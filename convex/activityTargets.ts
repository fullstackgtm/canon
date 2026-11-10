/**
 * What an activity is about (CP5a). A note, task, call or meeting is a ledger record; each record it is about is an
 * `activity_target` edge from it (lib/objects/associations.ts), so one activity shows on the timeline of its company,
 * its person and its deal. `log` saves the activity and its edges in one transaction.
 *
 * Activities saved before this have no edges: they name one company and maybe one person in their `accountId` and
 * `contactId` lookups. Those lookups stay the source for them and are read alongside the edges, so nothing is
 * migrated or dropped. A new activity still fills the lookups with its first company, person and deal, which My
 * tasks, the dialer and the record service's lists read, and adds an edge for every target.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { accessFor, sightJudge } from "./permissions";
import { visibleIds } from "./lib/scopedRecordClient";
import { admitRegisterIds } from "./lib/recordReferences";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { asListError, saveAsCaller } from "./objects";
import { callerClient, requireCaller } from "./records";
import { edgeStore } from "./associations";
import { applyEdgeCommand } from "./lib/objects/associations";
import { ACTIVITY_OBJECTS, linkedActivities, targetNames, type Activity, type ModuleActivityRow, type TargetObject } from "./lib/activities";
import type { ProjectedThrough } from "./lib/objects/listSpec";
import { fieldValue } from "./lib/objects/validators";
import { readModuleActivities } from "./lib/modules/activities";
import { createOnce, createdOrProposed } from "./lib/idempotency";

const activityObject = v.union(...ACTIVITY_OBJECTS.map((o) => v.literal(o)));
const targetObject = v.union(v.literal("account"), v.literal("contact"), v.literal("deal"), v.literal("lead"));

/** The lookup an activity names its company, person or deal in. A lead has none: an activity is about a lead by its edge alone. */
const lookupOf: Partial<Record<TargetObject, "accountId" | "contactId" | "dealId">> = { account: "accountId", contact: "contactId", deal: "dealId" };

/** Make a just-saved activity (its stream id) about these records, as its user. Used by the dialer, which saves its own call. */
export async function attachTargets(ctx: MutationCtx, user: Doc<"users">, activityId: string, toIds: readonly string[]): Promise<void> {
  if (!toIds.length) return;
  const edgeCtx = { orgId: user.orgId, source: { kind: "user" as const, ref: `user:${user._id}` }, actor: { kind: "user" as const, id: user._id }, now: Date.now() };
  const edges = await applyEdgeCommand(edgeStore(ctx), edgeCtx, { op: "target", activityId, toIds });
  if (edges.status === "invalid") throw new ConvexError(edges.message);
}

type Caller = Awaited<ReturnType<typeof requireCaller>>;

const logArgs = {
  object: activityObject,
  values: v.record(v.string(), fieldValue),
  targets: v.array(v.object({ object: targetObject, id: v.string() })),
  /** A create's Idempotency-Key (lib/idempotency.ts). */
  idempotencyKey: v.optional(v.string()),
};

/**
 * Save a note, task, call or meeting about these records, with an edge to
 * each. A role that sees only some companies or people logs about them
 * through logScoped, which admits them first (CP14): here such a target reads
 * as missing for that role.
 */
export const log = mutation({
  args: logArgs,
  handler: (ctx, args) => logAs(ctx, args, new Set()),
});

export const logAdmitted = internalMutation({
  args: { ...logArgs, admitted: v.array(v.string()) },
  handler: (ctx, { admitted, ...args }) => logAs(ctx, args, new Set(admitted)),
});

/** `log` with its companies and people admitted through the caller's scoped client: what the log form, the API and MCP call. */
export const logScoped = action({
  args: logArgs,
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof logAs>>> => {
    const caller = await requireCaller(ctx);
    const client = callerClient(ctx, caller);
    const of = (object: "account" | "contact") => args.targets.filter((t) => t.object === object).map((t) => t.id);
    const admitted = [
      ...await visibleIds(client, caller.orgId, "account", of("account")), ...await visibleIds(client, caller.orgId, "contact", of("contact")),
      ...await admitRegisterIds(client, caller.orgId, args.values),
    ];
    return ctx.runMutation(internal.activityTargets.logAdmitted, { ...args, admitted });
  },
});

