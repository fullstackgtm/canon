/**
 * Formula and rollup fields (CP7c, docs/core-crm-parity.md "CP7. Field
 * builder"): a small expression language over one record's fields, parsed and
 * type-checked when an admin defines the field. Values are never stored: the
 * record service evaluates the checked tree as SQL over the projection when a
 * list or a record page reads it (services/record-service/src/computed.ts), so
 * filters and sorts see it, a related record's change shows as soon as the
 * projector applies it, and `today()` is always today.
 *
 * The language: numbers, "text" or 'text', true and false; field apiNames
 * (`amount`, `custom.renewal_fee`); + - * /; = != < <= > >=; and, or, not;
 * parentheses; and a closed set of functions (FUNCTIONS). A tokenizer and a
 * recursive-descent parser build the tree; nothing is ever run as code.
 *
 * Money: currency fields are stored in cents, but a formula reads and writes
 * them in whole units, so `amount > 50000` means 50,000 of the deal's currency.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { FieldDef, ResolvedObjectDef } from "./registry.ts";

/** What an expression evaluates to. Currency is a number in a formula (see Money above). */
export type ValueType = "number" | "text" | "date" | "datetime" | "checkbox";

/** The type an admin gives a formula or rollup field: how its value is listed, filtered and shown. */
export const COMPUTED_TYPES = ["number", "currency", "text", "date", "datetime", "checkbox"] as const;
export type ComputedType = (typeof COMPUTED_TYPES)[number];

export const ROLLUP_FNS = ["count", "sum", "min", "max", "avg"] as const;
export type RollupFn = (typeof ROLLUP_FNS)[number];

/**
 * A rollup: `fn` over `field` of the `object` records whose lookup `via`
 * points at this record, counting only those its `formula` (a checkbox
 * expression over the related record, "" for all) holds for. Archived and
 * deleted related records are left out.
 */
export type RollupDef = { object: string; via: string; fn: RollupFn; field?: string };

export const FORMULA_MAX = 1000;
export const DEPTH_MAX = 24;
export const ARGS_MAX = 20;
/** Formula and rollup fields per object: each one is evaluated on every list read. */
export const COMPUTED_MAX = 20;

export const FUNCTIONS = ["if", "concat", "daysBetween", "isBlank", "round", "today"] as const;
export type FnName = (typeof FUNCTIONS)[number];

export type BinaryOp = "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

/** A checked expression: every node carries its type. A field node names the field by apiName; `money` marks a currency one. */
export type Expr = { t: ValueType } & (
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "field"; name: string; money: boolean }
  | { k: "neg" | "not"; arg: Expr }
  | { k: "bin"; op: BinaryOp; left: Expr; right: Expr }
  | { k: "call"; fn: FnName; args: Expr[] }
);

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

type Token =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "name"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

