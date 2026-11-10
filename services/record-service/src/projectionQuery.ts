// List views and title search over the projector's p_<object> tables. Requests
// are validated by the shared list semantics (src/core/objects/listSpec.ts),
// which the Convex fake evaluates in memory; this file is their SQL.
//
// - Keyset pagination on (sort column, id) with a null-phase bit: rows whose
//   sort cell is empty come after all others, in id order.
// - The total is counted on page 1 and carried in the cursor.
// - A filter on `id` becomes a MATERIALIZED CTE, so DuckDB looks the keys up
//   instead of rewriting the query into a full scan (scale-spike/cp0).
// - A request reads the build definitions, the cursors and the rows in one
//   snapshot, so a rebuild that swaps a view mid-request cannot pair one
//   build's columns with another build's table.
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import {
  cellOf, compileListRequest, compileSearch, encodeCursor, fieldColumn, isRegisterObject, ListRequestError, rankSearchHits, registerColumn, registerCustomKey, registerListDef,
  registerListRow, SEARCH_DETAIL, type CompiledFilter, type CompiledList, type CompiledScope, type ListColumn, type ListRequest, type ListResponse, type ListRow,
  type RegisterListResponse, type RegisterObject, type Scalar, type SearchHit, type SearchRequest, type SearchResponse,
} from "./core/objects/listSpec.ts";
import { ASSOCIATION_OBJECT, resolveObjectDef, STANDARD_OBJECTS, type ResolvedObjectDef } from "./core/objects/registry.ts";
import { computedColumns } from "./computed.ts";
import { ACTIVITY_TYPES, activityReportDef } from "./core/objects/reportSpec.ts";
import { ACTIVITY_OBJECT } from "./core/kernel/reportLanguage.ts";
import { all, lit } from "./db.ts";
import { HttpError } from "./errors.ts";
import { ident, selectList, viewName, type Column } from "./projection.ts";
import { buildsOf, SHARDS, throughOf } from "./projector.ts";
import type { Workspace } from "./workspace.ts";

export class Sql {
  readonly params: Record<string, DuckDBValue> = {};
  private n = 0;
  param(v: Scalar): string {
    const key = `p${this.n++}`;
    this.params[key] = v;
    return `$${key}`;
  }
  /** A parameter typed like the column it is compared with. */
  value(col: ListColumn, v: Scalar): string {
    return col.kind === "date" ? `CAST(${this.param(v)} AS DATE)` : this.param(v);
  }
}

/** The SQL a list column reads: a `p_<object>` column unless a register list says otherwise. */
export type ColumnSql = (col: ListColumn) => string;
const projectedColumn: ColumnSql = (col) => ident(col.column);

export function filterSql(sql: Sql, f: CompiledFilter, colSql: ColumnSql = projectedColumn): string {
  const c = colSql(f.col);
  switch (f.op) {
    case "empty": return `${c} IS NULL`;
    case "notEmpty": return `${c} IS NOT NULL`;
    case "eq": return `${c} = ${sql.value(f.col, f.value)}`;
    case "neq": return `${c} IS DISTINCT FROM ${sql.value(f.col, f.value)}`;
    case "gt": return `${c} > ${sql.value(f.col, f.value)}`;
    case "gte": return `${c} >= ${sql.value(f.col, f.value)}`;
    case "lt": return `${c} < ${sql.value(f.col, f.value)}`;
    case "lte": return `${c} <= ${sql.value(f.col, f.value)}`;
    case "contains": return `contains(lower(${c}), ${sql.param(f.value)})`;
    case "startsWith": return `starts_with(lower(${c}), ${sql.param(f.value)})`;
    case "in": return `${c} IN (${f.values.map((v) => sql.value(f.col, v)).join(", ")})`;
    case "hasAny": return `list_has_any(${c}, [${f.values.map((v) => sql.param(v)).join(", ")}]::VARCHAR[])`;
    case "hasAll": return `list_has_all(${c}, [${f.values.map((v) => sql.param(v)).join(", ")}]::VARCHAR[])`;
  }
}

