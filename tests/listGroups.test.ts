/**
 * Grouped record lists (docs/core-crm-parity.md, "Group-by and views on any
 * object"): `objects.groups` counts what `objects.list` lists, through the
 * caller's scoped record client, and a saved view carries its grouping.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { listViewDef, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { groupFilter, viewGroupOf, viewSpecProblem, type ViewGroup } from "../convex/lib/objects/views.ts";
import { daysFilter } from "../convex/lib/objects/calendar.ts";
import { groupRecords } from "../src/app/api/v1/_records.ts";
import type { V1Client } from "../src/app/api/v1/_lib.ts";
import { canonTools } from "../src/app/mcp/_canonTools.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", isActive: true };
const REP = "users:avery";

let caller: { orgId: string; userId: string; access: Access } = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
let records: RecordClient;
let unscoped = 0;
const M = loadConvex(["objects.ts", "savedViews.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ADMIN, requireUser: async () => ADMIN }),
  "records.ts": (real) => ({
    ...real,
    requireCaller: async () => caller,
    // A read that skips the caller's scope reaches this client, and the choke-point test counts it.
    clientFor: () => new Proxy({}, { get: () => () => { unscoped++; throw new Error("unscoped read"); } }),
    callerClient: (_ctx: unknown, c: { access: Access }) => scopedRecordClient(records, [c.access], async () => null),
  }),
});
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const call = async (file: string, name: string, args: unknown, ctx: unknown = {}) => plain(await M[file]![name]!.handler(ctx as never, args as never));

const row = (object: string, id: string, values: Record<string, unknown>): ListRow =>
  ({ id, object, version: 1, status: "active", title: id, createdAt: 1, updatedAt: 1, deletedAt: null, values: values as ListRow["values"] });

async function workspace() {
  const store = createMemoryRecordStore();
  const account = (id: string, industry: string | undefined, ownerId: string, employees: number) =>
    ({ id, domain: `${id}.example`, name: id, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId, employees, ...(industry ? { industry } : {}) }) as AccountRow;
  await store.putAccounts(ORG, [
    account("a1", "software", REP, 50), account("a2", "software", "users:jordan", 500), account("a3", "fintech", REP, 80),
    account("a4", undefined, REP, 900), account("a5", "fintech", "users:jordan", 20),
  ]);
  // Deals closing either side of a month boundary; a lead board by status.
  const rows = [
    row("deal", "d1", { stage: "prospecting", amount: 1000, closeDate: "2026-10-31", ownerId: REP }),
    row("deal", "d2", { stage: "prospecting", amount: 2500, closeDate: "2026-11-01", ownerId: REP }),
    row("deal", "d3", { stage: "negotiation", amount: 4000, closeDate: "2026-11-30", ownerId: "users:jordan" }),
    row("deal", "d4", { stage: "negotiation", amount: 700, ownerId: REP }),
    row("lead", "l1", { status: "new", ownerId: REP }), row("lead", "l2", { status: "working", ownerId: REP }), row("lead", "l3", { status: "new", ownerId: "users:jordan" }),
  ];
  const defs = ["deal", "lead"].map((o) => plainObjectDef(resolveObjectDef(STANDARD_OBJECTS[o as "deal"])));
  records = createFakeRecordClient({ store, objects: { rows: async (_ws, objects) => ({ rows: rows.filter((r) => !objects || objects.includes(r.object)), defs, heads: {} }) } });
}

const defOf = (object: "account" | "deal" | "lead") => listViewDef(object, resolveObjectDef(STANDARD_OBJECTS[object]));

/** Each group's count against the list of its records under the same filters, and every group's against the whole list. */
async function assertGroupsMatchList(object: "account" | "deal" | "lead", filter: unknown[], group: ViewGroup) {
  const res = await call("objects.ts", "groups", { object, filter, group });
  const listed = await call("objects.ts", "list", { object, filter });
  assert.equal(res.rows, listed.total);
  assert.equal(res.groups.reduce((n: number, g: { count: number }) => n + g.count, 0), listed.total);
  for (const g of res.groups) {
    const page = await call("objects.ts", "list", { object, filter: [...filter, ...groupFilter(defOf(object), group, g.key)] });
    assert.equal(page.total, g.count, `${object} group ${JSON.stringify(g.key)}`);
  }
  return res;
}