async function logAs(ctx: MutationCtx, { idempotencyKey, ...args }: { object: (typeof ACTIVITY_OBJECTS)[number]; values: Record<string, unknown>; targets: Array<{ object: TargetObject; id: string }>; idempotencyKey?: string }, admitted: ReadonlySet<string>) {
  const user = await requireUser(ctx);
  return createOnce(ctx, { orgId: user.orgId, userId: user._id }, idempotencyKey, { op: "activities.log", ...args }, () => logAsUser(ctx, user, args, admitted), createdOrProposed);
}

async function logAsUser(ctx: MutationCtx, user: Doc<"users">, args: { object: (typeof ACTIVITY_OBJECTS)[number]; values: Record<string, unknown>; targets: Array<{ object: TargetObject; id: string }> }, admitted: ReadonlySet<string>) {
  {
    // Every record the activity is about must be one the caller sees; a hidden one reads as missing (CP14).
    const judge = sightJudge(ctx, [await accessFor(ctx, user)], admitted);
    for (const t of args.targets.filter((t) => t.id)) {
      if (t.object === "account" || t.object === "contact") {
        if (!judge.record(t.object, t.id)) throw new ConvexError(`${t.object === "account" ? "Company" : "Person"} not found`);
        continue;
      }
      // A deal or lead by its stream; an id that names no record is the edge command's to refuse.
      const streamId = ctx.db.normalizeId("canonEntities", t.id);
      const entity = streamId ? await ctx.db.get(streamId) : null;
      if (entity && entity.orgId === user.orgId && !(await judge.entity(entity))) throw new ConvexError("Record not found");
    }
    const targets = args.targets.filter((t) => t.id);
    // The first company, person and deal fill the lookups (the last assignment below is the first target).
    const lookups: Record<string, string> = {};
    for (const t of [...targets].reverse()) {
      const lookup = lookupOf[t.object];
      if (lookup) lookups[lookup] = t.id;
    }
    const result = await saveAsCaller(ctx, user, args.object, { op: "create", values: { ...args.values, ...lookups } }, { references: admitted });
    if (result.status === "applied" || result.status === "proposed") await attachTargets(ctx, user, result.streamId, targets.map((t) => t.id));
    return result;
  }
}

const EDGES_PER_TARGET_READ = 30;
const ACTIVITY_TARGETS_READ = 8;
/** People and deals of a company whose activities its timeline also shows. */
const RELATED_MAX = 25;
/** Activities one timeline reads from edges, and in all. */
const EDGE_ACTIVITIES_MAX = 100;
const ACTIVITIES_MAX = 150;

/** Activity ids with an edge to any of `toIds`, newest edge first, at most `limit`. */
export const aboutRecords = internalQuery({
  args: { orgId: v.id("organizations"), toIds: v.array(v.string()), limit: v.number() },
  handler: async (ctx, args): Promise<string[]> => {
    const perTarget = await Promise.all(args.toIds.map((toId) => ctx.db.query("associations")
      // The index ends in _creationTime, so descending is newest edge first.
      .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", args.orgId).eq("association", "activity_target").eq("toId", toId))
      .order("desc").take(EDGES_PER_TARGET_READ)));
    const edges = perTarget.flat().filter((e) => e.active).sort((a, b) => b.createdAt - a.createdAt);
    return [...new Set(edges.map((e) => e.fromId))].slice(0, args.limit);
  },
});

/**
 * Every active activity edge to any of `toIds` (a module's activities read, convex/lib/modules/recordReads.ts), or a
 * refusal past `limit`: the read never computes on part of them.
 */
