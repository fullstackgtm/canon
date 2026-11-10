/**
 * The record API answers as its OpenAPI document says. Every operation runs
 * through its real Next route handler, whose Convex calls reach the real
 * handlers in process (tests/convexHandlers.ts) over a fake HTTP transport.
 * Each request sent and each answer is checked against the live document of
 * the fixture workspace, and standard-object exchanges also against the
 * shipped docs/openapi.json. Validation is strict: an answer with a property
 * the document does not declare fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConvexError, convexToJson, jsonToConvex, type Value } from "convex/values";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import type { OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import { OPERATIONS } from "../src/app/api/v1/_contract.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", isActive: true, clerkUserId: "user_ada" };
const REP = { ...ADMIN, _id: "users:avery", role: "rep", name: "Avery", clerkUserId: "user_avery" };
/** An admin of another workspace, and a member of this one turned off on the Team page. */
const OUTSIDER = { ...ADMIN, _id: "users:olga", orgId: "organizations:other", name: "Olga", clerkUserId: "user_olga" };
const GONE = { ...ADMIN, _id: "users:gus", role: "rep", name: "Gus", isActive: false, clerkUserId: "user_gus" };
const PROJECT: OrgObjectExtension & { apiName: string } = {
  apiName: "custom_project", registryVersion: 1,
  object: { label: "Project", pluralLabel: "Projects", icon: "folder", titleField: "custom.name" },
  customFields: [
    { fieldId: "custom.name", apiName: "custom.name", label: "Name", type: "text", required: true },
    { fieldId: "custom.budget", apiName: "custom.budget", label: "Budget", type: "currency" },
    { fieldId: "custom.phase", apiName: "custom.phase", label: "Phase", type: "picklist", options: [{ value: "plan", label: "Plan", active: true }, { value: "build", label: "Build", active: true }] },
  ] as never,
};

let user = ADMIN;
const FILES = ["objects.ts", "records.ts", "deals.ts", "customObjects.ts", "permissions.ts", "canon.ts", "activityTargets.ts", "apiIdempotency.ts"];
const M = loadConvex(FILES, { "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }) });

// ---- the workspace ----

const db = memoryDb({
  organizations: [{ _id: ORG, name: "Acme", defaultCurrency: "USD" }],
  users: [ADMIN, REP, OUTSIDER, GONE],
  objectDefs: [{ _id: "objectDefs:project", orgId: ORG, ...PROJECT, updatedAt: 1 }],
  rolePermissions: [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: [{ object: "custom_project", fields: [{ apiName: "custom.budget", level: "hidden" }] }] }],
});
// ---- Convex over a fake HTTP transport ----

const CONVEX_URL = "http://convex.test";
const STUBS: Record<string, unknown> = {
  "users:me": null,
  "duplicates:list": [{ ids: ["acc_a", "acc_b"] }],
  "duplicates:dismiss": null,
  "recordMerges:preview": { fields: [], records: [], picks: {} },
  "recordMerges:merge": { mergeId: "merge_1", survivorId: "acc_a" },
  "recordMerges:undo": { kept: ["acc_b"] },
  "associations:related": { people: [], companies: [], parent: null },
  "associations:link": { ok: true }, "associations:unlink": { ok: true }, "associations:makePrimary": { ok: true }, "associations:setParent": { ok: true },
  "dealCommittee:forDeal": [], "dealCommittee:setRole": { ok: true }, "dealCommittee:removeFromDeal": { ok: true },
  "activityTargets:forRecord": { activities: [], projectedThrough: {} },
  "salesforceImport:spotCheck": [],
};

type Kind = "query" | "mutation" | "action";
/** Convex runs mutations serializably; here one at a time, so concurrent requests interleave only as they would there. */
let mutations = Promise.resolve();
function serially<T>(run: () => Promise<T>): Promise<T> {
  const result = mutations.then(run);
  mutations = result.then(() => undefined, () => undefined);
  return result;
}
const runner = (kind: Kind) => async (path: string, args: unknown): Promise<unknown> => {
  const [file, name] = path.split(":");
  const fn = M[`${file}.ts`]?.[name!];
  if (!fn) throw new Error(`no in-process handler for ${path}`);
  const via = (as: Kind) => (ref: unknown, a: unknown) => {
    const parts = String(ref).split(".");
    const call = () => runner(as)(`${parts.slice(1, -1).join("/")}:${parts.at(-1)}`, a);
    return as === "mutation" && kind === "action" ? serially(call) : call();
  };
  const ctx = { db, scheduler: { runAfter: async () => null }, runQuery: via("query"), runMutation: via("mutation"), runAction: via("action"), kind };
  return fn.handler(ctx, args);
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const kind = url.match(/\/api\/(query|mutation|action)$/)?.[1] as "query" | "mutation" | "action" | undefined;
  if (!url.startsWith(CONVEX_URL) || !kind) throw new Error(`unexpected fetch ${url}`);
  const { path, args } = JSON.parse(String(init?.body));
  try {
    const run = () => runner(kind)(path, jsonToConvex(args[0]));
    const value = path === "users:me" ? user : path in STUBS ? STUBS[path] : await (kind === "mutation" ? serially(run) : run());
    return Response.json({ status: "success", value: convexToJson(JSON.parse(JSON.stringify(value ?? null)) as Value), logLines: [] });
  } catch (error) {
    // By name: the handlers' ConvexError is another copy of the class than this file's.
    const convexError = error instanceof ConvexError || (error as Error)?.name === "ConvexError" ? (error as ConvexError<Value>) : null;
    const data = convexError ? { errorData: convexToJson(convexError.data) } : {};
    return Response.json({ status: "error", errorMessage: convexError ? convexError.message : `[Request ID: test] Server Error\nUncaught ${String(error)}`, ...data, logLines: [] }, { status: 560 });
  }
}) as typeof fetch;
process.env.NEXT_PUBLIC_CONVEX_URL = CONVEX_URL;
// The sweep sends more requests than one minute's budget allows; the rate limit test sets its own.
for (const name of ["CANON_API_TOKEN_READS_PER_MINUTE", "CANON_API_TOKEN_WRITES_PER_MINUTE", "CANON_API_WORKSPACE_READS_PER_MINUTE", "CANON_API_WORKSPACE_WRITES_PER_MINUTE"]) process.env[name] = "0";

