// Module reports (contract 1.33.0, docs/modules.md "Reports and charts"): a Canon module's projected docs, kept as
// Canon writes them, and reports over one collection's docs as a caller reads them.
//
// - `module_docs` holds each doc whole (its data as JSON), with its owner, its set parent and generation, and a
//   parent's live generations. Canon sends what changed (Convex's moduleJobs `#report` keys); a rebuild sends every
//   doc, then sweeps the rows it didn't rewrite.
// - A report reads the collection as a report object (src/core/objects/moduleReport.ts moduleReportDef): each
//   declared field a typed column extracted from the JSON, so the shared report semantics (reportSpec.ts) and their
//   SQL (aggregate.ts) apply unchanged.
// - The scope is Canon's, compiled from the caller's read scope (convex/lib/modules/scope.ts reportPlan): an owner
//   list, a row condition whose refs read related docs here, and a set doc's parent, which must be readable and hold
//   the doc's generation as its live one. A doc the scope doesn't admit is never counted.
import { fieldColumn, ListRequestError } from "./core/objects/listSpec.ts";
import { compileAggregateRequest, type AggregateResponse } from "./core/objects/reportSpec.ts";
import { moduleReportDef, MODULE_SCOPE_DEPTH, sameProjection, type ModuleActivityReportSource, type ModuleDocScope, type ModuleFieldType, type ModuleProjection, type ModuleScalar, type ModuleSyncResponse, type ModuleWhere } from "./core/objects/moduleReport.ts";
import { aggregateCompiled } from "./aggregate.ts";
import type { ModuleAggregateBody, ModuleSyncBody } from "./contract.ts";
import { HttpError } from "./errors.ts";
import { ident } from "./projection.ts";
import { filterSql, Sql, type ObjectSource } from "./projectionQuery.ts";
import { SHARDS } from "./projector.ts";
import type { Workspace } from "./workspace.ts";
import type { DuckDBConnection } from "@duckdb/node-api";
import { all, one } from "./db.ts";

type Projection = ModuleProjection;
const projectionMatches = (r: Record<string, unknown> | undefined, p: Projection) => !!r && r.package_id === p.packageId
  && r.epoch === p.epoch && r.generation === p.generation && r.collections === JSON.stringify(p.collections);

async function requireProjection(c: DuckDBConnection, module: string, p?: Projection) {
  const r = await one(c, "SELECT * FROM module_projection WHERE module = $m", { m: module });
  if (!r && !p) return;
  if (!p || !projectionMatches(r, p)) throw new HttpError(503, "This module's report projection is initializing. Try again shortly.");
  const done = await all(c, "SELECT collection FROM module_collection_receipts WHERE module = $m AND complete", { m: module });
  if (!p.collections.every((name) => done.some((x) => x.collection === name))) throw new HttpError(503, "This module's report projection is syncing. Try again shortly.");
}

