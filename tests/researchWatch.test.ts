import assert from "node:assert/strict";
import test from "node:test";
import { watchRun } from "../convex/lib/research/watch.ts";

test("watchRun stops a run that only fails or never answers, and lets the rest go on", () => {
  assert.equal(watchRun({ done: 0, answered: 0, inferred: 0, errors: 5 }, "Timed out after 90s")?.rule, "failing");
  assert.equal(watchRun({ done: 1, answered: 0, inferred: 0, errors: 9 }), null, "one record got through");
  assert.equal(watchRun({ done: 20, answered: 0, inferred: 0, errors: 0 })?.rule, "no_answers");
  assert.equal(watchRun({ done: 20, answered: 0, inferred: 1, errors: 0 }), null, "an inferred answer counts");
  assert.equal(watchRun({ done: 19, answered: 0, inferred: 0, errors: 3 }), null);
});
