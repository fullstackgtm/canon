import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as recipes from "../recipes/index.ts";
import { scopeOf } from "../recipes/actions.ts";
import { parseCondition } from "../recipes/conditions.ts";
import { parseRecipe } from "../recipes/md/parse.ts";

const require = createRequire(import.meta.url);
const base = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
const lineOf = (text: string, needle: string, from = 0) => text.split("\n").findIndex((l, i) => i >= from && l.includes(needle)) + 1;

// Customize mode is off: no shape context, so sections draw unwrapped.
const NO_SHAPE = { useShape: () => null, ShapeSection: ({ children }: { children: ReactNode }) => children };
const sections: { PageSections?: ComponentType<Record<string, unknown>> } = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/components/records/page-sections.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: sections, require: (id: string) => (id === "../../../recipes" ? recipes : id === "./shape/shape-mode" ? NO_SHAPE : require(id)) });

/** The page drawn with each component as its name, a held section inside its holder, and the two columns as [ | ]. */
function drawn(object: recipes.PageObject, page: recipes.PageSpec): string {
  const renderers = Object.fromEntries(recipes.COMPONENTS[object].map((c) => [c, (_: unknown, { held }: { held?: ReactNode }) => createElement("i", null, c, held ? createElement("b", null, held) : null)]));
  return renderToStaticMarkup(createElement(sections.PageSections!, { object, page, stage: null, renderers }))
    .replace(/<div class="grid grid-cols-\[minmax\(0,1fr\)\] gap-6[^"]*">/g, "[").replace(/<div class="grid grid-cols-\[minmax\(0,1fr\)\] content-start gap-6">/g, "|")
    .replace(/<\/?(div|i)[^>]*>/g, " ").replace(/<\/?b>/g, (t) => (t === "<b>" ? "(" : ")")).replace(/\s+/g, " ").trim();
}

test("the account and contact pages draw canon-base's sections in its order, and in a recipe's new order once moved", () => {
  const account = recipes.RECIPES["canon-base"].accountPage;
  assert.equal(drawn("account", account), "header( fitBar ) [ fields | whyFit( scoreHistory ) timeline topSignals history companyDeals peopleAcrossDeals related");
  assert.equal(drawn("contact", recipes.RECIPES["canon-base"].contactPage), "header [ fields | aiFields related callPanel composeEmail timeline history");
  const moved = [account[0], account[1], account.find((s) => s.component === "related")!, ...account.slice(2).filter((s) => s.component !== "related")];
  assert.equal(drawn("account", moved), "header( fitBar ) related [ fields | whyFit( scoreHistory ) timeline topSignals history companyDeals peopleAcrossDeals");
});

test("a component or an action host the page's object doesn't have is refused at its line", () => {
  const contactAt = base.indexOf("# Contact {page=contact}");
  const broken = base.slice(0, contactAt) + base.slice(contactAt)
    .replace("## AI fields {section=aiFields}", "## Fit {section=whyFit}")
    .replace("runs: kernel.findPhone", "runs: kernel.setStatus");
  const contactLine = lineOf(base, "# Contact {page=contact}");
  const errors = parseRecipe(broken).problems.filter((p) => p.level === "error").map((p) => ({ line: p.line, level: p.level }));
  assert.deepEqual(errors, [
    { line: lineOf(broken, "runs: kernel.setStatus", contactLine), level: "error" },
    { line: lineOf(broken, "## Fit {section=whyFit}"), level: "error" },
  ].sort((a, b) => a.line - b.line));
});

test("a contact's actions read the contact page's scope, and the page offers each as its conditions hold", () => {
  const scope = scopeOf("kernel.findEmail", "header", "contact");
  assert.deepEqual(["contact.email && canEdit", "row.primary", 'stage == "in"'].map((c) => parseCondition(c, scope).ok), [true, false, false]);
  const header = recipes.RECIPES["canon-base"].contactPage.find((s) => s.component === "header")!.actions!;
  const shown = (ctx: recipes.Context) => recipes.offered(header, "header", ["kernel.findEmail", "kernel.findPhone", "kernel.merge", "kernel.restore"], ctx, {}, "contact").map((o) => o.label);
  const contact = { canEdit: true, canDelete: true, deleted: false, "contact.company": true };
  assert.deepEqual(shown({ ...contact, "contact.email": true }), ["Find phone", "Merge with…"]);
  assert.deepEqual(shown({ ...contact, canEdit: false, deleted: true }), ["Restore"]);
});
