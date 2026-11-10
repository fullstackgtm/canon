/**
 * The observation log (docs/signal-ledger.md): appends for every subject, a contact's log for its
 * timeline, and erasing a contact's observations, the log's one exception to append-only.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accessFor, sightJudge } from "./permissions";
import { callerClient, requireCaller } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { shardOf } from "./lib/objects/write";
import { subjectKey, type LoggedObservation, type PlannedObservation, type Subject } from "./lib/signals/observations";
import { eraseContactLog, type ContactLog } from "./lib/signals/contactLog";
import { eraseMessageOfKey, readableTexts } from "./lib/conversations/store";
import { touchBodyOf } from "./lib/signals/observationTouches";

/** A contact's observations read for its timeline: a few per LinkedIn cadence step, so far more than one contact has. */
const CONTACT_LOG_READ = 500;
const ERASE_BATCH = 200;

/** Append to a subject's log, issuing gap-free `seq`s from its shard's head in this transaction. */
export async function appendObservations(ctx: MutationCtx, orgId: Id<"organizations">, subject: Subject, source: Doc<"observations">["source"], planned: readonly PlannedObservation[]) {
  if (!planned.length) return;
  const shard = shardOf(subjectKey(subject));
  const head = await ctx.db.query("observationHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId).eq("shard", shard)).unique();
  let seq = head?.seq ?? 0;
  for (const p of planned) await ctx.db.insert("observations", { orgId, subject, shard, seq: ++seq, source, ...p });
  if (head) await ctx.db.patch(head._id, { seq });
  else await ctx.db.insert("observationHeads", { orgId, shard, seq });
}

const byContact = (ctx: QueryCtx, orgId: Id<"organizations">, contactId: string) =>
  ctx.db.query("observations").withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", orgId).eq("subject.contactId", contactId));

/** A contact's log in this org. Its observations come from the LinkedIn worker. */
export function contactLog(ctx: MutationCtx, orgId: Id<"organizations">): ContactLog {
  return {
    has: async (contactId, key) =>
      Boolean(await ctx.db.query("observations").withIndex("by_orgId_subjectContactId_bodyKey", (q) => q.eq("orgId", orgId).eq("subject.contactId", contactId).eq("body.key", key)).first()),
    append: (contactId, entry) => appendObservations(ctx, orgId, { object: "contact", contactId }, { kind: "pipeline", ref: "linkedin" }, [entry]),
    unerased: async (contactId, limit) => {
      const out: Array<{ id: string; body: LoggedObservation["body"] }> = [];
      for await (const o of byContact(ctx, orgId, contactId)) {
        if (o.body.type !== "erased") out.push({ id: o._id, body: o.body });
        if (out.length >= limit) break;
      }
      return out;
    },
    replace: async (id, body) => {
      const doc = await ctx.db.get(id as Id<"observations">);
      if (doc) await ctx.db.patch(doc._id, { body });
    },
  };
}

/** A contact's observations (its register id), with the names of the cadences they mention. */
export const forContact = query({
  args: { contactId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    // A role that sees only some people: null, and the page asks forContactScoped (CP14).
    return liveOrNull(await forContactAs(ctx, user, args.contactId, new Set()));
  },
});

const liveOrNull = <T,>(r: { pending: readonly unknown[]; value: T }) => (r.pending.length ? null : r.value);

/**
 * A contact's log as `user` may see it: only a contact their role sees (permissions.sightJudge). `texts` holds the
 * LinkedIn messages and emails conversation intake read, by timeline key, with the text only where the caller may read it.
 */
async function forContactAs(ctx: QueryCtx, user: Doc<"users">, contactId: string, admitted: ReadonlySet<string>) {
  const access = await accessFor(ctx, user);
  const judge = sightJudge(ctx, [access], admitted);
  if (!judge.record("contact", contactId)) return { pending: judge.pending, value: null };
  const rows = await byContact(ctx, user.orgId, contactId).take(CONTACT_LOG_READ);
  const log: LoggedObservation[] = rows.map((o) => ({ seq: o.seq, observedAt: o.observedAt, body: o.body, ...(o.occurredAt === undefined ? {} : { occurredAt: o.occurredAt }) }));
  const cadences: Record<string, string> = {};
  for (const o of rows) {
    if (o.body.type !== "linkedin" || o.body.event.kind === "message" || o.body.event.cadenceId in cadences) continue;
    const cadence = await ctx.db.get(o.body.event.cadenceId);
    cadences[o.body.event.cadenceId] = cadence?.orgId === user.orgId ? cadence.name : "A deleted cadence";
  }
  const texts = await readableTexts(ctx, access, user.orgId, rows.flatMap((o) => (o.body.type === "linkedin" || o.body.type === "email" ? [o.body.key] : [])));
  return { pending: [], value: { log, cadences, texts } };
}

export const forContactFor = internalQuery({
  args: { contactId: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? forContactAs(ctx, user, args.contactId, new Set(args.admitted)) : { pending: [], value: null };
  },
});

/** forContact for a role that sees only some people: the contact is admitted through the caller's scoped client. */
export const forContactScoped = action({
  args: { contactId: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof forContactAs>>["value"]> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead<Awaited<ReturnType<typeof forContactAs>>["value"]>(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.observations.forContactFor, { ...args, admitted }));
  },
});

