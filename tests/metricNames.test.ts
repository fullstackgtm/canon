// A metric in plain words (src/lib/metric-names.ts): its name, its definition line, and the ones a source suggests.
import assert from "node:assert/strict";
import test from "node:test";
import { metricDefinition, metricName, suggestedMetrics } from "../src/lib/metric-names.ts";

test("a metric reads as plain words", () => {
  assert.equal(metricName({ fn: "count" }, "", "Deals"), "Number of deals");
  assert.equal(metricName({ fn: "sum" }, "Amount", "Deals"), "Total amount");
  assert.equal(metricName({ fn: "avg" }, "Probability", "Deals"), "Average probability");
  assert.equal(metricName({ fn: "max" }, "Amount", "Deals"), "Largest amount");
  assert.equal(metricName({ fn: "sum" }, "ARR", "Deals"), "Total ARR");
});

test("the definition leads with the word a click changes", () => {
  assert.equal(metricDefinition({ fn: "sum" }, "Amount", "Deals"), "TOTAL of Amount");
  assert.equal(metricDefinition({ fn: "count" }, "", "Deals"), "COUNT of deals");
});

test("a source suggests a count, money totals and averages, then other numbers' averages", () => {
  const s = suggestedMetrics([{ name: "amount", label: "Amount", type: "currency" }, { name: "probability", label: "Probability", type: "number" }, { name: "stage", label: "Stage", type: "picklist" }]);
  assert.deepEqual(s, [{ fn: "count" }, { fn: "sum", field: "amount" }, { fn: "avg", field: "amount" }, { fn: "avg", field: "probability" }]);
});

test("a labelled metric keeps its name; a rate reads as a share of yes", async () => {
  const { metricName, metricDefinition, whereText } = await import("../src/lib/metric-names.ts");
  assert.equal(metricName({ fn: "sum", label: "Pipeline" }, "Amount", "Deals"), "Pipeline");
  assert.equal(metricName({ fn: "pctTrue" }, "Won", "Deals"), "% won");
  assert.equal(metricDefinition({ fn: "pctTrue" }, "Won", "Deals"), "% YES of Won");
  assert.equal(whereText([{ field: "isClosed", op: "eq", value: false }], () => "Closed"), "Closed is no");
});

test("deals offer Pipeline, Won revenue, Win rate and Average deal size, read from the won and closed flags", async () => {
  const { presetMetrics } = await import("../src/lib/metric-names.ts");
  const fields = [{ name: "amount", label: "Amount", type: "currency" }, { name: "isWon", label: "Won", type: "checkbox" }, { name: "isClosed", label: "Closed", type: "checkbox" }];
  const p = presetMetrics(fields);
  assert.deepEqual(p.map((x) => x.label), ["Pipeline", "Won revenue", "Win rate", "Average deal size"]);
  assert.deepEqual(p[2], { fn: "pctTrue", field: "isWon", label: "Win rate", where: [{ field: "isClosed", op: "eq", value: true }] });
  assert.deepEqual(presetMetrics([{ name: "urgent", label: "Urgent", type: "checkbox" }]).map((x) => x.label), ["% urgent"]);
});
