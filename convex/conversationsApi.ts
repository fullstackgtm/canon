/**
 * Conversation intake for a person's agent (docs/conversation-intake.md, CI5): the /mcp tool canon_conversations
 * (src/app/mcp/_canonConversationTools.ts) lists conversations, reads a thread, shows intake per linked account and
 * turns it off, always as the caller. Its reads see no more than the app does: the caller's own conversations, and
 * other people's only through a contact the caller's role sees (permissions.sightJudge), with each message's text
 * only where lib/conversations/store.ts lets them read it. Turning intake on, and deleting what was read, stay with
 * the person in the app (src/lib/gtm-human-only-mutations.ts): that is their consent to Canon reading their messages.
 */
import { ConvexError, v } from "convex/values";
import { action, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import type { Access } from "./lib/access";
import { readableThread, type ThreadMessage } from "./lib/conversations/store";
import { admitThenRead } from "./lib/scopedRecordClient";
import { accountOf, loggedAccountRef, patchIntake } from "./conversations";
import { conversationsOf } from "./conversationView";
import { accessFor, sightJudge } from "./permissions";
import { callerClient, requireCaller } from "./records";

const LIST_MAX = 50;
/** People one list reads at a time: a company's or a deal's, from canon_associations or canon_deal_roles. */
const CONTACTS_MAX = 50;
/** Conversations read per person, most recently linked first, before the newest are picked. */
const PER_CONTACT_READ = 200;
const THREAD_DEFAULT = 50;
const THREAD_MAX = 200;
const ACCOUNTS_MAX = 50;

type Extraction =
  | { status: "waiting"; dueAt: number }
  | { status: "read"; readAt: number; patchPlanId: Id<"patchPlans"> | null }
  | { status: "skipped"; reason: string }
  | { status: "not_read" };

/** Where CI3b's extraction of a thread stands (convex/conversationExtract.ts). */
function extractionOf(c: Doc<"conversations">): Extraction {
  if (c.extractDueAt) return { status: "waiting", dueAt: c.extractDueAt };
  if (c.extractSkipped) return { status: "skipped", reason: c.extractSkipped };
  if (c.extractedAt) return { status: "read", readAt: c.extractedAt, patchPlanId: c.patchPlanId ?? null };
  return { status: "not_read" };
}

async function summaryOf(ctx: QueryCtx, access: Access, c: Doc<"conversations">) {
  const [last] = (await readableThread(ctx, access, c, 1)).messages;
  return {
    conversationId: c._id, channel: c.channel, ownerUserId: c.ownerUserId, mine: c.ownerUserId === access.userId,
    counterpart: c.counterpart, contactIds: c.contactIds, lastMessageAt: c.lastMessageAt,
    lastMessage: (last ?? null) as ThreadMessage | null, extraction: extractionOf(c),
  };
}

/** The caller's linked LinkedIn and Gmail accounts (unlinked ones too: what they read is still theirs). */
async function ownAccounts(ctx: QueryCtx, user: Doc<"users">) {
  const linkedin = (await ctx.db.query("linkedinAccounts").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(ACCOUNTS_MAX))
    .map((row) => ({ channel: "linkedin" as const, row, label: row.profileName ?? row.publicIdentifier ?? "LinkedIn account" }));
  const email = (await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(ACCOUNTS_MAX))
    .map((row) => ({ channel: "email" as const, row, label: row.address }));
  return [...linkedin, ...email].filter((a) => a.row.orgId === user.orgId);
}

const listArgs = { contactIds: v.optional(v.array(v.string())), limit: v.optional(v.number()) };

/**
 * Conversations newest first: the caller's own with no `contactIds`; otherwise those matched to any of the people
 * named that the caller's role sees, whoever's they are.
 */
async function listAs(ctx: QueryCtx, user: Doc<"users">, args: { contactIds?: string[]; limit?: number }, admitted: ReadonlySet<string>) {
  const access = await accessFor(ctx, user);
  const limit = Math.max(1, Math.min(args.limit ?? LIST_MAX, LIST_MAX));
  const found = new Map<Id<"conversations">, Doc<"conversations">>();
  const judge = sightJudge(ctx, [access], admitted);
  if (!args.contactIds) {
    // Each account's most recently active, so the newest `limit` overall are among them.
    // Email they logged by BCC or forward is kept under their own ref (conversations.ts storeLogged).
    for (const ref of [...(await ownAccounts(ctx, user)).map((a) => a.row._id as string), loggedAccountRef(user._id)]) {
      for (const c of await ctx.db.query("conversations").withIndex("by_accountRef_and_lastMessageAt", (q) => q.eq("accountRef", ref)).order("desc").take(limit)) {
        if (c.orgId === user.orgId && c.ownerUserId === user._id) found.set(c._id, c);
      }
    }
  } else {
    if (args.contactIds.length > CONTACTS_MAX) throw new ConvexError(`At most ${CONTACTS_MAX} people at a time`);
    // A person the caller's role does not see, or not yet judged (pending), adds nothing.
    for (const contactId of new Set(args.contactIds)) {
      if (!judge.record("contact", contactId)) continue;
      for (const c of await conversationsOf(ctx, user.orgId, contactId, PER_CONTACT_READ)) found.set(c._id, c);
    }
  }
  const recent = [...found.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, limit);
  const conversations = [];
  for (const c of recent) conversations.push(await summaryOf(ctx, access, c));
  return { pending: judge.pending, value: { conversations } };
}

/**
 * One conversation and its latest messages, oldest first, or null when the caller may not see it: its owner sees it,
 * and anyone who sees a contact it is matched to, with the text only where store.ts readableThread allows.
 */
async function threadOf(ctx: QueryCtx, user: Doc<"users">, args: { conversationId: string; limit?: number }, admitted: ReadonlySet<string>) {
  const id = ctx.db.normalizeId("conversations", args.conversationId);
  const c = id ? await ctx.db.get(id) : null;
  if (!c || c.orgId !== user.orgId) return { pending: [], value: null };
  const access = await accessFor(ctx, user);
  if (c.ownerUserId !== access.userId) {
    const judge = sightJudge(ctx, [access], admitted);
    if (!c.contactIds.some((contactId) => judge.record("contact", contactId))) return { pending: judge.pending, value: null };
  }
  const limit = Math.max(1, Math.min(args.limit ?? THREAD_DEFAULT, THREAD_MAX));
  const { messages, more } = await readableThread(ctx, access, c, limit);
  return { pending: [], value: { ...(await summaryOf(ctx, access, c)), messages, more } };
}

type Listed = Awaited<ReturnType<typeof listAs>>["value"];
type Thread = NonNullable<Awaited<ReturnType<typeof threadOf>>["value"]>;

export const listFor = internalQuery({
  args: { ...listArgs, admitted: v.array(v.string()) },
  handler: async (ctx, { admitted, ...args }) => {
    const user = await getCurrentUser(ctx);
    return user ? listAs(ctx, user, args, new Set(admitted)) : { pending: [], value: { conversations: [] } };
  },
});

/** listAs for any role: people only the record service can judge are admitted through the caller's scoped client. */
export const list = action({
  args: listArgs,
  handler: async (ctx, args): Promise<Listed> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead<Listed>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.conversationsApi.listFor, { ...args, admitted }));
  },
});

