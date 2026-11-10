/**
 * The record API's OpenAPI 3.1 document, built from what the routes validate
 * with: the operation table and its zod shapes (_contract.ts), each object's
 * registry fields as `objects.describe` gives them to the caller
 * (convex/lib/objects/describe.ts), and the Convex validators of the creates
 * that take another shape (convex/lib/objects/createArgs.ts).
 *
 * `standardObjects()` describes the standard objects for an admin, which is
 * docs/openapi.json (scripts/build-openapi.ts). The live document,
 * `GET /api/v1/openapi.json`, passes the caller's own descriptions instead, so
 * it has the workspace's custom objects and fields and none the caller's role
 * cannot see.
 */
import { z } from "zod";
import type { GenericValidator } from "convex/values";
import { accessOf } from "../../../../convex/lib/access.ts";
import { describeObject, type DescribedObject } from "../../../../convex/lib/objects/describe.ts";
import { dealCreateArgs, upsertAccount, upsertContact } from "../../../../convex/lib/objects/createArgs.ts";
import { claimsUnique, isLedgerObjectName, MULTI_VALUES_MAX, resolveOrgObject, STANDARD_OBJECTS, type FieldDef } from "../../../../convex/lib/objects/registry.ts";
import { API_VERSION, ApiRecordSchema, ErrorBody, ObjectsBody, OPERATIONS, TIMELINE_OBJECTS, WriteBody, WriteResult, type ObjectGate, type Operation, type QueryParam } from "./_contract.ts";
import { V1_ERROR_CODES, V1_STATUS, type V1Client, type V1ErrorCode } from "./_lib.ts";
import { api } from "../../../../convex/_generated/api.js";

type Schema = Record<string, unknown>;
export type OpenApiDocument = Schema & { paths: Record<string, Record<string, Schema>>; components: Schema & { schemas: Record<string, Schema>; parameters: Record<string, Schema>; responses: Record<string, Schema> } };

/** The standard objects the record API serves (every ledger-stored one), in registry order. */
export const API_OBJECTS = Object.keys(STANDARD_OBJECTS).filter(isLedgerObjectName);

/** The standard objects as `objects.describe` gives them to an admin of a workspace with no custom fields. */
export function standardObjects(): DescribedObject[] {
  const access = accessOf({ userId: "users:admin", role: "admin" });
  return API_OBJECTS.map((object) => describeObject({ object, def: resolveOrgObject(object)!, access, dealsWrite: true, icpOptions: [], aiSlugs: new Set() }));
}

/** The caller's workspace's objects, standard and its own, each as `objects.describe` answers the caller; archived ones answer null. */
export async function workspaceObjects(client: V1Client): Promise<DescribedObject[]> {
  const custom = (await client.query(api.customObjects.list, {})).filter((o) => !o.archived).map((o) => o.apiName);
  const described = await Promise.all([...API_OBJECTS, ...custom].map((object) => client.query(api.objects.describe, { object })));
  return described.filter((d): d is NonNullable<typeof d> => d !== null) as unknown as DescribedObject[];
}

/** The descriptions as `GET /objects` answers them: a plain view of the same fields the document is built from. */
export function objectsBody(objects: readonly DescribedObject[]): z.infer<typeof ObjectsBody> {
  return {
    data: objects.filter((d) => d.readable).map((d) => ({
      object: d.apiName, label: d.label, pluralLabel: d.pluralLabel, kind: d.kind, writable: d.writable, canCreate: d.canCreate || d.register, canDelete: d.canDelete,
      fields: d.fields.map((f) => ({
        apiName: f.apiName, label: f.label, type: f.type, required: f.required === true, unique: claimsUnique(f),
        readOnly: Boolean(f.system) || f.type === "formula" || d.readOnlyFields.includes(f.apiName),
        ...("options" in f ? { options: f.options.map(({ value, label, active }) => ({ value, label, active })) } : {}),
        ...(f.type === "lookup" ? { lookupTo: f.lookupTo } : {}),
      })),
    })),
  };
}

