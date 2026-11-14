import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError, convexToJson, jsonToConvex, type Value } from "convex/values";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import type { OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import * as route from "../src/app/services/[...path]/route.ts";

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
  "users:list": [ADMIN, REP],
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

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>) {
  const url = new URL(`/services/${path}`, 'http://canon.test');
  const response = await route[method](new Request(url, { method, headers: { authorization: 'Bearer fixture', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ path: url.pathname.slice('/services/'.length).split('/') }) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
const base = 'data/v66.0';
test('Salesforce discovery, describe and CRUD use the caller record handlers', async () => {
  assert.equal((await call('GET', 'data')).body.length, 17);
  assert.equal((await call('GET', 'oauth2/userinfo')).body.user_id, ADMIN._id);
  const describe = await call('GET', `${base}/sobjects/Opportunity/describe`);
  assert.equal(describe.body.fields.find((f: { name: string }) => f.name === 'Amount').type, 'currency');
  const account = await call('POST', `${base}/sobjects/Account`, { Name: 'API Co', Website: 'sf-api.example' });
  assert.equal(account.status, 201, JSON.stringify(account.body)); assert.equal(account.body.success, true);
  const id = account.body.id;
  assert.equal((await call('GET', `${base}/sobjects/Account/${id}?fields=Id,Name`)).body.Name, 'API Co');
  assert.equal((await call('PATCH', `${base}/sobjects/Account/${id}`, { Name: 'Changed' })).status, 204);
  const person = await call('POST', `${base}/sobjects/Contact`, { FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@sf-api.example', AccountId: id });
  assert.equal(person.status, 201);
  assert.equal((await call('GET', `${base}/sobjects/Contact/${person.body.id}`)).body.Name, 'Ada Lovelace');
  assert.equal((await call('PATCH', `${base}/sobjects/Contact/${person.body.id}`, { LastName: 'Byron' })).status, 204);
  assert.equal((await call('GET', `${base}/sobjects/Contact/${person.body.id}`)).body.Name, 'Ada Byron');
  assert.equal((await call('DELETE', `${base}/sobjects/Contact/${person.body.id}`)).status, 204);
  assert.equal((await call('DELETE', `${base}/sobjects/Account/${id}`)).status, 204);
  const bad = await call('GET', `${base}/sobjects/Nonsense/describe`);
  assert.equal(bad.status, 404); assert.equal(bad.body[0].errorCode, 'INVALID_TYPE');
});
test('SOQL comparisons and refusals enter through the route', async () => {
  await call('POST', `${base}/sobjects/Lead`, { LastName: 'Alpha', FirstName: 'Ada', Status: 'new' });
  await call('POST', `${base}/sobjects/Lead`, { LastName: 'Beta', FirstName: 'Grace', Status: 'working', Title: 'CTO' });
  const q = async (s: string) => call('GET', `${base}/query?q=${encodeURIComponent(s)}`);
  for (const where of ["Status = 'new'", "Status != 'new'", "Title = null", "Title != null", "FirstName LIKE 'Ad%'", "FirstName LIKE '%da%'", "FirstName LIKE 'Ada'", "Status IN ('new','working')", "Status NOT IN ('new','working')", "(Status = 'new' OR Status = 'working')", 'CreatedDate = TODAY', 'CreatedDate >= YESTERDAY', 'CreatedDate > LAST_N_DAYS:3', 'CreatedDate < THIS_MONTH', 'CreatedDate <= LAST_MONTH', 'CreatedDate = THIS_YEAR', 'CreatedDate = LAST_YEAR', 'CreatedDate = TOMORROW', 'CreatedDate = NEXT_N_DAYS:2', 'CreatedDate = NEXT_MONTH', 'CreatedDate = NEXT_YEAR']) {
    const result = await q(`SELECT Id,LastName FROM Lead WHERE ${where} ORDER BY LastName DESC LIMIT 5 OFFSET 0`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  for (const [s, code] of [
    ['SELECT Missing FROM Account', 'INVALID_FIELD'], ['SELECT Id FROM Missing', 'INVALID_TYPE'],
    ['SELECT COUNT(Name) FROM Account', 'MALFORMED_QUERY'], ['SELECT Id FROM Account GROUP BY Name', 'MALFORMED_QUERY'],
    ["SELECT Id FROM Account WHERE Name = 'a' OR Website = 'b'", 'MALFORMED_QUERY'],
    ['SELECT (SELECT Id FROM Contacts) FROM Account', 'MALFORMED_QUERY'], ['SELECT Id FROM Account OFFSET 2001', 'MALFORMED_QUERY'],
    ['SELECT Id FROM Account FOR UPDATE', 'MALFORMED_QUERY'], ['SELECT Id FROM Account; DELETE', 'MALFORMED_QUERY'],
  ]) assert.equal((await q(s!)).body[0].errorCode, code);
  for (const [where, names] of [
    ["Status = 'new'", ['Alpha']], ["Status != 'new'", ['Beta']],
    ["Title = null", ['Alpha']], ["Title != null", ['Beta']],
    ["FirstName LIKE 'Ad%'", ['Alpha']], ["FirstName LIKE '%rac%'", ['Beta']],
    ["Status IN ('new','working')", ['Alpha', 'Beta']], ["Status NOT IN ('new','working')", []],
    ["(Status = 'new' OR Status = 'working')", ['Alpha', 'Beta']],
  ] as const) assert.deepEqual((await q(`SELECT LastName FROM Lead WHERE ${where} ORDER BY LastName ASC`)).body.records.map((r: { LastName: string }) => r.LastName), names);
  assert.equal((await q('SELECT COUNT() FROM Lead')).body.totalSize, 2);
});
test('locators reauthorize, reparse and page without losing records; held writes fail', async () => {
  for (let i = 0; i < 201; i++) {
    const saved = await call('POST', `${base}/sobjects/Lead`, { LastName: `Paging ${i}`, OwnerId: ADMIN._id });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  }
  const first = await call('GET', `${base}/query?q=${encodeURIComponent("SELECT Id,LastName,Owner.Name FROM Lead WHERE LastName LIKE 'Paging%' ORDER BY LastName ASC")}`, undefined, { 'Sforce-Query-Options': 'batchSize=200' });
  assert.equal(first.body.records.length, 200); assert.equal(first.body.done, false);
  assert.equal(first.body.records[0].Owner.Name, 'Ada');
  user = OUTSIDER;
  try { assert.equal((await call('GET', first.body.nextRecordsUrl.slice('/services/'.length))).body.records.length, 0); } finally { user = ADMIN; }
  const next = await call('GET', first.body.nextRecordsUrl.slice('/services/'.length));
  assert.equal(next.body.records.length, 1); assert.equal(next.body.done, true);
  assert.equal(new Set([...first.body.records, ...next.body.records].map(r => r.Id)).size, 201);
  const corrupt = Buffer.from(JSON.stringify({ q: 'SELECT Secret FROM Lead', seen: 0, skip: 0, batch: 200 })).toString('base64url');
  assert.equal((await call('GET', `${base}/query/${corrupt}`)).body[0].errorCode, 'INVALID_FIELD');
  STUBS['objects:writeScoped'] = { status: 'proposed', streamId: 'held', version: 1 };
  try {
    const held = await call('POST', `${base}/sobjects/Lead`, { LastName: 'Held' });
    assert.equal(held.status, 400); assert.equal(held.body[0].errorCode, 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
  } finally { delete STUBS['objects:writeScoped']; }
});

test('derived fields, currency, User offset and malformed inputs retain their meanings', async () => {
  const query = (q: string) => call('GET', `${base}/query?q=${encodeURIComponent(q)}`);
  assert.equal((await query('SELECT Id FROM User OFFSET 1')).body.records.length, 1);
  const deal = await call('POST', `${base}/sobjects/Opportunity`, { Name: 'Money', Amount: 19.99, CloseDate: '2026-11-14', StageName: 'prospecting', OwnerId: ADMIN._id });
  assert.equal(deal.status, 201, JSON.stringify(deal.body));
  assert.equal((await query('SELECT Id,Amount FROM Opportunity WHERE Amount = 19.99')).body.records[0].Amount, 19.99);
  assert.equal((await query("SELECT Id FROM Account WHERE Name LIKE '%a%b%' ")).body[0].errorCode, 'MALFORMED_QUERY');
  assert.equal((await call('GET', `${base}/query/${Buffer.from('null').toString('base64url')}`)).status, 400);
  assert.equal((await call('POST', `${base}/sobjects/Event`, { Subject: 'Bad', StartDateTime: 'invalid' })).body[0].errorCode, 'INVALID_FIELD');
  const project = await call('GET', `${base}/sobjects/custom_project__c/describe`);
  assert(project.body.fields.some((f: { name: string }) => f.name === 'custom_budget__c'));
  user = REP;
  try {
    const visible = await call('GET', `${base}/sobjects/custom_project__c/describe`);
    assert(!visible.body.fields.some((f: { name: string }) => f.name === 'custom_budget__c'));
    assert.equal((await query('SELECT custom_budget__c FROM custom_project__c')).body[0].errorCode, 'INVALID_FIELD');
  } finally { user = ADMIN; }
});
