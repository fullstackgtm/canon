import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { recordRelations } from "../recipes/recordRelations.ts";
import { listColumns } from "../convex/lib/objects/listSpec.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const require = createRequire(import.meta.url);

test("People exposes searchable company and deal relationships, respecting readable objects", () => {
  const columns = listColumns(resolveObjectDef(STANDARD_OBJECTS.contact));
  assert.equal(columns.has("companyId"), false, "company relationships are not scalar People fields");
  assert.equal(columns.has("dealId"), false, "deal relationships are not scalar People fields");
  const source = readFileSync(new URL("../src/components/records/related-people-filters.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const picked: Array<{ object: string; onPick: (record: { id: string; title: string }) => void }> = [];
  const navigated: string[] = [];
  let hidden = "";
  const stubs: Record<string, unknown> = {
    "next/navigation": { useRouter: () => ({ push: (url: string) => navigated.push(url) }) },
    "convex/react": { useQuery: (_ref: unknown, { object }: { object: string }) => ({ apiName: object, readable: object !== hidden, pluralLabel: object, fields: [] }) },
    "../../../convex/_generated/api": { api: { objects: { describe: "describe" } } },
    "../../../recipes/recordRelations": { recordRelations },
    "./record-relation-query": { relatedListHref: (source: { object: string; id: string }, relation: { object: string; id: string }) => `/dashboard/records/${relation.object}?${new URLSearchParams({ relatedObject: source.object, relatedId: source.id, relationship: relation.id })}` },
    "./lookup-field": { RecordPicker: (props: { object: string; label: string; onPick: (record: { id: string; title: string }) => void }) => { picked.push(props); return createElement("input", { "aria-label": props.label }); } },
  };
  const exports: { RelatedPeopleFilters?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react", "react/jsx-runtime"].includes(id), id);
    return require(id);
  } });
  assert.ok(exports.RelatedPeopleFilters);
  const html = renderToStaticMarkup(createElement(exports.RelatedPeopleFilters));
  assert.match(html, /Search company/);
  assert.match(html, /Search opportunity/);
  assert.deepEqual(picked.map((p) => p.object), ["account", "deal"]);
  picked[0].onPick({ id: "acc_1", title: "Company" });
  picked[1].onPick({ id: "deal_1", title: "Opportunity" });
  assert.deepEqual(navigated.map((url) => Object.fromEntries(new URL(url, "http://localhost").searchParams)), [
    { relatedObject: "account", relatedId: "acc_1", relationship: "companyPeople" },
    { relatedObject: "deal", relatedId: "deal_1", relationship: "dealPeople" },
  ]);
  hidden = "account";
  picked.length = 0;
  renderToStaticMarkup(createElement(exports.RelatedPeopleFilters));
  assert.deepEqual(picked.map((p) => p.object), ["deal"]);
});
