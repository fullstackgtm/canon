import { ConvexError } from "convex/values";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { shippedPoint } from "./shippedReports";
import type { ModuleImport } from "./imports";
import { reportSource, recordObjectName } from "../../../modules/kernel/reports.ts";
import { checkSpec } from "../../reports";

export const REPORTS_MODULE = "@canon/reports";
export const REPORTS_BUILDER = "deals";

type Cursor = { table: "reports" | "dashboards"; after: string | null; refused: number; examples: string[] };

export const reportsImport: ModuleImport = {
  module: REPORTS_MODULE,
  label: "Canon saved reports and dashboards",
  async adopt(ctx, orgId, cursor) {
    const state: Cursor = cursor ? JSON.parse(cursor) : { table: "reports", after: null, refused: 0, examples: [] };
    if (cursor === null) await adoptTemplateReceipts(ctx, orgId);
    if (state.table === "reports") {
      const page = await ctx.db.query("reports").withIndex("by_orgId_createdBy", (q) => q.eq("orgId", orgId)).paginate({ cursor: state.after, numItems: 50 });
      for (const r of page.page) {
        if (r.module) continue;
        try {
          const source = reportSource(r.spec.object);
          if (!source) throw new ConvexError(`No source for ${r.spec.object}`);
          await checkSpec(ctx, orgId, { ...r.spec, object: recordObjectName(source)! });
          await ctx.db.patch(r._id, { module: { moduleId: REPORTS_MODULE, report: REPORTS_BUILDER }, spec: { ...r.spec, object: source } });
        } catch (e) {
          if (!(e instanceof ConvexError)) throw e;
          state.refused++;
          if (state.examples.length < 5) state.examples.push(`${r._id} (${r.name}): ${String(e.data).slice(0, 60)}`);
        }
      }
      return { cursor: JSON.stringify({ ...state, table: page.isDone ? "dashboards" : "reports", after: page.isDone ? null : page.continueCursor }) };
    }
    const page = await ctx.db.query("dashboards").withIndex("by_orgId_createdBy", (q) => q.eq("orgId", orgId)).paginate({ cursor: state.after, numItems: 50 });
    for (const d of page.page) {
      if (d.module) continue;
      // A tile on a report the import left untouched would not open from the module, and would refuse every later save:
      // such a dashboard stays Canon's, and the import says so.
      const stays = [];
      for (const t of d.tiles) {
        const r = await ctx.db.get(t.reportId);
        if (r && r.module?.moduleId !== REPORTS_MODULE) stays.push(t.reportId);
      }
      if (stays.length) {
        state.refused++;
        if (state.examples.length < 5) state.examples.push(`dashboard ${d._id} (${d.name}): a tile's report stayed`);
        continue;
      }
      await ctx.db.patch(d._id, { module: REPORTS_MODULE });
    }
    return page.isDone
      ? { cursor: null, ...(state.refused ? { error: `${state.refused} reports or dashboards left untouched. ${state.examples.join("; ")}`.slice(0, 600) } : {}) }
      : { cursor: JSON.stringify({ ...state, after: page.continueCursor }) };
  },
};

async function adoptTemplateReceipts(ctx: MutationCtx, orgId: Id<"organizations">) {
  const keys = {
    reports: { canon: ["open_pipeline", "pipeline_by_stage", "pipeline_by_forecast", "won_lost_by_month", "activities_by_owner", "new_deals_by_month", "new_leads_by_month"], enterprise: ["open_by_owner_stage"], velocity: ["velocity_by_quarter_stage"] },
    dashboards: { canon: ["revenue", "activity"], enterprise: [], velocity: [] },
  };
  const recipes = { canon: "canon-base", enterprise: "fsgtm-enterprise-deal", velocity: "fsgtm-velocity-deal" };
  const oldReports = await ctx.db.query("reports").withIndex("by_orgId_builtIn", (q) => q.eq("orgId", orgId).gt("builtIn", "")).take(50);
  const oldBoards = await ctx.db.query("dashboards").withIndex("by_orgId_builtIn", (q) => q.eq("orgId", orgId).gt("builtIn", "")).take(50);
  const seeded = [...oldReports, ...oldBoards].some((r) => !r.recipe);
  for (const table of ["reports", "dashboards"] as const) for (const family of ["canon", "enterprise", "velocity"] as const) for (const key of keys[table][family]) {
    const old = await ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_recipeId_and_contributionKey", (q) => q.eq("orgId", orgId).eq("point", `templates.${table}`).eq("recipeId", recipes[family]).eq("contributionKey", key)).unique();
    const legacy = (table === "reports" ? oldReports : oldBoards).find((r) => r.builtIn === key && !r.recipe);
    if (!old?.installed && !legacy && !(family === "canon" && seeded)) continue;
    const point = shippedPoint(table);
    const receipt = await ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_recipeId_and_contributionKey", (q) => q.eq("orgId", orgId).eq("point", point).eq("recipeId", REPORTS_MODULE).eq("contributionKey", key)).unique();
    if (receipt?.installed) continue;
    const rowId = old?.installed?.rowId ?? legacy?._id;
    const installed = { version: "0.6.0", at: Date.now(), ...(rowId ? { rowId } : {}) };
    if (receipt) await ctx.db.patch(receipt._id, { installed });
    else await ctx.db.insert("recipeEnablements", { orgId, point, recipeId: REPORTS_MODULE, contributionKey: key, enabled: true, at: Date.now(), installed });
  }
}
