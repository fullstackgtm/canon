/**
 * LinkedIn cadences and who is in them (docs/linkedin-cadences.md, slice L2).
 * A cadence sends from one connected account. Its owner, or an admin, edits
 * it and enrolls audiences into it; the worker (convex/linkedinWorker.ts)
 * sends within the account's limits.
 */
import { ACTIVE_WITHIN_DAYS_CHOICES, ACTIVE_WITHIN_DAYS_DEFAULT, validActiveWithinDays } from "./lib/linkedin/activity";
import { suppressionFor } from "./lib/suppressions/store";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { enabledFor } from "./lib/recipes";
import { accessFor } from "./permissions";
import { seesRunRecords, withoutHidden, type Access } from "./lib/access";
import { audienceContacts, type Caller } from "./audienceActions";
import {
  NAME_MAX, funnelOf, isActive, planEnrollment, stepValidator, validateSteps,
  type EnrollCandidate, type EnrollSkip, type EnrollmentState, type Step,
} from "./lib/linkedin/cadence";
import { estimateInviteTimes, weekStart } from "./lib/linkedin/limits";
import { senderCapacity } from "./lib/linkedin/sender";
import { publishEnrollment, publishSender } from "./lib/linkedin/feedProjection";
import { cumulativeAcceptance } from "./lib/linkedin/acceptance";
import { SEGMENT_DIMENSIONS, segmentBreakdown, type SegmentDimension, type SegmentPerson, type SegmentRow } from "./lib/linkedin/segments";
import { callerClient } from "./records";
import { accountNamesByList } from "./lib/recordClient";

const CADENCES_MAX = 100;
/** Enrollments one cadence's funnel counts, and all cadences' funnels together count, per read. */
const FUNNEL_SCAN = 2000;
const FUNNEL_BUDGET = 10_000;
/** Queued people across the sender's cadences that the estimate places. */
const QUEUE_SCAN = 1000;
/** Contacts one existence check or insert handles. */
const CHUNK = 200;

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds shared.moderate. */
const isAdmin = (who: { role: string; capabilities?: readonly string[] }) => can(who, "shared.moderate");

async function senderFor(ctx: QueryCtx, user: Doc<"users">, accountId: Id<"linkedinAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account || account.orgId !== user.orgId || account.status === "disconnected") throw new ConvexError("That LinkedIn account isn't connected");
  if (account.userId !== user._id && !isAdmin(user)) throw new ConvexError("Only the account's owner or an admin can run cadences from it");
  return account;
}

async function editableCadence(ctx: QueryCtx, user: Doc<"users">, cadenceId: Id<"linkedinCadences">) {
  const cadence = await ctx.db.get(cadenceId);
  if (!cadence || cadence.orgId !== user.orgId) throw new ConvexError("Cadence not found");
  const account = await senderFor(ctx, user, cadence.senderAccountId);
  return { cadence, account };
}

function cleanSteps(steps: Step[]): Step[] {
  return steps.map((s) => (s.kind === "invite" ? (s.note?.trim() ? { kind: "invite", note: s.note.trim() } : { kind: "invite" }) : { ...s, body: s.body.trim() }));
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = (await ctx.db.query("linkedinCadences").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(CADENCES_MAX))
      .filter((r) => r.status !== "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const accounts = await Promise.all(rows.map((r) => ctx.db.get(r.senderAccountId)));
    const now = Date.now();
    let budget = FUNNEL_BUDGET;
    const out = [];
    for (const [i, r] of rows.entries()) {
      // Past the budget, a cadence shows no funnel rather than a wrong one.
      const scan = budget > 0 ? await funnelScan(ctx, r._id, Math.min(FUNNEL_SCAN, budget)) : null;
      if (scan) budget -= scan.funnel.enrolled;
      out.push({ _id: r._id, name: r.name, status: r.status, steps: r.steps.length, sender: accounts[i]?.profileName ?? "LinkedIn account", updatedAt: r.updatedAt, funnel: scan?.funnel ?? null, funnelTruncated: scan?.truncated ?? true, acceptanceDays: cumulativeAcceptance(scan?.rows ?? [], now) });
    }
    return out;
  },
});

