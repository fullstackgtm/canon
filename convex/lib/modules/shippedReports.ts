import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import type { ReportSpec } from "../objects/validators";

export const shippedPoint = (table: "reports" | "dashboards") => `module.templates.${table}`;

export async function installShippedReports(ctx: MutationCtx, orgId: Id<"organizations">, m: ModuleManifest, validate: (spec: ReportSpec) => Promise<void>): Promise<number> {
  if (!m.reports && !m.dashboards) return 0;
  const admins = await ctx.db.query("users").withIndex("by_orgId_role", (q) => q.eq("orgId", orgId).eq("role", "admin")).take(50);
  const owner = admins.find((u) => u.isActive !== false);
  if (!owner) return 0;
  type Template = NonNullable<ModuleManifest["reports"]>[string] | NonNullable<ModuleManifest["dashboards"]>[string];
  let created = 0;
  const reports = new Map<string, Id<"reports">>();
  for (const table of ["reports", "dashboards"] as const) {
    for (const [key, template] of Object.entries((m[table] ?? {}) as Record<string, Template>)) {
      const point = shippedPoint(table);
      const receipt = await ctx.db.query("recipeEnablements").withIndex("by_orgId_and_point_and_recipeId_and_contributionKey", (q) => q.eq("orgId", orgId).eq("point", point).eq("recipeId", m.id).eq("contributionKey", key)).unique();
      let rowId = receipt?.installed?.rowId;
      if (!receipt?.installed) {
        const existing = await ctx.db.query(table).withIndex("by_orgId_builtIn", (q) => q.eq("orgId", orgId).eq("builtIn", key)).take(50);
        const adopted = existing.find((r) => typeof r.module === "string" ? r.module === m.id : r.module?.moduleId === m.id);
        rowId = adopted?._id;
        if (!rowId) {
          if (table === "reports" && "spec" in template) {
            await validate(template.spec);
            rowId = await ctx.db.insert("reports", { orgId, name: template.name, spec: template.spec, shared: true, createdBy: owner._id, updatedAt: Date.now(), builtIn: key, module: { moduleId: m.id, report: template.report } });
          } else if (table === "dashboards" && "tiles" in template) {
            const tiles = template.tiles.flatMap((tile) => { const reportId = reports.get(tile.report); return reportId ? [{ reportId, wide: tile.wide }] : []; });
            rowId = await ctx.db.insert("dashboards", { orgId, name: template.name, tiles, shared: true, createdBy: owner._id, updatedAt: Date.now(), builtIn: key, module: m.id });
          }
          if (rowId) created++;
        }
        const installed = { version: m.version, at: Date.now(), ...(rowId ? { rowId } : {}) };
        if (receipt) await ctx.db.patch(receipt._id, { installed });
        else await ctx.db.insert("recipeEnablements", { orgId, point, recipeId: m.id, contributionKey: key, enabled: true, at: Date.now(), installed });
      }
      if (table === "reports" && rowId) {
        const id = ctx.db.normalizeId("reports", rowId);
        const r = id ? await ctx.db.get(id) : null;
        if (r?.orgId === orgId && r.module?.moduleId === m.id && r.shared) reports.set(key, r._id);
      }
    }
  }
  return created;
}
