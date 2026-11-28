import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

/** Loads a TSX module the way Next compiles it, with `@/` imports answered from `stubs`. */
function load<T>(path: string, stubs: Record<string, unknown>): T {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {} as T;
  runInNewContext(outputText, { exports, require: (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)) });
  return exports;
}

const cn = (...values: unknown[]) => values.filter(Boolean).join(" ");
const select = load<{
  SelectField: (props: Record<string, unknown>) => ReactNode;
  SearchableSelectField: (props: Record<string, unknown>) => ReactNode;
}>("../src/components/ui/select.tsx", { "@/lib/utils": { cn }, "@/components/ui/composition": {} });

const zones = [
  { value: "America/Los_Angeles", label: "America / Los Angeles", group: "America", keywords: ["Pacific Standard Time", "PST"] },
  { value: "Asia/Tokyo", label: "Asia / Tokyo", group: "Asia" },
];

/** The class list of the first select or combobox trigger in `html`. */
const triggerClasses = (html: string) => new Set(html.match(/<button[^>]*data-slot="(?:select|combobox)-trigger"[^>]*>/)?.[0].match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []);

test("the searchable select shows the chosen option on a trigger drawn exactly like SelectField's (#1469)", () => {
  const props = { value: "America/Los_Angeles", onValueChange: () => {}, options: zones, size: "default", className: "w-full" };
  const searchable = renderToStaticMarkup(createElement(select.SearchableSelectField, { ...props, searchLabel: "Search timezones" }));
  const plain = renderToStaticMarkup(createElement(select.SelectField, props));
  assert.match(searchable, /America \/ Los Angeles/);
  assert.match(searchable, /data-size="default"/);
  // Same height, border and padding classes: the two kinds of field sit level in one form row.
  assert.deepEqual(triggerClasses(searchable), triggerClasses(plain));
  assert.ok(triggerClasses(searchable).has("data-[size=default]:h-8"));
});

test("workspace defaults: text inputs match the select triggers and labels pack to the top (#1469)", () => {
  const source = readFileSync(new URL("../src/app/dashboard/settings/workspace-form.tsx", import.meta.url), "utf8");
  const field = source.match(/const FIELD = "([^"]*)"/)?.[1] ?? "";
  const text = source.match(/const TEXT_FIELD = "([^"]*)"/)?.[1] ?? "";
  // A grid label stretches its rows to the cell, so a neighbour's hint text pushed Timezone's select down.
  assert.ok(field.split(" ").includes("content-start"), field);
  for (const cls of ["h-8", "border", "border-border", "px-2.5"]) assert.ok(text.split(" ").includes(cls), `${cls} in ${text}`);
  assert.ok(!/rounded-lg|border-input/.test(text), text);
  assert.doesNotMatch(source, /<label className="grid gap-1\.5/, "every workspace field uses FIELD");
  assert.match(source, /<SearchableSelectField[\s\S]*?value=\{timezone\}/, "the timezone picker is searchable");
});

test("the searchable select keeps an option valued \"\" as a real choice, like SelectField", () => {
  const options = [{ value: "", label: "Any timezone" }, ...zones];
  const html = renderToStaticMarkup(createElement(select.SearchableSelectField, { value: "", onValueChange: () => {}, options, placeholder: "Pick one" }));
  assert.match(html, /Any timezone/);
  assert.doesNotMatch(html, /Pick one/);
});