const INT_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);

/** A zod schema as JSON Schema 2020-12 (OpenAPI 3.1's dialect), without zod's safe-integer bounds or its `propertyNames: string`, which every JSON key meets. */
function fromZod(schema: z.ZodType): Schema {
  const out = { ...(z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "input" }) as Schema) };
  delete out.$schema;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (typeof node !== "object" || node === null) return node;
    return Object.fromEntries(Object.entries(node).filter(([k, v]) => !((k === "maximum" || k === "minimum") && INT_BOUNDS.has(v as number)) && !(k === "propertyNames" && JSON.stringify(v) === '{"type":"string"}')).map(([k, v]) => [k, clean(v)]));
  };
  return clean(out) as Schema;
}

/** A Convex validator as JSON Schema: the shape Convex checks an argument with. */
function fromConvex(validator: GenericValidator): Schema {
  switch (validator.kind) {
    case "string": return { type: "string" };
    case "id": return { type: "string", "x-canon-id": validator.tableName };
    case "float64": return { type: "number" };
    case "int64": return { type: "integer" };
    case "boolean": return { type: "boolean" };
    case "null": return { type: "null" };
    case "any": return {};
    case "literal": return { const: validator.value };
    case "array": return { type: "array", items: fromConvex(validator.element) };
    case "record": return { type: "object", additionalProperties: fromConvex(validator.value) };
    case "union": return { anyOf: validator.members.map(fromConvex) };
    case "object": return convexObject(validator.fields);
    default: throw new Error(`No JSON Schema for a Convex ${validator.kind} validator`);
  }
}

function convexObject(fields: Record<string, GenericValidator>): Schema {
  const required = Object.entries(fields).filter(([, v]) => v.isOptional === "required").map(([k]) => k);
  return { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromConvex(v)])), ...(required.length ? { required } : {}), additionalProperties: false };
}

const nullable = (s: Schema): Schema =>
  typeof s.type === "string" ? { ...s, type: [s.type, "null"], ...(Array.isArray(s.enum) ? { enum: [...s.enum, null] } : {}) } : { anyOf: [s, { type: "null" }] };

/** Money is stored and sent in the currency's minor unit (cents), never in whole units. */
const CURRENCY: Schema = { type: "number", description: "Minor units (cents): 2400050 is 24,000.50", "x-canon-type": "currency", "x-canon-unit": "minor" };

const COMPUTED: Record<string, Schema> = {
  number: { type: "number" }, currency: CURRENCY, text: { type: "string" },
  date: { type: "string", format: "date" }, datetime: { type: "integer" }, checkbox: { type: "boolean" },
};

/** One field's value: as a record carries it (`read`), or as a write takes it. Every value may be null, which is empty. */
function fieldSchema(field: FieldDef, mode: "read" | "write"): Schema {
  const options = (all: boolean) => ("options" in field ? field.options.filter((o) => all || o.active).map((o) => o.value) : []);
  const oneOf = (values: string[]): Schema => (values.length ? { type: "string", enum: values } : { type: "string" });
  const base = ((): Schema => {
    switch (field.type) {
      case "text": return { type: "string" };
      case "user": return { type: "string", "x-canon-id": "users" };
      case "lookup": return { type: "string", "x-canon-lookup": field.lookupTo };
      case "number": return { type: "number" };
      case "currency": return CURRENCY;
      case "checkbox": return { type: "boolean" };
      case "date": return { type: "string", format: "date" };
      case "datetime":
        return mode === "read" ? { type: "integer", description: "Epoch milliseconds" }
          : { anyOf: [{ type: "integer", description: "Epoch milliseconds" }, { type: "string", format: "date-time", description: "With a timezone" }] };
      case "picklist": return oneOf(options(mode === "read"));
      case "multipicklist": return { type: "array", items: oneOf(options(mode === "read")), uniqueItems: true };
      case "emails": case "phones": case "links": return { type: "array", items: { type: "string" }, maxItems: MULTI_VALUES_MAX, description: "The first is the primary", "x-canon-type": field.type };
      case "splits": return { type: "array", items: { type: "object", properties: { userId: { type: "string", "x-canon-id": "users" }, percentage: { type: "number" }, kind: { type: "string", enum: ["revenue", "overlay"] } }, required: ["userId", "percentage", "kind"], additionalProperties: false } };
      case "formula": return { ...COMPUTED[field.returns], "x-canon-type": field.rollup ? "rollup" : "formula", ...(field.returns === "currency" ? { "x-canon-unit": "minor" } : {}) };
    }
  })();
  return { ...nullable(base), title: field.label, ...(claimsUnique(field) ? { "x-canon-unique": true } : {}) };
}

