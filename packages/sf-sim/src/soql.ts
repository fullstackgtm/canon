// A SOQL subset: SELECT fields | COUNT() FROM obj [WHERE cond] [ORDER BY f [ASC|DESC]] [LIMIT n] [OFFSET n].
// Conditions: = != <> < > <= >= LIKE IN NOT IN, joined by AND / OR (AND binds tighter),
// with parentheses. Values: 'str', numbers, true/false, null, date and datetime literals.
import { toMs } from "./util.ts";

export class SoqlError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

type Value = string | number | boolean | null | { literal: string };
type Cond =
  | { kind: "cmp"; field: string; op: string; value: Value | Value[] }
  | { kind: "and" | "or"; parts: Cond[] };

export type Query = {
  count: boolean;
  fields: string[];
  object: string;
  where?: Cond;
  orderBy?: { field: string; dir: "ASC" | "DESC" };
  limit?: number;
  offset?: number;
};

function tokenize(q: string): string[] {
  const re = /\s*('(?:[^'\\]|\\.)*'|<=|>=|!=|<>|[(),=<>]|[A-Za-z0-9_.:+\-]+)/gy;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(q))) {
    out.push(m[1]);
    last = re.lastIndex;
  }
  if (q.slice(last).trim()) throw new SoqlError("MALFORMED_QUERY", `unexpected token near: ${q.slice(last, last + 20)}`);
  return out;
}

export function parseSoql(q: string): Query {
  const t = tokenize(q.trim());
  let i = 0;
  const peek = () => t[i];
  const kw = (w: string) => peek()?.toUpperCase() === w;
  const expect = (w: string) => {
    if (!kw(w)) throw new SoqlError("MALFORMED_QUERY", `expected ${w} near ${peek() ?? "end"}`);
    i++;
  };
  expect("SELECT");
  const fields: string[] = [];
  let count = false;
  if (kw("COUNT") && t[i + 1] === "(" && t[i + 2] === ")") {
    count = true;
    i += 3;
  } else {
    for (;;) {
      const f = t[i++];
      if (!f || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f)) throw new SoqlError("MALFORMED_QUERY", `unsupported select item: ${f}`);
      fields.push(f);
      if (peek() !== ",") break;
      i++;
    }
  }
  expect("FROM");
  const object = t[i++];
  if (!object) throw new SoqlError("MALFORMED_QUERY", "missing object");
  const query: Query = { count, fields, object };

  const value = (): Value => {
    const v = t[i++];
    if (v === undefined) throw new SoqlError("MALFORMED_QUERY", "missing value");
    if (v.startsWith("'")) return v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
    if (/^null$/i.test(v)) return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { literal: v };
    throw new SoqlError("MALFORMED_QUERY", `unsupported value: ${v}`);
  };
  const cmp = (): Cond => {
    if (peek() === "(") {
      i++;
      const c = or();
      if (t[i++] !== ")") throw new SoqlError("MALFORMED_QUERY", "missing )");
      return c;
    }
    const field = t[i++];
    let op = t[i++]?.toUpperCase();
    if (op === "NOT" && kw("IN")) (i++, (op = "NOT IN"));
    if (op === "IN" || op === "NOT IN") {
      if (t[i++] !== "(") throw new SoqlError("MALFORMED_QUERY", "expected ( after IN");
      const vals: Value[] = [];
      for (;;) {
        vals.push(value());
        const sep = t[i++];
        if (sep === ")") break;
        if (sep !== ",") throw new SoqlError("MALFORMED_QUERY", "expected , or )");
      }
      return { kind: "cmp", field, op, value: vals };
    }
    if (!["=", "!=", "<>", "<", ">", "<=", ">=", "LIKE"].includes(op ?? "")) throw new SoqlError("MALFORMED_QUERY", `unsupported operator: ${op}`);
    return { kind: "cmp", field, op: op === "<>" ? "!=" : op!, value: value() };
  };
  const and = (): Cond => {
    const parts = [cmp()];
    while (kw("AND")) (i++, parts.push(cmp()));
    return parts.length === 1 ? parts[0] : { kind: "and", parts };
  };
  const or = (): Cond => {
    const parts = [and()];
    while (kw("OR")) (i++, parts.push(and()));
    return parts.length === 1 ? parts[0] : { kind: "or", parts };
  };
  if (kw("WHERE")) {
    i++;
    query.where = or();
  }
  if (kw("ORDER")) {
    i++;
    expect("BY");
    const field = t[i++];
    let dir: "ASC" | "DESC" = "ASC";
    if (kw("ASC") || kw("DESC")) dir = t[i++].toUpperCase() as "ASC" | "DESC";
    query.orderBy = { field, dir };
  }
  if (kw("LIMIT")) (i++, (query.limit = Number(t[i++])));
  if (kw("OFFSET")) (i++, (query.offset = Number(t[i++])));
  if (i < t.length) throw new SoqlError("MALFORMED_QUERY", `unexpected token: ${t[i]}`);
  return query;
}