/**
 * A visibility scope (CP14, 1.29.0) as SQL: the owner is one of the scope's
 * owners, or empty when it admits unowned records. No owners and no unowned
 * records is FALSE: the caller sees none of the object.
 */
export function scopeSql(sql: Sql, s: CompiledScope, colSql: ColumnSql = projectedColumn): string {
  return ownerSql(sql, `nullif(${colSql(s.col)}, '')`, s);
}

/** Whether the owner in `col` (SQL, empty read as NULL) is inside a scope's owners, or empty when it admits unowned ones. */
function ownerSql(sql: Sql, col: string, s: { owners: readonly string[]; unowned: boolean }): string {
  // A long list (an id scope names up to 5,000 deals) is one escaped literal list in a semi-join, which DuckDB hashes;
  // as thousands of bound parameters it is compared one by one.
  const owned = !s.owners.length ? "FALSE"
    : s.owners.length > 50 ? `${col} IN (SELECT unnest([${s.owners.map(lit).join(", ")}]::VARCHAR[]))`
    : `${col} IN (${s.owners.map((o) => sql.param(o)).join(", ")})`;
  return s.unowned ? `(${owned} OR ${col} IS NULL)` : `coalesce(${owned}, FALSE)`;
}

function keysetSql(sql: Sql, q: CompiledList, colSql: ColumnSql = projectedColumn): string | null {
  const cur = q.cursor;
  if (!cur) return null;
  const s = colSql(q.sort.col);
  const after = sql.param(cur.id);
  if (cur.nulls || cur.value === null) return `(${s} IS NULL AND id > ${after})`;
  const v = sql.value(q.sort.col, cur.value);
  return `((${s} IS NOT NULL AND (${s} ${q.sort.dir === "asc" ? ">" : "<"} ${v} OR (${s} = ${v} AND id > ${after}))) OR ${s} IS NULL)`;
}

function rowOf(r: Record<string, unknown>, object: string, cols: readonly Column[]): ListRow {
  return {
    id: String(r.id),
    object,
    version: Number(r.version),
    status: r.status as ListRow["status"],
    title: String(r.title),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
    values: Object.fromEntries(cols.map((c) => [c.fieldId, (c.type === "splits" && typeof r[c.name] === "string" ? JSON.parse(r[c.name] as string) : r[c.name] ?? null) as ListRow["values"][string]])),
  };
}

const emptyThrough = () => Object.fromEntries(Array.from({ length: SHARDS }, (_, s) => [String(s), 0]));

export async function listProjected(w: Workspace | null, object: string, req: ListRequest): Promise<ListResponse> {
  if (!w) return { rows: [], nextCursor: null, total: 0, projectedThrough: emptyThrough() };
  return w.snapshot((c) => listIn(c, object, req));
}

type Builds = Awaited<ReturnType<typeof buildsOf>>;
type Build = NonNullable<ReturnType<Builds["get"]>>;

/** Formula and rollup fields (CP7c): computed over the rows the query reads, so filters, sorts and keysets see them. */
function projectedComputed(build: Build, builds: Builds) {
  const computed = computedColumns(build.def, (o) => builds.get(o)?.def, "b", (col) => `b.${ident(col.column)}`);
  const withComputed = (from: string) => (computed.cols.length ? `(SELECT b.*${computed.select} FROM ${from} b${computed.joins}) b` : from);
  return { withComputed, cols: [...build.cols, ...computed.cols] };
}

/**
 * What a query over one object's records reads, as its list reads them: the
 * rows as a FROM item, the SQL of a list column over them, a filter's SQL, and
 * the predicate for live (not deleted) rows. Reports aggregate over it.
 */
export type ObjectSource = { def: ResolvedObjectDef; from: string; colSql: ColumnSql; filterOf: (sql: Sql, f: CompiledFilter) => string; live: string };

