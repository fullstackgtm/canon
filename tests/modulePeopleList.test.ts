import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseModuleManifest, peopleFilterForms } from "../modules/kernel/manifest.ts";
import { jsonQueryValue, moduleFilterHref, resolveAllowedFilterForm, parsePeopleFilter, peopleFilterContext, peopleListHref } from "../src/lib/people-list.ts";
import { renderText } from "../modules/kernel/text.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { collapseDayFilters, dayColumnsOf, expandDayFilters } from "../convex/lib/objects/views.ts";
import { FILTERS_MAX } from "../convex/lib/objects/listSpec.ts";

const source = () => JSON.parse(readFileSync("modules/examples/audiences/module.json", "utf8"));
const contact = resolveObjectDef(STANDARD_OBJECTS.contact);

test("people exports have one local provider key and an aggregate-only system op; refreshing bindings remain read-only", () => {
  const m = source();
  assert.ok(parseModuleManifest(m).ok);
  const detail = (x: typeof m) => x.pages.find((p: { path: string }) => p.path === "audiences/:key");
  const edits = [
    (x: typeof m) => { detail(x).bind.count.refreshMinutes = 4; },
    (x: typeof m) => { detail(x).bind.count.refreshMinutes = 1441; },
    (x: typeof m) => { x.calls.count.writes = ["runs"]; },
    (x: typeof m) => { x.exports["audience.csv"].columns = [{ label: "Raw", value: "{$row.email}" }]; },
    (x: typeof m) => { x.exports["audience.csv"].call = "count"; },
    (x: typeof m) => { x.exports["audience.csv"].people.provide = "notHere.v1"; },
    (x: typeof m) => { x.ops["runs.record"].roles = ["rep"]; },
    (x: typeof m) => { x.ops["runs.record"].kind = "update"; },
    (x: typeof m) => { x.ops["runs.record"].collection = "additions"; },
    (x: typeof m) => { x.collections.runs.schema.value.exported.fieldType = { type: "string" }; },
    (x: typeof m) => { x.collections.runs.schema.value.by.optional = false; },
    (x: typeof m) => { x.ops["audiences.used"].roles = ["rep"]; },
    (x: typeof m) => { x.exports["audience.csv"].record.parent.field = "owner"; },
    (x: typeof m) => { x.exports["audience.csv"].record.parent.op = "audiences.sync"; },
    (x: typeof m) => { detail(x).body[0].actions.at(-1).formats = ["csv", "xlsx"]; },
  ];
  for (const edit of edits) { const changed = source(); edit(changed); assert.equal(parseModuleManifest(changed).ok, false); }
  for (const minutes of [5, 1440]) { const changed = source(); detail(changed).bind.count.refreshMinutes = minutes; assert.ok(parseModuleManifest(changed).ok); }
});

test("a People filter makes the JSON text, list editor and module form round trip exactly", () => {
  const parsed = parseModuleManifest(source());
  assert.ok(parsed.ok);
  const modules = [{ module: "audiences", title: "Audiences", filterForms: peopleFilterForms(parsed.manifest, "rep") }];
  const dayColumns = dayColumnsOf(contact);
  const expanded = expandDayFilters([{ field: "updatedAt", op: "eq" as const, value: "2026-10-07" }], dayColumns);
  const filter = [{ field: "title", op: "contains" as const, value: "VP & Sales" }, ...expanded];
  for (const expected of [filter, []]) {
    const json = renderText("{$aud.filter|json}", { binds: { aud: { key: "k1", version: 1, owner: "rep1", data: { filter: expected } } }, members: new Map(), currency: "USD" });
    const url = new URL(peopleListHref(parsePeopleFilter(JSON.parse(json), contact), "/dashboard/m/audiences/audiences/k1/filter"), "https://local.test");
    const query = Object.fromEntries(url.searchParams);
    const loaded = parsePeopleFilter(jsonQueryValue(query, "filter"), contact);
    const edited = expandDayFilters(collapseDayFilters(loaded, dayColumns), dayColumns);
    const target = resolveAllowedFilterForm(query.returnTo, modules);
    const back = new URL(moduleFilterHref(target.module, target.form, edited), "https://local.test");
    assert.equal(back.pathname, "/dashboard/m/audiences/audiences/k1/filter");
    assert.deepEqual(jsonQueryValue(Object.fromEntries(back.searchParams), "filter"), expected);
  }
});