/** The funnel of a cadence's newest `limit` enrollments, and whether there were more. */
async function funnelScan(ctx: QueryCtx, cadenceId: Id<"linkedinCadences">, limit: number) {
  const rows = await ctx.db.query("linkedinEnrollments").withIndex("by_cadenceId_and_enrolledAt", (q) => q.eq("cadenceId", cadenceId)).order("desc").take(limit + 1);
  return { rows: rows.slice(0, limit), funnel: funnelOf(rows.slice(0, limit)), truncated: rows.length > limit };
}

/**
 * Where this cadence's queued people stand in the sender's invite queue, and
 * roughly when each goes out. The worker serves one queue per LinkedIn account
 * across its active cadences, oldest first, so positions are sender-wide.
 */
async function queueEstimate(ctx: QueryCtx, cadence: Doc<"linkedinCadences">, account: Doc<"linkedinAccounts"> | null, now: number) {
  const none = { order: [] as Id<"linkedinEnrollments">[], times: [] as (number | null)[], window: account?.window ?? null, timezone: account?.timezone ?? null };
  if (!account) return { ...none, waitReason: "The LinkedIn account for this cadence is gone." };
  if (cadence.status !== "active") return { ...none, waitReason: cadence.status === "paused" ? "Paused. Click Start to begin sending invites." : "Archived." };
  if (account.status !== "ok") return { ...none, waitReason: account.status === "credentials" ? "LinkedIn needs you to log in again (Integrations)." : `The LinkedIn account is ${account.status}.` };
  if ((account.holdUntil ?? 0) > now) return { ...none, waitReason: `${account.holdReason ?? "Paused by LinkedIn."} Until ${new Date(account.holdUntil!).toISOString()}.` };
  const { usage, health } = await senderCapacity(ctx, account, now);
  if (health.invitePause) return { ...none, waitReason: `Invites paused: ${health.invitePause}` };
  const statuses = new Map<Id<"linkedinCadences">, string | undefined>();
  const order: Id<"linkedinEnrollments">[] = [];
  for (const e of await ctx.db.query("linkedinEnrollments").withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", account._id).eq("state", "queued")).take(QUEUE_SCAN)) {
    if (!statuses.has(e.cadenceId)) statuses.set(e.cadenceId, (await ctx.db.get(e.cadenceId))?.status);
    if (statuses.get(e.cadenceId) === "active") order.push(e._id);
  }
  const recentInvites = (await ctx.db.query("linkedinSends").withIndex("by_accountId_and_kind_and_at", (q) => q.eq("accountId", account._id).eq("kind", "invite").gte("at", weekStart(now))).take(500)).map((r) => r.at);
  // An invite hold (LinkedIn's weekly limit hit) delays the start, not the order.
  const from = Math.max(now, account.inviteHoldUntil ?? 0);
  const times = estimateInviteTimes({
    queued: order.length, now: from, window: account.window, timezone: account.timezone, senderKey: account._id,
    account, health, invitesToday: from === now ? usage.invitesToday : 0, recentInvites,
  });
  return { ...none, order, times, waitReason: null as string | null };
}

/** One cadence with its funnel, its enrollments (newest first) and a count per state. */
export const get = query({
  args: { cadenceId: v.id("linkedinCadences") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const cadence = user && (await ctx.db.get(args.cadenceId));
    if (!user || !cadence || cadence.orgId !== user.orgId) return null;
    const account = await ctx.db.get(cadence.senderAccountId);
    const scan = await funnelScan(ctx, cadence._id, FUNNEL_SCAN);
    const rows = scan.rows;
    const counts: Partial<Record<EnrollmentState, number>> = {};
    for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
    const est = await queueEstimate(ctx, cadence, account, Date.now());
    // Who is in the cadence (names, profiles) shows to its sender and to roles that narrow no read; anyone else sees its counts (CP14).
    const showsPeople = seesRunRecords(await accessFor(ctx, user), account ? [account.userId] : []);
    const queue = { ...est, positions: new Map(est.order.map((id, i) => [id, i + 1])), etas: new Map(est.order.map((id, i) => [id, est.times[i]])) };
    return {
      _id: cadence._id,
      name: cadence.name,
      status: cadence.status,
      steps: cadence.steps,
      activeWithinDays: cadence.activeWithinDays ?? ACTIVE_WITHIN_DAYS_DEFAULT,
      senderAccountId: cadence.senderAccountId,
      sender: account ? { profileName: account.profileName ?? null, status: account.status, tier: account.tier } : null,
      canEdit: Boolean(account && (account.userId === user._id || isAdmin(user))),
      counts,
      funnel: scan.funnel,
      funnelTruncated: scan.truncated,
      queue: { waitReason: queue.waitReason, window: queue.window, timezone: queue.timezone, queued: queue.order.length, finishAt: queue.times.at(-1) ?? null },
      enrollments: (showsPeople ? rows : []).map((r) => ({
        _id: r._id, contactId: r.contactId, contactName: r.contactName, linkedinUrl: r.linkedinUrl,
        state: r.state, stepIndex: r.stepIndex, nextAt: r.nextAt, enrolledAt: r.enrolledAt,
        invitedAt: r.invitedAt ?? null, connectedAt: r.connectedAt ?? null, acceptedAt: r.acceptedAt ?? null,
        lastSentAt: r.lastSentAt ?? null, reason: r.reason ?? null,
        position: queue.positions.get(r._id) ?? null,
        eta: queue.etas.get(r._id) ?? null,
      })),
    };
  },
});

