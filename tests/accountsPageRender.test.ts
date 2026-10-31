import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { parseUrlState, serializeUrlState } from "../src/lib/url-state-core.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const childrenOnly = ({ children }: { children?: ReactNode }) => children;

function renderAccounts(query = "") {
  let signalStatusMounts = 0;
  let currentQuery = query;
  type DialogProps = { open: boolean; icpId?: string; onOpenChange: (open: boolean) => void };
  const captured: { dialog?: DialogProps } = {};
  const disclosure: { CollapsibleTreemap?: (props: { children: ReactNode }) => ReactNode } = {};
  const disclosureSource = readFileSync(new URL("../src/components/tam/collapsible-treemap.tsx", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(disclosureSource, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: disclosure, require });
  const stubs: Record<string, unknown> = {
    "next/link": { default: childrenOnly },
    "next/navigation": { useRouter: () => ({}), useSearchParams: () => new URLSearchParams(currentQuery) },
    "convex/react": { useAction: () => empty, useQuery: (ref: unknown) => ref === "describe" ? { canCreate: false } : null, useQueries: () => ({}) },
    "../../../../convex/_generated/api": { api: {
      objects: { describe: "describe" }, records: {}, researchSessions: {}, icpVersions: {}, icpsInterface: {}, users: {}, signals: {},
    } },
    "../../../../convex/lib/fitExplain": {},
    "../../../../convex/lib/signals/heat": { heatChunks: () => [] },
    "@/components/dashboard": {
      ViewFrame: ({ title, actions, controls, children }: { title: string; actions: { id: string; label: string; onClick: () => void }[]; controls: ReactNode; children: ReactNode }) => createElement("div", null, createElement("h1", null, title), actions.map((action) => createElement("button", { key: action.id, onClick: action.onClick }, action.label)), controls, children),
      ReadFailure: empty,
      SelectionBar: empty,
      LoadingRows: empty,
    },
    "@/lib/url-state": { useUrlState: (defaults: Record<string, string>) => [parseUrlState(new URLSearchParams(currentQuery), defaults), (patch: Record<string, string>) => { currentQuery = serializeUrlState(currentQuery, defaults, patch); }] },
    "@/components/crm/signals-ui": {
      SignalsStatus: () => { signalStatusMounts++; return createElement("div", null, "Signal management"); },
      HeatBadge: empty,
    },
    "@/components/crm/research-claim-fallback": { ResearchClaimFallback: empty },
    "@/components/crm/add-records-dialog": { AddRecordsDialog: (props: DialogProps) => { captured.dialog = props; return null; }, useFillTick: () => 0 },
    "@/components/records/csv-import": { CsvImport: empty },
    "@/components/crm/call-suggestions": { CallSuggestions: empty },
    "@/components/records/archive-records": { ArchiveSelected: empty, ArchivedLink: empty, useCanArchive: () => false },
    "@/components/records/record-context": { RecordLink: empty, RecordQuickView: empty, useRecordsSaved: empty },
    "@/components/records/object-labels": { useObjectLabels: () => () => ({ label: "Account", pluralLabel: "Accounts" }) },
    "@/components/records/live-rows": { refreshLimit: () => 50, refreshRows: empty, useKeepSettled: (value: unknown) => value },
    "@/components/crm/crm-ui": { ACCOUNT_STATUSES: [], PdlAttribution: empty },
    "@/lib/toast": {},
    "@/lib/utils": {},
    "@/lib/tam-levels": { DEFAULT_PV: "", parsePivot: () => ({}), pivotFilter: () => ({}) },
    "@/components/ui/select": Object.fromEntries(
      ["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"].map((name) => [name, childrenOnly]),
    ),
    "@/components/tam/tam-explorer": { TamExplorer: () => createElement("div", { "data-tam-explorer": true }) },
    "@/components/tam/treemap": {},
    "@/components/tam/collapsible-treemap": disclosure,
  };
  const source = readFileSync(new URL("../src/app/dashboard/accounts/page.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, {
    exports, URLSearchParams,
    require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected accounts dependency: ${id}`);
      return require(id);
    },
  });
  assert.ok(exports.default);
  const html = renderToStaticMarkup(createElement(exports.default));
  assert.ok(captured.dialog);
  return { html, signalStatusMounts, dialog: captured.dialog, query: () => currentQuery };
}

test("accounts renders its header, explorer and filters without mounting signal management", () => {
  const { html, signalStatusMounts } = renderAccounts();
  assert.match(html, /<h1>Accounts<\/h1>/);
  assert.match(html, /data-tam-explorer="true"/);
  assert.match(html, /aria-expanded="true" aria-controls="accounts-treemap"/);
  assert.match(html, /aria-label="Search accounts"/);
  assert.match(html, /<button>Add records<\/button>/, "register creation stays available when ledger creation is disabled");
  assert.equal(signalStatusMounts, 0, "Accounts must not mount the signal management header");
});

test("Accounts follows exact fill URL presence through close, Back and reopen without an opening effect", () => {
  const key = "icps:exact/key+value";
  const query = new URLSearchParams({ fill: key, icp: "other-filter", q: "Acme" }).toString();
  const page = renderAccounts(query);
  assert.equal(page.dialog.open, true);
  assert.equal(page.dialog.icpId, key);
  page.dialog.onOpenChange(false);
  const closed = renderAccounts(page.query());
  assert.equal(closed.dialog.open, false);
  assert.equal(closed.dialog.icpId, undefined);
  assert.equal(new URLSearchParams(closed.query()).get("icp"), "other-filter");
  assert.equal(new URLSearchParams(closed.query()).get("q"), "Acme");
  assert.equal(renderAccounts(query).dialog.icpId, key);
  assert.equal(renderAccounts("fill=next").dialog.icpId, "next");
  assert.equal(renderAccounts("fill=").dialog.open, true);
  assert.equal(renderAccounts("fill=").dialog.icpId, "");
});
