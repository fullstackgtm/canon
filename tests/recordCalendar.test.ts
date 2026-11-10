/**
 * A calendar on any object (lib/objects/calendar.ts): a month's read is the list with the month's range on the
 * field, through the caller's scoped client, and each record lands on its day (a date as it is, a date-time in the
 * workspace's zone).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { ListRow } from "../convex/lib/objects/listSpec.ts";
import { CALENDAR_DAY_SHOWN, dayCell, daysFilter, monthBounds, monthWeeks, movedTo, placeByDay, type CalendarKind } from "../convex/lib/objects/calendar.ts";

const ORG = "organizations:org";
const ADMIN = { _id: "users:ada", orgId: ORG, role: "admin", name: "Ada", isActive: true };
const REP = "users:avery";
let caller: { orgId: string; userId: string; access: Access } = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
let records: RecordClient;
const M = loadConvex(["objects.ts", "savedViews.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ADMIN, requireUser: async () => ADMIN }),
  "records.ts": (real) => ({ ...real, requireCaller: async () => caller, callerClient: (_ctx: unknown, c: { access: Access }) => scopedRecordClient(records, [c.access], async () => null) }),
});
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const call = async (file: string, name: string, args: unknown, ctx: unknown = {}) => plain(await M[file]![name]!.handler(ctx as never, args as never));
const row = (object: string, id: string, values: Record<string, unknown>): ListRow =>
  ({ id, object, version: 1, status: "active", title: id, createdAt: 1, updatedAt: 1, deletedAt: null, values: values as ListRow["values"] });

const LA = "America/Los_Angeles";
function workspace(rows: ListRow[]) {
  const defs = ["task", "lead"].map((o) => plainObjectDef(resolveObjectDef(STANDARD_OBJECTS[o as "task"])));
  records = createFakeRecordClient({ store: createMemoryRecordStore(), objects: { rows: async (_ws, objects) => ({ rows: rows.filter((r) => !objects || objects.includes(r.object)), defs, heads: {} }) } });
}

/** What a calendar shows for `month`: the month's read, placed by day. */
async function month(object: string, field: string, kind: CalendarKind, m: string, zone: string, filter: unknown[] = []) {
  const { from, to } = monthBounds(m);
  const res = await call("objects.ts", "list", { object, filter: [...filter, ...daysFilter(field, kind, from, to, zone)], limit: 200 });
  return Object.fromEntries([...placeByDay(res.rows as ListRow[], field, kind, zone)].map(([day, list]) => [day, list.map((r) => r.id)]));
}

