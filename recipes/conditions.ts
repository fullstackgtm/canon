/**
 * The conditions an action's `shows:` and `enabled:` lines are written in (docs/recipes.md, "Conditions"): names from a
 * typed scope, numbers, quoted strings, true, false, comparisons, `!`, `&&`, `||` and parentheses. A condition is
 * parsed and type-checked against its scope when a recipe is built or installed, and evaluated in the browser by a
 * walk over its tree. Nothing is ever run as code, and a name is only ever read from the context's own keys.
 */

export type VarType = { kind: "bool" } | { kind: "number" } | { kind: "enum"; values: readonly string[] };
/** The names a condition may read, and what each holds. */
export type Scope = Readonly<Record<string, VarType>>;
export type Value = boolean | number | string;
/** The values a condition reads. A name the context lacks reads as false, 0 or "". */
export type Context = Readonly<Record<string, Value>>;

type Compare = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type Condition =
  | { op: "var"; name: string }
  | { op: "lit"; value: Value }
  | { op: "not"; arg: Condition }
  | { op: "and" | "or"; left: Condition; right: Condition }
  | { op: Compare; left: Condition; right: Condition };

const MAX_LENGTH = 400;
const MAX_DEPTH = 24;
const TOKEN = /\s*(?:(-?\d+(?:\.\d+)?)(?![\w.])|"([^"\\]*)"|'([^'\\]*)'|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)|(&&|\|\||==|!=|<=|>=|<|>|!|\(|\)))/y;

type Token = ({ kind: "num"; value: number } | { kind: "str"; value: string } | { kind: "name"; value: string } | { kind: "op"; value: string }) & { at: number };

/** A problem at a character offset in the condition. */
class At extends Error {
  at: number;
  constructor(message: string, at: number) { super(message); this.at = at; }
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) {
      if (!text.slice(at).trim()) break;
      throw new At(`can't read "${text.slice(at).trim().slice(0, 20)}": a condition uses names, numbers, "strings", ==, !=, <, >, !, && and ||`, at + (text.slice(at).length - text.slice(at).trimStart().length));
    }
    const start = TOKEN.lastIndex - m[0].trimStart().length;
    if (m[1] !== undefined) out.push({ kind: "num", value: Number(m[1]), at: start });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: "str", value: m[2] ?? m[3], at: start });
    else if (m[4] !== undefined) out.push({ kind: "name", value: m[4], at: start });
    else out.push({ kind: "op", value: m[5], at: start });
  }
  return out;
}

type Typed = { node: Condition; type: "bool" | "number" | "string"; enumOf?: readonly string[] };

