import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { parseSplits } from "../modules/kernel/splits.ts";
import { contactHref } from "../src/lib/contact-href.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/records/fields.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const exports: { InlineField?: ComponentType<Record<string, unknown>>; FieldInput?: ComponentType<Record<string, unknown>> } = {};
runInNewContext(outputText, { exports, URL, require: (id: string) => {
  if (id === "@/lib/utils") return { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") };
  if (id === "./record-context") return { useRecordDraft: (_key: string, initial: unknown) => require("react").useState(initial) };
  if (id === "@/components/ui/select") return { SelectField: () => null };
  if (id === "../../../modules/kernel/splits") return { parseSplits };
  if (id === "@/lib/contact-href") return { contactHref };
  if (id === "./lookup-field") return { LookupInput: ({ field }: { field: { lookupTo: string } }) => createElement("span", { "data-picker": field.lookupTo }) };
  assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected dependency: ${id}`);
  return require(id);
} });

function render(value: unknown, readOnly = false, apiName = "linkedinUrl", type = "text") {
  return renderToStaticMarkup(createElement(exports.InlineField!, {
    field: { fieldId: apiName, apiName, label: "LinkedIn URL", type },
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

test("emails, phones and links open as mailto, tel and new-tab links; a value that is not http or https stays text", () => {
  const links = (type: string, value: string[], readOnly = false) => [...render(value, readOnly, "custom.x", type).matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  for (const readOnly of [false, true]) {
    assert.deepEqual(links("emails", ["ann@acme.com"], readOnly), ['<a href="mailto:ann@acme.com" class="truncate text-primary underline">']);
    assert.deepEqual(links("phones", ["+1 (555) 010-0000 x12"], readOnly), ['<a href="tel:+15550100000;ext=12" class="truncate text-primary underline">']);
    assert.deepEqual(links("links", ["acme.com/about"], readOnly), ['<a href="https://acme.com/about" target="_blank" rel="noopener noreferrer" class="truncate text-primary underline">']);
  }
  for (const value of ["javascript:alert(1).x", "data:text/html,x.y", "vbscript:x.y", "ftp://acme.com", "mailto:a@b.co"]) {
    const html = render([value], false, "custom.x", "links");
    assert.doesNotMatch(html, /<a\b/, value);
    assert.match(html, /Change/);
  }
  assert.doesNotMatch(render(["ann@acme.com?cc=x@y.z"], false, "custom.x", "emails"), /<a\b/);
});

test("a lookup in a form is the record picker, not a box for a raw id", () => {
  const html = renderToStaticMarkup(createElement(exports.FieldInput!, { field: { fieldId: "custom.client", apiName: "custom.client", label: "Client", type: "lookup", lookupTo: "account" }, value: null, onChange: () => undefined }));
  assert.equal(html, '<span data-picker="account"></span>');
});
