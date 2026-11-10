// Formula and rollup fields (CP7c, contract 1.26.0; src/core/objects/formula.ts).
// Their values are never stored: a list query computes them from the
// projection as it reads, so they filter and sort like any column, a related
// record's change shows once the projector has applied it, and `today()` is
// the day the list is read. A definition change takes effect on the next read.
//
// A formula's checked tree is compiled to a SQL expression: literals are
// quoted with lit(), fields go through the caller's column mapping, and the
// operators and functions are a fixed table. Nothing an admin typed reaches
// the SQL except as a quoted literal. A rollup is a LEFT JOIN onto an
// aggregate of the related object's projection, grouped by its lookup.
import { FormulaError, parseFormula, type ComputedType, type Expr } from "./core/objects/formula.ts";
import { fieldColumn, listColumns, type ListColumn } from "./core/objects/listSpec.ts";
import type { FieldDef, ResolvedObjectDef } from "./core/objects/registry.ts";
import { lit } from "./db.ts";
import { ident, viewName, type Column } from "./projection.ts";

/** The computed columns of a list query: SELECT items (`, expr AS "c_<fieldId>"`), the joins they read, and their typed columns. */
export type Computed = { cols: Column[]; select: string; joins: string };

type ComputedField = Extract<FieldDef, { type: "formula" }>;

const SQL_TYPE: Record<ComputedType, string> = { number: "DOUBLE", currency: "DOUBLE", text: "VARCHAR", date: "DATE", datetime: "BIGINT", checkbox: "BOOLEAN" };

/** A formula or rollup field a list computes: live ones only. */
export const isComputedField = (f: FieldDef): f is ComputedField => f.type === "formula" && f.archivedAt === undefined;

/** A formula over a record, as SQL; `ref` gives the SQL of a field by apiName. */
export function formulaSql(e: Expr, ref: (name: string) => string): string {
  const s = (x: Expr) => formulaSql(x, ref);
  switch (e.k) {
    case "num": return `CAST(${String(e.v)} AS DOUBLE)`;
    case "str": return lit(e.v);
    case "bool": return e.v ? "TRUE" : "FALSE";
    // Money is stored in cents and read in whole units.
    case "field": return e.money ? `(${ref(e.name)} / 100.0)` : ref(e.name);
    case "neg": return `(-${s(e.arg)})`;
    case "not": return `(NOT ${s(e.arg)})`;
    case "bin":
      switch (e.op) {
        case "/": return `(${s(e.left)} / nullif(${s(e.right)}, 0))`;
        case "!=": return `(${s(e.left)} <> ${s(e.right)})`;
        case "and": return `(${s(e.left)} AND ${s(e.right)})`;
        case "or": return `(${s(e.left)} OR ${s(e.right)})`;
        default: return `(${s(e.left)} ${e.op} ${s(e.right)})`;
      }
    case "call": {
      const a = e.args;
      switch (e.fn) {
        case "if": return `(CASE WHEN ${s(a[0])} THEN ${s(a[1])} ELSE ${s(a[2])} END)`;
        case "concat": return `concat(${a.map((x) => textOf(x, s(x))).join(", ")})`;
        case "daysBetween": return `CAST(date_diff('day', ${dayOf(a[0], s(a[0]))}, ${dayOf(a[1], s(a[1]))}) AS DOUBLE)`;
        case "isBlank": return a[0].t === "text" ? `(${s(a[0])} IS NULL OR ${s(a[0])} = '')` : `(${s(a[0])} IS NULL)`;
        case "round": return `round(${s(a[0])}, ${a[1] && a[1].k === "num" ? a[1].v : 0})`;
        case "today": return "current_date";
      }
    }
  }
}

const dayOf = (e: Expr, sql: string) => (e.t === "datetime" ? `CAST(to_timestamp(${sql} / 1000.0) AS DATE)` : sql);

/** A value as concat() writes it: whole numbers without a decimal point, dates as YYYY-MM-DD, checkboxes as true or false. */
function textOf(e: Expr, sql: string): string {
  switch (e.t) {
    case "text": return sql;
    case "number": return `(CASE WHEN ${sql} = round(${sql}) AND abs(${sql}) < 1e15 THEN CAST(CAST(${sql} AS BIGINT) AS VARCHAR) ELSE CAST(round(${sql}, 6) AS VARCHAR) END)`;
    case "date": return `CAST(${sql} AS VARCHAR)`;
    case "datetime": return `CAST(to_timestamp(${sql} / 1000.0) AS VARCHAR)`;
    case "checkbox": return `(CASE WHEN ${sql} THEN 'true' WHEN NOT ${sql} THEN 'false' END)`;
  }
}

