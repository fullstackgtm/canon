/**
 * The record API's request and response shapes, declared once. The routes
 * parse with these schemas and the OpenAPI document (_openapi.ts) is built
 * from them, with each object's `values` from its registry fields. A shape
 * changed here changes both; a route that answers something else fails
 * tests/recordApiConformance.test.ts.
 */
import { z } from "zod";
import { AGENT_SOURCES } from "../../../../convex/lib/canon/gate.ts";
import { DEAL_ROLES } from "../../../../convex/lib/objects/registry.ts";
import { LIST_LIMIT_MAX } from "../../../../convex/lib/objects/listSpec.ts";
import { FILTER_OPS, REPORT_BUCKETS } from "../../../../modules/kernel/reportLanguage.ts";
import { V1_ERROR_CODES, V1Error, type V1ErrorCode } from "./_lib.ts";

/** The API's own version (`info.version`): the major is the path's (`/api/v1`). Bump the minor for a new stable operation or field. */
export const API_VERSION = "1.3.0";

// ---- query strings ----

/** One query-string parameter: its value as text, the pattern it must match, and what a caller is told when it does not. */
export type QueryParam = { name: string; schema: z.ZodString | z.ZodEnum; message: string; description: string; required?: boolean; repeat?: boolean };

const opPattern = FILTER_OPS.join("|");
const FILTER: QueryParam = {
  name: "filter", repeat: true, schema: z.string().regex(new RegExp(`^[^:]+:(${opPattern})(:[\\s\\S]*)?$`)),
  message: `filter must be field:op:value with op one of ${FILTER_OPS.join(", ")}`,
  description: "`field:op:value`, repeated to combine with AND. A list value (`in`, `hasAny`, `hasAll`) is comma-separated; `empty` and `notEmpty` take no value. Number, currency and checkbox fields take a number or true/false.",
};

export const LIST_QUERY: readonly QueryParam[] = [
  FILTER,
  { name: "sort", schema: z.string().regex(/^[^:]+(:(asc|desc)(:.*)?)?$/), message: "sort must be field or field:asc|desc", description: "`field` or `field:asc|desc` (ascending by default)." },
  { name: "limit", schema: z.string().regex(/^\d+$/), message: "limit must be a whole number", description: `Records per page, 1 to ${LIST_LIMIT_MAX}.` },
  { name: "cursor", schema: z.string(), message: "cursor must be text", description: "The `nextCursor` of the previous page." },
  { name: "deleted", schema: z.enum(["true", "false"]), message: "deleted must be true or false", description: "`true` lists archived records instead." },
];

export const GROUP_QUERY: readonly QueryParam[] = [
  { name: "field", required: true, schema: z.string().min(1), message: "field is required: the field to group by", description: "The apiName of a picklist, owner, lookup, yes/no or date field." },
  { name: "bucket", schema: z.enum(REPORT_BUCKETS), message: `bucket must be one of ${REPORT_BUCKETS.join(", ")}`, description: "How a date groups; `month` by default. Date-times bucket by UTC day." },
  FILTER,
];

export const VERSION_QUERY: readonly QueryParam[] = [
  { name: "expectedVersion", schema: z.string().regex(/^\d+$/), message: "expectedVersion must be a non-negative integer", description: "Fail with 409 instead of acting when the record has moved past this version." },
];

/** The values of `params` named in `spec`, each checked against its pattern; an unknown name is refused when `strict`. */
export function readQuery(spec: readonly QueryParam[], params: URLSearchParams, strict = true): void {
  for (const key of params.keys()) if (strict && !spec.some((p) => p.name === key)) throw new V1Error("invalid_request", `Unknown query parameter ${key}`);
  for (const p of spec) {
    const values = params.getAll(p.name);
    if (p.required && !values.length) throw new V1Error("invalid_request", p.message);
    if (values.some((v) => !p.schema.safeParse(v).success)) throw new V1Error("invalid_request", p.message);
  }
}

// ---- request bodies ----

export const SOURCES = ["user", ...AGENT_SOURCES] as const;

