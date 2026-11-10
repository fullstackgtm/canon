import assert from "node:assert/strict";
import test from "node:test";
import { cohorts, cumulative, fiscalMonth, historicalShape, periodOf, targetLine, type PacingRow } from "../modules/kernel/pacing.ts";
import { allocate, buildPlan, parseTargets, targetFor, type PlanInput } from "../modules/kernel/targets.ts";

const row = (day: string, amount: number): PacingRow => ({ day, amount, attrs: {} });

test("pacing: cohorts of different lengths, a running total that stops at today", () => {
  assert.deepEqual(cohorts("2026-03-15", "quarter", 3).map((p) => [p.label, p.days]), [["Q1 2026", 90], ["Q4 2025", 92], ["Q3 2025", 92]]);
  assert.equal(periodOf("2024-02-10", "month").days, 29);
  assert.deepEqual(cohorts("2024-02-29", "year", 2, 2).map((p) => [p.start, p.days]), [["2024-02-01", 366], ["2023-02-01", 365]]);
  const p = periodOf("2026-10-14", "month");
  const line = cumulative([row("2026-10-01", 5), row("2026-10-03", 10), row("2026-09-30", 99), row("2026-10-20", 7)], p, "sum", "2026-10-14");
  assert.deepEqual(line.slice(0, 4), [5, 5, 15, 15]);
  assert.equal(line[13], 15);
  assert.equal(line[14], null);
  assert.deepEqual(cumulative([row("2026-09-02", 1)], periodOf("2026-09-01", "month"), "count", "2026-10-14").at(-1), 1);
});

test("pacing: a historical target follows the shape past cohorts kept", () => {
  // Every past cohort closed nothing in its first half and everything on its last day.
  const shape = historicalShape([[0, 0, 0, 10], [0, 0, 0, 4]]);
  assert.equal(shape(0.5), 0);
  assert.equal(shape(1), 1);
  assert.deepEqual(targetLine(100, 4, "historical", shape), [0, 0, 0, 100]);
  assert.deepEqual(targetLine(100, 4, "linear"), [25, 50, 75, 100]);
});

test("fiscal year: quarters and years follow the start month, and a plan reads its own calendar", () => {
  assert.deepEqual(cohorts("2026-03-15", "quarter", 2, 2).map((p) => [p.label, p.start, p.days]), [["Q1 FY27", "2026-02-01", 89], ["Q4 FY26", "2025-11-01", 92]]);
  assert.deepEqual(periodOf("2026-01-20", "year", 2), { key: "2026", label: "FY26", start: "2025-02-01", days: 365 });
  assert.deepEqual(fiscalMonth("2026-02-03", 2), { fy: 2027, m: 0 });
  const plan = buildPlan(input({ year: 2027, fyStart: 2 }));
  assert.equal(plan.repMonths.new.slice(0, 5).reduce((s, x) => s + x, 0), 0, "Nia starts in July, month 5 of FY27");
  assert.ok(plan.repMonths.new[5] > 0);
  assert.equal(targetFor(plan, periodOf("2026-03-01", "quarter", 2)), plan.months[0] + plan.months[1] + plan.months[2]);
});

test("targets: allocate keeps locks, rebalances the rest and sums exactly", () => {
  const a = allocate(100, { a: 1, b: 1, c: 1 });
  assert.equal(a.a + a.b + a.c, 100);
  assert.deepEqual(allocate(100, { a: 1, b: 1, c: 2 }, { c: 70 }), { c: 70, a: 15, b: 15 });
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  year: 2026, total: 1_200_000,
  months: { method: "even" }, teams: { method: "even" }, reps: { method: "capacity" },
  history: { months: new Array(12).fill(0), teams: {}, reps: {} },
  teamList: [{ id: "ent", name: "Enterprise" }, { id: "smb", name: "SMB" }],
  repList: [
    { id: "maya", name: "Maya Chen", team: "ent" },
    { id: "new", name: "Nia Brooks", team: "ent", start: "2026-07-01", rampMonths: 2 },
    { id: "sam", name: "Sam Rivera", team: "smb" },
  ],
  ...over,
});

