import { parseManifest, toManifest } from "../recipes/manifest.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apply, describeLayout } from "../recipes/md/edit.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { resolveQuery, validateDataQuery, type DataQuery } from "../recipes/data.ts";
import { loadConvex } from "./convexHandlers.ts";
const base = readFileSync("recipes/canon-base/recipe.md", "utf8");
const q = validateDataQuery("table", { object: "deal", filter: [{ field: "companyId", op: "eq", value: { record: "id" } }, { field: "isClosed", op: "eq", value: false }], columns: ["recordTitle", "amount"] }, "account");
function add(query: DataQuery = q) {
  const out = apply(base, { op: "addSection", object: "account", component: "table", title: "Open deals", query, before: null });
  assert.ok("markdown" in out, JSON.stringify(out)); return out.markdown;
}
test("data queries attach to sections, validate fields, operators, references and limits", () => {
  const text = add();
  assert.deepEqual(parseRecipe(text).problems, []);
  const manifest = toManifest(parseRecipe(text).recipe);
  assert.equal(parseManifest({ ...manifest, id: "@workspace/data-blocks", author: { org: "workspace", kind: "agency" } }).ok, true);
  assert.deepEqual(parseRecipe(text).recipe.accountPage.at(-1), { component: "table", title: "Open deals", query: q });
  for (const input of [{ ...q, object: "missing" }, { ...q, limit: 201 }, { ...q, columns: ["typo"] }, { ...q, filter: [{ field: "closed", op: "gt", value: true }] }, { ...q, filter: [{ field: "companyId", op: "eq", value: { record: "missing" } }] }]) {
    assert.throws(() => validateDataQuery("table", input, "account"));
    const broken = text.replace(JSON.stringify(q, null, 2), JSON.stringify(input, null, 2));
    assert.ok(parseRecipe(broken).problems.some((p) => p.level === "error" && p.line > 0));
  }
  assert.throws(() => validateDataQuery("metric", { object: "deal", aggregate: { fn: "sum", field: "name" } }, "account"));
  assert.doesNotThrow(() => validateDataQuery("chart", { object: "deal", aggregate: { fn: "sum", field: "amount" }, groupBy: { field: "createdAt", bucket: "month" } }, "account"));
});
test("record references resolve ids and field values and refuse unavailable values", () => {
  assert.equal(resolveQuery(q, { id: "acct", values: {} }, []).filter[0].value, "acct");
  const field = { apiName: "name", fieldId: "name" };
  const byName = { ...q, filter: [{ field: "name", op: "eq" as const, value: { record: "name" } }] };
  assert.equal(resolveQuery(byName, { id: "acct", values: { name: "Acme" } }, [field]).filter[0].value, "Acme");
  assert.throws(() => resolveQuery(byName, { id: "acct", values: {} }, [field]));
  assert.throws(() => resolveQuery(byName, { id: "acct", values: { name: "Acme" } }, [{ ...field, hidden: true }]));
});
test("query ops preserve unrelated bytes, and local pencil generates the same checked op", () => {
  const crlf = base.replaceAll("\n", "\r\n");
  const inserted = apply(crlf, { op: "addSection", object: "account", component: "table", title: "Open deals", query: q, before: null });
  assert.ok("markdown" in inserted); assert.doesNotMatch(inserted.markdown, /(?<!\r)\n/);
  const added = add();
  const removed = apply(added, { op: "removeSection", object: "account", section: { component: "table" } });
  assert.ok("markdown" in removed); assert.equal(removed.markdown, base);
  const changed = apply(added, { op: "setQuery", object: "account", section: { component: "table" }, query: { ...q, limit: 3 } });
  assert.ok("markdown" in changed, JSON.stringify(changed));
  assert.equal(changed.markdown.replace(JSON.stringify({ ...q, limit: 3 }, null, 2), JSON.stringify(q, null, 2)), added);
  const layout = describeLayout(base, "account"); assert.ok(!("error" in layout));
  const standIn = loadConvex(["lib/recipeAgentStandIn.ts"])["lib/recipeAgentStandIn.ts"].standInColumns as unknown as typeof import("../convex/lib/recipeAgentStandIn.ts").standInColumns;
  const ops = standIn(layout, undefined, "show open deals here"); assert.equal(ops.length, 1);
  assert.ok("markdown" in apply(base, ops[0]));
});
