import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { parseSplits } from "../modules/kernel/splits.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/records/fields.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const exports: { InlineField?: ComponentType<Record<string, unknown>> } = {};
runInNewContext(outputText, { exports, URL, require: (id: string) => {
  if (id === "@/lib/utils") return { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") };
  if (id === "./record-context") return { useRecordDraft: (_key: string, initial: unknown) => require("react").useState(initial) };
  if (id === "@/components/ui/select") return { SelectField: () => null };
  if (id === "../../../modules/kernel/splits") return { parseSplits };
  assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected dependency: ${id}`);
  return require(id);
} });

function render(value: unknown, readOnly = false, apiName = "linkedinUrl") {
  return renderToStaticMarkup(createElement(exports.InlineField!, {
    field: { fieldId: apiName, apiName, label: "LinkedIn URL", type: "text" },
    value, version: 1, readOnly, onSave: async () => true,
  }));
}

test("LinkedIn fields offer a safe external target without replacing inline editing", () => {
  const url = "https://www.linkedin.com/in/example";
  for (const readOnly of [false, true]) {
    const html = render(url, readOnly);
    assert.match(html, /<a[^>]*href="https:\/\/www.linkedin.com\/in\/example"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Open LinkedIn<\/a>/);
    assert.equal(html.includes('title="Click to edit"'), !readOnly);
    for (const button of html.matchAll(/<button\b[^]*?<\/button>/g)) assert.doesNotMatch(button[0], /<a\b/);
  }
  for (const value of [null, undefined, "", "   ", "not a url", "javascript:alert(1)", "data:text/html,test"]) {
    assert.doesNotMatch(render(value), /<a\b/);
  }
  assert.doesNotMatch(render(url, false, "title"), /<a\b/);
});