async function fencedSync(c: DuckDBConnection, module: string, body: ModuleSyncBody, at: number): Promise<ModuleSyncResponse> {
  const p = body.projection!, work = body.work!;
  const receipt = (accepted: boolean, retryAfter?: number): ModuleSyncResponse => ({ at, upserted: 0, deleted: 0,
    receipt: { projection: p, work, accepted, ...(retryAfter === undefined ? {} : { retryAfter }) } });
  const sorted = [...new Set(p.collections)].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(p.collections) || body.sweep) throw new HttpError(400, "a fenced sync needs a sorted, complete collection closure and versioned rebuilds");
  const old = await one(c, "SELECT * FROM module_projection WHERE module = $m", { m: module });
  if (!projectionMatches(old, p)) {
    if (old && (old.package_id !== p.packageId || Number(old.epoch) > p.epoch || (old.epoch === p.epoch && Number(old.generation) >= p.generation))) return receipt(false);
    if (work.kind !== "rebuild") throw new HttpError(409, "initialize the projection with a rebuild first");
    for (const table of ["module_docs", "module_doc_receipts", "module_collection_receipts", "module_projection"]) await c.run(`DELETE FROM ${table} WHERE module = $m`, { m: module });
    await c.run("INSERT INTO module_projection VALUES ($m, $p, $e, $g, $cs)", { m: module, p: p.packageId, e: p.epoch, g: p.generation, cs: JSON.stringify(p.collections) });
  }
  const rows: Array<ModuleSyncBody["upserts"][number] | ModuleSyncBody["deletes"][number]> = [...body.upserts, ...body.deletes];
  const names = rows.map((r) => `${r.collection}|${r.key}`);
  if (new Set(names).size !== names.length || rows.some((r) => !p.collections.includes(r.collection))) throw new HttpError(400, "sync rows must be unique and inside the projection closure");
  if (work.kind === "rebuild" && (!p.collections.includes(work.collection) || body.deletes.length || rows.some((r) => r.collection !== work.collection))) throw new HttpError(400, "a rebuild sends one declared collection");
  if (work.kind === "keys" && (work.keys.length !== rows.length || new Set(work.keys.map((k) => `${k.collection}|${k.key}`)).size !== rows.length
    || rows.some((r) => !work.keys.some((k) => k.collection === r.collection && k.key === r.key)))) throw new HttpError(400, "every sync row needs exactly one leased key receipt");

  if (work.kind === "rebuild") {
    const prior = await one(c, "SELECT * FROM module_collection_receipts WHERE module = $m AND collection = $c", { m: module, c: work.collection });
    if (prior && (Number(prior.seq) > work.seq || (prior.seq === work.seq && prior.job !== work.job))) return receipt(false, Number(prior.seq));
    if (prior?.seq === work.seq && prior.job === work.job && prior.complete) return receipt(true);
    await c.run("INSERT OR REPLACE INTO module_collection_receipts VALUES ($m, $c, $s, $j, false)", { m: module, c: work.collection, s: work.seq, j: work.job });
  }
  const apply: Array<{ row: (typeof rows)[number]; seq: number; job: string; seen: string | null }> = [];
  for (const row of rows) {
    const k = work.kind === "keys" ? work.keys.find((k) => k.collection === row.collection && k.key === row.key)! : work;
    const prior = await one(c, "SELECT * FROM module_doc_receipts WHERE module = $m AND collection = $c AND key = $k", { m: module, c: row.collection, k: row.key });
    if (prior && prior.seq === k.seq && prior.job === k.job) continue;
    const floor = await one(c, "SELECT seq FROM module_collection_receipts WHERE module = $m AND collection = $c", { m: module, c: row.collection });
    if (prior && Number(prior.seq) > k.seq) {
      if (work.kind === "rebuild") continue;
      return receipt(false, Number(prior.seq));
    }
    if ((prior && prior.seq === k.seq) || (work.kind === "keys" && floor && k.seq <= Number(floor.seq))) return receipt(false, Math.max(Number(prior?.seq ?? 0), Number(floor?.seq ?? 0)));
    apply.push({ row, seq: k.seq, job: k.job, seen: work.kind === "rebuild" ? `${work.job}:${work.seq}` : null });
  }
  for (const { row, seq, job, seen } of apply) {
    await c.run("DELETE FROM module_docs WHERE module = $m AND collection = $c AND key = $k", { m: module, c: row.collection, k: row.key });
    if ("data" in row) await c.run(`INSERT INTO module_docs VALUES ($m, $c, $k, $p, $g, CAST($gs AS JSON), $o, CAST($d AS JSON), $v, $ca, $ua, $at)`,
      { m: module, c: row.collection, k: row.key, p: row.parentKey, g: row.gen, gs: JSON.stringify(row.gens), o: row.owner, d: JSON.stringify(row.data), v: row.version, ca: row.createdAt, ua: row.updatedAt, at });
    await c.run("INSERT OR REPLACE INTO module_doc_receipts VALUES ($m, $c, $k, $s, $j, $seen)", { m: module, c: row.collection, k: row.key, s: seq, j: job, seen });
  }
  if (work.kind === "rebuild" && work.complete) {
    const params = { m: module, c: work.collection, s: work.seq, j: work.job, seen: `${work.job}:${work.seq}` };
    await c.run(`DELETE FROM module_docs WHERE module = $m AND collection = $c AND key IN
      (SELECT key FROM module_doc_receipts WHERE module = $m AND collection = $c AND seq <= $s AND seen IS DISTINCT FROM $seen)`, { m: module, c: work.collection, s: work.seq, seen: params.seen });
    await c.run("UPDATE module_doc_receipts SET seq = $s, job = $j WHERE module = $m AND collection = $c AND seq <= $s AND seen IS DISTINCT FROM $seen", params);
    await c.run("UPDATE module_collection_receipts SET complete = true WHERE module = $m AND collection = $c", { m: module, c: work.collection });
  }
  return { ...receipt(true), upserted: apply.filter((x) => "data" in x.row).length, deleted: apply.filter((x) => !("data" in x.row)).length };
}

