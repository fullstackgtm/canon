import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex } from "./convexHandlers.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { accessOf } from "../convex/lib/access.ts";

let client: ReturnType<typeof createFakeRecordClient>;
const modules = loadConvex(["recordMerges.ts"], {
  "records.ts": (real) => ({ ...real, callerClient: () => client, clientFor: () => client }),
});
const merges = modules["recordMerges.ts"] as unknown as { mergeAs: (...args: unknown[]) => Promise<unknown> };

test("merges refuse truncated people or activities before writing a partial move", async () => {
  for (const kind of ["contact", "note", "task", "call", "meeting"]) {
    for (const overCap of [true, false]) {
    const store = createMemoryRecordStore();
    await store.putAccounts("ws", ["acc_a", "acc_b"].map((id) => ({ id, domain: `${id}.example`, name: id, fit: 0, status: "new", segmentIds: [], source: "api", updatedAt: 1, version: 1 })));
    const n = (kind === "contact" ? 200 : 50) + (overCap ? 1 : -1);
    const base = createFakeRecordClient({ store });
    if (kind === "contact") await store.putContacts("ws", Array.from({ length: n }, (_, i) => ({ id: `con_${i}`, accountId: "acc_b", fullName: `Person ${i}`, status: "new", updatedAt: 1 })));
    client = { ...base, listObjects: async (_ws, object, req) => ({ rows: object === kind ? Array.from({ length: Math.min(n, req.limit ?? 50) }, (_, i) => ({ id: `activity_${i}`, title: "Activity", object, status: "active" as const, deletedAt: null, values: { accountId: "acc_b" }, version: 1, createdAt: 1, updatedAt: 1 })) : [], nextCursor: null, total: object === kind ? n : 0, projectedThrough: {} }) };
    let writes = 0;
    const merge = () => merges.mergeAs({}, { orgId: "ws", userId: "u", role: "admin", access: accessOf({ role: "admin", userId: "u" }) }, { object: "account", survivorId: "acc_a", loserIds: ["acc_b"], picks: {} }, async () => { writes++; });
    if (overCap) await assert.rejects(merge, { name: "ConvexError" }, kind);
    else await merge();
    assert.equal(writes, overCap ? 0 : 1);
    }
  }
});