/** Make a paused cadence. `template` names the recipe template it started from, which must be on in the workspace. */
export const create = mutation({
  args: { name: v.string(), senderAccountId: v.id("linkedinAccounts"), steps: v.array(stepValidator), template: v.optional(v.object({ recipeId: v.string(), key: v.string() })) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const account = await senderFor(ctx, user, args.senderAccountId);
    const name = args.name.trim();
    if (!name || name.length > NAME_MAX) throw new ConvexError(`A cadence name is 1 to ${NAME_MAX} characters`);
    const steps = cleanSteps(args.steps);
    const problem = validateSteps(steps, account.tier);
    if (problem) throw new ConvexError(problem);
    const existing = await ctx.db.query("linkedinCadences").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(CADENCES_MAX);
    if (existing.length >= CADENCES_MAX) throw new ConvexError(`An org has at most ${CADENCES_MAX} LinkedIn cadences`);
    const from = args.template && (await enabledFor(ctx, user.orgId, "templates.cadences")).find((e) => e.recipe.id === args.template!.recipeId && e.contribution.key === args.template!.key);
    if (args.template && !from) throw new ConvexError("That cadence template isn't on in this workspace");
    const now = Date.now();
    const id = await ctx.db.insert("linkedinCadences", {
      orgId: user.orgId, name, senderAccountId: account._id, steps, status: "paused", createdBy: user._id, createdAt: now, updatedAt: now,
      ...(from ? { recipe: { id: from.recipe.id, version: from.recipe.version, key: from.contribution.key } } : {}),
    });
    // The template's first use is the row its install points to.
    if (from?.row?.installed && !from.row.installed.rowId) await ctx.db.patch(from.row._id, { installed: { ...from.row.installed, rowId: id } });
    return id;
  },
});

/** Edit the name and steps. Contacts already past a step keep their place; a removed step ends them at the last one. */
export const update = mutation({
  args: { cadenceId: v.id("linkedinCadences"), name: v.string(), steps: v.array(stepValidator), activeWithinDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.activeWithinDays !== undefined && !validActiveWithinDays(args.activeWithinDays)) throw new ConvexError(`Activity window must be one of ${ACTIVE_WITHIN_DAYS_CHOICES.join(", ")} days`);
    const user = await requireUser(ctx);
    const { cadence, account } = await editableCadence(ctx, user, args.cadenceId);
    const name = args.name.trim();
    if (!name || name.length > NAME_MAX) throw new ConvexError(`A cadence name is 1 to ${NAME_MAX} characters`);
    const steps = cleanSteps(args.steps);
    const problem = validateSteps(steps, account.tier);
    if (problem) throw new ConvexError(problem);
    // Merge fields are captured at enrollment, so a new field could not be filled for people already in.
    const before = new Set(cadence.steps.flatMap((s) => [...(s.kind === "invite" ? s.note ?? "" : s.body).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1])));
    const added = steps.flatMap((s) => [...(s.kind === "invite" ? s.note ?? "" : s.body).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1])).filter((f) => !before.has(f));
    if (added.length) {
      const enrolled = await ctx.db.query("linkedinEnrollments").withIndex("by_cadenceId_and_enrolledAt", (q) => q.eq("cadenceId", cadence._id)).first();
      if (enrolled) throw new ConvexError(`This cadence already has contacts, so it can't start using {{${added[0]}}}. Create a new cadence for new merge fields.`);
    }
    const renamed = name !== cadence.name;
    await ctx.db.patch(cadence._id, { name, steps, ...(args.activeWithinDays === undefined ? {} : { activeWithinDays: args.activeWithinDays }), updatedAt: Date.now() });
    if (renamed) await ctx.scheduler.runAfter(0, internal.linkedinFeeds.refreshCadence, { cadenceId: cadence._id });
  },
});

