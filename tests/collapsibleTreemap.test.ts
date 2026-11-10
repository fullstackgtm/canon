import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/tam/collapsible-treemap.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});

function mount(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }) {
  let collapsed = false;
  let effect = () => {};
  const exports: { CollapsibleTreemap?: (props: { children: string }) => ReactElement } = {};
  runInNewContext(outputText, {
    exports,
    window: { localStorage: storage },
    require: (id: string) => id === "react" ? {
      useState: () => [collapsed, (next: boolean) => { collapsed = next; }],
      useEffect: (next: () => void) => { effect = next; },
    } : require(id),
  });
  const render = () => exports.CollapsibleTreemap!({ children: "Treemap content" });
  const html = () => renderToStaticMarkup(render());
  const click = () => {
    const tree = render() as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    tree.props.children[0].props.onClick();
  };
  render();
  return { html, click, hydrate: () => effect() };
}

test("treemap toggles accessibly and remembers both choices across remounts", () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  let view = mount(storage);
  assert.match(view.html(), /aria-expanded="true"/);
  view.hydrate();
  assert.match(view.html(), /Treemap content/);
  view.click();
  assert.match(view.html(), /aria-expanded="false" aria-controls="accounts-treemap"/);
  assert.match(view.html(), /id="accounts-treemap" hidden/);
  assert.doesNotMatch(view.html(), /Treemap content/);
  view = mount(storage);
  assert.match(view.html(), /aria-expanded="true"/, "initial render matches SSR before reading storage");
  view.hydrate();
  assert.match(view.html(), /aria-expanded="false"/);
  view.click();
  assert.match(view.html(), /Treemap content/);
  view = mount(storage);
  view.hydrate();
  assert.match(view.html(), /aria-expanded="true"/);
});

test("unavailable storage does not prevent collapsing or expanding", () => {
  const view = mount({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  view.hydrate();
  view.click();
  assert.match(view.html(), /aria-expanded="false"/);
  view.click();
  assert.match(view.html(), /Treemap content/);
});