export const edgesTo = internalQuery({
  args: { orgId: v.id("organizations"), toIds: v.array(v.string()), limit: v.number() },
  handler: async (ctx, args): Promise<Array<{ fromId: string; toId: string }>> => {
    const out: Array<{ fromId: string; toId: string }> = [];
    for (const toId of args.toIds) {
      const edges = await ctx.db.query("associations")
        .withIndex("by_orgId_association_toId", (q) => q.eq("orgId", args.orgId).eq("association", "activity_target").eq("toId", toId))
        .take(args.limit + 1);
      for (const e of edges) if (e.active) out.push({ fromId: e.fromId, toId });
      if (edges.length > args.limit || out.length > args.limit) throw new ConvexError(`The records asked about have more than ${args.limit} activities; narrow the read or raise its limit.`);
    }
    return out;
  },
});

/** The deal each ledger stream projects to, by stream id: an activity's `dealId` lookup as a module reads it. */
export const dealsOfStreams = internalQuery({
  args: { orgId: v.id("organizations"), streamIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const raw of args.streamIds) {
      const id = ctx.db.normalizeId("canonEntities", raw);
      const e = id ? await ctx.db.get(id) : null;
      if (e && e.orgId === args.orgId && e.projectionTable === "deals") out[raw] = e.projectionId;
    }
    return out;
  },
});

