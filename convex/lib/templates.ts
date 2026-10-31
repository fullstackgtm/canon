/**
 * Installing a recipe's templates (docs/recipes.md, "Templates"). recipes/templates.ts checks each kind's spec;
 * `INSTALLERS` here writes its row. Enabling a template contribution installs it once per (workspace, recipe, key):
 * its recipeEnablements row records the install, so a row the workspace deleted is never made again, and disabling
 * or uninstalling leaves the row alone. Canon never rewrites an installed row, whatever a later version's spec says.
 */
import { reportSource } from "../../modules/kernel/reports.ts";
import { reportsLegacyState } from "./reports/legacy";
import { can, refusal } from "./capabilities";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { insertRule, requireAdmin } from "../automations";
import { cleanPointOfView, insertIcp } from "../icps";
import { savePipeline } from "../pipelines";
import { checkSpec } from "../reports";
import { RECIPES, contributionsOf, isTemplatePoint, pointOf, POINT_IDS, templatePoint, type Contribution, type PointId } from "../../recipes/index.ts";
import { TEMPLATE_KINDS, type Provenance, type Template, type TemplateKind } from "../../recipes/templates.ts";
import { enablementRow, type FoundRecipe } from "./recipes";

type Db = Pick<QueryCtx, "db">;
type Table = "reports" | "dashboards" | "automationRules" | "icps" | "dealPipelines" | "linkedinCadences";

type Installer<K extends TemplateKind> = {
  table: Table;
  /** Where the installed row opens. */
  href: (id: string) => string;
  /** Write the row as `user` and return it; null for a kind that is only offered until first use. */
  install(ctx: MutationCtx, user: Doc<"users">, t: Template<K>, recipe: Provenance, from: FoundRecipe): Promise<string | null>;
};

/** Canon seeded its reports and dashboards before they were templates: such a row has `builtIn` and no `recipe`. */
async function seededBefore(ctx: Db, orgId: Id<"organizations">, table: "reports" | "dashboards", key: string): Promise<{ id: string } | "deleted" | null> {
  const legacy = async (t: "reports" | "dashboards") => (await ctx.db.query(t).withIndex("by_orgId_builtIn", (q) => q.eq("orgId", orgId).gt("builtIn", "")).take(50)).filter((r) => !r.recipe);
  const rows = await legacy(table);
  const hit = rows.find((r) => r.builtIn === key);
  if (hit) return { id: hit._id };
  return rows.length || (await legacy(table === "reports" ? "dashboards" : "reports")).length ? "deleted" : null;
}

const builtIn = (recipe: Provenance) => (recipe.id === "canon-base" ? { builtIn: recipe.key } : {});

export const INSTALLERS: { [K in TemplateKind]: Installer<K> } = {
  report: {
    table: "reports",
    href: (id) => `/dashboard/reports?report=${id}`,
    async install(ctx, user, t, recipe) {
      await checkSpec(ctx, user.orgId, t.spec.spec);
      const takeover = (await reportsLegacyState(ctx, user.orgId)).takeover;
      const source = takeover ? reportSource(t.spec.spec.object) : null;
      if (takeover && !source) throw new ConvexError(`No Reports source for ${t.spec.spec.object}`);
      return ctx.db.insert("reports", { orgId: user.orgId, name: t.title, createdBy: user._id, shared: true, spec: source ? { ...t.spec.spec, object: source } : t.spec.spec, ...(takeover ? { module: { moduleId: "@canon/reports", report: "deals" } } : {}), updatedAt: Date.now(), ...builtIn(recipe), recipe });
    },
  },
  dashboard: {
    table: "dashboards",
    href: (id) => `/dashboard/dashboards?d=${id}`,
    // Its reports install first, the same way. A tile is left out when the workspace deleted its report, or turned
    // the report off before it was ever installed.
    async install(ctx, user, t, recipe, from) {
      const tiles: Array<{ reportId: Id<"reports">; wide: boolean }> = [];
      for (const tile of t.spec.tiles) {
        const report = contributionsOf(from.recipe).find((c) => c.point === "templates.reports" && c.key === tile.report);
        if (!report) continue;
        const before = await enablementRow(ctx, user.orgId, "templates.reports", from.recipe.id, tile.report);
        if (before && !before.enabled && !before.installed) continue;
        await installContribution(ctx, user, from, report, { decided: false });
        const rowId = (await enablementRow(ctx, user.orgId, "templates.reports", from.recipe.id, tile.report))?.installed?.rowId;
        const reportId = rowId ? ctx.db.normalizeId("reports", rowId) : null;
        if (reportId && (await ctx.db.get(reportId))) tiles.push({ reportId, wide: tile.wide });
      }
      return ctx.db.insert("dashboards", { orgId: user.orgId, name: t.title, createdBy: user._id, shared: true, tiles, updatedAt: Date.now(), ...builtIn(recipe), recipe });
    },
  },
  automation: {
    table: "automationRules",
    href: () => "/dashboard/agents#automations",
    install: async (ctx, _user, t, recipe, from) =>
      insertRule(ctx, await requireAdmin(ctx), { name: t.title, object: t.spec.object, trigger: t.spec.trigger, conditions: t.spec.conditions, actions: t.spec.actions },
        { paused: `Installed from ${from.recipe.title}. Resume it to start.`, recipe }),
  },
  icp: {
    table: "icps",
    href: (id) => `/dashboard/icps?sel=${id}`,
    install: (ctx, user, t, recipe) => insertIcp(ctx, {
      orgId: user.orgId, name: t.title, description: t.spec.description?.trim() || undefined, pointOfView: cleanPointOfView(t.spec.pointOfView), offer: cleanPointOfView(t.spec.offer),
      spec: t.spec.spec, source: "recipe", createdBy: user._id, recipe,
    }),
  },
  pipeline: {
    table: "dealPipelines",
    href: () => "/dashboard/customization/pipelines",
    install: (ctx, user, t, recipe) => savePipeline(ctx, user.orgId, { target: { kind: "new" }, name: t.title, stages: t.spec.stages.map((s) => ({ ...s, value: null })) }, recipe),
  },
  cadence: {
    table: "linkedinCadences",
    href: () => "/dashboard/linkedin",
    install: async () => null,
  },
};

