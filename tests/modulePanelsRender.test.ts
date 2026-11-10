import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as schema from "../modules/kernel/schema.ts";
import * as text from "../modules/kernel/text.ts";
import * as document from "../modules/kernel/document.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const recipe = createElement("section", { "data-owner": "recipe" }, createElement("h2", null, "Calls"));

function load<T>(file: string, stubs: Record<string, unknown>, expose = ""): T {
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8") + expose, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  runInNewContext(outputText, { exports, URLSearchParams, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    if (["react", "react/jsx-runtime", "lucide-react"].includes(id)) return require(id);
    return {};
  } });
  return exports as T;
}

test("one contribution read selects a replacement or retains the recipe while absent or loading", () => {
  type Contribution = { module: string; title: string; panels: Array<{ id: string; title: string; path: string; replaces?: string }> };
  let contributions: Contribution[] | undefined;
  const { ModulePanels } = load<Pick<typeof import("../src/components/modules/module-panels"), "ModulePanels">>("../src/components/modules/module-panels.tsx", {
    "convex/react": { useQuery: (_ref: unknown, args: unknown) => args === "skip" ? undefined : contributions },
    "../../../convex/_generated/api": { api: { modules: { contributions: "contributions" } } },
    "./module-page": { ModulePage: ({ frame }: { frame: (body: ReactNode) => ReactNode }) => frame(createElement("div", { "data-owner": "module" }, "Call controls")) },
  });
  const draw = (enabled = true) => renderToStaticMarkup(createElement(ModulePanels, {
    page: "person", record: "con_a", enabled, fallback: () => recipe,
    renderSections: (replaced) => replaced.has("callPanel") ? null : recipe,
  }));
  for (const state of [undefined, []]) {
    contributions = state;
    assert.equal((draw().match(/<h2[^>]*>Calls<\/h2>/g) ?? []).length, 1);
    assert.match(draw(), /data-owner="recipe"/);
  }
  contributions = [{ module: "custom-phone", title: "Custom phone", panels: [{ id: "calls", title: "Calls", path: "panel/person/calls", replaces: "callPanel" }] }];
  const on = draw();
  assert.equal((on.match(/<h2[^>]*>Calls<\/h2>/g) ?? []).length, 1);
  assert.match(on, /data-owner="module"/);
  assert.doesNotMatch(on, /data-owner="recipe"/);
  assert.match(draw(false), /data-owner="recipe"/);
  contributions.push({ ...contributions[0], module: "another-phone" });
  assert.equal((draw().match(/data-owner="module"/g) ?? []).length, 1, "two claims cannot draw two replacements");
});

test("an embedded module page restores its recipe while unavailable", () => {
  let view: unknown;
  const { ModulePage } = load<Pick<typeof import("../src/components/modules/module-page"), "ModulePage">>("../src/components/modules/module-page.tsx", {
    "convex/react": { useQuery: () => view, useAction: () => empty },
    "../../../convex/_generated/api": { api: { modules: { page: "page", records: "records" } } },
    "next/navigation": { useSearchParams: () => new URLSearchParams(), usePathname: () => "/dashboard/records/contact/con_a", useRouter: () => ({ replace: empty }) },
    "@/lib/utils": { cn: (...values: string[]) => values.join(" "), getErrorMessage: String },
  });
  for (view of [undefined, null, { upgrading: { title: "Dialer", version: "0.2.0" } }, { module: { slug: "dialer", title: "Dialer" }, page: null }, { failed: { message: "Unavailable" } }, { missing: { text: "Unavailable" } }]) {
    const html = renderToStaticMarkup(createElement(ModulePage, { module: "dialer", path: ["panel", "person", "calls"], query: { record: "con_a" }, embedded: true, fallback: recipe }));
    assert.match(html, /data-owner="recipe"/);
    assert.equal((html.match(/<h2[^>]*>Calls<\/h2>/g) ?? []).length, 1);
  }
});