/** Contacts and observations per contact `firstLinkedin` reads: the account page's contacts, a few enrollments each. */
const FIRST_LINKEDIN_CONTACTS = 50;
const FIRST_LINKEDIN_READ = 20;

/**
 * When Canon first reached any of these contacts on LinkedIn (`first`, null
 * when never): an account's first contact (lib/scoreHistory.ts). Null for a
 * role that sees only some people; the page asks firstLinkedinScoped.
 */
export const firstLinkedin = query({
  args: { contactIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return liveOrNull(await firstLinkedinAs(ctx, user, args.contactIds, new Set()));
  },
});

/** firstLinkedin over the contacts `user` sees: a contact they may not see does not count. */
async function firstLinkedinAs(ctx: QueryCtx, user: Doc<"users">, contactIds: readonly string[], admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
  let first: number | null = null;
  for (const contactId of contactIds.slice(0, FIRST_LINKEDIN_CONTACTS)) {
    if (!judge.record("contact", contactId)) continue;
    for (const o of await byContact(ctx, user.orgId, contactId).take(FIRST_LINKEDIN_READ)) {
      if (o.body.key.startsWith("linkedin:") && (first === null || o.observedAt < first)) first = o.observedAt;
    }
  }
  return { pending: judge.pending, value: { first } };
}

export const firstLinkedinFor = internalQuery({
  args: { contactIds: v.array(v.string()), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? firstLinkedinAs(ctx, user, args.contactIds, new Set(args.admitted)) : { pending: [], value: { first: null } };
  },
});

/** firstLinkedin for a role that sees only some people. */
export const firstLinkedinScoped = action({
  args: { contactIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ first: number | null }> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.observations.firstLinkedinFor, { ...args, admitted }));
  },
});

/**
 * Erase a contact's observations (LinkedIn notes and messages are personal data), and the text of messages
 * intake read from them. The contact's erase
 * runs this; a contact with more than a batch continues in a follow-up run.
 */
export const eraseContact = internalMutation({
  args: { orgId: v.id("organizations"), contactId: v.string() },
  handler: async (ctx, args) => {
    const log = contactLog(ctx, args.orgId);
    // The LinkedIn messages conversation intake read from them go with the observations that point at them.
    for (const row of await log.unerased(args.contactId, ERASE_BATCH)) await eraseMessageOfKey(ctx, args.orgId, row.body.key);
    const erased = await eraseContactLog(log, args.contactId, Date.now(), ERASE_BATCH);
    if (erased === ERASE_BATCH) await ctx.scheduler.runAfter(0, internal.observations.eraseContact, args);
    return erased;
  },
});

/** The most observations a person's log yields to a module's touch read: the newest observed since `since`. */
const TOUCHES_PER_PERSON = 500;
/**
 * observations.forPeople (docs/modules.md): each person's observations from `since` to `until`, by when they happened,
 * cut to what a touch reads. The module's action has already left out the people its caller can't see. An
 * observation is recorded at or after it happened, so one that happened since `since` was observed since then too;
 * newest first, so a long log keeps its latest touches.
 */
export const forPeople = internalQuery({
  args: { orgId: v.id("organizations"), contactIds: v.array(v.string()), since: v.union(v.number(), v.null()), until: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const out: Array<{ contactId: string; at: number; body: ReturnType<typeof touchBodyOf> }> = [];
    for (const contactId of args.contactIds.slice(0, 500)) {
      const rows = await ctx.db.query("observations")
        .withIndex("by_orgId_subjectContactId_observedAt", (q) => {
          const person = q.eq("orgId", args.orgId).eq("subject.contactId", contactId);
          return args.since === null ? person : person.gte("observedAt", args.since);
        })
        .order("desc")
        .take(TOUCHES_PER_PERSON);
      for (const o of rows) {
        const at = o.occurredAt ?? o.observedAt;
        if ((args.since !== null && at < args.since) || (args.until !== null && at > args.until)) continue;
        out.push({ contactId, at, body: touchBodyOf(o.body as Record<string, unknown>) });
      }
    }
    return out;
  },
});
