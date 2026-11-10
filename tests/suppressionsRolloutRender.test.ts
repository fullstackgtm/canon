import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anyApi, getFunctionName } from "convex/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function render(available: boolean, admin = true) {
  const queries: string[] = [];
  const writes: string[] = [];
  function load(path: string): Record<string, ComponentType<any>> {
    const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
    const exports = {};
    runInNewContext(outputText, { exports, require: (id: string) => {
      if (id.endsWith("convex/_generated/api")) return { api: anyApi };
      if (id === "@/hooks/use-suppressions-available") return load("src/hooks/use-suppressions-available.ts");
      if (id === "convex/react") return {
        useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
          if (args === "skip") return undefined;
          const name = getFunctionName(ref);
          queries.push(name);
          if (name === "permissions:mine") return { role: admin ? "admin" : "rep", preview: null };
          if (name === "organizations:context") return { organization: { currentUserRole: admin ? "admin" : "rep" }, ...(available ? { features: { suppressions: true } } : {}) };
          assert.ok(available && admin, `Unsupported backend query ${name}`);
          assert.equal(name, "suppressions:list");
          return { page: [{ _id: "rule", value: "sam@example.test", kind: "email", source: "manual", state: "active", reason: "Asked us to stop" }], isDone: true, continueCursor: "end" };
        },
        useMutation: (ref: Parameters<typeof getFunctionName>[0]) => () => { writes.push(getFunctionName(ref)); return Promise.resolve(); },
      };
      if (id.endsWith("convex/lib/suppressions/domain")) return { SUPPRESSION_KINDS: ["email", "domain", "phone", "linkedin"], SUPPRESSION_SOURCES: ["unsubscribe", "reply", "bounce", "manual", "dnc"] };
      if (id === "@/lib/utils") return { getErrorMessage: String };
      if (id === "@/lib/toast") return { toast: {} };
      assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected dependency ${id}`);
      return require(id);
    } });
    return exports;
  }
  const { SuppressionsSection } = load("src/app/dashboard/settings/suppressions-section.tsx");
  return { html: renderToStaticMarkup(createElement(SuppressionsSection)), queries, writes };
}

test("the actual Settings section tolerates an old backend and waits for optional suppression support", () => {
  const old = render(false);
  assert.equal(old.html, "");
  assert.deepEqual(old.queries, ["organizations:context", "permissions:mine"]);
  assert.deepEqual(old.writes, []);
  assert.equal(render(true, false).html, "");
  const current = render(true);
  assert.match(current.html, /Do not contact/);
  assert.match(current.html, /sam@example.test/);
  assert.match(current.html, /Lift this cause/);
  assert.deepEqual(current.writes, []);
});