test("a computed binding prefills the rendered wizard and waits for post-save reads before navigation", async () => {
  let submitted: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  let writes = 0;
  const navigations: string[] = [];
  const notices: string[] = [];
  const runtime = require("react/jsx-runtime") as { jsx: (type: unknown, props: Record<string, unknown>, key?: unknown) => ReactNode; jsxs: (type: unknown, props: Record<string, unknown>, key?: unknown) => ReactNode };
  const capture = (render: typeof runtime.jsx) => (type: unknown, props: Record<string, unknown>, key?: unknown) => {
    if (type === "form") submitted = props.onSubmit as typeof submitted;
    return render(type, props, key);
  };
  const common = {
    "convex/react": { useAction: () => empty, useConvex: () => ({}), useQuery: () => undefined },
    "../../../convex/_generated/api": { api: { modules: { call: "call" } } },
    "../../../modules/kernel/schema": schema,
    "../../../modules/kernel/text": text,
    "../../../modules/kernel/document": document,
    "@/lib/utils": { cn: (...values: string[]) => values.join(" "), getErrorMessage: String },
  };
  const form = load<typeof import("../src/components/modules/module-form")>("../src/components/modules/module-form.tsx", {
    ...common,
    "@/components/ui/select": { SelectField: ({ value, options, onValueChange: _change, ...props }: { value: string; options: Array<{ value: string; label: string }>; onValueChange: unknown }) => createElement("select", { ...props, value, onChange: empty }, options.map((o) => createElement("option", { key: o.value, value: o.value }, o.label))) },
  });
  type Resolve = (data: Record<string, unknown>, loaded: Record<string, unknown>, value: () => undefined) => (expr: unknown) => unknown;
  const { Wizard, formValueOf } = load<{ Wizard: ComponentType<Record<string, unknown>>; formValueOf: Resolve }>("../src/components/modules/module-page.tsx", {
    ...common,
    "next/navigation": { useRouter: () => ({ push: (href: string) => navigations.push(href) }) },
    "react/jsx-runtime": { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) },
    "convex/react": { ...common["convex/react"], useAction: () => async () => { writes++; return { value: { key: "mine" } }; } },
    "@/lib/toast": { toast: { success: (message: string) => notices.push(message) } },
    "./module-form": form,
  }, "\nexports.Wizard = Wizard; exports.formValueOf = formValueOf;");
  const manifest = JSON.parse(readFileSync("modules/examples/notetaker/module.json", "utf8"));
  const wizard = manifest.pages.find((p: { path: string }) => p.path === "rules/edit").body.find((n: { c: string }) => n.c === "wizard");
  const specs: Record<string, schema.FieldSpec> = manifest.calls.savePreferences.args.value;
  const fields = Object.entries(specs).map(([field, spec]) => ({ field, spec, required: !spec.optional, widget: schema.widgetOf(spec), choices: schema.literalChoices(spec.fieldType), labels: schema.choiceLabels(spec.fieldType) }));
  const doc = (data: Record<string, unknown>) => ({ key: "mine", version: 1, owner: "rep1", data });
  const list = { field: "domains", label: "Domains", widget: "list" as const, required: true, spec: specs.includeDomains };
  assert.deepEqual(form.fromDraft(list, []), []);
  assert.equal(form.fromDraft({ ...list, required: false }, []), undefined);
  const defaults = { mode: "off", includeDomains: [], excludeDomains: [], skipKeywords: [] };
  const saved = { ...defaults, mode: "manual", includeDomains: ["example.test"], botName: "My meeting helper" };
  const draw = (data: Record<string, unknown>, loaded: Record<string, unknown>, reloadAll = async () => true) => renderToStaticMarkup(createElement(Wizard, { n: wizard, ctx: {
    view: { module: { slug: "notetaker" }, calls: { savePreferences: { fields, allowed: true } } },
    text: { binds: { ...data, ...loaded }, members: new Map(), currency: "USD" }, query: {},
    formValue: formValueOf(data, loaded, () => undefined), base: "/dashboard/m/notetaker", reloadAll,
  } }));
  for (const [data, loaded, mode, name] of [
    [{}, { prefs: doc(defaults) }, "off", undefined],
    [{ prefs: doc(defaults) }, { prefs: doc(saved) }, "manual", "My meeting helper"],
    [{ prefs: doc(saved) }, {}, "manual", "My meeting helper"],
  ] as const) {
    const html = draw(data, loaded);
    assert.match(html, new RegExp(`<option value="${mode}" selected=""`));
    assert.match(html, /<button type="submit"[^>]*>Save my preferences<\/button>/);
    assert.doesNotMatch(html, /<button type="submit"[^>]* disabled=/);
    if (name) {
      assert.ok(html.includes(`value="${name}"`));
      assert.ok(html.includes('value="example.test"'));
    }
  }
  const missing = draw({}, {});
  assert.match(missing, /<button type="submit"[^>]* disabled=/);
  let release: (ok: boolean) => void = empty;
  const refresh = new Promise<boolean>((resolve) => { release = resolve; });
  draw({}, { prefs: doc(defaults) }, () => refresh);
  const saving = submitted!({ preventDefault: empty });
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.deepEqual(navigations, []);
  assert.deepEqual(notices, []);
  release(true);
  await saving;
  assert.deepEqual(navigations, ["/dashboard/m/notetaker/rules"]);
  assert.equal(notices.length, 1);
  navigations.length = 0; notices.length = 0;
  draw({}, { prefs: doc(defaults) }, async () => false);
  await submitted!({ preventDefault: empty });
  assert.equal(writes, 2);
  assert.deepEqual(navigations, []);
  assert.deepEqual(notices, []);
});

test("adding a list row with one available choice submits the value shown", () => {
  let add: (() => void) | undefined;
  let draft: unknown;
  const runtime = require("react/jsx-runtime") as { jsx: (type: unknown, props: Record<string, unknown>, key?: unknown) => ReactNode; jsxs: (type: unknown, props: Record<string, unknown>, key?: unknown) => ReactNode };
  const capture = (render: typeof runtime.jsx) => (type: unknown, props: Record<string, unknown>, key?: unknown) => {
    if (type === "button" && typeof props.onClick === "function") add = props.onClick as () => void;
    return render(type, props, key);
  };
  const form = load<typeof import("../src/components/modules/module-form")>("../src/components/modules/module-form.tsx", {
    "convex/react": { useQuery: () => undefined },
    "../../../convex/_generated/api": { api: { modules: { suggest: "suggest" } } },
    "../../../modules/kernel/schema": schema,
    "../../../modules/kernel/text": text,
    "react/jsx-runtime": { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) },
    "@/lib/utils": { cn: (...values: string[]) => values.join(" "), getErrorMessage: String },
  });
  const field = { field: "fields", label: "Account fields", widget: "list" as const, required: true, spec: schema.withFieldChoices({ optional: false, fieldType: { type: "array", value: { type: "string" } } }, ["fit"], { fit: "Account fit" }) };
  renderToStaticMarkup(createElement(form.FieldsEditor, { fields: [field], values: { fields: [] }, onChange: (_field, next) => { draft = next; }, idPrefix: "choices" }));
  assert.ok(add);
  add();
  assert.deepEqual(JSON.parse(JSON.stringify(form.fromDraft(field, draft))), ["fit"]);
});