const pascal = (name: string) => name.split(/[_.]/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");

/** The fields a write may set: not computed, not set by the system, not read-only for the caller. */
const writable = (d: DescribedObject) => d.fields.filter((f) => !f.system && f.type !== "formula" && !d.readOnlyFields.includes(f.apiName));

function valuesSchema(fields: readonly FieldDef[], mode: "read" | "write", readOnly: readonly string[] = [], required: readonly string[] = []): Schema {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.apiName, { ...fieldSchema(f, mode), ...(mode === "read" && (f.system || f.type === "formula" || readOnly.includes(f.apiName)) ? { readOnly: true } : {}) }])),
    ...(required.length ? { required: [...required] } : {}),
  };
}

/**
 * A create's `values` as the route hands them on: companies and people to records.upsert, deals to deals.create
 * (custom fields in `custom`), anything else to the object's own fields.
 */
function createValues(d: DescribedObject): Schema {
  if (d.apiName === "account" || d.apiName === "contact") return fromConvex(d.apiName === "account" ? upsertAccount : upsertContact);
  const fields = writable(d);
  if (d.apiName === "deal") {
    const args = convexObject(Object.fromEntries(Object.entries(dealCreateArgs).filter(([name]) => name !== "custom")));
    const custom = valuesSchema(fields.filter((f) => f.apiName.startsWith("custom.")), "write");
    return { ...args, properties: { ...(args.properties as Schema), ...(custom.properties as Schema) } };
  }
  return { ...valuesSchema(fields, "write", [], fields.filter((f) => f.required).map((f) => f.apiName)), additionalProperties: false };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function objectSchemas(d: DescribedObject): Record<string, Schema> {
  const name = pascal(d.apiName);
  const record = fromZod(ApiRecordSchema);
  const props = record.properties as Schema;
  const write = fromZod(WriteBody);
  const writeProps = write.properties as Schema;
  const register = d.register;
  const create = { values: ref(`${name}Create`), ...(register || d.apiName === "deal" ? {} : { source: writeProps.source, evidence: writeProps.evidence, confidence: writeProps.confidence }) };
  const update = { values: ref(`${name}Update`), ...(register ? {} : { expectedVersion: writeProps.expectedVersion, source: writeProps.source, evidence: writeProps.evidence, confidence: writeProps.confidence }) };
  const result = fromZod(WriteResult);
  return {
    [`${name}Values`]: valuesSchema(d.fields, "read", d.readOnlyFields),
    [`${name}Record`]: { ...record, title: d.label, properties: { ...props, object: { type: "string", const: d.apiName }, values: ref(`${name}Values`) } },
    [`${name}Create`]: createValues(d),
    [`${name}Update`]: { ...valuesSchema(writable(d), "write"), additionalProperties: false },
    [`${name}CreateBody`]: { type: "object", properties: create, required: ["values"] },
    [`${name}UpdateBody`]: { type: "object", properties: update, required: d.versionRequired ? ["values", "expectedVersion"] : ["values"] },
    [`${name}WriteResult`]: { ...result, properties: { ...(result.properties as Schema), data: ref(`${name}Record`) } },
    [`${name}Page`]: { type: "object", properties: { data: { type: "array", items: ref(`${name}Record`) }, nextCursor: { type: ["string", "null"] }, total: { type: "integer" } }, required: ["data", "nextCursor", "total"] },
    [`${name}Get`]: { type: "object", properties: { data: ref(`${name}Record`) }, required: ["data"] },
  };
}

const GATES: Record<ObjectGate, (d: DescribedObject) => boolean> = {
  all: () => true,
  // The route creates companies and people in the register for any caller, and asks the registry for the rest.
  create: (d) => d.canCreate || d.register,
  edit: (d) => d.writable,
  delete: (d) => d.canDelete,
  merge: (d) => d.register,
  timeline: (d) => (TIMELINE_OBJECTS as readonly string[]).includes(d.apiName),
};

/** The OpenAPI path of a route folder, with a per-object operation's object filled in. */
const pathOf = (route: string, object?: string) => `/${route}`.replace(/\[([^\]]+)\]/g, (_, p: string) => (p === "object" && object ? object : `{${p}}`));

