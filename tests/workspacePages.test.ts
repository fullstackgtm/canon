import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apply, describeLayout, type LayoutOp } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { contributionsOf, planEnable, pointOf } from "../recipes/points.ts";
import { recipeOf } from "../recipes/compose.ts";
const base = readFileSync("recipes/canon-base/recipe.md", "utf8");
function edit(md: string, op: LayoutOp): string {
  const out = apply(md, op);
  assert.ok("markdown" in out, JSON.stringify(out));
  return out.markdown;
}
const query = { object: "deal", filter: [{ field: "isClosed", op: "eq" as const, value: false }], columns: ["recordTitle", "amount"], limit: 10 };
const added = () => edit(base, { op: "addPage", slug: "open-deals", title: "Open deals", icon: "chart" });
test("standalone pages parse, contribute independently, and edit through the existing layout ops", () => {
  const empty = added();
  const md = edit(empty, { op: "addSection", object: "open-deals", component: "table", title: "Deals", before: null, query });
  const parsed = parseRecipe(md);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.recipe.workspacePages?.[0], { slug: "open-deals", title: "Open deals", icon: "chart", nav: "main", sections: [{ component: "table", title: "Deals", query }] });
  const renamed = edit(md, { op: "renameSection", object: "open-deals", section: { component: "table" }, title: "Pipeline" });
  assert.equal(renamed, md.replace("## Deals {section=table}", "## Pipeline {section=table}"));
  const layout = describeLayout(md, "open-deals");
  assert.ok(!("error" in layout));
  assert.ok(layout.addable.includes("metric"));
  assert.ok(!layout.addable.includes("detail"));
  const offers = contributionsOf(recipeOf(parsed.recipe, [])).filter((c) => c.point === "workspace.pages");
  assert.equal(offers[0].key, "open-deals");
  assert.deepEqual(planEnable(pointOf("workspace.pages"), [], offers[0]), { ok: true, off: [] });
  assert.equal(planEnable(pointOf("workspace.pages"), [{ ...offers[0], recipeId: "other" }], offers[0]).ok, false);
  const card = edit(md, { op: "wrapSections", object: "open-deals", sections: [{ component: "table" }], kind: "card", id: "pipeline", props: { title: "Pipeline" } });
  assert.equal(parseRecipe(card).recipe.layouts?.["open-deals"]?.children.length, 1);
  const form = edit(md, { op: "addSection", object: "open-deals", component: "form", title: "New deal", before: null, query: { object: "deal", fields: ["name"], defaults: {}, filter: [], limit: 10 } });
  assert.deepEqual(parseRecipe(form).problems, []);
  const removed = edit(md, { op: "removePage", slug: "open-deals" });
  assert.deepEqual(parseRecipe(removed).recipe, parseRecipe(base).recipe);
  assert.ok(removed.includes(base.slice(base.indexOf("# Account"), base.indexOf("# Contact"))));
});
test("page problems point at bad slugs, duplicate declarations, record blocks and record references", () => {
  const good = added();
  for (const change of [
    good.replace("page=open-deals", "page=BadSlug"),
    good.replace("page=open-deals", "page=settings"),
    good + "\n# Again {page=open-deals}\n",
    good + "\n## Fields {section=fields}\n",
    good + '\n## Deals {section=table}\n\n```query\n{"object":"deal","filter":[{"field":"companyId","op":"eq","value":{"record":"id"}}]}\n```\n',
  ]) assert.ok(parseRecipe(change).problems.some((p) => p.level === "error" && p.line > 1));
});

test("enabled pages list in recipe order and resolve only in the caller workspace", async () => {
  const { loadConvex, memoryDb } = await import("./convexHandlers.ts");
  const user = { _id: "user", orgId: "org", role: "admin", name: "Riley" };
  const mods = loadConvex(["workspaceRecipes.ts", "recipes.ts", "lib/recipes.ts"], {
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }),
  });
  const db = memoryDb({ organizations: [{ _id: "org", name: "Acme", slug: "acme" }], users: [user] });
  let n = 0;
  const ctx: any = { db, storage: { store: async () => `blob:${++n}`, delete: async () => {} }, scheduler: { runAfter: async () => null } };
  const call = (ref: unknown, args: unknown) => {
    const [module, fn] = String(ref).split(".").slice(-2);
    return mods[`${module}.ts`][fn].handler(ctx, args);
  };
  ctx.runQuery = call; ctx.runMutation = call;
  const workspace = mods["workspaceRecipes.ts"], recipes = mods["recipes.ts"];
  const { recipeId } = await workspace.customize.handler(ctx, { recipeId: "canon-base" });
  const open = await workspace.editor.handler(ctx, { recipeId });
  const md = edit(open.markdown, { op: "addPage", slug: "open-deals", title: "Open deals" });
  await workspace.save.handler(ctx, { recipeId, markdown: md, baseRevision: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await recipes.workspacePages.handler(ctx, {}))), [{ slug: "open-deals", title: "Open deals", nav: "main" }]);
  assert.equal((await recipes.workspacePage.handler(ctx, { slug: "open-deals" })).recipeId, recipeId);
  assert.equal(await recipes.workspacePage.handler(ctx, { slug: "absent" }), null);
  user.orgId = "other";
  assert.equal(await recipes.workspacePage.handler(ctx, { slug: "open-deals" }), null);
});
