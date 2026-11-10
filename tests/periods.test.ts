import assert from "node:assert/strict";
import test from "node:test";
import { currentMonthRange, currentQuarterRange } from "../src/lib/periods.ts";

const may2026 = new Date("2026-05-03T12:00:00.000Z");

test("derives the current UTC month range", () => {
  assert.deepEqual(currentMonthRange(may2026), {
    start: "2026-05-01",
    end: "2026-05-31",
    label: "2026-05",
  });
});

test("derives the current UTC quarter range and label", () => {
  assert.deepEqual(currentQuarterRange(may2026), {
    start: "2026-04-01",
    end: "2026-06-30",
    label: "Q2 2026",
  });
});
