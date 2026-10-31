import assert from "node:assert/strict";
import test from "node:test";
import { refreshLimit, refreshRows } from "../src/components/records/live-rows.ts";

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ id: `r${from + i}` }));

test("a background refresh keeps the loaded window instead of collapsing to the first page", () => {
  // 120 loaded: one re-read of 120 replaces them all, and its cursor wins.
  assert.equal(refreshLimit(120), 120);
  const fresh = [{ id: "new" }, ...ids(0, 119)];
  assert.deepEqual(refreshRows(ids(0, 120), fresh, { current: "old", fresh: "next" }), { rows: fresh, cursor: "next" });

  // 250 loaded: the first 200 are re-read, the rest stay with their cursor, without duplicates.
  assert.equal(refreshLimit(250), 200);
  const head = [{ id: "new" }, ...ids(0, 199)];
  const merged = refreshRows(ids(0, 250), head, { current: "old", fresh: "next" });
  assert.equal(merged.cursor, "old");
  assert.deepEqual(merged.rows.map((r) => r.id), ["new", ...ids(0, 250).map((r) => r.id)]);
});