// ---- a strict JSON Schema check, for the keywords the document uses ----

type Schema = Record<string, unknown>;
type Doc = Schema & { paths: Record<string, Record<string, Schema>>; components: Record<string, Record<string, Schema>> };
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "format", "pattern", "minimum", "maximum", "maxItems", "minLength", "uniqueItems", "$ref", "description", "title", "readOnly"]);
const typeOf = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);

function problems(doc: Doc, schema: Schema, value: unknown, at = "$"): string[] {
  if (typeof schema.$ref === "string") return problems(doc, resolve(doc, schema.$ref), value, at);
  for (const k of Object.keys(schema)) if (!KNOWN.has(k) && !k.startsWith("x-")) throw new Error(`the check does not know the keyword ${k} (${at})`);
  if (schema.anyOf || schema.oneOf) {
    const branches = (schema.anyOf ?? schema.oneOf) as Schema[];
    const ok = branches.filter((b) => !problems(doc, b, value, at).length).length;
    if (schema.oneOf ? ok !== 1 : ok === 0) return [`${at}: matches ${ok} of its ${branches.length} shapes`];
  }
  const out: string[] = [];
  const t = typeOf(value);
  const types = schema.type === undefined ? null : ([schema.type].flat() as string[]);
  if (types && !types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: is ${t}, not ${types.join("|")}`];
  if ("const" in schema && value !== schema.const) out.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) out.push(`${at}: does not match ${schema.pattern}`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) out.push(`${at}: too short`);
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) out.push(`${at}: not a date`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) out.push(`${at}: not a date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...problems(doc, schema.items as Schema, v, `${at}[${i}]`)));
  }
  if (t === "object" && (schema.properties || schema.additionalProperties !== undefined)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[]) if (!(name in obj)) out.push(`${at}: lacks required ${name}`);
    for (const [name, v] of Object.entries(obj)) {
      if (props[name]) out.push(...problems(doc, props[name]!, v, `${at}.${name}`));
      else if (typeof schema.additionalProperties === "object") out.push(...problems(doc, schema.additionalProperties as Schema, v, `${at}.${name}`));
      // Strict: a property the document does not name fails, whether or not it says additionalProperties.
      else if (schema.additionalProperties !== true) out.push(`${at}: has undeclared ${name}`);
    }
  }
  return out;
}

function resolve(doc: Doc, pointer: string): Schema {
  return pointer.slice(2).split("/").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], doc) as Schema;
}

// ---- exchanges ----

const routeFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [path] : [];
});
const V1 = join(import.meta.dirname, "../src/app/api/v1");
/** Each route folder and the methods its file exports a handler for (the rest are its 405 fallbacks). */
const routes = new Map(routeFiles(V1).map((file) => [file.slice(V1.length + 1, -"/route.ts".length), {
  file, methods: [...readFileSync(file, "utf8").matchAll(/^export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)\b/gm)].map((m) => m[1]!),
}]));

const covered = new Set<string>();

/** The route folder and params a concrete path names, most specific first ("records/[object]/groups" before "records/[object]/[id]"). */
function routeFor(path: string): { route: string; params: Record<string, string> } {
  const segs = path.split("/").filter(Boolean);
  const candidates = [...routes.keys()].filter((r) => !r.startsWith("[...")).map((r) => r.split("/")).filter((r) => r.length === segs.length)
    .filter((r) => r.every((s, i) => s.startsWith("[") || s === segs[i])).sort((a, b) => a.filter((s) => s.startsWith("[")).length - b.filter((s) => s.startsWith("[")).length);
  const route = candidates[0];
  if (!route) throw new Error(`no route for ${path}`);
  return { route: route.join("/"), params: Object.fromEntries(route.flatMap((s, i) => (s.startsWith("[") ? [[s.slice(1, -1), segs[i]!]] : []))) };
}

