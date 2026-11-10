/**
 * Reports (CP9): a saved aggregate over one object's records, drawn as a
 * table or a chart. A report is its creator's until shared, as a saved view
 * is; only its creator or an admin changes or deletes it. Running one is a
 * read: the record service groups and measures the records where they live
 * (lib/objects/reportSpec.ts), so it answers at TAM scale.
 */
import { legacyReportSpec, moduleReportSpec, reportsLegacyState, REPORTS_MODULE } from "./lib/reports/legacy";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { callerClient, requireCaller } from "./records";
import { asListError } from "./objects";
import { listedDef } from "./savedViews";
import { activityReportDef, compileAggregateRequest, relationsOf, type AggregateResponse } from "./lib/objects/reportSpec";
import { ACTIVITY_OBJECT } from "../modules/kernel/reportLanguage";
import { ListRequestError } from "./lib/objects/listSpec";
import { plainMeasures, plainSpec } from "./lib/objects/metricSplit";
import { reportSpec, type ReportSpec } from "../modules/kernel/reportValidators";

const NAME_MAX = 80;
/** Reports a user may save, and reports an org may share: the list shows them all. */
export const REPORTS_MAX = 200;

/** A report's spec, checked against the org's definitions as the record service will read them. */
export async function checkSpec(ctx: QueryCtx, orgId: Id<"organizations">, spec: ReportSpec): Promise<void> {
  const def = spec.object === ACTIVITY_OBJECT ? activityReportDef() : await listedDef(ctx, orgId, spec.object);
  if (def.archivedAt !== undefined) throw new ConvexError(`${def.pluralLabel} is archived`);
  const related = new Map<string, Awaited<ReturnType<typeof listedDef>>>();
  for (const rel of relationsOf(spec.object, def)) {
    if (spec.groupBy.some((g) => g.via === rel.via) && !related.has(rel.object)) related.set(rel.object, await listedDef(ctx, orgId, rel.object));
  }
  try {
    compileAggregateRequest(spec.object, def, plainSpec(spec), (o) => related.get(o));
  } catch (e) {
    if (e instanceof ListRequestError) throw new ConvexError(e.message);
    throw e;
  }
}

export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) throw new ConvexError(`A report name is 1 to ${NAME_MAX} characters`);
  return trimmed;
}

// Canon dashboards may retain tiles whose reports were adopted by Reports. Their original access checks still apply.
const visibleTo = (user: Doc<"users">, includeReportsModule = true) => (r: Doc<"reports">) => r.orgId === user.orgId && (r.module === undefined || (includeReportsModule && r.module.moduleId === REPORTS_MODULE)) && (r.shared || r.createdBy === user._id);

const sharedReports = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("reports").withIndex("by_orgId_shared", (q) => q.eq("orgId", orgId).eq("shared", true));
const ownReports = (ctx: QueryCtx, user: Doc<"users">) =>
  ctx.db.query("reports").withIndex("by_orgId_createdBy", (q) => q.eq("orgId", user.orgId).eq("createdBy", user._id));

const summary = (user: Doc<"users">) => (r: Doc<"reports">) =>
  ({ _id: r._id, name: r.name, shared: r.shared, spec: legacyReportSpec(r.spec), mine: r.createdBy === user._id, updatedAt: r.updatedAt, recipe: r.recipe ?? null });

