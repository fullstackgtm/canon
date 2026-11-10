/**
 * List views and search over projected records (docs/cp0-object-layer.md,
 * "List views in DuckDB"): what a request may ask for, and what it means.
 *
 * The record service compiles a validated request to SQL over its `p_<object>`
 * tables; the fake record client (local stacks without the service) evaluates
 * the same validated request in memory with `listRowsInMemory`. Both validate
 * with `compileListRequest` and page with the same cursor, so a request that
 * one accepts the other accepts, and both return rows in the same order.
 *
 * Pure: no database access, no Node-only imports. The record service imports
 * a generated copy (scripts/sync-object-core.ts).
 */
import { project, titleOf, type FoldState, type Lifecycle } from "./fold.ts";
import { ASSOCIATION_OBJECT, CUSTOM_FIELD_API_NAME, isMultiValueType, type FieldDef, type FieldId, type FieldType, type FieldValue, type ResolvedObjectDef } from "./registry.ts";

export const LIST_LIMIT_MAX = 200;
export const LIST_LIMIT_DEFAULT = 50;
export const FILTERS_MAX = 20;
export const IN_VALUES_MAX = 500;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_LIMIT_DEFAULT = 20;
export const TEXT_VALUE_MAX = 512;

export type FilterOp =
  | "eq" | "neq" | "in"
  | "contains" | "startsWith"
  | "gt" | "gte" | "lt" | "lte"
  | "hasAny" | "hasAll"
  | "empty" | "notEmpty";

export const FILTER_OPS: readonly FilterOp[] = ["eq", "neq", "in", "contains", "startsWith", "gt", "gte", "lt", "lte", "hasAny", "hasAll", "empty", "notEmpty"];

export type ListFilter = { field: string; op: FilterOp; value?: unknown };
export type ListSort = { field: string; dir: "asc" | "desc" };
/**
 * Record visibility (CP14, contract 1.29.0): only records whose `field` (the
 * owner) is one of `owners`, and records with no owner when `unowned`. Convex
 * derives it from the caller's role (convex/lib/access.ts ownerScope); absent,
 * every record. An empty `owners` with `unowned: false` matches nothing.
 * `field: "id"` names the visible records themselves (deals, whose owner
 * lives on the Convex row), at most SCOPE_IDS_MAX of them.
 */
export type OwnerScope = { field: string; owners: readonly string[]; unowned: boolean };
/** The most values a scope carries: owners, or record ids for an `id` scope. */
export const SCOPE_IDS_MAX = 5000;
export type ListRequest = { filter?: readonly ListFilter[]; sort?: ListSort; limit?: number; cursor?: string; deleted?: boolean; scope?: OwnerScope };

/** One projected record as a list returns it. `values` is keyed by fieldId, like a Convex hot row. */
export type ListRow = {
  id: string;
  object: string;
  version: number;
  status: Lifecycle["status"];
  title: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  values: Record<string, FieldValue>;
};

/** Per shard, the last ledger `seq` the rows reflect. A client re-queries until it passes its own save's (shard, seq). */
export type ProjectedThrough = Record<string, number>;

export type ListResponse = { rows: ListRow[]; nextCursor: string | null; total: number; projectedThrough: ProjectedThrough };

/** `perObject` bounds each object's hits; `limit` bounds them all. `scopes` narrows an object's hits to what the caller sees (OwnerScope). */
export type SearchRequest = { q: string; limit?: number; perObject?: number; objects?: readonly string[]; scopes?: Readonly<Record<string, OwnerScope>> };
/** Accounts and contacts are register rows (their record-service id); other objects are streams. */
export type SearchHit = { object: string; id: string; title: string; updatedAt: number; detail?: Record<string, Scalar | null> };
export type SearchResponse = { hits: SearchHit[]; projectedThrough: ProjectedThrough };

/** The value domain of a listable column; it decides the filter ops and how values compare. */
export type ColumnKind = "id" | "text" | "number" | "date" | "checkbox" | "multi";

