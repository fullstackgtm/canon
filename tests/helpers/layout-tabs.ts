import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ElementType } from "react";

const require = createRequire(import.meta.url);
const loaded = new Map<string, Record<string, ElementType>>();
function ui(name: string): Record<string, ElementType> {
  const exports = {};
  loaded.set(name, exports);
  const code = ts.transpileModule(readFileSync(new URL(`../../src/components/ui/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, Event, require: (id: string) => {
    if (id.startsWith("@/components/ui/")) return loaded.get(id.slice("@/components/ui/".length)) ?? ui(id.slice("@/components/ui/".length));
    if (id === "@/lib/utils") return { cn: (...args: unknown[]) => args.filter(Boolean).join(" ") };
    return require(id);
  } });
  return exports;
}
export const tabs = ui("tabs");
