import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(new URL("../src/components/records/record-boundary.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
type Boundary = { state: { failed: boolean }; render(): ReactNode };
const exports: { RecordBoundary?: { new (props: { onClose: () => void; children: ReactNode }): Boundary; getDerivedStateFromError(): { failed: boolean } } } = {};
runInNewContext(outputText, { exports, require: (id: string) => {
  assert.ok(["react", "react/jsx-runtime"].includes(id), `Unexpected dependency: ${id}`);
  return require(id);
} });

function buttons(node: ReactNode, out = new Map<string, ReactElement<{ onClick: () => void }>>()) {
  if (Array.isArray(node)) node.forEach((child) => buttons(child, out));
  else if (isValidElement<{ children?: ReactNode; onClick: () => void }>(node)) {
    if (node.type === "button") out.set(renderToStaticMarkup(createElement("span", null, node.props.children)).replace(/<\/?span>/g, ""), node);
    else buttons(node.props.children, out);
  }
  return out;
}

test("the record boundary renders a closeable alert after a render failure", () => {
  const { RecordBoundary } = exports;
  let closed = 0;
  const boundary = new RecordBoundary!({ onClose: () => closed++, children: createElement("p", null, "Record body") });
  assert.match(renderToStaticMarkup(boundary.render()), /Record body/);

  boundary.state = RecordBoundary!.getDerivedStateFromError();
  const fallback = boundary.render();
  const html = renderToStaticMarkup(fallback);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /Record body/);
  buttons(fallback).get("Close")!.props.onClick();
  assert.equal(closed, 1);
});
