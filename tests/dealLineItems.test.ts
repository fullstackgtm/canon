import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { createRecord, updateRecord, deleteRecord, restoreRecord } from "../src/app/api/v1/_records.ts";
import type { V1Client } from "../src/app/api/v1/_lib.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { lineMoneyText, lineProblem, lineTotal, parseLineMoney } from "../convex/lib/objects/lineItems.ts";

const ADMIN = { _id: "users:ada", orgId: "organizations:org", role: "admin", name: "Ada", isActive: true };
let user = ADMIN;
const modules = loadConvex(["dealLineItems.ts", "deals.ts", "objects.ts", "permissions.ts", "lib/modules/canonReads.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => user }),
});

test("deal Products saves ordered ledger lines, preserves exact totals, rejects stale edits and only updates amount on request", async () => {
  user = ADMIN;
  const db = memoryDb({ organizations: [{ _id: ADMIN.orgId, defaultCurrency: "USD" }], users: [ADMIN] });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const call = async (file: string, name: string, args: unknown) => {
    const checkpoint = db.checkpoint();
    try { return await modules[file][name].handler(ctx, args); }
    catch (cause) { db.rollback(checkpoint); throw cause; }
  };
  await call("deals.ts", "create", { name: "Northwind", amount: 100, currency: "USD", closeDate: "2026-11-01", stage: "prospecting" });
  const entity = db.rows("canonEntities").find((r) => r.projectionTable === "deals")!;
  const deal = entity._id;
  await db.patch(String(entity.projectionId), { products: ["Stored fallback"] });
  const product = await call("objects.ts", "write", { object: "product", values: { name: "Training hour", active: true } });
  const reads = modules["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<Array<{ products: string[] }>>; dealFieldsOf: (...args: unknown[]) => Record<string, unknown>; dealValues: (...args: unknown[]) => Promise<string[]> };
  const products = async (access = accessOf({ userId: ADMIN._id, role: "admin" })) => JSON.parse(JSON.stringify((await reads.canonRead(ctx, ADMIN.orgId, access, { reads: { deals: ["products"] } }, "deals.byIds", { ids: [entity.projectionId] }, 10))[0].products));
  const line = { productId: product.streamId, quantity: 10, unitPrice: 22857, totalPrice: 228571 };
  await call("dealLineItems.ts", "replace", { deal, expected: [], lines: [line, { ...line, quantity: 1, totalPrice: 1371429 }] });
  let result = await call("dealLineItems.ts", "forDeal", { deal });
  assert.equal(result.total, 1600000);
  assert.equal((await db.get(String(entity.projectionId)))!.amount, 100);
  assert.deepEqual(JSON.parse(JSON.stringify((await db.get(String(entity.projectionId)))!.lineItemProducts)), ["Training hour"]);
  assert.deepEqual(await products(), ["Training hour"]);
  for (const rule of [{ object: "lineItem", read: false }, { object: "lineItem", fields: [{ apiName: "name", level: "hidden" as const }] }]) {
    const access = accessOf({ userId: "users:manager", role: "manager", rules: [rule] });
    assert.deepEqual(await products(access), ["Stored fallback"]);
    assert.deepEqual(JSON.parse(JSON.stringify(reads.dealFieldsOf(await db.get(String(entity.projectionId)), ["products"], access).products)), ["Stored fallback"]);
    assert.deepEqual(JSON.parse(JSON.stringify(await reads.dealValues(ctx, ADMIN.orgId, access, { reads: { deals: ["products"] } }, "products", "", 10))), ["Stored fallback"]);
  }
  const expected = result.lines.map((l: { id: string; version: number }) => ({ version: l.version, id: l.id }));
  const foreign = await db.insert("canonEntities", { orgId: "organizations:elsewhere", entityType: "product", projectionTable: "recordRows" });
  const entriesBefore = db.rows("ledgerEntries").length;
  await assert.rejects(call("dealLineItems.ts", "replace", { deal, expected, lines: [{ ...line, totalPrice: 1 }, { ...line, productId: foreign }] }));
  assert.equal(db.rows("ledgerEntries").length, entriesBefore, "a foreign product rolls the whole replacement back");
  const reversed = result.lines.toReversed().map((l: Record<string, unknown>) => ({ id: l.id, version: l.version, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, totalPrice: l.totalPrice }));
  await call("dealLineItems.ts", "replace", { deal, expected, lines: reversed });
  result = await call("dealLineItems.ts", "forDeal", { deal });
  assert.equal(result.lines[0].totalPrice, 1371429);
  await assert.rejects(call("dealLineItems.ts", "replace", { deal, expected, lines: [] }));
  const record = await call("objects.ts", "get", { streamId: deal });
  await assert.rejects(call("dealLineItems.ts", "useAsAmount", { deal, expectedVersion: record.version, expected }));
  await call("dealLineItems.ts", "useAsAmount", { deal, expectedVersion: record.version, expected: result.lines.map((l: { id: string; version: number }) => ({ id: l.id, version: l.version })) });
  assert.equal((await db.get(String(entity.projectionId)))!.amount, 1600000);
  await assert.rejects(call("objects.ts", "write", { object: "lineItem", streamId: result.lines[0].id, values: { totalPrice: 1 } }));
  await call("dealLineItems.ts", "replace", { deal, expected: result.lines.map((l: { id: string; version: number }) => ({ id: l.id, version: l.version })), lines: [] });
  assert.equal((await call("dealLineItems.ts", "forDeal", { deal })).total, 0);
  assert.equal((await db.get(String(entity.projectionId)))!.lineItemProducts, undefined);
  assert.deepEqual(await products(), ["Stored fallback"]);
  assert.equal((await db.get(String(entity.projectionId)))!.amount, 1600000);
  assert.equal(db.rows("ledgerEntries").filter((e) => e.object === "lineItem").length, 6);
});

test("line items inherit the parent deal visibility on direct reads, receipts, edits, lists, search and reports", async () => {
  user = { ...ADMIN, _id: "users:morgan", role: "manager" };
  const access = accessOf({ userId: user._id, role: "manager", rules: [{ object: "deal", visibility: "own", unowned: false }] });
  const db = memoryDb({ users: [user], rolePermissions: [{ _id: "rolePermissions:m", orgId: user.orgId, role: "manager", rules: [{ object: "deal", visibility: "own", unowned: false }] }],
    deals: [{ _id: "deals:hidden", orgId: user.orgId, primaryRepId: "users:other" }],
    canonEntities: [{ _id: "canonEntities:deal", orgId: user.orgId, entityType: "opportunity", projectionTable: "deals", projectionId: "deals:hidden" }, { _id: "canonEntities:line", orgId: user.orgId, entityType: "lineItem", projectionTable: "recordRows" }],
    recordRows: [{ _id: "recordRows:line", orgId: user.orgId, streamId: "canonEntities:line", values: { dealId: "canonEntities:deal" } }],
  });
  const ctx = { db };
  assert.equal(await modules["dealLineItems.ts"].forDeal.handler(ctx, { deal: "canonEntities:deal" }), null);
  await assert.rejects(modules["dealLineItems.ts"].replace.handler(ctx, { deal: "canonEntities:deal", expected: [], lines: [] }));
  const visibility = modules["permissions.ts"] as unknown as { recordVisible: (...args: unknown[]) => Promise<boolean>; entitySight: (...args: unknown[]) => Promise<{ seen: boolean }> };
  assert.equal(await visibility.recordVisible(ctx, access, { streamId: "canonEntities:line", object: "lineItem", values: { dealId: "canonEntities:deal" } }), false);
  assert.equal((await visibility.entitySight(ctx, [access], await db.get("canonEntities:line"))).seen, false);
  await db.patch("deals:hidden", { primaryRepId: user._id });
  assert.equal((await visibility.entitySight(ctx, [access], await db.get("canonEntities:line"))).seen, true);
  await db.patch("canonEntities:deal", { orgId: "organizations:elsewhere" });
  assert.equal(await modules["dealLineItems.ts"].forDeal.handler(ctx, { deal: "canonEntities:deal" }), null);
  assert.equal((await visibility.entitySight(ctx, [access], await db.get("canonEntities:line"))).seen, false);
  const store = createMemoryRecordStore();
  const rows = ["mine", "hidden"].map((id) => ({ id, object: "lineItem", version: 1, status: "active" as const, title: "Training", createdAt: 1, updatedAt: 1, deletedAt: null, values: { name: "Training", dealId: id === "mine" ? "visible" : "canonEntities:deal", totalPrice: 100 } }));
  const base = createFakeRecordClient({ store, objects: { rows: async () => ({ rows, defs: [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.lineItem))], heads: {} }) } });
  const client = scopedRecordClient(base, [access], async () => ({ field: "id", owners: ["visible"], unowned: false }));
  assert.deepEqual((await client.listObjects(user.orgId, "lineItem", {})).rows.map((l) => l.id), ["mine"]);
  assert.deepEqual((await client.searchObjects(user.orgId, { q: "Training", objects: ["lineItem"] })).hits.map((l) => l.id), ["mine"]);
  assert.deepEqual((await client.aggregate(user.orgId, "lineItem", { measures: [{ fn: "sum", field: "totalPrice" }] })).total, [100]);
});