export const setStatus = mutation({
  args: { cadenceId: v.id("linkedinCadences"), status: v.union(v.literal("active"), v.literal("paused"), v.literal("archived")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { cadence } = await editableCadence(ctx, user, args.cadenceId);
    if (cadence.status === "archived") throw new ConvexError("This cadence is archived");
    if (args.status === "archived") {
      // Archiving ends everyone still in it, one page at a time.
      await ctx.scheduler.runAfter(0, internal.linkedinCadences.stopAll, { cadenceId: cadence._id, reason: "Cadence archived" });
    }
    await ctx.db.patch(cadence._id, { status: args.status, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.linkedinFeeds.refreshCadence, { cadenceId: cadence._id });
  },
});

export const stopEnrollment = mutation({
  args: { enrollmentId: v.id("linkedinEnrollments") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.enrollmentId);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("Not found");
    await editableCadence(ctx, user, row.cadenceId);
    if (!isActive(row.state)) return;
    await ctx.db.patch(row._id, { state: "stopped", reason: "Stopped by hand", updatedAt: Date.now() });
    await publishEnrollment(ctx, row._id);
    await publishSender(ctx, row.senderAccountId);
  },
});

export const stopAll = internalMutation({
  args: { cadenceId: v.id("linkedinCadences"), reason: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("linkedinEnrollments")
      .withIndex("by_cadenceId_and_enrolledAt", (q) => q.eq("cadenceId", args.cadenceId))
      .paginate({ numItems: 200, cursor: args.cursor ?? null });
    for (const r of page.page) {
      if (isActive(r.state)) await ctx.db.patch(r._id, { state: "stopped", reason: args.reason, updatedAt: Date.now() });
      await publishEnrollment(ctx, r._id);
    }
    const cadence = await ctx.db.get(args.cadenceId);
    if (cadence) await publishSender(ctx, cadence.senderAccountId);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.linkedinCadences.stopAll, { ...args, cursor: page.continueCursor });
  },
});

// ───────────────────────────── Enrolling an audience ─────────────────────────────

export const enrollContext = internalQuery({
  args: { cadenceId: v.id("linkedinCadences") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const { cadence, account } = await editableCadence(ctx, user, args.cadenceId);
    if (cadence.status === "archived") throw new ConvexError("This cadence is archived");
    return { caller: { orgId: user.orgId, userId: user._id, role: user.role } as Caller, steps: cadence.steps as Step[], tier: account.tier };
  },
});

/** Which of these contacts are in any active LinkedIn cadence, and which were ever in this one. */
export const existingFor = internalQuery({
  args: { orgId: v.id("organizations"), cadenceId: v.id("linkedinCadences"), contactIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const active: string[] = [];
    const inCadence: string[] = [];
    for (const contactId of args.contactIds) {
      const rows = await ctx.db.query("linkedinEnrollments").withIndex("by_orgId_and_contactId", (q) => q.eq("orgId", args.orgId).eq("contactId", contactId)).take(50);
      if (rows.some((r) => isActive(r.state))) active.push(contactId);
      if (rows.some((r) => r.cadenceId === args.cadenceId)) inCadence.push(contactId);
    }
    return { active, inCadence };
  },
});

const candidate = v.object({
  contactId: v.string(), contactName: v.string(), linkedinUrl: v.string(), publicIdentifier: v.string(), vars: v.record(v.string(), v.string()),
});

