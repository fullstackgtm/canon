import assert from "node:assert/strict";
import test from "node:test";
import { resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { batchesByShard, collapseDayFilters, dayColumnsOf, expandDayFilters, projectedPast, runBulk, viewSpecProblem, VIEW_COLUMNS_MAX } from "../convex/lib/objects/views.ts";
import { shardOf } from "../convex/lib/objects/write.ts";
import { listViewDef } from "../convex/lib/objects/listSpec.ts";

const ids = Array.from({ length: 200 }, (_, i) => `id${i}`);
const noSleep = { sleep: async () => {}, backoffMs: () => 0 };

test("batchesByShard keeps every batch inside one shard, at most max ids, each id once", () => {
  const byShard = batchesByShard([...ids, ...ids.slice(0, 10)], 7);
  const seen: string[] = [];
  for (const [shard, batches] of byShard) {
    for (const batch of batches) {
      assert.ok(batch.length >= 1 && batch.length <= 7);
      for (const id of batch) assert.equal(shardOf(id), shard);
      seen.push(...batch);
    }
    // Only the last batch of a shard may be short.
    for (const batch of batches.slice(0, -1)) assert.equal(batch.length, 7);
  }
  assert.deepEqual(seen.sort(), [...ids].sort());
});

test("runBulk never runs two batches of one shard at once, and saves every id", async () => {
  const inFlight = new Set<number>();
  let overlap = false;
  const out = await runBulk(ids, 5, async (batch) => {
    const shard = shardOf(batch[0]!);
    if (inFlight.has(shard)) overlap = true;
    inFlight.add(shard);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight.delete(shard);
    return { results: batch.map((streamId) => ({ streamId, result: "ok" })), unprocessed: [] };
  }, { concurrency: 8 });
  assert.equal(overlap, false);
  assert.equal(out.results.size, ids.length);
  assert.equal(out.failed.size, 0);
});

test("runBulk retries a batch that throws (a lost optimistic-concurrency race) and gives up after its attempts", async () => {
  const calls = new Map<string, number>();
  const flaky = ids.slice(0, 20);
  const out = await runBulk(flaky, 25, async (batch) => {
    const key = batch.join();
    const n = (calls.get(key) ?? 0) + 1;
    calls.set(key, n);
    // Shard of id0 always fails; the others fail once, then succeed.
    if (batch.includes("id0") || n === 1) throw new Error("Documents read from or written to the table changed");
    return { results: batch.map((streamId) => ({ streamId, result: "ok" })), unprocessed: [] };
  }, { ...noSleep, attempts: 3 });
  const id0Shard = flaky.filter((id) => shardOf(id) === shardOf("id0"));
  assert.deepEqual([...out.failed.keys()].sort(), id0Shard.sort());
  assert.match(out.failed.get("id0")!, /changed/);
  assert.equal(out.results.size, flaky.length - id0Shard.length);
  assert.equal(calls.get(id0Shard.join()), 3);
});

test("runBulk resends the ids a batch left unprocessed", async () => {
  const sent: string[][] = [];
  const one = ids.filter((id) => shardOf(id) === 3).slice(0, 6);
  const out = await runBulk(one, 25, async (batch) => {
    sent.push(batch);
    // Each call gets through two records, then runs out of read budget.
    return { results: batch.slice(0, 2).map((streamId) => ({ streamId, result: "ok" })), unprocessed: batch.slice(2) };
  }, noSleep);
  assert.deepEqual(sent.map((b) => b.length), [6, 4, 2]);
  assert.equal(out.results.size, 6);
  assert.equal(out.failed.size, 0);
});

test("projectedPast compares each save's shard cursor", () => {
  assert.equal(projectedPast({ "3": 10 }, [{ shard: 3, seq: 10 }]), true);
  assert.equal(projectedPast({ "3": 9 }, [{ shard: 3, seq: 10 }]), false);
  assert.equal(projectedPast({}, [{ shard: 1, seq: 1 }]), false);
  assert.equal(projectedPast({ "1": 5, "2": 1 }, [{ shard: 1, seq: 5 }, { shard: 2, seq: 2 }]), false);
  assert.equal(projectedPast({}, []), true);
});

test("viewSpecProblem accepts what the list serves and names what it doesn't", () => {
  const task = resolveObjectDef(STANDARD_OBJECTS.task);
  const ok = { filter: [{ field: "priority", op: "eq" as const, value: "high" }], sort: { field: "dueDate", dir: "asc" as const }, columns: ["status", "updatedAt"], layout: "table" as const };
  assert.equal(viewSpecProblem(task, ok), null);
  assert.equal(viewSpecProblem(task, { ...ok, layout: "board", groupBy: "status" }), null);
  assert.match(viewSpecProblem(task, { ...ok, filter: [{ field: "nope", op: "eq", value: "x" }] })!, /unknown field nope/);
  assert.match(viewSpecProblem(task, { ...ok, filter: [{ field: "dueDate", op: "contains", value: "x" }] })!, /cannot be filtered with contains/);
  assert.match(viewSpecProblem(task, { ...ok, columns: ["status", "ghost"] })!, /unknown column ghost/);
  assert.match(viewSpecProblem(task, { ...ok, columns: Array(VIEW_COLUMNS_MAX + 1).fill("status") })!, /at most/);
  assert.match(viewSpecProblem(task, { ...ok, layout: "board", groupBy: "subject" })!, /picklist/);
  assert.match(viewSpecProblem(task, { ...ok, layout: "board" })!, /picklist/);
  // A board column adds a predicate to the view's filters, and day filters can take two.
  const twenty = Array.from({ length: 20 }, () => ({ field: "subject", op: "contains" as const, value: "a" }));
  assert.equal(viewSpecProblem(task, { ...ok, filter: twenty }), null);
  assert.match(viewSpecProblem(task, { ...ok, filter: twenty, layout: "board", groupBy: "status" })!, /at most 20 filters/);
  assert.match(viewSpecProblem(task, { ...ok, filter: [...twenty.slice(1), { field: "updatedAt", op: "eq", value: "2026-10-07" }] })!, /at most 20 filters/);
});

test("an account view saves with the register's derived columns", () => {
  const account = listViewDef("account", resolveObjectDef(STANDARD_OBJECTS.account));
  const spec = { filter: [{ field: "segmentIds", op: "hasAny" as const, value: ["s1"] }], sort: { field: "fit", dir: "desc" as const }, columns: ["name", "fit", "revenue"], layout: "table" as const };
  assert.equal(viewSpecProblem(account, spec), null);
});

test("a contact view may show AI field columns, but only ones it is told about, and never filter by them", () => {
  const contact = listViewDef("contact", resolveObjectDef(STANDARD_OBJECTS.contact));
  const spec = { filter: [], columns: ["custom.tier"], layout: "table" as const };
  assert.equal(viewSpecProblem(contact, spec, new Set(["custom.tier"])), null);
  assert.match(viewSpecProblem(contact, spec)!, /unknown column custom.tier/);
  assert.match(viewSpecProblem(contact, { ...spec, filter: [{ field: "custom.tier", op: "eq", value: "x" }] }, new Set(["custom.tier"]))!, /unknown field/);
});

test("expandDayFilters turns a saved day into that whole day in the viewer's time zone", () => {
  const days = new Set(["createdAt"]);
  const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  const one = (op: string) => expandDayFilters([{ field: "createdAt", op, value: "2026-10-07" }], days, at);
  const day = at(2026, 10, 7);
  const next = at(2026, 10, 8);
  assert.deepEqual(one("eq"), [{ field: "createdAt", op: "gte", value: day }, { field: "createdAt", op: "lt", value: next }]);
  assert.deepEqual(one("gt"), [{ field: "createdAt", op: "gte", value: next }]);
  assert.deepEqual(one("gte"), [{ field: "createdAt", op: "gte", value: day }]);
  assert.deepEqual(one("lt"), [{ field: "createdAt", op: "lt", value: day }]);
  assert.deepEqual(one("lte"), [{ field: "createdAt", op: "lt", value: next }]);
  // Other columns, value-less ops and malformed days pass through.
  assert.deepEqual(
    expandDayFilters([{ field: "amount", op: "eq", value: 5 }, { field: "createdAt", op: "empty" }, { field: "createdAt", op: "eq", value: "7 Oct" }], days, at),
    [{ field: "amount", op: "eq", value: 5 }, { field: "createdAt", op: "empty" }, { field: "createdAt", op: "eq", value: "7 Oct" }],
  );
  // Both bounds come from the same viewer's calendar: a zone 7 hours behind UTC gets a full day, shifted, never a truncated one.
  const la = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) + 7 * 3_600_000;
  const [start, end] = expandDayFilters([{ field: "createdAt", op: "eq", value: "2026-10-07" }], days, la);
  assert.equal(Number(end!.value) - Number(start!.value), 24 * 3_600_000);
  // The real local calendar: across a DST change the day is 23 or 25 hours.
  const [s2, e2] = expandDayFilters([{ field: "createdAt", op: "eq", value: "2026-03-08" }], days);
  assert.equal(e2!.value, new Date(2026, 2, 9).getTime());
  assert.equal(s2!.value, new Date(2026, 2, 8).getTime());
});

test("a saved view's day filter validates as a day, and a timestamp column takes no other text", () => {
  const task = resolveObjectDef(STANDARD_OBJECTS.task);
  assert.ok(dayColumnsOf(task).has("updatedAt"));
  const base = { columns: [], layout: "table" as const };
  assert.equal(viewSpecProblem(task, { ...base, filter: [{ field: "updatedAt", op: "lte", value: "2026-10-07" }] }), null);
  assert.match(viewSpecProblem(task, { ...base, filter: [{ field: "updatedAt", op: "lte", value: "yesterday" }] })!, /must be a number/);
});

test("collapseDayFilters turns stored day bounds back into days that expand to the same request", () => {
  const days = new Set(["createdAt"]);
  for (const op of ["eq", "gt", "gte", "lt", "lte"]) {
    const stored = expandDayFilters([{ field: "createdAt", op, value: "2026-03-08" }], days);
    const editable = collapseDayFilters(stored, days);
    assert.ok(editable.every((f) => typeof f.value === "string"));
    assert.deepEqual(expandDayFilters(editable, days), stored);
  }
});
