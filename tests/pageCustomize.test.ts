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
    const out = await actions.save.handler(ctx, { ...args, markdown: moved.markdown });
    assert.equal(out.revision, 2);
    assert.deepEqual(enabled, [`${object}.page`]);
    assert.equal(parseRecipe(saved).recipe.meta.id, "@workspace/base");
    assert.deepEqual(parseRecipe(saved).recipe[PAGE_KEYS[object]], after[PAGE_KEYS[object]]);
  });
}

test("page edits refuse non-deciders before any model call", async () => {
  await assert.rejects(actions.edit.handler({
    runQuery: async (ref: unknown) => String(ref) === "internal.records.callerContext" ? { orgId: "org", userId: "member" } : { canEdit: false },
    runMutation: async () => null,
  }, { recipeId: "canon-base", object: "account", markdown: BASE, request: "fold this section" }));
});
