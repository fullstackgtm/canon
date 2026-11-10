// The typed wide table per object (docs/cp0-object-layer.md, "List views in
// DuckDB"): p_<object>__b<build> holds one row per record with one column per
// field, s_<object>__b<build> its fold state, and the view p_<object> points
// at the current build.
import { dateValue, LIST, listValue, VARCHAR, type DuckDBAppender } from "@duckdb/node-api";
import type { FoldState } from "./core/objects/fold.ts";
import { fieldColumn, listRowOf } from "./core/objects/listSpec.ts";
import type { FieldId, FieldType, FieldValue, ObjectDef, ResolvedObjectDef } from "./core/objects/registry.ts";

const SQL_TYPE: Record<Exclude<FieldType, "formula">, string> = {
  text: "VARCHAR", picklist: "VARCHAR", user: "VARCHAR", lookup: "VARCHAR",
  number: "DOUBLE", currency: "DOUBLE",
  date: "DATE",
  // Epoch milliseconds, as the fold stores them, so values and cursors round-trip exactly.
  datetime: "BIGINT",
  checkbox: "BOOLEAN",
  multipicklist: "VARCHAR[]",
  // A multi-value field (CP7a): ordered, the first item primary.
  emails: "VARCHAR[]", phones: "VARCHAR[]", links: "VARCHAR[]",
  splits: "JSON",
};

export type Column = { name: string; fieldId: FieldId; type: Exclude<FieldType, "formula"> };

export const OBJECT_TABLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** A quoted identifier. Names come from the registry, so quote rather than trust them. */
export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const SYSTEM_COLUMNS = `id VARCHAR NOT NULL, version INTEGER NOT NULL, status VARCHAR NOT NULL, title VARCHAR NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT`;

/** The field columns of an object: every field a record's projection carries (not system or formula fields). */
export function columnsOf(def: ObjectDef): Column[] {
  const cols: Column[] = [];
  const seen = new Set<string>();
  for (const f of def.fields) {
    if (f.system || f.type === "formula") continue;
    const name = fieldColumn(f.fieldId);
    // DuckDB matches identifiers case-insensitively, even quoted.
    if (seen.has(name.toLowerCase())) throw new Error(`${def.apiName}: field ids ${f.fieldId} and another differ only in case`);
    seen.add(name.toLowerCase());
    cols.push({ name, fieldId: f.fieldId, type: f.type });
  }
  return cols;
}

/** What decides a table's shape and contents. A registry change that leaves it equal needs no rebuild (picklist options, labels). */
export function signatureOf(def: ObjectDef): string {
  return JSON.stringify([def.titleFieldId, columnsOf(def).map((c) => [c.fieldId, c.type])]);
}

export const rowTable = (object: string, build: number) => `p_${object}__b${build}`;
export const stateTable = (object: string, build: number) => `s_${object}__b${build}`;
export const viewName = (object: string) => `p_${object}`;

export function createBuildTables(def: ObjectDef, build: number): string[] {
  const cols = columnsOf(def).map((c) => `, ${ident(c.name)} ${SQL_TYPE[c.type]}`).join("");
  return [
    `CREATE TABLE ${ident(rowTable(def.apiName, build))} (${SYSTEM_COLUMNS}${cols})`,
    `CREATE TABLE ${ident(stateTable(def.apiName, build))} (id VARCHAR NOT NULL, version INTEGER NOT NULL, state VARCHAR NOT NULL)`,
  ];
}

export function indexBuildTables(object: string, build: number): string[] {
  return [
    `CREATE INDEX ${ident(`${rowTable(object, build)}_id`)} ON ${ident(rowTable(object, build))}(id)`,
    `CREATE INDEX ${ident(`${stateTable(object, build)}_id`)} ON ${ident(stateTable(object, build))}(id)`,
  ];
}

const VARCHAR_LIST = LIST(VARCHAR);
const DAY_MS = 86_400_000;

function appendValue(app: DuckDBAppender, type: Column["type"], v: FieldValue | undefined) {
  if (v === null || v === undefined) return app.appendNull();
  switch (type) {
    case "splits":
      return app.appendVarchar(JSON.stringify(v));
    case "number":
    case "currency":
      return app.appendDouble(Number(v));
    case "datetime":
      return app.appendBigInt(BigInt(Math.trunc(Number(v))));
    case "date":
      return app.appendDate(dateValue(Math.floor(Date.parse(`${String(v)}T00:00:00Z`) / DAY_MS)));
    case "checkbox":
      return app.appendBoolean(Boolean(v));
    case "multipicklist":
    case "emails":
    case "phones":
    case "links":
      return app.appendList(listValue((v as readonly string[]).map(String)), VARCHAR_LIST);
    default:
      return app.appendVarchar(String(v));
  }
}

/** Append one record's row and fold state to a build's tables. */
export function appendRecord(rows: DuckDBAppender, states: DuckDBAppender, def: ResolvedObjectDef, cols: readonly Column[], state: FoldState) {
  const r = listRowOf(def, state);
  rows.appendVarchar(r.id);
  rows.appendInteger(r.version);
  rows.appendVarchar(r.status);
  rows.appendVarchar(r.title);
  rows.appendBigInt(BigInt(r.createdAt));
  rows.appendBigInt(BigInt(r.updatedAt));
  if (r.deletedAt === null) rows.appendNull();
  else rows.appendBigInt(BigInt(r.deletedAt));
  for (const c of cols) appendValue(rows, c.type, r.values[c.fieldId]);
  rows.endRow();
  states.appendVarchar(state.streamId);
  states.appendInteger(state.version);
  states.appendVarchar(JSON.stringify(state));
  states.endRow();
}

/** The SELECT list that reads a row back in ListRow form (dates as YYYY-MM-DD text). */
export function selectList(cols: readonly Column[]): string {
  const fields = cols.map((c) => (c.type === "date" ? `CAST(${ident(c.name)} AS VARCHAR) AS ${ident(c.name)}` : ident(c.name)));
  return ["id", "version", "status", "title", "created_at", "updated_at", "deleted_at", ...fields].join(", ");
}
