import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError, convexToJson, jsonToConvex, type Value } from "convex/values";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import type { OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import * as route from "../src/app/hubspot/[...path]/route.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", isActive: true, clerkUserId: "user_ada" };
const REP = { ...ADMIN, _id: "users:avery", role: "rep", name: "Avery", clerkUserId: "user_avery" };
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
const FILES = ["objects.ts", "records.ts", "deals.ts", "customObjects.ts", "permissions.ts", "canon.ts", "activityTargets.ts", "apiIdempotency.ts", "associations.ts", "dealCommittee.ts", "pipelines.ts"];
const M = loadConvex(FILES, { "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }) });

// ---- the workspace ----

const db = memoryDb({
  organizations: [{ _id: ORG, name: "Acme", defaultCurrency: "USD" }],
  users: [ADMIN, REP],
  objectDefs: [{ _id: "objectDefs:project", orgId: ORG, ...PROJECT, updatedAt: 1 }],
  rolePermissions: [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: [{ object: "custom_project", fields: [{ apiName: "custom.budget", level: "hidden" }] }] }],
});
// ---- Convex over a fake HTTP transport ----

const CONVEX_URL = "http://convex.test";
const STUBS: Record<string, unknown> = { "users:list": [ADMIN, REP] };

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

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown, headers?: Record<string, string>) {
  const url = new URL(`/hubspot/${path}`, 'http://canon.test');
  const response = await route[method](new Request(url, { method, headers: { authorization: 'Bearer fixture', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ path: url.pathname.slice('/hubspot/'.length).split('/').map(decodeURIComponent) }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

const base = 'crm/v3/objects';
test('HubSpot properties, values, CRUD, paging and partial batches use record handlers', async () => {
  const properties = (await call('GET', 'crm/v3/properties/contacts')).body.results;
  assert(properties.some((p: { name: string }) => p.name === 'firstname'));
  assert.equal(new Set(properties.map((p: { name: string }) => p.name)).size, properties.length);
  const company = await call('POST', `${base}/companies`, { properties: { name: 'Hub Co', domain: 'hub.example' } });
  assert.equal(company.status, 201, JSON.stringify(company.body));
  const duplicate = await call('POST', `${base}/companies`, { properties: { name: 'Replacement', domain: 'hub.example' } });
  assert.equal(duplicate.body.id, company.body.id);
  assert.equal(duplicate.body.properties.name, 'Hub Co');
  const extra = await call('POST', `${base}/companies`, { properties: { name: 'Refused', domain: 'refused.example', description: 'No overwrite' } });
  assert.equal(extra.status, 400); assert.deepEqual(extra.body.errors[0].context.propertyName, ['description']);
  const person = await call('POST', `${base}/0-1`, { properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@hub.example' }, associations: [{ to: { id: company.body.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }] }] });
  assert.equal(person.status, 201, JSON.stringify(person.body));
  const id = person.body.id;
  assert.equal((await call('PUT', `crm/v4/objects/contacts/${id}/associations/default/companies/${company.body.id}`)).status, 200);
  assert.equal((await call('DELETE', `crm/v4/objects/contacts/${id}/associations/companies/${company.body.id}`)).status, 204);
  assert.deepEqual((await call('GET', `crm/v4/objects/contacts/${id}/associations/companies`)).body.results, []);
  await call('PUT', `crm/v4/objects/contacts/${id}/associations/default/companies/${company.body.id}`);

  assert.equal((await call('GET', `crm/v4/objects/contacts/${id}/associations/companies`)).body.results[0].toObjectId, company.body.id);
  assert.equal((await call('PATCH', `${base}/contacts/${id}`, { properties: { lastname: 'Byron' } })).body.properties.lastname, 'Byron');
  assert.equal((await call('GET', `${base}/contacts/ada%40hub.example?idProperty=email`)).status, 200);
  const batch = await call('POST', `${base}/contacts/batch/read`, { inputs: [{ id }, { id: 'missing' }], properties: ['email'] });
  assert.equal(batch.status, 207); assert.equal(batch.body.results.length, 1); assert.equal(batch.body.numErrors, 1);
  const first = await call('GET', `${base}/companies?limit=1`);
  await call('POST', `${base}/companies`, { properties: { name: 'Other', domain: 'other.hub.example' } });
  const page = await call('GET', `${base}/companies?limit=1`);
  assert.equal(first.body.results.length, 1); assert(page.body.paging.next.after);
  assert.equal((await call('GET', `${base}/companies?limit=1&after=${encodeURIComponent(page.body.paging.next.after)}`)).body.results.length, 1);
  const deal = await call('POST', `${base}/deals`, { properties: { dealname: 'Money', amount: '19.99', deal_currency_code: 'USD', dealtype: 'new_business', closedate: '2026-11-14', dealstage: 'prospecting' } });
  assert.equal(deal.status, 201, JSON.stringify(deal.body)); assert.equal(deal.body.properties.amount, '19.99');
  assert.equal(typeof deal.body.properties.createdate, 'string');
  assert.equal((await call('PUT', `crm/v4/objects/deals/${deal.body.id}/associations/default/companies/${company.body.id}`)).status, 200);
  assert.equal((await call('GET', `${base}/deals/${deal.body.id}?associations=companies`)).body.associations.companies.results[0].id, company.body.id);
  assert.equal((await call('GET', `${base}/companies/${company.body.id}?associations=deals`)).body.associations.deals.results[0].id, deal.body.id);
  const pipeline = (await call('GET', 'crm/v3/pipelines/deals')).body.results[0];
  assert.equal((await call('PATCH', `${base}/deals/${deal.body.id}`, { properties: { pipeline: pipeline.id, dealstage: pipeline.stages[0].id } })).status, 200);
  await runner('action')('dealCommittee:setRole', { streamId: deal.body.id, contactId: id, role: 'champion' });
  assert.equal((await call('PUT', `crm/v4/objects/deals/${deal.body.id}/associations/default/contacts/${id}`)).status, 200);
  const committee = await runner('action')('dealCommittee:forDeal', { streamId: deal.body.id }) as { members: { role: string }[] };
  assert.equal(committee.members[0]!.role, 'champion');
  assert.equal((await call('DELETE', `crm/v4/objects/deals/${deal.body.id}/associations/contacts/${id}`)).status, 204);
  await db.patch('rolePermissions:rep', { rules: [{ object: 'account', visibility: 'own', unowned: false }] });
  user = REP;
  try { assert.deepEqual((await call('GET', `${base}/contacts/${id}?associations=companies`)).body.associations.companies.results, []); }
  finally { user = ADMIN; await db.patch('rolePermissions:rep', { rules: [{ object: 'custom_project', fields: [{ apiName: 'custom.budget', level: 'hidden' }] }] }); }

  assert.equal((await call('DELETE', `${base}/contacts/${id}`)).status, 204);
  const missing = await call('POST', `${base}/companies`, { properties: { name: 'No domain' } });
  assert.equal(missing.status, 400); assert.equal(missing.body.category, 'VALIDATION_ERROR'); assert(missing.body.correlationId);
  assert.deepEqual(missing.body.errors[0].context.propertyName, ['domain']);
  assert.equal((await call('POST', 'crm/v3/properties/contacts', {})).status, 405);
});
test('search translates each supported operator and refuses lossy expressions', async () => {
  await call('POST', `${base}/companies`, { properties: { name: 'Search A', domain: 'search-a.example', numberofemployees: '10' } });
  await call('POST', `${base}/companies`, { properties: { name: 'Search B', domain: 'search-b.example', numberofemployees: '20' } });
  for (const [operator, extra, count] of [
    ['EQ', { value: 'Search A' }, 1], ['NEQ', { value: 'Search A' }, 3],
    ['LT', { value: '15' }, 1], ['LTE', { value: '10' }, 1],
    ['GT', { value: '15' }, 1], ['GTE', { value: '20' }, 1],
    ['BETWEEN', { value: '10', highValue: '20' }, 2],
    ['IN', { values: ['Search A', 'Search B'] }, 2], ['NOT_IN', { values: ['Search A', 'Search B'] }, 2],
    ['HAS_PROPERTY', {}, 4], ['NOT_HAS_PROPERTY', {}, 0], ['CONTAINS_TOKEN', { value: 'Search' }, 2],
  ] as const) {
    const r = await call('POST', `${base}/companies/search`, { filterGroups: [{ filters: [{ propertyName: ['LT','LTE','GT','GTE','BETWEEN'].includes(operator) ? 'numberofemployees' : 'name', operator, ...extra }] }], sorts: ['-name'], properties: ['name'] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.total, count, operator);
  }
  const or = await call('POST', `${base}/companies/search`, { filterGroups: ['Search A', 'Search B'].map(value => ({ filters: [{ propertyName: 'name', operator: 'EQ', value }] })) });
  assert.equal(or.body.total, 2);
  for (const body of [{ query: 'search' }, { filterGroups: [{ filters: [{ propertyName: 'name', operator: 'NOPE' }] }] }, { sorts: ['name', 'domain'] }, { filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: 'a' }] }, { filters: [{ propertyName: 'domain', operator: 'EQ', value: 'b' }] }] }]) assert.equal((await call('POST', `${base}/companies/search`, body)).status, 400);
  STUBS['objects:writeScoped'] = { status: 'proposed', streamId: 'held', version: 1 };
  try { assert.equal((await call('POST', `${base}/notes`, { properties: { hs_note_body: 'Held' } })).status, 400); } finally { delete STUBS['objects:writeScoped']; }
  user = REP;
  try { const p = await call('GET', 'crm/v3/properties/custom_project'); assert(!p.body.results.some((p: { name: string }) => p.name === 'canon_637573746f6d2e627564676574')); } finally { user = ADMIN; }
});

test('batch writes, property types, system values and type IDs keep HubSpot shapes', async () => {
  for (const object of ['contacts', 'companies', 'deals', 'tasks', 'notes', 'meetings', 'calls', 'products', 'custom_project']) {
    const r = await call('GET', `crm/v3/properties/${object}`);
    assert.equal(r.status, 200);
    assert.equal(new Set(r.body.results.map((p: { name: string }) => p.name)).size, r.body.results.length);
  }
  const products = await call('POST', `${base}/0-7/batch/create`, { inputs: [{ properties: { name: 'A', price: '12.34', canon_616374697665: 'true' } }, { properties: { name: 'B' } }] });
  assert.equal(products.status, 201, JSON.stringify(products.body));
  assert.equal(products.body.results[0].properties.price, '12.34');
  assert.equal(products.body.results[0].properties.canon_616374697665, 'true');
  const id = products.body.results[0].id;
  assert.equal((await call('POST', `${base}/products/batch/update`, { inputs: [{ id, properties: { name: 'Changed' } }] })).body.results[0].properties.name, 'Changed');
  assert.equal((await call('POST', `${base}/products/batch/archive`, { inputs: [{ id }] })).status, 200);
  assert.equal((await call('GET', `${base}/products?archived=true`)).body.results[0].archived, true);
  const meeting = await call('POST', `${base}/meetings`, { properties: { hs_meeting_title: 'Proof', hs_meeting_start_time: '2026-11-14T10:00:00.000Z' } });
  assert.equal(meeting.status, 201, JSON.stringify(meeting.body));
  assert.equal(meeting.body.properties.hs_meeting_start_time, '2026-11-14T10:00:00.000Z');
  const unknown = await call('GET', `${base}/tickets`);
  assert.equal(unknown.status, 404); assert.equal(unknown.body.category, 'OBJECT_NOT_FOUND');
});