/**
 * A record write. `values` is checked here only as values (scalars, string lists, credit splits); the object's own
 * fields check each one (registry `coerce`), and the document describes them per object.
 */
export const WriteBody = z.object({
  values: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().min(0).optional(),
  source: z.enum(SOURCES).optional(),
  evidence: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const WRITE_MESSAGES: Record<string, string> = {
  "": "Send a JSON object body",
  values: "values must map field apiNames to scalar values, string lists or valid credit splits",
  expectedVersion: "expectedVersion must be a non-negative integer",
  source: `source must be one of ${SOURCES.join(", ")}`,
  evidence: "evidence must be text",
  confidence: "confidence must be a number from 0 to 1",
};

const ids = z.array(z.string());
const MERGE_OBJECTS = ["account", "contact"] as const;
export const ACTIVITY_OBJECTS = ["note", "task", "call", "meeting"] as const;
export const TIMELINE_OBJECTS = ["account", "contact", "deal"] as const;

export const DismissBody = z.object({ ids: ids.describe("2 to 8 record ids that are not duplicates") });
export const MergePreviewBody = z.object({ ids });
export const MergeBody = z.object({
  survivorId: z.string(),
  loserIds: ids,
  picks: z.record(z.string(), z.string()).optional().describe("Field apiName to the id of the record whose value survives; an unnamed field keeps the survivor's"),
});
const link = { contactId: z.string(), accountId: z.string() };
export const AssociationBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("link"), ...link, primary: z.boolean().optional() }),
  z.object({ op: z.literal("unlink"), ...link }),
  z.object({ op: z.literal("make_primary"), ...link }),
  z.object({ op: z.literal("set_parent"), accountId: z.string(), parentId: z.string().nullable().optional().describe("null or absent removes the parent") }),
]);
export const DealRoleBody = z.object({ contactId: z.string(), role: z.enum(DEAL_ROLES), reason: z.string().optional() });
export const ActivityBody = z.object({
  object: z.enum(ACTIVITY_OBJECTS),
  values: z.record(z.string(), z.unknown()).optional().describe("The activity's field values by apiName"),
  targets: z.array(z.object({ object: z.enum(TIMELINE_OBJECTS), id: z.string() })).optional(),
});
export const SALESFORCE_OBJECTS = ["Account", "Contact", "Lead", "Opportunity", "Task", "Event", "Note", "ContentDocument"] as const;
export const SpotCheckBody = z.object({ object: z.enum(SALESFORCE_OBJECTS), sfIds: z.array(z.string()) });

/**
 * A relationship write's body, parsed: a body that is not an object, or names no known `op`, is a 400; a field of the
 * wrong type is a 422 naming it, as the Convex validator behind the route answers.
 */
export function parseBody<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new V1Error("invalid_request", "The body must be a JSON object");
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const field = issue.path.join(".");
  if (field === "op") throw new V1Error("invalid_request", "op must be one of link, unlink, make_primary, set_parent");
  const message = issue.code === "invalid_value" ? `${field} must be one of ${issue.values.join(", ")}`
    : issue.code === "invalid_type" && issue.input === undefined ? `${field} is required`
      : issue.code === "invalid_type" ? `${field} must be ${issue.expected === "array" ? "a list" : issue.expected}` : `${field}: ${issue.message}`;
  throw new V1Error("validation_failed", "Some values were rejected", { errors: [{ field, message }] });
}

// ---- responses ----

const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), z.array(z.object({ userId: z.string(), percentage: z.number(), kind: z.enum(["revenue", "overlay"]) }))]);

/** A record as the API returns it. `values` is keyed by field apiName; the document gives each object's fields. */
export const ApiRecordSchema = z.object({
  id: z.string().describe("A company's or person's register id (acc_…, con_…), else the record's stream id"),
  object: z.string(),
  version: z.number().int(),
  status: z.enum(["active", "deleted", "merged"]),
  title: z.string(),
  values: z.record(z.string(), FieldValue),
  createdAt: z.number().int().describe("Epoch milliseconds"),
  updatedAt: z.number().int().describe("Epoch milliseconds"),
  deletedAt: z.number().int().nullable().describe("When it was archived, epoch milliseconds"),
});
export type ApiRecord = z.infer<typeof ApiRecordSchema>;