/** `text` as a condition over `scope`, or why it isn't one and the 1-based column it is about. */
export function parseCondition(text: string, scope: Scope): { ok: true; condition: Condition } | { ok: false; error: string; column: number } {
  let ts: Token[] = [];
  let i = 0;
  try {
    if (text.length > MAX_LENGTH) throw new Error(`a condition is at most ${MAX_LENGTH} characters`);
    ts = tokens(text);
    if (!ts.length) throw new Error("the condition is empty");
    const peek = (v: string) => ts[i]?.kind === "op" && ts[i].value === v;
    const bool = (t: Typed, what: string): Condition => {
      if (t.type !== "bool") throw new Error(`${what} is a ${t.type === "string" ? "string" : t.type}; compare it, like ${describe(t.node)} == …`);
      return t.node;
    };
    const or = (depth: number): Typed => {
      if (depth > MAX_DEPTH) throw new Error("the condition nests too deeply");
      let left = and(depth);
      while (peek("||")) { i++; const right = and(depth); left = { node: { op: "or", left: bool(left, describe(left.node)), right: bool(right, describe(right.node)) }, type: "bool" }; }
      return left;
    };
    const and = (depth: number): Typed => {
      let left = not(depth);
      while (peek("&&")) { i++; const right = not(depth); left = { node: { op: "and", left: bool(left, describe(left.node)), right: bool(right, describe(right.node)) }, type: "bool" }; }
      return left;
    };
    const not = (depth: number): Typed => {
      if (peek("!")) { i++; const arg = not(depth + 1); return { node: { op: "not", arg: bool(arg, describe(arg.node)) }, type: "bool" }; }
      return compare(depth);
    };
    const compare = (depth: number): Typed => {
      const left = atom(depth);
      const t = ts[i];
      if (t?.kind !== "op" || !["==", "!=", "<", "<=", ">", ">="].includes(t.value)) return left;
      i++;
      const op = t.value as Compare;
      const right = atom(depth);
      if (left.type !== right.type) throw new At(`${describe(left.node)} is a ${left.type} and ${describe(right.node)} is a ${right.type}, so ${op} can't compare them`, t.at);
      if (op !== "==" && op !== "!=" && left.type !== "number") throw new At(`${op} compares numbers, and ${describe(left.node)} is a ${left.type}`, t.at);
      for (const [a, b] of [[left, right], [right, left]]) {
        if (a.enumOf && b.node.op === "lit" && !a.enumOf.includes(String(b.node.value))) throw new At(`${describe(a.node)} is one of ${a.enumOf.map((v) => `"${v}"`).join(", ")}, never "${b.node.value}"`, t.at);
      }
      return { node: { op, left: left.node, right: right.node }, type: "bool" };
    };
    const atom = (depth: number): Typed => {
      const t = ts[i++];
      if (!t) throw new At("the condition ends too soon", text.length);
      if (t.kind === "num") return { node: { op: "lit", value: t.value }, type: "number" };
      if (t.kind === "str") return { node: { op: "lit", value: t.value }, type: "string" };
      if (t.kind === "name") {
        if (t.value === "true" || t.value === "false") return { node: { op: "lit", value: t.value === "true" }, type: "bool" };
        if (ts[i]?.kind === "op" && ts[i].value === "(") throw new At(`${t.value}(…): a condition can't call anything`, t.at);
        const v = Object.hasOwn(scope, t.value) ? scope[t.value] : undefined;
        if (!v) throw new At(`${t.value} is not something this action can read (${Object.keys(scope).join(", ")})`, t.at);
        return v.kind === "enum" ? { node: { op: "var", name: t.value }, type: "string", enumOf: v.values } : { node: { op: "var", name: t.value }, type: v.kind };
      }
      if (t.value === "(") {
        const inner = or(depth + 1);
        if (!peek(")")) throw new At("a ( is never closed", t.at);
        i++;
        return inner;
      }
      throw new At(`${t.value} can't start a value`, t.at);
    };
    const top = or(0);
    if (i < ts.length) throw new At(`unexpected ${ts[i].kind === "str" ? `"${ts[i].value}"` : ts[i].value}`, ts[i].at);
    return { ok: true, condition: bool(top, describe(top.node)) };
  } catch (e) {
    const at = e instanceof At ? e.at : (ts[Math.min(i, ts.length) - 1]?.at ?? 0);
    return { ok: false, error: e instanceof Error ? e.message : String(e), column: at + 1 };
  }
}

function describe(c: Condition): string {
  return c.op === "var" ? c.name : c.op === "lit" ? JSON.stringify(c.value) : "the expression";
}

const read = (ctx: Context, name: string): Value => (Object.hasOwn(ctx, name) ? ctx[name] : false);

function value(c: Condition, ctx: Context): Value {
  switch (c.op) {
    case "var": return read(ctx, c.name);
    case "lit": return c.value;
    case "not": return !truthy(c.arg, ctx);
    case "and": return truthy(c.left, ctx) && truthy(c.right, ctx);
    case "or": return truthy(c.left, ctx) || truthy(c.right, ctx);
    case "==": return value(c.left, ctx) === value(c.right, ctx);
    case "!=": return value(c.left, ctx) !== value(c.right, ctx);
    case "<": return Number(value(c.left, ctx)) < Number(value(c.right, ctx));
    case "<=": return Number(value(c.left, ctx)) <= Number(value(c.right, ctx));
    case ">": return Number(value(c.left, ctx)) > Number(value(c.right, ctx));
    case ">=": return Number(value(c.left, ctx)) >= Number(value(c.right, ctx));
  }
}

const truthy = (c: Condition, ctx: Context): boolean => value(c, ctx) === true;

/** Whether `condition` holds in `ctx`. */
export const holds = (condition: Condition, ctx: Context): boolean => truthy(condition, ctx);