/** The document's operation for a concrete path: a per-object path is in the document as itself, the rest as their template. */
function operationIn(doc: Doc, method: string, path: string): { template: string; op: Schema } | null {
  const params = (t: string) => (t.match(/\{/g) ?? []).length;
  for (const [template, ops] of Object.entries(doc.paths).sort(([a], [b]) => params(a) - params(b))) {
    const re = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    if (re.test(path) && ops[method]) return { template, op: ops[method]! };
  }
  return null;
}

/** `invalid`: a request the document does not allow, sent to see the error it gets; only its answer is checked. */
type Exchange = { query?: Array<[string, string]>; body?: unknown; invalid?: true; bearer?: string; idempotencyKey?: string };

async function call(docs: Doc[], method: string, path: string, { query = [], body, invalid, bearer, idempotencyKey }: Exchange = {}) {
  for (const doc of invalid ? [] : docs) {
    const found = operationIn(doc, method, path);
    assert.ok(found, `${method.toUpperCase()} ${path} is not in the document`);
    const declared = ((found.op.parameters ?? []) as Schema[]).map((p) => (p.$ref ? resolve(doc, p.$ref as string) : p)).filter((p) => p.in === "query");
    for (const [name, value] of query) {
      const p = declared.find((d) => d.name === name);
      assert.ok(p, `${path}: ${name} is not a declared parameter`);
      const schema = p.schema as Schema;
      assert.deepEqual(problems(doc, schema.type === "array" ? (schema.items as Schema) : schema, value), [], `${path}?${name}`);
    }
    if (body !== undefined) {
      const schema = ((found.op.requestBody as Schema).content as Record<string, Schema>)["application/json"]!.schema as Schema;
      assert.deepEqual(problems(doc, schema, body), [], `request ${method} ${path}`);
    }
  }
  const { route, params } = routeFor(path);
  const handler = (await import(routes.get(route)!.file))[method.toUpperCase()] as (r: Request, c: { params: Promise<unknown> }) => Promise<Response>;
  const url = `http://canon.test/api/v1${path}${query.length ? `?${new URLSearchParams(query)}` : ""}`;
  if (idempotencyKey) for (const doc of docs) assert.ok(((operationIn(doc, method, path)!.op.parameters ?? []) as Schema[]).some((p) => p.in === "header" && p.name === "Idempotency-Key"), `${method} ${path} takes no Idempotency-Key`);
  const headers = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) };
  const response = await handler(new Request(url, { method: method.toUpperCase(), headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
  const json = await response.json();
  for (const doc of docs) {
    const { template, op } = operationIn(doc, method, path)!;
    const declared = (op.responses as Record<string, Schema>)[String(response.status)];
    assert.ok(declared, `${method.toUpperCase()} ${path} answered ${response.status}, which the document does not list: ${JSON.stringify(json).slice(0, 300)}`);
    const resolved = declared.$ref ? resolve(doc, declared.$ref as string) : declared;
    const schema = ((resolved.content as Record<string, Schema>)["application/json"]!).schema as Schema;
    assert.deepEqual(problems(doc, schema, json), [], `answer of ${method.toUpperCase()} ${path} (${response.status})`);
    if (doc === docs[0]) covered.add(`${method} ${template} ${response.status < 300 ? "ok" : "error"}`);
  }
  return { status: response.status, body: json, headers: response.headers };
}

const staticDoc = JSON.parse(readFileSync(join(import.meta.dirname, "../docs/openapi.json"), "utf8")) as Doc;

test("every route method is an operation in the contract, and every operation a route method", () => {
  const real = [...routes].filter(([r]) => !r.startsWith("[...")).flatMap(([route, { methods }]) => methods.map((m) => `${m.toLowerCase()} ${route}`));
  assert.deepEqual(real.sort(), OPERATIONS.map((o) => `${o.method} ${o.route}`).sort());
});

test("every described operation answers as the document says, through the real routes", async () => {
  const live = (await call([staticDoc], "get", "/openapi.json")).body as Doc;
  assert.deepEqual(Object.keys(live.paths).filter((p) => p.includes("custom_project")).sort(), ["/records/custom_project", "/records/custom_project/groups", "/records/custom_project/{id}", "/records/custom_project/{id}/restore"]);
  const both = [live, staticDoc];
  const objects = (await call(both, "get", "/objects")).body as { data: Array<{ object: string; fields: Array<{ apiName: string }> }> };
  assert.ok(objects.data.find((o) => o.object === "custom_project")!.fields.some((f) => f.apiName === "custom.budget"));

  // A ledger object, every verb.
  const lead = await call(both, "post", "/records/lead", { body: { values: { lastName: "Rivera", company: "Acme", status: "new" } } });
  assert.equal(lead.status, 201);
  const leadId = (lead.body as { id: string }).id;
  await call(both, "get", "/records/lead", { query: [["filter", "company:contains:acme"], ["sort", "updatedAt:desc"], ["limit", "10"]] });
  await call(both, "get", `/records/lead/${leadId}`);
  const updated = await call(both, "patch", `/records/lead/${leadId}`, { body: { values: { company: "Acme Inc" }, expectedVersion: (lead.body as { version: number }).version } });
  assert.equal(updated.status, 200);
  const proposed = await call(both, "patch", `/records/lead/${leadId}`, { body: { values: { title: "CTO" }, source: "agent_run", evidence: "https://acme.example/team", confidence: 0.8 } });
  assert.equal(proposed.status, 202);
  assert.equal((await call(both, "patch", `/records/lead/${leadId}`, { body: { values: { company: "X" }, expectedVersion: 0 } })).status, 409);
  assert.equal((await call(both, "post", "/records/lead", { body: { values: { company: "No name" } }, invalid: true })).status, 422);
  assert.equal((await call(both, "get", "/records/lead", { query: [["sort", "company:sideways"]], invalid: true })).status, 400);
  await call(both, "get", "/records/lead/groups", { query: [["field", "status"]] });
  await call(both, "delete", `/records/lead/${leadId}`);
  await call(both, "get", "/records/lead", { query: [["deleted", "true"]] });
  await call(both, "post", `/records/lead/${leadId}/restore`);
  assert.equal((await call(both, "get", "/records/lead/kNotARecord")).status, 404);

  // The workspace's own object, in the live document only.
  const project = await call([live], "post", "/records/custom_project", { body: { values: { "custom.name": "Rollout", "custom.budget": 120000, "custom.phase": "plan" } } });
  const projectId = (project.body as { id: string }).id;
  await call([live], "patch", `/records/custom_project/${projectId}`, { body: { values: { "custom.phase": "build" } } });
  await call([live], "get", `/records/custom_project/${projectId}`);
  await call([live], "get", "/records/custom_project");
  await call([live], "get", "/records/custom_project/groups", { query: [["field", "custom.phase"]] });
  await call([live], "delete", `/records/custom_project/${projectId}`);
  await call([live], "post", `/records/custom_project/${projectId}/restore`);
  assert.equal((await call([live], "patch", `/records/custom_project/${projectId}`, { body: { values: { "custom.phase": "ship" } }, invalid: true })).status, 422);

  // Companies and people, from the register.
  const company = await call(both, "post", "/records/account", { body: { values: { domain: "a.example", name: "A" } } });
  assert.equal(company.status, 201);
  const acc = (company.body as { id: string }).id;
  await call(both, "get", "/records/account", { query: [["limit", "5"]] });
  await call(both, "get", `/records/account/${acc}`);
  await call(both, "patch", `/records/account/${acc}`, { body: { values: { industry: "software" } } });
  assert.equal((await call(both, "patch", `/records/account/${acc}`, { body: { values: { domain: "c.example" } }, invalid: true })).status, 422);
  await call(both, "get", "/records/contact");
  await call(both, "get", "/records/account/groups", { query: [["field", "industry"]] });
  await call(both, "delete", `/records/account/${acc}`);
  await call(both, "post", `/records/account/${acc}/restore`);

  // Deals: created through deals.create.
  const deal = await call(both, "post", "/records/deal", { body: { values: { name: "Acme expansion", closeDate: "2026-12-31", stage: "prospecting", amount: 500000 } } });
  const dealId = (deal.body as { id: string }).id;
  await call(both, "get", `/records/deal/${dealId}`);

  // Relationship routes: their `data` is not described yet, so the Convex functions behind them answer canned values.
  await call(both, "get", "/records/account/duplicates");
  await call(both, "post", "/records/account/duplicates/dismiss", { body: { ids: [acc, "acc_b"] } });
  await call(both, "post", "/records/account/merge/preview", { body: { ids: [acc, "acc_b"] } });
  await call(both, "post", "/records/account/merge", { body: { survivorId: acc, loserIds: ["acc_b"], picks: { industry: "acc_b" } } });
  assert.equal((await call(both, "post", "/records/account/merge", { body: { survivorId: acc }, invalid: true })).status, 422);
  await call(both, "post", "/merges/merge_1/undo");
  await call(both, "get", "/associations", { query: [["object", "account"], ["id", acc]] });
  await call(both, "post", "/associations", { body: { op: "link", contactId: "con_1", accountId: acc, primary: true } });
  await call(both, "post", "/associations", { body: { op: "set_parent", accountId: acc, parentId: null } });
  await call(both, "get", `/deals/${dealId}/roles`);
  await call(both, "post", `/deals/${dealId}/roles`, { body: { contactId: "con_1", role: "champion", reason: "ran the pilot" } });
  await call(both, "delete", `/deals/${dealId}/roles/con_1`);
  await call(both, "post", "/activities", { body: { object: "note", values: { body: "Intro call" }, targets: [{ object: "account", id: acc }] } });
  await call(both, "get", `/records/account/${acc}/activities`);
  await call(both, "post", "/salesforce/spot-check", { body: { object: "Account", sfIds: ["001A"] } });

  // People, and the remaining ledger objects' verbs.
  const person = await call(both, "post", "/records/contact", { body: { values: { fullName: "Ann Lee", accountDomain: "a.example", email: "ann@a.example" } } });
  const personId = (person.body as { id: string }).id;
  await call(both, "get", `/records/contact/${personId}`);
  await call(both, "patch", `/records/contact/${personId}`, { body: { values: { title: "CFO" } } });
  await call(both, "delete", `/records/contact/${personId}`);
  await call(both, "post", `/records/contact/${personId}/restore`);
  await call(both, "get", "/records/contact/groups", { query: [["field", "ownerId"]] });
  await call(both, "get", "/records/contact/duplicates");
  await call(both, "post", "/records/contact/duplicates/dismiss", { body: { ids: [personId, "con_x"] } });
  await call(both, "post", "/records/contact/merge/preview", { body: { ids: [personId, "con_x"] } });
  await call(both, "post", "/records/contact/merge", { body: { survivorId: personId, loserIds: ["con_x"] } });
  await call(both, "get", `/records/contact/${personId}/activities`);

  await call(both, "get", "/records/deal", { query: [["filter", "amount:gte:1000"]] });
  await call(both, "patch", `/records/deal/${dealId}`, { body: { values: { nextStep: "Send the order form" } } });
  await call(both, "get", "/records/deal/groups", { query: [["field", "closeDate"], ["bucket", "quarter"]] });
  await call(both, "get", `/records/deal/${dealId}/activities`);
  await call(both, "delete", `/records/deal/${dealId}`);
  await call(both, "post", `/records/deal/${dealId}/restore`);
  const product = (await call(both, "post", "/records/product", { body: { values: { name: "Seat", active: true, unitPrice: 1200 } } })).body as { id: string };
  const created: Record<string, Record<string, unknown>> = {
    task: { subject: "Call back", dueDate: "2026-11-20", status: "not_started" }, note: { body: "Met at the fair" }, call: { subject: "Intro", callAt: "2026-11-09T15:00:00Z", durationSeconds: 300 },
    meeting: { title: "Kickoff", startAt: Date.UTC(2026, 10, 12, 16) }, lineItem: { dealId, productId: product.id, quantity: 2, unitPrice: 1200, totalPrice: 2400 },
  };
  for (const [object, values] of Object.entries({ product: null, ...created })) {
    const id = values ? ((await call(both, "post", `/records/${object}`, { body: { values } })).body as { id: string }).id : product.id;
    await call(both, "get", `/records/${object}`);
    await call(both, "get", `/records/${object}/${id}`);
    await call(both, "get", `/records/${object}/groups`, { query: [["field", "createdAt"], ["bucket", "day"]] });
    // A line item's every change names the version it expects.
    const version = async () => String(((await call(both, "get", `/records/${object}/${id}`)).body as { data: { version: number } }).data.version);
    const expected = object === "lineItem" ? { expectedVersion: Number(await version()) } : {};
    await call(both, "patch", `/records/${object}/${id}`, { body: { values: object === "lineItem" ? { quantity: 3, totalPrice: 3600 } : { [Object.keys(values ?? { name: 1 })[0]!]: "Edited" }, ...expected } });
    await call(both, "delete", `/records/${object}/${id}`, object === "lineItem" ? { query: [["expectedVersion", await version()]] } : {});
    await call(both, "post", `/records/${object}/${id}/restore`, object === "lineItem" ? { query: [["expectedVersion", await version()]] } : {});
  }

  const protocol = (op: Schema) => String(op["x-canon-undescribed"] ?? "").includes("protocol");
  const missing = Object.entries(live.paths).flatMap(([template, ops]) =>
    Object.entries(ops).filter(([method, op]) => !protocol(op) && !covered.has(`${method} ${template} ok`)).map(([method]) => `${method} ${template}`));
  assert.deepEqual(missing, [], "operations no exchange succeeded on");
});

test("archiving a company or person through the API is the dashboard's archive (records.bulkRegister)", async () => {
  // The in-process register does not project the ledger's archive back onto its rows (the record service does), so
  // lists and the record's state are proved on a local stack; this proves the path, the actor and the refusals.
  for (const [object, values] of [["account", { domain: "archive.example", name: "Archive Co" }], ["contact", { fullName: "Ari Archive", accountDomain: "archive.example" }]] as const) {
    const id = ((await call([staticDoc], "post", `/records/${object}`, { body: { values } })).body as { id: string }).id;
    assert.equal((await call([staticDoc], "delete", `/records/${object}/${id}`)).body.status, "applied");
    assert.equal((await call([staticDoc], "delete", `/records/${object}/${id}`)).body.status, "unchanged");
    const entries = (await db.query("ledgerEntries").collect()) as unknown as Array<{ object: string; actor: unknown; body: unknown }>;
    assert.equal(entries.filter((e) => e.object === object && JSON.stringify(e.body).includes('"delete"')).map((e) => JSON.stringify(e.actor)).at(-1), JSON.stringify({ kind: "user", id: "users:ada" }));
    assert.equal((await call([staticDoc], "delete", `/records/${object}/${id}`, { query: [["expectedVersion", "1"]] })).status, 405);
    // A rep is refused as the dashboard refuses them, not told the verb does not exist.
    user = REP;
    try {
      assert.equal((await call([staticDoc], "post", `/records/${object}/${id}/restore`, { invalid: true })).status, 403);
    } finally {
      user = ADMIN;
    }
    assert.equal((await call([staticDoc], "post", `/records/${object}/${id}/restore`)).body.status, "applied");
    assert.equal((await call([staticDoc], "delete", `/records/${object}/${object === "account" ? "acc" : "con"}_missing`)).status, 404);
  }
  const dealId = ((await call([staticDoc], "post", "/records/deal", { body: { values: { name: "Admin deal", closeDate: "2026-12-31", stage: "prospecting" } } })).body as { id: string }).id;
  user = REP;
  try {
    assert.equal((await call([staticDoc], "post", "/records/deal", { body: { values: { name: "Rep deal", closeDate: "2026-12-31", stage: "prospecting" } }, invalid: true })).status, 403);
    assert.equal((await call([staticDoc], "delete", `/records/deal/${dealId}`, { invalid: true })).status, 403);
  } finally {
    user = ADMIN;
  }
});

test("a create retried with its Idempotency-Key makes one record and answers as the first did, even when both arrive at once", async () => {
  const streams = () => db.rows("canonEntities").length;
  const creates: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["/records/lead", { values: { lastName: "Once", company: "Retry Co" } }, { values: { lastName: "Twice", company: "Retry Co" } }],
    ["/records/deal", { values: { name: "Retry deal", closeDate: "2026-12-31", stage: "prospecting" } }, { values: { name: "Other deal", closeDate: "2026-12-31", stage: "prospecting" } }],
    ["/activities", { object: "note", values: { body: "Retried note" }, targets: [] }, { object: "note", values: { body: "Other note" }, targets: [] }],
  ];
  for (const [path, body, other] of creates) {
    const idempotencyKey = `key-${path}`;
    const before = streams();
    const [first, second] = await Promise.all([call([staticDoc], "post", path, { body, idempotencyKey }), call([staticDoc], "post", path, { body, idempotencyKey })]);
    assert.equal(streams(), before + 1, `${path}: one record`);
    assert.deepEqual(second.body, first.body, path);
    assert.equal(second.status, first.status, path);
    const replay = await call([staticDoc], "post", path, { body, idempotencyKey });
    assert.deepEqual([replay.status, replay.body], [first.status, first.body], `${path}: a later retry`);
    const reused = await call([staticDoc], "post", path, { body: other, idempotencyKey });
    assert.deepEqual([reused.status, (reused.body as { error: { code: string } }).error.code], [422, "idempotency_key_reused"], path);
    assert.equal(streams(), before + 1, `${path}: still one record`);
  }
  // Companies and people: the record service replays the key; the same key with other values is refused.
  const company = { values: { domain: "retry.example", name: "Retry" } };
  const added = await call([staticDoc], "post", "/records/account", { body: company, idempotencyKey: "company-key" });
  assert.deepEqual((await call([staticDoc], "post", "/records/account", { body: company, idempotencyKey: "company-key" })).body, added.body);
  const reused = await call([staticDoc], "post", "/records/account", { body: { values: { domain: "other.example", name: "Other" } }, idempotencyKey: "company-key" });
  assert.equal((reused.body as { error: { code: string } }).error.code, "idempotency_key_reused");
  // A key is the caller's own: another user's same key creates their own record.
  user = REP;
  try {
    const before = streams();
    const theirs = await call([staticDoc], "post", "/records/lead", { body: creates[0]![1], idempotencyKey: "key-/records/lead" });
    assert.equal(theirs.status, 201);
    assert.equal(streams(), before + 1);
  } finally {
    user = ADMIN;
  }
});

test("past its budget a token is answered 429 with Retry-After, as the document says", async () => {
  process.env.CANON_API_TOKEN_READS_PER_MINUTE = "2";
  try {
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(await call([staticDoc], "get", "/records/lead"));
    const refused = answers.find((a) => a.status === 429)!;
    assert.equal((refused.body as { error: { code: string } }).error.code, "rate_limited");
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal(refused.headers.get("ratelimit-remaining"), "0");
    assert.equal(answers[0]!.headers.get("ratelimit-limit"), "2");
    // Two people's sessions in one workspace share its ceiling.
    process.env.CANON_API_TOKEN_READS_PER_MINUTE = "100";
    process.env.CANON_API_WORKSPACE_READS_PER_MINUTE = "3";
    const as = async (who: typeof ADMIN, bearer: string) => {
      user = who;
      try {
        return (await call([staticDoc], "get", "/records/lead", { bearer })).status;
      } finally {
        user = ADMIN;
      }
    };
    assert.deepEqual([await as(ADMIN, "session-ada"), await as(ADMIN, "session-ada"), await as(REP, "session-avery"), await as(REP, "session-avery")], [200, 200, 200, 429]);
  } finally {
    process.env.CANON_API_TOKEN_READS_PER_MINUTE = "0";
    process.env.CANON_API_WORKSPACE_READS_PER_MINUTE = "0";
  }
});

/** An object with a field of every filterable type, and a unique code. Added by the tests that use it, so the sweep above does not cover it. */
const KIT = {
  apiName: "custom_kit", registryVersion: 1, object: { label: "Kit", pluralLabel: "Kits", icon: "box", titleField: "custom.name" },
  customFields: [
    { fieldId: "custom.name", apiName: "custom.name", label: "Name", type: "text", required: true },
    { fieldId: "custom.code", apiName: "custom.code", label: "Code", type: "text", unique: true },
    { fieldId: "custom.seats", apiName: "custom.seats", label: "Seats", type: "number" },
    { fieldId: "custom.budget", apiName: "custom.budget", label: "Budget", type: "currency" },
    { fieldId: "custom.due", apiName: "custom.due", label: "Due", type: "date" },
    { fieldId: "custom.kickoff", apiName: "custom.kickoff", label: "Kickoff", type: "datetime" },
    { fieldId: "custom.signed", apiName: "custom.signed", label: "Signed", type: "checkbox" },
    { fieldId: "custom.stage", apiName: "custom.stage", label: "Stage", type: "picklist", options: [{ value: "plan", label: "Plan", active: true }] },
    { fieldId: "custom.tags", apiName: "custom.tags", label: "Tags", type: "multipicklist", options: [{ value: "red", label: "Red", active: true }] },
    { fieldId: "custom.inboxes", apiName: "custom.inboxes", label: "Inboxes", type: "emails" },
    { fieldId: "custom.sponsor", apiName: "custom.sponsor", label: "Sponsor", type: "user" },
    { fieldId: "custom.client", apiName: "custom.client", label: "Client", type: "lookup", lookupTo: "account" },
    { fieldId: "custom.parent", apiName: "custom.parent", label: "Parent kit", type: "lookup", lookupTo: "custom_kit" },
    { fieldId: "custom.double", apiName: "custom.double", label: "Double", type: "formula", formula: "custom.seats * 2", returns: "number" },
  ],
};
let kitAdded = false;
async function withKit() {
  if (kitAdded) return;
  kitAdded = true;
  await db.insert("objectDefs", { orgId: ORG, ...KIT, updatedAt: 1 });
  await db.patch("rolePermissions:rep", { rules: [{ object: "custom_project", fields: [{ apiName: "custom.budget", level: "hidden" }] }, { object: "custom_kit", visibility: "own", unowned: false }] });
}

test("a list filters by a field of every filterable type, each value typed as its field is", async () => {
  await withKit();
  const live = (await call([staticDoc], "get", "/openapi.json")).body as Doc;
  const kickoff = Date.UTC(2026, 11, 1, 15, 30);
  const client = ((await call([staticDoc], "post", "/records/account", { body: { values: { domain: "kit-client.example", name: "Kit client" } } })).body as { id: string }).id;
  const values = {
    "custom.name": "Starter kit", "custom.seats": 12, "custom.budget": 2400050, "custom.due": "2026-12-01", "custom.kickoff": kickoff, "custom.signed": true,
    "custom.stage": "plan", "custom.tags": ["red"], "custom.inboxes": ["a@kit.example"], "custom.sponsor": "users:ada", "custom.client": client,
  };
  const id = ((await call([live], "post", "/records/custom_kit", { body: { values } })).body as { id: string }).id;
  const matched = [
    "custom.seats:gt:5", "custom.budget:gte:2400050", "custom.due:lt:2027-01-01", "custom.kickoff:gt:2026-12-01T15:00:00Z", `custom.kickoff:lte:${kickoff}`,
    "custom.signed:eq:true", "custom.stage:in:plan", "custom.tags:hasAny:red", "custom.inboxes:hasAll:a@kit.example", "custom.sponsor:eq:users:ada",
    `custom.client:eq:${client}`, "recordTitle:startsWith:Starter", `id:eq:${id}`, "createdAt:gt:2000-01-01T00:00:00Z", "custom.code:empty",
  ];
  for (const filter of matched) {
    const res = await call([live], "get", "/records/custom_kit", { query: [["filter", filter]] });
    assert.deepEqual([res.status, (res.body as { data: Array<{ id: string }> }).data.map((r) => r.id)], [200, [id]], filter);
  }
  // A formula filters as the type it gives (its values are computed by the record service, not here).
  assert.equal((await call([live], "get", "/records/custom_kit", { query: [["filter", "custom.double:gt:5"]] })).status, 200);
  assert.equal((await call([live], "get", "/records/custom_kit", { query: [["filter", "custom.kickoff:gt:tomorrow"]], invalid: true })).status, 400);
});

test("a value another record holds on a unique field is refused with 422 naming the field, and names the holder only to someone who sees it", async () => {
  await withKit();
  const live = (await call([staticDoc], "get", "/openapi.json")).body as Doc;
  assert.equal((await call([live], "post", "/records/custom_kit", { body: { values: { "custom.name": "Admin's kit", "custom.code": "K-1" } } })).status, 201);
  const refused = async () => {
    const res = await call([live], "post", "/records/custom_kit", { body: { values: { "custom.name": "Second kit", "custom.code": "k-1" } }, invalid: true });
    const { error } = res.body as { error: { code: string; errors: Array<{ field: string; message: string }> } };
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual([error.code, error.errors.map((e) => e.field)], ["validation_failed", ["custom.code"]]);
    return error.errors[0]!.message;
  };
  assert.match(await refused(), /Admin's kit/);
  user = REP;
  try {
    assert.doesNotMatch(await refused(), /Admin's kit/);
  } finally {
    user = ADMIN;
  }
});

test("a write names only active members of the workspace and records the caller sees, refused with 422 naming the field", async () => {
  await withKit();
  const live = (await call([staticDoc], "get", "/openapi.json")).body as Doc;
  const kit = (values: Record<string, unknown>) => ({ values: { "custom.name": "Kit", ...values } });
  const refusal = async (docs: Doc[], method: string, path: string, body: unknown) => {
    const res = await call(docs, method, path, { body, invalid: true });
    const { error } = res.body as { error: { code: string; errors?: Array<{ field: string; message: string }> } };
    assert.deepEqual([res.status, error.code], [422, "validation_failed"], `${method} ${path} ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
    return error.errors!.map((e) => [e.field, e.message] as const);
  };
  const company = ((await call([staticDoc], "post", "/records/account", { body: { values: { domain: "refs.example", name: "Refs" } } })).body as { id: string }).id;
  const own = ((await call([live], "post", "/records/custom_kit", { body: kit({ "custom.sponsor": "users:ada", "custom.client": company }) })).body as { id: string }).id;
  assert.equal((await call([live], "post", "/records/custom_kit", { body: kit({ "custom.parent": own }) })).status, 201);
  const theirs = await db.insert("canonEntities", { orgId: OUTSIDER.orgId, entityType: "custom_kit", projectionTable: "recordRows", projectionId: "x" });
  for (const sponsor of ["users:nobody", OUTSIDER._id, GONE._id]) assert.deepEqual((await refusal([live], "post", "/records/custom_kit", kit({ "custom.sponsor": sponsor }))).map(([f]) => f), ["custom.sponsor"], sponsor);
  assert.deepEqual((await refusal([live], "post", "/records/custom_kit", kit({ "custom.client": "acc_nowhere" }))).map(([f]) => f), ["custom.client"]);
  const missing = await refusal([live], "patch", `/records/custom_kit/${own}`, { values: { "custom.parent": "canonEntities:nowhere" } });
  assert.deepEqual(missing.map(([f]) => f), ["custom.parent"]);
  assert.deepEqual(await refusal([live], "patch", `/records/custom_kit/${own}`, { values: { "custom.parent": theirs } }), missing);
  assert.deepEqual((await refusal([staticDoc], "post", "/records/task", { values: { subject: "Call", ownerId: GONE._id, dealId: "canonEntities:nowhere" } })).map(([f]) => f).sort(), ["dealId", "ownerId"]);
  const deal = ((await call([staticDoc], "post", "/records/deal", { body: { values: { name: "Refs deal", closeDate: "2026-12-31", stage: "prospecting", companyId: company } } })).body as { id: string }).id;
  assert.deepEqual((await refusal([staticDoc], "patch", `/records/deal/${deal}`, { values: { ownerId: GONE._id } })).map(([f]) => f), ["ownerId"]);
  assert.deepEqual((await refusal([staticDoc], "patch", `/records/account/${company}`, { values: { ownerId: OUTSIDER._id } })).map(([f]) => f), ["ownerId"]);
  assert.deepEqual((await refusal([staticDoc], "post", "/records/deal", { values: { name: "Refs deal", closeDate: "2026-12-31", stage: "prospecting", primaryRepId: GONE._id, companyId: "acc_nowhere" } })).map(([f]) => f).sort(), ["companyId", "primaryRepId"]);
  // A company id is not a person, though the caller sees it.
  assert.deepEqual((await refusal([staticDoc], "post", "/records/task", { values: { subject: "Call", contactId: company } })).map(([f]) => f), ["contactId"]);
  // A list's bulk edit admits the companies it names as a single edit does.
  const task = ((await call([staticDoc], "post", "/records/task", { body: { values: { subject: "Bulk" } } })).body as { id: string }).id;
  const bulk = async (accountId: string) => ((await runner("action")("objects:bulkScoped", { object: "task", op: "update", streamIds: [task], values: { accountId } })) as { results: Array<{ result: { status: string } }> }).results[0]!.result.status;
  assert.deepEqual([await bulk(company), await bulk("acc_nowhere")], ["applied", "invalid"]);
  // A record the caller cannot see is refused as one that does not exist.
  user = REP;
  try {
    assert.deepEqual(await refusal([live], "post", "/records/custom_kit", kit({ ownerId: REP._id, "custom.parent": own })), [["custom.parent", missing[0]![1]]]);
  } finally {
    user = ADMIN;
  }
});

test("the live document leaves out a field the caller's role cannot see", async () => {
  user = REP;
  try {
    const live = (await call([staticDoc], "get", "/openapi.json")).body as Doc;
    const values = live.components.schemas!.CustomProjectValues as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(values.properties).sort(), ["createdAt", "custom.name", "custom.phase", "ownerId", "updatedAt"]);
  } finally {
    user = ADMIN;
  }
});