const threadArgs = { conversationId: v.string(), limit: v.optional(v.number()) };

export const threadFor = internalQuery({
  args: { ...threadArgs, admitted: v.array(v.string()) },
  handler: async (ctx, { admitted, ...args }) => {
    const user = await getCurrentUser(ctx);
    return user ? threadOf(ctx, user, args, new Set(admitted)) : { pending: [], value: null };
  },
});

export const thread = action({
  args: threadArgs,
  handler: async (ctx, args): Promise<Thread> => {
    const caller = await requireCaller(ctx, { read: true });
    const read = await admitThenRead<Thread | null>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.conversationsApi.threadFor, { ...args, admitted }));
    if (!read) throw new ConvexError("Conversation not found");
    return read;
  },
});

/** The caller's linked LinkedIn and Gmail accounts and whether Canon reads each one's messages. */
export const intakeStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { accounts: [] };
    const accounts = [];
    for (const { channel, row: r, label } of await ownAccounts(ctx, user)) {
      accounts.push({
        accountId: r._id, channel, label, status: r.status,
        on: r.ingest === true, consentAt: r.ingestConsentAt ?? null, backfilledAt: r.ingestBackfilledAt ?? null, syncedAt: r.ingestSyncedAt ?? null,
        hasRead: Boolean(await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", r._id)).first()),
      });
    }
    return { accounts };
  },
});

/**
 * Stop reading the caller's own account's messages: what conversations.setIntake does when turned off, for the
 * account's owner only. It only takes access away, so an agent may do it; what was read stays until the owner
 * deletes it in the app.
 */
export const stopIntake = mutation({
  args: { accountId: v.union(v.id("linkedinAccounts"), v.id("emailAccounts")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const found = await accountOf(ctx, args.accountId);
    if (!found || found.row.orgId !== user.orgId || found.row.userId !== user._id) throw new ConvexError("Account not found");
    if (!found.row.ingest) return { on: false };
    const now = Date.now();
    await patchIntake(ctx, found, { ingest: false, ingestBackfillCursor: undefined, updatedAt: now }, null);
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId, userId: user._id, verb: "do", operation: "conversation_intake.stop", status: "applied",
      details: { accountId: found.row._id, channel: found.channel, client: await agentClientOf(ctx) }, createdAt: now,
    });
    return { on: false };
  },
});
