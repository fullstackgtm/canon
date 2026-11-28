import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/dashboard/settings/workspace-form.tsx", import.meta.url), "utf8");

function workspace(role = "admin", timezone = "US/Pacific") {
  const org = { name: "Demo", defaultCurrency: "USD", timezone, currentUserRole: role };
  let picker: any;
  let form: any;
  let stateIndex = 0;
  const states: any[] = [];
  const writes: unknown[] = [];
  const sdk = require("@ui-sdk/react/combobox");
  const stubs: Record<string, unknown> = {
    react: { ...React, useEffect: () => {}, useState: (initial: unknown) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = index === 0 ? { ...org, industry: "", fiscalYearStartMonth: 1, currencyDecimals: 2, syncSchedule: "daily", hierarchySource: "hubspot" } : initial;
      return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    } },
    "convex/react": { useQuery: (ref: string) => ref === "org" ? { organization: org } : {}, useMutation: () => async (draft: unknown) => { writes.push(draft); } },
    "../../../../convex/_generated/api": { api: { organizations: { context: "org" }, integrations: {} } },
    "@/lib/toast": { toast: { success() {}, error() {} } },
    "@/components/dashboard": { LoadingRows: () => null, StatusBadge: () => null },
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
    "@/components/ui/select": { SelectField: () => React.createElement("button", { type: "button" }) },
    "../../../../modules/kernel/pacing": { fiscalMonth: () => ({ fy: 2026, m: 0 }) },
    "../../../../modules/kernel/text": { moneyDecimals: () => 2, formatMoney: () => "$1,234,567.89" },
    "@ui-sdk/react/combobox": { ...sdk, Combobox: (props: any) => { picker = props; return React.createElement(sdk.Combobox, props); } },
  };
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: any = {};
  runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
  function render() {
    stateIndex = 0;
    function Harness() {
      const tree = exports.WorkspaceForm();
      form = tree.props.children;
      return tree;
    }
    return renderToStaticMarkup(React.createElement(Harness));
  }
  return { render, picker: () => picker, writes, save: () => form.props.onSubmit({ preventDefault() {} }) };
}

test("workspace top-aligns fields with helper text and renders a named timezone search", () => {
  const page = workspace();
  const html = page.render();
  assert.match(html, /grid-cols-1 items-start gap-4 md:grid-cols-2/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /placeholder="Search timezones…"/);
  assert.match(html, /value="US \/ Pacific"/);
  assert.match(html, /<label[^>]*>Timezone<\/label>/);
});

test("timezone selection preserves IANA values, saves the draft, and honors read-only access", async () => {
  const page = workspace();
  page.render();
  assert.equal(page.picker().itemToLabel("America/New_York"), "America / New York");
  page.picker().onValueChange("America/New_York");
  page.render();
  await page.save();
  assert.equal((page.writes[0] as any).timezone, "America/New_York");
  page.picker().onValueChange(null);
  page.render();
  assert.equal(page.picker().value, "America/New_York");
  const reader = workspace("member");
  const html = reader.render();
  assert.equal(reader.picker().disabled, true);
  assert.match(html, /<input[^>]*disabled=""/);
});