const OPS = ["<=", ">=", "!=", "=", "<", ">", "+", "-", "*", "/", "(", ")", ","];
const NAME = /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?/y;
const NUMBER = /(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/y;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const at = i + 1;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        text += src[j++];
      }
      if (j >= src.length) throw new FormulaError(`The text starting at character ${at} has no closing quote`);
      out.push({ k: "str", v: text, at });
      i = j + 1;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num && /[\d.]/.test(ch)) {
      if (!Number.isFinite(Number(num[0]))) throw new FormulaError(`The number at character ${at} is too large`);
      out.push({ k: "num", v: Number(num[0]), at });
      i += num[0].length;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(src);
    if (name) {
      out.push({ k: "name", v: name[0], at });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unexpected ${JSON.stringify(ch)} at character ${at}`);
    out.push({ k: "op", v: op, at });
    i += op.length;
  }
  out.push({ k: "end", at: src.length + 1 });
  return out;
}

const TYPE_NAME: Record<ValueType, string> = { number: "a number", text: "text", date: "a date", datetime: "a date and time", checkbox: "true or false" };

/** The type a field reads as in a formula, or null when a formula cannot use it. */
export function fieldValueType(f: FieldDef): ValueType | null {
  switch (f.type) {
    case "text": case "picklist": case "user": case "lookup": return "text";
    case "number": case "currency": return "number";
    case "date": return "date";
    case "datetime": return "datetime";
    case "checkbox": return "checkbox";
    case "formula": return f.rollup ? valueTypeOf(f.returns) : null;
    default: return null;
  }
}

export const valueTypeOf = (t: ComputedType): ValueType => (t === "currency" ? "number" : t);

const isMoney = (f: FieldDef) => f.type === "currency" || (f.type === "formula" && f.returns === "currency");

/**
 * The fields a formula on `def` may name, by apiName: every field with a
 * readable type that is not archived, rollups included (formulas are not, so a
 * formula never depends on another one).
 */
function referable(def: ResolvedObjectDef, rollups: boolean): Map<string, { t: ValueType; money: boolean }> {
  const out = new Map<string, { t: ValueType; money: boolean }>();
  for (const f of def.fields) {
    if (f.archivedAt !== undefined || (f.type === "formula" && (!rollups || !f.rollup))) continue;
    const t = fieldValueType(f);
    if (t) out.set(f.apiName, { t, money: isMoney(f) });
  }
  return out;
}

class Parser {
  private i = 0;
  private readonly toks: Token[];
  private readonly fields: Map<string, { t: ValueType; money: boolean }>;
  constructor(toks: Token[], fields: Map<string, { t: ValueType; money: boolean }>) {
    this.toks = toks;
    this.fields = fields;
  }
  private peek() { return this.toks[this.i]; }
  private next() { return this.toks[this.i++]; }
  private op() { return (this.next() as { v: string }).v as BinaryOp; }
  private isOp(v: string) { const t = this.peek(); return t.k === "op" && t.v === v; }
  private isWord(v: string) { const t = this.peek(); return t.k === "name" && t.v.toLowerCase() === v; }
  private expect(v: string) {
    const t = this.next();
    if (t.k !== "op" || t.v !== v) throw new FormulaError(`Expected ${v} at character ${t.at}`);
  }

  parse(): Expr {
    const e = this.or(0);
    const t = this.peek();
    if (t.k !== "end") throw new FormulaError(`Unexpected ${describeToken(t)} at character ${t.at}`);
    return e;
  }

  private deep(depth: number) {
    if (depth > DEPTH_MAX) throw new FormulaError(`The formula nests more than ${DEPTH_MAX} levels deep`);
  }

  private or(d: number): Expr {
    let left = this.and(d);
    while (this.isWord("or")) { this.next(); left = logic("or", left, this.and(d)); }
    return left;
  }
  private and(d: number): Expr {
    let left = this.not(d);
    while (this.isWord("and")) { this.next(); left = logic("and", left, this.not(d)); }
    return left;
  }
  private not(d: number): Expr {
    if (this.isWord("not")) {
      this.deep(d + 1);
      this.next();
      const arg = this.not(d + 1);
      if (arg.t !== "checkbox") throw new FormulaError(`not needs true or false, not ${TYPE_NAME[arg.t]}`);
      return { t: "checkbox", k: "not", arg };
    }
    return this.compare(d);
  }
  private compare(d: number): Expr {
    const left = this.sum(d);
    const t = this.peek();
    if (t.k === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.next();
      const right = this.sum(d);
      const op = t.v as BinaryOp;
      if (left.t !== right.t) throw new FormulaError(`"${op}" compares ${TYPE_NAME[left.t]} with ${TYPE_NAME[right.t]}; both sides need the same type`);
      if (left.t === "checkbox" && op !== "=" && op !== "!=") throw new FormulaError(`"${op}" cannot order true and false`);
      return { t: "checkbox", k: "bin", op, left, right };
    }
    return left;
  }
  private sum(d: number): Expr {
    let left = this.product(d);
    while (this.isOp("+") || this.isOp("-")) left = arith(this.op(), left, this.product(d));
    return left;
  }
  private product(d: number): Expr {
    let left = this.unary(d);
    while (this.isOp("*") || this.isOp("/")) left = arith(this.op(), left, this.unary(d));
    return left;
  }
  private unary(d: number): Expr {
    if (this.isOp("-")) {
      this.deep(d + 1);
      this.next();
      const arg = this.unary(d + 1);
      if (arg.t !== "number") throw new FormulaError(`"-" needs a number, not ${TYPE_NAME[arg.t]}`);
      return { t: "number", k: "neg", arg };
    }
    return this.atom(d);
  }
  private atom(d: number): Expr {
    const t = this.next();
    if (t.k === "num") return { t: "number", k: "num", v: t.v };
    if (t.k === "str") return { t: "text", k: "str", v: t.v };
    if (t.k === "op" && t.v === "(") {
      this.deep(d + 1);
      const e = this.or(d + 1);
      this.expect(")");
      return e;
    }
    if (t.k === "name") {
      const lower = t.v.toLowerCase();
      if (this.isOp("(")) return this.call(t.v, t.at, d + 1);
      if (lower === "true" || lower === "false") return { t: "checkbox", k: "bool", v: lower === "true" };
      const field = this.fields.get(t.v);
      if (!field) throw new FormulaError(`No field ${JSON.stringify(t.v)} (character ${t.at}). Name fields by their API name`);
      return { t: field.t, k: "field", name: t.v, money: field.money };
    }
    throw new FormulaError(t.k === "end" ? "The formula ends too soon" : `Unexpected ${describeToken(t)} at character ${t.at}`);
  }
  private call(name: string, at: number, d: number): Expr {
    this.deep(d);
    const fn = FUNCTIONS.find((f) => f.toLowerCase() === name.toLowerCase());
    if (!fn) throw new FormulaError(`No function ${name} (character ${at}). Formulas use ${FUNCTIONS.join(", ")}`);
    this.expect("(");
    const args: Expr[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.or(d));
        if (args.length > ARGS_MAX) throw new FormulaError(`${fn} takes at most ${ARGS_MAX} values`);
        if (!this.isOp(",")) break;
        this.next();
      }
    }
    this.expect(")");
    return checkCall(fn, args);
  }
}

function describeToken(t: Token): string {
  switch (t.k) {
    case "num": return `number ${t.v}`;
    case "str": return "text";
    case "name": return JSON.stringify(t.v);
    case "op": return JSON.stringify(t.v);
    case "end": return "end of the formula";
  }
}

function logic(op: "and" | "or", left: Expr, right: Expr): Expr {
  if (left.t !== "checkbox" || right.t !== "checkbox") throw new FormulaError(`${op} needs true or false on both sides`);
  return { t: "checkbox", k: "bin", op, left, right };
}

function arith(op: BinaryOp, left: Expr, right: Expr): Expr {
  if (left.t !== "number" || right.t !== "number") {
    const hint = left.t === "text" || right.t === "text" ? "; join text with concat()" : left.t !== "number" && right.t !== "number" ? "; use daysBetween() for dates" : "";
    throw new FormulaError(`"${op}" needs numbers, not ${TYPE_NAME[left.t === "number" ? right.t : left.t]}${hint}`);
  }
  return { t: "number", k: "bin", op, left, right };
}

function arity(fn: FnName, args: Expr[], min: number, max = min) {
  if (args.length < min || args.length > max) {
    throw new FormulaError(`${fn} takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? "" : "s"}, not ${args.length}`);
  }
}

function checkCall(fn: FnName, args: Expr[]): Expr {
  switch (fn) {
    case "if": {
      arity(fn, args, 3);
      const [c, a, b] = args;
      if (c.t !== "checkbox") throw new FormulaError(`if needs a true-or-false test first, not ${TYPE_NAME[c.t]}`);
      if (a.t !== b.t) throw new FormulaError(`if gives ${TYPE_NAME[a.t]} one way and ${TYPE_NAME[b.t]} the other; both need the same type`);
      return { t: a.t, k: "call", fn, args };
    }
    case "concat":
      arity(fn, args, 1, ARGS_MAX);
      return { t: "text", k: "call", fn, args };
    case "daysBetween":
      arity(fn, args, 2);
      if (args.some((a) => a.t !== "date" && a.t !== "datetime")) throw new FormulaError("daysBetween takes two dates: daysBetween(start, end) is end minus start in days");
      return { t: "number", k: "call", fn, args };
    case "isBlank":
      arity(fn, args, 1);
      return { t: "checkbox", k: "call", fn, args };
    case "round": {
      arity(fn, args, 1, 2);
      if (args[0].t !== "number") throw new FormulaError(`round needs a number, not ${TYPE_NAME[args[0].t]}`);
      const digits = args[1];
      if (digits && !(digits.k === "num" && Number.isInteger(digits.v) && digits.v >= 0 && digits.v <= 10)) throw new FormulaError("round's second value is a whole number of digits from 0 to 10");
      return { t: "number", k: "call", fn, args };
    }
    case "today":
      arity(fn, args, 0);
      return { t: "date", k: "call", fn, args };
  }
}

/** Parse and type-check an expression over `def`'s fields. Throws FormulaError with a message an admin can act on. */
export function parseFormula(def: ResolvedObjectDef, src: string, opts: { rollups?: boolean } = {}): Expr {
  if (src.length > FORMULA_MAX) throw new FormulaError(`A formula is at most ${FORMULA_MAX} characters`);
  if (!src.trim()) throw new FormulaError("The formula is empty");
  return new Parser(tokenize(src), referable(def, opts.rollups ?? true)).parse();
}

/** Check a formula gives the type its field declares. */
export function checkFormula(def: ResolvedObjectDef, src: string, returns: ComputedType): Expr {
  const expr = parseFormula(def, src);
  if (expr.t !== valueTypeOf(returns)) throw new FormulaError(`This formula gives ${TYPE_NAME[expr.t]}, but the field is ${returns === "currency" ? "a currency amount" : TYPE_NAME[returns]}`);
  return expr;
}

const ROLLUP_FIELD_TYPES: Record<Exclude<RollupFn, "count">, readonly string[]> = {
  sum: ["number", "currency"], avg: ["number", "currency"], min: ["number", "currency", "date", "datetime"], max: ["number", "currency", "date", "datetime"],
};

/**
 * Check a rollup on `object` and give the type its value has. `related` is
 * the definition of the object it reads; `filter` is a checkbox expression
 * over that object's own fields, "" for every record.
 */
export function checkRollup(object: string, rollup: RollupDef, related: ResolvedObjectDef | null, filter: string): ComputedType {
  if (!related || related.archivedAt !== undefined) throw new FormulaError(`No object ${rollup.object} to roll up`);
  const via = related.byFieldId.get(rollup.via as never);
  if (!via || via.type !== "lookup" || via.lookupTo !== object || via.archivedAt !== undefined) {
    throw new FormulaError(`${related.pluralLabel} have no lookup ${rollup.via} pointing here`);
  }
  if (!(ROLLUP_FNS as readonly string[]).includes(rollup.fn)) throw new FormulaError(`${rollup.fn} is not a rollup; use ${ROLLUP_FNS.join(", ")}`);
  if (filter.trim()) {
    const where = parseFormula(related, filter, { rollups: false });
    if (where.t !== "checkbox") throw new FormulaError(`The filter gives ${TYPE_NAME[where.t]}; it needs to be true or false for each ${related.label.toLowerCase()}`);
  }
  if (rollup.fn === "count") {
    if (rollup.field !== undefined) throw new FormulaError("A count takes no field");
    return "number";
  }
  const field = rollup.field === undefined ? undefined : related.byFieldId.get(rollup.field as never);
  if (!field || field.archivedAt !== undefined || field.type === "formula") throw new FormulaError(`A ${rollup.fn} needs a field of ${related.pluralLabel} to read`);
  if (!ROLLUP_FIELD_TYPES[rollup.fn].includes(field.type)) throw new FormulaError(`A ${rollup.fn} cannot read ${field.label}, a ${field.type} field`);
  return rollup.fn === "avg" && field.type === "number" ? "number" : (field.type as ComputedType);
}
