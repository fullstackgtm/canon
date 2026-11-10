// Metrics with their own filter, and rates (convex/lib/objects/metricSplit.ts): a report splits into one plain
// aggregate per `where`, and the answers join back group by group.
import assert from "node:assert/strict";
import test from "node:test";
import { joinParts, needsSplit, splitReport } from "../convex/lib/objects/metricSplit.ts";
import type { ReportSpec } from "../modules/kernel/reportValidators.ts";

const open = { field: "isClosed", op: "eq" as const, value: false };
const closed = { field: "isClosed", op: "eq" as const, value: true };
const spec: ReportSpec = {
  object: "canon.deals", filter: [{ field: "dealType", op: "eq", value: "New" }], groupBy: [{ field: "ownerId" }], chart: "table",
  measures: [
    { fn: "sum", field: "amount", label: "Pipeline", where: [open] },
    { fn: "pctTrue", field: "isWon", label: "Win rate", where: [closed] },
    { fn: "count" },
  ],
};

test("only a filtered metric or a rate needs splitting", () => {
  assert.equal(needsSplit({ measures: [{ fn: "sum", field: "amount" }] }), false);
  assert.equal(needsSplit(spec), true);
});

test("a report splits into one aggregate per where, each with the report's own filters", () => {
  const { parts, refs } = splitReport(spec);
  assert.deepEqual(parts.map((p) => [p.filter, p.measures]), [
    [[spec.filter[0], open], [{ fn: "sum", field: "amount" }]],
    [[spec.filter[0], closed], [{ fn: "count" }]],
    [[spec.filter[0], closed, { field: "isWon", op: "eq", value: true }], [{ fn: "count" }]],
    [[spec.filter[0]], [{ fn: "count" }]],
  ]);
  assert.deepEqual(refs, [{ part: 0, at: 0 }, { part: 2, at: 0, over: { part: 1, at: 0 } }, { part: 3, at: 0 }]);
});

test("the answers join by group: a rate is its two counts divided, a missing count is 0", () => {
  const { refs } = splitReport(spec);
  const run = (groups: Array<[string, number]>, total: number, rows = 0) =>
    ({ groups: groups.map(([k, v]) => ({ keys: [k], values: [v] })), subtotals: [], total: [total], rows, truncated: false, projectedThrough: {} });
  const out = joinParts(spec, refs, [
    run([["ana", 500], ["bo", 300]], 800, 5),
    run([["ana", 4], ["cy", 2]], 6, 6),
    run([["ana", 3]], 3, 3),
    run([["ana", 7], ["bo", 2], ["cy", 2]], 11, 11),
  ]);
  assert.deepEqual(out.groups, [
    { keys: ["ana"], values: [500, 0.75, 7] },
    { keys: ["bo"], values: [300, null, 2] },
    { keys: ["cy"], values: [null, 0, 2] },
  ]);
  assert.deepEqual(out.total, [800, 0.5, 11]);
  assert.equal(out.rows, 11);
});

test("a metric filters on at most three fields", () => {
  assert.throws(() => splitReport({ ...spec, measures: [{ fn: "count", where: [open, open, open, open] }] }), /at most 3/);
});
