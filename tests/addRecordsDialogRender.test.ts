import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, isValidElement, type ReactNode, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { emptySpec } from "../convex/lib/icps.ts";
import { resolveFillPrefill } from "../src/lib/fill-prefill.ts";

const require = createRequire(import.meta.url);
const childrenOnly = ({ children }: { children?: ReactNode }) => children;
const selected = { key: "icps:chosen", name: "Chosen", active: true, isDefault: false, updatedAt: 2, spec: {
  ...emptySpec(), market: { industries: ["retail"], countries: ["ca"], employeeBands: ["51-200"] },
  persona: { ...emptySpec().persona, titles: ["Operations"], countries: ["us"] },
  exclude: { industries: ["banking"], countries: ["gb"], titles: ["Consultant"] },
} };
const defaultIcp = { ...selected, key: "icps:default", name: "Default", isDefault: true, spec: emptySpec() };
const context = { canRun: true, configured: true, icps: [defaultIcp, selected], start: { icpId: defaultIcp.key, spec: defaultIcp.spec } };
const source = { icps: [defaultIcp, selected] };
const transpiled = ts.transpileModule(readFileSync(new URL("../src/components/crm/add-records-dialog.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;

function render(icpId?: string, results: { source?: unknown; context?: unknown } = { source, context }, open = true) {
  let actions = 0;
  let formKey: string | null = null;
  const fields: Record<string, unknown> = {};
  const capture = (name: string) => ({ value }: { value: unknown }) => { fields[name] = value; return null; };
  const stubs: Record<string, unknown> = {
    "convex/react": { useAction: () => () => { actions++; }, useQueries: () => results },
    "../../../convex/_generated/api": { api: { addRecords: {}, records: {}, icpsInterface: {} } },
    "../../../convex/lib/peopleSources": {},
    "../../../convex/lib/addRecords": { MAX_TARGET_ACCOUNTS: 100, parseAccountList: () => ({ accounts: [], invalid: [] }) },
    "next/link": { default: childrenOnly }, "next/navigation": { useRouter: () => ({}) },
    "@/lib/fill-prefill": { resolveFillPrefill }, "@/lib/toast": {}, "@/lib/utils": {},
    "@/components/records/object-labels": { useObjectLabels: () => () => ({ pluralLabel: "Accounts" }) },
    "@/components/crm/icp-fields": { MarketFields: capture("market"), PersonaFields: capture("persona"), ExcludeFields: capture("exclude"), Chips: () => null, excludeCount: () => 1 },
    "@/components/crm/paid-sources-tab": { PaidSourcesTab: () => null },
    "@/components/ui/select": { SelectField: capture("from") },
    "@/components/ui/dialog": {
      ...Object.fromEntries(["Dialog", "DialogTitle", "DialogDescription"].map((name) => [name, childrenOnly])),
      DialogContent: ({ children }: { children: ReactNode[] }) => {
        for (const child of children) if (isValidElement(child) && child.key !== null) formKey = child.key;
        return children;
      },
    },
    "@/components/ui/tabs": {
      ...Object.fromEntries(["TabsContent", "TabsList", "TabsTrigger"].map((name) => [name, childrenOnly])),
      Tabs: ({ children, value }: { children: ReactNode; value: string }) => createElement("div", { "data-tab": value }, children),
    },
  };
  const exports: { AddRecordsDialog?: ComponentType<{ open: boolean; icpId?: string; onOpenChange: () => void }> } = {};
  runInNewContext(transpiled, { exports, Error, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), id);
    return require(id);
  } });
  const html = renderToStaticMarkup(createElement(exports.AddRecordsDialog!, { open, icpId, onOpenChange: () => {} }));
  return { html, fields, actions, formKey };
}

test("Add records uses exact prefill fields and market tab, while ordinary opening retains workspace defaults", () => {
  const chosen = render(selected.key);
  assert.match(chosen.html, /data-tab="market"/);
  assert.deepEqual(chosen.fields, { market: selected.spec.market, persona: selected.spec.persona, exclude: selected.spec.exclude, from: selected.key });
  const ordinary = render();
  assert.match(ordinary.html, /data-tab="accounts"/);
  assert.deepEqual(ordinary.fields.market, defaultIcp.spec.market);
  assert.equal(ordinary.fields.from, defaultIcp.key);
  assert.equal(chosen.actions + ordinary.actions, 0);
});

test("Add records renders waiting and explicit refusal without mounting forms or starting actions", () => {
  const waiting = render(selected.key, { context });
  assert.match(waiting.html, /role="status"/);
  assert.deepEqual(waiting.fields, {});
  assert.equal(waiting.actions, 0);
  for (const [key, current, ctx] of [
    ["", source, context], ["missing", source, context],
    [selected.key, { icps: [{ ...selected, active: false }] }, context],
    [selected.key, new Error("provider unavailable"), context],
    [selected.key, source, new Error("context unavailable")],
    [selected.key, source, null],
    [selected.key, source, { ...context, configured: false }],
  ] as const) {
    const result = render(key, { source: current, context: ctx });
    assert.match(result.html, /role="alert"/);
    assert.deepEqual(result.fields, {});
    assert.equal(result.actions, 0);
  }
});

test("changed intent or source replaces the form identity and closing unmounts the form", () => {
  const before = render(selected.key);
  assert.notEqual(render(defaultIcp.key).formKey, before.formKey);
  const changed = { ...selected, updatedAt: 3, spec: defaultIcp.spec };
  const after = render(selected.key, { source: { icps: [defaultIcp, changed] }, context });
  assert.notEqual(after.formKey, before.formKey);
  assert.deepEqual(after.fields.market, changed.spec.market);
  assert.equal(render(selected.key, { source, context }, false).formKey, null);
  assert.deepEqual(render(selected.key).fields, before.fields);
});
