import assert from "node:assert/strict";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

async function fixture() {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", ["mine", "peer"].map((id, i) => ({ id, name: id, domain: `${id}.example`, ownerId: i ? "other" : "u", fit: i ? .99 : .8, icpIds: ["secret"], status: "new" as const, segmentIds: [], source: "test", updatedAt: 1, version: 1 })));
  await store.putContacts("ws", ["mine", "peer"].flatMap((accountId) => [0, 1].map((i) => ({ id: `${accountId}${i}`, accountId, fullName: `${accountId}${i}`, ownerId: "u", status: "new" as const, updatedAt: 1 }))));
  const base = createFakeRecordClient({ store });
  const rep = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }] });
  const client = scopedRecordClient(base, [rep], async () => null);
  return { base, rep, client };
}

test("a rep cannot read, filter, sort, count or aggregate a hidden company's fit through visible people", async () => {
  const { client } = await fixture();
  const all = await client.listRegister("ws", "contact", {});
  assert.equal(all.total, 4);
  for (const row of all.rows) {
    assert.equal(row.values.accountFit, row.accountId === "mine" ? 80 : undefined);
    assert.deepEqual(row.values.accountIcpIds, row.accountId === "mine" ? ["secret"] : undefined);
  }
  for (const filter of [[{ field: "accountFit", op: "gte" as const, value: 80 }], [{ field: "accountFit", op: "neq" as const, value: 99 }], [{ field: "accountIcpIds", op: "hasAny" as const, value: ["secret"] }]]) {
    const first = await client.listRegister("ws", "contact", { filter, limit: 1 });
    assert.equal(first.total, 2);
    const second = await client.listRegister("ws", "contact", { filter, limit: 1, cursor: first.nextCursor! });
    assert.equal(second.total, 2);
    assert.notEqual(first.rows[0].id, second.rows[0].id);
    assert.equal(second.nextCursor, null);
    assert.ok([...first.rows, ...second.rows].every((r) => r.accountId === "mine"));
  }
  assert.equal((await client.listRegister("ws", "contact", { filter: [{ field: "accountFit", op: "empty" }] })).total, 0);
  assert.equal((await client.listRegister("ws", "contact", { sort: { field: "accountFit", dir: "desc" } })).total, 2);
  const groups = await client.aggregate("ws", "contact", { filter: [{ field: "accountFit", op: "gte", value: 0 }], groupBy: [{ field: "ownerId" }], measures: [{ fn: "count" }, { fn: "sum", field: "accountFit" }] });
  assert.equal(groups.rows, 2);
  assert.deepEqual(groups.groups.map((g) => g.values), [[2, 160]]);
});

test("hidden account fields refuse derived use and leave contact rows absent, across principals", async () => {
  const { base, rep } = await fixture();
  const hidden = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", fields: [{ apiName: "fit", level: "hidden" }, { apiName: "icpIds", level: "hidden" }] }] });
  for (const accesses of [[hidden], [rep, hidden]]) {
    const client = scopedRecordClient(base, accesses, async () => null);
    const page = await client.listRegister("ws", "contact", {});
    assert.ok(page.rows.every((r) => !("accountFit" in r.values) && !("accountIcpIds" in r.values)));
    await assert.rejects(() => client.listRegister("ws", "contact", { filter: [{ field: "accountIcpIds", op: "hasAny", value: ["secret"] }] }));
    await assert.rejects(() => client.listRegister("ws", "contact", { sort: { field: "accountFit", dir: "asc" } }));
    await assert.rejects(() => client.aggregate("ws", "contact", { measures: [{ fn: "sum", field: "accountFit" }] }));
  }
});

test("unrestricted members retain exact responses and base call counts without health reads", async () => {
  const { base } = await fixture();
  let lists = 0, health = 0;
  const counted = { ...base, contractVersion: async () => { health++; return "1.51.0"; }, listRegister: async (...args: Parameters<typeof base.listRegister>) => { lists++; return base.listRegister(...args); } };
  const client = scopedRecordClient(counted, [accessOf({ userId: "u", role: "rep" })], async () => null);
  const request = { filter: [{ field: "accountIcpIds", op: "hasAny" as const, value: ["secret"] }], limit: 1 };
  const expected = await base.listRegister("ws", "contact", request);
  assert.equal(JSON.stringify(await client.listRegister("ws", "contact", request)), JSON.stringify(expected));
  assert.equal(lists, 1);
  assert.equal(health, 0);
});

test("1.50.0 and unknown services fail before sending any protected contact list or aggregate", async () => {
  const { base, rep } = await fixture();
  for (const version of ["1.50.0", null]) {
    let reads = 0;
    const old = { ...base, mode: "http" as const, contractVersion: async () => version, listRegister: async (...args: Parameters<typeof base.listRegister>) => { reads++; return base.listRegister(...args); }, aggregate: async (...args: Parameters<typeof base.aggregate>) => { reads++; return base.aggregate(...args); } };
    const client = scopedRecordClient(old, [rep], async () => null);
    await assert.rejects(() => client.listRegister("ws", "contact", {}));
    await assert.rejects(() => client.aggregate("ws", "contact", { measures: [{ fn: "count" }] }));
    assert.equal(reads, 0);
  }
});


