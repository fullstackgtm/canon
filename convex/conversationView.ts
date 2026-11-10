/**
 * Conversations on records (docs/conversation-intake.md CI4): a contact's, company's or deal's email and LinkedIn
 * threads, and one thread with what it changed. A list shows who and when; message text is read only through
 * lib/conversations/store.ts readableThread, which shows it to the owner and to roles that read their activity.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, sightJudge } from "./permissions";
import { callerClient, requireCaller } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { peopleOfCompany, rowsById } from "./associations";
import { entityInfo, factJudge } from "./canonGate";
import { linkContacts, readableThread } from "./lib/conversations/store";
import type { ConversationSummary } from "./lib/conversations/view";

/** People whose conversations one record's list reads: a company's or deal's first ones. */
const CONTACTS_MAX = 50;
/** Each person's conversations a list reads, most recently linked first. */
const PER_CONTACT = 20;
/** Conversations one list returns. */
const LIST_MAX = 50;
/** Proposals and suggestions a list counts per conversation, and a thread lists. */
const COUNT_MAX = 50;
/** A thread's newest messages shown. */
const THREAD_MAX = 100;

type Person = { id: string; name: string };

const nameOf = (ctx: QueryCtx, userId: Id<"users">) => ctx.db.get(userId).then((u) => u?.name ?? u?.email ?? "A teammate");

/** A contact's conversations in its org, most recently linked first (conversationContacts). */
export async function conversationsOf(ctx: QueryCtx, orgId: Id<"organizations">, contactId: string, limit: number): Promise<Doc<"conversations">[]> {
  const links = await ctx.db.query("conversationContacts").withIndex("by_orgId_and_contactId", (q) => q.eq("orgId", orgId).eq("contactId", contactId)).order("desc").take(limit);
  const rows = await Promise.all(links.map((l) => ctx.db.get(l.conversationId)));
  return rows.filter((c): c is Doc<"conversations"> => c !== null && c.orgId === orgId);
}

async function summaryOf(ctx: QueryCtx, c: Doc<"conversations">, person: Person): Promise<ConversationSummary & { ownerName: string }> {
  const proposals = c.patchPlanId ? (await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", c.patchPlanId)).take(COUNT_MAX)).length : 0;
  const suggestions = (await ctx.db.query("callSuggestions").withIndex("by_conversationId", (q) => q.eq("conversationId", c._id)).take(COUNT_MAX)).length;
  return {
    id: c._id, channel: c.channel, lastMessageAt: c.lastMessageAt, contactId: person.id,
    counterpart: person.name || c.counterpart.name || c.counterpart.email || "Someone", ...(c.subject ? { subject: c.subject } : {}),
    ownerUserId: c.ownerUserId, ownerName: await nameOf(ctx, c.ownerUserId), proposals, suggestions,
  };
}

/**
 * The conversations of `people`, newest first, for the caller: only people their role sees (permissions.sightJudge),
 * `admitted` holding those the caller's scoped client already listed. Who and when only, never the text.
 */
export const listFor = internalQuery({
  args: { people: v.array(v.object({ id: v.string(), name: v.string() })), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const judge = sightJudge(ctx, [await accessFor(ctx, user)], new Set(args.admitted));
    // An email thread with two of a company's people shows once, under the first of them.
    const rows = new Map<string, { c: Doc<"conversations">; person: Person }>();
    for (const person of args.people.slice(0, CONTACTS_MAX)) {
      if (!judge.record("contact", person.id)) continue;
      for (const c of await conversationsOf(ctx, user.orgId, person.id, PER_CONTACT)) if (!rows.has(c._id)) rows.set(c._id, { c, person });
    }
    const newest = [...rows.values()].sort((a, b) => b.c.lastMessageAt - a.c.lastMessageAt).slice(0, LIST_MAX);
    return Promise.all(newest.map(({ c, person }) => summaryOf(ctx, c, person)));
  },
});

/** The people a record's conversations are with, as the caller's scoped client lists them. */
async function peopleOf(ctx: Parameters<typeof callerClient>[0], caller: Awaited<ReturnType<typeof requireCaller>>, object: "contact" | "account" | "deal", id: string): Promise<Person[]> {
  const orgId = caller.orgId as Id<"organizations">;
  const client = callerClient(ctx, caller);
  if (object === "account") return (await peopleOfCompany(ctx, client, orgId, id)).slice(0, CONTACTS_MAX).map((p) => ({ id: p.id, name: p.name }));
  const ids = object === "contact" ? [id]
    : ((await ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId: caller.userId as Id<"users">, streamId: id, access: caller.access }))?.members ?? []).map((m) => m.contactId);
  const rows = await rowsById(client, orgId, "contact", ids.slice(0, CONTACTS_MAX));
  return [...rows.values()].map((r) => ({ id: r.id, name: r.title || r.id }));
}

