// The date range picker's labels (src/lib/date-range-text.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { dayText, rangeText } from "../src/lib/date-range-text.ts";

test("a day reads as month, day and year", () => {
  assert.equal(dayText("2026-07-01"), "Jul 1, 2026");
});

test("a range names its year once when both ends share it", () => {
  assert.equal(rangeText({ from: "2026-07-01", to: "2026-09-30" }), "Jul 1 – Sep 30, 2026");
  assert.equal(rangeText({ from: "2025-11-15", to: "2026-02-01" }), "Nov 15, 2025 – Feb 1, 2026");
  assert.equal(rangeText({ from: "2026-07-01", to: "2026-07-01" }), "Jul 1, 2026");
});

test("an open range says which end it has, and none reads as any date", () => {
  assert.equal(rangeText({ from: "2026-07-01", to: null }), "From Jul 1, 2026");
  assert.equal(rangeText({ from: null, to: "2026-07-01" }), "Through Jul 1, 2026");
  assert.equal(rangeText(null), "Any date");
  assert.equal(rangeText({ from: null, to: null }), "Any date");
});