/** Activity branches all expose the same four report columns and internal record identity. */
export function activitySource(parts: readonly string[]): ObjectSource {
  return { def: activityReportDef(), from: `(${parts.join(" UNION ALL ")}) activities`, colSql: projectedColumn, filterOf: (sql, f) => filterSql(sql, f), live: "status = 'active'" };
}

/** The source of `object` in a snapshot: the register for accounts and contacts, else its projection; null when nothing is projected. */
export async function objectSource(c: DuckDBConnection, object: string): Promise<ObjectSource | null> {
  const builds = await buildsOf(c);
  if (object === ACTIVITY_OBJECT) {
    // Every note, task, call and meeting as one set, typed by which it is (lib/objects/reportSpec.ts activityReportDef).
    const parts = ACTIVITY_TYPES.filter((t) => builds.has(t)).map((t) =>
      `SELECT id, status, title, created_at, updated_at, ${builds.get(t)!.def.byApiName.has("ownerId") ? ident(fieldColumn("ownerId")) : "CAST(NULL AS VARCHAR)"} AS ${ident(fieldColumn("ownerId"))}, ${lit(t)} AS ${ident(fieldColumn("type"))} FROM ${ident(viewName(t))}`);
    if (!parts.length) return null;
    return activitySource(parts);
  }
  if (isRegisterObject(object)) {
    const def = registerListDef(object, builds.get(object)?.def ?? resolveObjectDef(STANDARD_OBJECTS[object]));
    return { def, ...registerSource(object, def, (o) => builds.get(o)?.def), live: "deletedAt IS NULL" };
  }
  const build = builds.get(object);
  if (!build) return null;
  return { def: build.def, from: projectedComputed(build, builds).withComputed(ident(viewName(object))), colSql: projectedColumn, filterOf: (sql, f) => filterSql(sql, f), live: "status = 'active'" };
}

async function listIn(c: DuckDBConnection, object: string, req: ListRequest): Promise<ListResponse> {
  const builds = await buildsOf(c);
  const build = builds.get(object);
  const through = await throughOf(c);
  if (!build) return { rows: [], nextCursor: null, total: 0, projectedThrough: through };
  let q: CompiledList;
  try {
    q = compileListRequest(build.def, req);
  } catch (e) {
    if (e instanceof ListRequestError) throw new HttpError(400, e.message);
    throw e;
  }
  const { withComputed, cols } = projectedComputed(build, builds);
  const view = ident(viewName(object));
  const s = ident(q.sort.col.column);
  /** The query's FROM and WHERE, with or without the keyset predicate; each call binds its own parameters. */
  const scope = (withKeyset: boolean) => {
    const sql = new Sql();
    const keyFilters = q.filters.filter((f) => f.col.column === "id");
    const where = [`status = ${sql.param(q.deleted ? "deleted" : "active")}`, ...q.filters.filter((f) => f.col.column !== "id").map((f) => filterSql(sql, f))];
    if (q.scope) where.push(scopeSql(sql, q.scope));
    const keyset = withKeyset ? keysetSql(sql, q) : null;
    if (keyset) where.push(keyset);
    const cte = keyFilters.length ? `WITH keyed AS MATERIALIZED (SELECT * FROM ${view} WHERE ${keyFilters.map((f) => filterSql(sql, f)).join(" AND ")}) ` : "";
    return { sql, head: cte, from: withComputed(keyFilters.length ? "keyed" : view), where: where.join(" AND ") };
  };
  const page = scope(true);
  const rows = await all(c,
    `${page.head}SELECT ${selectList(cols)} FROM ${page.from} WHERE ${page.where} ORDER BY ${s} ${q.sort.dir.toUpperCase()} NULLS LAST, id LIMIT ${q.limit + 1}`,
    page.sql.params);
  let total: number;
  if (q.cursor) total = q.cursor.total;
  else {
    const count = scope(false);
    total = Number((await all(c, `${count.head}SELECT count(*) AS n FROM ${count.from} WHERE ${count.where}`, count.sql.params))[0].n);
  }
  const listed = rows.slice(0, q.limit).map((r) => rowOf(r, object, cols));
  const last = listed[listed.length - 1];
  const cell = last ? cellOf(last, q.sort.col) : null;
  const nextCursor = rows.length > q.limit && last
    ? encodeCursor({ key: q.key, nulls: cell === null, value: cell as Scalar | null, id: last.id, total })
    : null;
  return { rows: listed, nextCursor, total, projectedThrough: through };
}

