import assert from "node:assert/strict";
import * as capabilities from "../convex/lib/capabilities.ts";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { treeMoveError } from "../modules/kernel/icpTreeMove.ts";

test("updateNode persists reparenting, detaches to root, and rejects unauthorized or invalid moves", async () => {
  const nodes = [
    { _id: "s", icpId: "icp", orgId: "org", kind: "segment" },
    { _id: "p", icpId: "icp", orgId: "org", kind: "persona", parentId: "s" },
    { _id: "t", icpId: "icp", orgId: "org", kind: "segment" },
    { _id: "foreign", icpId: "elsewhere", orgId: "elsewhere", kind: "segment" },
  ];
  let canEdit = true;
  const patches: Array<[string, Record<string, unknown>]> = [];
  const ctx = { db: {
    get: async (id: string) => nodes.find((n) => n._id === id),
    query: () => ({ withIndex: () => ({ take: async () => nodes.filter((n) => n.icpId === "icp") }) }),
    patch: async (id: string, patch: Record<string, unknown>) => { patches.push([id, patch]); },
  } };
  const registration = (definition: unknown) => definition;
  const validator = new Proxy({}, { get: () => () => ({}) });
  const stubs: Record<string, unknown> = {
    "convex/values": { v: validator, ConvexError: Error },
    "./_generated/server": { mutation: registration, query: registration, action: registration, internalQuery: registration },
    "./_generated/api": {},
   "./lib/capabilities": capabilities,
    "./lib": { requireCap: async () => { if (!canEdit) throw Error("Forbidden"); return { orgId: "org" }; } },
    "./lib/modules/interfaceOwnership": { assertLegacyIcpsWritable: async () => {} }, "./lib/icpsInterface": {},
    "./icps": {}, "./lib/icps": {}, "./lib/recipes": {}, "../modules/kernel/icpQuery": {},
    "./lib/icpTree": {}, "../modules/kernel/icpTreeMove": { treeMoveError }, "./records": {}, "./lib/recordClient": {},
  };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../convex/icpTree.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const exports: { updateNode?: { handler: (context: typeof ctx, args: { nodeId: string; parentId: string | null }) => Promise<unknown> } } = {};
  runInNewContext(outputText, { exports, require: (id: string) => {
    assert.ok(Object.hasOwn(stubs, id), id);
    return stubs[id];
  } });
  const move = (nodeId: string, parentId: string | null) => exports.updateNode!.handler(ctx, { nodeId, parentId });
  await move("s", "t");
  assert.equal(patches[0][0], "s");
  assert.equal(patches[0][1].parentId, "t");
  assert.equal(nodes[1].parentId, "s", "moving a segment keeps its children attached");
  await move("p", null);
  assert.ok(Object.hasOwn(patches[1][1], "parentId"));
  assert.equal(patches[1][1].parentId, undefined, "Convex patch removes the old parent field");
  for (const [source, target] of [["s", "p"], ["s", "foreign"], ["foreign", "s"], ["s", "s"]]) {
    await assert.rejects(move(source, target));
  }
  canEdit = false;
  await assert.rejects(move("p", "t"));
  assert.equal(patches.length, 2, "rejected moves never write");
});
