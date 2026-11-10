/**
 * Conversation intake (docs/conversation-intake.md): LinkedIn (CI1) and Gmail (CI2). The owner of a linked account
 * turns on "Read my messages" (`setIntake`, recording consent); from then on every 1:1 LinkedIn message, or every
 * email with someone outside the team, the account sends or receives is stored (`storeLinkedin`, `storeEmail`)
 * from Unipile's webhooks and from a 90-day backfill (conversationActions), reconciled daily. A message whose
 * counterpart matches a contact also lands on that contact's timeline, without its text; the text is read only
 * through lib/conversations/store.ts readableTexts. "Delete what was read" (`deleteRead`) erases it all, also
 * after the account was unlinked (`unlinkedReads` lists those accounts).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { can } from "./lib/capabilities";
import { INTAKE_CONSENT } from "./lib/conversations/consent";
import { BACKFILL_DAYS, EXTRACT_QUIET_MS, emailMessageKey, emailReceivedKey, messageKey, replyKey, slugOf } from "./lib/conversations/intake";
import { advanceIntakeJob, finishIntakeJob, startIntakeJob } from "./lib/conversations/intakeJob";
import { accountCopy, eraseConversation, firstCopy, linkContacts, storedInOrg } from "./lib/conversations/store";
import { emailThreadKey, messageIdForms } from "./lib/email/messageIds";
import { loggingMember } from "./emailLog";
import { MESSAGE_TEXT_MAX } from "./lib/linkedin/inbound";
import { nextGapMs } from "./lib/linkedin/limits";
import type { PlannedObservation } from "./lib/signals/observations";
import { appendObservations, contactLog } from "./observations";

const DAY_MS = 86_400_000;
/** One backfill chain per account holds this; each step renews it. */
const LEASE_MS = 15 * 60_000;
const ERASE_BATCH = 400;
/** A contact matched late attaches at most this many of the conversation's earlier messages to their timeline. */
const ATTACH_MAX = 500;
const ACCOUNTS_MAX = 500;
const SENDERS_MAX = 200;
const MEMBERS_MAX = 500;
/** Contacts one conversation lands on, at most (an email thread can have several people from outside). */
const CONTACTS_MAX = 10;
/** The daily reconcile re-reads this much before the last pass, in case a webhook arrived out of order. */
const RECONCILE_OVERLAP_MS = DAY_MS;
/** The daily passes start spread over this long. */
const RECONCILE_SPREAD_MS = 30 * 60_000;
/** Between pages of an inbox's mail. Reading mail puts no LinkedIn-style risk on the account, so it is only polite. */
const EMAIL_GAP_MS = 5_000;

type Channel = "linkedin" | "email";
type Found = { channel: "linkedin"; row: Doc<"linkedinAccounts"> } | { channel: "email"; row: Doc<"emailAccounts"> };
const accountIdV = v.union(v.id("linkedinAccounts"), v.id("emailAccounts"));

export async function accountOf(ctx: QueryCtx, id: string): Promise<Found | null> {
  const linkedin = ctx.db.normalizeId("linkedinAccounts", id);
  if (linkedin) {
    const row = await ctx.db.get(linkedin);
    return row ? { channel: "linkedin", row } : null;
  }
  const email = ctx.db.normalizeId("emailAccounts", id);
  const row = email ? await ctx.db.get(email) : null;
  return row ? { channel: "email", row } : null;
}

/** The intake fields both account tables share. A LinkedIn read also forgets where it stopped inside a chat. */
type IntakePatch = Partial<Pick<Doc<"emailAccounts">, "ingest" | "ingestConsentAt" | "ingestTextVersion" | "ingestSince" | "ingestBackfillCursor" | "ingestBackfilledAt" | "ingestSyncedAt" | "ingestLeaseUntil" | "updatedAt">>;
export async function patchIntake(ctx: MutationCtx, found: Found, patch: IntakePatch, resume?: Doc<"linkedinAccounts">["ingestBackfillResume"] | null) {
  if (found.channel === "linkedin") await ctx.db.patch(found.row._id, { ...patch, ...(resume === undefined ? {} : { ingestBackfillResume: resume ?? undefined }) });
  else await ctx.db.patch(found.row._id, patch);
}

const scheduleBackfill = (ctx: MutationCtx, delayMs: number, found: Found) => (found.channel === "linkedin"
  ? ctx.scheduler.runAfter(delayMs, internal.conversationActions.backfillLinkedin, { accountId: found.row._id })
  : ctx.scheduler.runAfter(delayMs, internal.conversationActions.backfillEmail, { accountId: found.row._id }));

