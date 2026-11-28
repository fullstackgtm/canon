import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { present } from "../src/components/reports/present.ts";
import { validateDataQuery } from "../recipes/data.ts";
const require = createRequire(import.meta.url);
const tag = (name: string) => function Tag({ children, ...props }: { children?: ReactNode }) { return createElement(name, props, children); };
const exports: { DataResult?: ComponentType<Record<string, unknown>> } = {};
const stubs: Record<string, unknown> = {
  "../../../convex/lib/objects/views": {}, "./data-write-section": {}, "convex/react": {}, "../../../convex/_generated/api": {}, "../../../recipes/data": {}, "../../../recipes/relationData": {}, "../../../convex/lib/objects/registry": {},
  "@/components/ui/table": Object.fromEntries(Object.entries({ Table: "table", TableHeader: "thead", TableHead: "th", TableBody: "tbody", TableRow: "tr", TableCell: "td" }).map(([k, v]) => [k, tag(v)])),
  "./record-context": { RecordLink: ({ id, children }: { id: string; children: ReactNode }) => createElement("a", { href: `/record/${id}` }, children), RecordQuickView: () => null },
  "../../../modules/kernel/text": { formatMoney: (v: number) => `$${(v / 100).toFixed(2)}` }, "../reports/report-chart": {}, "../reports/present": { present },
};
runInNewContext(ts.transpileModule(readFileSync("src/components/records/data-section.tsx", "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (id: string) => id in stubs ? stubs[id] : require(id) });
test("table and metric render viewer results, including empty values and zero counts", () => {
  const q = validateDataQuery("table", { object: "deal", columns: ["recordTitle", "amount"] }, "account");
  const html = renderToStaticMarkup(createElement(exports.DataResult!, { kind: "table", query: q, answer: { fields: [{ fieldId: "amount", apiName: "amount", label: "Amount", type: "currency" }], rows: { rows: [{ id: "deal1", title: "First deal", values: { amount: 12500 } }] } } }));
  assert.match(html, /<table/); assert.match(html, /First deal/); assert.match(html, /href="\/record\/deal1"/); assert.match(html, /125.00/); assert.match(html, /overflow-x-auto/);
  const metric = validateDataQuery("metric", { object: "deal", aggregate: { fn: "count" } }, "account");
  const number = renderToStaticMarkup(createElement(exports.DataResult!, { kind: "metric", query: metric, answer: { fields: [], aggregate: { groups: [], subtotals: [], total: [0], rows: 0, truncated: false } } }));
  assert.match(number, />0<\/p>/);
});
