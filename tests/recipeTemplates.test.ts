// Recipe templates (docs/recipes.md, "Templates"): enabling one installs its row once, and Canon's own reports and
// dashboards, now canon-base templates, install exactly as dashboards.ensureSeeded seeded them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { parseRecipe } from "../recipes/md/parse.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const admin = { _id: "admin", orgId: "org", role: "admin", name: "Ada" };
const SEED = JSON.parse(readFileSync(new URL("./fixtures/built-in-seed.json", import.meta.url), "utf8")) as {
  created: number;
  reports: Array<{ name: string; builtIn: string }>;
  dashboards: Array<{ name: string; builtIn: string; tiles: Array<{ report: string; wide: boolean }> }>;
};

const loaded = loadConvex(["recipes.ts", "templates.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => admin, requireUser: async () => admin }),
  "permissions.ts": (real) => ({ ...real, requireWriteAccess: async () => ({}) }),
  "lib/access.ts": (real) => ({ ...real, refuseNarrowed: () => {} }),
});
/** Values from the loaded modules' realm, as plain data. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function workspace(tables: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [admin], ...tables });
  const ctx = { db, auth: { getUserIdentity: async () => null } };
  return { db, ctx, recipes: loaded["recipes.ts"], templates: loaded["templates.ts"] };
}

/** Rows as ensureSeeded wrote them: tiles by their report's key, without ids, times or provenance. */
function seeded(db: ReturnType<typeof memoryDb>) {
  const key = new Map(db.rows("reports").map((r) => [r._id, r.builtIn]));
  const strip = ({ _id, _creationTime, updatedAt, orgId, recipe, ...r }: Record<string, unknown>) => r;
  return plain({
    reports: db.rows("reports").map(strip),
    dashboards: db.rows("dashboards").map((d) => ({ ...strip(d), tiles: (d.tiles as Array<{ reportId: string; wide: boolean }>).map((t) => ({ report: key.get(t.reportId), wide: t.wide })) })),
  });
}

test("enabling a template installs its row once with provenance, and a deleted row is never made again", async () => {
  const w = workspace();
  const report = { point: "templates.reports", recipeId: "fsgtm-enterprise-deal", key: "open_by_owner_stage" };
  const rule = { point: "templates.automations", recipeId: "fsgtm-enterprise-deal", key: "map_committee" };
  await w.recipes.enableContribution.handler(w.ctx, report);
  await w.recipes.enableContribution.handler(w.ctx, rule);
  await w.recipes.disableContribution.handler(w.ctx, report);
  await w.recipes.enableContribution.handler(w.ctx, report);

  const [row] = w.db.rows("reports");
  assert.equal(w.db.rows("reports").length, 1);
  assert.deepEqual(plain({ name: row.name, shared: row.shared, createdBy: row.createdBy, recipe: row.recipe, builtIn: row.builtIn ?? null }), {
    name: "Open deals by owner and stage", shared: true, createdBy: "admin", recipe: { id: "fsgtm-enterprise-deal", version: "1.2.0", key: "open_by_owner_stage" }, builtIn: null,
  });
  const [automation] = w.db.rows("automationRules");
  assert.deepEqual(plain([automation.status, automation.createdBy, automation.recipe]), ["paused", "admin", { id: "fsgtm-enterprise-deal", version: "1.2.0", key: "map_committee" }]);

  await w.db.delete(row._id);
  await w.recipes.disableContribution.handler(w.ctx, report);
  await w.recipes.enableContribution.handler(w.ctx, report);
  assert.equal(w.db.rows("reports").length, 0, "a report the workspace deleted stays deleted");
  const view = await w.recipes.contributions.handler(w.ctx, {});
  const shown = view.points.find((p: { id: string }) => p.id === "templates.reports").contributions.find((c: { key: string }) => c.key === "open_by_owner_stage");
  assert.deepEqual(plain([shown.enabled, shown.install]), [true, { state: "deleted", version: "1.2.0" }]);
});

test("canon-base's reports and dashboards install as ensureSeeded seeded them, on a new workspace and on one it already seeded", async () => {
  const fresh = workspace();
  assert.deepEqual(plain(await fresh.templates.ensureDefaults.handler(fresh.ctx, {})), { created: SEED.created });
  assert.deepEqual(seeded(fresh.db), { reports: SEED.reports.map((r) => ({ ...r, createdBy: "admin" })), dashboards: SEED.dashboards.map((d) => ({ ...d, createdBy: "admin" })) });
  assert.ok(fresh.db.rows("reports").every((r) => (r.recipe as { id: string }).id === "canon-base"));
  assert.deepEqual(plain(await fresh.templates.ensureDefaults.handler(fresh.ctx, {})), { created: 0 });

  // Seeded before templates, then one report deleted: nothing new, and the deleted one isn't brought back.
  const ids = new Map(SEED.reports.map((r, i) => [r.builtIn, `old-report-${i}`]));
  const before = workspace({
    reports: SEED.reports.filter((r) => r.builtIn !== "new_leads_by_month").map((r) => ({ _id: ids.get(r.builtIn), orgId: "org", updatedAt: 1, ...r })),
    dashboards: SEED.dashboards.map((d, i) => ({ _id: `old-dash-${i}`, orgId: "org", updatedAt: 1, ...d, tiles: d.tiles.map((t) => ({ reportId: ids.get(t.report), wide: t.wide })) })),
  });
  const rows = JSON.stringify(seeded(before.db));
  assert.deepEqual(plain(await before.templates.ensureDefaults.handler(before.ctx, {})), { created: 0 });
  assert.equal(JSON.stringify(seeded(before.db)), rows);
  const adopted = before.db.rows("recipeEnablements").map((e) => [e.contributionKey, (e.installed as { rowId?: string }).rowId ?? null]);
  assert.deepEqual(plain(Object.fromEntries(adopted)), { ...Object.fromEntries([...ids].map(([k, id]) => [k, id])), new_leads_by_month: null, revenue: "old-dash-0", activity: "old-dash-1" });
});

