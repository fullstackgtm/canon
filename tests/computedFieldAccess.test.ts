import assert from "node:assert/strict";
import test from "node:test";
import { accessOf, type ObjectRule } from "../convex/lib/access.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import type { ActionCtx } from "../convex/_generated/server.ts";
import { resolvePeopleRows } from "../convex/lib/modules/recordReads.ts";
import { applyRelated, relatedPorts } from "../convex/lib/outbound/related.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS, type FieldDef } from "../convex/lib/objects/registry.ts";

const computed = (name: string, formula: string, rollup?: { object: string; via: string; fn: "sum"; field: string }): FieldDef =>
  ({ fieldId: `custom.${name}` as FieldDef["fieldId"], apiName: `custom.${name}`, label: name, type: "formula", formula, returns: "number", ...(rollup ? { rollup } : {}) });
const fields = [computed("fee", "annualRevenue * 0.2"), computed("total", "", { object: "deal", via: "companyId", fn: "sum", field: "amount" }), computed("copy", "custom.total * 2")];
const defs = [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields: fields })), plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal))];
const values = { name: "Visible", annualRevenue: 100, "custom.fee": 20, "custom.total": 500, "custom.copy": 1000 };
function fixture(rules: ObjectRule[]) {
  const base: RecordClient = { ...createFakeRecordClient({ store: createMemoryRecordStore() }),
    listRegister: async () => ({ rows: [{ id: "a", stream: null, object: "account", version: 1, status: "active" as const, title: "Visible", createdAt: 1, updatedAt: 1, deletedAt: null, values }], total: 1, nextCursor: null, projectedThrough: {} }),
  };
  const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules })], async () => ({ field: "id", owners: ["mine"], unowned: false }), async () => defs);
  return { base, client };
}
const hide = (object: string, apiName: string): ObjectRule => ({ object, fields: [{ apiName, level: "hidden" }] });

test("a formula over a hidden field is omitted from caller rows", async () => {
  const { client } = fixture([hide("account", "annualRevenue")]);
  assert.equal("custom.fee" in (await client.listRegister("ws", "account", {})).rows[0].values, false);
});
test("a rollup over narrowed source records and its dependent formula are omitted from caller rows", async () => {
  const { client } = fixture([{ object: "deal", visibility: "own" }]);
  const row = (await client.listRegister("ws", "account", {})).rows[0];
  assert.equal("custom.total" in row.values, false);
  assert.equal("custom.copy" in row.values, false);
});
test("a rollup over a hidden source field is omitted from caller rows", async () => {
  const { client } = fixture([hide("deal", "amount")]);
  assert.equal("custom.total" in (await client.listRegister("ws", "account", {})).rows[0].values, false);
});
test("a computed hidden field refuses filter, sort, group and measure use", async () => {
  const { client } = fixture([hide("deal", "amount")]);
  await assert.rejects(() => client.listRegister("ws", "account", { filter: [{ field: "custom.total", op: "gt", value: 0 }] }), /hidden/);
  await assert.rejects(() => client.listRegister("ws", "account", { sort: { field: "custom.total", dir: "asc" } }), /hidden/);
  await assert.rejects(() => client.aggregate("ws", "account", { groupBy: [{ field: "custom.total" }], measures: [{ fn: "count" }] }), /hidden/);
  await assert.rejects(() => client.aggregate("ws", "account", { measures: [{ fn: "sum", field: "custom.total" }] }), /hidden/);
  await assert.rejects(() => applyRelated([], [{ path: "company", filter: [{ field: "custom.total", op: "gt", value: 0 }] }], relatedPorts(client, "ws")), /hidden/);
  await assert.rejects(() => resolvePeopleRows(client, "ws", async () => [], { filter: [], related: [{ path: "company", filter: [{ field: "custom.total", op: "gt", value: 0 }] }] }), /hidden/);
});

