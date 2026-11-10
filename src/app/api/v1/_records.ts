/**
 * The record API's verbs (docs/record-api.md). Objects and fields come from
 * `objects.describe`, the registry's own answer for the caller's workspace, so
 * a new field or object needs no code here. Every read and write calls the
 * Convex function the MCP `canon_*` record tools call, as the token's user:
 * nothing here writes around the evidence gate or the version check.
 */
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { FILTER_OPS, type FilterOp, type ReportBucket } from "../../../../modules/kernel/reportLanguage.ts";
import { ConvexError } from "convex/values";
import { V1Error, toV1Error, type V1Client, type V1Result } from "./_lib.ts";
import type { FieldValue as RegistryValue } from "../../../../convex/lib/objects/registry.ts";
import type { Stored } from "../../../../convex/lib/objects/validators.ts";
import { parseSplits } from "../../../../modules/kernel/splits.ts";
import { setRecordLifecycle, type LifecycleOp } from "../../mcp/_recordLifecycle.ts";
import { isGenericObject } from "../../../../convex/lib/objects/describe.ts";
import { columnKind, type ColumnKind } from "../../../../convex/lib/objects/listSpec.ts";
import { GROUP_QUERY, LIST_QUERY, readQuery, VERSION_QUERY, WRITE_MESSAGES, WriteBody, type ApiRecord } from "./_contract.ts";

type FieldValue = Stored<RegistryValue>;
type Field = { fieldId: string; apiName: string; type: string; system?: boolean; returns?: string };
type Described = { fields: Field[]; readOnlyFields?: string[]; register: boolean; canCreate: boolean; canDelete: boolean; writable: boolean };

export type { ApiRecord };

const isFieldValue = (x: unknown): x is FieldValue =>
  x === null || ["string", "number", "boolean"].includes(typeof x) || (Array.isArray(x) && (x.every((i) => typeof i === "string") || parseSplits(x).ok));

async function describe(client: V1Client, object: string): Promise<Described> {
  const def = (await client.query(api.objects.describe, { object })) as Described | null;
  if (!def) throw new V1Error("unknown_object", `No record object named ${object}`);
  return def;
}

function toApiRecord(def: Described, r: { id: string; object: string; version: number; status: string; title: string; values: Record<string, unknown>; createdAt: number; updatedAt: number; deletedAt: number | null }): ApiRecord {
  const names = new Map(def.fields.map((f) => [f.fieldId, f.apiName]));
  const values = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [names.get(k) ?? k, v])) as Record<string, FieldValue>;
  return { id: r.id, object: r.object, version: r.version, status: r.status as ApiRecord["status"], title: r.title, values, createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt: r.deletedAt };
}

// ---- list ----

/** A datetime filter value: epoch milliseconds, or an ISO date and time with a timezone. */
function epochMs(s: string, field: string): number {
  const ms = /^-?\d+$/.test(s) ? Number(s) : /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? Date.parse(s) : NaN;
  if (!Number.isFinite(ms)) throw new V1Error("invalid_request", `${field} filters take epoch milliseconds or a date and time with a timezone`);
  return ms;
}

/** What a filter value is, by the list column kind of its field (listSpec columnKind), the table the list itself checks values against. */
const FILTER_VALUE: Readonly<Record<ColumnKind, (s: string, field: string, datetime: boolean) => string | number | boolean>> = {
  id: (s) => s, text: (s) => s, multi: (s) => s, date: (s) => s,
  number: (s, field, datetime) => {
    if (datetime) return epochMs(s, field);
    if (s.trim() === "" || !Number.isFinite(Number(s))) throw new V1Error("invalid_request", `${field} filters take a number`);
    return Number(s);
  },
  checkbox: (s, field) => {
    if (s !== "true" && s !== "false") throw new V1Error("invalid_request", `${field} filters take true or false`);
    return s === "true";
  },
};

/** A filter field's column kind, and whether its numbers are epoch milliseconds. An unknown field passes as text for the list to refuse. */
function filterColumn(def: Described, field: string): { kind: ColumnKind; datetime: boolean } {
  if (field === "id") return { kind: "id", datetime: false };
  if (field === "createdAt" || field === "updatedAt") return { kind: "number", datetime: true };
  const f = def.fields.find((x) => x.apiName === field);
  const kind = f ? columnKind(f as never) : null;
  return { kind: kind ?? "text", datetime: f?.type === "datetime" || (f?.type === "formula" && f.returns === "datetime") };
}