async function ownedAccount(ctx: MutationCtx, accountId: string) {
  const user = await requireUser(ctx);
  const found = await accountOf(ctx, accountId);
  if (!found || found.row.orgId !== user.orgId) throw new ConvexError("Account not found");
  return { found, owner: found.row.userId === user._id, moderator: can(user, "shared.moderate") };
}

/**
 * Turn intake on (the owner only, on a linked account, with the consent text they read) or off (the owner or a
 * moderator, also once the account is unlinked). Turning it on starts the 90-day backfill; turning it off stops
 * intake and keeps what was read until it is deleted.
 */
export const setIntake = mutation({
  args: { accountId: accountIdV, on: v.boolean(), textVersion: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { found, owner, moderator } = await ownedAccount(ctx, args.accountId);
    const { row } = found;
    const now = Date.now();
    if (!args.on) {
      if (!owner && !moderator) throw new ConvexError("Only the account's owner or an admin can turn this off");
      await patchIntake(ctx, found, { ingest: false, ingestBackfillCursor: undefined, updatedAt: now }, null);
      await finishIntakeJob(ctx, found, now, { off: true });
      return;
    }
    if (!owner) throw new ConvexError("Only the account's owner can let Canon read their messages");
    if (row.status === "disconnected") throw new ConvexError("Link the account again first");
    if (args.textVersion !== INTAKE_CONSENT[found.channel].version) throw new ConvexError("What Canon reads has changed. Reload the page and read it again.");
    const leased = (row.ingestLeaseUntil ?? 0) > now;
    await patchIntake(ctx, found, {
      ingest: true, ingestConsentAt: now, ingestTextVersion: args.textVersion,
      ingestSince: now - BACKFILL_DAYS * DAY_MS, ingestBackfillCursor: undefined, ingestBackfilledAt: undefined,
      ...(leased ? {} : { ingestLeaseUntil: now + LEASE_MS }), updatedAt: now,
    }, null);
    await startIntakeJob(ctx, found, now);
    // A chain still running picks up the reset since and cursor at its next step.
    if (!leased) await scheduleBackfill(ctx, 0, found);
  },
});

/**
 * Erase every message read from the account, and its conversations. Intake must be off first on a linked account;
 * an unlinked one reads nothing, so deleting also turns its intake off.
 */
export const deleteRead = mutation({
  args: { accountId: accountIdV },
  handler: async (ctx, args) => {
    const { found, owner, moderator } = await ownedAccount(ctx, args.accountId);
    if (!owner && !moderator) throw new ConvexError("Only the account's owner or an admin can delete what was read");
    if (found.row.ingest) {
      if (found.row.status !== "disconnected") throw new ConvexError("Turn off reading your messages first");
      await patchIntake(ctx, found, { ingest: false, ingestBackfillCursor: undefined, updatedAt: Date.now() }, null);
      await finishIntakeJob(ctx, found, Date.now(), { off: true });
    }
    await ctx.scheduler.runAfter(0, internal.conversations.eraseRead, { accountRef: found.row._id });
  },
});