/**
 * A list view of the register (docs/cp0-object-layer.md, "One register"): the
 * request a `p_<object>` list takes, over every account or contact the
 * workspace knows, worked or not. Rows deleted on the ledger are left out
 * (`deleted` lists only them). Empty text and empty lists read as empty, as
 * the fake's in-memory evaluation reads them.
 */
export async function listRegister(w: Workspace, object: RegisterObject, req: ListRequest): Promise<RegisterListResponse> {
  return w.snapshot(async (c) => {
    // The workspace's definition, as the projector last stored it from Convex, so its custom fields list too (1.22.0).
    const builds = await buildsOf(c);
    const def = registerListDef(object, builds.get(object)?.def ?? resolveObjectDef(STANDARD_OBJECTS[object]));
    let q: CompiledList;
    try {
      q = compileListRequest(def, req);
    } catch (e) {
      if (e instanceof ListRequestError) throw new HttpError(400, e.message);
      throw e;
    }
    return listRegisterIn(c, object, def, q, (o) => builds.get(o)?.def);
  });
}

/** A custom field's value in a register row's `custom` JSON, typed like its list column. The key is `custom.<slug>` (registerCustomKey), safe in a path. */
function customSql(key: string, col: ListColumn): string {
  const path = `'$."${key}"'`;
  const text = `json_extract_string(custom, ${path})`;
  switch (col.kind) {
    case "number": return `TRY_CAST(${text} AS DOUBLE)`;
    case "date": return `TRY_CAST(${text} AS DATE)`;
    case "checkbox": return `TRY_CAST(${text} AS BOOLEAN)`;
    case "multi": {
      const j = `json_extract(custom, ${path})`;
      return `(CASE WHEN json_type(${j}) = 'ARRAY' AND json_array_length(${j}) > 0 THEN from_json(${j}, '["VARCHAR"]') END)`;
    }
    default: return `nullif(${text}, '')`;
  }
}

/** A register list's rows and column SQL: custom fields from `custom`, a contact's account fit, formula and rollup fields computed. */
function registerSource(object: RegisterObject, def: ResolvedObjectDef, defs: (object: string) => ResolvedObjectDef | undefined) {
  const computedIds = new Set(def.fields.filter((f) => f.type === "formula").map((f) => f.fieldId as string));
  const colSql: ColumnSql = (col) => {
    if (col.fieldId !== null && computedIds.has(col.fieldId)) return ident(col.column);
    const key = registerCustomKey(col);
    if (key) return customSql(key, col);
    const c = ident(registerColumn(object, col));
    if (col.kind === "text") return `nullif(${c}, '')`;
    if (col.kind === "multi") return `(CASE WHEN len(${c}) = 0 THEN NULL ELSE ${c} END)`;
    return c;
  };
  // An email matches whatever its case: the register keeps it as written, and the import looks it up lowercased.
  const lower = (v: Scalar) => (typeof v === "string" ? v.toLowerCase() : v);
  // A person's email filter matches any of their emails (1.28.0): the primary, or one of the others, stored lowercased.
  const others = `coalesce(additionalEmails, []::VARCHAR[])`;
  const anyOther = (sql: Sql, values: readonly Scalar[]) => `list_has_any(${others}, [${values.map((v) => sql.param(lower(v))).join(", ")}]::VARCHAR[])`;
  const filterOf = (sql: Sql, f: CompiledFilter) => {
    if (object !== "contact" || f.col.field !== "email") return filterSql(sql, f, colSql);
    const primary = (g: CompiledFilter) => filterSql(sql, g, (col) => `lower(${colSql(col)})`);
    if (f.op === "in") return `(${primary({ ...f, values: f.values.map(lower) })} OR ${anyOther(sql, f.values)})`;
    if (f.op === "eq") return `(${primary({ ...f, value: lower(f.value) })} OR ${anyOther(sql, [f.value])})`;
    if (f.op === "neq") return `(${primary({ ...f, value: lower(f.value) })} AND NOT ${anyOther(sql, [f.value])})`;
    if (f.op === "contains" || f.op === "startsWith") {
      const fn = f.op === "contains" ? "contains" : "starts_with";
      return `(${filterSql(sql, f, colSql)} OR len(list_filter(${others}, lambda e: ${fn}(e, ${sql.param(f.value)}))) > 0)`;
    }
    return filterSql(sql, f, colSql);
  };
  // A contact's account fit and ICPs are its account's, read with it (1.15.0); a deleted account leaves them empty.
  const rows0 = object === "account"
    ? "accounts"
    : "(SELECT c.*, a.fit AS accountFit, a.icpIds AS accountIcpIds FROM contacts c LEFT JOIN accounts a ON a.id = c.accountId AND a.deletedAt IS NULL)";
  // Formula and rollup fields (CP7c) are computed over the register rows, so they filter and sort like the row's own columns.
  const computed = computedColumns(def, defs, "t", colSql);
  const from = computed.cols.length ? `(SELECT t.*${computed.select} FROM ${rows0} t${computed.joins}) ${object}s` : `${rows0} ${object}s`;
  return { from, colSql, filterOf, computed };
}

