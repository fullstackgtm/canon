import assert from "node:assert/strict";
import test from "node:test";
import { applyRelated, relatedPorts } from "../convex/lib/outbound/related.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { accessOf } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { plainObjectDef } from "../convex/lib/objects/registry.ts";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { ListRow } from "../convex/lib/objects/listSpec.ts";
import type { RelatedCondition } from "../convex/lib/objects/validators.ts";

const condition = (has: "some" | "none"): RelatedCondition => ({ path: "company.deals", has, filter: [{ field: "isClosed", op: "eq", value: false }] });
const people = [{ accountId: "a" }, { accountId: "b" }, { accountId: "" }];
const deal = (id: string, companyId: string, isClosed: boolean): ListRow => ({ id, object: "deal", title: id, createdAt: 1, updatedAt: 1, deletedAt: null, status: "active", version: 1, values: { companyId, isClosed } });
const base = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows: [deal("mine", "a", false), deal("peer", "b", false)], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });

test("related some uses only deals the caller can see", async () => {
  const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] })], async () => ({ field: "id", owners: ["mine"], unowned: false }));
  assert.deepEqual(await applyRelated(people, [condition("some")], relatedPorts(client, "ws")), [people[0]]);
  await assert.rejects(() => applyRelated(people, [condition("none")], relatedPorts(client, "ws")));
  await assert.rejects(() => applyRelated([], [condition("none")], relatedPorts(client, "ws")));
  assert.deepEqual(await applyRelated(people, [], relatedPorts(client, "ws")), people);
});

test("hidden join keys and condition fields refuse even with no candidates", async () => {
  for (const [object, apiName] of [["contact", "accountId"], ["deal", "companyId"], ["deal", "isClosed"]]) {
    const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [{ object, fields: [{ apiName, level: "hidden" }] }] })], async () => null);
    await assert.rejects(() => applyRelated([], [condition("some")], relatedPorts(client, "ws")), { name: "ConvexError" });
  }
});

test("company and deal conditions count actual list calls at audience scale", async () => {
  for (const n of [1000, 10000]) {
    let calls = 0;
    const store = createMemoryRecordStore();
    await store.putAccounts("ws", Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, domain: `a${i}.example`, fit: 0, status: "new" as const, segmentIds: [], source: "api", updatedAt: 1, version: 1 })));
    const fake = createFakeRecordClient({ store });
    const client = { ...fake, listRegister: async (...args: Parameters<typeof fake.listRegister>) => { calls++; return fake.listRegister(...args); } };
    const rows = Array.from({ length: n }, (_, i) => ({ accountId: `a${i}` }));
    assert.equal((await applyRelated(rows, [{ path: "company", filter: [] }], relatedPorts(client, "ws"))).length, n);
    assert.equal(calls, n === 1000 ? 6 : 60);
    console.log(`company condition: ${n} people, ${calls} list calls`);
    calls = 0;
    const deals = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: rows.map((r, i) => ({ ...deal(`d${i}`, i % 2 === 0 ? r.accountId : "", false), values: { ...(i % 2 === 0 ? { companyId: r.accountId } : {}), accountId: `crm_${i}`, isClosed: false } })), defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
    const counted = { ...deals, listObjects: async (...args: Parameters<typeof deals.listObjects>) => { calls++; return deals.listObjects(...args); } };
    assert.equal((await applyRelated(rows, [condition("some")], relatedPorts(counted, "ws"))).length, n / 2);
    assert.equal(calls, n === 1000 ? 4 : 40);
    console.log(`mixed-link deal some condition: ${n} people, ${calls} list calls`);
  }
});


test("open-deal conditions ignore closed deals", async () => {
  const fake = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows: [deal("open", "a", false), deal("closed", "b", true)], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  assert.deepEqual(await applyRelated(people, [condition("some")], relatedPorts(fake, "ws")), [people[0]]);
  await assert.rejects(() => applyRelated(people, [condition("none")], relatedPorts(fake, "ws")));
});