test("grouped counts match the list under the same filters, for companies in the register and deals on the ledger", async () => {
  await workspace();
  caller = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
  const companies = await assertGroupsMatchList("account", [{ field: "employees", op: "lt", value: 600 }], { field: "industry" });
  assert.deepEqual(companies.groups.map((g: { key: unknown; count: number }) => [g.key, g.count]), [["fintech", 2], ["software", 2]]);
  const owners = await assertGroupsMatchList("account", [], { field: "ownerId" });
  assert.equal(owners.summed, null);
  // Close dates by month: Oct 31 and Nov 1 land in different groups, and a deal without one in the last.
  const deals = await assertGroupsMatchList("deal", [], { field: "closeDate", bucket: "month" });
  assert.deepEqual(deals.groups.map((g: { key: unknown; count: number; sum: number }) => [g.key, g.count, g.sum]), [["2026-10-01", 1, 1000], ["2026-11-01", 2, 6500], [null, 1, 700]]);
  assert.equal(deals.sum, 8200);
  await assertGroupsMatchList("deal", [{ field: "amount", op: "gte", value: 1000 }], { field: "stage" });
});

test("a grouped list counts only the records the caller sees, refuses a hidden field and leaves out a hidden amount", async () => {
  await workspace();
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }] }) };
  const own = await assertGroupsMatchList("account", [], { field: "industry" });
  assert.deepEqual(own.groups.map((g: { key: unknown; count: number }) => [g.key, g.count]), [["fintech", 1], ["software", 1], [null, 1]]);
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "account", fields: [{ apiName: "industry", level: "hidden" }] }] }) };
  await assert.rejects(call("objects.ts", "groups", { object: "account", group: { field: "industry" } }));
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "deal", fields: [{ apiName: "amount", level: "hidden" }] }] }) };
  const deals = await call("objects.ts", "groups", { object: "deal", group: { field: "stage" } });
  assert.deepEqual(deals.groups.map((g: { key: unknown; count: number; sum: unknown }) => [g.key, g.count, g.sum]), [["negotiation", 2, null], ["prospecting", 2, null]]);
});

test("every list, grouped, board and calendar read a restricted caller makes reaches the record service only through their scoped client", async () => {
  await workspace();
  const seen: Array<{ method: string; scoped: boolean }> = [];
  const base = records;
  records = new Proxy(base, {
    get: (target, method: string) => typeof target[method as keyof RecordClient] !== "function" ? target[method as keyof RecordClient]
      : async (...args: unknown[]) => {
        const req = args[2] as { scope?: unknown } | undefined;
        if (["listObjects", "listRegister", "aggregate"].includes(method)) seen.push({ method, scoped: Boolean(req?.scope) });
        return (target[method as keyof RecordClient] as (...a: unknown[]) => unknown)(...args);
      },
  });
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }, { object: "lead", visibility: "own", unowned: false }] }) };
  unscoped = 0;
  const READS: Array<[string, unknown]> = [
    ["list", { object: "account" }],
    ["groups", { object: "account", group: { field: "industry" } }],
    ["list", { object: "lead", filter: groupFilter(defOf("lead"), { field: "status" }, "new") }],
    ["groups", { object: "lead", group: { field: "status" } }],
    // An owner board: its counts, and a member's column and the "No owner" column (board-view.tsx's column predicate).
    ["groups", { object: "lead", group: { field: "ownerId" } }],
    ["list", { object: "lead", filter: [{ field: "ownerId", op: "eq", value: REP }] }],
    ["list", { object: "lead", filter: [{ field: "ownerId", op: "empty" }] }],
    ["groups", { object: "account", group: { field: "ownerId" } }],
    // A calendar's month (calendar-view.tsx): the list with the month's range on its field.
    ["list", { object: "lead", filter: daysFilter("convertedAt", "instant", "2026-11-01", "2026-12-01", "America/Los_Angeles"), sort: { field: "convertedAt", dir: "asc" } }],
  ];
  for (const [name, args] of READS) await call("objects.ts", name, args);
  assert.equal(unscoped, 0);
  assert.equal(seen.length, READS.length);
  assert.ok(seen.every((s) => s.scoped), JSON.stringify(seen));
});