/**
 * Install one template contribution once. `decided`: a decider turned it on, so the kind's role applies. Otherwise
 * Canon installs a default-on template for whoever opened the page it shows on, as it always seeded its built-ins.
 * Returns whether it made a row.
 */
export async function installContribution(ctx: MutationCtx, user: Doc<"users">, from: FoundRecipe, c: Contribution, { decided }: { decided: boolean }): Promise<boolean> {
  const t = c.declares as Template;
  const point = templatePoint(t.kind);
  if (t.kind === "report" || t.kind === "dashboard") {
    if (from.recipe.id === "canon-base" && (await reportsLegacyState(ctx, user.orgId)).takeover) return false;
  }
  const row = await enablementRow(ctx, user.orgId, point, from.recipe.id, c.key);
  if (row?.installed) return false;
  if (decided && !can(user, TEMPLATE_KINDS[t.kind].capability)) throw new ConvexError(refusal(TEMPLATE_KINDS[t.kind].capability));
  const recipe: Provenance = { id: from.recipe.id, version: from.recipe.version, key: t.key };
  const installer = INSTALLERS[t.kind] as Installer<TemplateKind>;
  const legacy = from.recipe.id === "canon-base" && (t.kind === "report" || t.kind === "dashboard") ? await seededBefore(ctx, user.orgId, installer.table as "reports" | "dashboards", t.key) : null;
  const rowId = legacy === null ? await installer.install(ctx, user, t, recipe, from) : legacy === "deleted" ? null : legacy.id;
  const now = Date.now();
  const installed = { version: recipe.version, at: now, ...(rowId ? { rowId } : {}) };
  if (row) await ctx.db.patch(row._id, { installed });
  else await ctx.db.insert("recipeEnablements", { orgId: user.orgId, point, recipeId: from.recipe.id, contributionKey: c.key, enabled: true, at: now, installed });
  return legacy === null && rowId !== null;
}

/** Install every default-on template the workspace hasn't turned off or installed yet. Returns the rows made. */
export async function installDefaults(ctx: MutationCtx, user: Doc<"users">): Promise<number> {
  let created = 0;
  for (const point of POINT_IDS) {
    const def = pointOf(point);
    if (!isTemplatePoint(point) || def.cardinality !== "additive") continue;
    for (const recipeId of def.defaultOn ?? []) {
      for (const c of contributionsOf(RECIPES[recipeId]).filter((x) => x.point === point)) {
        const row = await enablementRow(ctx, user.orgId, point, recipeId, c.key);
        if (row && (!row.enabled || row.installed)) continue;
        if (await installContribution(ctx, user, { recipe: RECIPES[recipeId], pkg: null }, c, { decided: false })) created++;
      }
    }
  }
  return created;
}

/** What the Recipes page shows of a template contribution: not installed, offered, installed as a row, or deleted. */
export type InstallView =
  | { state: "none" }
  | { state: "offered"; version: string }
  /** `by` names another recipe whose row this is (a field under the same slug), so `version` is that recipe's. */
  | { state: "installed"; version: string; row: { name: string; href: string }; by?: string }
  | { state: "deleted"; version: string };

export async function installView(ctx: Db, orgId: Id<"organizations">, point: PointId, c: Contribution): Promise<InstallView> {
  const installed = (await enablementRow(ctx, orgId, point, c.recipeId, c.key))?.installed;
  if (!installed) return { state: "none" };
  const t = c.declares as Template;
  const installer = INSTALLERS[t.kind] as Installer<TemplateKind>;
  if (!installed.rowId) return t.kind === "cadence" ? { state: "offered", version: installed.version } : { state: "deleted", version: installed.version };
  const id = ctx.db.normalizeId(installer.table, installed.rowId);
  const row = id ? ((await ctx.db.get(id)) as { name: string; status?: string } | null) : null;
  if (!row || row.status === "archived") return { state: "deleted", version: installed.version };
  return { state: "installed", version: installed.version, row: { name: row.name, href: installer.href(installed.rowId) } };
}
