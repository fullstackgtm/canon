import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function load() {
  const source = readFileSync(new URL("../src/components/research/run-flow.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
  const exports: { runNodes?: (title: string, traces: unknown[]) => Array<{ id: string; parent?: string; title: string; tone?: string; action?: string }> } = {};
  runInNewContext(outputText, { exports, URL, require: (id: string) => (id === "@/components/flow/flow-canvas" ? { FlowCanvas: () => null, FlowRows: () => null } : require(id)) });
  return exports.runNodes!;
}

test("a research run draws each record's searches and reads in order, ending in its outcome", () => {
  const nodes = load()("Tech stack", [
    { id: "t1", label: "Acme", status: "answered", value: "Salesforce", quote: "We run on Salesforce", ms: 4200, calls: 3, model: "gpt", steps: [
      { kind: "model", action: "search" }, { kind: "search", query: "acme crm", pages: 5 }, { kind: "read", url: "https://www.acme.com/jobs", ok: true },
    ] },
    { id: "t2", label: "Globex", status: "error", ms: 900, calls: 1, model: "gpt", steps: [{ kind: "read", url: "https://globex.com", ok: false }] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(nodes.map((n) => [n.id, n.parent ?? null, n.title, n.tone]))), [
    ["run", null, "Tech stack", "active"],
    ["t1", "run", "Acme", "done"],
    ["t1:1", "t1", "acme crm", "done"],
    ["t1:2", "t1:1", "acme.com", "done"],
    ["t1:outcome", "t1:2", "Answered", "done"],
    ["t2", "run", "Globex", "failed"],
    ["t2:0", "t2", "globex.com", "failed"],
    ["t2:outcome", "t2:0", "Failed", "failed"],
  ]);
});
