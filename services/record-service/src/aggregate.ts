// Reports (CP9, contract 1.27.0): one object's records grouped and measured
// where they live. The request is validated by the shared report semantics
// (src/core/objects/reportSpec.ts), which the Convex fake evaluates in memory;
// this file is their SQL.
//
// The object's rows are read as its list reads them (objectSource), so a
// report filters, and groups on formula, rollup and custom fields, exactly as
// a list view does. A group key on a related record joins that object's own
// source by id. One GROUPING SETS query answers the groups, the subtotals (every
// key but the last) and the total in a single scan; QUALIFY keeps the first GROUPS_MAX of each.
import type { DuckDBConnection } from "@duckdb/node-api";
import { fieldColumn, ListRequestError, type ListColumn, type Scalar } from "./core/objects/listSpec.ts";
import {
  ACTIVITY_OBJECT, activityReportDef, compileAggregateRequest, CONTACT_COMPANY_VIA, GROUPS_MAX, relationsOf, type AggregateGroup, type AggregateResponse, type CompiledAggregate, type CompiledGroup,
} from "./core/objects/reportSpec.ts";
import type { ActivityAggregateRequest } from "./core/objects/moduleReport.ts";
import { moduleActivitySelects } from "./moduleDocs.ts";
import { all } from "./db.ts";
import { HttpError } from "./errors.ts";
import { ident } from "./projection.ts";
import { activitySource, objectSource, scopeSql, Sql, type ObjectSource } from "./projectionQuery.ts";
import { SHARDS, throughOf } from "./projector.ts";
import type { Workspace } from "./workspace.ts";

const emptyResponse = (measures: number): Omit<AggregateResponse, "projectedThrough"> =>
  ({ groups: [], subtotals: [], total: Array.from({ length: measures }, () => null), rows: 0, truncated: false });

