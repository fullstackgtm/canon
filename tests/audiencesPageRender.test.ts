import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as sequencers from "../convex/lib/outbound/sequencers.ts";

const require = createRequire(import.meta.url);
const empty = () => null;

function render(summary?: { total: number; withEmail: number; customVariables: string[]; computedAt: number }) {
  const effects: Array<() => void> = [];
  const actions: string[] = [];
  const stubs: Record<string, unknown> = {
    react: { ...require("react"), useEffect: (effect: () => void) => effects.push(effect) },
    "next/link": { default: empty },
    "convex/react": {
      useQuery: (ref: string) => ref === "list" ? [{ _id: "audience-1", name: "Buyers", summary }] : ref === "history" ? [] : {},
      useAction: (ref: string) => async () => { actions.push(ref); return { push: null }; },
      useMutation: () => empty,
    },
    "../../../../convex/_generated/api": { api: {
      audiences: { list: "list", history: "history", sequencerStatus: "status" },
      audienceActions: { preview: "preview", exportCsv: "export", campaigns: "campaigns", push: "push" },
    } },
    "../../../../convex/lib/outbound/sequencers": sequencers,
    "@/components/dashboard": { ViewFrame: ({ children }: { children?: ReactNode }) => children, EmptyState: empty, LoadingRows: () => createElement("div", null, "Loading rows") },
    "@/components/records/audience-actions": { downloadCsv: empty },
    "@/lib/toast": { toast: { error: empty } },
    "@/lib/url-state": { useUrlState: () => [{ audience: "" }, empty] },
    "@/lib/utils": { cn: (...values: string[]) => values.join(" "), getErrorMessage: String },
    "@/components/ui/select": { SelectField: ({ options, value, disabled, "aria-label": label }: { options: { value: string; label: ReactNode }[]; value: string; disabled?: boolean; "aria-label"?: string }) => createElement("button", { type: "button", role: "combobox", "aria-label": label, disabled }, options.find((o) => o.value === value)?.label) },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/audiences/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
  const html = renderToStaticMarkup(createElement(exports.default!));
  for (const effect of effects) effect();
  return { html, actions };
}

test("opening an audience reads its persisted summary without resolving membership", () => {
  const { html, actions } = render({ total: 1234, withEmail: 1200, customVariables: ["region"], computedAt: 1000 });
  assert.deepEqual(actions, []);
  assert.match(html, /1,234 contacts, 1,200 with an email/);
  assert.match(html, /region/);
  assert.doesNotMatch(html, /Loading rows/);
});

test("an audience without a cached summary remains usable without a page-load refresh", () => {
  const { html, actions } = render();
  assert.deepEqual(actions, []);
  assert.match(html, /pending background refresh/);
  assert.match(html, /Export CSV/);
  assert.doesNotMatch(html, /Loading rows/);
});