function parameter(p: QueryParam): Schema {
  const schema = fromZod(p.schema);
  return { name: p.name, in: "query", ...(p.required ? { required: true } : {}), description: p.description, schema: p.repeat ? { type: "array", items: schema } : schema, ...(p.repeat ? { style: "form", explode: true } : {}) };
}

/** Query parameters by name, shared by the operations that take them; two that differ under one name get the operation's id too. */
function parameters(): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  for (const op of OPERATIONS) for (const p of op.query ?? []) {
    const key = out[p.name] && JSON.stringify(out[p.name]) !== JSON.stringify(parameter(p)) ? `${op.id}.${p.name}` : p.name;
    out[key] = parameter(p);
  }
  return out;
}

const COMMON_ERRORS: readonly V1ErrorCode[] = ["unauthorized", "forbidden", "rate_limited", "internal", "not_configured"];

const integer = (description: string) => ({ description, schema: { type: "integer" } });
/** A 429's headers (docs/record-api.md, Rate limits). Every other answer carries the three RateLimit ones too. */
const RATE_HEADERS: Record<string, Schema> = {
  "Retry-After": integer("Seconds until the window resets"),
  "RateLimit-Limit": integer("Requests a minute in the tightest budget that applies: the token's or the workspace's, for this kind of request"),
  "RateLimit-Remaining": integer("Requests left in that budget this window"),
  "RateLimit-Reset": integer("Seconds until that budget's window resets"),
};

/** One response per error status, naming every code the API answers with it. */
function errorComponents(): Record<string, Schema> {
  return Object.fromEntries(V1_ERROR_CODES.map((code) => V1_STATUS[code]).filter((s, i, all) => all.indexOf(s) === i).sort((a, b) => a - b).map((status) => [String(status), {
    description: V1_ERROR_CODES.filter((c) => V1_STATUS[c] === status).map((c) => `\`${c}\``).join(", "), content: { "application/json": { schema: ref("Error") } },
    ...(status === V1_STATUS.rate_limited ? { headers: RATE_HEADERS } : {}),
  }]));
}

const errorResponses = (op: Operation): Record<string, Schema> =>
  Object.fromEntries([...new Set([...op.errors, ...COMMON_ERRORS].map((c) => V1_STATUS[c]))].sort((a, b) => a - b).map((status) => [String(status), { $ref: `#/components/responses/${status}` }]));

const json = (schema: Schema) => ({ content: { "application/json": { schema } } });

