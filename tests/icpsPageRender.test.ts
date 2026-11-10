import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { treeMoveError } from "../modules/kernel/icpTreeMove.ts";

const require = createRequire(import.meta.url);
const empty = () => null;
const childrenOnly = ({ children }: { children?: ReactNode }) => children;

function render(canEdit: boolean) {
  const stubs: Record<string, unknown> = {
    "next/link": { default: childrenOnly }, "next/navigation": { useRouter: () => ({}) },
    "convex/react": {
      useAction: () => empty, useMutation: () => empty,
      useQuery: (fn: string) => fn === "tree" ? {
        canEdit,
        icps: [{ _id: "icp", name: "Main ICP", query: "", active: true }],
        nodes: [
          { _id: "s", icpId: "icp", kind: "segment", name: "SaaS", query: "" },
          { _id: "p", icpId: "icp", parentId: "s", kind: "persona", name: "Buyer", query: "level:manager" },
        ],
      } : null,
    },
    "../../../../convex/_generated/api": { api: { icpTree: { list: "tree" }, icps: {}, icpActions: {}, researchAgents: {}, audiences: {} } },
    "../../../../modules/kernel/icpQuery": { parseQuery: () => ({ errors: [], query: {} }) },
    "../../../../modules/kernel/icpTreeMove": { treeMoveError },
    "@/components/records/object-labels": { useObjectLabels: () => (o: string) => ({ label: o, pluralLabel: o === "contact" ? "People" : o === "account" ? "Accounts" : `${o}s` }) },
    "@/components/dashboard": { ViewFrame: ({ title, secondaryActions, children }: { title: string; secondaryActions?: ReactNode; children: ReactNode }) => createElement("div", null, createElement("h1", null, title), secondaryActions, children), LoadingRows: empty },
    "@/components/crm/add-records-dialog": { AddRecordsDialog: empty },
    "@/components/crm/icp-fields": { label: "" },
    "@/components/icps/icp-map": { IcpMap: empty },
    "@/components/icps/icp-sentence": { IcpSentence: empty },
    "@/components/icps/icp-viewer": { IcpViewer: empty },
    "@/components/icps/winners-check": { WinnersCheck: empty },
    "@/components/icps/market-sources": { MarketSources: empty },
    "@/components/icps/map-my-market": { MapMyMarket: empty },
    "@/components/ui/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogHeader", "DialogTitle"].map((key) => [key, childrenOnly])),
    "@/components/ui/dropdown-menu": Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuSeparator", "DropdownMenuTrigger"].map((key) => [key, childrenOnly])),
    "@/components/ui/switch": { Switch: empty },
    "../../../../modules/kernel/icpSentence": { sentence: empty, sentenceText: () => "" },
    "@/lib/toast": {},
    "@/lib/url-state": { useUrlState: (defaults: unknown) => [defaults, empty] },
    "@/lib/utils": { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/icps/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    if (Object.hasOwn(stubs, id)) return stubs[id];
    assert.ok(["react", "react/jsx-runtime", "lucide-react"].includes(id), id);
    return require(id);
  } });
  return renderToStaticMarkup(createElement(exports.default!));
}

test("editable ICP trees show child ghost rows and accessible move destinations", () => {
  const html = render(true);
  for (const parent of ["Main ICP", "SaaS"]) {
    for (const kind of ["segment", "persona"]) assert.ok(html.includes(`aria-label="Add ${kind} under ${parent}"`));
  }
  assert.ok(!html.includes('aria-label="Add segment under Buyer"'));
  assert.ok(html.includes('draggable="true"'));
  assert.ok(html.includes("Move to Main ICP"));
  assert.ok(!html.includes("Move to Buyer"));
  assert.ok(html.indexOf('aria-label="Persona name"') < html.indexOf('aria-label="Add segment under SaaS"'), "ghost rows follow children");
});

test("read-only ICP trees expose neither ghost rows nor drag handles", () => {
  const html = render(false);
  assert.ok(!html.includes('aria-label="Add segment under'));
  assert.ok(!html.includes('draggable="true"'));
  assert.ok(!html.includes("Move to Main ICP"));
});