/** The caller's unlinked accounts that still hold messages Canon read, so they can delete them (issue #920). */
export const unlinkedReads = query({
  args: { channel: v.union(v.literal("linkedin"), v.literal("email")) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows: Array<{ _id: string; orgId: Id<"organizations">; status: string; label: string; ingest?: boolean }> = args.channel === "linkedin"
      ? (await ctx.db.query("linkedinAccounts").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(SENDERS_MAX)).map((r) => ({ ...r, label: r.profileName ?? r.publicIdentifier ?? "LinkedIn account" }))
      : (await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", user._id)).take(SENDERS_MAX)).map((r) => ({ ...r, label: r.address }));
    const out = [];
    for (const r of rows) {
      if (r.orgId !== user.orgId || r.status !== "disconnected") continue;
      if (!(await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", r._id)).first())) continue;
      out.push({ _id: r._id as Id<"linkedinAccounts"> | Id<"emailAccounts">, label: r.label, on: r.ingest === true });
    }
    return out;
  },
});

/**
 * Erase what an account read: its conversations and their messages. A conversation that also holds email its owner
 * logged by BCC or forward (it moved to the inbox when the inbox read the thread, emailThreadOf) keeps the logged
 * messages and goes back to the owner's logged mail.
 */
export const eraseRead = internalMutation({
  args: { accountRef: v.string() },
  handler: async (ctx, args) => {
    let left = ERASE_BATCH;
    for (const c of await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", args.accountRef)).take(ERASE_BATCH)) {
      let kept = false;
      // Read the whole thread: a conversation moves back to logged mail only once nothing the inbox read is left in it.
      for await (const m of ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", c._id))) {
        if (left <= 0) break;
        if (m.logged) kept = true;
        else {
          await ctx.db.delete(m._id);
          left--;
        }
      }
      if (left <= 0) break;
      if (kept) {
        await ctx.db.patch(c._id, { accountRef: loggedAccountRef(c.ownerUserId), extractDueAt: undefined, updatedAt: Date.now() });
        left--;
      } else left -= await eraseConversation(ctx, c._id, left);
      if (left <= 0) break;
    }
    if (left <= 0) await ctx.scheduler.runAfter(0, internal.conversations.eraseRead, args);
  },
});

// ───────────────────────────── Intake ─────────────────────────────

export type IntakeAccount = { accountId: Id<"linkedinAccounts">; orgId: Id<"organizations">; userId: Id<"users"> };
export type EmailIntakeAccount = { accountId: Id<"emailAccounts">; orgId: Id<"organizations">; userId: Id<"users">; unipileAccountId: string; address: string };

/**
 * Why an account's messages may not be read now, or null when they may: intake is on, the account is still linked,
 * and its owner is an active member of the account's workspace. Every reader asks here (the webhooks, the backfill,
 * the daily reconcile and extraction, conversationExtract.ts), so a member who leaves stops being read everywhere.
 * What was read stays, under the same visibility rules.
 */
export async function intakeClosed(ctx: QueryCtx, found: Found | null): Promise<string | null> {
  if (!found || found.row.status === "disconnected") return "account is gone";
  if (!found.row.ingest) return "intake is off";
  const owner = await ctx.db.get(found.row.userId);
  return owner?.isActive && owner.orgId === found.row.orgId ? null : "owner is no longer a member";
}

const intakeOf = async (ctx: QueryCtx, row: Doc<"linkedinAccounts"> | null): Promise<IntakeAccount | null> =>
  row && !(await intakeClosed(ctx, { channel: "linkedin", row })) ? { accountId: row._id, orgId: row.orgId, userId: row.userId } : null;

const emailIntakeOf = async (ctx: QueryCtx, row: Doc<"emailAccounts"> | null): Promise<EmailIntakeAccount | null> =>
  row && !(await intakeClosed(ctx, { channel: "email", row })) ? { accountId: row._id, orgId: row.orgId, userId: row.userId, unipileAccountId: row.unipileAccountId, address: row.address } : null;

/** The account behind a Unipile id, when its owner turned intake on; null otherwise, and then nothing is kept. */
export const intakeAccount = internalQuery({
  args: { unipileAccountId: v.string() },
  handler: async (ctx, args): Promise<IntakeAccount | null> =>
    intakeOf(ctx, await ctx.db.query("linkedinAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first()),
});

/** The same for a Gmail inbox. */
export const emailIntakeAccount = internalQuery({
  args: { unipileAccountId: v.string() },
  handler: async (ctx, args): Promise<EmailIntakeAccount | null> =>
    emailIntakeOf(ctx, await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first()),
});

/** Who is on the inbox owner's team, by Granola's rules (lib/calls/suggestions.ts teamOf): members and what an admin added. */
export const emailTeam = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ memberEmails: string[]; ourTeam: string[] }> => {
    const members = (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(MEMBERS_MAX)).filter((m) => m.isActive);
    const granola = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "granola")).first();
    const ourTeam = Array.isArray(granola?.syncConfig?.granolaOurTeam) ? (granola.syncConfig.granolaOurTeam as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return { memberEmails: members.map((m) => m.email.toLowerCase()), ourTeam };
  },
});

/** The contact a cadence of this sender enrolled under LinkedIn provider id `providerId`, newest first. */
export const contactForProviderId = internalQuery({
  args: { accountId: v.id("linkedinAccounts"), providerId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const rows = await ctx.db.query("linkedinEnrollments")
      .withIndex("by_senderAccountId_and_providerId", (q) => q.eq("senderAccountId", args.accountId).eq("providerId", args.providerId))
      .take(10);
    return rows.filter((e) => e.orgId === account.orgId).sort((a, b) => b._creationTime - a._creationTime)[0]?.contactId ?? null;
  },
});

type Stored = Pick<Doc<"conversationMessages">, "externalMessageId" | "direction" | "at" | "from" | "to" | "subject" | "viaCanon">;
type Logged = Pick<Doc<"conversationMessages">, "logged" | "inReplyTo" | "references">;
type Incoming = { messageId: string; direction: "in" | "out"; at: number; from: string; text: string; to?: string; subject?: string; viaCanon?: boolean; logged?: Logged };
/**
 * A stored message's timeline entry on one contact's timeline: the keys meaning it is there already, and the body;
 * null for none. `fresh` is true for a message this call stored.
 */
type TimelineOf = (m: Stored, fresh: boolean, contactId: string) => { seen: string[]; body: PlannedObservation["body"] } | null;

/**
 * Store a thread's messages, once each by their external id within the account (two teammates' inboxes that got the
 * same email keep a copy each), and log each on the timeline of every contact the thread is matched to, without its
 * text. A contact matched only now gets the thread's earlier messages too. Returns how many messages were new.
 */
async function storeThread(
  ctx: MutationCtx,
  account: { orgId: Id<"organizations">; userId: Id<"users">; accountRef: string; channel: Channel },
  thread: { threadId: string; counterpart: Doc<"conversations">["counterpart"]; contactIds: readonly string[]; subject?: string; participants?: Doc<"conversations">["participants"]; messages: readonly Incoming[] },
  timeline: TimelineOf,
  { extract = true }: { extract?: boolean } = {},
): Promise<number> {
  const { orgId } = account;
  const now = Date.now();
  const found = await ctx.db.query("conversations")
    .withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", account.accountRef).eq("externalThreadId", thread.threadId))
    .first();
  const conversationId = found?._id ?? await ctx.db.insert("conversations", {
    orgId, ownerUserId: account.userId, channel: account.channel, accountRef: account.accountRef, externalThreadId: thread.threadId,
    counterpart: thread.counterpart, contactIds: [], lastMessageAt: 0, createdAt: now, updatedAt: now,
  });
  const before = found?.contactIds ?? [];
  const contactIds = [...new Set([...before, ...thread.contactIds])].slice(0, CONTACTS_MAX);
  const added = new Set(contactIds.filter((c) => !before.includes(c)));

  let latest = found?.lastMessageAt ?? 0;
  const fresh: Stored[] = [];
  for (const m of thread.messages) {
    if (await accountCopy(ctx, orgId, account.accountRef, m.messageId)) continue;
    const row = { externalMessageId: m.messageId, direction: m.direction, at: Math.min(m.at, now), from: m.from, ...(m.to ? { to: m.to } : {}), ...(m.subject ? { subject: m.subject } : {}), ...(m.viaCanon ? { viaCanon: true } : {}) };
    await ctx.db.insert("conversationMessages", { orgId, conversationId, ...row, ...m.logged, text: m.text.slice(0, MESSAGE_TEXT_MAX) });
    fresh.push(row);
    latest = Math.max(latest, row.at);
  }

  const earlier = added.size
    ? (await ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", conversationId)).take(ATTACH_MAX))
    : [];
  const freshIds = new Set(fresh.map((m) => m.externalMessageId));
  for (const contactId of contactIds) {
    await logOnTimeline(ctx, orgId, account.channel, contactId, added.has(contactId) ? earlier : fresh, (m) => timeline(m, freshIds.has(m.externalMessageId), contactId), now);
  }
  await ctx.db.patch(conversationId, {
    counterpart: { ...found?.counterpart, ...thread.counterpart }, contactIds, lastMessageAt: latest,
    ...(thread.subject && !found?.subject ? { subject: thread.subject } : {}),
    ...(thread.participants ? { participants: mergedPeople(found?.participants ?? [], thread.participants) } : {}),
    // CI3 extracts once the thread has been quiet this long.
    ...(fresh.length && extract ? { extractDueAt: latest + EXTRACT_QUIET_MS } : {}), updatedAt: now,
  });
  await linkContacts(ctx, orgId, conversationId, added);
  return fresh.length;
}

/** Log messages on a contact's timeline without their text, once each: one whose entry is already there is skipped. */
async function logOnTimeline(ctx: MutationCtx, orgId: Id<"organizations">, ref: Channel, contactId: string, messages: readonly Stored[], entryOf: (m: Stored) => ReturnType<TimelineOf>, now: number) {
  const log = contactLog(ctx, orgId);
  for (const m of messages) {
    const entry = entryOf(m);
    if (!entry) continue;
    let logged = false;
    for (const key of entry.seen) if (await log.has(contactId, key)) logged = true;
    if (logged) continue;
    await appendObservations(ctx, orgId, { object: "contact", contactId }, { kind: "pipeline", ref }, [{ body: entry.body, observedAt: now, occurredAt: m.at }]);
  }
}

const linkedinTimeline: TimelineOf = (m) => ({
  seen: [messageKey(m.externalMessageId), ...(m.direction === "in" ? [replyKey(m.externalMessageId)] : [])],
  body: { type: "linkedin", key: messageKey(m.externalMessageId), event: { kind: "message", direction: m.direction } },
});

/**
 * An email's line, from the inbox owner's side. An email Canon sent is on the timeline already, and so is a received
 * one the reply path logs (`email:received:<id>`). A webhook's received email (`live`, `fresh`) is that path's to log
 * on its sender's contact (emailActions.receive), so only that contact skips it; the other contacts on it get it here.
 * `senders` maps an address to the contact it matched.
 */
const emailTimeline = (userId: Id<"users">, live: boolean, senders: ReadonlyMap<string, string> = new Map()): TimelineOf => (m, fresh, contactId) => {
  if (m.viaCanon || (fresh && live && m.direction === "in" && senders.get(m.from.toLowerCase()) === contactId)) return null;
  const key = emailMessageKey(m.externalMessageId);
  return {
    // Either form of the id: a line written before ids were stored bare kept its angle brackets.
    seen: messageIdForms(m.externalMessageId).flatMap((id) => [emailMessageKey(id), emailReceivedKey(id)]),
    body: { type: "email", key, event: { kind: "message", direction: m.direction, userId, from: m.from, to: m.to ?? "", subject: m.subject ?? "" } },
  };
};

/**
 * A conversation intake matched to no one whose counterpart was found later (extraction reads the register again):
 * it is matched now, as intake would match it, its messages so far going onto the contact's timeline.
 * One intake matched meanwhile is kept.
 */
export async function matchLate(ctx: MutationCtx, conversation: Doc<"conversations">, contactId: string, now: number) {
  if (conversation.contactIds.length) return;
  await ctx.db.patch(conversation._id, { contactIds: [contactId] });
  await linkContacts(ctx, conversation.orgId, conversation._id, [contactId]);
  const earlier = await ctx.db.query("conversationMessages").withIndex("by_conversationId_and_at", (q) => q.eq("conversationId", conversation._id)).take(ATTACH_MAX);
  const timeline = conversation.channel === "linkedin" ? linkedinTimeline : emailTimeline(conversation.ownerUserId, false);
  await logOnTimeline(ctx, conversation.orgId, conversation.channel, contactId, earlier, (m) => timeline(m, false, contactId), now);
}

const mergedPeople = (a: NonNullable<Doc<"conversations">["participants"]>, b: NonNullable<Doc<"conversations">["participants"]>) =>
  [...new Map([...b, ...a].map((p) => [p.email, p])).values()].slice(0, 20);

const direction = v.union(v.literal("in"), v.literal("out"));

/**
 * Store one chat's messages, once each by LinkedIn's message id. A chat with a teammate's account is skipped. When
 * the counterpart matches a contact (`contactId`), each message is logged on their timeline without its text; a
 * reply the cadence worker already logged is not logged again. Returns how many messages were new.
 */
export const storeLinkedin = internalMutation({
  args: {
    accountId: v.id("linkedinAccounts"),
    chatId: v.string(),
    counterpart: v.object({ providerId: v.string(), name: v.optional(v.string()), publicIdentifier: v.optional(v.string()), profileUrl: v.optional(v.string()) }),
    contactId: v.optional(v.string()),
    messages: v.array(v.object({ messageId: v.string(), direction, at: v.number(), from: v.string(), text: v.string() })),
  },
  handler: async (ctx, args): Promise<number> => {
    const account = await intakeOf(ctx, await ctx.db.get(args.accountId));
    if (!account) return 0;
    const slug = slugOf(args.counterpart.publicIdentifier, args.counterpart.profileUrl)?.toLowerCase();
    if (slug) {
      const team = await ctx.db.query("linkedinAccounts").withIndex("by_orgId", (q) => q.eq("orgId", account.orgId)).take(SENDERS_MAX);
      if (team.some((t) => t.publicIdentifier?.toLowerCase() === slug)) return 0;
    }
    return storeThread(
      ctx, { orgId: account.orgId, userId: account.userId, accountRef: account.accountId, channel: "linkedin" },
      { threadId: args.chatId, counterpart: args.counterpart, contactIds: args.contactId ? [args.contactId] : [], messages: args.messages },
      linkedinTimeline,
    );
  },
});

const person = v.object({ email: v.string(), name: v.optional(v.string()) });

/** The conversations a member's logged email is kept under (convex/emailLog.ts): one "account" per member. */
export const loggedAccountRef = (userId: Id<"users">) => `emaillog:${userId}`;

type EmailHead = { messageId: string; inReplyTo?: string | null; references?: readonly string[] };

/**
 * Where an email joins its owner's mail, the same from every source (docs/email-logging.md). `accountRef` is the
 * linked inbox that read it, or the owner's logged mail (`emaillog:<userId>`). Returns the conversation it is stored
 * under, as its account and thread key:
 * 1. the conversation already holding this email or one it replies to (In-Reply-To, then References newest first),
 *    in this account or the owner's other sources;
 * 2. else the owner's conversation keyed on the thread's root (lib/email/messageIds.ts emailThreadKey), or one this
 *    inbox keyed before on Unipile's thread id (`legacyThreadId`, how a linked inbox keyed threads until then);
 * 3. else a new one under that root key.
 * An inbox's own sources are itself and the owner's logged mail: a thread they logged that the inbox then reads
 * moves to the inbox, so it is one conversation. Logged mail's are itself and each inbox the owner linked. Two
 * inboxes never share one: each keeps its copy, as two teammates' do.
 */
async function emailThreadOf(ctx: MutationCtx, owner: { orgId: Id<"organizations">; userId: Id<"users"> }, accountRef: string, head: EmailHead, legacyThreadId: string | null): Promise<{ accountRef: string; threadId: string }> {
  const logged = loggedAccountRef(owner.userId);
  const refs = accountRef === logged
    ? [logged, ...(await ctx.db.query("emailAccounts").withIndex("by_userId", (q) => q.eq("userId", owner.userId)).take(SENDERS_MAX)).filter((a) => a.orgId === owner.orgId).map((a) => a._id as string)]
    : [accountRef, logged];
  const joined = async (c: Doc<"conversations">) => {
    if (c.accountRef === logged && accountRef !== logged) await ctx.db.patch(c._id, { accountRef, updatedAt: Date.now() });
    return { accountRef: c.accountRef === logged ? accountRef : c.accountRef, threadId: c.externalThreadId };
  };
  for (const id of [head.messageId, head.inReplyTo, ...[...(head.references ?? [])].reverse()]) {
    const copy = id ? await firstCopy(ctx, owner.orgId, refs, id) : null;
    if (copy) return joined(copy.conversation);
  }
  const key = emailThreadKey(head);
  const keyed = (ref: string, threadId: string) => ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", ref).eq("externalThreadId", threadId)).first();
  const candidates: Array<[string, string]> = [[accountRef, key], ...(legacyThreadId ? [[accountRef, legacyThreadId] as [string, string]] : []), ...refs.filter((r) => r !== accountRef).map((r): [string, string] => [r, key])];
  for (const [ref, threadId] of candidates) {
    const c = await keyed(ref, threadId);
    if (c && c.ownerUserId === owner.userId) return joined(c);
  }
  return { accountRef, threadId: key };
}

/**
 * Store one email thread's messages, once each by Message-ID in this inbox, and log each on the timeline of the
 * contacts it is with (`contacts`, by address), without its text. A received email the inbox's reply path logs
 * (`email:received:<id>`) is not logged again; `live` marks a webhook's delivery, whose received email that path logs
 * itself on the sender's contact. An email Canon sent is already on the timeline. A thread without Unipile's id joins
 * the one its In-Reply-To names in this inbox, or starts its own.
 */
export const storeEmail = internalMutation({
  args: {
    accountId: v.id("emailAccounts"),
    threadId: v.union(v.string(), v.null()),
    subject: v.string(),
    counterpart: v.object({ email: v.string(), name: v.optional(v.string()), domain: v.optional(v.string()) }),
    participants: v.array(person),
    contacts: v.array(v.object({ email: v.string(), contactId: v.string() })),
    live: v.boolean(),
    messages: v.array(v.object({
      messageId: v.string(), inReplyTo: v.optional(v.string()), references: v.optional(v.array(v.string())), direction, at: v.number(), from: v.string(), to: v.string(), subject: v.string(), text: v.string(), viaCanon: v.boolean(),
    })),
  },
  handler: async (ctx, args): Promise<number> => {
    const account = await emailIntakeOf(ctx, await ctx.db.get(args.accountId));
    if (!account || !args.messages.length) return 0;
    const at = await emailThreadOf(ctx, account, account.accountId, args.messages[0], args.threadId);
    const senders = new Map(args.contacts.map((c) => [c.email.toLowerCase(), c.contactId]));
    return storeThread(
      ctx, { orgId: account.orgId, userId: account.userId, accountRef: at.accountRef, channel: "email" },
      {
        threadId: at.threadId, counterpart: args.counterpart, contactIds: [...new Set(args.contacts.map((c) => c.contactId))], subject: args.subject, participants: args.participants,
        messages: args.messages.map(({ inReplyTo: _r, references: _f, ...m }) => m),
      },
      emailTimeline(account.userId, args.live, senders),
    );
  },
});

/**
 * Store one email a member logged by BCC or forward (convex/emailLog.ts), once per workspace: by its Message-ID, or,
 * for a forward that carries no id of the original, by its fingerprint (sender, minute, subject). It joins the member's thread of the message it replies to, and
 * is logged on the timeline of each contact it is with, as email intake's are, without its text. Logged mail is not
 * read for facts (no `extractDueAt`).
 */
export const storeLogged = internalMutation({
  args: {
    token: v.string(),
    fingerprint: v.string(),
    /** The message carries no id of its own (an inline forward): it is a duplicate when its fingerprint was logged. */
    byFingerprint: v.boolean(),
    subject: v.string(),
    counterpart: v.object({ email: v.string(), name: v.optional(v.string()), domain: v.optional(v.string()) }),
    participants: v.array(person),
    contacts: v.array(v.object({ email: v.string(), contactId: v.string() })),
    message: v.object({
      messageId: v.string(), direction, at: v.number(), from: v.string(), to: v.string(), text: v.string(),
      logged: v.union(v.literal("bcc"), v.literal("forward")), inReplyTo: v.optional(v.string()), references: v.array(v.string()),
    }),
  },
  handler: async (ctx, args): Promise<{ status: "logged"; conversationId: Id<"conversations"> } | { status: "duplicate" | "unknown_address" }> => {
    const member = await loggingMember(ctx, args.token);
    if (!member) return { status: "unknown_address" };
    const { orgId, userId } = member;
    const m = args.message;
    const key = `fp:${args.fingerprint}`;
    if (await storedInOrg(ctx, orgId, m.messageId)) return { status: "duplicate" };
    const seen = await ctx.db.query("emailLogKeys").withIndex("by_orgId_and_key", (q) => q.eq("orgId", orgId).eq("key", key)).first();
    if (seen && args.byFingerprint) return { status: "duplicate" };
    if (!seen) await ctx.db.insert("emailLogKeys", { orgId, key, createdAt: Date.now() });
    const { accountRef, threadId } = await emailThreadOf(ctx, member, loggedAccountRef(userId), m, null);
    const logged: Logged = {
      logged: m.logged, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}), ...(m.references.length ? { references: m.references.join(" ").slice(0, 4_000) } : {}),
    };
    await storeThread(
      ctx, { orgId, userId, accountRef, channel: "email" },
      {
        threadId, counterpart: args.counterpart, contactIds: [...new Set(args.contacts.map((c) => c.contactId))], subject: args.subject, participants: args.participants,
        messages: [{ messageId: m.messageId, direction: m.direction, at: m.at, from: m.from, to: m.to, subject: args.subject, text: m.text, logged }],
      },
      emailTimeline(userId, false),
      { extract: false },
    );
    const conversation = await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", accountRef).eq("externalThreadId", threadId)).first();
    return { status: "logged", conversationId: conversation!._id };
  },
});

