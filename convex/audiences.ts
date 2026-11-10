/**
 * Audiences (GT6): a named set of contacts, defined by a contact view's
 * filter, with a snapshot of who was exported or pushed where and when.
 * Resolving contacts and talking to sequencers (Instantly, EmailBison,
 * Smartlead) happen in audienceActions.ts.
 *
 * An audience is its creator's until shared (docs/audiences-and-icps.md): a
 * rep's own space at the edge. Admins and managers see and change every
 * audience, and sharing one hands it to the whole workspace.
 *
 * A sequencer's API key is stored like Stripe's: encrypted on its
 * `integrations` row, read only by internal functions, never returned to the
 * client. EmailBison's host goes in the row's `instanceUrl`.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor } from "./permissions";
import { listedDef } from "./savedViews";
import { compileListRequest, ListRequestError } from "./lib/objects/listSpec";
import { listFilter, type ViewFilter } from "./lib/objects/validators";
import { encryptForStorage } from "./lib/tokenHelpers";
import { AUDIENCE_MAX, runsOf } from "./lib/outbound/audience";
import { SEQUENCER_IDS, SEQUENCERS, type SequencerId } from "./lib/outbound/sequencers";
import { scheduleAudienceIcpGaps } from "./icpFills";
import { readIcps } from "./lib/icpsInterface";

const NAME_MAX = 80;
/** Audiences a rep may keep, and audiences a workspace may share: `list` shows them all. */
const AUDIENCES_MAX = 100;
/** Audiences an admin's or manager's list reads across the workspace. */
const ORG_READ = 1000;
/** Member rows one mutation writes; callers send no more. */
export const WRITE_CHUNK = 500;
/** Sent emails one dedupe page reads; the action reads pages until none are left. */
const SENT_PAGE = 2000;
/** Member rows the history shows runs from; one more is read to tell whether the read was cut short. */
const HISTORY_READ = 2000;
const HISTORY_RUNS = 20;

const outcome = v.union(v.literal("sent"), v.literal("exported"), v.literal("skipped"));
const memberRow = v.object({ contactId: v.string(), email: v.optional(v.string()), outcome, reason: v.optional(v.string()) });

type Viewer = { _id: Id<"users">; orgId: Id<"organizations">; role: string; capabilities?: readonly string[] };
type Owned = Pick<Doc<"audiences">, "orgId" | "createdBy" | "shared">;

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds audiences.manageAll. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "audiences.manageAll");
/** Audiences from before sharing existed have no `shared` and stay everybody's. */
export const isShared = (a: Pick<Doc<"audiences">, "shared">) => a.shared !== false;
export const canSee = (viewer: Viewer, a: Owned) => a.orgId === viewer.orgId && (isShared(a) || a.createdBy === viewer._id || isManager(viewer));
export const canChange = (viewer: Viewer, a: Owned) => a.orgId === viewer.orgId && (a.createdBy === viewer._id || isManager(viewer));

const ownAudiences = (ctx: QueryCtx, user: Viewer) =>
  ctx.db.query("audiences").withIndex("by_orgId_and_createdBy", (q) => q.eq("orgId", user.orgId).eq("createdBy", user._id));

/** The workspace's shared audiences: marked shared, or from before sharing. */
async function sharedAudiences(ctx: QueryCtx, orgId: Id<"organizations">, limit: number): Promise<Doc<"audiences">[]> {
  const marked = await ctx.db.query("audiences").withIndex("by_orgId_and_shared", (q) => q.eq("orgId", orgId).eq("shared", true)).take(limit);
  const legacy = await ctx.db.query("audiences").withIndex("by_orgId_and_shared", (q) => q.eq("orgId", orgId).eq("shared", undefined)).take(limit);
  return [...marked, ...legacy];
}

async function visibleAudience(ctx: QueryCtx, audienceId: Id<"audiences">) {
  const user = await getCurrentUser(ctx);
  const audience = user && (await ctx.db.get(audienceId));
  return user && audience && canSee(user, audience) ? { user, audience } : null;
}