/** A group key's SQL over its column: the value, or the first day of its bucket as YYYY-MM-DD. */
function keySql(g: CompiledGroup, col: string): string {
  if (g.kind === "value") return col;
  const day = g.kind === "day" ? `CAST(${col} AS DATE)` : `CAST(epoch_ms(CAST(${col} AS BIGINT)) AS DATE)`;
  return `strftime(date_trunc('${g.bucket}', ${day}), '%Y-%m-%d')`;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function aggregateObject(w: Workspace | null, object: string, req: ActivityAggregateRequest): Promise<AggregateResponse> {
  if (req.moduleActivities !== undefined && object !== ACTIVITY_OBJECT) throw new HttpError(400, "module activity sources belong only to Activities reports");
  if (!w && req.moduleActivities?.length) throw new HttpError(503, "Activity report projections are initializing. Try again shortly.");
  if (!w) return { ...emptyResponse(req.measures.length), projectedThrough: Object.fromEntries(Array.from({ length: SHARDS }, (_, s) => [String(s), 0])) };
  return w.snapshot((c) => aggregateIn(c, object, req));
}

async function aggregateIn(c: DuckDBConnection, object: string, req: ActivityAggregateRequest): Promise<AggregateResponse> {
  const through = await throughOf(c);
  let base = await objectSource(c, object);
  const union = !!req.moduleActivities?.length;
  if (!base && !union) return { ...emptyResponse(req.measures.length), projectedThrough: through };
  const sources = new Map<string, ObjectSource | null>([[object, base]]);
  const def = base?.def ?? activityReportDef();
  const relations = new Map(relationsOf(object, def).map((r) => [r.via, r.object]));
  for (const g of req.groupBy ?? []) {
    const target = g.via === undefined ? undefined : relations.get(g.via);
    if (target && !sources.has(target)) sources.set(target, await objectSource(c, target));
  }
  let q;
  try {
    q = compileAggregateRequest(object, def, req, (o) => sources.get(o)?.def);
  } catch (e) {
    if (e instanceof ListRequestError) throw new HttpError(400, e.message);
    throw e;
  }
  const sql = new Sql();
  if (union) {
    const parts: string[] = [];
    if (base) {
      const admits = q.scope ? ` AND ${scopeSql(sql, q.scope, base.colSql)}` : "";
      parts.push(`SELECT to_json(list_value('ledger', id)) AS id, status, title, created_at, updated_at, ${ident(fieldColumn("ownerId"))}, ${ident(fieldColumn("type"))} FROM ${base.from} WHERE ${base.live}${admits}`);
    }
    parts.push(...await moduleActivitySelects(c, req.moduleActivities!, sql));
    base = activitySource(parts);
    q = { ...q, scope: null };
  }
  const result = await aggregateCompiled(c, q, base!, sources, sql, through);
  return { ...result, ...(union ? { moduleActivities: req.moduleActivities } : {}) };
}

/**
 * A compiled report over `base`, a source of rows (an object's, or a module collection's docs: moduleDocs.ts), with
 * the related objects its keys read in `sources`. `sql` holds the parameters `base.from` already bound.
 */
export async function aggregateCompiled(
  c: DuckDBConnection, q: CompiledAggregate, base: ObjectSource, sources: ReadonlyMap<string, ObjectSource | null>, sql: Sql, through: AggregateResponse["projectedThrough"],
): Promise<AggregateResponse> {
  const inner: string[] = [];
  const joins: string[] = [];
  q.groups.forEach((g, i) => {
    if (!g.via) {
      inner.push(`${keySql(g, base.colSql(g.col))} AS ${ident(`k${i}`)}`);
      return;
    }
    const target = sources.get(g.object)!;
    const viaSql = g.via.col === CONTACT_COMPANY_VIA ? `nullif(${ident("accountId")}, '')` : base.colSql(g.via.col as ListColumn);
    inner.push(`${viaSql} AS ${ident(`j${i}`)}`);
    const r = ident(`r${i}`);
    joins.push(` LEFT JOIN (SELECT id AS rid, ${keySql(g, target.colSql(g.col))} AS v FROM ${target.from} WHERE ${target.live}) ${r} ON ${r}.rid = b.${ident(`j${i}`)}`);
  });
  q.measures.forEach((m, i) => {
    if (m.col) inner.push(`${m.weight ? `${base.colSql(m.col)} * ${base.colSql(m.weight)}` : base.colSql(m.col)} AS ${ident(`m${i}`)}`);
  });
  // A report counts only the records its caller may see (CP14): the scope a list of the object applies.
  const where = [base.live, ...q.filters.map((f) => base.filterOf(sql, f)), ...(q.scope ? [scopeSql(sql, q.scope, base.colSql)] : [])].join(" AND ");
  const keyCols = q.groups.map((g, i) => (g.via ? `${ident(`r${i}`)}.v` : `b.${ident(`k${i}`)}`) + ` AS ${ident(`k${i}`)}`);
  const measureCols = q.measures.map((m, i) => (m.col ? `b.${ident(`m${i}`)} AS ${ident(`m${i}`)}` : null)).filter(Boolean);
  const rowsSql = `SELECT ${["1 AS one", ...keyCols, ...measureCols].join(", ")} FROM (SELECT ${["1 AS one", ...inner].join(", ")} FROM ${base.from} WHERE ${where}) b${joins.join("")}`;
  const keys = q.groups.map((_, i) => ident(`k${i}`));
  const values = q.measures.map((m, i) => `${m.fn === "count" ? "count(*)" : `${m.fn}(${ident(`m${i}`)})`} AS ${ident(`v${i}`)}`);
  const sets = keys.length > 1 ? `GROUPING SETS ((${keys.join(", ")}), (${keys.slice(0, -1).join(", ")}), ())` : keys.length === 1 ? `GROUPING SETS ((${keys[0]}), ())` : "GROUPING SETS (())";
  const level = keys.length ? `GROUPING(${keys.join(", ")})` : "0";
  const order = keys.length ? keys.map((k) => `${k} NULLS LAST`).join(", ") : "1";
  const out = await all(c,
    `SELECT ${[...keys, ...values, `${level} AS lvl`, "count(*) AS n"].join(", ")} FROM (${rowsSql}) t GROUP BY ${sets}`
    + ` QUALIFY row_number() OVER (PARTITION BY ${level} ORDER BY ${order}) <= ${GROUPS_MAX + 1} ORDER BY ${order}`,
    sql.params);
  // GROUPING(k0, ..., kn) is 0 for a leaf, 1 for a subtotal (only the last key rolled up) and all ones for the total.
  const full = keys.length ? (1 << keys.length) - 1 : 0;
  const groupOf = (r: Record<string, unknown>, n: number): AggregateGroup => ({
    keys: Array.from({ length: n }, (_, i) => (r[`k${i}`] ?? null) as Scalar | null),
    values: q.measures.map((_, i) => num(r[`v${i}`])),
  });
  const leaves = out.filter((r) => keys.length && Number(r.lvl) === 0);
  const subs = out.filter((r) => keys.length > 1 && Number(r.lvl) === 1);
  const total = out.find((r) => Number(r.lvl) === full);
  return {
    groups: leaves.slice(0, GROUPS_MAX).map((r) => groupOf(r, keys.length)),
    subtotals: subs.slice(0, GROUPS_MAX).map((r) => groupOf(r, keys.length - 1)),
    total: total ? groupOf(total, 0).values : emptyResponse(q.measures.length).total.map((_, i) => (q.measures[i].fn === "count" ? 0 : null)),
    rows: total ? Number(total.n) : 0,
    truncated: leaves.length > GROUPS_MAX || subs.length > GROUPS_MAX,
    projectedThrough: through,
  };
}
