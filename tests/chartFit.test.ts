// Which charts the report builder offers for a report (src/lib/chart-fit.ts): the ones that can't draw it say why,
// and the one that reads it best is suggested.
import assert from "node:assert/strict";
import test from "node:test";
import { chartFit } from "../src/lib/chart-fit.ts";

test("with no dimension, only a number or a table can show the report", () => {
  const fit = chartFit({ groupBy: [], measures: [{ fn: "count" }] });
  assert.equal(fit.suggested, "number");
  assert.deepEqual(Object.keys(fit.why).sort(), ["area", "bar", "column", "line", "pie"]);
  assert.equal(fit.why.bar, "add a dimension");
});

test("a date dimension suggests columns, any other suggests bars", () => {
  assert.equal(chartFit({ groupBy: [{ field: "closeDate", bucket: "month" }], measures: [{ fn: "count" }] }).suggested, "column");
  assert.equal(chartFit({ groupBy: [{ field: "stage" }], measures: [{ fn: "count" }] }).suggested, "bar");
});

test("a pie needs a count or a sum as its first value", () => {
  const sum = chartFit({ groupBy: [{ field: "stage" }], measures: [{ fn: "sum", field: "amount" }] });
  assert.deepEqual(sum.why, {});
  const avg = chartFit({ groupBy: [{ field: "stage" }], measures: [{ fn: "avg", field: "amount" }, { fn: "count" }] });
  assert.deepEqual(avg.why, { pie: "needs a count or a sum" });
});
