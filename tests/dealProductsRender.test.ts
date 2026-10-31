import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as lineItems from "../convex/lib/objects/lineItems.ts";
import * as utils from "../src/lib/utils.ts";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/components/records/deal-products.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;

function products(currency: string, editing = false) {
  let index = 0;
  let submitted: Record<string, unknown> | undefined;
  let submit: ((e: { preventDefault: () => void }) => void) | undefined;
  const empty = () => {};
  const runtime = require("react/jsx-runtime");
  const draft = [{ key: "new", productId: "product", quantity: "1", unitPrice: "1200.00", totalPrice: "1200.00" }];
  const stubs: Record<string, unknown> = {
    react: { useEffect: empty, useState: (initial: unknown) => [index++ === 0 && editing ? draft : initial, empty] },
    "react/jsx-runtime": { ...runtime, jsxs: (type: unknown, props: Record<string, unknown>, key: unknown) => {
      if (type === "form") submit = props.onSubmit as typeof submit;
      return runtime.jsxs(type, props, key);
    } },
    "next/link": { default: empty },
    "convex/react": { useQuery: () => ({ editable: true, total: 100000, lines: [{ id: "line", version: 1, productId: "product", quantity: 1, unitPrice: 100000, totalPrice: 100000, name: "Training" }] }), useAction: () => empty, useMutation: () => async (args: Record<string, unknown>) => { submitted = args; return null; } },
    "../../../convex/_generated/api": { api: { dealLineItems: {}, objects: {} } },
    "../../../convex/lib/objects/lineItems": lineItems,
    "@/lib/utils": utils, "@/lib/toast": { toast: { success: empty, error: empty } },
    "./list-view": {}, "./record-parts": {},
  };
  const exports: { DealProducts?: ComponentType<Record<string, unknown>> } = {};
  runInNewContext(code, { exports, require: (id: string) => { assert.ok(Object.hasOwn(stubs, id), id); return stubs[id]; } });
  const html = renderToStaticMarkup(createElement(exports.DealProducts!, { deal: "deal", version: 1, amount: 100000, currency, active: true, canEditAmount: true }));
  return { html, save: () => { assert.ok(submit); submit({ preventDefault: empty }); return submitted; } };
}

test("Products uses Canon hundredths for JPY and KWD display and edits", () => {
  assert.match(products("JPY").html, /¥1,000/);
  assert.doesNotMatch(products("JPY").html, /100,000/);
  assert.match(products("KWD").html, /1,000\.000/);
  for (const currency of ["USD", "JPY", "KWD"]) {
    const saved = products(currency, true).save()!;
    assert.deepEqual(JSON.parse(JSON.stringify(saved.lines)), [{ productId: "product", quantity: 1, unitPrice: 120000, totalPrice: 120000 }]);
  }
});

test("Products retains the shared USD fallback for malformed CRM currencies", () => {
  assert.match(products("US$").html, /\$1,000\.00/);
});
