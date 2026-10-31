// Reports (CP9). The SQL's equivalence with these in-memory semantics is
// services/record-service/test/aggregate.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { isRegisterObject, registerListDef, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { ACTIVITY_OBJECT, activityReportDef, compileAggregateRequest } from "../convex/lib/objects/reportSpec.ts";
import { stageHistoryReport, stageVisits } from "../convex/lib/objects/stageHistory.ts";
import type { LedgerEntry } from "../convex/lib/objects/fold.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { openPipelineOf } from "../src/lib/revenue.ts";
import { needsLoad, present } from "../src/components/reports/present.ts";

const deals = [
  { id: "d1", name: "Atlas", stage: "proposal", amount: 14_500_000, isClosed: false },
  { id: "d2", name: "Northstar", stage: "discovery", amount: 9_200_000, isClosed: false },
  { id: "d3", name: "Cove", stage: "discovery", amount: null, isClosed: false },
  { id: "d4", name: "Brightline", stage: "closed_won", amount: 21_000_000, isClosed: true },
  { id: "d5", name: "Dune", stage: null, amount: 1_000_000, isClosed: false },
];

const row = (d: (typeof deals)[number]): ListRow => ({
  id: d.id, object: "deal", version: 1, status: "active", title: d.name, createdAt: 1, updatedAt: 1, deletedAt: null,
  values: { name: d.name, stage: d.stage, amount: d.amount, isClosed: d.isClosed, isWon: false, currency: "USD" },
});

test("a pipeline-by-stage report adds up to the Revenue page's open pipeline", async () => {
  const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
  const client = createFakeRecordClient({
    store: createMemoryRecordStore(),
    objects: { rows: async () => ({ rows: deals.map(row), defs: [plainObjectDef(deal)], heads: {} }) },
  });
  const report = await client.aggregate("org", "deal", {
    filter: [{ field: "isClosed", op: "eq", value: false }],
    groupBy: [{ field: "stage" }],
    measures: [{ fn: "sum", field: "amount" }, { fn: "count" }],
  });
  assert.deepEqual(report.groups, [
    { keys: ["discovery"], values: [9_200_000, 2] },
    { keys: ["proposal"], values: [14_500_000, 1] },
    { keys: [null], values: [1_000_000, 1] },
  ]);
  const revenue = openPipelineOf(deals);
  assert.deepEqual(report.total, [revenue.amount, revenue.count]);
  assert.deepEqual(report.total, [24_700_000, 4]);
});

test("a report reads as its fields mean: stages in pipeline order, dates as buckets, money in dollars", () => {
  const p = present(
    { groupBy: [{ field: "stage" }, { field: "closeDate", bucket: "quarter" }], measures: [{ fn: "sum", field: "amount" }] },
    {
      groups: [{ keys: ["discovery", "2026-10-01"], values: [9_200_000] }, { keys: ["proposal", "2026-07-01"], values: [14_500_000] }, { keys: [null, "2026-10-01"], values: [100] }],
      subtotals: [{ keys: ["discovery"], values: [9_200_000] }, { keys: ["proposal"], values: [14_500_000] }, { keys: [null], values: [100] }],
      total: [23_700_100], rows: 3, truncated: false,
    },
    [{ label: "Stage", type: "picklist", options: [{ value: "proposal", label: "Proposal" }, { value: "discovery", label: "Discovery" }] }, { label: "Close date", type: "date" }],
    [{ label: "Amount", type: "currency" }],
  );
  assert.deepEqual(p.groups.map((g) => g.labels), [["Proposal", "Q3 2026"], ["Discovery", "Q4 2026"], ["No stage", "Q4 2026"]]);
  assert.deepEqual(p.subtotals.map((g) => g.labels[0]), ["Proposal", "Discovery", "No stage"]);
  assert.deepEqual([p.measureLabels[0], p.format(0, p.total[0])], ["Sum of Amount", "$237,001"]);
});

