import assert from "node:assert/strict";
import { test } from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { ListRow } from "../convex/lib/objects/listSpec.ts";

test("hidden contact account links leave both list surfaces' values and row metadata without changing the source", async () => {
  const store = createMemoryRecordStore();
  await store.putContacts("org", [{ id: "con_a", accountId: "acc_a", fullName: "Ada", status: "active", updatedAt: 1 } as never]);
  const row: ListRow & { accountId: string } = { id: "con_a", object: "contact", accountId: "acc_a", title: "Ada", version: 1,
    status: "active", createdAt: 1, updatedAt: 1, deletedAt: null, values: { fullName: "Ada", accountId: "acc_a" } };
  const base = createFakeRecordClient({ store, objects: { rows: async () => ({ rows: [row],
    defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.contact))], heads: {} }) } });
  const client = scopedRecordClient(base, [accessOf({ userId: "rep", role: "rep", rules: [
    { object: "contact", fields: [{ apiName: "accountId", level: "hidden" }] },
  ] })], async () => null);
  for (const method of ["listRegister", "listObjects"] as const) {
    const visible = await client[method]("org", "contact", { limit: 10 });
    assert.equal(visible.rows.length, 1, method);
    assert.equal(visible.rows[0].title, "Ada", method);
    assert.equal(Object.hasOwn(visible.rows[0], "accountId"), false, method);
    assert.equal(Object.hasOwn(visible.rows[0].values, "accountId"), false, method);
    const source = await base[method]("org", "contact", { limit: 10 });
    assert.equal(Object.hasOwn(source.rows[0], "accountId"), true, method);
  }
});