/** `field:op:value`, a list value comma-separated, typed by the field. `empty` and `notEmpty` take no value. */
function parseFilter(def: Described, text: string) {
  const [field, op, ...rest] = text.split(":");
  if (!field || !op || !(FILTER_OPS as readonly string[]).includes(op)) throw new V1Error("invalid_request", LIST_QUERY[0]!.message);
  if (op === "empty" || op === "notEmpty") return { field, op: op as FilterOp };
  const { kind, datetime } = filterColumn(def, field);
  const scalar = (s: string) => FILTER_VALUE[kind](s, field, datetime);
  const raw = rest.join(":");
  return { field, op: op as FilterOp, value: op === "in" || op === "hasAny" || op === "hasAll" ? raw.split(",").map(scalar) : scalar(raw) };
}

export async function listRecords(client: V1Client, object: string, params: URLSearchParams): Promise<V1Result> {
  readQuery(LIST_QUERY, params);
  const def = await describe(client, object);
  const limit = params.get("limit");
  const deleted = params.get("deleted");
  const sort = params.get("sort");
  const [sortField, sortDir = "asc"] = sort ? sort.split(":") : [];
  const page = await client.action(api.objects.list, {
    object: object as never,
    filter: params.getAll("filter").map((f) => parseFilter(def, f)),
    ...(sort ? { sort: { field: sortField, dir: sortDir as "asc" | "desc" } } : {}),
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    ...(deleted === "true" ? { deleted: true } : {}),
  } as never);
  return { status: 200, body: { data: page.rows.map((r) => toApiRecord(def, r)), nextCursor: page.nextCursor, total: page.total } };
}

/** An object's records grouped by `field` (a date by `bucket`), as `objects.groups` counts them for a grouped list. */
export async function groupRecords(client: V1Client, object: string, params: URLSearchParams): Promise<V1Result> {
  readQuery(GROUP_QUERY, params);
  const def = await describe(client, object);
  const field = params.get("field")!;
  const bucket = params.get("bucket");
  const res = await client.action(api.objects.groups, {
    object, filter: params.getAll("filter").map((f) => parseFilter(def, f)), group: { field, ...(bucket ? { bucket: bucket as ReportBucket } : {}) },
  });
  return { status: 200, body: { data: res.groups, rows: res.rows, sum: res.sum, summed: res.summed, truncated: res.truncated } };
}

/**
 * Objects whose records the API creates, archives and restores (the ledger's, deals, companies and people). For
 * these a caller whose role may not is refused by the Convex function, as on the dashboard (403), not told the verb
 * does not exist (405).
 */
const hasRecordWrites = (def: Described, object: string) => def.register || object === "deal" || isGenericObject(object);

/** The body a write needs, with the object's own field names, so a caller can fix it in one try. */
function missingValues(def: Described, object: string): V1Error {
  const fields = def.fields.filter((f) => !f.system && !def.readOnlyFields?.includes(f.apiName)).map((f) => f.apiName);
  return new V1Error("invalid_request", `values is required: send {"values": {<field>: value}}; ${object} fields: ${fields.join(", ")}`);
}

// ---- get ----

/** A path id Convex cannot parse as one of its ids is a record that does not exist. */
async function byId<T>(object: string, id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && /ArgumentValidationError|Validator error/i.test(error.message)) throw new V1Error("not_found", `No ${object} ${id}`);
    throw error;
  }
}

/** `archived`: look among archived records first (just after an archive), else active ones first. */
async function fetchRecord(client: V1Client, def: Described, object: string, id: string, archived = false): Promise<ApiRecord> {
  if (def.register) {
    // Accounts and contacts live in the register under their record id; the list is the one read that serves both.
    const read = (deleted: boolean) => client.action(api.objects.list, { object: object as never, filter: [{ field: "id", op: "eq", value: id }], limit: 1, ...(deleted ? { deleted: true } : {}) });
    // An archived company or person reads as archived, as an archived ledger record does, not as missing.
    const row = (await read(archived)).rows[0] ?? (await read(!archived)).rows[0];
    if (!row) throw new V1Error("not_found", `No ${object} ${id}`);
    return toApiRecord(def, row);
  }
  const rec = await byId(object, id, () => client.query(api.objects.get, { streamId: id as Id<"canonEntities"> }));
  if (!rec || rec.object !== object) throw new V1Error("not_found", `No ${object} ${id}`);
  // Formula and rollup fields (CP7c) are computed by the list read, not held on the record.
  const computed = def.fields.filter((f) => f.type === "formula");
  const listed = computed.length && rec.lifecycle.status === "active"
    ? (await client.action(api.objects.list, { object: object as never, filter: [{ field: "id", op: "eq", value: id }], limit: 1 })).rows[0]
    : undefined;
  return toApiRecord(def, {
    id, object: rec.object, version: rec.version, status: rec.lifecycle.status, title: rec.title,
    values: { ...rec.values, ...Object.fromEntries(computed.map((f) => [f.fieldId, listed?.values[f.fieldId] ?? null])) },
    createdAt: rec.createdAt, updatedAt: rec.updatedAt, deletedAt: rec.lifecycle.status === "deleted" ? rec.lifecycle.at : null,
  });
}

