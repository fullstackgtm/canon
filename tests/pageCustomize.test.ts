import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConvex } from "./convexHandlers.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { PAGE_KEYS } from "../recipes/kernel.ts";
import { readLens } from "../src/components/records/shape/lens.ts";

const BASE = readFileSync("recipes/canon-base/recipe.md", "utf8");
const { "pageCustomize.ts": actions } = loadConvex(["pageCustomize.ts"], {
  "lib/recipeAgentStandIn.ts": (real) => ({ ...real, recipeAgentStandIn: () => true }),
  "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: () => { throw new Error("local edits must not call a model"); } }),
});

for (const object of ["deal", "account", "contact"] as const) {
  test(`${object} edits fold and move only its page, and save enables the copy at its point`, async () => {
    const enabled: string[] = [];
    let saved = "";
    const ctx = {
      runQuery: async (ref: unknown) => {
        switch (String(ref)) {
          case "internal.records.callerContext": return { orgId: "org", userId: "user" };
          case "api.recipes.contributions": return { canEdit: true };
          case "api.workspaceRecipes.markdown": return { markdown: BASE.replace("id: canon-base", "id: '@workspace/base'"), revision: 1 };
          case "internal.workspaceRecipes.editBase": return { revision: 1 };
          default: throw new Error(String(ref));
        }
      },
      runMutation: async (ref: unknown, args: { point: string }) => { if (String(ref) === "api.recipes.enableContribution") enabled.push(args.point); },
      runAction: async (ref: unknown, args: { markdown: string }) => {
        if (String(ref) === "api.workspaceRecipes.customize") return { recipeId: "@workspace/base" };
        assert.equal(String(ref), "api.workspaceRecipes.save");
        saved = args.markdown;
        return { revision: 2, blocked: false, evals: [], evalsNotRun: null };
      },
    };
    const before = parseRecipe(BASE).recipe;
    const target = { component: "history" };
    const args = { recipeId: "canon-base", ...(object === "deal" ? {} : { object }), markdown: BASE, target };
    const folded = await actions.edit.handler(ctx, { ...args, request: "fold this section" });
    assert.equal(parseRecipe(folded.markdown).recipe[PAGE_KEYS[object]].find((s) => s.component === "history")?.collapsed, true);
    const moved = await actions.edit.handler(ctx, { ...args, markdown: folded.markdown, request: "move this to the top" });
    const after = parseRecipe(moved.markdown).recipe;
    assert.equal(after[PAGE_KEYS[object]][0].component, "history");
    for (const other of ["deal", "account", "contact"] as const) if (other !== object) assert.deepEqual(after[PAGE_KEYS[other]], before[PAGE_KEYS[other]]);
    assert.ok(readLens(BASE, object).length > 0);
    const out = await actions.save.handler(ctx, { ...args, scope: "workspace", markdown: moved.markdown });
    assert.equal(out.revision, 2);
    assert.deepEqual(enabled, [`${object}.page`]);
    assert.equal(parseRecipe(saved).recipe.meta.id, "@workspace/base");
    assert.deepEqual(parseRecipe(saved).recipe[PAGE_KEYS[object]], after[PAGE_KEYS[object]]);
  });
}

test("members can edit their personal page without a decider capability", async () => {
  const out = await actions.edit.handler({
    runQuery: async () => ({ orgId: "org", userId: "member" }), runMutation: async () => null,
  }, { recipeId: "canon-base", object: "account", markdown: BASE, target: { component: "history" }, request: "fold this section" });
  assert.equal(parseRecipe(out.markdown).recipe.accountPage.find((s) => s.component === "history")?.collapsed, true);
});

test("image-only section edits acknowledge the reference without storing an attempt", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const ctx = {
    runQuery: async () => ({ orgId: "org", userId: "member" }),
    runMutation: () => assert.fail("image-backed edits must not write the edit audit"),
  };
  const out = await actions.edit.handler(ctx, {
    recipeId: "canon-base", markdown: BASE, target: { component: "history" }, request: "", images: [image],
  });
  assert.equal(out.markdown, BASE);
  assert.match(out.summary, /1 image attached/);
  assert.ok(!JSON.stringify(out).includes(image));
});

test("pencil replaces Deals with a stage count chart at the same position and reports its removed action", async () => {
  const { describeLayout } = await import("../recipes/md/edit.ts");
  const { builtInDataView } = await import("../recipes/md/dataView.ts");
  const layout = describeLayout(BASE, "account");
  assert.ok(!("error" in layout));
  const index = layout.sections.findIndex((s) => s.component === "companyDeals");
  assert.deepEqual(layout.sections[index].asQuery, {
    object: "deal", from: "companyDeals", filter: [],
    columns: ["name", "amount", "stage", "closeDate"], limit: 200,
  });
  const ctx = { runMutation: async () => null, runQuery: async (ref: unknown) => String(ref) === "internal.records.callerContext" ? { orgId: "org", userId: "user" } : { canEdit: true } };
  const out = await actions.edit.handler(ctx, { recipeId: "canon-base", object: "account", markdown: BASE, target: { component: "companyDeals" }, request: "make this into a graph" });
  const parsed = parseRecipe(out.markdown);
  assert.deepEqual(parsed.problems, []);
  const chart = parsed.recipe.accountPage[index];
  assert.equal(chart.component, "chart");
  assert.deepEqual(chart.query, {
    object: "deal", from: "companyDeals", filter: [], limit: 200,
    aggregate: { fn: "count" }, groupBy: { field: "stage" },
  });
  assert.ok(!parsed.recipe.accountPage.some((s) => s.component === "companyDeals"));
  assert.equal(parsed.recipe.accountPage[index + 1].component, layout.sections[index + 1].component);
  assert.match(out.summary, /New deal/);
  assert.match(out.summary, /form block/);
  assert.match(out.summary, /Undo/);
  for (const view of ["table", "list", "metric", "chart"]) {
    assert.equal(builtInDataView(layout, { component: "companyDeals" }, `make this a ${view}`)?.ops.length, 2);
    assert.equal(builtInDataView(layout, { component: "companyDeals" }, `also show a ${view}`)?.ops.length, 1);
  }
  assert.equal(builtInDataView(layout, { component: "related" }, "make this into a graph"), null);
  assert.equal(builtInDataView(layout, { component: "companyDeals" }, "make this a chart of open deals"), null);
});
