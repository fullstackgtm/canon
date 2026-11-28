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

test("write blocks parse, retain actions, and reject register boards and invalid fields", () => {
  for (const [component, input] of [
    ["form", { object: "deal", fields: ["name", "closeDate"], defaults: { companyId: { record: "id" } } }],
    ["board", { object: "deal", groupBy: { field: "stage" }, columns: ["name"] }],
    ["detail", { object: "account", record: "companyId", columns: ["name"], limit: 1 }],
  ] as const) {
    const query = validateDataQuery(component, input, "deal");
    const out = apply(base, { op: "addSection", object: "deal", component, title: component, query, before: null });
    assert.ok("markdown" in out, JSON.stringify(out));
    const parsed = parseRecipe(out.markdown);
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.recipe.dealPage.at(-1)?.actions?.[0].runs, component === "form" ? "kernel.createRecord" : "kernel.editField");
    const removed = apply(out.markdown, { op: "removeSection", object: "deal", section: { component } });
    assert.ok("markdown" in removed); assert.equal(removed.markdown, base);
  }
  assert.throws(() => validateDataQuery("board", { object: "account", groupBy: { field: "status" } }, "account"));
  assert.throws(() => validateDataQuery("board", { object: "deal", groupBy: { field: "name" } }, "account"));
  assert.throws(() => validateDataQuery("detail", { object: "deal", columns: ["name"], limit: 2 }, "account"));
  assert.throws(() => validateDataQuery("form", { object: "deal", fields: ["typo"] }, "account"));
});

test("companyDeals is a read-only account relation and rejects other pages and objects", () => {
  const input = { object: "deal", from: "companyDeals", columns: ["name", "amount", "stage", "closeDate"] };
  assert.equal(validateDataQuery("table", input, "account").from, "companyDeals");
  for (const page of ["deal", "contact", "workspace"]) assert.throws(() => validateDataQuery("table", input, page));
  assert.throws(() => validateDataQuery("table", { ...input, object: "contact" }, "account"));
  assert.throws(() => validateDataQuery("table", { ...input, from: "unknown" }, "account"));
  assert.throws(() => validateDataQuery("form", { object: "deal", from: "companyDeals", fields: ["name"] }, "account"));
  const text = add(validateDataQuery("table", input, "account"));
  assert.deepEqual(parseRecipe(text).problems, []);
  assert.ok(parseRecipe(text.replace('"from": "companyDeals"', '"from": "unknown"')).problems.some((p) => p.level === "error"));
});

test("companyDeals evaluates the viewer-scoped linked and CRM rows with list and report semantics", async () => {
  const { companyDealsData } = await import("../recipes/relationData.ts");
  const { STANDARD_OBJECTS, resolveObjectDef } = await import("../convex/lib/objects/registry.ts");
  const def = resolveObjectDef(STANDARD_OBJECTS.deal);
  const deals = [
    { dealId: "crm", streamId: "crm-stream", name: "CRM deal", amount: 20000, currency: "USD", stage: "closed_won", isClosed: true, closeDate: "2026-11-20", createdAt: 1 },
    { dealId: "linked1", streamId: "stream1", name: "Linked one", amount: 10000, currency: "USD", stage: "qualification", isClosed: false, closeDate: "2026-12-31", createdAt: 2 },
    { dealId: "linked2", streamId: null, name: "Linked two", stage: "prospecting", isClosed: false, closeDate: "2026-12-31", createdAt: 3 },
  ];
  const query = (kind: "chart" | "metric" | "table", extra: object) => validateDataQuery(kind, { object: "deal", from: "companyDeals", ...extra }, "account");
  const chart = companyDealsData(query("chart", { aggregate: { fn: "count" }, groupBy: { field: "stage" }, limit: 1 }), deals, def);
  assert.ok(chart.aggregate);
  assert.equal(chart.aggregate.rows, 3);
  assert.deepEqual(chart.aggregate.total, [3]);
  assert.deepEqual(chart.aggregate.groups.map((g) => [g.keys[0], g.values[0]]), [["closed_won", 1], ["prospecting", 1], ["qualification", 1]]);
  const sum = companyDealsData(query("metric", { aggregate: { fn: "sum", field: "amount" }, filter: [{ field: "isClosed", op: "eq", value: false }] }), deals, def);
  assert.ok(sum.aggregate); assert.deepEqual(sum.aggregate.total, [10000]);
  const table = companyDealsData(query("table", { columns: ["name"], sort: { field: "name", dir: "desc" }, limit: 1, filter: [{ field: "isClosed", op: "eq", value: false }] }), deals, def);
  assert.ok(table.rows); assert.equal(table.rows.total, 2); assert.equal(table.rows.rows[0].title, "Linked two"); assert.deepEqual(table.unlinked, ["linked2"]);
  const avg = companyDealsData(query("metric", { aggregate: { fn: "avg", field: "amount" } }), deals, def);
  assert.ok(avg.aggregate); assert.deepEqual(avg.aggregate.total, [15000]);
  assert.throws(() => companyDealsData(query("table", { columns: ["ownerId"] }), deals, def));
});
