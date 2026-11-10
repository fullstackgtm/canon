/**
 * The prompt templates a markdown recipe writes as prose (docs/recipes.md, "Writing a recipe"). Pure: it renders in
 * Convex, the browser and the recipe runtime's isolate alike.
 *
 *   {{path}}  {{helper arg "literal" 4}}  {{#if a && b == "x"}}…{{else}}…{{/if}}  {{#each list}}…{{else}}…{{/each}}
 *   {{> partial path}} includes the partial `partial.<value of path>`.
 *
 * A prompt is paragraphs. A paragraph that renders empty is dropped, and so is a line inside one that renders empty;
 * paragraphs join with one blank line. That one rule stands in for `[...].filter(Boolean).join("\n\n")`. A newline
 * inside an interpolated value is never dropped.
 */
import { LINKEDIN_MAX } from "../convex/lib/plays/drafts.ts";
import { pagesBlock } from "../convex/lib/plays/research.ts";

/** Kernel constants a prompt reads as `{{kernel.NAME}}`. */
export const KERNEL_CONSTANTS = { LINKEDIN_MAX };

type Node =
  | { t: "text"; v: string }
  | { t: "val"; expr: string }
  | { t: "if"; cond: string; then: Node[]; else: Node[] }
  | { t: "each"; path: string; body: Node[]; else: Node[] }
  | { t: "partial"; name: string; arg: string | null };

export type TemplateError = { offset: number; message: string };

/** One paragraph's template as nodes, or the first error with its offset into `src`. */
export function parseTemplate(src: string): { nodes: Node[] } | { error: TemplateError } {
  const root: Node[] = [];
  const stack: Array<{ node: Extract<Node, { t: "if" | "each" }>; inElse: boolean; offset: number }> = [];
  const out = () => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.node.else : top.node.t === "if" ? top.node.then : top.node.body;
  };
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out().push({ t: "text", v: src.slice(last, m.index) });
    last = m.index + m[0].length;
    const tag = m[1].trim();
    if (tag.startsWith("#if ") || tag.startsWith("#each ")) {
      const node = tag.startsWith("#if ") ? { t: "if" as const, cond: tag.slice(4).trim(), then: [], else: [] } : { t: "each" as const, path: tag.slice(6).trim(), body: [], else: [] };
      out().push(node);
      stack.push({ node, inElse: false, offset: m.index });
    } else if (tag === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.inElse) return { error: { offset: m.index, message: "{{else}} outside an {{#if}} or {{#each}}" } };
      top.inElse = true;
    } else if (tag === "/if" || tag === "/each") {
      const top = stack.pop();
      if (!top || `/${top.node.t}` !== tag) return { error: { offset: m.index, message: `${m[0]} closes nothing open` } };
    } else if (tag.startsWith(">")) {
      const [name, arg] = tag.slice(1).trim().split(/\s+/);
      out().push({ t: "partial", name, arg: arg ?? null });
    } else if (tag.startsWith("#") || tag.startsWith("/")) {
      return { error: { offset: m.index, message: `unknown block ${m[0]}` } };
    } else {
      out().push({ t: "val", expr: tag });
    }
  }
  if (stack.length) return { error: { offset: stack[stack.length - 1].offset, message: `{{#${stack[stack.length - 1].node.t}}} is never closed in this paragraph` } };
  if (last < src.length) out().push({ t: "text", v: src.slice(last) });
  return { nodes: root };
}

/** The helpers and partials a template calls: what validation checks against what exists. */
export function templateRefs(nodes: readonly Node[]): { helpers: string[]; partials: string[] } {
  const helpers: string[] = [], partials: string[] = [];
  const walk = (ns: readonly Node[]) => {
    for (const n of ns) {
      if (n.t === "val") { const [head, ...rest] = tokens(n.expr); if (rest.length || ZERO_ARITY.has(head)) helpers.push(head); }
      else if (n.t === "partial") partials.push(n.name);
      else if (n.t === "if") { walk(n.then); walk(n.else); }
      else if (n.t === "each") { walk(n.body); walk(n.else); }
    }
  };
  walk(nodes);
  return { helpers, partials };
}

