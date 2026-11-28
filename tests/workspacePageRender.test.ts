import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
test("workspace route draws loading, not found and an enabled page through the shared renderers", () => {
  let spec: unknown;
  const exports: { default?: React.ComponentType<any> } = {};
  const stubs: Record<string, unknown> = {
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
});