/** Your audiences and the shared ones; for admins and managers, every audience in the workspace. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = isManager(user)
      ? await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(ORG_READ)
      : [...new Map([...(await ownAudiences(ctx, user).take(AUDIENCES_MAX)), ...(await sharedAudiences(ctx, user.orgId, AUDIENCES_MAX))].map((a) => [a._id, a])).values()];
    const owners = new Map<Id<"users">, string>();
    for (const id of new Set(rows.map((a) => a.createdBy))) owners.set(id, (await ctx.db.get(id))?.name ?? "Former member");
    return rows
      .map((a) => ({
        _id: a._id, name: a.name, filterCount: a.filter.length, createdAt: a.createdAt, lastSentAt: a.lastSentAt, summary: a.summary,
        shared: isShared(a), mine: a.createdBy === user._id, ownerName: owners.get(a.createdBy) ?? "Former member", canEdit: canChange(user, a),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** One audience's recent sends and exports, newest first: what went where, when. */
export const history = query({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, args) => {
    if (!(await visibleAudience(ctx, args.audienceId))) return [];
    const runs = await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", args.audienceId)).order("desc").take(HISTORY_RUNS);
    const kept = new Set(runs.map((r) => `${r.target}@${r.at}`));
    // Runs from before audienceRuns existed, read back from their member rows.
    const rows = await ctx.db.query("audienceMembers").withIndex("by_audienceId_at", (q) => q.eq("audienceId", args.audienceId)).order("desc").take(HISTORY_READ + 1);
    const older = runsOf(rows, rows.length > HISTORY_READ).filter((r) => !kept.has(`${r.target}@${r.at}`));
    return [...runs.map(({ target, at, sent, exported, skipped }) => ({ target, at, sent, exported, skipped })), ...older]
      .sort((a, b) => b.at - a.at)
      .slice(0, HISTORY_RUNS);
  },
});

/** One audience's name and filter, for the contacts list to open it and edit the filter (or start a copy, without `canEdit`). */
export const byId = query({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, args) => {
    const found = await visibleAudience(ctx, args.audienceId);
    if (!found) return null;
    const { user, audience } = found;
    return { _id: audience._id, name: audience.name, filter: audience.filter, canEdit: canChange(user, audience) };
  },
});

function nameOrThrow(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) throw new ConvexError(`An audience name is 1 to ${NAME_MAX} characters`);
  return name;
}

async function checkFilter(ctx: QueryCtx, orgId: Id<"organizations">, filter: ViewFilter[]) {
  try {
    compileListRequest(await listedDef(ctx, orgId, "contact"), { filter });
  } catch (cause) {
    if (cause instanceof ListRequestError) throw new ConvexError(cause.message);
    throw cause;
  }
}