export const ListPage = z.object({ data: z.array(ApiRecordSchema), nextCursor: z.string().nullable(), total: z.number().int() });
export const RecordBody = z.object({ data: ApiRecordSchema });
export const WriteResult = z.object({
  status: z.enum(["applied", "proposed", "unchanged"]).describe("`proposed`: held for a reviewer (202); nothing changed yet"),
  id: z.string(),
  version: z.number().int().optional(),
  data: ApiRecordSchema.optional().describe("The record after the write; absent for a proposal"),
});
export const GroupsBody = z.object({
  data: z.array(z.object({ key: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe("null holds the records with no value"), count: z.number().int(), sum: z.number().nullable() })),
  rows: z.number().int(),
  sum: z.number().nullable().describe("A deal's amount in cents, when the caller may read it"),
  summed: z.string().nullable(),
  truncated: z.boolean().describe("More than 100 groups matched"),
});
/** `GET /objects`: each object the caller reads, its fields as their role sees them, and the verbs they may use. */
export const ObjectsBody = z.object({
  data: z.array(z.object({
    object: z.string().describe("The apiName the record routes take"),
    label: z.string(),
    pluralLabel: z.string(),
    kind: z.enum(["standard", "custom"]),
    writable: z.boolean(),
    canCreate: z.boolean(),
    canDelete: z.boolean(),
    fields: z.array(z.object({
      apiName: z.string(),
      label: z.string(),
      type: z.string().describe("text, number, currency, date, datetime, checkbox, picklist, multipicklist, lookup, user, emails, phones, links, splits or formula"),
      required: z.boolean(),
      unique: z.boolean().describe("No two records may hold one value (a list field's items each count)"),
      readOnly: z.boolean(),
      options: z.array(z.object({ value: z.string(), label: z.string(), active: z.boolean() })).optional(),
      lookupTo: z.string().optional(),
    })),
  })),
});

/** A relationship route's answer: `data` is what the Convex function behind it returns. */
export const DataBody = z.object({ data: z.unknown() });

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(V1_ERROR_CODES),
    message: z.string(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })).optional().describe("422: each rejected field and what it takes"),
    currentVersion: z.number().int().optional(),
    expectedVersion: z.number().int().optional(),
    requestId: z.string().optional().describe("Quote it when reporting an internal error"),
  }),
});

// ---- operations ----

export type Stability = "stable" | "preview";

/** Which objects a per-object operation exists for, by what `objects.describe` says the caller may do. */
export type ObjectGate = "all" | "create" | "edit" | "delete" | "merge" | "timeline";

/**
 * One operation: its route (the folder under src/app/api/v1, Next's `[param]` form), method and shapes. `object` ops
 * are listed once per object; their `values` come from that object's fields. `stability` follows docs/record-api.md:
 * `stable` for what it documents, `preview` for the rest. `since` is the day it shipped.
 */
export type Operation = {
  id: string;
  route: string;
  method: "get" | "post" | "patch" | "delete";
  summary: string;
  stability: Stability;
  since: string;
  /** Present for an operation listed per object. */
  object?: ObjectGate;
  query?: readonly QueryParam[];
  /** A body schema, or the record write named. */
  body?: z.ZodType | "create" | "update";
  headers?: readonly { name: string; description: string }[];
  /** Status to answer: a schema, or the record answer named, which the document types per object. */
  responses: Readonly<Record<number, z.ZodType | "record" | "list" | "write">>;
  errors: readonly V1ErrorCode[];
  /** Parts not described yet, and why: the document marks them `x-canon-undescribed` instead of guessing. */
  undescribed?: string;
  /** Another bearer than the API token. */
  security?: "exportKey" | "importKey";
};