test("a date lands on its own day in any zone; a date-time on its day in the workspace's zone, across a month end and a DST change", async () => {
  workspace([
    row("task", "t1", { subject: "Oct 31", dueDate: "2026-10-31" }),
    row("task", "t2", { subject: "Nov 1", dueDate: "2026-11-01" }),
    // 23:30 on Oct 31 in Los Angeles is Nov 1 in UTC; US daylight time ends at 02:00 on Nov 1, 2026.
    row("lead", "l1", { lastName: "Halloween night", convertedAt: Date.parse("2026-10-31T23:30:00-07:00") }),
    row("lead", "l2", { lastName: "Before the change", convertedAt: Date.parse("2026-11-01T00:30:00-07:00") }),
    row("lead", "l3", { lastName: "After the change", convertedAt: Date.parse("2026-11-01T23:30:00-08:00") }),
    row("lead", "l4", { lastName: "Next morning", convertedAt: Date.parse("2026-11-02T00:10:00-08:00") }),
  ]);
  caller = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
  // UTC+14: a date still never moves.
  assert.deepEqual(await month("task", "dueDate", "day", "2026-10", "Pacific/Kiritimati"), { "2026-10-31": ["t1"] });
  assert.deepEqual(await month("task", "dueDate", "day", "2026-11", "Pacific/Kiritimati"), { "2026-11-01": ["t2"] });
  assert.deepEqual(await month("lead", "convertedAt", "instant", "2026-10", LA), { "2026-10-31": ["l1"] });
  const nov = await month("lead", "convertedAt", "instant", "2026-11", LA);
  assert.deepEqual(Object.fromEntries(Object.entries(nov).map(([d, ids]) => [d, ids.sort()])), { "2026-11-01": ["l2", "l3"], "2026-11-02": ["l4"] });
  // Dragging the 23:30 lead to Nov 3 keeps its wall-clock time there, in standard time.
  const lateEvening = Date.parse("2026-10-31T23:30:00-07:00");
  assert.equal(movedTo("instant", lateEvening, "2026-11-03", LA), Date.parse("2026-11-03T23:30:00-08:00"));
  // Onto the day clocks fall back, and the day they spring forward, it stays 23:30 on that day.
  assert.equal(movedTo("instant", lateEvening, "2026-11-01", LA), Date.parse("2026-11-01T23:30:00-08:00"));
  assert.equal(movedTo("instant", lateEvening, "2027-03-14", LA), Date.parse("2027-03-14T23:30:00-07:00"));
  assert.equal(movedTo("day", "2026-10-31", "2026-11-03", LA), "2026-11-03");
  // November 2026 starts on a Sunday: the grid opens on Monday Oct 26 and ends on Sunday Dec 6.
  const weeks = monthWeeks("2026-11");
  assert.deepEqual([weeks[0]![0], weeks.at(-1)![6], weeks.length], ["2026-10-26", "2026-12-06", 6]);
});

test("a day shows three records and counts the rest, which its own list holds", async () => {
  workspace(Array.from({ length: 5 }, (_, i) => row("task", `t${i}`, { subject: `Call ${i}`, dueDate: "2026-11-12" })));
  caller = { orgId: ORG, userId: ADMIN._id, access: accessOf({ userId: ADMIN._id, role: "admin" }) };
  const placed = await month("task", "dueDate", "day", "2026-11", LA);
  const cell = dayCell(placed["2026-11-12"]);
  assert.deepEqual([cell.shown.length, cell.more], [CALENDAR_DAY_SHOWN, 2]);
  const day = await call("objects.ts", "list", { object: "task", filter: daysFilter("dueDate", "day", "2026-11-12", "2026-11-13", LA) });
  assert.equal(day.total, 5);
});

test("a calendar places only the records the caller sees, and refuses a date field hidden from them", async () => {
  workspace([
    row("task", "mine", { subject: "Mine", dueDate: "2026-11-05", ownerId: REP }),
    row("task", "theirs", { subject: "Theirs", dueDate: "2026-11-05", ownerId: "users:jordan" }),
  ]);
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "task", visibility: "own", unowned: false }] }) };
  assert.deepEqual(await month("task", "dueDate", "day", "2026-11", LA), { "2026-11-05": ["mine"] });
  caller = { orgId: ORG, userId: REP, access: accessOf({ userId: REP, role: "rep", rules: [{ object: "task", fields: [{ apiName: "dueDate", level: "hidden" }] }] }) };
  await assert.rejects(month("task", "dueDate", "day", "2026-11", LA));
});

test("a saved calendar view round-trips; a calendar needs a date or date-time field", async () => {
  const db = memoryDb({ users: [ADMIN] });
  const spec = { filter: [{ field: "status", op: "eq", value: "not_started" }], columns: ["subject"], layout: "calendar", calendar: { field: "dueDate" } };
  const viewId = await call("savedViews.ts", "create", { object: "task", name: "Due this month", shared: true, spec }, { db });
  const [saved] = await call("savedViews.ts", "list", { object: "task" }, { db });
  assert.deepEqual([saved._id, saved.spec], [viewId, spec]);
  await assert.rejects(call("savedViews.ts", "create", { object: "task", name: "Bad", shared: false, spec: { ...spec, calendar: { field: "subject" } } }, { db }));
  await assert.rejects(call("savedViews.ts", "create", { object: "task", name: "Bad", shared: false, spec: { ...spec, calendar: undefined } }, { db }));
});