export const create = mutation({
  args: { name: v.string(), filter: v.array(listFilter), viewId: v.optional(v.id("savedViews")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const name = nameOrThrow(args.name);
    if ((await ownAudiences(ctx, user).take(AUDIENCES_MAX)).length >= AUDIENCES_MAX) throw new ConvexError(`At most ${AUDIENCES_MAX} audiences each`);
    await checkFilter(ctx, user.orgId, args.filter);
    if (args.viewId) {
      const view = await ctx.db.get(args.viewId);
      if (!view || view.orgId !== user.orgId || view.object !== "contact") throw new ConvexError("View not found");
    }
    const audienceId = await ctx.db.insert("audiences", { orgId: user.orgId, name, filter: args.filter, viewId: args.viewId, createdBy: user._id, shared: false, createdAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.audienceActions.refreshSummary, { orgId: user.orgId, audienceId });
    await checkIcpGaps(ctx, user.orgId, args.filter);
    return audienceId;
  },
});

/**
 * A new private audience of the contacts at accounts in a saved ICP. It follows
 * the ICP: when the ICP changes and the workspace rescores, so do its members.
 * The rep then narrows it like any other filter.
 */
/**
 * An audience that filters on ICPs reaches as far as their markets: check each active one for a gap the
 * TAM doesn't cover (outside-TAM fills, docs/tam-and-icps.md). Other filters have no market.
 */
async function checkIcpGaps(ctx: MutationCtx, orgId: Id<"organizations">, filter: ViewFilter[]) {
  await scheduleAudienceIcpGaps(ctx, orgId, filter);
}

export const createFromIcp = mutation({
  args: { icpId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const icp = (await readIcps(ctx, user.orgId)).find((row) => row.key === args.icpId);
    if (!icp) throw new ConvexError("ICP not found");
    if (!icp.active) throw new ConvexError(`Switch ${icp.name} on first: an ICP that is off has no accounts.`);
    if ((await ownAudiences(ctx, user).take(AUDIENCES_MAX)).length >= AUDIENCES_MAX) throw new ConvexError(`At most ${AUDIENCES_MAX} audiences each`);
    const filter: ViewFilter[] = [{ field: "accountIcpIds", op: "hasAny", value: [icp.key] }];
    await checkFilter(ctx, user.orgId, filter);
    const audienceId = await ctx.db.insert("audiences", {
      orgId: user.orgId, name: nameOrThrow(`${icp.name.slice(0, NAME_MAX - 9)}: people`), filter, createdBy: user._id, shared: false, createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.audienceActions.refreshSummary, { orgId: user.orgId, audienceId });
    await checkIcpGaps(ctx, user.orgId, filter);
    return audienceId;
  },
});

/**
 * Rename an audience, replace its filter, or share it with the workspace (or
 * take it back). Its creator, an admin or a manager. Its history stays: the
 * next export or push reads the new members.
 */
export const update = mutation({
  args: { audienceId: v.id("audiences"), name: v.optional(v.string()), filter: v.optional(v.array(listFilter)), shared: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const audience = await ctx.db.get(args.audienceId);
    if (!audience || !canSee(user, audience)) throw new ConvexError("Audience not found");
    if (!canChange(user, audience)) throw new ConvexError("Only the audience's creator, an admin or a manager can change it");
    const patch: { name?: string; filter?: ViewFilter[]; summary?: undefined; shared?: boolean } = {};
    if (args.name !== undefined) patch.name = nameOrThrow(args.name);
    if (args.shared !== undefined && args.shared !== isShared(audience)) {
      if (args.shared && (await sharedAudiences(ctx, user.orgId, AUDIENCES_MAX)).length >= AUDIENCES_MAX) {
        throw new ConvexError(`Your team already shares ${AUDIENCES_MAX} audiences; unshare one first`);
      }
      patch.shared = args.shared;
    }
    if (args.filter !== undefined) {
      await checkFilter(ctx, user.orgId, args.filter);
      patch.filter = args.filter;
      patch.summary = undefined;
    }
    await ctx.db.patch(audience._id, patch);
    if (args.filter !== undefined) {
      await ctx.scheduler.runAfter(0, internal.audienceActions.refreshSummary, { orgId: user.orgId, audienceId: audience._id });
      await checkIcpGaps(ctx, user.orgId, args.filter);
    }
  },
});

export const refreshSummaries = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db.query("audiences").paginate({ numItems: 50, cursor: args.cursor ?? null });
    for (const audience of page.page) {
      await ctx.scheduler.runAfter(0, internal.audienceActions.refreshSummary, { orgId: audience.orgId, audienceId: audience._id });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.audiences.refreshSummaries, { cursor: page.continueCursor });
    }
  },
});

export const storeSummary = internalMutation({
  args: {
    audienceId: v.id("audiences"), orgId: v.id("organizations"), filter: v.array(listFilter),
    summary: v.object({ total: v.number(), withEmail: v.number(), customVariables: v.array(v.string()), computedAt: v.number() }),
  },
  handler: async (ctx, args) => {
    const audience = await ctx.db.get(args.audienceId);
    if (!audience || audience.orgId !== args.orgId || JSON.stringify(audience.filter) !== JSON.stringify(args.filter)) return;
    if (audience.summary && audience.summary.computedAt > args.summary.computedAt) return;
    await ctx.db.patch(audience._id, { summary: args.summary });
  },
});

// ───────────────────────────── For the actions ─────────────────────────────

export const caller = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    // With the caller's access (CP14): an audience lists and exports only the people they see.
    return user ? { orgId: user.orgId, userId: user._id, role: user.role, ...(user.capabilities ? { capabilities: user.capabilities } : {}), access: await accessFor(ctx, user) } : null;
  },
});

/** Contact ids added to the audience one at a time (an event agent's route), on top of its filter. */
export const addedContactIds = internalQuery({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db.query("audienceAdditions").withIndex("by_audienceId_and_contactId", (q) => q.eq("audienceId", args.audienceId)).take(AUDIENCE_MAX + 1);
    return rows.map((r) => r.contactId);
  },
});

/** The audience, if it is in the org and (with a `viewer`) the viewer can see it. Without one, the system reads it. */
export const get = internalQuery({
  args: { orgId: v.id("organizations"), audienceId: v.id("audiences"), viewer: v.optional(v.object({ userId: v.id("users"), role: v.string(), capabilities: v.optional(v.array(v.string())) })) },
  handler: async (ctx, args) => {
    const audience = await ctx.db.get(args.audienceId);
    if (!audience || audience.orgId !== args.orgId) return null;
    if (args.viewer && !canSee({ _id: args.viewer.userId, orgId: args.orgId, role: args.viewer.role, capabilities: args.viewer.capabilities }, audience)) return null;
    return audience;
  },
});