/**
 * A column a list can filter or sort on. `column` names the DuckDB column of
 * `p_<object>`: a system column, or `c_<fieldId>` for a field.
 */
export type ListColumn =
  | { field: string; kind: ColumnKind; column: "id" | "title" | "created_at" | "updated_at"; fieldId: null }
  | { field: string; kind: ColumnKind; column: string; fieldId: FieldId };

const KIND_OF: Record<FieldType, ColumnKind | null> = {
  text: "text", picklist: "text", user: "text", lookup: "text",
  number: "number", currency: "number", datetime: "number",
  date: "date",
  checkbox: "checkbox",
  multipicklist: "multi", emails: "multi", phones: "multi", links: "multi",
  // A formula or rollup lists as the type it gives (columnKind).
  formula: null, splits: null,
};

/** The value domain of a field's list column, or null when it has none. */
export const columnKind = (f: FieldDef): ColumnKind | null => KIND_OF[f.type === "formula" ? f.returns : f.type];

/** The filter ops each column kind accepts. */
export const OPS_OF: Readonly<Record<ColumnKind, readonly FilterOp[]>> = {
  id: ["eq", "in"],
  text: ["eq", "neq", "in", "contains", "startsWith", "empty", "notEmpty"],
  number: ["eq", "neq", "in", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  date: ["eq", "neq", "in", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  checkbox: ["eq", "empty", "notEmpty"],
  multi: ["hasAny", "hasAll", "empty", "notEmpty"],
};

/** The DuckDB column for a field. */
export const fieldColumn = (fieldId: string) => `c_${fieldId}`;

/**
 * The record's id and its title (the title field's value as text). Their names
 * cannot be field apiNames: leads and contacts have a `title` field (job title).
 */
export const SYSTEM_LIST_FIELDS = ["id", "recordTitle"] as const;

/** Every column of an object a list can name, keyed by the name a request uses (a field's apiName, or a system name). */
export function listColumns(def: ResolvedObjectDef): ReadonlyMap<string, ListColumn> {
  const out = new Map<string, ListColumn>([
    ["id", { field: "id", kind: "id", column: "id", fieldId: null }],
    ["recordTitle", { field: "recordTitle", kind: "text", column: "title", fieldId: null }],
  ]);
  for (const f of def.fields) {
    if ((SYSTEM_LIST_FIELDS as readonly string[]).includes(f.apiName)) throw new ListRequestError(`${def.apiName}.${f.apiName} clashes with a system list field`);
    if (f.system) {
      if (f.apiName === "createdAt") out.set("createdAt", { field: "createdAt", kind: "number", column: "created_at", fieldId: null });
      if (f.apiName === "updatedAt") out.set("updatedAt", { field: "updatedAt", kind: "number", column: "updated_at", fieldId: null });
      continue;
    }
    // An archived field leaves list views; its values stay in the ledger.
    if (f.archivedAt !== undefined) continue;
    const kind = columnKind(f);
    if (kind) out.set(f.apiName, { field: f.apiName, kind, column: fieldColumn(f.fieldId), fieldId: f.fieldId });
  }
  // createdAt and updatedAt sort every object, whether or not its registry lists them.
  if (!out.has("createdAt")) out.set("createdAt", { field: "createdAt", kind: "number", column: "created_at", fieldId: null });
  if (!out.has("updatedAt")) out.set("updatedAt", { field: "updatedAt", kind: "number", column: "updated_at", fieldId: null });
  return out;
}

/** A filter or cursor value after validation: text, a number, a `YYYY-MM-DD` date, or a boolean. */
export type Scalar = string | number | boolean;

export type CompiledFilter =
  | { col: ListColumn; op: "empty" | "notEmpty" }
  | { col: ListColumn; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith"; value: Scalar }
  | { col: ListColumn; op: "in" | "hasAny" | "hasAll"; values: Scalar[] };

/** Where the previous page ended. `nulls` is the null-phase bit: the sort column's null rows come after all others. */
export type ListCursor = { key: string; nulls: boolean; value: Scalar | null; id: string; total: number };

/** A visibility scope checked against an object's owner column. */
export type CompiledScope = { col: ListColumn; owners: string[]; unowned: boolean };

export type CompiledList = {
  object: string;
  filters: CompiledFilter[];
  scope: CompiledScope | null;
  sort: { col: ListColumn; dir: "asc" | "desc" };
  limit: number;
  deleted: boolean;
  cursor: ListCursor | null;
  /** Identifies the query a cursor belongs to, so a cursor cannot page a different filter or sort. */
  key: string;
};

export class ListRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListRequestError";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A value of a column's kind. Filter values are capped at TEXT_VALUE_MAX; a cursor carries a stored value, which is not. */
function scalarFor(col: ListColumn, raw: unknown, what: string, maxText = TEXT_VALUE_MAX): Scalar {
  switch (col.kind) {
    case "id":
    case "text":
    case "multi":
      if (typeof raw !== "string") throw new ListRequestError(`${what} must be text`);
      if (raw.length > maxText) throw new ListRequestError(`${what} must be text of at most ${maxText} characters`);
      return raw;
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new ListRequestError(`${what} must be a number`);
      return raw;
    case "date":
      if (typeof raw !== "string" || !DATE.test(raw) || !isCalendarDate(raw)) throw new ListRequestError(`${what} must be a date (YYYY-MM-DD)`);
      return raw;
    case "checkbox":
      if (typeof raw !== "boolean") throw new ListRequestError(`${what} must be true or false`);
      return raw;
  }
}

/** A YYYY-MM-DD string naming a day that exists (rejects 2026-02-30), as DuckDB's DATE cast requires. */
function isCalendarDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function compileFilter(columns: ReadonlyMap<string, ListColumn>, f: ListFilter): CompiledFilter {
  const col = columns.get(f.field);
  if (!col) throw new ListRequestError(`unknown field ${f.field}`);
  if (!OPS_OF[col.kind].includes(f.op)) throw new ListRequestError(`${f.field} cannot be filtered with ${f.op}`);
  const what = `${f.field} ${f.op}`;
  switch (f.op) {
    case "empty":
    case "notEmpty":
      if (f.value !== undefined) throw new ListRequestError(`${what} takes no value`);
      return { col, op: f.op };
    case "in":
    case "hasAny":
    case "hasAll": {
      if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > IN_VALUES_MAX) throw new ListRequestError(`${what} needs a list of 1 to ${IN_VALUES_MAX} values`);
      return { col, op: f.op, values: [...new Set(f.value.map((v) => scalarFor(col, v, what)))] };
    }
    case "contains":
    case "startsWith": {
      const value = scalarFor(col, f.value, what) as string;
      if (!value) throw new ListRequestError(`${what} needs some text`);
      return { col, op: f.op, value: value.toLowerCase() };
    }
    default:
      return { col, op: f.op, value: scalarFor(col, f.value, what) };
  }
}

/** FNV-1a over a string, as base 36: a short stable key, the same in every runtime. */
function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function utf8ToBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToUtf8(b64: string): string {
  const binary = atob(b64.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeCursor(c: ListCursor): string {
  return utf8ToBase64Url(JSON.stringify([c.key, c.nulls ? 1 : 0, c.value, c.id, c.total]));
}

export function decodeCursor(raw: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToUtf8(raw));
  } catch {
    throw new ListRequestError("invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) throw new ListRequestError("invalid cursor");
  const [key, nulls, value, id, total] = parsed as unknown[];
  const scalarOrNull = value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (typeof key !== "string" || (nulls !== 0 && nulls !== 1) || !scalarOrNull || typeof id !== "string" || typeof total !== "number") {
    throw new ListRequestError("invalid cursor");
  }
  return { key, nulls: nulls === 1, value: value as Scalar | null, id, total };
}

/** Validate a visibility scope against an object's columns: its owner field must be a text column. */
export function compileScope(columns: ReadonlyMap<string, ListColumn>, scope: OwnerScope | undefined): CompiledScope | null {
  if (!scope) return null;
  const col = columns.get(scope.field);
  if (!col || (col.kind !== "text" && col.kind !== "id")) throw new ListRequestError(`scope field ${scope.field} is not an owner column`);
  if (!Array.isArray(scope.owners) || scope.owners.length > SCOPE_IDS_MAX || scope.owners.some((o) => typeof o !== "string" || !o || o.length > TEXT_VALUE_MAX)) {
    throw new ListRequestError(`scope owners must be at most ${SCOPE_IDS_MAX} ids`);
  }
  return { col, owners: [...new Set(scope.owners)].sort(), unowned: scope.unowned === true };
}

/** Whether an owner value is inside a scope: an empty owner is inside when `unowned`. */
export function ownerAdmitted(s: { owners: readonly string[]; unowned: boolean } | null | undefined, owner: unknown): boolean {
  if (!s) return true;
  if (owner === null || owner === undefined || owner === "") return s.unowned;
  return typeof owner === "string" && s.owners.includes(owner);
}

/** Whether a row is inside a compiled scope, as the record service's SQL reads it. */
export const matchesScope = (row: ListRow, s: CompiledScope | null): boolean => !s || ownerAdmitted(s, cellOf(row, s.col));

/** Validate a list request against an object's definition. Throws ListRequestError on anything it cannot serve. */
export function compileListRequest(def: ResolvedObjectDef, req: ListRequest): CompiledList {
  const columns = listColumns(def);
  const limit = req.limit ?? LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) throw new ListRequestError(`limit must be 1 to ${LIST_LIMIT_MAX}`);
  const raw = req.filter ?? [];
  if (raw.length > FILTERS_MAX) throw new ListRequestError(`at most ${FILTERS_MAX} filters`);
  const filters = raw.map((f) => compileFilter(columns, f));
  const scope = compileScope(columns, req.scope);
  const sortReq = req.sort ?? { field: "updatedAt", dir: "desc" as const };
  const sortCol = columns.get(sortReq.field);
  if (!sortCol) throw new ListRequestError(`unknown sort field ${sortReq.field}`);
  if (sortCol.kind === "multi") throw new ListRequestError(`${sortReq.field} is a multi-select and cannot be sorted on`);
  if (sortReq.dir !== "asc" && sortReq.dir !== "desc") throw new ListRequestError("sort dir must be asc or desc");
  const deleted = req.deleted === true;
  const key = hashKey(JSON.stringify([
    def.apiName, deleted, sortCol.field, sortReq.dir,
    filters.map((f) => [f.col.field, f.op, "value" in f ? f.value : "values" in f ? f.values : null]),
    // A cursor is bound to the scope it was read under, so it cannot page past what another caller may see.
    ...(scope ? [[scope.col.field, scope.owners, scope.unowned]] : []),
  ]));
  let cursor: ListCursor | null = null;
  if (req.cursor) {
    cursor = decodeCursor(req.cursor);
    if (cursor.key !== key) throw new ListRequestError("cursor belongs to a different query");
    if (cursor.value !== null) scalarFor(sortCol, cursor.value, "cursor", Infinity);
  }
  return { object: def.apiName, filters, scope, sort: { col: sortCol, dir: sortReq.dir }, limit, deleted, cursor, key };
}

/** A record's list row: the fold state projected with the object's definition. */
export function listRowOf(def: ResolvedObjectDef, state: FoldState): ListRow {
  const row = project(def, state);
  return {
    id: state.streamId,
    object: def.apiName,
    version: state.version,
    status: state.lifecycle.status,
    title: titleOf(def, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    values: row.values,
  };
}

// In-memory evaluation, for the fake record client and for tests. The record
// service's SQL (services/record-service/src/projectionQuery.ts) means the same.

/** The value a row holds in a list column. */
export function cellOf(row: ListRow, col: ListColumn): FieldValue {
  switch (col.column) {
    case "id": return row.id;
    case "title": return row.title;
    case "created_at": return row.createdAt;
    case "updated_at": return row.updatedAt;
    default: return row.values[col.fieldId!] ?? null;
  }
}

function compareScalars(a: Scalar, b: Scalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether a row passes one compiled filter, as the record service's SQL reads it. */
export function matchesFilter(row: ListRow, f: CompiledFilter): boolean {
  const cell = cellOf(row, f.col);
  switch (f.op) {
    case "empty": return cell === null;
    case "notEmpty": return cell !== null;
    case "hasAny": return Array.isArray(cell) && f.values.some((v) => cell.includes(v as string));
    case "hasAll": return Array.isArray(cell) && f.values.every((v) => cell.includes(v as string));
    case "in": return cell !== null && !Array.isArray(cell) && f.values.some((v) => compareScalars(cell as Scalar, v) === 0);
    // IS DISTINCT FROM: an empty cell differs from every value.
    case "neq": return cell === null || Array.isArray(cell) || compareScalars(cell as Scalar, f.value) !== 0;
    default: {
      if (cell === null || Array.isArray(cell)) return false;
      const c = cell as Scalar;
      switch (f.op) {
        case "eq": return compareScalars(c, f.value) === 0;
        case "gt": return compareScalars(c, f.value) > 0;
        case "gte": return compareScalars(c, f.value) >= 0;
        case "lt": return compareScalars(c, f.value) < 0;
        case "lte": return compareScalars(c, f.value) <= 0;
        case "contains": return String(c).toLowerCase().includes(f.value as string);
        case "startsWith": return String(c).toLowerCase().startsWith(f.value as string);
      }
    }
  }
}

/** Sort order of a list: the sort column (empty cells last, whatever the direction), then id ascending. */
function compareForSort(sort: CompiledList["sort"], a: { cell: FieldValue; id: string }, b: { cell: FieldValue; id: string }): number {
  const an = a.cell === null;
  const bn = b.cell === null;
  if (an !== bn) return an ? 1 : -1;
  if (!an) {
    const c = compareScalars(a.cell as Scalar, b.cell as Scalar);
    if (c !== 0) return sort.dir === "asc" ? c : -c;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether a row's `status` belongs in the list: active rows, or deleted ones for the recycle bin. */
export const statusListed = (status: ListRow["status"], deleted: boolean) => status === (deleted ? "deleted" : "active");

export function listRowsInMemory(def: ResolvedObjectDef, rows: readonly ListRow[], req: ListRequest, projectedThrough: ProjectedThrough): ListResponse {
  const q = compileListRequest(def, req);
  const matched = rows.filter((r) => r.object === def.apiName && statusListed(r.status, q.deleted) && matchesScope(r, q.scope) && q.filters.every((f) => matchesFilter(r, f)));
  const keyed = matched.map((row) => ({ row, cell: cellOf(row, q.sort.col), id: row.id }));
  keyed.sort((a, b) => compareForSort(q.sort, a, b));
  const cursor = q.cursor;
  const after = cursor ? keyed.filter((k) => compareForSort(q.sort, k, { cell: cursor.value, id: cursor.id }) > 0) : keyed;
  const page = after.slice(0, q.limit);
  const total = cursor ? cursor.total : matched.length;
  const last = page[page.length - 1];
  const nextCursor = after.length > q.limit && last
    ? encodeCursor({ key: q.key, nulls: last.cell === null, value: last.cell as Scalar | null, id: last.id, total })
    : null;
  return { rows: page.map((k) => k.row), nextCursor, total, projectedThrough };
}

export type CompiledSearch = { q: string; limit: number; perObject: number; objects: readonly string[] | null; scopes: Readonly<Record<string, OwnerScope>> };

export function compileSearch(req: SearchRequest): CompiledSearch {
  const q = req.q.trim().toLowerCase();
  if (!q || q.length > 200) throw new ListRequestError("q must be 1 to 200 characters");
  const limit = req.limit ?? SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new ListRequestError(`limit must be 1 to ${SEARCH_LIMIT_MAX}`);
  const perObject = req.perObject ?? limit;
  if (!Number.isInteger(perObject) || perObject < 1 || perObject > limit) throw new ListRequestError("perObject must be 1 to limit");
  const scopes = req.scopes ?? {};
  for (const scope of Object.values(scopes)) {
    if (!Array.isArray(scope.owners) || scope.owners.length > SCOPE_IDS_MAX) throw new ListRequestError(`scope owners must be at most ${SCOPE_IDS_MAX} ids`);
  }
  return { q, limit, perObject, objects: req.objects?.length ? req.objects : null, scopes };
}

/** The values a hit carries beside its title: a company's domain, a person's email and company, a deal's amount and stage. */
export const SEARCH_DETAIL: Readonly<Record<string, readonly string[]>> = {
  account: ["domain"], contact: ["email", "company"], deal: ["amount", "currency", "stage"],
};

/** Search order: titles that start with `q` first, then the most recently updated; at most `perObject` per object, `limit` in all. */
export function rankSearchHits(hits: readonly SearchHit[], s: CompiledSearch): SearchHit[] {
  const prefix = (h: SearchHit) => Number(h.title.toLowerCase().startsWith(s.q));
  const sorted = [...hits].sort((a, b) => prefix(b) - prefix(a) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Map<string, number>();
  return sorted.filter((h) => {
    const n = taken.get(h.object) ?? 0;
    taken.set(h.object, n + 1);
    return n < s.perObject;
  }).slice(0, s.limit);
}

/** A list row as a search hit, with its object's detail values (standard fields, whose fieldId is the apiName). */
export function searchHitOf(r: ListRow): SearchHit {
  const fields = SEARCH_DETAIL[r.object] ?? [];
  const hit: SearchHit = { object: r.object, id: r.id, title: r.title, updatedAt: r.updatedAt };
  if (fields.length) hit.detail = Object.fromEntries(fields.map((f) => [f, (r.values[f] ?? null) as Scalar | null]));
  return hit;
}

/** Whether a search hit of `object` whose owner is `owner` is inside that object's scope (no scope: seen whole). */
export const searchAdmits = (s: CompiledSearch, object: string, owner: unknown): boolean => ownerAdmitted(s.scopes[object], owner);

/** Title search over list rows: active records whose title contains `q`, in search order. */
export function searchRowsInMemory(rows: readonly ListRow[], req: SearchRequest, projectedThrough: ProjectedThrough): SearchResponse {
  const s = compileSearch(req);
  // A standard field's fieldId is its apiName, so a scope's owner field reads straight off the row.
  const owner = (r: ListRow) => {
    const scope = s.scopes[r.object];
    return !scope ? null : scope.field === "id" ? r.id : r.values[scope.field] ?? null;
  };
  const matched = rows.filter((r) => r.status === "active" && r.object !== ASSOCIATION_OBJECT && (!s.objects || s.objects.includes(r.object))
    && searchAdmits(s, r.object, owner(r)) && r.title.toLowerCase().includes(s.q));
  return { hits: rankSearchHits(matched.map(searchHitOf), s), projectedThrough };
}

// Register lists (docs/cp0-object-layer.md, "One register of accounts and
// contacts"): the generic list pages read accounts and contacts from the
// record service's `accounts` and `contacts` tables, which hold every company
// and person the workspace knows, worked (`stream` set) or not. `p_account`
// and `p_contact` hold worked streams only. A register row's id is the record
// service's id, not a stream id.

export type RegisterObject = "account" | "contact";
export const isRegisterObject = (o: string): o is RegisterObject => o === "account" || o === "contact";

/**
 * Registry fieldId -> register column, for the fields the ledger owns on a
 * linked row. The record service's write-back (services/record-service
 * register.ts) uses the same map.
 */
export const REGISTER_COLUMNS: Readonly<Record<RegisterObject, Readonly<Record<string, string>>>> = {
  account: {
    name: "name", domain: "domain", industry: "industry", employees: "employees", country: "country", linkedinUrl: "linkedinUrl",
    status: "status", ownerId: "ownerId", phone: "phone", city: "city", description: "description", annualRevenue: "annualRevenue",
  },
  contact: {
    fullName: "fullName", title: "title", email: "email", additionalEmails: "additionalEmails", phone: "phone", additionalPhones: "additionalPhones", linkedinUrl: "linkedinUrl",
    ownerId: "ownerId", lifecycleStage: "lifecycleStage", leadStatus: "leadStatus",
  },
};

/**
 * Columns the record service derives, listed beside the registry's fields:
 * for accounts, ICP fit 0-100, revenue in USD, segments and the saved ICPs the
 * account passes; for contacts, their account's fit and ICPs, read at query
 * time (service 1.15.0). They are not registry fields, and nothing writes them
 * through the ledger. The ICP options are the workspace's, filled in where the
 * definition is described.
 */
const REGISTER_DERIVED: Readonly<Record<RegisterObject, readonly FieldDef[]>> = {
  account: [
    { fieldId: "fit" as FieldId, apiName: "fit", label: "Fit", type: "number" },
    { fieldId: "revenue" as FieldId, apiName: "revenue", label: "Revenue (USD)", type: "number" },
    { fieldId: "segmentIds" as FieldId, apiName: "segmentIds", label: "Segments", type: "multipicklist", options: [] },
    { fieldId: "icpIds" as FieldId, apiName: "icpIds", label: "ICPs", type: "multipicklist", options: [] },
  ],
  contact: [
    { fieldId: "accountFit" as FieldId, apiName: "accountFit", label: "Account fit", type: "number" },
    { fieldId: "accountIcpIds" as FieldId, apiName: "accountIcpIds", label: "Account ICPs", type: "multipicklist", options: [] },
  ],
};
export const REGISTER_DERIVED_FIELDS: Readonly<Record<RegisterObject, readonly string[]>> = {
  account: REGISTER_DERIVED.account.map((f) => f.apiName),
  contact: REGISTER_DERIVED.contact.map((f) => f.apiName),
};
/** The derived fields whose options are the workspace's saved ICPs. */
export const ICP_FIELDS: readonly string[] = ["icpIds", "accountIcpIds"];

/** Field order on the register pages: the fields people triage by first. */
const REGISTER_ORDER: Readonly<Record<RegisterObject, readonly string[]>> = {
  account: ["name", "domain", "industry", "employees", "country", "status", "ownerId", "fit", "revenue", "segmentIds"],
  contact: ["fullName", "title", "email", "additionalEmails", "phone", "additionalPhones", "linkedinUrl", "ownerId", "lifecycleStage", "leadStatus"],
};

/** A custom field (`custom.<slug>`): the register keeps its value in the row's `custom` JSON, keyed by apiName. */
export const isCustomField = (f: Pick<FieldDef, "apiName">) => CUSTOM_FIELD_API_NAME.test(f.apiName);

/**
 * An object's definition as its register lists it: the registry fields the
 * register has a column for, then the derived columns, then the custom fields
 * (kept in the row's `custom` JSON, service 1.22.0), then the last-modified
 * time. Archived custom fields and `createdAt` are left out: the register
 * keeps no creation time.
 */
export function registerListDef(object: RegisterObject, def: ResolvedObjectDef): ResolvedObjectDef {
  const columns = REGISTER_COLUMNS[object];
  const order = REGISTER_ORDER[object];
  const rank = (f: FieldDef) => (order.includes(f.apiName) ? order.indexOf(f.apiName) : order.length);
  const custom = def.fields.filter((f) => !f.system && isCustomField(f) && f.archivedAt === undefined);
  const fields = [...def.fields.filter((f) => !f.system && Object.hasOwn(columns, f.fieldId)), ...REGISTER_DERIVED[object]]
    .sort((a, b) => rank(a) - rank(b))
    .concat(custom);
  const updatedAt = def.fields.find((f) => f.system && f.apiName === "updatedAt");
  if (updatedAt) fields.push(updatedAt);
  return { ...def, fields, byApiName: new Map(fields.map((f) => [f.apiName, f])), byFieldId: new Map(fields.map((f) => [f.fieldId, f])) };
}

/** The definition an object's list views use (saved views validate against it): the register's for accounts and contacts. */
export const listViewDef = (object: string, def: ResolvedObjectDef): ResolvedObjectDef => (isRegisterObject(object) ? registerListDef(object, def) : def);

/** A register row as a list returns it: the row's own id, the stream it is linked to once worked, and a contact's account (service 1.12.0+). */
export type RegisterListRow = ListRow & { stream: string | null; accountId?: string };
export type RegisterListResponse = Omit<ListResponse, "rows"> & { rows: RegisterListRow[] };

/** The register column a list column reads. The register keeps no creation time: `createdAt` reads as last modified. Custom fields read `custom` (registerCustomKey). */
export function registerColumn(object: RegisterObject, col: ListColumn): string {
  if (registerCustomKey(col)) return "custom";
  switch (col.column) {
    case "id": return "id";
    case "title": return object === "account" ? "name" : "fullName";
    case "created_at":
    case "updated_at": return "updatedAt";
    default: {
      const column = REGISTER_COLUMNS[object][col.fieldId!] ?? REGISTER_DERIVED_FIELDS[object].find((f) => f === col.fieldId);
      if (!column) throw new ListRequestError(`${object} has no register column for ${col.field}`);
      return column;
    }
  }
}

/** The `custom` JSON key a register list column reads, or null for a column of its own. Only `custom.<slug>` keys, so the key is safe in a JSON path. */
export const registerCustomKey = (col: Pick<ListColumn, "fieldId">): string | null =>
  col.fieldId !== null && CUSTOM_FIELD_API_NAME.test(col.fieldId) ? col.fieldId : null;

/**
 * A register cell as a list value: empty text and empty lists are empty, as
 * the record service's SQL reads them. A list is sorted, except a multi-value
 * field's, whose first item is its primary.
 */
const registerCell = (v: unknown, field: FieldDef): FieldValue => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.length ? (isMultiValueType(field.type) ? v.map(String) : v.map(String).sort()) : null;
  return v as FieldValue;
};

/** A register row (record-service column names) as a list row of `def`, a registerListDef. */
export function registerListRow(object: RegisterObject, def: ResolvedObjectDef, r: Readonly<Record<string, unknown>>): RegisterListRow {
  const updatedAt = Number(r.updatedAt);
  const deletedAt = r.deletedAt === null || r.deletedAt === undefined ? null : Number(r.deletedAt);
  const values: Record<string, FieldValue> = {};
  const raw = r.custom;
  const custom = (typeof raw === "string" ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>;
  for (const f of def.fields) {
    if (f.system) continue;
    const col: ListColumn = { field: f.apiName, kind: "text", column: fieldColumn(f.fieldId), fieldId: f.fieldId };
    // A formula or rollup is computed by the list query into a column of its own (services/record-service/src/computed.ts).
    const key = f.type === "formula" ? null : registerCustomKey(col);
    values[f.fieldId] = registerCell(f.type === "formula" ? r[col.column] : key ? custom[key] : r[registerColumn(object, col)], f);
  }
  return {
    id: String(r.id), object, version: Number(r.version ?? 1), status: deletedAt === null ? "active" : "deleted",
    title: String(r[object === "account" ? "name" : "fullName"] ?? ""), createdAt: updatedAt, updatedAt, deletedAt, values,
    stream: typeof r.stream === "string" && r.stream ? r.stream : null,
    ...(object === "contact" ? { accountId: typeof r.accountId === "string" ? r.accountId : "" } : {}),
  };
}
