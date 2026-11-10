import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as catalog from "../src/app/dashboard/settings/catalog.ts";

const require = createRequire(import.meta.url);

test("settings renders its areas and detail rail without the relocated-area footer", () => {
  const stubs: Record<string, unknown> = {
    "next/link": { default: ({ children, ...props }: { children?: ReactNode }) => createElement("a", props, children) },
    "next/navigation": {
      useRouter: () => ({}), usePathname: () => "/dashboard/settings", useSearchParams: () => new URLSearchParams(),
    },
    "@/components/dashboard": { ViewFrame: ({ title, secondaryActions, children }: { title: string; secondaryActions?: ReactNode; children: ReactNode }) => createElement("div", null, createElement("h1", null, title), secondaryActions, children) },
    "@/lib/utils": { cn: (...classes: unknown[]) => classes.filter(Boolean).join(" ") },
    "./catalog": catalog,
    "./settings-ui": {
      useSettingsAccess: () => ({ isAdmin: true }),
      useSettingsSummaries: () => Object.fromEntries(catalog.SETTINGS_GROUPS.flatMap((group) =>
        group.items.map((item) => [item.key, { value: "Ready", facts: [] }]),
      )),
    },
  };
  const source = readFileSync(new URL("../src/app/dashboard/settings/page.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, {
    exports,
    require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), `Unexpected settings dependency: ${id}`);
      return require(id);
    },
  });
  assert.ok(exports.default);
  const html = renderToStaticMarkup(createElement(exports.default));
  assert.match(html, /data-testid="settings-row-workspace"/);
  assert.match(html, /data-testid="settings-rail"/);
  assert.match(html, /href="\/dashboard\/settings\/workspace"/);
  assert.doesNotMatch(html, /href="\/dashboard\/(?:integrations|recipes|agents)(?:[?"#])/);
});