async function listRegisterIn(
  c: DuckDBConnection, object: RegisterObject, def: ResolvedObjectDef, q: CompiledList, defs: (object: string) => ResolvedObjectDef | undefined,
): Promise<RegisterListResponse> {
  const { from: table, colSql, filterOf, computed } = registerSource(object, def, defs);
  const dates = computed.cols.filter((col) => col.type === "date").map((col) => `CAST(${ident(col.name)} AS VARCHAR) AS ${ident(col.name)}`);
  const star = dates.length ? `* REPLACE (${dates.join(", ")})` : "*";
  const s = colSql(q.sort.col);
  const scope = (withKeyset: boolean) => {
    const sql = new Sql();
    // The recycle bin leaves out rows merged into another (1.23.0): they come back by undoing the merge, not by a restore.
    const where = [q.deleted ? "deletedAt IS NOT NULL AND mergedInto IS NULL" : "deletedAt IS NULL", ...q.filters.map((f) => filterOf(sql, f))];
    if (q.scope) where.push(scopeSql(sql, q.scope, colSql));
    const keyset = withKeyset ? keysetSql(sql, q, colSql) : null;
    if (keyset) where.push(keyset);
    return { sql, where: where.join(" AND ") };
  };
  const through = await throughOf(c);
  const page = scope(true);
  const rows = await all(c, `SELECT ${star} FROM ${table} WHERE ${page.where} ORDER BY ${s} ${q.sort.dir.toUpperCase()} NULLS LAST, id LIMIT ${q.limit + 1}`, page.sql.params);
  let total: number;
  if (q.cursor) total = q.cursor.total;
  else {
    const count = scope(false);
    total = Number((await all(c, `SELECT count(*) AS n FROM ${table} WHERE ${count.where}`, count.sql.params))[0].n);
  }
  const listed = rows.slice(0, q.limit).map((r) => registerListRow(object, def, r));
  const last = listed[listed.length - 1];
  const cell = last ? cellOf(last, q.sort.col) : null;
  const nextCursor = rows.length > q.limit && last
    ? encodeCursor({ key: q.key, nulls: cell === null, value: cell as Scalar | null, id: last.id, total })
    : null;
  return { rows: listed, nextCursor, total, projectedThrough: through };
}

