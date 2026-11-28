import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isCustomObjectName } from "../modules/kernel/reportLanguage.ts";
const require = createRequire(import.meta.url);
test("workspace route draws loading, not found and an enabled page through the shared renderers", () => {
  let spec: unknown;
  let workflow: unknown = null;
  const exports: { default?: React.ComponentType<any> } = {};
  const stubs: Record<string, unknown> = {
    "../../../../../modules/kernel/reportLanguage": { isCustomObjectName },
    "@/components/customize/customize-mode": { useCustomizeMode: () => ({ workflow }) },
    "../../../../../recipes/md/parse": { parseRecipe: () => ({ recipe: { meta: { title: "Draft" }, workspacePages: [{ slug: "open-deals", title: "Draft page", sections: [{ component: "metric", title: "Draft metric" }] }] } }) },
    react: { ...React, use: () => ({ slug: "open-deals" }) },
    "convex/react": { useQuery: (ref: unknown) => ref === "page" ? spec : undefined },
    "../../../../../convex/_generated/api": { api: { recipes: { workspacePage: "page" }, workspaceRecipes: { markdown: "markdown" } } },
    "@/components/records/shape/shape-mode": { useShapeMode: ({ base }: any) => ({ page: base, provider: (children: React.ReactNode) => children }) },
    "@/components/records/data-section": { dataRenderers: () => ({ metric: () => React.createElement("p", null, "12") }) },
    "@/components/records/page-sections": { PageSections: ({ page, renderers }: any) => page.map((s: any) => React.createElement("section", { key: s.title }, s.title, renderers[s.component](s))) },
  };
  runInNewContext(ts.transpileModule(readFileSync("src/app/dashboard/p/[slug]/page.tsx", "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (id: string) => stubs[id] ?? require(id) });
  const render = () => renderToStaticMarkup(React.createElement(exports.default!, { params: Promise.resolve({ slug: "open-deals" }) }));
  assert.match(render(), /Loading page/);
  spec = null; assert.match(render(), /Page not found/);
  spec = { title: "Open deals", recipeId: "recipe", sections: [{ component: "metric", title: "Pipeline" }] };
  assert.match(render(), /Open deals.*Pipeline.*12/);
  spec = null;
  workflow = { targets: [{ target: "open-deals", recipeId: "recipe", markdown: "draft" }] };
  assert.match(render(), /Draft page.*Draft metric.*12/);
});