/** Insert enrollments, re-checking in the transaction that no contact is already active somewhere. */
export const insertEnrollments = internalMutation({
  args: { cadenceId: v.id("linkedinCadences"), userId: v.id("users"), candidates: v.array(candidate), at: v.number() },
  handler: async (ctx, args): Promise<{ inserted: number; raced: string[] }> => {
    const cadence = await ctx.db.get(args.cadenceId);
    if (!cadence || cadence.status === "archived") throw new ConvexError("Cadence not found");
    let inserted = 0;
    const raced: string[] = [];
    for (const [i, c] of args.candidates.entries()) {
      if ((await suppressionFor(ctx, cadence.orgId, { linkedinUrl: c.linkedinUrl }, "automated_outreach")).linkedin.blocked) { raced.push(c.contactId); continue; }
      const rows = await ctx.db.query("linkedinEnrollments").withIndex("by_orgId_and_contactId", (q) => q.eq("orgId", cadence.orgId).eq("contactId", c.contactId)).take(50);
      if (rows.some((r) => isActive(r.state) || r.cadenceId === cadence._id)) { raced.push(c.contactId); continue; }
      const enrollmentId = await ctx.db.insert("linkedinEnrollments", {
        orgId: cadence.orgId, cadenceId: cadence._id, senderAccountId: cadence.senderAccountId,
        ...c, state: "queued", stepIndex: 0,
        // Audience order is kept: earlier contacts are invited first.
        nextAt: args.at + i,
        enrolledBy: args.userId, enrolledAt: args.at, updatedAt: args.at,
      });
      await publishEnrollment(ctx, enrollmentId);
      inserted++;
    }
    if (inserted) await publishSender(ctx, cadence.senderAccountId);
    return { inserted, raced };
  },
});

type Plan = { enroll: EnrollCandidate[]; skipped: EnrollSkip[]; total: number };

async function plan(ctx: ActionCtx, cadenceId: Id<"linkedinCadences">, audienceId: Id<"audiences">): Promise<Plan & { caller: Caller }> {
  const context: { caller: Caller; steps: Step[]; tier: Doc<"linkedinAccounts">["tier"] } | null = await ctx.runQuery(internal.linkedinCadences.enrollContext, { cadenceId });
  if (!context) throw new ConvexError("Not authenticated");
  const { contacts } = await audienceContacts(ctx, context.caller, audienceId);
  const active = new Set<string>();
  const inCadence = new Set<string>();
  for (let i = 0; i < contacts.length; i += CHUNK) {
    const ids = contacts.slice(i, i + CHUNK).map((c) => c.id);
    const found: { active: string[]; inCadence: string[] } = await ctx.runQuery(internal.linkedinCadences.existingFor, { orgId: context.caller.orgId, cadenceId, contactIds: ids });
    found.active.forEach((id) => active.add(id));
    found.inCadence.forEach((id) => inCadence.add(id));
  }
  return { ...planEnrollment(contacts, context.steps, context.tier, { active, inCadence }), total: contacts.length, caller: context.caller };
}

/** Who from the audience would join, and why the rest wouldn't. Writes nothing. */
export const previewEnroll = action({
  args: { cadenceId: v.id("linkedinCadences"), audienceId: v.id("audiences") },
  handler: async (ctx, args): Promise<{ total: number; enroll: number; skipped: EnrollSkip[] }> => {
    const p = await plan(ctx, args.cadenceId, args.audienceId);
    return { total: p.total, enroll: p.enroll.length, skipped: p.skipped.slice(0, 200) };
  },
});

/** Enroll the audience. The caller names how many it expects (from the preview); a changed audience stops and asks for a new preview. */
export const enroll = action({
  args: { cadenceId: v.id("linkedinCadences"), audienceId: v.id("audiences"), expectToEnroll: v.number() },
  handler: async (ctx, args): Promise<{ enrolled: number; skipped: number }> => {
    const p = await plan(ctx, args.cadenceId, args.audienceId);
    if (p.enroll.length !== args.expectToEnroll) throw new ConvexError(`The audience changed: ${p.enroll.length} contacts would join now, not ${args.expectToEnroll}. Preview again.`);
    const at = Date.now();
    let enrolled = 0;
    let raced = 0;
    for (let i = 0; i < p.enroll.length; i += CHUNK) {
      const out: { inserted: number; raced: string[] } = await ctx.runMutation(internal.linkedinCadences.insertEnrollments, {
        cadenceId: args.cadenceId, userId: p.caller.userId, candidates: p.enroll.slice(i, i + CHUNK), at: at + i,
      });
      enrolled += out.inserted;
      raced += out.raced.length;
    }
    return { enrolled, skipped: p.skipped.length + raced };
  },
});


// ───────────────────────────── Segments ─────────────────────────────

/** Contacts one breakdown reads at once from the record service, and custom values per query. */
const SEGMENT_FETCH_PARALLEL = 20;
const SEGMENT_CUSTOM_CHUNK = 100;