// ───────────────────────────── Backfill and reconcile ─────────────────────────────

/** Where a LinkedIn pass stopped inside a page of chats (schema: linkedinAccounts.ingestBackfillResume). */
export type ChatResume = NonNullable<Doc<"linkedinAccounts">["ingestBackfillResume"]>;
const resumeV = v.object({ next: v.number(), chat: v.optional(v.object({ id: v.string(), providerId: v.string(), cursor: v.string() })) });

export type BackfillStep =
  | { run: false }
  | ({ since: number; cursor: string | null; holdUntil: number | null; unipileAccountId: string } & (
    | { run: true; channel: "linkedin"; account: IntakeAccount; resume: ChatResume | null }
    | { run: true; channel: "email"; account: EmailIntakeAccount }
  ));

/** Where the account's read stands: what the next page reads, or nothing when intake is off or the account isn't connected. */
export const backfillState = internalQuery({
  args: { accountId: accountIdV },
  handler: async (ctx, args): Promise<BackfillStep> => {
    const found = await accountOf(ctx, args.accountId);
    if (!found || found.row.status !== "ok" || found.row.ingestSince === undefined) return { run: false };
    const base = { since: found.row.ingestSince, cursor: found.row.ingestBackfillCursor ?? null, unipileAccountId: found.row.unipileAccountId };
    if (found.channel === "email") {
      const account = await emailIntakeOf(ctx, found.row);
      return account ? { run: true, channel: "email", account, ...base, holdUntil: null } : { run: false };
    }
    const account = await intakeOf(ctx, found.row);
    if (!account) return { run: false };
    const now = Date.now();
    return { run: true, channel: "linkedin", account, ...base, resume: found.row.ingestBackfillResume ?? null, holdUntil: (found.row.holdUntil ?? 0) > now ? found.row.holdUntil! : null };
  },
});

