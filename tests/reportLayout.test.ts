// Dragging a report builder's dimensions and values (src/lib/report-layout.ts): reorder inside a list, move between
// Group by (two at most) and Split by (one).
import assert from "node:assert/strict";
import test from "node:test";
import { moveAt, moveKey } from "../src/lib/report-layout.ts";

test("an item moves to its new place in the list", () => {
  assert.deepEqual(moveAt(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveAt(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveAt(["a", "b"], 1, 9), ["a", "b"]);
});

test("Group by reorders in place", () => {
  assert.deepEqual(moveKey(["stage", "owner"], [], { list: "group", i: 1 }, { list: "group", i: 0 }), { group: ["owner", "stage"], split: [] });
});

test("a field dragged to Split by swaps with the one there", () => {
  assert.deepEqual(moveKey(["stage", "owner"], [], { list: "group", i: 1 }, { list: "split", i: 0 }), { group: ["stage"], split: ["owner"] });
  assert.deepEqual(moveKey(["stage", "owner"], ["close"], { list: "group", i: 0 }, { list: "split", i: 0 }), { group: ["close", "owner"], split: ["stage"] });
});

test("Split by moves into Group by at the drop, while there is room", () => {
  assert.deepEqual(moveKey(["stage"], ["owner"], { list: "split", i: 0 }, { list: "group", i: 0 }), { group: ["owner", "stage"], split: [] });
  assert.equal(moveKey(["stage", "type"], ["owner"], { list: "split", i: 0 }, { list: "group", i: 0 }), "Group by holds 2 fields at most.");
});
