import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const empty = () => null;

function render(loaded: boolean) {
  const stubs: Record<string, unknown> = {
    "next/link": { default: empty },
    "convex/react": {
      useQuery: () => loaded ? { agents: [], canCreate: true } : undefined,
      useMutation: () => empty,
    },
    "../../../../convex/_generated/api": { api: { agentTurns: { list: "list", create: "create" }, researchAgents: { list: "fields" }, automations: { workspace: "rules" } } },
    "@/components/dashboard": {
      ViewFrame: ({ title, children }: { title: string; children?: ReactNode }) => createElement("section", null, createElement("h1", null, title), children),
      EmptyState: () => createElement("div", null, "No agents yet"),
      LoadingRows: () => createElement("div", null, "Loading rows"),
    },
    "@/components/agents/agent-owner-line": { AgentOwnerLine: empty },
    "@/components/ui/dialog": { Dialog: empty, DialogContent: empty, DialogDescription: empty, DialogTitle: empty },
    "@/components/ui/select": { SelectField: empty },
    "@/lib/utils": { getErrorMessage: String },
    "@/lib/toast": { toast: { error: empty } },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/agents/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
  return renderToStaticMarkup(createElement(exports.default!));
}

test("agents page puts its heading in the shared view frame while loading and loaded", () => {
  for (const loaded of [false, true]) {
    const html = render(loaded);
    assert.match(html, /^<section><h1>Agents<\/h1>/);
    assert.ok(html.includes(loaded ? "No agents yet" : "Loading rows"));
  }
});