/**
 * A contact's, company's (its people's) or deal's (the people on it) email and LinkedIn conversations, newest
 * first. The record page merges in its calls and meetings (lib/conversations/view.ts conversationRows).
 */
export const forRecord = action({
  args: { object: v.union(v.literal("contact"), v.literal("account"), v.literal("deal")), id: v.string() },
  handler: async (ctx, args): Promise<Array<ConversationSummary & { ownerName: string }>> => {
    const caller = await requireCaller(ctx, { read: true });
    const people = await peopleOf(ctx, caller, args.object, args.id);
    if (!people.length) return [];
    return ctx.runQuery(internal.conversationView.listFor, { people, admitted: people.map((p) => p.id) });
  },
});

/**
 * One conversation as `user` may see it: its owner, or anyone who sees the person it was with. The messages carry
 * their text only where the caller may read it; the proposals its last extraction made are the ones the caller's
 * role sees (canonGate.factJudge), each with its status; and the suggestions it made.
 */
async function threadAs(ctx: QueryCtx, user: Doc<"users">, conversationId: string, admitted: ReadonlySet<string>) {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const c = id ? await ctx.db.get(id) : null;
  if (!c || c.orgId !== user.orgId) return { pending: [], value: null };
  const access = await accessFor(ctx, user);
  const judge = sightJudge(ctx, [access], admitted);
  const seen = c.ownerUserId === user._id || c.contactIds.some((contactId) => judge.record("contact", contactId));
  if (!seen) return { pending: judge.pending, value: null };
  const facts = factJudge(ctx, [access], admitted);
  const proposals = [];
  for (const f of c.patchPlanId ? await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", c.patchPlanId)).take(COUNT_MAX) : []) {
    if (!(await facts.shows(await ctx.db.get(f.entityId), f.attribute))) continue;
    const info = await entityInfo(ctx, f.entityId);
    proposals.push({ factId: f._id, label: info.label, entityType: info.entityType, attribute: f.attribute, value: f.value, status: f.status, evidence: f.evidence ?? null });
  }
  if (facts.pending.length) return { pending: facts.pending, value: null };
  const suggestions = (await ctx.db.query("callSuggestions").withIndex("by_conversationId", (q) => q.eq("conversationId", c._id)).take(COUNT_MAX))
    .map((s) => ({ id: s._id, kind: s.kind, status: s.status, name: s.values.name ?? s.values.email ?? s.values.domain ?? null, mine: s.userId === user._id }));
  const { messages, more } = await readableThread(ctx, access, c, THREAD_MAX);
  return {
    pending: [],
    value: {
      id: c._id, channel: c.channel, contactId: c.contactIds[0] ?? null,
      counterpart: c.counterpart.name || c.counterpart.email || "Someone", subject: c.subject ?? null, profileUrl: c.counterpart.profileUrl ?? null,
      ownerUserId: c.ownerUserId, ownerName: await nameOf(ctx, c.ownerUserId), mine: c.ownerUserId === user._id,
      lastMessageAt: c.lastMessageAt, extractedAt: c.extractedAt ?? null, messages, more, proposals, suggestions,
    },
  };
}

const liveOrNull = <T,>(r: { pending: readonly unknown[]; value: T }) => (r.pending.length ? null : r.value);

/** One conversation for its page. Null for a role that sees only some people: the page asks threadScoped. */
export const thread = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return liveOrNull(await threadAs(ctx, user, args.conversationId, new Set()));
  },
});

export const threadFor = internalQuery({
  args: { conversationId: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? threadAs(ctx, user, args.conversationId, new Set(args.admitted)) : { pending: [], value: null };
  },
});

export type Thread = NonNullable<Awaited<ReturnType<typeof threadAs>>["value"]>;

/** thread for a role that sees only some people: the conversation's person is admitted through the caller's scoped client. */
export const threadScoped = action({
  args: { conversationId: v.string() },
  handler: async (ctx, args): Promise<Thread | null> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead<Thread | null>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.conversationView.threadFor, { ...args, admitted }));
  },
});

/** Conversations one backfill step links. */
const LINK_BATCH = 200;

/**
 * Migration (docs/agent-coordination.md §4): link every conversation stored before conversationContacts existed to
 * its contacts. Run once per deployment with `{}`; it schedules itself until done. Linking twice is harmless.
 */
export const linkExisting = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("conversations").paginate({ numItems: LINK_BATCH, cursor: args.cursor ?? null });
    for (const c of page.page) await linkContacts(ctx, c.orgId, c._id, c.contactIds);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.conversationView.linkExisting, { cursor: page.continueCursor });
    return { linked: page.page.length, done: page.isDone };
  },
});