/** Every create takes one (convex/lib/idempotency.ts). */
const IDEMPOTENCY_KEY = {
  name: "Idempotency-Key",
  description: "Up to 200 characters, unique per create: a UUID. A retry with the same key and body answers as the first request did and creates nothing; the same key with another body is refused with `idempotency_key_reused`. Kept for 24 hours, for your user in this workspace.",
} as const;

const RECORD_ERRORS = ["unknown_object", "not_found"] as const;
/** 405: `expectedVersion` sent for a company or person, which have no version check. */
const LIFECYCLE_ERRORS = [...RECORD_ERRORS, "invalid_request", "validation_failed", "version_conflict", "unsupported"] as const;
const UNDESCRIBED_DATA = "`data` is what the Convex function behind the route returns; it has no declared validator yet.";

export const OPERATIONS: readonly Operation[] = [
  { id: "list", route: "records/[object]", method: "get", object: "all", summary: "List records", stability: "stable", since: "2026-10-10", query: LIST_QUERY, responses: { 200: "list" }, errors: ["unknown_object", "invalid_request"] },
  {
    id: "create", route: "records/[object]", method: "post", object: "create", summary: "Create a record", stability: "stable", since: "2026-10-10", body: "create",
    headers: [IDEMPOTENCY_KEY],
    responses: { 201: "write", 202: "write" }, errors: ["unknown_object", "invalid_request", "validation_failed", "idempotency_key_reused", "unsupported"],
  },
  { id: "get", route: "records/[object]/[id]", method: "get", object: "all", summary: "Get a record", stability: "stable", since: "2026-10-10", responses: { 200: "record" }, errors: RECORD_ERRORS },
  { id: "update", route: "records/[object]/[id]", method: "patch", object: "edit", summary: "Update a record", stability: "stable", since: "2026-10-10", body: "update", responses: { 200: "write", 202: "write" }, errors: [...RECORD_ERRORS, "invalid_request", "validation_failed", "version_conflict", "unsupported"] },
  { id: "delete", route: "records/[object]/[id]", method: "delete", object: "delete", summary: "Archive a record", stability: "stable", since: "2026-10-10", query: VERSION_QUERY, responses: { 200: "write" }, errors: LIFECYCLE_ERRORS },
  { id: "restore", route: "records/[object]/[id]/restore", method: "post", object: "delete", summary: "Restore an archived record", stability: "stable", since: "2026-10-10", query: VERSION_QUERY, responses: { 200: "write" }, errors: LIFECYCLE_ERRORS },
  { id: "group", route: "records/[object]/groups", method: "get", object: "all", summary: "Count records by one field's values", stability: "stable", since: "2026-11-09", query: GROUP_QUERY, responses: { 200: GroupsBody }, errors: ["unknown_object", "invalid_request"] },
  { id: "timeline", route: "records/[object]/[id]/activities", method: "get", object: "timeline", summary: "A record's activity timeline", stability: "stable", since: "2026-10-10", responses: { 200: DataBody }, errors: RECORD_ERRORS, undescribed: UNDESCRIBED_DATA },
  { id: "duplicates", route: "records/[object]/duplicates", method: "get", object: "merge", summary: "Probable duplicates", stability: "stable", since: "2026-10-10", responses: { 200: DataBody }, errors: ["unknown_object"], undescribed: UNDESCRIBED_DATA },
  { id: "dismissDuplicates", route: "records/[object]/duplicates/dismiss", method: "post", object: "merge", summary: "Mark records as not duplicates", stability: "stable", since: "2026-10-10", body: DismissBody, responses: { 200: DataBody }, errors: ["unknown_object", "invalid_request", "validation_failed"], undescribed: UNDESCRIBED_DATA },
  { id: "previewMerge", route: "records/[object]/merge/preview", method: "post", object: "merge", summary: "Preview a merge", stability: "stable", since: "2026-10-10", body: MergePreviewBody, responses: { 200: DataBody }, errors: ["unknown_object", "invalid_request", "validation_failed"], undescribed: UNDESCRIBED_DATA },
  { id: "merge", route: "records/[object]/merge", method: "post", object: "merge", summary: "Merge records", stability: "stable", since: "2026-10-10", body: MergeBody, responses: { 200: DataBody }, errors: ["unknown_object", "invalid_request", "validation_failed"], undescribed: UNDESCRIBED_DATA },
  { id: "undoMerge", route: "merges/[mergeId]/undo", method: "post", summary: "Undo a merge", stability: "stable", since: "2026-10-10", responses: { 200: DataBody }, errors: ["not_found", "invalid_request"], undescribed: UNDESCRIBED_DATA },
  {
    id: "related", route: "associations", method: "get", summary: "A company's or person's links", stability: "stable", since: "2026-10-10",
    query: [
      { name: "object", required: true, schema: z.enum(MERGE_OBJECTS), message: "Pass object=account|contact and id", description: "`account` or `contact`" },
      { name: "id", required: true, schema: z.string().min(1), message: "Pass object=account|contact and id", description: "The record's register id" },
    ],
    responses: { 200: DataBody }, errors: ["invalid_request"], undescribed: UNDESCRIBED_DATA,
  },
  { id: "changeAssociation", route: "associations", method: "post", summary: "Link, unlink or reparent", stability: "stable", since: "2026-10-10", body: AssociationBody, responses: { 200: DataBody }, errors: ["invalid_request", "validation_failed", "not_found"], undescribed: UNDESCRIBED_DATA },
  { id: "dealRoles", route: "deals/[id]/roles", method: "get", summary: "The people on a deal and their roles", stability: "stable", since: "2026-10-10", responses: { 200: DataBody }, errors: ["not_found"], undescribed: UNDESCRIBED_DATA },
  { id: "setDealRole", route: "deals/[id]/roles", method: "post", summary: "Set a person's role on a deal", stability: "stable", since: "2026-10-10", body: DealRoleBody, responses: { 200: DataBody }, errors: ["not_found", "invalid_request", "validation_failed"], undescribed: UNDESCRIBED_DATA },
  { id: "removeFromDeal", route: "deals/[id]/roles/[contactId]", method: "delete", summary: "Take a person off a deal", stability: "stable", since: "2026-10-10", responses: { 200: DataBody }, errors: ["not_found", "invalid_request"], undescribed: UNDESCRIBED_DATA },
  { id: "logActivity", route: "activities", method: "post", summary: "Log an activity about several records", stability: "stable", since: "2026-10-10", body: ActivityBody, headers: [IDEMPOTENCY_KEY], responses: { 201: DataBody }, errors: ["invalid_request", "validation_failed", "idempotency_key_reused", "not_found"], undescribed: UNDESCRIBED_DATA },
  { id: "salesforceSpotCheck", route: "salesforce/spot-check", method: "post", summary: "What Canon holds for imported Salesforce records", stability: "preview", since: "2026-10-10", body: SpotCheckBody, responses: { 200: DataBody }, errors: ["invalid_request"], undescribed: UNDESCRIBED_DATA },
  { id: "objects", route: "objects", method: "get", summary: "The workspace's objects and their fields", stability: "preview", since: "2026-11-09", responses: { 200: ObjectsBody }, errors: [] },
  { id: "openapi", route: "openapi.json", method: "get", summary: "This document, for the caller's workspace", stability: "preview", since: "2026-11-09", responses: { 200: z.record(z.string(), z.unknown()) }, errors: [] },
  {
    id: "workspaceExport", route: "workspace/export", method: "post", summary: "Export a workspace (canon workspace export)", stability: "preview", since: "2026-11-09", security: "exportKey",
    responses: {}, errors: [], undescribed: "The body and answers are the canon CLI's export protocol (src/app/api/v1/workspace/export/route.ts), not described here yet.",
  },
  {
    id: "workspaceImport", route: "workspace/import", method: "post", summary: "Import a workspace (canon workspace import)", stability: "preview", since: "2026-11-09", security: "importKey",
    responses: {}, errors: [], undescribed: "The body and answers are the canon CLI's import protocol (src/app/api/v1/workspace/import/route.ts), not described here yet.",
  },
];