test("line money preserves minor units without floating point pricing or inferred totals", () => {
  assert.equal(lineTotal([{ totalPrice: 23328000 }, { totalPrice: 11520000 }, { totalPrice: 1371429 }, { totalPrice: 228571 }]), 36448000);
  assert.equal(lineMoneyText(parseLineMoney("90071992547409.91", 2), 2), "90071992547409.91");
  for (const [text, decimals, expected] of [["1200", 0, 1200], ["12.345", 3, 12345], ["1001.50", 2, 100150]] as const) assert.equal(parseLineMoney(text, decimals), expected);
  assert.throws(() => parseLineMoney("12.345", 2));
  assert.throws(() => lineTotal([{ totalPrice: Number.MAX_SAFE_INTEGER }, { totalPrice: 1 }]));
  assert.notEqual(lineProblem({ quantity: 0, totalPrice: 1 }), null);
  assert.notEqual(lineProblem({ quantity: 1, totalPrice: 0.5 }), null);
});


test("record API line-item CRUD updates Products and its consumer with CAS, permissions and immutable parent", async () => {
  user = ADMIN;
  const db = memoryDb({ organizations: [{ _id: ADMIN.orgId }], users: [ADMIN] });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const call = async (name: string, args: any) => {
    const checkpoint = db.checkpoint();
    try { const [file, fn] = name.split(":"); return await modules[`${file}.ts`][fn].handler(ctx, args); }
    catch (cause) { db.rollback(checkpoint); throw cause; }
  };
  const invoke = (ref: any, args: any) => call(getFunctionName(ref), args);
  // writeScoped admits the companies and people a write names, which these writes have none of: objects.write is the same save.
  const action = (ref: any, args: any) => (getFunctionName(ref) === "objects:writeScoped" ? call("objects:write", args) : invoke(ref, args));
  const client = { query: invoke, mutation: invoke, action } as unknown as V1Client;
  await call("deals:create", { name: "API deal", amount: 1234, currency: "USD", closeDate: "2026-11-01", stage: "prospecting" });
  const entity = db.rows("canonEntities").find((r) => r.projectionTable === "deals")!;
  const product = await call("objects:write", { object: "product", values: { name: "Training", active: true } });
  const values = { dealId: entity._id, productId: product.streamId, quantity: 2, unitPrice: 500, totalPrice: 999, position: 0 };
  const created = await createRecord(client, "lineItem", { values });
  assert.equal(created.status, 201);
  const id = (created.body as { id: string }).id;
  const line = () => call("objects:get", { streamId: id });
  const products = () => call("dealLineItems:forDeal", { deal: entity._id });
  assert.equal((await products()).total, 999);
  assert.equal((await line()).values.name, "Training");
  let version = (await line()).version;
  await updateRecord(client, "lineItem", id, { values: { totalPrice: 777 }, expectedVersion: version });
  assert.equal((await products()).total, 777);
  await assert.rejects(updateRecord(client, "lineItem", id, { values: { totalPrice: 1 }, expectedVersion: version }));
  version = (await line()).version;
  const denied = [
    { values: { dealId: product.streamId }, expectedVersion: version },
    { values: { name: "Forged" }, expectedVersion: version },
    { values: { quantity: 0 }, expectedVersion: version },
    { values: { totalPrice: 0.5 }, expectedVersion: version },
    { values: { totalPrice: 2 } },
    { values: { totalPrice: 2 }, expectedVersion: version, source: "agent_run" },
  ];
  for (const body of denied) await assert.rejects(updateRecord(client, "lineItem", id, body));
  await assert.rejects(call("objects:bulk", { object: "lineItem", op: "delete", streamIds: [id] }));
  const role = await db.insert("rolePermissions", { orgId: ADMIN.orgId, role: "manager", rules: [] });
  user = { ...ADMIN, role: "manager" };
  for (const rules of [
    [{ object: "lineItem", fields: [{ apiName: "totalPrice", level: "readOnly" }] }],
    [{ object: "lineItem", edit: false }],
    [{ object: "deal", edit: false }],
    [{ object: "deal", visibility: "own", unowned: false }],
  ]) {
    await db.patch(role, { rules });
    if (rules[0].object === "deal" && "visibility" in rules[0]) await db.patch(String(entity.projectionId), { primaryRepId: "users:other" });
    await assert.rejects(updateRecord(client, "lineItem", id, { values: { totalPrice: 2 }, expectedVersion: version }));
  }
  await db.patch(role, { rules: [{ object: "product", fields: [{ apiName: "name", level: "hidden" }] }] });
  await db.patch(String(entity.projectionId), { primaryRepId: ADMIN._id });
  await assert.rejects(createRecord(client, "lineItem", { values }));
  user = ADMIN;
  assert.equal((await line()).version, version);
  await deleteRecord(client, "lineItem", id, new URLSearchParams({ expectedVersion: String(version) }));
  assert.equal((await products()).lines.length, 0);
  await assert.rejects(restoreRecord(client, "lineItem", id, new URLSearchParams({ expectedVersion: String(version) })));
  await restoreRecord(client, "lineItem", id, new URLSearchParams({ expectedVersion: String((await line()).version) }));
  assert.equal((await products()).total, 777);
  const reads = modules["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<Array<{ products: string[] }>> };
  const rows = await reads.canonRead(ctx, ADMIN.orgId, accessOf({ userId: ADMIN._id, role: "admin" }), { reads: { deals: ["products"] } }, "deals.byIds", { ids: [entity.projectionId] }, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0].products)), ["Training"]);
  assert.equal((await db.get(String(entity.projectionId)))!.amount, 1234);
});

