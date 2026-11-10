// A HubSpot sync sorts out its unchanged rows with queries (convex/hubspot.ts unchangedAccounts), so only the rows
// that change wait for its one write slot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { shardOf } from "../convex/lib/objects/write.ts";

const { "hubspot.ts": hubspot } = loadConvex(["hubspot.ts"]);

const DAY = 24 * 60 * 60 * 1000;
const fresh = Date.now() - 60_000;
const stale = Date.now() - 2 * DAY;
const synced = { orgId: "org1", provider: "hubspot", createdAt: 1 };

function world() {
  return memoryDb({
    users: [{ _id: "users:rep", orgId: "org1" }, { _id: "users:other", orgId: "org2" }],
    crmAccounts: [
      { _id: "crmAccounts:acme", ...synced, crmId: "c1", name: "Acme", domain: "acme.com", rawData: { a: 1 }, lastSyncAt: fresh },
      { _id: "crmAccounts:old", ...synced, crmId: "c2", name: "Old Co", rawData: {}, lastSyncAt: stale },
      // An owner a person assigned stays, so the sync's owner does not make the row read as changed.
      { _id: "crmAccounts:kept", ...synced, crmId: "c3", name: "Kept", ownerId: "users:rep", rawData: { accountAssignmentSource: "manual" }, lastSyncAt: fresh },
    ],
    crmContacts: [
      { _id: "crmContacts:ada", ...synced, crmId: "p1", firstName: "Ada", email: "ada@acme.com", accountId: "crmAccounts:acme", rawData: {}, lastSyncAt: fresh },
      { _id: "crmContacts:bob", ...synced, crmId: "p2", firstName: "Bob", title: "CTO", rawData: {}, lastSyncAt: stale },
    ],
    deals: [{ _id: "deals:d1", orgId: "org1", crmId: "d1", name: "Big", syncHash: "not-this-one", lastSyncAt: fresh }],
  });
}

test("companies and people that would change nothing are named; changed, new and custom-valued ones are left to write", async () => {
  const db = world();
  const accounts = await hubspot.unchangedAccounts.handler({ db }, {
    orgId: "org1",
    accounts: [
      { crmId: "c1", name: "Acme", domain: "acme.com", rawData: { a: 1 } },
      { crmId: "c2", name: "Old Co", rawData: {} },
      { crmId: "c3", name: "Kept", ownerId: "users:other", rawData: {} },
      { crmId: "c1x", name: "New Co" },
      { crmId: "c1", name: "Acme", domain: "acme.io", rawData: { a: 1 } },
    ],
  });
  assert.deepEqual([...accounts.unchanged].sort(), ["c1", "c2", "c3"]);
  // Only the row last synced over a day ago has its sync time due.
  assert.deepEqual([...accounts.stamp], ["crmAccounts:old"]);

  const contacts = await hubspot.unchangedContacts.handler({ db }, {
    orgId: "org1",
    contacts: [
      // Email case and the company named by its HubSpot id read as the stored row.
      { crmId: "p1", firstName: "Ada", email: "ADA@acme.com", accountCrmId: "c1", rawData: {} },
      { crmId: "p2", firstName: "Bob", title: "CEO", rawData: {} },
      { crmId: "p1", firstName: "Ada", email: "ada@acme.com", accountCrmId: "c2", rawData: {} },
      { crmId: "p1", firstName: "Ada", email: "ada@acme.com", accountCrmId: "c1", rawData: {}, extra: { lifecyclestage: "lead" } },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(contacts)), { unchanged: ["p1"], stamp: [] });
});

test("a deal reads as unchanged only by the fingerprint the sync last wrote, and a rep from another org is the upsert's to skip", async () => {
  const db = world();
  const deal = { crmId: "d1", name: "Big", closeDate: "2026-12-01", dealType: "new_business", revenueType: "one_time", isClosed: false, isWon: false, rawData: {} };
  const sorted = await hubspot.unchangedDeals.handler({ db }, { orgId: "org1", deals: [deal, { ...deal, primaryRepId: "users:other" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(sorted)), { unchanged: [], stamp: [] });
});

test("stamping an unchanged row writes its sync time and nothing else", async () => {
  const db = world();
  await hubspot.stampSynced.handler({ db }, { ids: ["crmContacts:bob", "crmAccounts:old"] });
  const bob = (await db.get("crmContacts:bob"))!;
  assert.ok((bob.lastSyncAt as number) > fresh);
  assert.equal(bob.title, "CTO");
  assert.ok(((await db.get("crmAccounts:old"))!.lastSyncAt as number) > fresh);
});

test("a new person's row and record are made before their write, which reads the row as new until the person is on the ledger", async () => {
  const db = world();
  const budget = { used: 0, remaining: 1e9 };
  const metrics = Object.fromEntries(["bytesRead", "bytesWritten", "databaseQueries", "documentsRead", "documentsWritten", "functionsScheduled", "scheduledFunctionArgsBytes"].map((k) => [k, budget]));
  const ctx = { db, scheduler: { runAfter: async () => {} }, meta: { getTransactionMetrics: async () => metrics } };
  const cara = { crmId: "p3", firstName: "Cara", lastName: "Quill", email: "cara@acme.com", accountCrmId: "c1", rawData: { properties: { hs_lastmodifieddate: "2026-10-01T00:00:00Z" } } };
  const [prepared] = await hubspot.prepareContacts.handler(ctx, { orgId: "org1", contacts: [cara] });
  assert.equal(prepared.crmId, "p3");
  assert.equal(db.rows("ledgerEntries").length, 0);
  // Until the write, a sync reads the row as changed, so a person whose write never ran is written by the next.
  assert.deepEqual(JSON.parse(JSON.stringify(await hubspot.unchangedContacts.handler(ctx, { orgId: "org1", contacts: [cara] }))), { unchanged: [], stamp: [] });

  const out = await hubspot.upsertContacts.handler(ctx, { orgId: "org1", contacts: [cara] });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { synced: 1, created: 1, unprocessed: [] });
  // The write lands on the record prepared, on the shard the sync was told.
  const entries = db.rows("ledgerEntries");
  assert.ok(entries.length > 0);
  for (const e of entries) assert.equal(e.shard, prepared.shard);
  assert.equal(shardOf(entries[0].streamId as string), prepared.shard);
  assert.equal(db.rows("crmContacts").filter((r) => r.crmId === "p3").length, 1);
  assert.deepEqual([...(await hubspot.unchangedContacts.handler(ctx, { orgId: "org1", contacts: [cara] })).unchanged], ["p3"]);
});