export async function searchProjected(w: Workspace | null, req: SearchRequest): Promise<SearchResponse> {
  let s: ReturnType<typeof compileSearch>;
  try {
    s = compileSearch(req);
  } catch (e) {
    if (e instanceof ListRequestError) throw new HttpError(400, e.message);
    throw e;
  }
  if (!w) return { hits: [], projectedThrough: emptyThrough() };
  const want = (o: string) => !s.objects || s.objects.includes(o);
  const top = (title: string, updated: string, id = "id") => `ORDER BY starts_with(lower(${title}), $q) DESC, ${updated} DESC, ${id} LIMIT ${s.perObject}`;
  /** An object's visibility scope over its owner column (SQL), as an AND clause; an object with a scope and no owner column finds nothing. */
  const scoped = (object: string, ownerCol: string | null, params: Record<string, DuckDBValue>) => {
    const scope = s.scopes[object];
    if (!scope) return "";
    if (!ownerCol) return " AND FALSE";
    const sql = new Sql();
    const clause = ownerSql(sql, `nullif(${ownerCol}, '')`, scope);
    // Sql names its parameters p0, p1, ..., apart from the search's own $q.
    Object.assign(params, sql.params);
    return ` AND ${clause}`;
  };
  return w.snapshot(async (c) => {
    const through = await throughOf(c);
    const hits: SearchHit[] = [];
    const add = (object: string, rows: Record<string, unknown>[], detail: readonly string[]) => {
      for (const r of rows) {
        const hit: SearchHit = { object, id: String(r.id), title: String(r.title), updatedAt: Number(r.updated_at) };
        if (detail.length) hit.detail = Object.fromEntries(detail.map((f) => [f, (r[f] ?? null) as Scalar | null]));
        hits.push(hit);
      }
    };
    // Accounts and contacts come from the register, worked or not; `p_account`/`p_contact` hold worked ones only.
    // Edge streams are not records anyone searches for.
    for (const [object, build] of [...(await buildsOf(c))].filter(([o]) => want(o) && !isRegisterObject(o) && o !== ASSOCIATION_OBJECT)) {
      const detail = (SEARCH_DETAIL[object] ?? []).filter((f) => build.def.byApiName.has(f));
      const cols = detail.map((f) => `, ${ident(fieldColumn(build.def.byApiName.get(f)!.fieldId))} AS ${ident(f)}`).join("");
      const params: Record<string, DuckDBValue> = { q: s.q };
      const field = s.scopes[object]?.field;
      const owner = field && field !== "id" ? build.def.byApiName.get(field) : undefined;
      const scope = scoped(object, field === "id" ? "id" : owner ? ident(fieldColumn(owner.fieldId)) : null, params);
      add(object, await all(c, `SELECT id, title, updated_at${cols} FROM ${ident(viewName(object))} WHERE status = 'active' AND contains(lower(title), $q)${scope} ${top("title", "updated_at")}`, params), detail);
    }
    if (want("account")) {
      const params: Record<string, DuckDBValue> = { q: s.q };
      const scope = scoped("account", "ownerId", params);
      add("account", await all(c, `SELECT id, name AS title, updatedAt AS updated_at, domain FROM accounts
        WHERE deletedAt IS NULL AND (contains(lower(name), $q) OR contains(lower(domain), $q))${scope} ${top("name", "updatedAt")}`, params), SEARCH_DETAIL.account);
    }
    if (want("contact")) {
      const params: Record<string, DuckDBValue> = { q: s.q };
      const scope = scoped("contact", "p.ownerId", params);
      add("contact", await all(c, `SELECT p.id, p.fullName AS title, p.updatedAt AS updated_at, nullif(p.email, '') AS email, a.name AS company
        FROM contacts p LEFT JOIN accounts a ON a.id = p.accountId
        WHERE p.deletedAt IS NULL AND (contains(lower(p.fullName), $q) OR contains(lower(p.email), $q)
          OR contains(array_to_string(coalesce(p.additionalEmails, []::VARCHAR[]), ' '), $q))${scope} ${top("p.fullName", "p.updatedAt", "p.id")}`, params), SEARCH_DETAIL.contact);
    }
    return { hits: rankSearchHits(hits, s), projectedThrough: through };
  });
}