test("line-item writes validate final count and exact aggregate atomically, including replacement at the limit", async () => {
  user = ADMIN;
  const db = memoryDb({ organizations: [{ _id: ADMIN.orgId }], users: [ADMIN] });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const call = async (file: string, name: string, args: any) => {
    const checkpoint = db.checkpoint();
    try { return await modules[file][name].handler(ctx, args); }
    catch (cause) { db.rollback(checkpoint); throw cause; }
  };
  await call("deals.ts", "create", { name: "Bounded", amount: 0, closeDate: "2026-11-01", stage: "prospecting" });
  const deal = db.rows("canonEntities").find((r) => r.projectionTable === "deals")!._id;
  const product = await call("objects.ts", "write", { object: "product", values: { name: "Training", active: true } });
  const line = { productId: product.streamId, quantity: 1, unitPrice: null, totalPrice: 0 };
  const replace = async (lines: any[]) => {
    const rows = await call("dealLineItems.ts", "forDeal", { deal });
    await call("dealLineItems.ts", "replace", { deal, expected: rows.lines.map((r: any) => ({ id: r.id, version: r.version })), lines });
    return call("dealLineItems.ts", "forDeal", { deal });
  };
  let rows = await replace([{ ...line, totalPrice: 0 }, { ...line, totalPrice: Number.MAX_SAFE_INTEGER }]);
  rows = await replace(rows.lines.map((r: any, i: number) => ({ ...line, id: r.id, version: r.version, totalPrice: i === 0 ? Number.MAX_SAFE_INTEGER : 0 })));
  assert.equal(rows.total, Number.MAX_SAFE_INTEGER, "a safe final total may temporarily exceed the bound during replacement");
  const entries = db.rows("ledgerEntries").length;
  await assert.rejects(call("objects.ts", "write", { object: "lineItem", values: { ...line, dealId: deal, totalPrice: 1 } }));
  assert.equal(db.rows("ledgerEntries").length, entries, "aggregate overflow rolls back the create");
  rows = await replace(Array.from({ length: 100 }, () => line));
  const capEntries = db.rows("ledgerEntries").length;
  await assert.rejects(call("objects.ts", "write", { object: "lineItem", values: { ...line, dealId: deal } }));
  assert.equal(db.rows("ledgerEntries").length, capEntries);
  await replace(Array.from({ length: 100 }, () => line));
  assert.equal((await call("dealLineItems.ts", "forDeal", { deal })).lines.length, 100, "a full list can be replaced with new streams atomically");
});
