import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BLOCKS } from "../recipes/blocks.ts";
import { parseRecipe } from "../recipes/md/parse.ts";

const source = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");

test("block heading schemas and the parser accept the same folding, stages and parts", () => {
  for (const [component, show] of [["summary", "health, amount"], ["summary", ""], ["summary", "owner, owner"], ["summary", "unknown"], ["history", "health"]] as const) {
    for (const collapsed of ["true", "false", "yes"]) for (const when of ["stage = in", "stage not in [case, close]", "stage = unknown"]) {
      const attrs = { section: component, title: "Example", collapsed, when, show };
      const markdown = source.replace("## History {section=history}", `## Example {section=${component} collapsed=${collapsed} when="${when}" show="${show}"}`);
      const line = markdown.split("\n").findIndex((l) => l.startsWith("## Example")) + 1;
      const problems = parseRecipe(markdown).problems.filter((p) => p.line === line && p.level === "error");
      assert.equal(problems.length === 0, BLOCKS[component].props.safeParse(attrs).success, JSON.stringify(attrs));
    }
  }
});

test("built-in data equivalents validate on each supported page against the object registry", async () => {
  const { validateDataQuery } = await import("../recipes/data.ts");
  const { STANDARD_OBJECTS, resolveObjectDef } = await import("../convex/lib/objects/registry.ts");
  const { listColumns } = await import("../convex/lib/objects/listSpec.ts");
  const equivalents: string[] = [];
  for (const block of Object.values(BLOCKS)) for (const [page, query] of Object.entries(block.asQuery ?? {})) {
    assert.ok(page in block.objects);
    const checked = validateDataQuery("table", query, page);
    const def = resolveObjectDef(STANDARD_OBJECTS[checked.object as keyof typeof STANDARD_OBJECTS]);
    const columns = listColumns(def);
    for (const name of [...checked.filter.map((f) => f.field), ...("columns" in checked ? checked.columns : [])]) assert.ok(columns.has(name), name);
    equivalents.push(`${page}.${block.id}`);
  }
  assert.deepEqual(equivalents, ["account.companyDeals"]);
});
