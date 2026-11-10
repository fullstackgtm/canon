/**
 * Dashboards (CP9): saved reports' charts pinned in a grid, several per
 * workspace. A dashboard is its creator's until shared, as a report is; a
 * shared one shows only shared reports, so everyone who opens it sees every
 * tile. Canon's own reports and the Revenue and Activity dashboards are
 * canon-base templates (recipes/canon-base/recipe.md), installed the first time
 * someone opens Dashboards (convex/templates.ts ensureDefaults).
 */
import { reportsLegacyState, REPORTS_MODULE } from "./lib/reports/legacy";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { RECIPES } from "../recipes/index.ts";

import { checkTiles, cleanDashboardName as cleanName, DASHBOARDS_MAX, tile } from "./lib/dashboardRules";
export { TILES_MAX } from "./lib/dashboardRules";

const visibleTo = (user: Doc<"users">, fallback = false) => (d: Doc<"dashboards">) => (d.module === undefined || (fallback && d.module === REPORTS_MODULE)) && d.orgId === user.orgId && (d.shared || d.createdBy === user._id);
const shared = (ctx: QueryCtx, orgId: Id<"organizations">, module?: string) => ctx.db.query("dashboards").withIndex("by_orgId_module_shared", (q) => q.eq("orgId", orgId).eq("module", module).eq("shared", true));
const own = (ctx: QueryCtx, user: Doc<"users">, module?: string) => ctx.db.query("dashboards").withIndex("by_orgId_module_createdBy", (q) => q.eq("orgId", user.orgId).eq("module", module).eq("createdBy", user._id));

const summary = (user: Doc<"users">) => (d: Doc<"dashboards">) =>
  ({ _id: d._id, name: d.name, shared: d.shared, tiles: d.tiles, mine: d.createdBy === user._id, builtIn: d.builtIn ?? null, updatedAt: d.updatedAt });

/** The caller's dashboards and the workspace's shared ones: built-in first (Revenue leads), then by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const { fallback } = await reportsLegacyState(ctx, user.orgId);
    const rows = [];
    for (const moduleId of fallback ? [undefined, REPORTS_MODULE] : [undefined]) rows.push(...await own(ctx, user, moduleId).take(DASHBOARDS_MAX), ...await shared(ctx, user.orgId, moduleId).take(DASHBOARDS_MAX));
    const byId = new Map(rows.map((d) => [d._id, d]));
    const order = RECIPES["canon-base"].templates.filter((t) => t.kind === "dashboard").map((t) => t.key);
    const rank = (d: { builtIn: string | null }) => (d.builtIn ? order.indexOf(d.builtIn) : Infinity);
    return [...byId.values()].filter(visibleTo(user, fallback)).map(summary(user)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  },
});

async function ownDashboard(ctx: QueryCtx, dashboardId: Id<"dashboards">) {
  const user = await requireUser(ctx);
  const d = await ctx.db.get(dashboardId);
  if (!d || !visibleTo(user, (await reportsLegacyState(ctx, user.orgId)).fallback)(d)) throw new ConvexError("Dashboard not found");
  if (d.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError(refusal("shared.moderate"));
  return { user, dashboard: d };
}

/** A retained Canon dashboard keeps its legacy URL, including during Reports takeover. */
export const legacyRoute = query({
  args: { dashboardId: v.string() },
  handler: async (ctx, a) => {
    const user = await getCurrentUser(ctx);
    const id = ctx.db.normalizeId("dashboards", a.dashboardId);
    const d = user && id ? await ctx.db.get(id) : null;
    return !!user && !!d && visibleTo(user)(d);
  },
});

export const create = mutation({
  args: { name: v.string(), shared: v.boolean(), tiles: v.optional(v.array(tile)) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    // Core creates stay Canon-owned so retained and adopted reports can share a dashboard.
    if ((await own(ctx, user).take(DASHBOARDS_MAX)).length >= DASHBOARDS_MAX) throw new ConvexError(`At most ${DASHBOARDS_MAX} dashboards`);
    const tiles = args.tiles ?? [];
    await checkTiles(ctx, user, tiles, args.shared, [undefined, REPORTS_MODULE]);
    return ctx.db.insert("dashboards", { orgId: user.orgId, name: cleanName(args.name), createdBy: user._id, shared: args.shared, tiles, updatedAt: Date.now() });
  },
});

/** Rename, share or unshare, or replace the tiles (their order is the grid's). */
export const update = mutation({
  args: { dashboardId: v.id("dashboards"), name: v.optional(v.string()), shared: v.optional(v.boolean()), tiles: v.optional(v.array(tile)) },
  handler: async (ctx, args) => {
    const { user, dashboard } = await ownDashboard(ctx, args.dashboardId);
    const tiles = args.tiles ?? dashboard.tiles;
    await checkTiles(ctx, user, tiles, args.shared ?? dashboard.shared, dashboard.module === REPORTS_MODULE ? REPORTS_MODULE : [undefined, REPORTS_MODULE]);
    await ctx.db.patch(dashboard._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.shared !== undefined ? { shared: args.shared } : {}),
      ...(args.tiles ? { tiles } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { dashboardId: v.id("dashboards") },
  handler: async (ctx, args) => {
    const { dashboard } = await ownDashboard(ctx, args.dashboardId);
    await ctx.db.delete(dashboard._id);
  },
});

/** Pin a report's chart to the end of a dashboard, or to a new one named `name`. Returns the dashboard. */
export const pin = mutation({
  args: { reportId: v.id("reports"), dashboardId: v.optional(v.id("dashboards")), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<"dashboards">> => {
    if (!args.dashboardId) {
      const user = await requireUser(ctx);
      await checkTiles(ctx, user, [args], false, [undefined, REPORTS_MODULE]);
      return ctx.db.insert("dashboards", { orgId: user.orgId, name: cleanName(args.name ?? ""), createdBy: user._id, shared: false, tiles: [{ reportId: args.reportId, wide: false }], updatedAt: Date.now() });
    }
    const { user, dashboard } = await ownDashboard(ctx, args.dashboardId);
    const tiles = [...dashboard.tiles, { reportId: args.reportId, wide: false }];
    await checkTiles(ctx, user, tiles, dashboard.shared, dashboard.module === REPORTS_MODULE ? REPORTS_MODULE : [undefined, REPORTS_MODULE]);
    await ctx.db.patch(dashboard._id, { tiles, updatedAt: Date.now() });
    return dashboard._id;
  },
});
