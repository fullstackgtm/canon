import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyUsage, type UsageRow } from "../convex/lib/creditUsage.ts";

const at = (day: number) => Date.UTC(2026, 9, day, 12);
const row = (day: number, kind: string, amount: number, free = 0): UsageRow => ({ at: at(day), kind, amount, free });

test("daily usage walks back from today's bought balance and counts free spend as used", () => {
  // Free allowance 50: day 1 spends 20 free; day 3 buys 100, spends 90 (30 free, 60 bought); bought balance now 40.
  // A row from last month is ignored.
  const rows = [row(0, "purchase", 500), row(1, "spend", -20, 20), row(3, "purchase", 100), row(3, "spend", -90, 30)];
  const days = dailyUsage(rows, at(4), 40, 50);
  assert.deepEqual(days.map(({ used, added, cumulative, available, entries }) => [used, added, cumulative, available, entries]), [
    [20, 0, 20, 50, 1],
    [0, 0, 20, 50, 0],
    [90, 100, 110, 150, 2],
    [0, 0, 110, 150, 0],
  ]);
  // What's left matches the free credits left plus the bought balance.
  assert.equal(days[3].available - days[3].cumulative, 40);
});