function operation(op: Operation, shared: Record<string, Schema>, d?: DescribedObject): Schema {
  const name = d ? pascal(d.apiName) : "";
  const named = { record: `${name}Get`, list: `${name}Page`, write: `${name}WriteResult` } as const;
  const bodyOf = (s: NonNullable<Operation["responses"][number]>) => (typeof s === "string" ? ref(named[s]) : fromZod(s));
  const params = [
    ...[...pathOf(op.route, d?.apiName).matchAll(/\{([^}]+)\}/g)].map(([, p]) => ({ name: p, in: "path", required: true, schema: { type: "string" } })),
    ...(op.query ?? []).map((p) => (d?.versionRequired && p.name === "expectedVersion" ? { ...parameter(p), required: true }
      : { $ref: `#/components/parameters/${shared[p.name] && JSON.stringify(shared[p.name]) === JSON.stringify(parameter(p)) ? p.name : `${op.id}.${p.name}`}` })),
    ...(op.headers ?? []).map((h) => ({ name: h.name, in: "header", description: h.description, schema: { type: "string" } })),
  ];
  const success = Object.entries(op.responses).map(([status, s]) => [status, { description: Number(status) === 202 ? "Held for review" : "OK", ...json(bodyOf(s)) }]);
  return {
    operationId: `${op.id}${name}`,
    summary: d ? `${op.summary}: ${d.pluralLabel}` : op.summary,
    tags: [d ? d.pluralLabel : op.security ? "Workspace" : "Relationships"],
    ...(params.length ? { parameters: params } : {}),
    ...(op.body ? { requestBody: { required: true, ...json(typeof op.body === "string" ? ref(`${name}${op.body === "create" ? "Create" : "Update"}Body`) : fromZod(op.body)) } } : {}),
    responses: success.length ? { ...Object.fromEntries(success), ...errorResponses(op) } : { default: { description: "Not described yet (x-canon-undescribed)" } },
    ...(op.security ? { security: [{ [op.security]: [] }] } : {}),
    "x-stability": op.stability,
    "x-since": op.since,
    ...(op.undescribed ? { "x-canon-undescribed": op.undescribed } : {}),
  };
}

/**
 * The document for `objects`, each as `objects.describe` answered for the caller. Objects the caller cannot read are
 * left out, and per-object operations only where the route would allow them.
 */
export function buildOpenApi(objects: readonly DescribedObject[], opts: { server: string; workspace?: boolean }): OpenApiDocument {
  const readable = objects.filter((d) => d.readable);
  const paths: OpenApiDocument["paths"] = {};
  const shared = parameters();
  const add = (path: string, method: string, body: Schema) => (paths[path] ??= {})[method] = body;
  for (const op of OPERATIONS) {
    if (!op.object) add(pathOf(op.route), op.method, operation(op, shared));
    else for (const d of readable) if (GATES[op.object](d)) add(pathOf(op.route, d.apiName), op.method, operation(op, shared, d));
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Canon record API",
      version: API_VERSION,
      description: `REST access to a Canon workspace's records (docs/record-api.md). ${opts.workspace ? "This document is the calling workspace's: its own objects and fields, as the caller's role sees them." : "This document covers the standard objects as an admin sees them; GET /api/v1/openapi.json gives a workspace's own, with its custom objects and fields."} \`x-stability\` is \`stable\` for what docs/record-api.md documents and \`preview\` for what may still change; \`x-canon-undescribed\` marks a part not described yet.`,
    },
    servers: [{ url: opts.server }],
    security: [{ bearer: [] }],
    tags: [...readable.map((d) => ({ name: d.pluralLabel })), { name: "Relationships" }, { name: "Workspace" }],
    paths,
    components: {
      schemas: { ...Object.assign({}, ...readable.map(objectSchemas)), Error: fromZod(ErrorBody) },
      parameters: shared,
      responses: errorComponents(),
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A paired CLI token (`fsgtm_...`, from `canon login`) or a Clerk session JWT. Every call runs as that user, in that user's workspace." },
        exportKey: { type: "http", scheme: "bearer", description: "An export key (`cwx_...`) from Settings, Workspace" },
        importKey: { type: "http", scheme: "bearer", description: "An import key (`cwi_...`) from Settings, Workspace" },
      },
    },
    "x-canon-undescribed": OPERATIONS.filter((o) => o.undescribed).map((o) => ({ route: pathOf(o.route), method: o.method, reason: o.undescribed })),
  };
}
