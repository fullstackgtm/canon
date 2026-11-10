import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { pageRows } from "../src/app/dashboard/customization/page-map.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const on = (recipeId: string, recipeTitle: string, key = "page", enabled = true) => ({ recipeId, recipeTitle, key, title: key, enabled, version: "1", hasPlays: false, install: null });
const POINTS = [
  { id: "deal.page", kind: "page", title: "Deal page", description: "", cardinality: "exclusive" as const, contributions: [on("canon-base", "Canon defaults", "page", false), on("fsgtm-enterprise-deal", "Enterprise multi-touch deal")] },
  { id: "account.page", kind: "page", title: "Account page", description: "", cardinality: "exclusive" as const, contributions: [on("canon-base", "Canon defaults")] },
  { id: "templates.reports", kind: "templates", title: "Reports", description: "", cardinality: "additive" as const, contributions: [on("canon-base", "Canon defaults", "pipeline", false), on("canon-base", "Canon defaults", "won")] },
  { id: "workspace.theme", kind: "theme", title: "Theme", description: "", cardinality: "exclusive" as const, contributions: [on("canon-ledger", "Ledger", "theme")] },
];

test("a page is changed when something other than a new workspace's default runs there", () => {
  const { pages, workspace } = pageRows(POINTS);
  const changed = Object.fromEntries(pages.filter((p) => p.applied.length).map((p) => [p.id, p.applied.map((a) => `${a.title}: ${a.by}`)]));
  assert.deepEqual(changed, { deals: ["Deal page: Enterprise multi-touch deal"], reports: ["Reports: 1 of 2 on"] });
  assert.deepEqual(workspace.applied, []);
  assert.equal(pages.find((p) => p.id === "deals")?.offered, 1);
});

test("Applied lists changed pages first and folds the ones Canon ships as is", () => {
  const view = { canEdit: true, available: [], points: POINTS };
  const stubs: Record<string, unknown> = {
    "next/link": { default: ({ children }: { children: ReactNode }) => createElement("a", null, children) },
    "next/navigation": { useRouter: () => ({ push: empty }) },
    "convex/react": { useQuery: (q: string) => (q === "recipes.forOrg" ? view : q === "modules.installed" ? { canEdit: true, modules: [{ moduleId: "@canon/work", enabled: true, nav: null, pages: 0 }, { moduleId: "@fixture/visits", enabled: false, nav: { href: "/dashboard/m/visits", label: "Visits" }, pages: 1 }] } : undefined), useMutation: () => empty, useAction: () => empty },
    "../../../../convex/_generated/api": { api: { recipes: { forOrg: "recipes.forOrg" }, modules: { installed: "modules.installed" }, workspaceRecipes: {}, pipelines: {}, dataModel: {} } },
    "@/components/dashboard": { ViewFrame: ({ title, children }: { title: string; children: ReactNode }) => createElement("div", null, createElement("h1", null, title), children), LoadingRows: empty },
    "@/components/ui/dropdown-menu": { DropdownMenu: empty, DropdownMenuContent: empty, DropdownMenuItem: empty, DropdownMenuTrigger: empty },
    "@/components/ui/sheet": { Sheet: empty, SheetContent: empty, SheetDescription: empty, SheetTitle: empty },
    "@/lib/toast": { toast: {} },
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" "), getErrorMessage: String },
    "./page-map": { pageRows },
    "./point-row": { PointRow: empty },
    "./recipe-github": { GithubConnections: empty },
    "./recipe-modules": { CanonModules: empty, InstallModuleSheet: empty, InstalledModules: empty },
    "./recipe-packages": { InstallSheet: empty, UpgradeSheet: empty, permissionLines: () => [] },
    "./recipe-settings": { RecipeSettingsSheet: empty },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/customization/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)) });
  const html = renderToStaticMarkup(createElement(exports.default!));
  assert.match(html, /<h1>Customization<\/h1>/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Applied</);
  assert.match(html, /<a>Opportunities<\/a><span[^>]*><span[^>]*>Deal page: Enterprise multi-touch deal<\/span>/);
  assert.match(html, /11 pages as Canon ships them/);
  assert.match(html, /Modules on<\/dt><dd[^>]*>1 of 2</);
  assert.match(html, /Pages changed<\/dt><dd[^>]*>2 of 13</);
});

test("module rows and install previews render responses from before Canon imports shipped", () => {
  const installed = { moduleId: "@canon/legacy", title: "Legacy module", version: "0.1.0", source: "canon:legacy", enabled: false, nav: null, links: [], pages: 0, upgrade: null, jobs: null };
  const preview = { id: installed.moduleId, title: installed.title, version: installed.version, source: installed.source, author: "Canon", description: "Legacy preview", pinned: { sha: "a".repeat(64) }, nav: null, links: [], collections: [], reads: [], ops: [], calls: [], server: null, installed: null, upgrade: null, canInstall: true };
  let sheet = false, state = 0;
  const children = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const stubs: Record<string, unknown> = {
    react: { ...require("react"), useState: (initial: unknown) => [sheet && state++ === 2 ? preview : initial, empty] },
    "next/link": { default: children },
    "convex/react": { useQuery: (q: string) => q === "installed" ? { canEdit: true, modules: [installed] } : q === "examples" ? { examples: [] } : null, useMutation: () => empty, useAction: () => empty },
    "../../../../convex/_generated/api": { api: { modules: { installed: "installed", examples: "examples" }, moduleGrants: {} } },
    "@/components/ui/sheet": { Sheet: children, SheetContent: children, SheetDescription: children, SheetTitle: children },
    "@/lib/toast": { toast: {} },
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" "), getErrorMessage: String },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/customization/recipe-modules.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Partial<Pick<typeof import("../src/app/dashboard/customization/recipe-modules"), "InstalledModules" | "InstallModuleSheet">> = {};
  runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
  const row = renderToStaticMarkup(createElement(exports.InstalledModules!, { onInstall: empty, onBrowse: empty }));
  assert.match(row, /Legacy module/);
  assert.match(row, /Turn on/);
  sheet = true;
  const install = renderToStaticMarkup(createElement(exports.InstallModuleSheet!, { initial: "canon:legacy", onClose: empty }));
  assert.match(install, /Legacy preview/);
  assert.match(install, />Install<\/button>/);
});
