import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoomAttribution, type RoomTarget } from "../convex/lib/modules/roomAttribution.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { accessOf, type ObjectRule } from "../convex/lib/access.ts";
import type { ListRow } from "../convex/lib/objects/listSpec.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const target: RoomTarget = { source: { deal: "mirror", company: "acc_ignored" }, deal: { id: "mirror", streamId: "stream", companyId: "acc_1" } };

async function fixture(rules: ObjectRule[] = []) {
  const store = createMemoryRecordStore();
  await store.putAccounts("org", [{ id: "acc_1", name: "Acme", domain: "acme.test", ownerId: "seller", fit: 0, status: "new", segmentIds: [], source: "test", updatedAt: 1, version: 1 }]);
  await store.putContacts("org", [{ id: "con_1", accountId: "acc_1", fullName: "Priya", email: "priya@acme.test", ownerId: "seller", status: "active", updatedAt: 1 } as never]);
  const row: ListRow = { id: "stream", object: "deal", version: 1, status: "active", title: "Deal", createdAt: 1, updatedAt: 1, deletedAt: null, values: { companyId: "acc_1", ownerId: "seller" } };
  const base = createFakeRecordClient({ store, objects: { rows: async (ws) => ({ rows: ws === "org" ? [row] : [], defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))], heads: {} }) } });
  const scoped = scopedRecordClient(base, [accessOf({ userId: "seller", role: "rep", rules })], async () => rules.some((r) => r.object === "deal" && r.read === false) ? { field: "id", owners: [], unowned: false } : null);
  const service142: RecordClient = new Proxy(scoped, { get(client, key) {
    if (key === "contractVersion") return async () => "1.42.0";
    if (key === "listRegister" || key === "listObjects") return client[key];
    throw new Error(`The service 1.42 issuance fixture exposes no ${String(key)}`);
  } });
  return { client: service142, store, row };
}

test("issuance pins the visible canonical deal account and unique recipient using the service 1.42 reads", async () => {
  const { client } = await fixture();
  assert.equal(await client.contractVersion(), "1.42.0");
  assert.deepEqual(await resolveRoomAttribution(client, "org", target, { email: " PRIYA@ACME.TEST " }), {
    accountId: "acc_1", domain: "acme.test", source: { deal: "mirror", company: "acc_ignored" }, deal: { id: "mirror", streamId: "stream", companyId: "acc_1" }, contact: { id: "con_1", email: "priya@acme.test" },
  });
  assert.deepEqual(await resolveRoomAttribution(client, "org", { source: { deal: null, company: "acc_1" }, deal: null }, {}), { accountId: "acc_1", domain: "acme.test", source: { deal: null, company: "acc_1" } });
  assert.equal(await resolveRoomAttribution(client, "org", { source: { deal: null, company: null }, deal: null }, { contactId: "unlinked" }), null);
  await assert.rejects(resolveRoomAttribution(client, "foreign-org", target, {}));
});

test("hidden records, hidden canonical fields, unlinked recipients and stale deal companies refuse attribution", async () => {
  for (const rule of [
    { object: "account", read: false }, { object: "deal", read: false },
    { object: "account", fields: [{ apiName: "domain", level: "hidden" as const }] },
    { object: "deal", fields: [{ apiName: "companyId", level: "hidden" as const }] },
  ]) {
    const { client } = await fixture([rule]);
    await assert.rejects(resolveRoomAttribution(client, "org", target, {}));
  }
  const { client, row } = await fixture();
  await assert.rejects(resolveRoomAttribution(client, "org", target, { contactId: "foreign_contact" }));
  await assert.rejects(resolveRoomAttribution(client, "org", target, { contactId: "con_1", email: "not-priya@acme.test" }));
  row.values.companyId = "acc_changed";
  await assert.rejects(resolveRoomAttribution(client, "org", target, {}));
});

test("names and nonunique or unreadable email matches never select a contact", async () => {
  const { client, store } = await fixture();
  assert.equal((await resolveRoomAttribution(client, "org", target, { email: "unknown@acme.test" }))!.contact, undefined);
  await store.putContacts("org", [
    { id: "con_1", accountId: "acc_1", fullName: "Priya", email: "priya@acme.test", status: "active", updatedAt: 1 } as never,
    { id: "con_2", accountId: "acc_1", fullName: "Priya", email: "priya@acme.test", status: "active", updatedAt: 1 } as never,
  ]);
  assert.equal((await resolveRoomAttribution(client, "org", target, { email: "priya@acme.test" }))!.contact, undefined);
  for (const rule of [{ object: "contact", read: false }, { object: "contact", fields: [{ apiName: "accountId", level: "hidden" as const }] }]) {
    const hidden = await fixture([rule]);
    assert.equal((await resolveRoomAttribution(hidden.client, "org", target, { email: "priya@acme.test" }))!.contact, undefined);
    await assert.rejects(resolveRoomAttribution(hidden.client, "org", target, { contactId: "con_1" }));
  }
});