test("an ICP-scoped audience keeps only people at companies visible to the rep", async () => {
  const { client } = await fixture();
  const { resolveContacts } = await import("../convex/lib/outbound/resolve.ts");
  const resolved = await resolveContacts({ listContacts: (req) => client.listRegister("ws", "contact", req), getContact: (id) => client.getContact("ws", id), accountNames: async () => ({}), customValues: async () => ({}) }, [{ field: "accountIcpIds", op: "hasAny", value: ["secret"] }], []);
  assert.equal(resolved.total, 2);
  assert.deepEqual(resolved.contacts.map((c) => c.id).sort(), ["mine0", "mine1"]);
});

test("a real HTTP adapter checks the 1.50.0 fake service before issuing a protected read", async () => {
  const { rep } = await fixture();
  let health = 0, records = 0;
  const base = createHttpRecordClient({ baseUrl: "http://fake-record-service", token: "test", fetchImpl: async (input) => {
    if (String(input).endsWith("/healthz")) { health++; return new Response(JSON.stringify({ version: "1.50.0-old" }), { status: 200 }); }
    records++;
    return new Response(JSON.stringify({ rows: [], total: 999, nextCursor: null, projectedThrough: {} }), { status: 200 });
  } });
  const client = scopedRecordClient(base, [rep], async () => null);
  await assert.rejects(() => client.listRegister("ws", "contact", { filter: [{ field: "accountIcpIds", op: "hasAny", value: ["secret"] }] }));
  assert.equal(health, 1);
  assert.equal(records, 0);
});


test("the caller predicate keeps paging bounded at 10,000 companies with measured list calls", async () => {
  const store = createMemoryRecordStore();
  const n = 10000;
  await store.putAccounts("ws", Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, domain: `a${i}.example`, ownerId: i % 2 ? "peer" : "u", fit: .8, icpIds: ["target"], status: "new" as const, segmentIds: [], source: "test", updatedAt: 1, version: 1 })));
  await store.putContacts("ws", Array.from({ length: n }, (_, i) => ({ id: `p${i}`, accountId: `a${i}`, fullName: `P${i}`, status: "new" as const, updatedAt: 1 })));
  const fake = createFakeRecordClient({ store });
  for (const restricted of [false, true]) {
    let calls = 0, health = 0, seen = 0;
    const base = { ...fake, contractVersion: async () => { health++; return "1.51.0"; }, listRegister: async (...args: Parameters<typeof fake.listRegister>) => { calls++; return fake.listRegister(...args); } };
    const access = accessOf({ userId: "u", role: "rep", rules: restricted ? [{ object: "account", visibility: "own", unowned: false }] : [] });
    const client = scopedRecordClient(base, [access], async () => null);
    let cursor: string | undefined;
    do {
      const page = await client.listRegister("ws", "contact", { filter: [{ field: "accountIcpIds", op: "hasAny", value: ["target"] }], limit: 200, ...(cursor ? { cursor } : {}) });
      assert.equal(page.total, restricted ? n / 2 : n);
      seen += page.rows.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen, restricted ? 5000 : 10000);
    assert.equal(calls, restricted ? 25 : 50);
    assert.equal(health, 0);
    console.log(`10k-company ICP list: restricted=${restricted}, rows=${seen}, list calls=${calls}, health reads=${health}`);
  }
});


test("field limits are independent and denying account reads masks both derived fields", async () => {
  const { base } = await fixture();
  for (const [field, derived, sibling] of [["fit", "accountFit", "accountIcpIds"], ["icpIds", "accountIcpIds", "accountFit"]]) {
    const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [{ object: "account", fields: [{ apiName: field, level: "hidden" }] }] })], async () => null);
    const rows = (await client.listRegister("ws", "contact", {})).rows;
    assert.ok(rows.every((r) => !(derived in r.values) && sibling in r.values));
  }
  const denied = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [{ object: "account", read: false }] })], async () => null);
  const all = await denied.listRegister("ws", "contact", {});
  assert.equal(all.total, 4);
  assert.ok(all.rows.every((r) => !("accountFit" in r.values) && !("accountIcpIds" in r.values)));
  assert.equal((await denied.listRegister("ws", "contact", { filter: [{ field: "accountFit", op: "gte", value: 0 }] })).total, 0);
});

test("contact projection reads retain stream IDs and in-flight cursors without a company join", async () => {
  const store = createMemoryRecordStore();
  await store.putContacts("ws", [{ id: "register-unworked", fullName: "Unworked", accountId: "", status: "new", updatedAt: 1 }]);
  const { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } = await import("../convex/lib/objects/registry.ts");
  const base = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: ["stream-a", "stream-b"].map((id) => ({ id, object: "contact", title: id, createdAt: 1, updatedAt: 1, deletedAt: null, status: "active" as const, version: 1, values: { fullName: id } })), defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.contact))], heads: {} }) } });
  const first = await base.listObjects("ws", "contact", { limit: 1 });
  let projection = 0, register = 0, health = 0;
  const counted = { ...base, listObjects: async (...args: Parameters<typeof base.listObjects>) => { projection++; return base.listObjects(...args); }, listRegister: async (...args: Parameters<typeof base.listRegister>) => { register++; return base.listRegister(...args); }, contractVersion: async () => { health++; return "1.50.0"; } };
  const rep = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }] });
  const client = scopedRecordClient(counted, [rep], async () => null);
  const next = await client.listObjects("ws", "contact", { limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(next.rows.map((r) => r.id), ["stream-b"]);
  assert.equal(next.total, 2);
  assert.equal(projection, 1);
  assert.equal(register, 0);
  assert.equal(health, 0);
});