function cmpValues(a: unknown, b: Value): number | null {
  if (a === null || a === undefined || b === null) return null;
  if (typeof b === "object") {
    const x = toMs(String(a));
    const y = toMs(b.literal.length === 10 ? `${b.literal}T00:00:00Z` : b.literal);
    return Number.isNaN(x) || Number.isNaN(y) ? null : x - y;
  }
  if (typeof b === "number") return Number(a) - b;
  if (typeof b === "boolean") return a === b ? 0 : 1;
  const s = String(a);
  // Salesforce string comparison is case-insensitive.
  return s.toLowerCase() < b.toLowerCase() ? -1 : s.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

function test(rec: Record<string, unknown>, c: Cond, fieldOk: (f: string) => string): boolean {
  if (c.kind !== "cmp") return c.kind === "and" ? c.parts.every((p) => test(rec, p, fieldOk)) : c.parts.some((p) => test(rec, p, fieldOk));
  const v = rec[fieldOk(c.field)];
  switch (c.op) {
    case "=":
      return c.value === null ? v === null || v === undefined : cmpValues(v, c.value as Value) === 0;
    case "!=":
      return c.value === null ? !(v === null || v === undefined) : cmpValues(v, c.value as Value) !== 0;
    case "<": { const r = cmpValues(v, c.value as Value); return r !== null && r < 0; }
    case ">": { const r = cmpValues(v, c.value as Value); return r !== null && r > 0; }
    case "<=": { const r = cmpValues(v, c.value as Value); return r !== null && r <= 0; }
    case ">=": { const r = cmpValues(v, c.value as Value); return r !== null && r >= 0; }
    case "LIKE": {
      const pat = String(c.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", ".");
      return v != null && new RegExp(`^${pat}$`, "is").test(String(v));
    }
    case "IN":
      return (c.value as Value[]).some((x) => cmpValues(v, x) === 0);
    case "NOT IN":
      return !(c.value as Value[]).some((x) => cmpValues(v, x) === 0);
  }
  return false;
}

/**
 * Run a parsed query over records. `canonical(f)` maps a (case-insensitive)
 * field name to its canonical name or throws INVALID_FIELD.
 */
export function runQuery(q: Query, records: Iterable<Record<string, unknown>>, canonical: (f: string) => string) {
  const fields = q.fields.map(canonical);
  if (q.orderBy) q.orderBy.field = canonical(q.orderBy.field);
  let rows: Record<string, unknown>[] = [];
  for (const r of records) if (!q.where || test(r, q.where, canonical)) rows.push(r);
  if (q.orderBy) {
    const { field, dir } = q.orderBy;
    const sgn = dir === "DESC" ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[field], y = b[field];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sgn;
    });
  }
  const total = rows.length;
  if (q.offset) rows = rows.slice(q.offset);
  if (q.limit !== undefined) rows = rows.slice(0, q.limit);
  return { total, fields, rows };
}
