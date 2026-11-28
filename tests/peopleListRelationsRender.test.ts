import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anyApi, getFunctionName } from "convex/server";
import ts from "typescript";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import * as peopleList from "../src/lib/people-list.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
let search = new URLSearchParams();
let audience: unknown = null;
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
        case "objects:describe": return { ...resolveObjectDef(STANDARD_OBJECTS[args.object!]), pages: {}, readable: true, writable: false, readOnlyFields: [] };
        case "audiences:byId": return audience;
        case "savedViews:list": case "users:list": case "modules:contributions": return [];
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
  "@/components/ui/select": { SelectField: empty },
  "@/components/research/ai-cell": { useContactAiFields: () => [], useContactAnswers: () => ({}), AiCell: empty },
  "./fields": { isEditable: () => false },
  "./filter-bar": { FilterBar: empty, isComplete: () => true },
  "./related-people-filters": { RelatedPeopleFilters: () => createElement("div", { "data-related-people-filters": true }) },
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
const source = readFileSync(new URL("../src/components/records/list-view.tsx", import.meta.url), "utf8");
const exports: { ObjectListView?: (props: { object: string }) => ReactNode } = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText, {
  exports,
  require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (id.startsWith("../../../convex/lib/") || id === "../../../modules/kernel/reportLanguage") return require(`../${id.slice(9)}.ts`);
    assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected list dependency: ${id}`);
    return require(id);
  },
});

test("ObjectListView mounts related People controls only for the ordinary active People list", () => {
  assert.ok(exports.ObjectListView);
  const cases = [
    { name: "ordinary People", object: "contact", query: "", visible: true },
    { name: "archived People", object: "contact", query: "bin=1", visible: false },
    { name: "accounts", object: "account", query: "", visible: false },
    { name: "opportunities", object: "deal", query: "", visible: false },
    { name: "module filter handoff", object: "contact", query: new URLSearchParams({ filter: "[]", returnTo: "/dashboard/m/reports/filter" }).toString(), visible: false },
    { name: "standalone filter", object: "contact", query: "filter=%5B%5D", visible: false },
    { name: "audience editing", object: "contact", query: "audience=aud_1", visible: false },
    { name: "audience loading", object: "contact", query: "audience=aud_1", loading: true, visible: false },
  ];
  for (const scenario of cases) {
    search = new URLSearchParams(scenario.query);
    audience = scenario.loading ? undefined : search.has("audience") ? { _id: "aud_1", filter: [] } : null;
    const html = renderToStaticMarkup(createElement(exports.ObjectListView, { object: scenario.object }));
    assert.equal(html.includes("data-related-people-filters"), scenario.visible, scenario.name);
  }
});
