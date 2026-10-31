/**
 * The Forecast engine's goldens: docs/module-plans/forecast.md §12, fixture "Northwind", literal expected values.
 * Money is in cents; the plan's dollars are × 100.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accuracyOf, DEFAULT_RISK_SETTINGS, flow, moves, risksOf, rollup, systemNumbers, tree, type Deal, type DealChange, type Version } from "../modules/examples/forecast/engine.ts";

const $ = (dollars: number) => dollars * 100;
const Q4 = { start: "2026-10-01", end: "2026-12-31" };
const A = Date.UTC(2026, 9, 5), B = Date.UTC(2026, 9, 12);
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const members = [
  { id: "dana", name: "Dana", managerId: null }, { id: "mo", name: "Mo", managerId: "dana" }, { id: "lee", name: "Lee", managerId: "dana" },
  { id: "ava", name: "Ava", managerId: "mo" }, { id: "ben", name: "Ben", managerId: "mo" }, { id: "cal", name: "Cal", managerId: "lee" },
];
const deal = (id: string, ownerId: string, amount: number, closeDate: string, forecastCategory: string, extra: Partial<Deal> = {}): Deal =>
  ({ id, ownerId, amount: $(amount), closeDate, forecastCategory, isClosed: false, isWon: false, nextStep: "Next call", ...extra });
const won = { forecastCategory: "closed_won", isClosed: true, isWon: true };
const lost = { forecastCategory: "closed_lost", isClosed: true, isWon: false };
const atA: Record<string, Deal> = {
  D1: deal("D1", "ava", 120_000, "2026-11-15", "commit"), D2: deal("D2", "ava", 80_000, "2026-12-10", "best_case"),
  D3: deal("D3", "ava", 60_000, "2026-10-30", "commit"), D4: deal("D4", "ben", 150_000, "2026-12-20", "commit"),
  D5: deal("D5", "ben", 50_000, "2026-11-30", "pipeline", { nextStep: null }), D6: deal("D6", "cal", 200_000, "2026-12-05", "best_case"),
  D7: deal("D7", "cal", 90_000, "2026-12-15", "pipeline"),
};
const atB: Record<string, Deal> = {
  D1: atA.D1, D2: atA.D2, D3: { ...atA.D3, ...won }, D4: { ...atA.D4, closeDate: "2027-01-15" },
  D5: { ...atA.D5, forecastCategory: "best_case" }, D6: { ...atA.D6, amount: $(180_000), forecastCategory: "commit" },
  D7: { ...atA.D7, ...lost }, D8: deal("D8", "cal", 40_000, "2026-12-01", "pipeline"),
};
const ids = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];
const changes: DealChange[] = ids.map((id) => ({ id, before: atA[id] ?? null, after: atB[id] ?? null }));
const inQ4 = (ds: Record<string, Deal>) => Object.values(ds).filter((d) => d.closeDate! >= Q4.start && d.closeDate! <= Q4.end);
const parent = tree(members, []);
const targets = new Map([["ava", $(300_000)], ["ben", $(200_000)], ["cal", $(250_000)]]);
const pick = (r: { won: number; commit: number; bestCase: number; pipeline: number }) => [r.won, r.commit, r.bestCase, r.pipeline].map((x) => x / 100);

test("G-1 system numbers at B and at A, cumulative, rolled up the manager chain", () => {
  const at = (ds: Record<string, Deal>) => rollup(parent, systemNumbers(inQ4(ds), members.map((m) => m.id)), [], [], targets);
  const b = at(atB), a = at(atA);
  assert.deepEqual(Object.fromEntries(["ava", "ben", "cal", "mo", "lee", "dana"].map((m) => [m, pick(b.get(m)!)])), {
    ava: [60_000, 180_000, 260_000, 0], ben: [0, 0, 50_000, 0], cal: [0, 180_000, 180_000, 40_000],
    mo: [60_000, 180_000, 310_000, 0], lee: [0, 180_000, 180_000, 40_000], dana: [60_000, 360_000, 490_000, 40_000],
  });
  assert.deepEqual(Object.fromEntries(["ava", "ben", "cal", "dana"].map((m) => [m, pick(a.get(m)!)])), {
    ava: [0, 180_000, 260_000, 0], ben: [0, 150_000, 150_000, 50_000], cal: [0, 0, 200_000, 90_000], dana: [0, 330_000, 610_000, 140_000],
  });
});

test("G-2 calls roll up after the manager's adjustment, with gap, coverage and commit share", () => {
  const subs = [["ava", 220_000], ["ben", 40_000], ["cal", 180_000], ["mo", 220_000], ["lee", 180_000], ["dana", 420_000]].map(([member, call]) => ({ member: member as string, call: $(call as number) }));
  const r = rollup(parent, systemNumbers(inQ4(atB), members.map((m) => m.id)), subs, [{ by: "mo", member: "ben", field: "call", to: 0 }], targets);
  assert.deepEqual([r.get("ben")!.adjustedCall, r.get("ben")!.call, r.get("ben")!.adjusted], [0, $(40_000), true]);
  assert.deepEqual(["mo", "lee", "dana"].map((m) => r.get(m)!.reportsCall / 100), [220_000, 180_000, 400_000]);
  assert.equal(r.get("mo")!.reportsCallUnadjusted / 100, 260_000);
  const dana = r.get("dana")!;
  assert.deepEqual([dana.target / 100, dana.gap / 100, dana.coverage, Number(dana.commitShare!.toFixed(4))], [750_000, 690_000, 0.56, 0.8571]);
});

test("G-3 what moved A → B adds up from start to end, with its category moves", () => {
  const m = moves(changes, Q4);
  assert.deepEqual([m.start / 100, m.end / 100], [750_000, 530_000]);
  assert.deepEqual(Object.fromEntries(Object.entries(m.buckets).map(([k, b]) => [k, b.amount / 100])), { new: 40_000, moved_in: 0, increased: 0, decreased: -20_000, slipped: -150_000, moved_out: 0, lost: -90_000 });
  assert.deepEqual(m.won.deals, [{ id: "D3", amount: $(60_000) }]);
  assert.deepEqual(m.categoryMoves.map((c) => [c.id, c.from, c.to]), [["D3", "commit", "won"], ["D5", "pipeline", "best_case"], ["D6", "best_case", "commit"], ["D7", "pipeline", "lost"]]);
});

test("G-4 the flow of Commit at A, and what came into it", () => {
  const f = flow(changes, Q4, "commit");
  assert.deepEqual([f.start.amount / 100, f.start.deals], [330_000, 3]);
  assert.deepEqual(Object.fromEntries(Object.entries(f.ends).map(([k, e]) => [k, [e.amount / 100, e.deals.length]])), { won: [60_000, 1], upgraded: [0, 0], downgraded: [0, 0], idle: [120_000, 1], slipped: [150_000, 1], lost: [0, 0] });
  assert.deepEqual(f.into, [{ id: "D6", from: "best_case", amount: $(180_000) }]);
});

test("G-5 risks at B, each with its evidence; a dismissed push fires again on a newer push", () => {
  const two = [{ at: day("2026-10-09"), personId: "p1" }, { at: day("2026-10-09"), personId: "p2" }];
  const v = (iso: string, d: Partial<Version>): Version => ({ at: day(iso), ...d });
  const history: Record<string, Version[]> = {
    D1: [v("2026-07-14", atA.D1)], D2: [v("2026-07-14", { ...atA.D2, closeDate: "2026-11-20" }), v("2026-09-28", { ...atA.D2, closeDate: "2026-12-01" }), v("2026-10-03", atA.D2)],
    D4: [v("2026-07-14", atA.D4), v("2026-10-09", atB.D4)], D5: [v("2026-07-14", atA.D5), v("2026-10-10", atB.D5)],
    D6: [v("2026-07-14", atA.D6), v("2026-10-07", atB.D6)], D8: [v("2026-10-08", atB.D8)],
  };
  const activity: Record<string, Array<{ at: number; personId: string }>> = { D1: [{ at: day("2026-09-20"), personId: "p1" }, { at: day("2026-09-18"), personId: "p2" }] };
  const risks = Object.fromEntries(["D1", "D2", "D4", "D5", "D6", "D8"].map((id) => [id, risksOf(atB[id], history[id], activity[id] ?? two, DEFAULT_RISK_SETTINGS, B).map((r) => [r.rule, r.evidence])]));
  assert.deepEqual(risks, {
    D1: [["no_activity", "No activity since 2026-09-20 (22 days)"]],
    D2: [["pushed", "Close date moved 2026-11-20 → 2026-12-01 → 2026-12-10"]],
    D4: [], D5: [["no_next_step", "No next step"]],
    D6: [["amount_down", "Amount $200,000 → $180,000 (−10%)"]], D8: [],
  });
  assert.deepEqual([risksOf(atB.D3, [], [], DEFAULT_RISK_SETTINGS, B), risksOf(atB.D7, [], [], DEFAULT_RISK_SETTINGS, B)], [[], []]);
  // D2 pushed again: the rule fires on the newer evidence, which the risk job compares to the dismissed one to reopen it.
  const again = risksOf({ ...atB.D2, closeDate: "2027-01-10" }, [...history.D2, v("2026-10-12", { ...atA.D2, closeDate: "2027-01-10" })], two, DEFAULT_RISK_SETTINGS, B);
  assert.deepEqual(again.map((r) => r.evidence), ["Close date moved 2026-11-20 → 2026-12-01 → 2026-12-10 → 2027-01-10"]);
  // Amount-only samples carry no category: an always-omitted deal doesn't read as moved down from pipeline.
  const omitted = deal("O1", "ava", 10_000, "2026-11-20", "omit", { nextStep: "Call" });
  assert.equal(risksOf(omitted, [{ at: B, amount: $(10_000) }], two, DEFAULT_RISK_SETTINGS, B).some((r) => r.rule === "category_down"), false);
});

test("G-6 accuracy of a closed period's week-4 call", () => {
  const a = accuracyOf($(500_000), $(450_000));
  assert.deepEqual([a.error / 100, Number(a.accuracy!.toFixed(4))], [50_000, 0.8889]);
});

test("a manager chain that loops is refused with its members named", () => {
  assert.throws(() => tree([{ id: "a", name: "Ann", managerId: "b" }, { id: "b", name: "Bo", managerId: "a" }], []), /Ann → Bo → Ann/);
});

test("the Team call counts deals no member owns at the top, and offers Adjust only on the caller's own reports", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const reads = {
    period: doc("current", { period: "2026-Q4", label: "Q4 2026", start: "2026-10-01", end: "2026-12-31" }), settings: null,
    users: members, teams: [], subs: [], adjs: [], plan: [],
    deals: [...inQ4(atB), deal("U1", "nobody", 25_000, "2026-11-01", "commit")],
  };
  const team = (caller: string, member?: string) => calls.team({ now: B, caller: { userId: caller, role: "manager" }, args: member ? { member } : {} }, reads as never) as { value: { root: Record<string, number>; rows: Array<Record<string, unknown>> } };
  const top = team("dana").value;
  assert.deepEqual([top.root.commit / 100, top.rows.at(-1)!.name, (top.rows.at(-1)!.commit as number) / 100], [385_000, "Unassigned (no Canon owner)", 25_000]);
  assert.equal(team("mo").value.rows.some((r) => r.member === "unassigned"), false, "a manager lower down doesn't own them");
  const drilled = team("dana", "mo").value.rows;
  assert.deepEqual(drilled.map((r) => [r.member, r.isReport]), [["mo", true], ["ava", false], ["ben", false]], "Dana's adjustment reaches Mo, not Mo's reps");
});

test("the risk job opens a flag, reopens a dismissed one whose evidence moved on, and clears one that stopped firing", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const doc = (key: string, version: number, data: Record<string, unknown>) => ({ key, version, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const two = [{ dealId: "D2", at: day("2026-10-09"), personId: "p1" }, { dealId: "D2", at: day("2026-10-09"), personId: "p2" }];
  const run = (existing: unknown[], dates: string[]) => (calls.assess({ now: B, caller: { userId: "system", role: "system" }, args: { keys: ["D2"], deal: ["D2"] } }, {
    deals: [{ ...atB.D2, closeDate: dates.at(-1) }], changes: [{ id: "D2", before: atA.D2, after: atB.D2, closeDates: dates }], acts: two, existing,
  } as never) as { byKey: Record<string, Array<Record<string, unknown>>> }).byKey.D2.map((i) => [i.op, i.key ?? "", (i.data as { evidence?: string } | undefined)?.evidence ?? i.name ?? ""]);
  assert.deepEqual(run([], ["2026-11-20", "2026-12-01", "2026-12-10"]), [["put", "D2|pushed", "Close date moved 2026-11-20 → 2026-12-01 → 2026-12-10"], ["notify", "", ""]], "a new high risk tells its owner");
  const dismissed = doc("D2|pushed", 3, { deal: "D2", rule: "pushed", evidence: "Close date moved 2026-11-20 → 2026-12-01 → 2026-12-10", status: "dismissed" });
  assert.deepEqual(run([dismissed], ["2026-11-20", "2026-12-01", "2026-12-10", "2027-01-10"]), [
    ["patch", "D2|pushed", "Close date moved 2026-11-20 → 2026-12-01 → 2026-12-10 → 2027-01-10"], ["transition", "D2|pushed", "reopen"],
  ]);
  assert.deepEqual(run([{ ...dismissed, data: { ...dismissed.data, status: "open" } }], ["2026-12-10"]), [["delete", "D2|pushed", ""]], "a deal whose flag stopped firing clears it");
  // Reassigned with the same evidence: the risk follows its deal's new owner, and a dismissed one stays dismissed.
  const owned = calls.assess({ now: B, caller: { userId: "system", role: "system" }, args: { keys: ["D2"], deal: ["D2"] } }, {
    deals: [{ ...atB.D2, ownerId: "ben" }], changes: [{ id: "D2", before: atA.D2, after: atB.D2, closeDates: ["2026-11-20", "2026-12-01", "2026-12-10"] }], acts: two,
    existing: [{ ...dismissed, data: { ...dismissed.data, owner: "ava" } }],
  } as never) as { byKey: Record<string, Array<Record<string, unknown>>> };
  assert.deepEqual(owned.byKey.D2.map((i) => [i.op, (i.data as { owner?: string }).owner, "deal" in (i.data as object) || "rule" in (i.data as object)]), [["patch", "ben", false]], "a patch names no key field");
  const swept = calls.riskSweep({ now: B, caller: { userId: "system", role: "system" }, args: {} }, { deals: Object.values(atB) } as never) as { intents: Array<{ key: string }> };
  assert.deepEqual(swept.intents.map((i) => i.key), ["D1", "D2", "D4", "D5", "D6", "D8"], "every open deal, daily and on install");
});

test("the What moved call shapes G-3 into steps that add up, its category moves and the flow of Commit", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const period = { key: "current", version: 1, data: { period: "2026-Q4", label: "Q4 2026", start: Q4.start, end: Q4.end }, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 };
  const v = (calls.moved({ now: B, caller: { userId: "dana", role: "admin" }, args: {} }, { period, changes } as never) as { value: Record<string, any> }).value;
  assert.deepEqual([v.start, v.end, v.newAmount, v.down, v.slipped, v.lost].map((x: number) => x / 100), [750_000, 530_000, 40_000, -20_000, -150_000, -90_000]);
  assert.deepEqual(v.flows.filter((f: { from: string }) => f.from === "Commit").map((f: { to: string; amount: number }) => [f.to, f.amount / 100]), [["Won", 60_000], ["Unchanged", 120_000], ["Slipped", 150_000], ["Came in", 180_000]]);
});

test("G-6 through Close period: Dana's week-4 call against what her tree won, and the period's final won", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const weeks = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03"];
  const subs = weeks.map((week, i) => doc(`2026-Q3|${week}|dana`, { period: "2026-Q3", week, member: "dana", call: $(i === 3 ? 500_000 : 600_000), status: "submitted" }));
  const q3 = [deal("W1", "ava", 300_000, "2026-08-20", "commit", won), deal("W2", "cal", 150_000, "2026-09-10", "commit", won), deal("L1", "ben", 80_000, "2026-09-12", "pipeline", lost)];
  const reads = {
    period: doc("2026-Q3", { period: "2026-Q3", label: "Q3 2026", start: "2026-07-01", end: "2026-09-30", status: "open" }), settings: null,
    users: members, teams: [], deals: q3, subs, existing: [],
  } as never;
  assert.throws(() => calls.closePeriod({ now: Date.parse("2026-09-15"), caller: { userId: "dana", role: "admin" }, args: { period: "2026-Q3" } }, reads), /isn't over/);
  const out = calls.closePeriod({ now: B, caller: { userId: "dana", role: "admin" }, args: { period: "2026-Q3" } }, reads) as { intents: Array<{ op: string; data: Record<string, number | string> }> };
  const acc = out.intents.find((i) => i.op === "put")!.data;
  assert.deepEqual([acc.week, (acc.call as number) / 100, (acc.actual as number) / 100, (acc.error as number) / 100, Number((acc.accuracy as number).toFixed(4))], ["2026-07-27", 500_000, 450_000, 50_000, 0.8889]);
  assert.deepEqual(out.intents.at(-1)!.data, { status: "closed", finalWon: $(450_000), closedAt: B });
});

test("the weekly freeze keeps each member's numbers and call for the week, and on the cadence day tells whoever hasn't called", async () => {
  const { calls } = await import("../modules/examples/forecast/server.ts");
  const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
  const sub = (member: string, call: number) => doc(`2026-Q4|2026-10-12|${member}`, { period: "2026-Q4", week: "2026-10-12", member, call: $(call), status: "submitted" });
  const out = calls.freezeWeek({ now: B, caller: { userId: "system", role: "system" }, args: {} }, {
    period: doc("current", { period: "2026-Q4", label: "Q4 2026", start: Q4.start, end: Q4.end }), settings: null, users: members, teams: [],
    deals: inQ4(atB), subs: [sub("ava", 220_000), sub("dana", 420_000)], adjs: [], plan: [], existing: [],
  } as never) as { intents: Array<Record<string, any>> };
  const ava = out.intents.find((i) => i.key === "2026-Q4|2026-10-12|ava")!.data;
  assert.deepEqual([ava.week, ava.commit / 100, ava.bestCase / 100, ava.call / 100], ["2026-10-12", 180_000, 260_000, 220_000]);
  assert.deepEqual(out.intents.filter((i) => i.op === "notify").flatMap((i) => i.to).sort(), ["ben", "cal", "lee", "mo"], "Monday is the cadence day: everyone who hasn't called");
});