/** The cadence's newest people with their funnel fields, for someone who may see who is in it; null otherwise. */
export const segmentContext = internalQuery({
  args: { cadenceId: v.id("linkedinCadences"), withActivity: v.boolean() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const cadence = user && (await ctx.db.get(args.cadenceId));
    if (!user || !cadence || cadence.orgId !== user.orgId) return null;
    const account = await ctx.db.get(cadence.senderAccountId);
    const access = await accessFor(ctx, user);
    if (!seesRunRecords(access, account ? [account.userId] : [])) return null;
    const scan = await funnelScan(ctx, cadence._id, FUNNEL_SCAN);
    const people = [];
    for (const r of scan.rows) {
      let activity: SegmentPerson["activity"] = null;
      if (args.withActivity) {
        const row = r.providerId
          ? await ctx.db.query("linkedinActivity").withIndex("by_orgId_and_providerId", (q) => q.eq("orgId", cadence.orgId).eq("providerId", r.providerId!)).first()
          : await ctx.db.query("linkedinActivity").withIndex("by_orgId_and_publicIdentifier", (q) => q.eq("orgId", cadence.orgId).eq("publicIdentifier", r.publicIdentifier.toLowerCase())).first();
        if (row) activity = { lastActiveAt: row.lastActiveAt ?? null, checkedAt: row.checkedAt };
      }
      people.push({ contactId: r.contactId, state: r.state, invitedAt: r.invitedAt ?? null, connectedAt: r.connectedAt ?? null, lastSentAt: r.lastSentAt ?? null, activity });
    }
    return { orgId: cadence.orgId, access, people, truncated: scan.truncated };
  },
});

/**
 * The cadence's acceptance and response rates split by one trait of its people. Contacts are read
 * as the caller, so a person whose record they can't see counts under "Unknown".
 */
export const segments = action({
  args: { cadenceId: v.id("linkedinCadences"), by: v.union(...SEGMENT_DIMENSIONS.map((d) => v.literal(d))) },
  handler: async (ctx, args): Promise<{ rows: SegmentRow[]; truncated: boolean } | null> => {
    const by = args.by as SegmentDimension;
    const context: { orgId: Id<"organizations">; access: Access; people: (Omit<SegmentPerson, "title" | "company" | "seniority" | "roleStart"> & { contactId: string })[]; truncated: boolean } | null =
      await ctx.runQuery(internal.linkedinCadences.segmentContext, { cadenceId: args.cadenceId, withActivity: by === "activity" });
    if (!context) return null;
    const ws = context.orgId as string;
    const contacts = new Map<string, { title?: string; accountId: string; stream?: string }>();
    let names: Record<string, string> = {};
    if (by !== "activity") {
      const client = callerClient(ctx, { orgId: ws, access: context.access });
      const ids = [...new Set(context.people.map((p) => p.contactId))];
      for (let i = 0; i < ids.length; i += SEGMENT_FETCH_PARALLEL) {
        const got = await Promise.all(ids.slice(i, i + SEGMENT_FETCH_PARALLEL).map((id) => client.getContact(ws, id).catch(() => null)));
        got.forEach((c, j) => { if (c) contacts.set(ids[i + j], c); });
      }
      if (by === "company") names = await accountNamesByList(client, ws, [...contacts.values()].map((c) => c.accountId));
    }
    const custom: Record<string, Record<string, string | number | boolean>> = {};
    if (by === "seniority" || by === "tenure") {
      const streams = [...contacts.values()].flatMap((c) => (c.stream ? [c.stream] : []));
      for (let i = 0; i < streams.length; i += SEGMENT_CUSTOM_CHUNK) {
        Object.assign(custom, await ctx.runQuery(internal.objects.customFieldValues, { orgId: context.orgId, streamIds: streams.slice(i, i + SEGMENT_CUSTOM_CHUNK) }));
      }
    }
    const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
    const people: SegmentPerson[] = context.people.map(({ contactId, ...p }) => {
      const c = contacts.get(contactId);
      // Fields the caller's role hides never place anyone in a segment.
      const values = withoutHidden(context.access, "contact", (c?.stream && custom[c.stream]) || {});
      return {
        ...p,
        title: c?.title ?? null,
        company: c ? names[c.accountId] ?? null : null,
        seniority: text(values["custom.seniority"]),
        roleStart: text(values["custom.in_role_since"]),
      };
    });
    return { rows: segmentBreakdown(people, by, Date.now()), truncated: context.truncated };
  },
});