// A newline inside a value: kept through the line-dropping pass.
const NL = "\u0001";
type Scope = Array<Record<string, unknown>>;
type Helper = (...args: unknown[]) => unknown;

const trimmed = (x: unknown) => (typeof x === "string" ? x.trim() : x == null ? "" : String(x));
/** What `{{name arg …}}` may call. */
export const HELPERS: Readonly<Record<string, Helper>> = {
  /** The first argument that isn't blank, trimmed. */
  or: (...xs) => xs.map(trimmed).find((x) => x !== "") ?? "",
  /** `a`, or `b` when `a` is null or missing. */
  default: (a, b) => a ?? b,
  minus: (a, b) => Number(a) - Number(b),
  nl: () => "\n",
  pagesBlock: (pages) => pagesBlock(pages as never),
};
const ZERO_ARITY = new Set(["nl"]);

const tokens = (expr: string): string[] => expr.match(/"[^"]*"|\S+/g) ?? [];

function lookup(scope: Scope, path: string): unknown {
  if (path === "this") return scope[scope.length - 1].this;
  const [head, ...rest] = path.split(".");
  let at: unknown;
  for (let i = scope.length - 1; i >= 0; i--) if (Object.hasOwn(scope[i], head)) { at = scope[i][head]; break; }
  for (const k of rest) at = at && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined;
  return at;
}
function arg(scope: Scope, tok: string): unknown {
  if (/^".*"$/.test(tok)) return tok.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
  return lookup(scope, tok);
}
const truthy = (x: unknown) => (Array.isArray(x) ? x.length > 0 : Boolean(x));
function test(scope: Scope, cond: string): boolean {
  return cond.split("&&").every((term) => {
    const t = term.trim();
    const cmp = t.match(/^(\S+)\s*(==|!=)\s*(\S+)$/);
    if (cmp) {
      const same = arg(scope, cmp[1]) === arg(scope, cmp[3]);
      return cmp[2] === "==" ? same : !same;
    }
    return t.startsWith("!") ? !truthy(lookup(scope, t.slice(1))) : truthy(lookup(scope, t));
  });
}
const show = (x: unknown) => (x == null ? "" : String(x)).replace(/\n/g, NL);

/** Each prompt and partial by id, as its paragraphs' sources. */
export type Templates = Readonly<Record<string, readonly string[]>>;

function renderNodes(nodes: readonly Node[], scope: Scope, templates: Templates): string {
  let s = "";
  for (const n of nodes) {
    if (n.t === "text") s += n.v;
    else if (n.t === "val") {
      const [head, ...rest] = tokens(n.expr);
      const helper = Object.hasOwn(HELPERS, head) ? HELPERS[head] : undefined;
      s += show(helper && (rest.length || ZERO_ARITY.has(head)) ? helper(...rest.map((t) => arg(scope, t))) : lookup(scope, n.expr));
    } else if (n.t === "if") s += renderNodes(test(scope, n.cond) ? n.then : n.else, scope, templates);
    else if (n.t === "each") {
      const list = lookup(scope, n.path);
      const items = Array.isArray(list) ? list : [];
      s += items.length
        ? items.map((item, i) => renderNodes(n.body, [...scope, { ...(item && typeof item === "object" ? item : {}), this: item, "@index": i }], templates)).join("\n")
        : renderNodes(n.else, scope, templates);
    } else {
      const key = n.arg ? `${n.name}.${String(lookup(scope, n.arg))}` : n.name;
      s += Object.hasOwn(templates, key) ? render(templates, key, scope[0]).replace(/\n/g, NL) : "";
    }
  }
  return s;
}

/** Prompt `id` rendered against `vars`. */
export function render(templates: Templates, id: string, vars: Record<string, unknown>): string {
  const paragraphs = templates[id];
  if (!paragraphs) throw new Error(`no prompt ${id}`);
  const out: string[] = [];
  for (const src of paragraphs) {
    const parsed = parseTemplate(src);
    if ("error" in parsed) throw new Error(`${id}: ${parsed.error.message}`);
    const text = renderNodes(parsed.nodes, [vars], templates).split("\n").filter((line) => line.trim() !== "").join("\n").replaceAll(NL, "\n");
    if (text) out.push(text);
  }
  return out.join("\n\n");
}
