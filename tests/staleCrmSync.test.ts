// A CRM sync killed mid-run (Convex's action limit) must not hold the connection "in progress" for good.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const MIN = 60_000;
const admin = { _id: "users:1", orgId: "org1", role: "admin", name: "Ana", email: "ana@x.co" };
const { "integrations.ts": integrations } = loadConvex(["integrations.ts"], {
  "lib.ts": (real) => ({ ...real, requireUser: async () => admin }),
});

function world(runs: Array<{ provider: string; startedAt: number }>) {
  return memoryDb({
    integrations: [
      { _id: "integrations:sf", orgId: "org1", provider: "salesforce", lastSyncStatus: "in_progress", isActive: true },
      { _id: "integrations:gr", orgId: "org1", provider: "granola", lastSyncStatus: "in_progress", isActive: true },
    ],
    integrationSyncRuns: runs.map((r, i) => ({ _id: `integrationSyncRuns:${i}`, orgId: "org1", trigger: "scheduled", status: "in_progress", ...r })),
  });
}

test("the sweep ends CRM runs older than any action, and frees the connection", async () => {
  const db = world([
    { provider: "salesforce", startedAt: Date.now() - 10 * 24 * 60 * MIN },
    { provider: "salesforce", startedAt: Date.now() - MIN },
    { provider: "granola", startedAt: Date.now() - 60 * MIN },
  ]);
  assert.equal((await integrations.endStaleSyncs.handler({ db }, {})).ended, 1);
  assert.deepEqual(db.rows("integrationSyncRuns").map((r) => r.status), ["error", "in_progress", "in_progress"]);
  // The live run still holds the connection; the sweep frees it once nothing runs.
  assert.equal((await db.get("integrations:sf"))!.lastSyncStatus, "in_progress");
  assert.equal((await db.get("integrations:gr"))!.lastSyncStatus, "in_progress");
  await db.patch("integrationSyncRuns:1", { startedAt: Date.now() - 20 * MIN });
  await integrations.endStaleSyncs.handler({ db }, {});
  assert.equal((await db.get("integrations:sf"))!.lastSyncStatus, "error");
});

test("a new sync ends a stale run, but not a live one", async () => {
  const db = world([{ provider: "salesforce", startedAt: Date.now() - 20 * MIN }]);
  await integrations.startSyncRun.handler({ db }, { orgId: "org1", provider: "salesforce", trigger: "manual" });
  assert.deepEqual(db.rows("integrationSyncRuns").map((r) => r.status), ["error", "in_progress"]);
  await assert.rejects(integrations.startSyncRun.handler({ db }, { orgId: "org1", provider: "salesforce", trigger: "manual" }), /already running/);
});

test("stop ends the run, and the sync's own finish cannot undo it", async () => {
  const db = world([{ provider: "salesforce", startedAt: Date.now() - MIN }]);
  assert.equal((await integrations.stopSync.handler({ db }, { provider: "salesforce" })).stopped, 1);
  assert.equal((await db.get("integrations:sf"))!.lastSyncError, "Sync stopped by Ana.");
  assert.equal(await integrations.syncRunLive.handler({ db }, { syncRunId: "integrationSyncRuns:0" }), false);
  await integrations.finishSyncRun.handler({ db }, { syncRunId: "integrationSyncRuns:0", status: "success" });
  assert.equal((await db.get("integrationSyncRuns:0"))!.status, "error");
});