/** Apply one legacy or fenced module sync atomically. */
export function syncModuleDocs(w: Workspace, module: string, body: ModuleSyncBody): Promise<ModuleSyncResponse> {
  return w.write(async (c) => {
    const at = Date.now();
    if (!!body.projection !== !!body.work) throw new HttpError(400, "a fenced sync needs both projection and work");
    if (body.projection) return fencedSync(c, module, body, at);
    if (await one(c, "SELECT module FROM module_projection WHERE module = $m", { m: module })) throw new HttpError(409, "this projection requires versioned sync receipts");
    const gone = [...body.upserts.map((d) => ({ collection: d.collection, key: d.key })), ...body.deletes];
    if (gone.length) {
      await c.run(
        `DELETE FROM module_docs WHERE module = $m AND (collection, key) IN (SELECT r->>'collection', r->>'key' FROM (SELECT unnest(CAST(CAST($keys AS JSON) AS JSON[])) AS r))`,
        { m: module, keys: JSON.stringify(gone) },
      );
    }
    if (body.upserts.length) {
      await c.run(
        `INSERT INTO module_docs SELECT $m, r->>'collection', r->>'key', r->>'parentKey', TRY_CAST(r->>'gen' AS INTEGER), r->'gens', r->>'owner', r->'data',
          CAST(r->>'version' AS INTEGER), CAST(CAST(r->>'createdAt' AS DOUBLE) AS BIGINT), CAST(CAST(r->>'updatedAt' AS DOUBLE) AS BIGINT), $at
         FROM (SELECT unnest(CAST(CAST($rows AS JSON) AS JSON[])) AS r)`,
        { m: module, rows: JSON.stringify(body.upserts), at },
      );
    }
    if (body.sweep) {
      await c.run(`DELETE FROM module_docs WHERE module = $m AND collection = $c AND synced_at < $before`, { m: module, c: body.sweep.collection, before: body.sweep.before });
    }
    return { at, upserted: body.upserts.length, deleted: body.deletes.length };
  });
}

