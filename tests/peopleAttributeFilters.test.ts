import assert from "node:assert/strict";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { FILTERS_MAX, IN_VALUES_MAX, registerListDef, type ListFilter, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { validateViewListRequest } from "../convex/lib/objects/peopleFilters.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS, type FieldId } from "../convex/lib/objects/registry.ts";
import { viewSpecProblem } from "../convex/lib/objects/views.ts";
import { peopleFilterClient } from "../convex/lib/peopleFilterClient.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { parsePeopleFilter } from "../src/lib/people-list.ts";

const contact = registerListDef("contact", resolveObjectDef(STANDARD_OBJECTS.contact));
const account = resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields: [
  { apiName: "custom.tier", fieldId: "custom.tier" as FieldId, label: "Tier", type: "text" },
] });
const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
const related = { account: registerListDef("account", account), deal };
const filter: ListFilter[] = [
  { field: "title", op: "eq", value: "Buyer" },
  { field: "company.custom.tier", op: "eq", value: "gold" },
  { field: "deal.stage", op: "eq", value: "negotiation" },
  { field: "deal.amount", op: "gte", value: 1_000_000 },
];

test("People view and URL filters validate related fields while view columns, sorts and groups stay on People", () => {
  const spec = { layout: "table" as const, columns: ["title"], group: { field: "title" }, filter };
  assert.equal(viewSpecProblem(contact, spec, new Set(), related), null);
  assert.deepEqual(parsePeopleFilter(JSON.parse(JSON.stringify(filter)), contact, undefined, related), filter);
  assert.equal(viewSpecProblem(contact, { ...spec, filter: [{ field: "deal.createdAt", op: "eq", value: "2026-11-28" }] }, new Set(), related), null);
  assert.ok(viewSpecProblem(contact, { ...spec, sort: { field: "company.employees", dir: "desc" } }, new Set(), related));
  for (const invalid of [
    [{ field: "company.employees", op: "gte", value: "50" }],
    [{ field: "deal.custom.removed", op: "empty" }],
    Array.from({ length: FILTERS_MAX + 1 }, () => filter[1]),
  ] satisfies ListFilter[][]) {
    assert.throws(() => validateViewListRequest(contact, { filter: invalid }, related));
  }
  assert.throws(() => validateViewListRequest(deal, { filter }, related));
});

test("the fake intersects company filters and visibility, deal membership, and People clauses before counts and pages", async () => {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", ["mine", "peer", "silver", "small"].map((id) => ({
    id, name: id, domain: `${id}.example`, ownerId: id === "peer" ? "peer" : "u",
    employees: id === "small" ? 1 : 100, custom: { "custom.tier": id === "silver" ? "silver" : "gold" },
    fit: 0, status: "new", segmentIds: [], source: "test", updatedAt: 1, version: 1,
  })));
  await store.putContacts("ws", ["mine", "mine", "mine", "mine", "peer", "silver", "small", "missing", "mine", "mine"].map((accountId, i) => ({
    id: `p${i}`, fullName: `Person ${i}`, title: i === 3 ? "Manager" : "Buyer",
    ownerId: i === 9 ? "peer" : "u", status: "new", updatedAt: i, accountId,
  })));
  const rows: ListRow[] = [
    { id: "good", stage: "negotiation", amount: 1_000_000 },
    { id: "cheap", stage: "negotiation", amount: 5 },
    { id: "early", stage: "proposal", amount: 1_000_000 },
    { id: "hidden", stage: "negotiation", amount: 1_000_000 },
  ].map(({ id, stage, amount }) => ({ id, title: id, object: "deal", status: "active", createdAt: 0, updatedAt: 0, version: 1, deletedAt: null, values: { stage, amount } }));
  const defs = [account, contact, deal].map(plainObjectDef);
  const base = createFakeRecordClient({ store, objects: { rows: async () => ({ rows, defs, heads: {} }) } });
  const own = accessOf({ userId: "u", role: "rep", rules: ["account", "contact", "deal"].map((object) => ({ object, visibility: "own", unowned: false })) });
  const scoped = scopedRecordClient(base, [own], async () => ({ field: "id", owners: ["good", "cheap", "early"], unowned: false }), async () => defs);
  const client = peopleFilterClient(scoped, [own], async (streams) => streams.flatMap((id) =>
    id === "good" ? ["p0", "p2", "p3", "p4", "p5", "p6", "p7", "p9"] : id === "hidden" ? ["p8"] : ["p1"]));
  const req = { filter, company: { fields: ["fit", "icpIds"] as const, filter: [{ field: "employees", op: "gte" as const, value: 50 }] } };
  const page = await client.listRegister("ws", "contact", { ...req, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map((r) => r.id), ["p2"]);
  assert.ok(page.nextCursor);
  const following = await client.listRegister("ws", "contact", { ...req, limit: 1, cursor: page.nextCursor });
  assert.deepEqual(following.rows.map((r) => r.id), ["p0"]);
  assert.equal(following.nextCursor, null);
  const groups = await client.aggregate("ws", "contact", { ...req, groupBy: [{ field: "title" }], measures: [{ fn: "count" }] });
  assert.equal(groups.rows, 2);
  assert.deepEqual(groups.groups.map((g) => [g.keys, g.values]), [[["Buyer"], [2]]]);
  assert.equal((await client.listRegister("ws", "contact", { filter: [{ field: "deal.amount", op: "gt", value: 1_000_000 }] })).total, 0);

  for (const [object, apiName] of [["account", "custom.tier"], ["deal", "amount"], ["contact", "accountId"]]) {
    const restricted = accessOf({ userId: "u", role: "rep", rules: [{ object, fields: [{ apiName, level: "hidden" }] }] });
    const hidden = peopleFilterClient(scopedRecordClient(base, [restricted], async () => null, async () => defs), [restricted], async () => []);
    await assert.rejects(hidden.listRegister("ws", "contact", req), /hidden for your role/);
  }
  const broad = peopleFilterClient(scoped, [own], async () => Array.from({ length: IN_VALUES_MAX + 1 }, (_, i) => `p${i}`));
  await assert.rejects(broad.listRegister("ws", "contact", req), /Narrow the opportunity filters/);
});

test("an older HTTP service cannot silently omit a company filter on list or aggregate", async () => {
  const base = createHttpRecordClient({
    baseUrl: "http://rs.test", token: "test",
    fetchImpl: async (url) => {
      assert.match(String(url), /\/healthz$/);
      return Response.json({ version: "1.50.0" });
    },
  });
  const client = peopleFilterClient(base, [accessOf({ role: "admin", userId: "u" })], async () => []);
  const req = { filter: [filter[1]] };
  await assert.rejects(client.listRegister("ws", "contact", req), /1\.51\.0/);
  await assert.rejects(client.aggregate("ws", "contact", { ...req, measures: [{ fn: "count" }] }), /1\.51\.0/);
});