export async function getRecord(client: V1Client, object: string, id: string): Promise<V1Result> {
  return { status: 200, body: { data: await fetchRecord(client, await describe(client, object), object, id) } };
}

// ---- writes ----

function parseBody(body: unknown) {
  const parsed = WriteBody.safeParse(body);
  const values = parsed.success ? parsed.data.values : undefined;
  if (!parsed.success || (values !== undefined && !Object.values(values).every(isFieldValue))) {
    const field = parsed.success ? "values" : String(parsed.error.issues[0]!.path[0] ?? "");
    throw new V1Error("invalid_request", WRITE_MESSAGES[field] ?? WRITE_MESSAGES[""]!);
  }
  return { ...parsed.data, values: values as Record<string, FieldValue> | undefined };
}

type SaveResult =
  | { status: "applied" | "proposed"; streamId: string; version: number }
  | { status: "unchanged"; streamId: string; version: number }
  | { status: "conflict"; streamId: string; version: number; expectedVersion: number }
  | { status: "invalid"; errors: Array<{ field: string; message: string }> };

/** A ledger save's result as an HTTP result. A proposal is accepted for review (202), not applied. */
async function saved(client: V1Client, def: Described, object: string, result: SaveResult, created: boolean): Promise<V1Result> {
  if (result.status === "conflict") {
    throw new V1Error("version_conflict", `The record is at version ${result.version}, not ${result.expectedVersion}`, { currentVersion: result.version, expectedVersion: result.expectedVersion });
  }
  if (result.status === "invalid") throw new V1Error("validation_failed", "Some values were rejected", { errors: result.errors.map((e) => ({ field: e.field, message: e.message })) });
  const record = result.status === "proposed" ? undefined : await fetchRecord(client, def, object, result.streamId).catch(() => undefined);
  return { status: result.status === "proposed" ? 202 : created ? 201 : 200, body: { status: result.status, id: result.streamId, version: result.version, ...(record ? { data: record } : {}) } };
}

const agentOptions = (b: ReturnType<typeof parseBody>) => ({
  ...(b.source ? { sourceKind: b.source as never } : {}),
  ...(b.evidence !== undefined ? { evidence: b.evidence } : {}),
  ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
});

/**
 * A company or person write whose values the registry or an org rule refuses is a 422, not a 400: Convex throws the
 * refusal as a ConvexError of its message. A missing record or a role check keeps its own code.
 */
async function registerWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const mapped = toV1Error(error);
    if (!(error instanceof ConvexError) || mapped.code !== "invalid_request") throw mapped;
    if (/not found/i.test(mapped.message)) throw new V1Error("not_found", mapped.message);
    throw new V1Error("validation_failed", mapped.message);
  }
}

/** Every create the record API makes; with a key, each kind runs it through convex/lib/idempotency.ts once. */
export async function createRecord(client: V1Client, object: string, body: unknown, idempotencyKey?: string): Promise<V1Result> {
  const def = await describe(client, object);
  const b = parseBody(body);
  if (!b.values) throw missingValues(def, object);
  if (b.expectedVersion !== undefined) throw new V1Error("invalid_request", "expectedVersion applies to updates");
  if (!def.canCreate && !hasRecordWrites(def, object)) throw new V1Error("unsupported", `${object} records cannot be created through the API`);
  if (def.register) {
    // Companies and people are added to the register fill-only (dedupe by domain or person), not written to the ledger.
    if (b.source) throw new V1Error("invalid_request", "source applies to ledger objects, not companies and people");
    const key = idempotencyKey ?? globalThis.crypto.randomUUID();
    const res = (await registerWrite(() => client.action(api.records.upsert, { object: object as "account" | "contact", [object === "account" ? "accounts" : "contacts"]: [b.values], idempotencyKey: key } as never))) as { upserted: number; ids: string[]; rejected?: Array<{ reason: string }> };
    if (!res.ids.length) throw new V1Error("validation_failed", "The record was rejected", { errors: (res.rejected ?? []).map((r) => ({ field: "values", message: r.reason })) });
    return { status: 201, body: { status: "applied", id: res.ids[0] } };
  }
  if (object === "deal") {
    // deals.create has no proposal path: never apply an agent-marked create as a user write.
    if (b.source && b.source !== "user") throw new V1Error("invalid_request", "Deals cannot be created as proposals; omit source");
    // Custom field values go in `custom`; deals.create takes the standard ones as arguments.
    const entries = Object.entries(b.values);
    const custom = Object.fromEntries(entries.filter(([k]) => k.startsWith("custom.")));
    const standard = Object.fromEntries(entries.filter(([k]) => !k.startsWith("custom.")));
    const res = await client.action(api.deals.createScoped, { ...standard, ...(Object.keys(custom).length ? { custom } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) } as never);
    return { status: 201, body: { status: "applied", id: res.streamId } };
  }
  return saved(client, def, object, (await client.action(api.objects.writeScoped, { object: object as never, values: b.values, ...agentOptions(b), ...(idempotencyKey ? { idempotencyKey } : {}) })) as SaveResult, true);
}