test("outbound resolution applies related conditions to filter matches and added contacts", async () => {
  const { resolveContacts } = await import("../convex/lib/outbound/resolve.ts");
  const store = createMemoryRecordStore();
  await store.putContacts("ws", [{ id: "matched", accountId: "a", fullName: "Matched", title: "CFO", status: "new", updatedAt: 1 }, { id: "added", accountId: "b", fullName: "Added", title: "CEO", status: "new", updatedAt: 1 }]);
  const fake = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: [deal("open", "a", false)], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const ports = { listContacts: (req: Parameters<typeof fake.listRegister>[2]) => fake.listRegister("ws", "contact", req), getContact: (id: string) => fake.getContact("ws", id), accountNames: async () => ({}), customValues: async () => ({}), related: relatedPorts(fake, "ws") };
  for (const has of ["some"] as const) {
    const resolved = await resolveContacts(ports, [{ field: "title", op: "eq", value: "CFO" }], ["added"], [condition(has)]);
    assert.deepEqual(resolved.contacts.map((c) => c.id), ["matched"]);
    assert.equal(resolved.total, 1);
  }
});

test("negative deal conditions refuse before any candidate read while CRM identity resolution is unavailable", async () => {
  let reads = 0;
  const client = { ...base, listObjects: async (...args: Parameters<typeof base.listObjects>) => { reads++; return base.listObjects(...args); } };
  await assert.rejects(() => applyRelated(people, [condition("none")], relatedPorts(client, "ws")), { name: "ConvexError" });
  assert.equal(reads, 0);
});

test("CRM-only open deals stay outside the explicit-link some fallback", async () => {
  const { companyDeals } = await import("../convex/lib/dealCompany.ts");
  assert.equal(companyDeals("a", ["crm_a"], [{ _id: "crm", accountId: "crm_a", closeDate: "2026-12-01" }]).length, 1);
  const fake = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows: [{ ...deal("crm", "", false), values: { accountId: "crm_a", isClosed: false } }], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  assert.deepEqual(await applyRelated(people, [condition("some")], relatedPorts(fake, "ws")), []);
});

test("a CRM deal explicitly re-linked by a person belongs only to that company, within caller visibility", async () => {
  const { companyDeals } = await import("../convex/lib/dealCompany.ts");
  const linked = [{ _id: "mine", companyId: "b", accountId: "crm_a", closeDate: "2026-12-01" }, { _id: "peer", companyId: "a", accountId: "crm_b", closeDate: "2026-12-01" }];
  assert.deepEqual(companyDeals("a", ["crm_a"], [linked[0]]), []);
  assert.equal(companyDeals("b", [], [linked[0]]).length, 1);
  const fake = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async () => ({ rows: linked.map((d) => ({ ...deal(d._id, d.companyId, false), values: { ...d, isClosed: false } })), defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const client = scopedRecordClient(fake, [accessOf({ userId: "u", role: "rep", rules: [{ object: "deal", visibility: "own", unowned: false }] })], async () => ({ field: "id", owners: ["mine"], unowned: false }));
  assert.deepEqual(await applyRelated(people, [condition("some")], relatedPorts(client, "ws")), [people[1]]);
});

test("deal paging refuses a dense chunk instead of running without a bound", async () => {
  const { DEAL_PAGES_PER_CHUNK_MAX } = await import("../convex/lib/outbound/related.ts");
  let calls = 0;
  const client = { ...base, listObjects: async () => { calls++; return { rows: [deal("duplicate", "a", false)], total: 100000, nextCursor: "more", projectedThrough: {} }; } };
  await assert.rejects(() => applyRelated(people, [condition("some")], relatedPorts(client, "ws")), { name: "ConvexError" });
  assert.equal(calls, DEAL_PAGES_PER_CHUNK_MAX);
});
