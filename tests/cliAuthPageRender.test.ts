import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("CLI pairing puts its heading in the view frame and keeps the pairing form and tokens", () => {
  const stubs: Record<string, unknown> = {
    "next/navigation": { useSearchParams: () => new URLSearchParams() },
    "convex/react": {
      useMutation: () => () => {},
      useQuery: (query: string) => query === "list" ? [{
        _id: "token", userName: "Test user", createdAt: 1, lastUsedAt: null, revokedAt: null,
      }] : null,
    },
    "../../../../convex/_generated/api": { api: { cliAuth: { list: "list", revoke: "revoke", describe: "describe", approve: "approve" } } },
    "@/components/dashboard": { ViewFrame: ({ title, children }: { title: string; children?: ReactNode }) => createElement("section", null, createElement("h1", null, title), children) },
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../src/app/dashboard/cli-auth/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: () => ReactNode } = {};
  runInNewContext(outputText, { exports, require: (id: string) => Object.hasOwn(stubs, id) ? stubs[id] : require(id) });
  const html = renderToStaticMarkup(createElement(exports.default!));
  assert.match(html, /^<section><h1>CLI Pairing<\/h1><div class="space-y-6">/, "preserve spacing between page sections");
  assert.match(html, /<form/);
  assert.match(html, /Test user/);
});