/**
 * Record a backfill step and schedule the next: the next page after a gap (LinkedIn's random 45-180 s, or a short
 * one for mail), a retry after `retryInMs`, or the end of the pass when there is no next page. A LinkedIn step that
 * stopped inside a page (`resume`) keeps the page's cursor and reads on from there; the pass ends only when every chat
 * is read. A step whose `since` is no longer the account's (intake was turned off and on again meanwhile) leaves the
 * cursor alone, so the new pass starts from the beginning.
 *
 * The 90-day backfill's tray job (lib/conversations/intakeJob.ts) moves with it: what the step read (`read`
 * conversations or emails, back to `reachedAt`), a pause, the end, or why it stopped (`error`).
 */
export const backfillAdvance = internalMutation({
  args: {
    accountId: accountIdV, since: v.number(), cursor: v.union(v.string(), v.null()), resume: v.optional(resumeV), retryInMs: v.optional(v.number()), stop: v.optional(v.boolean()),
    read: v.optional(v.number()), reachedAt: v.optional(v.number()), error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const found = await accountOf(ctx, args.accountId);
    if (!found) return;
    const { row, channel } = found;
    const now = Date.now();
    const closed = await intakeClosed(ctx, found);
    const step = { read: args.read, reachedAt: args.reachedAt };
    if (closed || args.stop) {
      await patchIntake(ctx, found, { ingestLeaseUntil: undefined });
      if (row.status === "disconnected") await finishIntakeJob(ctx, found, now, { error: "The account was unlinked.", resumes: false });
      else if (closed === "owner is no longer a member") await finishIntakeJob(ctx, found, now, { error: "The account's owner is no longer a member.", resumes: false });
      else if (row.status !== "ok") await finishIntakeJob(ctx, found, now, { error: "The account needs you to sign in again.", resumes: true });
      else if (!closed) await finishIntakeJob(ctx, found, now, { error: args.error ?? "Reading stopped.", resumes: true });
      return;
    }
    const next = (delayMs: number) => scheduleBackfill(ctx, delayMs, found);
    const current = row.ingestSince === args.since;
    if (args.retryInMs !== undefined) {
      await patchIntake(ctx, found, { ingestLeaseUntil: now + args.retryInMs + LEASE_MS });
      await advanceIntakeJob(ctx, found, now, step, args.retryInMs, args.retryInMs);
      await next(args.retryInMs);
      return;
    }
    const gap = channel === "linkedin" ? nextGapMs(Math.random()) : EMAIL_GAP_MS;
    if (args.resume && current) {
      await patchIntake(ctx, found, { ingestBackfillCursor: args.cursor ?? undefined, ingestLeaseUntil: now + gap + LEASE_MS }, args.resume);
      await advanceIntakeJob(ctx, found, now, step, gap);
      await next(gap);
      return;
    }
    if (args.cursor || !current) {
      await patchIntake(ctx, found, { ...(current ? { ingestBackfillCursor: args.cursor! } : {}), ingestLeaseUntil: now + gap + LEASE_MS }, current ? null : undefined);
      await advanceIntakeJob(ctx, found, now, step, gap);
      await next(gap);
      return;
    }
    await advanceIntakeJob(ctx, found, now, step, 0);
    await finishIntakeJob(ctx, found, now, { done: true });
    await patchIntake(ctx, found, { ingestBackfillCursor: undefined, ingestBackfilledAt: row.ingestBackfilledAt ?? now, ingestSyncedAt: now, ingestLeaseUntil: undefined }, null);
  },
});

