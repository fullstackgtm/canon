import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as recipes from "../recipes/index.ts";
import * as recordTarget from "../src/components/records/record-target.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const transpile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
const outputText = transpile("../src/components/records/record-page.tsx");
const recordParts = transpile("../src/components/records/record-parts.tsx");
const pageSections: { PageSections?: ComponentType<Record<string, unknown>> } = {};
// Customize mode is off: no shape context, and the page is the recipe's own sections.
const NO_SHAPE = { useShape: () => null, ShapeSection: ({ children }: { children: ReactNode }) => children,
  useShapeMode: ({ base }: { base: recipes.PageSpec }) => ({ page: base, provider: (children: ReactNode) => children }) };
runInNewContext(transpile("../src/components/records/page-sections.tsx"), { exports: pageSections, require: (id: string) => (id === "../../../recipes" ? recipes : id === "./shape/shape-mode" ? NO_SHAPE : require(id)) });
const NO_PLAY = Object.fromEntries(recipes.PLAY_COMPONENTS.map((c) => [c, empty]));

function render(object: string, status = "active", inDialog = false, recipe: recipes.RecipeId = recipes.POINTS["deal.page"].defaults.unset) {
  const dealPage = { id: recipe, hasPlays: recipes.RECIPES[recipe].data !== null, sections: recipes.RECIPES[recipe].dealPage };
  const stubs: Record<string, unknown> = {
    "next/link": { default: ({ children }: { children: ReactNode }) => children },
    "next/navigation": {},
    "convex/react": {
      useAction: () => empty, useMutation: () => empty,
      usePaginatedQuery: () => ({ results: [], status: "Exhausted" }),
      useQuery: (q: string) => q === "describe" ? { label: object, fields: [], readOnlyFields: [] }
        : q === "get" ? { object, title: "Example record", complete: true, lifecycle: { status }, values: {}, version: 1 }
        : q === "forOrg" ? { dealPage } : [],
    },
    "../../../convex/_generated/api": { api: { objects: { describe: "describe", get: "get" }, recipes: { forOrg: "forOrg" }, workspaceRecipes: {}, users: {}, automations: {} } },
    "../../../recipes": recipes,
    "@/components/dashboard": {}, "@/components/ui/dialog": {}, "@/lib/toast": {},
    "@/lib/utils": { cn: (...v: unknown[]) => v.filter(Boolean).join(" ") },
    "./fields": {}, "@/components/research/ai-cell": {},
    "@/components/crm/signals-ui": { DealTimeline: empty, LeadTimeline: empty },
    "@/components/crm/deal-gaps": { DealGaps: empty },
    // The play draws the record's sections where the page puts them, here a deal building the case.
    "@/components/crm/deal-play": { NO_PLAY, DealPlay: ({ page, record }: { page: recipes.PageSpec; record: Record<string, unknown> }) =>
      createElement(Fragment, null, createElement("section", null, "Deal play sentinel"), createElement(pageSections.PageSections!, { object: "deal", page, stage: "case", renderers: { ...NO_PLAY, ...record } })) },
    "./page-sections": pageSections,
    "./shape/shape-mode": NO_SHAPE,
    "./convert-lead": { ConvertLeadDialog: empty },
    "./deal-products": { DealProducts: empty },
    "./list-view": {},
    "./record-target": recordTarget,
    "./lookup-field": { useLookupTitles: empty },
    "./related-lists": { DealRelations: () => createElement("section", null, "Committee sentinel") },
    "./register-page": {},
    "../modules/module-panels": { ModulePanels: empty },
    "./record-boundary": { RecordBoundary: ({ children }: { children: ReactNode }) => children },
    "./record-context": { RecordLink: ({ children }: { children: ReactNode }) => children },
  };
  const load = (text: string) => {
    const exports: Record<string, unknown> = {};
    runInNewContext(text, { exports, require: (id: string) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), id);
      return require(id);
    } });
    return exports;
  };
  stubs["./record-parts"] = load(recordParts);
  const exports = load(outputText) as { RecordPage?: ComponentType<Record<string, unknown>> };
  return renderToStaticMarkup(createElement(exports.RecordPage!, { object, id: "record", ...(inDialog ? { inDialog: { onSaved: empty } } : {}) }));
}

test("only full active deals collapse record fields, history and committee below the play; the base recipe shows them open with no play", () => {
  const html = render("deal");
  assert.match(html, /Deal play sentinel[\s\S]*<details><summary[\s\S]*History[\s\S]*Committee sentinel[\s\S]*<\/details>/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  for (const other of [render("deal", "deleted"), render("deal", "merged"), render("deal", "active", true), render("lead")]) {
    assert.doesNotMatch(other, /<details/);
    assert.match(other, /History/);
  }
  const base = render("deal", "active", false, "canon-base");
  assert.doesNotMatch(base, /Deal play sentinel|<details/);
  assert.match(base, /History[\s\S]*Committee sentinel/);
});
