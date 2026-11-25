import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

test("the optional search company predicate masks names without changing contact hits or order", async () => {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", ["mine", "hidden", "deleted"].map((id) => ({ id, name: `${id} company`, domain: `${id}.example`, ownerId: id === "mine" ? "u" : "peer", ...(id === "deleted" ? { deletedAt: 2 } : {}), fit: 0, status: "new" as const, segmentIds: [], source: "test", updatedAt: 1, version: 1 })));
  await store.putContacts("ws", ["mine", "hidden", "deleted", "missing"].map((accountId, i) => ({ id: `p${i}`, fullName: `Visible person ${i}`, accountId, ownerId: "u", status: "new" as const, updatedAt: i })));
  const base = createFakeRecordClient({ store });
  const req = { q: "Visible", objects: ["contact"] };
  const legacy = await base.searchObjects("ws", req);
  const company = { scope: { field: "ownerId", owners: ["u"], unowned: false }, fields: ["name"] as const };
  const masked = await base.searchObjects("ws", { ...req, company });
  assert.deepEqual(masked.hits.map((h) => [h.id, h.title, h.updatedAt]), legacy.hits.map((h) => [h.id, h.title, h.updatedAt]));
  assert.deepEqual(masked.hits.map((h) => h.detail?.company), [null, null, null, "mine company"]);
  assert.ok((await base.searchObjects("ws", { ...req, company: { fields: [] } })).hits.every((h) => h.detail?.company === null));
  assert.deepEqual((await base.searchObjects("ws", { q: "hidden company", objects: ["contact"], company })).hits, []);
  assert.deepEqual(await base.searchObjects("ws", req), legacy);
});
