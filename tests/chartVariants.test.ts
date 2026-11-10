// The report builder's chart picker (src/lib/chart-variants.ts): each picture maps to a chart and how it draws.
import assert from "node:assert/strict";
import test from "node:test";
import { CHART_VARIANTS, variantOf, variantWhy, withVariant } from "../src/lib/chart-variants.ts";

const v = (id: string) => CHART_VARIANTS.find((x) => x.id === id)!;
const base = { chart: "table" as const, groupBy: [{ field: "stage" }], measures: [{ fn: "sum" as const, field: "amount" }, { fn: "count" as const }] };

test("picking a variant sets its chart and stacking, and reads back as itself", () => {
  for (const x of CHART_VARIANTS) assert.equal(variantOf({ ...base, ...withVariant(base, x) }).id, x.id);
});

test("columns and line draws the second metric as the line; plain columns drop it", () => {
  const combo = withVariant(base, v("combo"));
  assert.deepEqual(combo.display?.types, ["bar", "line"]);
  assert.equal(withVariant({ ...base, ...combo }, v("column")).display?.types, undefined);
});

test("a variant that can't draw the report says why", () => {
  assert.equal(variantWhy({ ...base, measures: [{ fn: "count" }] }, v("combo")), "needs two metrics and one dimension");
  assert.equal(variantWhy({ ...base, groupBy: [] }, v("column")), "add a dimension");
  assert.equal(variantWhy(base, v("table")), undefined);
});