/** A JSON path to a top-level field, as a bound parameter. */
const pathOf = (sql: Sql, field: string) => sql.param(`$."${field.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);

/** A field's value as the report reads it (moduleReport.ts moduleCell, in SQL). */
function cellSql(sql: Sql, alias: string, field: string, type: ModuleFieldType): string {
  const p = pathOf(sql, field);
  const j = `json_extract(${alias}.data, ${p})`;
  const t = `json_type(${j})`;
  switch (type) {
    case "text": case "picklist": case "user": return `CASE WHEN ${t} IN ('VARCHAR', 'BIGINT', 'UBIGINT', 'DOUBLE', 'BOOLEAN') THEN json_extract_string(${alias}.data, ${p}) END`;
    case "number": case "currency": case "datetime": return `CASE WHEN ${t} IN ('BIGINT', 'UBIGINT', 'DOUBLE') THEN CAST(${j} AS DOUBLE) END`;
    case "date": return `CASE WHEN ${t} = 'VARCHAR' AND regexp_full_match(json_extract_string(${alias}.data, ${p}), '\\d{4}-\\d{2}-\\d{2}') THEN TRY_CAST(json_extract_string(${alias}.data, ${p}) AS DATE) END`;
    case "checkbox": return `CASE WHEN ${t} = 'BOOLEAN' THEN CAST(${j} AS BOOLEAN) END`;
  }
}

/** Whether `alias`'s field holds `v`, typed as Convex compares it: a missing field and JSON null are null. */
function holdsSql(sql: Sql, alias: string, field: string, v: ModuleScalar): string {
  const p = pathOf(sql, field);
  const j = `json_extract(${alias}.data, ${p})`;
  if (v === null) return `(${j} IS NULL OR json_type(${j}) = 'NULL')`;
  if (typeof v === "string") return `(json_type(${j}) = 'VARCHAR' AND json_extract_string(${alias}.data, ${p}) = ${sql.param(v)})`;
  if (typeof v === "boolean") return `(json_type(${j}) = 'BOOLEAN' AND CAST(${j} AS BOOLEAN) = ${sql.param(v)})`;
  return `(json_type(${j}) IN ('BIGINT', 'UBIGINT', 'DOUBLE') AND CAST(${j} AS DOUBLE) = ${sql.param(v)})`;
}

type Ctx = { sql: Sql; module: string; n: number };
const fresh = (x: Ctx) => `r${x.n++}`;

/** A row condition on the doc `alias` (manifest.ts rowWhereHolds, in SQL); a ref reads the doc its field names. */
function whereSql(x: Ctx, alias: string, w: ModuleWhere, depth: number): string {
  if (depth > MODULE_SCOPE_DEPTH) throw new HttpError(400, "a module scope nests too deep");
  if ("all" in w) return `(${w.all.map((y) => whereSql(x, alias, y, depth)).join(" AND ")})`;
  if ("ref" in w) {
    const r = fresh(x);
    const p = pathOf(x.sql, w.ref);
    return `EXISTS (SELECT 1 FROM module_docs ${r} WHERE ${r}.module = ${x.sql.param(x.module)} AND ${r}.collection = ${x.sql.param(w.collection)}`
      + ` AND json_type(json_extract(${alias}.data, ${p})) = 'VARCHAR' AND ${r}.key = json_extract_string(${alias}.data, ${p}) AND ${whereSql(x, r, w.where, depth + 1)})`;
  }
  if ("in" in w) return `(${w.in.map((v) => holdsSql(x.sql, alias, w.field, v)).join(" OR ")})`;
  return `(NOT ${holdsSql(x.sql, alias, w.field, null)} AND NOT ${holdsSql(x.sql, alias, w.field, w.neq)})`;
}

/** Whether a scope admits the doc `alias` of `collection`: its owner, its condition, and a set doc's live, readable parent. */
function scopeSql(x: Ctx, alias: string, collection: string, s: ModuleDocScope, depth: number): string {
  if (depth > MODULE_SCOPE_DEPTH) throw new HttpError(400, "a module scope nests too deep");
  const parts: string[] = [];
  if (s.owners !== null) parts.push(s.owners.length ? `${alias}.owner IN (SELECT unnest(${x.sql.param(JSON.stringify(s.owners))}::JSON::VARCHAR[]))` : "FALSE");
  if (s.where) parts.push(whereSql(x, alias, s.where, 0));
  if (s.setOf) {
    const p = fresh(x);
    parts.push(`EXISTS (SELECT 1 FROM module_docs ${p} WHERE ${p}.module = ${x.sql.param(x.module)} AND ${p}.collection = ${x.sql.param(s.setOf.parent)} AND ${p}.key = ${alias}.parent_key`
      + ` AND coalesce(TRY_CAST(json_extract(${p}.gens, ${pathOf(x.sql, collection)}) AS INTEGER), ${p}.gen, 0) = coalesce(${alias}.gen, 0)`
      + ` AND ${scopeSql(x, p, s.setOf.parent, s.setOf.scope, depth + 1)})`);
  }
  return parts.length ? parts.join(" AND ") : "TRUE";
}

/** Reuses module reports' exact scope and cell SQL inside the aggregate's snapshot. */
export async function moduleActivitySelects(c: DuckDBConnection, sources: readonly ModuleActivityReportSource[], sql: Sql): Promise<string[]> {
  if (sources.length > 100) throw new HttpError(400, "too many activity collections");
  const seen = new Set<string>();
  const projections = new Map<string, Projection>();
  const parts: string[] = [];
  for (const source of sources) {
    const { module, collection, projection, scopes } = source;
    const identity = JSON.stringify([module, collection]);
    if (seen.has(identity)) throw new HttpError(400, "duplicate activity collection");
    seen.add(identity);
    if (!projection.collections.includes(collection) || JSON.stringify([...new Set(projection.collections)].sort()) !== JSON.stringify(projection.collections)) throw new HttpError(400, "activity collection needs a complete sorted projection closure");
    if (projections.has(module) && !sameProjection(projections.get(module), projection)) throw new HttpError(400, "activity sources disagree on their projection");
    projections.set(module, projection);
    await requireProjection(c, module, projection);
    if (!scopes.length || scopes.length > 100) throw new HttpError(400, "activity sources need bounded principal scopes");
    const x: Ctx = { sql, module, n: 0 };
    const admits = scopes.map((s) => `(${scopeSql(x, "d", collection, s, 0)})`).join(" AND ");
    const owner = source.owner === null ? "CAST(NULL AS VARCHAR)" : `nullif(${cellSql(sql, "d", source.owner, "user")}, '')`;
    parts.push(`SELECT to_json(list_value('module', ${sql.param(module)}, ${sql.param(collection)}, d.key)) AS id, 'active' AS status, d.key AS title, d.created_at, d.updated_at, ${owner} AS ${ident(fieldColumn("ownerId"))}, ${sql.param(source.kind)} AS ${ident(fieldColumn("type"))}`
      + ` FROM module_docs d WHERE d.module = ${sql.param(module)} AND d.collection = ${sql.param(collection)} AND ${admits}`);
  }
  return parts;
}

export function aggregateModuleDocs(w: Workspace | null, module: string, body: ModuleAggregateBody): Promise<AggregateResponse> {
  if (body.projection && !body.projection.collections.includes(body.collection)) throw new HttpError(400, "the report collection is outside its projection closure");
  const through = Object.fromEntries(Array.from({ length: SHARDS }, (_, s) => [String(s), 0]));
  const def = moduleReportDef(body.collection, body.fields);
  let q;
  try {
    q = compileAggregateRequest(body.collection, def, { filter: body.filter, groupBy: body.groupBy, measures: body.measures }, () => undefined);
  } catch (e) {
    if (e instanceof ListRequestError) throw new HttpError(400, e.message);
    throw e;
  }
  if (!w && body.projection) throw new HttpError(503, "This module's report projection is initializing. Try again shortly.");
  if (!w) return Promise.resolve({ groups: [], subtotals: [], total: q.measures.map((m) => (m.fn === "count" ? 0 : null)), rows: 0, truncated: false, projectedThrough: through });
  const sql = new Sql();
  const x: Ctx = { sql, module, n: 0 };
  const cols = body.fields.map((f) => `${cellSql(sql, "d", f.name, f.type)} AS ${ident(`c_${f.name}`)}`);
  const admits = body.docScope ? scopeSql(x, "d", body.collection, body.docScope, 0) : "TRUE";
  const from = `(SELECT d.key AS id, 'active' AS status, d.key AS title, d.created_at, d.updated_at, ${cols.join(", ")} FROM module_docs d`
    + ` WHERE d.module = ${sql.param(module)} AND d.collection = ${sql.param(body.collection)} AND ${admits}) md`;
  const base: ObjectSource = { def, from, colSql: (col) => ident(col.column), filterOf: (s, f) => filterSql(s, f), live: "TRUE" };
  return w.snapshot(async (c) => {
    await requireProjection(c, module, body.projection);
    const result = await aggregateCompiled(c, q, base, new Map(), sql, through);
    return { ...result, ...(body.projection ? { projection: body.projection } : {}) };
  });
}