test("unrestricted callers keep the exact computed response without loading definitions", async () => {
  const { base } = fixture([]);
  const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep" })], async () => { throw Error("scope"); }, async () => { throw Error("definitions"); });
  assert.deepEqual(await client.listRegister("ws", "account", {}), await base.listRegister("ws", "account", {}));
});
test("restricted callers keep computed fields whose dependencies are readable", async () => {
  const { base, client } = fixture([hide("account", "industry")]);
  assert.deepEqual(await client.listRegister("ws", "account", {}), await base.listRegister("ws", "account", {}));
});
test("a rollup with a hidden join or filter dependency is withheld", async () => {
  const filtered = { ...fields[1], formula: "probability > 0" };
  const filteredDefs = [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields: [filtered] })), defs[1]];
  for (const field of ["companyId", "probability"]) {
    const { base } = fixture([]);
    const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [hide("deal", field)] })], async () => null, async () => filteredDefs);
    assert.equal("custom.total" in (await client.listRegister("ws", "account", {})).rows[0].values, false);
  }
});
test("line-item rollups inherit narrowed deal visibility", async () => {
  const lineDefs = [plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal, { registryVersion: 1, customFields: [computed("total", "", { object: "lineItem", via: "dealId", fn: "sum", field: "totalPrice" })] })), plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.lineItem))];
  const { base } = fixture([]);
  const client = scopedRecordClient({ ...base, listObjects: (ws, _object, req) => base.listRegister(ws, "account", req) }, [accessOf({ userId: "u", role: "rep", rules: [{ object: "deal", visibility: "own" }] })], async () => ({ field: "id", owners: ["mine"], unowned: false }), async () => lineDefs);
  assert.equal("custom.total" in (await client.listObjects("ws", "deal", {})).rows[0].values, false);
});
test("a stale formula definition keeps its empty read instead of throwing", async () => {
  const stale = plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields: [computed("fee", "custom.archived * 2")] }));
  const { base } = fixture([]);
  const empty = { ...base, listRegister: async () => { const page = await base.listRegister("ws", "account", {}); return { ...page, rows: page.rows.map((r) => ({ ...r, values: { "custom.fee": null } })) }; } };
  const client = scopedRecordClient(empty, [accessOf({ userId: "u", role: "rep", rules: [hide("account", "industry")] })], async () => null, async () => [stale]);
  assert.equal((await client.listRegister("ws", "account", {})).rows[0].values["custom.fee"], null);
});

test("register formula dependencies include derived fields and revenue aliases", async () => {
  const derived = plainObjectDef(resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields: [computed("fee", "fit * 2"), computed("total", "revenue * 2")] }));
  const { base } = fixture([]);
  const client = scopedRecordClient(base, [accessOf({ userId: "u", role: "rep", rules: [{ object: "account", fields: [{ apiName: "fit", level: "hidden" }, { apiName: "annualRevenue", level: "hidden" }] }] })], async () => null, async () => [derived]);
  const row = (await client.listRegister("ws", "account", {})).rows[0];
  assert.equal("custom.fee" in row.values, false);
  assert.equal("custom.total" in row.values, false);
});

test("principalClient loads workspace definitions and intersects computed field access", async () => {
  const { base } = fixture([]);
  const loaded = loadConvex(["records.ts", "ledgerFeed.ts"], { "lib/recordClient.ts": (real) => ({ ...real, recordClient: () => base }) });
  const db = memoryDb({ organizations: [{ _id: "ws" }], objectDefs: [{ _id: "def", orgId: "ws", apiName: "account", registryVersion: 1, customFields: fields }] });
  const ctx = { runQuery: async (ref: unknown, args: unknown) => {
    const [file, name] = String(ref).replace(/^internal\./, "").split(".");
    return loaded[`${file}.ts`][name].handler({ db }, args);
  } };
  const { principalClient } = loaded["records.ts"] as unknown as { principalClient(ctx: ActionCtx, ws: string, accesses: ReturnType<typeof accessOf>[]): RecordClient };
  const client = principalClient(ctx as unknown as ActionCtx, "ws", [accessOf({ userId: "admin", role: "admin" }), accessOf({ userId: "rep", role: "rep", rules: [hide("account", "annualRevenue")] })]);
  assert.equal("custom.fee" in (await client.listRegister("ws", "account", {})).rows[0].values, false);
});
