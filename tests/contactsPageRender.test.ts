import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as contactTable from "../src/lib/contact-table.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const legacyNote = "Legacy discovery summary sentinel";
const source = readFileSync(new URL("../src/app/dashboard/contacts/page.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
const stubs: Record<string, unknown> = {
  "@/components/integration-gate": { IntegrationGate: ({ children }: { children: ReactNode }) => children },
  "next/link": { default: empty },
  "convex/react": {
    useAction: () => async () => undefined,
    useQuery: (ref: unknown) => ref === "describe" ? { canCreate: false } : { contactsSampled: 25, contactsNote: legacyNote },
  },
  "../../../../convex/_generated/api": {
    api: { objects: { describe: "describe" }, records: {}, usage: {}, researchSessions: {} },
  },
  "@/components/dashboard": {
    ViewFrame: ({ title, actions, controls, children }: { title: string; actions: { id: string; label: string; onClick: () => void }[]; controls: ReactNode; children: ReactNode }) => createElement("div", null, createElement("h1", null, title), actions.map((action) => createElement("button", { key: action.id, onClick: action.onClick }, action.label)), controls, children),
      ReadFailure: empty,
      SelectionBar: empty,
    EmptyState: empty,
    LoadingRows: () => createElement("div", { "data-loading": true }),
  },
  "@/lib/url-state": { useUrlState: () => [{ q: "" }, empty] },
  "@/lib/toast": { toast: { error: empty } },
  "@/lib/utils": { getErrorMessage: String },
  "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
  "@/components/research/ai-cell": { AiCell: empty, useContactAiFields: () => [], useContactAnswers: () => ({}) },
  "@/components/research/research-menu": { ContactResearchMenu: empty },
  "@/components/research/ai-field-dialog": { AiFieldDialog: empty },
  "@/lib/contact-table": contactTable,
  "./bulk-reveal-dialog": { BulkRevealDialog: empty },
  "@/components/records/archive-records": { ArchiveSelected: empty, ArchivedLink: empty },
  "@/components/crm/add-records-dialog": { AddRecordsDialog: empty, useFillTick: () => 0 },
  "@/components/records/csv-import": { CsvImport: empty },
  "@/components/crm/call-suggestions": { CallSuggestions: empty },
  "@/components/records/record-context": { RecordLink: empty, RecordQuickView: empty, useRecordsSaved: empty },
    "@/components/records/object-labels": { useObjectLabels: () => () => ({ label: "Person", pluralLabel: "People" }) },
    "@/components/records/live-rows": { refreshLimit: () => 50, refreshRows: empty, useKeepSettled: (value: unknown) => value },
};
const exports: { default?: () => ReactNode } = {};
runInNewContext(outputText, {
  exports,
  require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected contacts dependency: ${id}`);
    return require(id);
  },
});

test("contacts header keeps table controls without legacy discovery and explanatory blocks", () => {
  assert.ok(exports.default);
  const html = renderToStaticMarkup(createElement(exports.default));
  assert.match(html, /<h1>People<\/h1>/);
  assert.match(html, /<button>Add records<\/button>/, "register creation stays available when ledger creation is disabled");
  assert.match(html, /aria-label="Search contacts"/);
  assert.match(html, /aria-label="Sort loaded contacts"/);
  assert.match(html, /aria-label="Filter loaded contacts by"/);
  assert.match(html, /data-loading="true"/);
  assert.ok(!html.includes(legacyNote), "discovery notes must not appear above contacts");

});
