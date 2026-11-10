// "vs previous period" (src/lib/period-compare.ts): the span before, by months when whole months, stopped the same
// number of days in when the range is in progress.
import assert from "node:assert/strict";
import test from "node:test";
import { change, previousPeriod } from "../src/lib/period-compare.ts";

test("a finished quarter compares with the whole quarter before", () => {
  assert.deepEqual(previousPeriod("2026-07-01", "2026-09-30", "2026-10-22"), { from: "2026-04-01", to: "2026-06-30", partial: false });
});

test("a quarter in progress compares with the same days of the last one", () => {
  assert.deepEqual(previousPeriod("2026-10-01", "2026-12-31", "2026-10-22"), { from: "2026-07-01", to: "2026-07-22", partial: true });
});

test("a month compares with the month before, whatever its length", () => {
  assert.deepEqual(previousPeriod("2026-03-01", "2026-03-31", "2026-05-01"), { from: "2026-02-01", to: "2026-02-28", partial: false });
});

test("a range of days compares with the same number of days before it", () => {
  assert.deepEqual(previousPeriod("2026-10-10", "2026-10-19", "2026-11-01"), { from: "2026-09-30", to: "2026-10-09", partial: false });
});

test("a rate moves by points, anything else by percent", () => {
  assert.deepEqual(change(0.5, 0.47, true), { text: "▲ 3 pts", up: true });
  assert.deepEqual(change(80, 100, false), { text: "▼ 20%", up: false });
  assert.equal(change(5, 0, false), null);
  assert.equal(change(null, 3, false), null);
});