test("a saved view round-trips its layout, grouping, filters, sort and columns; older views still open as they did", async () => {
  const db = memoryDb({ users: [ADMIN] });
  const spec = { filter: [{ field: "ownerId", op: "eq", value: REP }], sort: { field: "updatedAt", dir: "desc" }, columns: ["status", "company"], layout: "board", group: { field: "status" } };
  const viewId = await call("savedViews.ts", "create", { object: "lead", name: "Leads by status", shared: true, spec }, { db });
  const [saved] = await call("savedViews.ts", "list", { object: "lead" }, { db });
  assert.equal(saved._id, viewId);
  assert.deepEqual(saved.spec, spec);
  const byDueMonth = { filter: [], columns: ["subject"], layout: "table" as const, group: { field: "dueDate", bucket: "month" as const } };
  assert.equal(viewSpecProblem(resolveObjectDef(STANDARD_OBJECTS.task), byDueMonth), null);
  await assert.rejects(call("savedViews.ts", "create", { object: "lead", name: "Bad", shared: false, spec: { ...spec, group: { field: "status", bucket: "month" } } }, { db }));
  // A board by owner saves; one by a lookup or a date does not.
  const byOwner = { ...spec, group: { field: "ownerId" } };
  const ownerId = await call("savedViews.ts", "create", { object: "lead", name: "Leads by owner", shared: false, spec: byOwner }, { db });
  assert.deepEqual((await call("savedViews.ts", "list", { object: "lead" }, { db })).find((v: { _id: string }) => v._id === ownerId).spec, byOwner);
  await assert.rejects(call("savedViews.ts", "create", { object: "lead", name: "Bad", shared: false, spec: { ...spec, group: { field: "convertedAccountId" } } }, { db }));
  await assert.rejects(call("savedViews.ts", "create", { object: "task", name: "Bad", shared: false, spec: { ...byDueMonth, layout: "board" } }, { db }));
  // A board saved as before `group` is stored with `group` once saved again; the stored old one still reads the same.
  const legacy = { filter: [], columns: ["status"], layout: "board" as const, groupBy: "status" };
  const legacyId = await call("savedViews.ts", "create", { object: "lead", name: "Old board", shared: false, spec: legacy }, { db });
  assert.deepEqual(plain((await db.get(legacyId))!.spec), { filter: [], columns: ["status"], layout: "board", group: { field: "status" } });
  assert.deepEqual(viewGroupOf(legacy), { field: "status" });
  assert.equal(viewSpecProblem(resolveObjectDef(STANDARD_OBJECTS.lead), legacy), null);
  // A view saved before `group` existed: a table that kept a board's groupBy opens ungrouped; a board keeps its columns.
  assert.equal(viewGroupOf({ layout: "table", groupBy: "status" }), null);
  assert.deepEqual(viewGroupOf({ layout: "board", groupBy: "status" }), { field: "status" });
  assert.equal(viewSpecProblem(resolveObjectDef(STANDARD_OBJECTS.lead), { filter: [], columns: ["status"], layout: "table", groupBy: "status" }), null);
});

test("an agent creates a board view with canon_views and reads grouped rows over the record API", async () => {
  await workspace();
  caller = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
  const db = memoryDb({ users: [ADMIN] });
  const answer = async (ref: unknown, args: unknown) => {
    const [file, name] = getFunctionName(ref as never).split(":");
    return call(`${file}.ts`, name!, args, { db });
  };
  const convex = { query: answer, mutation: answer, action: answer };
  const tool = canonTools.find((t) => t.name === "canon_views")!;
  const spec = { filter: [], columns: ["status"], layout: "board", group: { field: "status" } };
  const viewId = await tool.run(convex as never, { action: "create", args: { object: "lead", name: "Leads by status", shared: false, spec } });
  const views = plain(await tool.run(convex as never, { action: "list", args: { object: "lead" } })) as Array<{ _id: string; spec: unknown }>;
  assert.deepEqual(views.map((v) => [v._id, v.spec]), [[viewId, spec]]);
  const out = await groupRecords(convex as unknown as V1Client, "lead", new URLSearchParams([["field", "status"], ["filter", "ownerId:eq:users:avery"]]));
  assert.deepEqual(plain(out.body), { data: [{ key: "new", count: 1, sum: null }, { key: "working", count: 1, sum: null }], rows: 2, sum: null, summed: null, truncated: false });
});