test("targets: a top-down plan rolls up at every level and backloads a ramping rep", () => {
  const plan = buildPlan(input());
  assert.equal(plan.months.reduce((s, x) => s + x, 0), 1_200_000);
  assert.equal(plan.teams.ent, 600_000);
  assert.equal(plan.reps.maya + plan.reps.new, 600_000);
  assert.ok(plan.reps.new < plan.reps.maya);
  assert.equal(plan.repMonths.new.slice(0, 6).reduce((s, x) => s + x, 0), 0);
  assert.ok(plan.repMonths.new[6] < plan.repMonths.new[9]);
  const q3 = periodOf("2026-08-01", "quarter");
  assert.equal(targetFor(plan, q3, { teams: ["ent"] }), [6, 7, 8].reduce((s, m) => s + plan.teamMonths.ent[m], 0));
  assert.equal(targetFor(plan, periodOf("2025-08-01", "quarter")), null);
  assert.equal(targetFor(plan, q3, { reps: ["someone-new"] }), null, "a rep the plan never split into has no target");

  const locked = buildPlan(input({ teams: { method: "even", locks: { smb: 1_000_000 } }, reps: { method: "even", locks: { maya: 300_000 } } }));
  assert.equal(locked.teams.ent, 200_000);
  assert.deepEqual(locked.misfits, [{ level: "ent", by: 100_000 }]);
  // Every rep locked below their team's amount: the rest has nowhere to go, so the plan says so instead of dropping it.
  const short = buildPlan(input({ repList: [{ id: "maya", name: "Maya Chen", team: "ent" }, { id: "sam", name: "Sam Rivera", team: "smb" }], reps: { method: "even", locks: { maya: 100_000 } } }));
  assert.deepEqual(short.misfits, [{ level: "ent", by: -500_000 }]);
});

test("targets: pasted bottom-up rows match by full or first name", () => {
  const named = [{ id: "maya", name: "Maya Chen" }, { id: "sam", name: "Sam Rivera" }];
  const { amounts, quarters, unmatched } = parseTargets("Maya Chen\t$300,000\t$1,200,000\nsam, 1.5M\nNobody 5k\nheader row", named);
  assert.deepEqual(amounts, { maya: 1_200_000, sam: 1_500_000 });
  assert.deepEqual(unmatched, ["Nobody 5k", "header row"]);
  // Quarterly columns (and a total) set the rep's quarters; the plan's months follow them.
  const q = parseTargets("Maya Chen\t100k\t200k\t300k\t400k\t1M", named);
  assert.deepEqual(q.quarters, { maya: [100_000, 200_000, 300_000, 400_000] });
  const plan = buildPlan(input({ repList: [{ id: "maya", name: "Maya Chen", team: "ent" }], reps: { method: "even", quarters: q.quarters } }));
  assert.equal(plan.repMonths.maya.slice(3, 6).reduce((s, x) => s + x, 0), 200_000);
});

test("targets: a save made on a version refuses, writing nothing, once the year's plan has changed", async () => {
  const { loadConvex, memoryDb } = await import("./convexHandlers.ts");
  const user = { _id: "u1", orgId: "org", role: "admin" };
  const fns = loadConvex(["targets.ts"], { "lib.ts": (r) => ({ ...r, requireCap: async () => user, requireUser: async () => user, getCurrentUser: async () => user }) })["targets.ts"];
  const db = memoryDb({ targetPlans: [] });
  const ctx = { db };
  const plan = { year: 2027, total: 100, coverage: 3, months: { method: "even" }, teams: { method: "even" }, reps: { method: "capacity" }, repTeam: {}, repMonths: {}, teamMonths: {} };
  await fns.store.handler(ctx, { ...plan, expect: null });
  const saved = db.rows("targetPlans")[0] as unknown as { updatedAt: number };
  await assert.rejects(fns.store.handler(ctx, { ...plan, total: 200, expect: null }), /changed since this was proposed/);
  await fns.store.handler(ctx, { ...plan, total: 300, expect: saved.updatedAt });
  assert.equal((db.rows("targetPlans")[0] as unknown as { total: number }).total, 300);
});
