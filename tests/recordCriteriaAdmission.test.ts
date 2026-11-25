import assert from "node:assert/strict";
import test from "node:test";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { accessOf } from "../convex/lib/access.ts";
import type { IcpTreeAccount } from "../convex/lib/recordContract.ts";

const criteria: Array<[string, IcpTreeAccount]> = [
  ["industry", { industries: ["Software"] }], ["country", { excludeCountries: ["US"] }],
  ["employees", { employees: [{ min: 1, max: 10 }] }], ["city", { cities: ["boston"] }],
  ["ownerId", { excludeOwners: ["u"] }], ["annualRevenue", { revenue: [{ min: 1, max: 10 }] }],
];
test("every scoped criterion reader refuses hidden fields and allows readable criteria", async () => {
  const base = createFakeRecordClient({ store: createMemoryRecordStore() });
  for (const [field, criterion] of criteria) {
    const access = accessOf({ role: "rep", userId: "u", rules: [{ object: "account", fields: [{ apiName: field, level: "hidden" }] }] });
    const client = scopedRecordClient(base, [access], async () => null);
    const reads = [
      () => client.list("ws", { filter: { criteria: [criterion] } }),
      () => client.countSegment("ws", { criteria: [criterion] }),
      () => client.facets("ws", { filter: { criteria: [criterion] }, groupBy: "industry" }),
      () => client.icpTreeCounts("ws", { nodes: [{ id: "n", account: criterion }] }),
      () => client.territoryTreeCounts("ws", { nodes: [{ id: "n", account: criterion }] }),
    ];
    for (const read of reads) await assert.rejects(read, { name: "ConvexError" }, field);
    const readable = scopedRecordClient(base, [accessOf({ role: "rep", userId: "u" })], async () => null);
    assert.equal((await readable.list("ws", { filter: { criteria: [criterion] } })).rows.length, 0);
    assert.equal((await readable.countSegment("ws", { criteria: [criterion] })).total, 0);
    await readable.facets("ws", { filter: { criteria: [criterion] }, groupBy: "industry" });
    await readable.territoryTreeCounts("ws", { nodes: [{ id: "n", account: criterion }] });
  }
});

test("person criteria and custom account criteria use the same refusal in ICP counts", async () => {
  const base = createFakeRecordClient({ store: createMemoryRecordStore() });
  const client = scopedRecordClient(base, [accessOf({ role: "rep", userId: "u", rules: [
    { object: "contact", fields: [{ apiName: "title", level: "hidden" }] },
    { object: "account", fields: [{ apiName: "custom.score", level: "hidden" }] },
  ] })], async () => null);
  await assert.rejects(() => client.icpTreeCounts("ws", { nodes: [{ id: "n", account: { custom: [{ key: "custom.score", min: 1 }] } }] }));
  for (const field of ["titles", "levels", "departments", "topics", "exclude"]) {
    const person = { titles: [], levels: [], departments: [], exclude: [], [field]: ["sales"] };
    await assert.rejects(() => client.icpTreeCounts("ws", { nodes: [{ id: "n", person }] }));
    await assert.rejects(() => client.icpTreeCounts("ws", { nodes: [{ id: "n", has: [{ person }] }] }));
  }
});

test("scoped reads refuse hidden facet measures, company filters and revenue aliases", async () => {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", [{ id: "acc_a", name: "A", domain: "a.example", fit: 0, status: "new", segmentIds: [], source: "api", version: 1, updatedAt: 1, revenue: 123 }]);
  const client = scopedRecordClient(createFakeRecordClient({ store }), [accessOf({ role: "rep", userId: "u", rules: [
    { object: "account", fields: [{ apiName: "annualRevenue", level: "hidden" }, { apiName: "employees", level: "hidden" }] },
    { object: "contact", fields: [{ apiName: "accountId", level: "hidden" }] },
  ] })], async () => null);
  await assert.rejects(() => client.facets("ws", { groupBy: "industry" }));
  assert.equal((await client.listContacts("ws", { filter: { accountId: "acc_a" } })).total, 0);
  assert.equal((await client.listContacts("ws", { filter: { accountIds: ["acc_a"] } })).total, 0);
  await assert.rejects(() => client.listRegister("ws", "account", { sort: { field: "revenue", dir: "asc" } }));
  const rows = await client.listRegister("ws", "account", {});
  assert.equal(rows.rows[0]?.values.revenue, undefined);
});