test("a dashboard installed from Customization leaves out a report turned off first, and the defaults still install around it", async () => {
  const w = workspace();
  const base = { recipeId: "canon-base" };
  await w.recipes.disableContribution.handler(w.ctx, { ...base, point: "templates.reports", key: "open_pipeline" });
  await w.recipes.enableContribution.handler(w.ctx, { ...base, point: "templates.dashboards", key: "revenue" });
  assert.deepEqual(plain(await w.templates.ensureDefaults.handler(w.ctx, {})), { created: SEED.created - 5 });
  const { reports, dashboards } = seeded(w.db) as unknown as typeof SEED;
  assert.deepEqual(reports.map((r) => r.builtIn).sort(), SEED.reports.map((r) => r.builtIn).filter((k) => k !== "open_pipeline").sort());
  const revenue = SEED.dashboards.find((d) => d.builtIn === "revenue")!;
  assert.deepEqual(dashboards.find((d) => d.builtIn === "revenue")?.tiles, revenue.tiles.filter((t) => t.report !== "open_pipeline"));
  assert.equal(dashboards.length, SEED.dashboards.length);
});

test("a default-on template not installed yet offers Install and a switch to turn it off", () => {
  const require = createRequire(import.meta.url);
  const contribution = (key: string, enabled: boolean) => ({ recipeId: "canon-base", recipeTitle: "Canon base", key, title: key, version: "1.0.0", enabled, hasPlays: false, install: { state: "none" } });
  const point = { id: "templates.dashboards", kind: "templates", title: "Dashboards", description: "", cardinality: "additive", contributions: [contribution("revenue", true), contribution("activity", false)] };
  const none = () => null;
  const stubs: Record<string, unknown> = {
    "next/link": { default: ({ children }: { children: ReactNode }) => children },
    "../../../../recipes": { isFirstParty: () => true },
    "@/components/ui/select": { SelectField: none },
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" ") },
  };
  const source = readFileSync(new URL("../src/app/dashboard/customization/point-row.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Record<string, (props: Record<string, unknown>) => ReactNode> = {};
  runInNewContext(outputText, { exports, require: (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)) });
  const html = renderToStaticMarkup(createElement(exports.PointRow, { point, canEdit: true, busy: false, onEnable: none, onDisable: none }));
  assert.match(html, /aria-label="Install revenue from Canon base"/);
  assert.match(html, /role="switch" aria-checked="true" aria-label="revenue from Canon base"/);
  assert.match(html, /aria-label="Install activity from Canon base"/);
  assert.doesNotMatch(html, /aria-label="activity from Canon base"/);
});

test("a bad template spec is refused at its block's line", () => {
  const source = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
  const lines = source.split("\n");
  const fence = lines.indexOf("```template kind=report key=pipeline_by_stage") + 1;
  const bad = lines.map((l, i) => (i > fence && i < fence + 8 && l === "  chart: bar" ? "  chart: donut" : l)).join("\n");
  const { problems } = parseRecipe(bad);
  assert.deepEqual(problems.map((p) => [p.line, p.level]), [[fence, "error"]]);
  assert.match(problems[0].message, /pipeline_by_stage: spec\.spec\.chart/);
});


test("optional recipe reports belong to Reports after takeover and legacy defaults cannot duplicate shipped rows", async () => {
  const manifest = readFileSync("modules/examples/reports/module.json", "utf8");
  const w = workspace({ modulePackages: [{ _id: "reports-module", orgId: "org", moduleId: "@canon/reports", slug: "reports", status: "installed", manifest, manifestHash: "rp6", version: "0.6.0", imports: { "reports.legacy": { cursor: null, done: true } } }] });
  assert.deepEqual(plain(await w.templates.ensureDefaults.handler(w.ctx, {})), { created: 0 });
  await w.recipes.enableContribution.handler(w.ctx, { point: "templates.reports", recipeId: "fsgtm-enterprise-deal", key: "open_by_owner_stage" });
  const row = w.db.rows("reports")[0];
  assert.deepEqual(plain(row.module), { moduleId: "@canon/reports", report: "deals" });
  assert.equal((row.spec as { object: string }).object, "canon.deals");
  assert.equal(row.shared, true);
});
