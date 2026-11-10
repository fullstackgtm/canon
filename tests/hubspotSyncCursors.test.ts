// The HubSpot sync's watermark (convex/hubspot.ts setSyncCursors) belongs to the run that finished.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const { "hubspot.ts": hubspot } = loadConvex(["hubspot.ts"]);

function world(runStatus: string, openSince: number) {
  return memoryDb({
    integrations: [{ _id: "integrations:hs", orgId: "org1", provider: "hubspot", isActive: true, syncCursors: { modifiedSince: 500, fullSyncAt: 500, openSince } }],
    integrationSyncRuns: [{ _id: "integrationSyncRuns:1", orgId: "org1", provider: "hubspot", status: runStatus, startedAt: 1000 }],
  });
}
const cursors = async (db: ReturnType<typeof world>) => ({ ...((await db.get("integrations:hs")) as unknown as { syncCursors: Record<string, unknown> }).syncCursors });
const publish = { orgId: "org1", syncRunId: "integrationSyncRuns:1", modifiedSince: 1000, mappingsKey: "k" };

test("a successful run moves the mark and clears its own open mark", async () => {
  const db = world("success", 1000);
  await hubspot.setSyncCursors.handler({ db }, publish);
  assert.deepEqual(await cursors(db), { modifiedSince: 1000, fullSyncAt: 500, mappingsKey: "k" });
});

test("a newer sync's open mark survives an older run's finish, so its failure still forces a full sync", async () => {
  const db = world("success", 2000);
  await hubspot.setSyncCursors.handler({ db }, publish);
  assert.equal((await cursors(db)).openSince, 2000);
  assert.equal((await cursors(db)).modifiedSince, 1000);
});

test("a run that was stopped or failed records nothing", async () => {
  const db = world("error", 1000);
  await hubspot.setSyncCursors.handler({ db }, publish);
  assert.deepEqual(await cursors(db), { modifiedSince: 500, fullSyncAt: 500, openSince: 1000 });
});