test("a second key never reorders the first: months stay in order across stages", () => {
  const p = present(
    { groupBy: [{ field: "closeDate", bucket: "month" }, { field: "stage" }], measures: [{ fn: "count" }] },
    {
      groups: [{ keys: ["2026-01-01", "discovery"], values: [1] }, { keys: ["2026-01-01", "proposal"], values: [1] }, { keys: ["2026-02-01", "discovery"], values: [1] }],
      subtotals: [{ keys: ["2026-01-01"], values: [2] }, { keys: ["2026-02-01"], values: [1] }],
      total: [3], rows: 3, truncated: false,
    },
    [{ label: "Close date", type: "date" }, { label: "Stage", type: "picklist", options: [{ value: "proposal", label: "Proposal" }, { value: "discovery", label: "Discovery" }] }],
    [undefined],
  );
  assert.deepEqual(p.groups.map((g) => g.labels), [["Jan 2026", "Proposal"], ["Jan 2026", "Discovery"], ["Feb 2026", "Discovery"]]);
});

test("editing, renaming or sharing a saved report keeps the draft; opening another loads it", () => {
  const saved = { spec: { object: "deal" } };
  const loaded = needsLoad(null, "r1", saved, false)!;
  assert.deepEqual(loaded, { reportId: "r1", spec: '{"object":"deal"}' });
  assert.equal(needsLoad(loaded, "r1", saved, true), null, "the first edit does not reload");
  assert.equal(needsLoad(loaded, "r1", { spec: { object: "deal" } }, false), null, "a rename or share (same spec) does not reload");
  assert.equal(needsLoad(loaded, "r1", { spec: { object: "account" } }, true), null, "a spec saved elsewhere waits while there are edits");
  assert.deepEqual(needsLoad(loaded, "r1", { spec: { object: "account" } }, false), { reportId: "r1", spec: '{"object":"account"}' });
  assert.deepEqual(needsLoad(loaded, "r2", saved, true), { reportId: "r2", spec: '{"object":"deal"}' });
});

test("stage history: each change of a deal's folded stage is a visit, and time in stage counts finished stays", () => {
  const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
  const day = (n: number) => Date.UTC(2026, 0, 1) + n * 86_400_000;
  const user = { source: { kind: "user" as const, ref: "user:u1" }, actor: { kind: "user" as const, id: "u1" } };
  const set = (streamId: string, version: number, at: number, values: Record<string, unknown>): LedgerEntry => ({
    streamId, version, observedAt: at, ...user,
    body: { kind: "assert", status: "accepted", assertions: Object.entries(values).map(([fieldId, value]) => ({ fieldId, value })) } as never,
  });
  const a = [set("a", 1, day(0), { name: "A", stage: "discovery" }), set("a", 2, day(3), { stage: "proposal" }), set("a", 3, day(4), { amount: 5 }), set("a", 4, day(10), { stage: "negotiation" })];
  const b = [set("b", 1, day(0), { name: "B" }), set("b", 2, day(1), { stage: "discovery" })];
  const gone = [set("c", 1, day(0), { name: "C", stage: "discovery" }), { ...set("c", 2, day(2), {}), body: { kind: "lifecycle", op: "delete" } } as LedgerEntry];
  assert.deepEqual(stageVisits(deal, a), [
    { stage: "discovery", enteredAt: day(0), leftAt: day(3) }, { stage: "proposal", enteredAt: day(3), leftAt: day(10) }, { stage: "negotiation", enteredAt: day(10), leftAt: null },
  ]);
  const report = stageHistoryReport([a, b, gone].map((e) => stageVisits(deal, e)), day(12));
  assert.deepEqual(report.stages, [
    { stage: "discovery", entered: 2, left: 1, avgDays: 3, medianDays: 3, current: 1, currentAvgDays: 11 },
    { stage: "proposal", entered: 1, left: 1, avgDays: 7, medianDays: 7, current: 0, currentAvgDays: null },
    { stage: "negotiation", entered: 1, left: 0, avgDays: null, medianDays: null, current: 1, currentAvgDays: 2 },
  ]);
  assert.deepEqual([report.deals, report.byMonth.map((m) => [m.month, m.stage, m.entered])], [2, [["2026-01-01", "discovery", 2], ["2026-01-01", "proposal", 1], ["2026-01-01", "negotiation", 1]]]);
});
