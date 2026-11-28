import assert from "node:assert/strict";
import test from "node:test";
import { applyRelated, relatedPorts } from "../convex/lib/outbound/related.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { ListRow } from "../convex/lib/objects/listSpec.ts";

const rows: ListRow[] = [{ id: "hubspot", object: "deal", title: "Deal", createdAt: 1, updatedAt: 1, deletedAt: null, status: "active", version: 1, values: { companyId: "", isClosed: false } }];
const client = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows, defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
const crm = async () => ({ ids: { a: ["hubspot"] }, over: false });
const people = [{ accountId: "a" }, { accountId: "" }];
for (const has of ["some", "none"] as const) test(`HubSpot-only matching deal supports ${has}`, async () => {
  const ports = relatedPorts(client, "ws", crm);
  assert.deepEqual(await applyRelated(people, [{ path: "company.deals", has, filter: [] }], ports), [people[has === "some" ? 0 : 1]]);
});

import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
const loadedHandlers = loadConvex(["deals.ts", "permissions.ts"]);
const handlers = loadedHandlers["deals.ts"];
const dealScope = loadedHandlers["permissions.ts"].dealIdScope as unknown as (...args: any[]) => Promise<any>;
const full = accessOf({ userId: "u", role: "rep" });
const own = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }, { object: "deal", visibility: "own", unowned: false }] });
function fixture() {
  return memoryDb({
    users: [{ _id: "u", orgId: "ws" }],
    canonEntities: [{ _id: "deal-stream", orgId: "ws", entityType: "opportunity", projectionTable: "deals", projectionId: "hubspot" }, { _id: "stream", orgId: "ws", entityType: "account", projectionTable: "crmAccounts", projectionId: "crm" }],
    canonExternalIds: [{ _id: "ext", orgId: "ws", provider: "record:account", externalId: "a", entityId: "stream" }],
    crmAccounts: [{ _id: "crm", orgId: "ws", ownerId: "u", domain: "secret.example", name: "Secret" }],
    deals: [{ _id: "hubspot", orgId: "ws", accountId: "crm", primaryRepId: "u", closeDate: "2026-12-01" }],
  });
}
async function evaluate(db: ReturnType<typeof fixture>, access: Access | null, has: "some" | "none" = "some") {
  const projected: ListRow[] = [];
  for (const d of await db.query("deals").take(3000)) {
    const entity = (await db.query("canonEntities").take(3000)).find((e) => e.projectionTable === "deals" && e.projectionId === d._id);
    if (entity && d.archivedAt === undefined) projected.push({ ...rows[0], id: entity._id, values: { companyId: typeof d.companyId === "string" ? d.companyId : "", isClosed: d.isClosed === true } });
  }
  const fake = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows: projected, defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const scoped = access ? scopedRecordClient(fake, [access], async () => dealScope({ db }, "ws", access)) : fake;
  const port = async (companies: import("../convex/lib/outbound/related.ts").CrmCompany[]) => handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access, companies });
  return applyRelated(people, [{ path: "company.deals", has, filter: [] }], relatedPorts(scoped, "ws", port));
}
test("P1 peer CRM account and deal are not attributed to own-only rep", async () => {
  const db = fixture();
  await db.patch("crm", { ownerId: "peer" });
  await db.patch("hubspot", { primaryRepId: "peer" });
  assert.deepEqual(await evaluate(db, own), []);
  assert.deepEqual(await evaluate(db, own, "none"), people);
});
test("P2 visible own deal on unreadable CRM account reveals no attribution or labels", async () => {
  const db = fixture();
  await db.patch("crm", { ownerId: "peer" });
  assert.deepEqual(await evaluate(db, own), []);
  const result = await handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: own, companies: [{ id: "a" }] });
  assert.ok(!JSON.stringify(result).includes("secret"));
});
for (const apiName of ["companyId", "isClosed"]) test(`P3/4 hidden deal ${apiName} refuses stored and CRM evaluation`, async () => {
  const hidden = accessOf({ userId: "u", role: "rep", rules: [{ object: "deal", fields: [{ apiName, level: "hidden" }] }] });
  for (const companyId of ["a", undefined]) for (const has of ["some", "none"] as const) {
    const db = fixture();
    await db.patch("hubspot", { companyId });
    if (apiName === "companyId") await assert.rejects(() => handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: hidden, companies: [{ id: "a" }] }), { name: "ConvexError" });
    const scoped = scopedRecordClient(client, [hidden], async () => null);
    await assert.rejects(() => applyRelated(people, [{ path: "company.deals", has, filter: [{ field: "isClosed", op: "eq", value: false }] }], relatedPorts(scoped, "ws", crm)), { name: "ConvexError" });
  }
});
test("P5 unsupported account scope fails closed", async () => {
  const custom = loadConvex(["deals.ts"], { "lib/access.ts": (real) => ({ ...real, scopeFor: () => ({ field: "territory", owners: ["u"], unowned: false }) }) })["deals.ts"];
  const result = await custom.crmDealIdsOfCompanies.handler({ db: fixture() }, { orgId: "ws", access: full, companies: [{ id: "a" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.ids)), { a: [] });
});
test("P6 unreadable company resolves by id without passing its domain", async () => {
  const db = fixture();
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", [{ id: "a", name: "Secret", domain: "secret.example", ownerId: "peer", fit: 0, status: "new", segmentIds: [], source: "api", updatedAt: 1, version: 1 }]);
  const fake = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: [{ ...rows[0], id: "deal-stream" }], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const scoped = scopedRecordClient(fake, [own], async () => ({ field: "id", owners: ["deal-stream"], unowned: false }));
  let candidates: unknown;
  const result = await applyRelated(people, [{ path: "company.deals", has: "some", filter: [] }], relatedPorts(scoped, "ws", async (companies) => {
    candidates = companies;
    return handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: own, companies });
  }));
  assert.deepEqual(candidates, [{ id: "a" }]);
  assert.deepEqual(result, [people[0]]);
});
test("P7 system counts peer deals regardless of ownership", async () => {
  const db = fixture();
  await db.patch("crm", { ownerId: "peer" });
  await db.patch("hubspot", { primaryRepId: "peer" });
  assert.deepEqual(await evaluate(db, null), [people[0]]);
});
test("P9 unrestricted caller receives full attribution", async () => {
  assert.deepEqual(await evaluate(fixture(), full), [people[0]]);
});
test("B2 stored company wins over CRM account", async () => {
  const db = fixture();
  await db.patch("hubspot", { companyId: "b" });
  assert.deepEqual(await evaluate(db, full), []);
});
test("B3 Salesforce imported stored company deal counts once", async () => {
  const db = fixture();
  await db.patch("hubspot", { companyId: "a" });
  assert.deepEqual(await evaluate(db, full), [people[0]]);
});
test("B4 domainless company resolves by stream or record id", async () => {
  const db = fixture();
  await db.patch("crm", { domain: undefined });
  for (const company of [{ id: "a" }, { id: "unmapped", stream: "stream" }]) {
    const result = await handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: full, companies: [company] });
    assert.deepEqual(JSON.parse(JSON.stringify(result.ids[company.id])), ["deal-stream"]);
  }
});
test("B5 shared domain identity reaches both CRM accounts", async () => {
  const db = fixture();
  await db.insert("canonExternalIds", { orgId: "ws", provider: "domain", externalId: "shared.example", entityId: "stream" });
  await db.insert("canonExternalIds", { orgId: "ws", provider: "hubspot:account", externalId: "second", entityId: "stream" });
  await db.insert("crmAccounts", { _id: "crm2", orgId: "ws", provider: "hubspot", crmId: "second" });
  await db.insert("deals", { _id: "second-deal", orgId: "ws", accountId: "crm2" });
  await db.insert("canonEntities", { _id: "second-stream", orgId: "ws", entityType: "opportunity", projectionTable: "deals", projectionId: "second-deal" });
  const result = await handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: full, companies: [{ id: "by-domain", domain: "shared.example" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.ids["by-domain"])).sort(), ["deal-stream", "second-stream"]);
});
test("B6 survivor inherits loser deals except undone merges", async () => {
  const db = fixture();
  await db.insert("canonEntities", { _id: "survivor", orgId: "ws", entityType: "account" });
  await db.insert("recordMerges", { _id: "merge", orgId: "ws", survivorStream: "survivor", losers: [{ stream: "stream" }] });
  for (const undoneAt of [undefined, 1]) {
    await db.patch("merge", { undoneAt });
    const result = await handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: full, companies: [{ id: "merged", stream: "survivor" }] });
    assert.deepEqual(JSON.parse(JSON.stringify(result.ids.merged)), undoneAt ? [] : ["deal-stream"]);
  }
});
test("B7 orphan CRM account belongs to no company", async () => {
  const db = fixture();
  await db.delete("ext");
  assert.deepEqual(await evaluate(db, full, "none"), people);
});
test("B8 nonmatching and archived CRM deals do not prevent none", async () => {
  const db = fixture();
  await db.patch("hubspot", { archivedAt: 1 });
  assert.deepEqual(await evaluate(db, full, "none"), people);
  assert.deepEqual(await applyRelated(people, [{ path: "company.deals", has: "none", filter: [{ field: "isClosed", op: "eq", value: true }] }], relatedPorts(client, "ws", crm)), people);
});
test("amended ruling skips deal rows with no canonical entity", async () => {
  const db = fixture();
  await db.delete("deal-stream");
  assert.deepEqual(await evaluate(db, full, "none"), people);
});
test("stream-id filter intersects caller scope without widening it", async () => {
  const scoped = scopedRecordClient(client, [own], async () => ({ field: "id", owners: ["another-stream"], unowned: false }));
  assert.deepEqual(await applyRelated(people, [{ path: "company.deals", has: "some", filter: [] }], relatedPorts(scoped, "ws", crm)), []);
});
test("one CRM account reached from two companies counts for both", async () => {
  const db = fixture();
  const result = await handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: full, companies: [{ id: "a" }, { id: "second", stream: "stream" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.ids)), { a: ["deal-stream"], second: ["deal-stream"] });
});
test("B9 query refuses company, account-deal, aggregate-read and identity-fanout bounds", async () => {
  const db = fixture();
  const query = (companies = [{ id: "a" }]) => handlers.crmDealIdsOfCompanies.handler({ db }, { orgId: "ws", access: full, companies });
  assert.equal((await query(Array.from({ length: 51 }, (_, i) => ({ id: String(i) })))).over, true);
  for (let i = 0; i < 500; i++) await db.insert("deals", { orgId: "ws", accountId: "crm" });
  assert.equal((await query()).over, true);
  const aggregate = fixture();
  for (let i = 0; i < 99; i++) await aggregate.insert("deals", { orgId: "ws", accountId: "crm" });
  assert.equal((await handlers.crmDealIdsOfCompanies.handler({ db: aggregate }, { orgId: "ws", access: full, companies: [{ id: "a" }, { id: "b", stream: "stream" }, { id: "c", stream: "stream" }] })).over, true);
  const dense = fixture();
  await dense.insert("recordMerges", { orgId: "ws", survivorStream: "stream", losers: Array.from({ length: 4000 }, (_, i) => ({ stream: `loser${i}` })) });
  assert.equal((await handlers.crmDealIdsOfCompanies.handler({ db: dense }, { orgId: "ws", access: full, companies: [{ id: "a" }] })).over, true);
});
test("B9 evaluation refuses every port/id/list overflow without partial membership", async () => {
  const { CRM_DEAL_LIMIT_MESSAGE, DEAL_LIST_CALLS_MAX } = await import("../convex/lib/outbound/related.ts");
  const condition = [{ path: "company.deals" as const, has: "none" as const, filter: [] }];
  await assert.rejects(() => applyRelated(people, condition, relatedPorts(client, "ws", async () => ({ ids: {}, over: true }))), { message: CRM_DEAL_LIMIT_MESSAGE });
  await assert.rejects(() => applyRelated(people, condition, relatedPorts(client, "ws", async () => ({ ids: { a: Array.from({ length: 251 }, (_, i) => String(i)) }, over: false }))), { message: CRM_DEAL_LIMIT_MESSAGE });
  const many = Array.from({ length: 5100 }, (_, i) => ({ accountId: String(i) }));
  const empty = { ...client, listObjects: async () => ({ rows: [], total: 0, projectedThrough: {}, nextCursor: null }) };
  await assert.rejects(() => applyRelated(many, condition, relatedPorts(empty, "ws", async (companies) => ({ ids: { [companies[0].id]: Array.from({ length: 250 }, (_, i) => `${companies[0].id}-${i}`) }, over: false }))), { message: CRM_DEAL_LIMIT_MESSAGE });
  let calls = 0;
  const endless = { ...client, listObjects: async () => { calls++; return { rows: [], total: 0, projectedThrough: {}, nextCursor: "more" }; } };
  await assert.rejects(() => applyRelated(people, condition, relatedPorts(endless, "ws", crm)), { message: CRM_DEAL_LIMIT_MESSAGE });
  assert.equal(calls, DEAL_LIST_CALLS_MAX);
});
test("P8 both audience evaluators pass previewed access to CRM queries", async () => {
  const db = fixture();
  await db.patch("hubspot", { primaryRepId: "peer" });
  const store = createMemoryRecordStore();
  await store.putContacts("ws", [{ id: "person", accountId: "a", fullName: "Person", status: "new", updatedAt: 1 }]);
  const fake = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: [{ ...rows[0], id: "deal-stream" }], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const related = [{ path: "company.deals", has: "some", filter: [] }];
  let previewed: Access = full;
  const seen: Array<Access | null> = [];
  const loaded = loadConvex(["audienceActions.ts", "lib/modules/recordReadAction.ts", "modules.ts"], {
    "records.ts": (real) => ({ ...real, clientFor: () => fake, requireCaller: async () => ({ orgId: "ws", access: previewed }), callerClient: (_ctx: unknown, who: { access: Access }) => scopedRecordClient(fake, [who.access], async () => ({ field: "id", owners: [], unowned: false })) }),
  });
  const ctx = { runQuery: async (ref: unknown, args: any) => {
    const name = String(ref);
    if (name.endsWith("crmDealIdsOfCompanies")) {
      seen.push(args.access);
      return handlers.crmDealIdsOfCompanies.handler({ db }, args);
    }
    if (name.endsWith("modules.exportSource")) return { source: { orgId: "ws", userId: "u", filename: "people", people: { filter: [], related } } };
    if (name.endsWith("audiences.get")) return { _id: "aud", orgId: "ws", filter: [], related };
    if (name.endsWith("customFieldValues")) return {};
    if (name.endsWith("addedContactIds")) return [];
    throw new Error(name);
  } };
  const audience = loaded["audienceActions.ts"].audienceContacts as unknown as (...args: any[]) => Promise<any>;
  const modules = loaded["lib/modules/recordReadAction.ts"].readRecordsOf as unknown as (...args: any[]) => Promise<void>;
  for (const restricted of [false, true]) {
    previewed = restricted ? { ...own, preview: { asName: "Rep" } } as Access : full;
    const result = await audience(ctx, { orgId: "ws", userId: "u", role: "rep", access: previewed }, "aud");
    assert.equal(result.contacts.length, restricted ? 0 : 1);
    assert.equal(seen.at(-1)?.preview?.asName, restricted ? "Rep" : undefined);
    const reads: Record<string, any> = {};
    await modules(ctx, { records: { people: { read: "people.count", ids: ["aud"], limit: 100, fields: [], since: null, audience: { moduleId: "m", filter: [], related } } } }, reads);
    assert.equal(reads.people[0].count, restricted ? 0 : 1);
    const exported = await loaded["modules.ts"].exportCsv.handler(ctx, { module: "m", export: "people" });
    assert.equal(exported.rows, restricted ? 0 : 1);
    assert.equal(seen.at(-1)?.preview?.asName, restricted ? "Rep" : undefined);
  }
  const summaryWrites: any[] = [];
  related[0].has = "none";
  previewed = full;
  assert.equal((await loaded["modules.ts"].exportCsv.handler(ctx, { module: "m", export: "people" })).rows, 0);
  await loaded["audienceActions.ts"].refreshSummary.handler({ ...ctx, runMutation: async (_ref: unknown, args: unknown) => { summaryWrites.push(args); } }, { orgId: "ws", audienceId: "aud" });
  assert.equal(summaryWrites[0].summary.total, 0);
  assert.equal(seen.at(-1), null);
});
test("dense company batches split until each CRM query fits without partial results", async () => {
  let calls = 0;
  const candidates = Array.from({ length: 50 }, (_, i) => ({ accountId: String(i) }));
  const empty = { ...client, listObjects: async () => ({ rows: [], total: 0, projectedThrough: {}, nextCursor: null }) };
  const result = await applyRelated(candidates, [{ path: "company.deals", has: "none", filter: [] }], relatedPorts(empty, "ws", async (companies) => {
    calls++;
    return { ids: companies.length > 10 ? {} : Object.fromEntries(companies.map((c) => [c.id, [c.id]])), over: companies.length > 10 };
  }));
  assert.deepEqual(result, candidates);
  assert.ok(calls > 1 && calls <= 99);
});

test("deal conditions refuse when a consumer omits CRM resolution", async () => {
  await assert.rejects(() => applyRelated(people, [{ path: "company.deals", has: "none", filter: [] }], relatedPorts(client, "ws")), { name: "ConvexError" });
});
