import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anyApi, getFunctionName } from "convex/server";
import ts from "typescript";
import { accessOf } from "../convex/lib/access.ts";
import { describeObject } from "../convex/lib/objects/describe.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import * as peopleList from "../src/lib/people-list.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
let search = new URLSearchParams();
let hiddenObject = "";
const stubs: Record<string, unknown> = {
  "next/link": { default: empty },
  "next/navigation": { useSearchParams: () => search },
  "../../../convex/_generated/api": { api: anyApi },
  "convex/react": {
    useAction: () => empty,
    useMutation: () => empty,
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: { object?: keyof typeof STANDARD_OBJECTS } | "skip") => {
      if (args === "skip") return undefined;
      switch (getFunctionName(ref)) {
        case "objects:describe": {
          const object = args.object!;
          const rules = hiddenObject ? [{ object: hiddenObject, read: false }] : [];
          return describeObject({ object, def: resolveObjectDef(STANDARD_OBJECTS[object]), access: accessOf({ role: "rep", userId: "u", rules }), dealsWrite: false, icpOptions: [], aiSlugs: new Set() });
        }
        case "savedViews:list": return [];
        case "users:list": case "modules:contributions": return [];
        default: return undefined;
      }
    },
  },
  "@/lib/people-list": peopleList,
  "@/lib/url-state": { useUrlState: (defaults: Record<string, string>) => [{ ...defaults, ...Object.fromEntries(search) }, empty] },
  "@/lib/toast": { toast: {} },
  "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" "), getErrorMessage: String },
  "@/components/dashboard": { ViewFrame: ({ controls, children }: { controls: ReactNode; children: ReactNode }) => createElement("main", null, controls, children), EmptyState: empty, LoadingRows: empty, ReadFailure: empty, SelectionBar: empty },
  "@/components/ui/dialog": { Dialog: empty, DialogContent: empty, DialogDescription: empty, DialogFooter: empty, DialogHeader: empty, DialogTitle: empty },
  "@/components/ui/select": { SelectField: ({ options, value, "aria-label": label }: { options: { value: string; label: string; group?: string }[]; value: string; "aria-label": string }) =>
    createElement("div", { "aria-label": label, "data-value": value }, options.map((o) =>
      createElement("span", { key: o.value, "data-group": o.group, "data-value": o.value }, o.label))) },
  "@/components/research/ai-cell": { useContactAiFields: () => [], useContactAnswers: () => ({}), AiCell: empty },
  "./fields": { isEditable: () => false },
  "./board-view": { BoardView: empty },
  "./calendar-view": { CalendarView: empty },
  "./board-move": {},
  "./grouped-list": { GroupedRows: empty },
  "./audience-actions": { ContactAudienceActions: empty },
  "./csv-import": { CsvImport: empty },
  "./custom-csv-import": { CustomCsvImport: empty },
  "./list-export": { ExportView: empty },
  "./use-object-list": { useObjectList: () => ({ rows: [], total: 0 }) },
  "./deal-create": { DealCreateDialog: empty },
  "./lookup-field": { useLookupTitles: () => ({}) },
  "./money": { useWorkspaceMoney: () => ({ currency: "USD" }) },
  "./record-context": { useRecordInspection: () => ({}), useRecordsSaved: empty, RecordQuickView: empty },
  "./record-target": {},
  "./convert-lead": { ConvertLeadDialog: empty },
  "./merge-dialog": { MergeDialog: empty },
};
function loadComponent(name: string) {
  const source = readFileSync(new URL(`../src/components/records/${name}.tsx`, import.meta.url), "utf8");
  const exports: Record<string, (...args: never[]) => ReactNode> = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports,
    require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      if (id.startsWith("../../../convex/lib/") || id === "../../../modules/kernel/reportLanguage") return require(`../${id.slice(9)}.ts`);
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected dependency: ${id}`);
      return require(id);
    },
  });
  return exports;
}
const filterBar = loadComponent("filter-bar");
stubs["./filter-bar"] = {
  ...filterBar,
  FilterBar: (props: Parameters<typeof import("../src/components/records/filter-bar").FilterBar>[0]) =>
    createElement(filterBar.FilterBar as typeof import("../src/components/records/filter-bar").FilterBar, { ...props, filters: [
      { field: "recordTitle", op: "contains", value: "Person" },
      { field: "company.employees", op: "gte", value: 50 },
      { field: "deal.stage", op: "eq", value: "negotiation" },
      { field: "deal.amount", op: "gte", value: 1_000_000 },
    ] }),
};
const { ObjectListView } = loadComponent("list-view") as { ObjectListView: (props: { object: string }) => ReactNode };

test("the People FilterBar renders related field groups and typed value controls", () => {
  const cases = [
    { object: "contact", query: "", hidden: "", company: true, deal: true },
    { object: "contact", query: "filter=%5B%5D", hidden: "deal", company: true, deal: false },
    { object: "contact", query: "", hidden: "account", company: false, deal: true },
    { object: "account", query: "", hidden: "", company: false, deal: false },
    { object: "contact", query: "audience=aud_1", hidden: "", company: false, deal: false },
  ];
  for (const scenario of cases) {
    search = new URLSearchParams(scenario.query);
    hiddenObject = scenario.hidden;
    const html = renderToStaticMarkup(createElement(ObjectListView, { object: scenario.object }));
    assert.equal(html.includes('data-group="Company" data-value="company.industry"'), scenario.company, JSON.stringify(scenario));
    assert.equal(html.includes('aria-label="company.employees value"'), scenario.company, JSON.stringify(scenario));
    assert.equal(html.includes('data-group="Opportunity" data-value="deal.stage"'), scenario.deal, JSON.stringify(scenario));
    assert.equal(html.includes('data-value="negotiation">Negotiation'), scenario.deal, JSON.stringify(scenario));
    assert.equal(html.includes('placeholder="$" value="10000"'), scenario.deal, JSON.stringify(scenario));
  }
});