/** Each activity's active targets. */
export const targetsOf = internalQuery({
  args: { orgId: v.id("organizations"), activityIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string[]>> => {
    const rows = await Promise.all(args.activityIds.map((fromId) => ctx.db.query("associations")
      .withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", args.orgId).eq("association", "activity_target").eq("fromId", fromId))
      .take(ACTIVITY_TARGETS_READ)));
    return Object.fromEntries(args.activityIds.map((id, i) => [id, rows[i].filter((e) => e.active).map((e) => e.toId)]));
  },
});

const nullableString = v.union(v.string(), v.null());
const activityCommon = {
  id: v.string(), at: v.number(), ownerId: nullableString,
  targets: v.optional(v.array(v.object({ object: targetObject, id: v.string(), name: v.string() }))),
};
const activity = v.union(
  v.object({ ...activityCommon, kind: v.literal("note"), body: v.string() }),
  v.object({ ...activityCommon, kind: v.literal("task"), subject: v.string(), dueDate: nullableString, status: nullableString }),
  v.object({ ...activityCommon, kind: v.literal("call"), subject: nullableString, outcome: nullableString }),
  v.object({ ...activityCommon, kind: v.literal("meeting"), title: v.string(), startAt: v.number() }),
  v.object({ ...activityCommon, kind: v.literal("module"), activityKind: v.string(), subject: v.string(), status: nullableString, dueDate: nullableString, date: v.optional(v.string()),
    source: v.object({ moduleId: v.string(), collection: v.string(), key: v.string(), href: v.string() }) }),
);

function lowest(all: readonly ProjectedThrough[]): ProjectedThrough {
  const shards = new Set(all.flatMap((p) => Object.keys(p)));
  return Object.fromEntries([...shards].map((s) => [s, Math.min(...all.map((p) => p[s] ?? 0))]));
}

/**
 * The activities on a company, person or deal, newest first: those with an edge to it, and those naming it in an
 * `accountId`, `contactId` or `dealId` lookup. A company's also include its people's and its deals' (at most
 * RELATED_MAX of each). Each lists the records it is about, so a page can say which one it was on.
 */
export const forRecord = action({
  args: { object: targetObject, id: v.string() },
  returns: v.object({ activities: v.array(activity), projectedThrough: v.record(v.string(), v.number()), moduleActivityUnavailable: v.optional(v.boolean()) }),
  handler: async (ctx, args): Promise<{ activities: Activity[]; projectedThrough: ProjectedThrough; moduleActivityUnavailable?: boolean }> =>
    activitiesForRecord(ctx, await requireCaller(ctx, { read: true }), args.object, args.id),
});

/** forRecord's read, for a caller already resolved (a deal's play reads its deal's calls and meetings). */
export async function activitiesForRecord(
  ctx: ActionCtx, caller: Caller, object: TargetObject, id: string,
): Promise<{ activities: Activity[]; projectedThrough: ProjectedThrough; moduleActivityUnavailable?: boolean }> {
  // Every activity, person and deal read as the caller sees them (CP14).
  const client = callerClient(ctx, caller);
  const orgId = caller.orgId as Id<"organizations">;
  const read = async () => {
    const on: Record<TargetObject, string[]> = { account: [], contact: [], deal: [], lead: [] };
    on[object].push(id);
    if (object === "account") {
      const [inbound, primary, deals] = await Promise.all([
        ctx.runQuery(internal.associations.edges, { orgId, association: "contact_account", side: "to", id }),
        client.listContacts(caller.orgId, { filter: { accountId: id }, limit: RELATED_MAX }),
        client.listObjects(caller.orgId, "deal", { filter: [{ field: "companyId", op: "eq", value: id }], limit: RELATED_MAX }),
      ]);
      on.contact.push(...new Set([...primary.rows.map((c) => c.id), ...inbound.active.map((e) => e.fromId)].slice(0, RELATED_MAX)));
      on.deal.push(...deals.rows.map((r) => r.id));
    }
    const [byLookup, edgeIds] = await Promise.all([
      Promise.all((Object.keys(on) as TargetObject[]).flatMap((o) => {
        const field = lookupOf[o];
        return field && on[o].length ? [linkedActivities(client, caller.orgId, { field, id: on[o] })] : [];
      })),
      ctx.runQuery(internal.activityTargets.aboutRecords, { orgId, toIds: Object.values(on).flat(), limit: EDGE_ACTIVITIES_MAX }),
    ]);
    const known = new Set(byLookup.flatMap((l) => l.activities.map((a) => a.id)));
    const byEdge = await linkedActivities(client, caller.orgId, { field: "id", id: edgeIds.filter((id) => !known.has(id)) });
    const pages = [...byLookup, byEdge];
    const merged = new Map(pages.flatMap((p) => p.activities).map((a) => [a.id, a]));
    const lookups = Object.assign({}, ...pages.map((p) => p.lookups)) as Record<string, string[]>;
    const activities = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, ACTIVITIES_MAX);
    const edges = await ctx.runQuery(internal.activityTargets.targetsOf, { orgId, activityIds: activities.map((a) => a.id) });
    const aboutIds = activities.map((a) => [...new Set([...(edges[a.id] ?? []), ...(lookups[a.id] ?? [])])]);
    const names = await targetNames(client, caller.orgId, aboutIds.flat());
    return {
      activities: activities.map((a, i) => ({ ...a, targets: aboutIds[i].flatMap((id) => names.get(id) ?? []) })),
      targets: (Object.keys(on) as TargetObject[]).flatMap((object) => on[object].map((id) => ({ object, id }))),
      projectedThrough: lowest(pages.map((p) => p.projectedThrough).filter((p) => Object.keys(p).length > 0)),
    };
  };
  let ledger: Awaited<ReturnType<typeof read>>;
  try {
    ledger = await asListError(read);
  } catch {
    // A deploy that adds lookup columns is caught up by the projector's next run, which an idle org never triggers;
    // a waiting nudge runs it, then read again.
    const heads = await ctx.runQuery(internal.objects.callerShardHeads, {});
    await client.nudgeProjector(caller.orgId, heads, process.env.CONVEX_SITE_URL, { wait: true });
    ledger = await asListError(read);
  }
  let modules: ModuleActivityRow[] = [];
  let moduleActivityUnavailable = false;
  try {
    modules = await readModuleActivities(ctx, client, caller.orgId, { targets: ledger.targets, since: null, limit: 1000 });
  } catch (error) {
    if (!(error instanceof ConvexError) || typeof error.data !== "object" || error.data === null || !("kind" in error.data) || error.data.kind !== "module_activity_limit") throw error;
    moduleActivityUnavailable = true;
  }
  return { ...(moduleActivityUnavailable ? { moduleActivityUnavailable: true } : {}), activities: [...ledger.activities, ...modules.map((r) => r.activity)].sort((a, b) => b.at - a.at).slice(0, ACTIVITIES_MAX), projectedThrough: ledger.projectedThrough };
}