test("malformed or unavailable filters and unsafe return destinations fail closed; legacy audiences keep priority", () => {
  const malformed: Array<Record<string, string>> = [{}, { filter: "" }, { filter: "[" }];
  for (const query of malformed) assert.throws(() => jsonQueryValue(query, "filter"));
  for (const value of [null, {}, [{ field: "gone", op: "eq", value: "x" }], [{ field: "title", op: "gt", value: "x" }], [{ field: "title", op: "eq" }], [{ field: "title", op: "eq", value: "x", extra: true }], Array.from({ length: FILTERS_MAX + 1 }, () => ({ field: "title", op: "eq", value: "x" }))]) assert.throws(() => parsePeopleFilter(value, contact));
  assert.throws(() => parsePeopleFilter([{ field: "title", op: "eq", value: "x" }], contact, new Set(["updatedAt"])));
  const modules = [{ module: "audiences", title: "Audiences", filterForms: [{ path: "audiences/:key/filter", param: "filter" }] }];
  for (const path of ["https://evil.test/dashboard/m/audiences/audiences/k/filter", "//evil.test/x", "/dashboard/settings", "/dashboard/m/off/audiences/k/filter", "/dashboard/m/audiences/audiences/../filter", "/dashboard/m/audiences/audiences/%2e%2e/filter", "/dashboard/m/audiences/audiences/%252e%252e/filter", "/dashboard/m/audiences/audiences/%2f/filter", "/dashboard/m/audiences/audiences/k/filter?next=bad", "/dashboard/m/audiences/audiences/k\\x/filter"]) assert.throws(() => resolveAllowedFilterForm(path, modules));
  assert.throws(() => resolveAllowedFilterForm("/dashboard/m/audiences/audiences/k/filter", []));
  assert.deepEqual(peopleFilterContext({ audience: "core1", filter: "[", returnTo: "//evil.test" }), { kind: "core" });
  assert.deepEqual(peopleFilterContext({ audience: "", filter: "", returnTo: "" }), { kind: "core" });
  assert.equal(peopleFilterContext({ audience: "", filter: "", filterPresent: true, returnTo: "" }).kind, "filter");
  assert.equal(peopleFilterContext({ audience: "", filter: "", returnPresent: true, returnTo: "" }).kind, "filter");
});

test("a list action must name one literal role-visible page with a fixed JSON People-filter form", () => {
  assert.ok(parseModuleManifest(source()).ok);
  const invalid = [
    (m: ReturnType<typeof source>) => { m.contributes.people.listActions.push({ ...m.contributes.people.listActions[0] }); },
    (m: ReturnType<typeof source>) => { m.contributes.people.listActions[0].path = "audiences/:key/filter"; },
    (m: ReturnType<typeof source>) => { m.contributes.people.listActions[0].path = "../outside"; },
    (m: ReturnType<typeof source>) => { m.contributes.people.listActions[0].param = "wrong"; },
    (m: ReturnType<typeof source>) => { m.contributes.people.listActions[0].roles = ["unknown"]; },
    (m: ReturnType<typeof source>) => { m.pages[1].roles = ["admin"]; },
    (m: ReturnType<typeof source>) => { m.pages[1].body[1].fixed.filter = { query: "filter" }; },
    (m: ReturnType<typeof source>) => { m.pages[1].body[1].fixed.name = { query: "name", json: true }; },
    (m: ReturnType<typeof source>) => { m.pages[1].bind = { bad: { view: "audiences.one", args: { key: { query: "filter", json: true } } } }; },
  ];
  for (const edit of invalid) {
    const m = source(); edit(m);
    assert.equal(parseModuleManifest(m).ok, false);
  }
});