/** One page of the lowercase emails already sent to `target` from this audience, from the sent-only index. */
export const sentEmails = internalQuery({
  args: { audienceId: v.id("audiences"), target: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ items: string[]; next: string | null }> => {
    const page = await ctx.db
      .query("audienceMembers")
      .withIndex("by_audienceId_target_outcome_email", (q) => q.eq("audienceId", args.audienceId).eq("target", args.target).eq("outcome", "sent"))
      .paginate({ numItems: SENT_PAGE, cursor: args.cursor });
    return { items: page.page.flatMap((r) => (r.email ? [r.email] : [])), next: page.isDone ? null : page.continueCursor };
  },
});

export const recordMembers = internalMutation({
  args: { orgId: v.id("organizations"), audienceId: v.id("audiences"), userId: v.id("users"), target: v.string(), at: v.number(), rows: v.array(memberRow) },
  handler: async (ctx, args) => {
    const { at } = args;
    const counts = { sent: 0, exported: 0, skipped: 0 };
    for (const r of args.rows) {
      await ctx.db.insert("audienceMembers", { orgId: args.orgId, audienceId: args.audienceId, target: args.target, at, by: args.userId, ...r });
      counts[r.outcome] += 1;
    }
    const run = await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", args.audienceId).eq("at", at).eq("target", args.target)).unique();
    if (run) await ctx.db.patch(run._id, { sent: run.sent + counts.sent, exported: run.exported + counts.exported, skipped: run.skipped + counts.skipped });
    else await ctx.db.insert("audienceRuns", { orgId: args.orgId, audienceId: args.audienceId, target: args.target, at, ...counts });
    if (args.rows.some((r) => r.outcome !== "skipped")) await ctx.db.patch(args.audienceId, { lastSentAt: at });
  },
});

// ───────────────────────────── Sequencer connections ─────────────────────────────

/** The providers an audience pushes to (lib/outbound/sequencers.ts). */
export const sequencerId = v.union(v.literal("instantly"), v.literal("emailbison"), v.literal("smartlead"));

const sequencerRow = (ctx: QueryCtx, orgId: Id<"organizations">, provider: SequencerId) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", provider)).first();

/** The encrypted key and the provider's host, for the actions only. */
export const sequencerKey = internalQuery({
  args: { orgId: v.id("organizations"), provider: sequencerId },
  handler: async (ctx, args) => {
    const row = await sequencerRow(ctx, args.orgId, args.provider);
    return row && row.isActive ? { accessToken: row.accessToken, instanceUrl: row.instanceUrl ?? null } : null;
  },
});

/** Which sequencers are connected, and where: never a key. */
export const sequencerStatus = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const out = {} as Record<SequencerId, { connected: boolean; connectedAt: number | null; instanceUrl: string | null }>;
    for (const provider of SEQUENCER_IDS) {
      const row = user && (await sequencerRow(ctx, user.orgId, provider));
      out[provider] = { connected: Boolean(row?.isActive), connectedAt: row?.connectedAt ?? null, instanceUrl: (row?.isActive && row.instanceUrl) || null };
    }
    return out;
  },
});

export const storeSequencerKey = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), provider: sequencerId, apiKey: v.string(), instanceUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptForStorage(args.apiKey);
    const existing = await sequencerRow(ctx, args.orgId, args.provider);
    if (existing) {
      await ctx.db.patch(existing._id, { accessToken: encrypted, instanceUrl: args.instanceUrl, isActive: true, connectedBy: args.userId, connectedAt: now, updatedAt: now });
      return;
    }
    await ctx.db.insert("integrations", {
      orgId: args.orgId, provider: args.provider, accessToken: encrypted, refreshToken: await encryptForStorage(""), instanceUrl: args.instanceUrl,
      isActive: true, connectedBy: args.userId, connectedAt: now, createdAt: now, updatedAt: now,
    });
  },
});

export const disconnectSequencer = mutation({
  args: { provider: sequencerId },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await sequencerRow(ctx, user.orgId, args.provider);
    if (row) await ctx.db.patch(row._id, { isActive: false, accessToken: await encryptForStorage(""), updatedAt: Date.now() });
  },
});
