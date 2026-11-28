import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement as h, type ElementType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const loaded = new Map<string, Record<string, ElementType>>();
function ui(name: string): Record<string, ElementType> {
  const path = `../src/components/ui/${name}.tsx`;
  const existing = loaded.get(path);
  if (existing) return existing;
  const exports = {};
  loaded.set(path, exports);
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, Event, require: (id: string) => {
    if (id.startsWith("@/components/ui/")) return ui(id.slice("@/components/ui/".length));
    if (id === "@/lib/utils") return { cn: (...values: unknown[]) => values.flat().filter(Boolean).join(" ") };
    return require(id);
  } });
  return exports;
}

for (const [name, root, trigger] of [
  ["dialog", "Dialog", "DialogTrigger"], ["sheet", "Sheet", "SheetTrigger"],
  ["popover", "Popover", "PopoverTrigger"], ["dropdown-menu", "DropdownMenu", "DropdownMenuTrigger"],
  ["tooltip", "Tooltip", "TooltipTrigger"],
]) {
  test(`${root} asChild keeps one trigger element, its label and caller props`, () => {
    const parts = ui(name);
    const html = renderToStaticMarkup(h(parts[root], null,
      h(parts[trigger], { asChild: true, "aria-label": "Open panel" },
        h("button", { className: "caller-trigger", type: "button" }, "Open"))));
    assert.equal((html.match(/<button\b/g) ?? []).length, 1);
    assert.match(html, /aria-label="Open panel"/);
    assert.match(html, /caller-trigger/);
    assert.match(html, />Open<\/button>/);
    assert.doesNotMatch(html, /asChild=/);
  });
}

test("button and badge render their child links with merged classes and content", () => {
  for (const name of ["button", "badge"]) {
    const Part = ui(name)[name === "button" ? "Button" : "Badge"];
    const html = renderToStaticMarkup(h(Part, { asChild: true, className: "wrapper" },
      h("a", { href: "/dashboard", className: "link" }, "Dashboard")));
    assert.match(html, /^<a /);
    assert.match(html, /href="\/dashboard"/);
    assert.match(html, /wrapper/);
    assert.match(html, /link/);
    assert.match(html, />Dashboard<\/a>$/);
  }
});

test("Select accepts empty values, renders rich placeholders and submits its name", () => {
  const { Select, SelectTrigger, SelectValue } = ui("select");
  const html = renderToStaticMarkup(h(Select, { value: "", name: "owner", onValueChange: () => {} },
    h(SelectTrigger, { "aria-label": "Owner" },
      h(SelectValue, { placeholder: h("em", null, "Anyone") }))));
  assert.match(html, /<em>Anyone<\/em>/);
  assert.match(html, /name="owner"/);
  assert.match(html, /role="combobox"/);
});

test("Tabs keeps string values and exposes the selected tab and panel", () => {
  const { Tabs, TabsList, TabsTrigger, TabsContent } = ui("tabs");
  const html = renderToStaticMarkup(h(Tabs, { defaultValue: "first" },
    h(TabsList, { "aria-label": "Sections" }, h(TabsTrigger, { value: "first" }, "First"), h(TabsTrigger, { value: "second" }, "Second")),
    h(TabsContent, { value: "first" }, "First panel"), h(TabsContent, { value: "second" }, "Second panel")));
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /First panel/);
});