/**
 * Daily: start a pass for every account reading its messages with no chain running. A backfill that stopped
 * resumes where it was; a finished one re-reads what changed since its last pass.
 */
export const reconcile = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!integrationEnabled("unipile")) return null;
    const now = Date.now();
    const rows: Found[] = [
      ...(await ctx.db.query("linkedinAccounts").withIndex("by_status", (q) => q.eq("status", "ok")).take(ACCOUNTS_MAX)).map((row) => ({ channel: "linkedin" as const, row })),
      ...(await ctx.db.query("emailAccounts").withIndex("by_status", (q) => q.eq("status", "ok")).take(ACCOUNTS_MAX)).map((row) => ({ channel: "email" as const, row })),
    ];
    for (const found of rows) {
      const { row } = found;
      if ((row.ingestLeaseUntil ?? 0) > now || (await intakeClosed(ctx, found))) continue;
      const last = row.ingestBackfilledAt === undefined ? null : row.ingestSyncedAt ?? row.ingestBackfilledAt;
      const start = Math.floor(Math.random() * RECONCILE_SPREAD_MS);
      await patchIntake(ctx, found, {
        ingestLeaseUntil: now + start + LEASE_MS,
        ...(last === null ? {} : { ingestSince: last - RECONCILE_OVERLAP_MS, ingestBackfillCursor: undefined }),
      }, last === null ? undefined : null);
      await scheduleBackfill(ctx, start, found);
    }
  },
});
