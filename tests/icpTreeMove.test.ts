import assert from "node:assert/strict";
import test from "node:test";
import { treeMoveError, type MovableNode } from "../modules/kernel/icpTreeMove.ts";

const nodes: MovableNode[] = [
  { id: "icp", kind: "icp", parent: null },
  { id: "other", kind: "icp", parent: null },
  { id: "segment", kind: "segment", parent: "icp" },
  { id: "nested", kind: "segment", parent: "segment" },
  { id: "persona", kind: "persona", parent: "nested" },
  { id: "peer", kind: "segment", parent: "icp" },
  { id: "deep", kind: "segment", parent: "peer" },
];

test("segments and personas can nest and return to the ICP root", () => {
  assert.equal(treeMoveError(nodes, "persona", "segment"), null);
  assert.equal(treeMoveError(nodes, "persona", "icp"), null);
  assert.equal(treeMoveError(nodes, "segment", "peer"), null);
  const moved = nodes.map((n) => n.id === "segment" ? { ...n, parent: "peer" } : n);
  assert.equal(treeMoveError(moved, "segment", "icp"), null);
});

test("moves reject cycles, persona parents, cross-ICP moves and excessive subtree depth", () => {
  for (const [source, target] of [
    ["segment", "segment"], ["segment", "nested"], ["segment", "persona"],
    ["segment", "other"], ["icp", "peer"], ["persona", "missing"],
    ["segment", "deep"], ["persona", "nested"],
  ]) assert.ok(treeMoveError(nodes, source, target), `${source} -> ${target}`);
});
