import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf } from "../convex/lib/access.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";

const ORG = "organizations:readback";
const ADMIN = { _id: "users:ada", orgId: ORG, name: "Ada", role: "admin", isActive: true };
let user = ADMIN;
let access = accessOf({ userId: ADMIN._id, role: "admin" });
const store = createMemoryRecordStore();
const base = createFakeRecordClient({ store });
const modules = loadConvex(["canonEntities.ts", "objects.ts", "records.ts", "deals.ts", "permissions.ts", "canon.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }),
  "records.ts": (real) => ({ ...real,
    requireCaller: async () => ({ orgId: ORG, userId: user._id, access }),
    callerClient: () => scopedRecordClient(base, [access], async () => null),
  }),
});
function harness() {
  const db = memoryDb({ organizations: [{ _id: ORG }], users: [ADMIN], objectDefs: ["account", "contact", "deal", "custom_kit"].map((object) => ({
    _id: `objectDefs:${object}`, orgId: ORG, apiName: object, registryVersion: 1,
    ...(object === "custom_kit" ? { object: { label: "Kit", pluralLabel: "Kits", icon: "box", titleField: "custom.name" } } : {}),
    customFields: [{ fieldId: "custom.name", apiName: "custom.name", label: "Name", type: "text" }],
  })) });
  const ctx = { db, scheduler: { runAfter: async () => null }, runQuery: async (ref: unknown, args: unknown): Promise<any> => invoke(ref, args) };
  const invoke = (ref: unknown, args: unknown): Promise<any> => {
    const parts = String(ref).split(".");
    return modules[`${parts.at(-2)}.ts`][parts.at(-1)!].handler(ctx, args);
  };
  return { db, ctx, call: (file: string, fn: string, args: unknown) => modules[file][fn].handler(ctx, args) };
}

test("workspace lookup finds unworked companies and people by natural key or returned register id without writing, respecting scope", async () => {
  const { db, call } = harness();
  const account = (await base.upsertAccounts(ORG, { records: [{ domain: "acme.example", name: "Acme" }], source: "manual", idempotencyKey: "a" })).ids[0];
  const contact = (await base.upsertContacts(ORG, { records: [{ fullName: "Ana", email: "ana@acme.example", accountId: account }], source: "manual", idempotencyKey: "c" })).ids[0];
  for (const [entityType, key, id] of [["account", { domain: "ACME.EXAMPLE" }, account], ["contact", { email: "ANA@ACME.EXAMPLE" }, contact]] as const) {
    for (const selector of [key, { recordId: id }]) {
      const found = await call("canonEntities.ts", "findScoped", { entityType, ...selector });
      assert.equal(found.recordId, id);
      assert.equal(found.entityId, null);
      assert.ok(await call("objects.ts", "read", { id }));
    }
  }
  assert.equal(db.rows("canonEntities").length, 0);
  access = accessOf({ userId: ADMIN._id, role: "rep", rules: [{ object: "account", read: false }, { object: "contact", read: false }] });
  for (const [entityType, id] of [["account", account], ["contact", contact]]) {
    assert.equal(await call("canonEntities.ts", "findScoped", { entityType, recordId: id }), null);
    assert.equal(await call("objects.ts", "read", { id }), null);
  }
  access = accessOf({ userId: ADMIN._id, role: "admin" });
});

test("single-record ledger reads preserve custom values across objects and hide them under field rules", async () => {
  const { db, ctx, call } = harness();
  for (const object of ["account", "contact", "deal", "custom_kit"]) {
    let streamId: string;
    if (object === "account" || object === "contact") {
      const saveParty = modules["canon.ts"].saveParty as unknown as (ctx: unknown, args: unknown) => Promise<{ entityId: string }>;
      streamId = (await saveParty(ctx, {
        orgId: ORG, object, seed: null,
        identity: { projectionTable: object === "account" ? "recordAccounts" : "recordContacts", projectionId: `register_${object}`, externalIds: [], label: object },
        source: { kind: "user", userId: ADMIN._id }, values: { ...(object === "account" ? { name: "Acme", domain: "acme.example" } : { fullName: "Ana", email: "ana@acme.example" }), "custom.name": object },
      })).entityId;
    } else if (object === "deal") {
      const created = await call("deals.ts", "create", { name: "Deal", amount: 100, currency: "USD", closeDate: "2026-11-01", stage: "prospecting", custom: { "custom.name": object } });
      streamId = created.streamId;
    } else {
      streamId = (await call("objects.ts", "write", { object, values: { "custom.name": object } })).streamId;
    }
    const got = await call("objects.ts", "read", { id: streamId });
    assert.equal(got.values["custom.name"], object);
    const projectionId = (await db.get(streamId))!.projectionId;
    assert.equal((await call("objects.ts", "read", { id: projectionId })).values["custom.name"], object);
    const ruleId = await db.insert("rolePermissions", { orgId: ORG, role: "rep", rules: [{ object, fields: [{ apiName: "custom.name", level: "hidden" }] }] });
    user = { ...ADMIN, role: "rep" };
    const hidden = await call("objects.ts", "read", { id: streamId });
    assert.equal(hidden?.values["custom.name"], undefined);
    if (object === "account" || object === "contact") {
      const rules = [{ object, visibility: "own" as const, unowned: true }];
      await db.patch(ruleId, { rules });
      access = accessOf({ userId: ADMIN._id, role: "rep", rules });
      // The ledger has no owner, but the register must still admit this id.
      assert.equal(await call("objects.ts", "read", { id: projectionId }), null);
      assert.equal(await call("canonEntities.ts", "findScoped", { entityType: object, entityId: streamId }), null);
    }
    await db.patch(ruleId, { rules: [{ object, read: false }] });
    assert.equal(await call("objects.ts", "read", { id: streamId }), null);
    user = ADMIN;
    access = accessOf({ userId: ADMIN._id, role: "admin" });
    await db.delete(ruleId);
  }
});
