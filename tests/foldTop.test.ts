// A chart of many groups folds to its largest and an Other that adds the rest up (src/lib/fold-top.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { foldTop } from "../src/lib/fold-top.ts";

const p = (n: number) => ({ keyLabels: ["Name"], groups: Array.from({ length: n }, (_, i) => ({ keys: [`a${i}`], labels: [`A${i}`], values: [i, i * 2] })) });

test("many groups fold to the largest and an Other with the rest added up", () => {
  const out = foldTop(p(20), ["sum", "avg"], 3);
  assert.deepEqual(out.groups.map((g) => g.labels[0]), ["A19", "A18", "A17", "Other (17)"]);
  assert.deepEqual(out.groups[3].values, [136, null]);
});

test("a few groups, dates and two keys stay as they are", () => {
  assert.equal(foldTop(p(4), ["sum"], 3).groups.length, 4);
  assert.equal(foldTop(p(20), ["sum"], 3, true).groups.length, 20);
  assert.equal(foldTop({ ...p(20), keyLabels: ["A", "B"] }, ["sum"], 3).groups.length, 20);
});
