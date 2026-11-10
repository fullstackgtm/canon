// A report's style (src/lib/chart-style.ts): the heatmap tints a metric by its place in its column.
import assert from "node:assert/strict";
import test from "node:test";
import { heat, PALETTES, ranges } from "../src/lib/chart-style.ts";

test("every palette has eight hues", () => {
  for (const p of Object.values(PALETTES)) assert.equal(p.length, 8);
});

test("the heatmap tints the lowest lightly and the highest most", () => {
  assert.equal(heat(0, 0, 100), 0.06);
  assert.equal(heat(100, 0, 100), 0.46);
  assert.equal(heat(50, 0, 100), 0.26);
  assert.equal(heat(null, 0, 100), 0);
  assert.equal(heat(5, 5, 5), 0);
});

test("ranges read each column's lowest and highest, skipping empty cells", () => {
  assert.deepEqual(ranges([[1, null], [4, 2], [2, 8]], 2), [{ min: 1, max: 4 }, { min: 2, max: 8 }]);
  assert.deepEqual(ranges([[null]], 1), [{ min: 0, max: 0 }]);
});