/** The caller's reports and the org's shared ones, by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const byId = new Map([...(await ownReports(ctx, user).take(REPORTS_MAX)), ...(await sharedReports(ctx, user.orgId).take(REPORTS_MAX))].map((r) => [r._id, r]));
    return [...byId.values()].filter(visibleTo(user)).map(summary(user)).sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const get = query({
  args: { reportId: v.id("reports") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const r = user && (await ctx.db.get(args.reportId));
    return user && r && visibleTo(user)(r) ? summary(user)(r) : null;
  },
});

export const legacyRoute = query({
  args: { reportId: v.string() },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    const id = ctx.db.normalizeId("reports", a.reportId);
    const r = user && id ? await ctx.db.get(id) : null;
    return !!user && !!r && visibleTo(user, false)(r);
  },
});

export const create = mutation({
  args: { name: v.string(), shared: v.boolean(), spec: reportSpec },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await checkSpec(ctx, user.orgId, args.spec);
    if ((await ownReports(ctx, user).take(REPORTS_MAX)).length >= REPORTS_MAX) throw new ConvexError(`At most ${REPORTS_MAX} saved reports`);
    if (args.shared && (await sharedReports(ctx, user.orgId).take(REPORTS_MAX)).length >= REPORTS_MAX) throw new ConvexError(`Your team already shares ${REPORTS_MAX} reports; unshare one first`);
    const takeover = (await reportsLegacyState(ctx, user.orgId)).takeover;
    return ctx.db.insert("reports", { ...(takeover ? { module: { moduleId: REPORTS_MODULE, report: "deals" } } : {}), orgId: user.orgId, name: cleanName(args.name), createdBy: user._id, shared: args.shared, spec: takeover ? moduleReportSpec(args.spec) : args.spec, updatedAt: Date.now() });
  },
});

async function ownReport(ctx: QueryCtx, reportId: Id<"reports">) {
  const user = await requireUser(ctx);
  const r = await ctx.db.get(reportId);
  if (!r || !visibleTo(user)(r)) throw new ConvexError("Report not found");
  if (r.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError(refusal("shared.moderate"));
  return { user, report: r };
}

/** Rename, share or unshare, or replace the spec. */
export const update = mutation({
  args: { reportId: v.id("reports"), name: v.optional(v.string()), shared: v.optional(v.boolean()), spec: v.optional(reportSpec) },
  handler: async (ctx, args) => {
    const { user, report } = await ownReport(ctx, args.reportId);
    if (args.spec) await checkSpec(ctx, user.orgId, args.spec);
    if (args.shared && !report.shared && (await sharedReports(ctx, user.orgId).take(REPORTS_MAX)).length >= REPORTS_MAX) {
      throw new ConvexError(`Your team already shares ${REPORTS_MAX} reports; unshare one first`);
    }
    await ctx.db.patch(report._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.shared !== undefined ? { shared: args.shared } : {}),
      ...(args.spec ? { spec: report.module?.moduleId === REPORTS_MODULE ? moduleReportSpec(args.spec) : args.spec } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { reportId: v.id("reports") },
  handler: async (ctx, args) => {
    const { report } = await ownReport(ctx, args.reportId);
    await ctx.db.delete(report._id);
  },
});

/** The caller's org and the spec to run: the one given, checked, or a saved report the caller can see. */
export const runContext = internalQuery({
  args: { spec: v.optional(reportSpec), reportId: v.optional(v.id("reports")) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    let spec = args.spec;
    if (args.reportId) {
      const r = await ctx.db.get(args.reportId);
      if (!r || !visibleTo(user)(r)) throw new ConvexError("Report not found");
      spec = legacyReportSpec(r.spec);
    }
    if (!spec) throw new ConvexError("Give a spec or a reportId");
    await checkSpec(ctx, user.orgId, spec);
    // A report counts only the records the caller's role sees (CP14), whoever saved it.
    return { orgId: user.orgId as string, spec };
  },
});

/**
 * Run a report: `spec` (unsaved, as the builder edits it) or a saved
 * `reportId`. Returns the groups in key order, a subtotal per first key when
 * there are two keys, and the total, with one value per measure. Currency is
 * in cents.
 */
export const run = action({
  args: { spec: v.optional(reportSpec), reportId: v.optional(v.id("reports")) },
  handler: async (ctx, args): Promise<AggregateResponse & { spec: ReportSpec }> => {
    const { orgId, spec } = await ctx.runQuery(internal.reports.runContext, args);
    // A report counts only the records the caller's role sees (CP14), whoever saved it.
    const caller = await requireCaller(ctx, { read: true });
    const res = await asListError(() => callerClient(ctx, caller).aggregate(orgId, spec.object, { filter: spec.filter, groupBy: spec.groupBy, measures: plainMeasures(spec.measures) }));
    return { ...res, spec };
  },
});
