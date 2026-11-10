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

test("a run in steps that keeps beating its heartbeat lives past any one action; a silent one does not", async () => {
  const db = memoryDb({
    integrations: [{ _id: "integrations:hs", orgId: "org1", provider: "hubspot", lastSyncStatus: "in_progress", isActive: true }],
    integrationSyncRuns: [
      { _id: "integrationSyncRuns:0", orgId: "org1", provider: "hubspot", trigger: "manual", status: "in_progress", startedAt: Date.now() - 40 * MIN, progress: { heartbeatAt: Date.now() - MIN } },
      { _id: "integrationSyncRuns:1", orgId: "org2", provider: "hubspot", trigger: "manual", status: "in_progress", startedAt: Date.now() - 40 * MIN, progress: { heartbeatAt: Date.now() - 20 * MIN } },
    ],
  });
  assert.equal((await integrations.endStaleSyncs.handler({ db }, {})).ended, 1);
  assert.deepEqual(db.rows("integrationSyncRuns").map((r) => r.status), ["in_progress", "error"]);
  // Live chains older than a dead run do not hide it from the sweep.
  const crowded = memoryDb({
    integrations: [],
    integrationSyncRuns: [
      ...Array.from({ length: 150 }, (_, i) => ({ _id: `integrationSyncRuns:${i}`, orgId: `live${i}`, provider: "hubspot", trigger: "manual", status: "in_progress", startedAt: Date.now() - 60 * MIN - i, progress: { heartbeatAt: Date.now() } })),
      { _id: "integrationSyncRuns:dead", orgId: "org9", provider: "hubspot", trigger: "manual", status: "in_progress", startedAt: Date.now() - 30 * MIN, progress: { heartbeatAt: Date.now() - 20 * MIN } },
    ],
  });
  assert.equal((await integrations.endStaleSyncs.handler({ db: crowded }, {})).ended, 1);
  assert.equal((await crowded.get("integrationSyncRuns:dead"))!.status, "error");
  await assert.rejects(integrations.startSyncRun.handler({ db }, { orgId: "org1", provider: "hubspot", trigger: "manual" }), /already running/);
});

test("stop ends the run, and the sync's own finish cannot undo it", async () => {
  const db = world([{ provider: "salesforce", startedAt: Date.now() - MIN }]);
  assert.equal((await integrations.stopSync.handler({ db }, { provider: "salesforce" })).stopped, 1);
  assert.equal((await db.get("integrations:sf"))!.lastSyncError, "Sync stopped by Ana.");
  assert.equal(await integrations.syncRunLive.handler({ db }, { syncRunId: "integrationSyncRuns:0" }), false);
  await integrations.finishSyncRun.handler({ db }, { syncRunId: "integrationSyncRuns:0", status: "success" });
  assert.equal((await db.get("integrationSyncRuns:0"))!.status, "error");
});

test("a sync's per-object progress never moves back to an older snapshot", async () => {
  const db = memoryDb({
    integrations: [],
    integrationSyncRuns: [{ _id: "integrationSyncRuns:0", orgId: "org1", provider: "hubspot", trigger: "manual", status: "in_progress", startedAt: Date.now() }],
  });
  const snapshot = (done: number, finished: boolean, updatedAt: number) => ({ syncRunId: "integrationSyncRuns:0", objects: [{ object: "accounts", done, finished, updatedAt }] });
  await integrations.updateRunObjects.handler({ db }, snapshot(200, true, 2000));
  await integrations.updateRunObjects.handler({ db }, snapshot(100, false, 1000));
  assert.deepEqual((await db.get("integrationSyncRuns:0"))!.objects, snapshot(200, true, 2000).objects);
});