export async function updateRecord(client: V1Client, object: string, id: string, body: unknown): Promise<V1Result> {
  const def = await describe(client, object);
  const b = parseBody(body);
  if (!b.values) throw missingValues(def, object);
  if (!def.writable) throw new V1Error("forbidden", `You cannot edit ${object} records`);
  if (def.register) {
    if (b.expectedVersion !== undefined) throw new V1Error("unsupported", "Companies and people have no version check; omit expectedVersion");
    if (b.source) throw new V1Error("invalid_request", "source applies to ledger objects, not companies and people");
    // A field the register does not take an edit of (a company's domain, a name nobody defined) is a refused value, named, not a crash.
    const refused = Object.keys(b.values).filter((name) => {
      const field = def.fields.find((f) => f.apiName === name);
      return !field || field.system || def.readOnlyFields?.includes(name);
    });
    if (refused.length) {
      throw new V1Error("validation_failed", "Some values were rejected", { errors: refused.map((field) => ({ field, message: `${field} cannot be edited on ${object} records` })) });
    }
    // Lists and booleans are custom fields' values (multi-selects, checkboxes, emails); records.edit checks each against the registry.
    const patch: Record<string, string | number | boolean | null | string[]> = {};
    for (const [field, value] of Object.entries(b.values)) {
      if (value !== null && typeof value === "object") {
        if (!value.every((v): v is string => typeof v === "string")) throw new V1Error("validation_failed", "Credit splits belong to deals");
        patch[field] = value;
      } else patch[field] = value;
    }
    const res = await registerWrite(() => client.action(api.records.edit, { object: object as "account" | "contact", id, patch, idempotencyKey: globalThis.crypto.randomUUID() }));
    return { status: 200, body: { status: "applied", id, version: res.version } };
  }
  const result = await byId(object, id, () => client.action(api.objects.writeScoped, {
    object: object as never, streamId: id as Id<"canonEntities">, values: b.values!,
    ...(b.expectedVersion !== undefined ? { expectedVersion: b.expectedVersion } : {}), ...agentOptions(b),
  }));
  return saved(client, def, object, result as SaveResult, false);
}

/**
 * Archive or restore, through the dashboard's function for the object (src/lib/recordLifecycle.ts). A role that may
 * not archive is refused by that function (403), as on the dashboard; 405 is for an object with no archive at all.
 */
async function lifecycle(client: V1Client, object: string, id: string, searchParams: URLSearchParams, op: LifecycleOp): Promise<V1Result> {
  const def = await describe(client, object);
  if (!def.canDelete && !hasRecordWrites(def, object)) throw new V1Error("unsupported", `${object} records cannot be deleted or restored through the API`);
  readQuery(VERSION_QUERY, searchParams, false);
  const raw = searchParams.get("expectedVersion");
  if (def.register && raw !== null) throw new V1Error("unsupported", "Companies and people have no version check; omit expectedVersion");
  const result = await byId(object, id, () => setRecordLifecycle(client, { object, id, op, ...(raw !== null ? { expectedVersion: Number(raw) } : {}) }));
  if (!def.register) return saved(client, def, object, result as SaveResult, false);
  if (result.status === "invalid") {
    const message = result.errors.map((e) => e.message).join("; ");
    throw /not found/i.test(message) ? new V1Error("not_found", `No ${object} ${id}`) : new V1Error("validation_failed", message, { errors: result.errors });
  }
  const record = await fetchRecord(client, def, object, id, op === "delete");
  return { status: 200, body: { status: result.status, id, version: record.version, data: record } };
}

export const deleteRecord = (client: V1Client, object: string, id: string, params: URLSearchParams) => lifecycle(client, object, id, params, "delete");
export const restoreRecord = (client: V1Client, object: string, id: string, params: URLSearchParams) => lifecycle(client, object, id, params, "restore");