/** A formula's value as its field's type: currency back to cents. TRY_CAST, so one odd row reads empty instead of failing the list. */
const typed = (returns: ComputedType, sql: string) => `TRY_CAST(${returns === "currency" ? `round(${sql} * 100)` : sql} AS ${SQL_TYPE[returns]})`;

/**
 * The computed columns of `def` for a list over rows aliased `base`.
 * `defs` gives the projected definition of another object (a rollup's
 * source), `colSql` the SQL of one of `def`'s own columns. A field whose
 * definition no longer checks (a field it names was archived since) reads as
 * empty.
 */
export function computedColumns(def: ResolvedObjectDef, defs: (object: string) => ResolvedObjectDef | undefined, base: string, colSql: (col: ListColumn) => string): Computed {
  const fields = def.fields.filter(isComputedField);
  if (!fields.length) return { cols: [], select: "", joins: "" };
  const own = listColumns(def);
  const rollups = new Map<string, string>();
  const joins: string[] = [];
  for (const f of fields.filter((x) => x.rollup)) rollups.set(f.apiName, rollupSql(f, defs, base, joins));
  const ref = (name: string) => {
    const rolled = rollups.get(name);
    if (rolled !== undefined) return rolled;
    const col = own.get(name);
    if (!col) throw new FormulaError(`No field ${name}`);
    return colSql(col);
  };
  const select = fields.map((f) => {
    let sql: string;
    if (f.rollup) sql = rollups.get(f.apiName)!;
    else {
      try {
        sql = typed(f.returns, formulaSql(parseFormula(def, f.formula), ref));
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e;
        sql = "NULL";
      }
    }
    return `, ${sql} AS ${ident(fieldColumn(f.fieldId))}`;
  }).join("");
  return { cols: fields.map((f) => ({ name: fieldColumn(f.fieldId), fieldId: f.fieldId, type: f.returns })), select, joins: joins.join("") };
}

/** A rollup's value: a join onto its source's aggregate per lookup value. A count or sum of nothing is 0; a min, max or average of nothing is empty. */
function rollupSql(f: ComputedField, defs: (object: string) => ResolvedObjectDef | undefined, base: string, joins: string[]): string {
  const r = f.rollup!;
  const zero = r.fn === "count" || r.fn === "sum";
  const empty = zero ? "CAST(0 AS DOUBLE)" : "NULL";
  const related = defs(r.object);
  const via = related?.byFieldId.get(r.via as never);
  const field = r.field === undefined ? undefined : related?.byFieldId.get(r.field as never);
  // Columns by the related projection's own mapping: a system field such as createdAt reads `created_at`, not `c_createdAt`.
  const cols = related ? listColumns(related) : new Map<string, ListColumn>();
  const viaCol = via && cols.get(via.apiName);
  const fieldCol = field && cols.get(field.apiName);
  if (!related || !viaCol || via.type !== "lookup" || (r.fn !== "count" && !fieldCol)) return `TRY_CAST(${empty} AS ${SQL_TYPE[f.returns]})`;
  let where = "";
  if (f.formula.trim()) {
    try {
      where = ` AND ${formulaSql(parseFormula(related, f.formula, { rollups: false }), (name) => {
        const col = cols.get(name);
        if (!col) throw new FormulaError(`No field ${name}`);
        return `r.${ident(col.column)}`;
      })}`;
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      return `TRY_CAST(NULL AS ${SQL_TYPE[f.returns]})`;
    }
  }
  const alias = ident(`ru_${joins.length}`);
  const value = r.fn === "count" ? "count(*)" : `${r.fn}(r.${ident(fieldCol!.column)})`;
  const k = `r.${ident(viaCol.column)}`;
  joins.push(` LEFT JOIN (SELECT ${k} AS k, ${value} AS v FROM ${ident(viewName(r.object))} r`
    + ` WHERE r.status = 'active' AND ${k} IS NOT NULL${where} GROUP BY 1) ${alias} ON ${alias}.k = ${base}.id`);
  return `TRY_CAST(${zero ? `coalesce(${alias}.v, 0)` : `${alias}.v`} AS ${SQL_TYPE[f.returns]})`;
}
