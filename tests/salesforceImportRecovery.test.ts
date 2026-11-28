import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { runImport } from "../engine/src/sync/salesforceImport/engine.ts";
import { memorySink } from "../engine/src/sync/salesforceImport/sinks.ts";
import type { ObjectImportState } from "../engine/src/sync/salesforceImport/contracts.ts";

test("a pending bulk query yields at the slice deadline and resumes the stored job", async () => {
  let time = 0, creates = 0, complete = false;
  const objects: ObjectImportState[] = [{ apiName: "Account", sfTotal: 0, upserted: 0, merged: 0, rejected: 0, state: "pending" }];
  const conn = { instanceUrl: "https://fake.test", apiVersion: "60.0", getToken: async () => "fake",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { creates++; return Response.json({ id: "bulk1" }); }
      if (url.includes("/results")) return new Response("Id,Name,Website\n", { headers: { "Sforce-Locator": "null" } });
      time += 100;
      if (time > 200 && !complete) throw new Error("fake action limit");
      return Response.json({ state: complete ? "JobComplete" : "InProgress" });
    },
  };
  const opts = { conn, objects, orgId: "org", sink: memorySink(), now: () => time, deadlineAt: 50, checkpoint: async () => {} };
  assert.equal((await runImport(opts)).done, false);
  assert.equal(objects[0].bulkJobId, "bulk1");
  assert.equal(objects[0].state, "running");
  complete = true;
  assert.equal((await runImport({ ...opts, deadlineAt: 1000 })).done, true);
  assert.equal(creates, 1);
});

test("createJob replaces silent imports but refuses recent queued or heartbeating jobs", async () => {
  const m = loadConvex(["salesforceImport.ts"])["salesforceImport.ts"];
  for (const status of ["queued", "running"]) {
    const db = memoryDb({ sfImportJobs: [{ _id: "old", orgId: "org", status, objects: [], rejectedSample: [], startedAt: Date.now() - 60 * 60_000, heartbeatAt: Date.now() }] });
    await assert.rejects(m.createJob.handler({ db }, { orgId: "org" }));
    await db.patch("old", { heartbeatAt: Date.now() - 60 * 60_000 });
    await m.createJob.handler({ db }, { orgId: "org" });
    assert.equal((await db.get("old"))!.status, "failed");
    await assert.rejects(m.createJob.handler({ db }, { orgId: "org" }));
  }
});

test("an action failure saves the objects mutated during its slice", async () => {
  const m = loadConvex(["salesforceImport.ts"], {
    "../engine/src/sync/salesforceImport/engine.ts": real => ({ ...real, planObjects: async () => [{ apiName: "Account", state: "running", seen: 0 }], runImport: async (opts: { objects: ObjectImportState[] }) => { opts.objects[0].seen = 3; throw new Error("checkpoint transport failed"); } }),
  })["salesforceImport.ts"];
  const original: unknown[] = [];
  let saved: any;
  const ctx = {
    runQuery: async () => ({ orgId: "org", status: "running", objects: structuredClone(original) }),
    runAction: async () => ({ accessToken: "fake", instanceUrl: "https://fake.test" }),
    runMutation: async (_fn: unknown, args: unknown) => { saved = args; },
  };
  await m.run.handler(ctx, { jobId: "job" });
  assert.equal(saved.objects[0]?.seen, 3);
});

test("sync stats retain rejected record diagnostics after later clean ticks", async () => {
  const m = loadConvex(["salesforceSync.ts"])["salesforceSync.ts"];
  const db = memoryDb({ sfSyncState: [{ _id: "state", orgId: "org" }] });
  await m.releaseTick.handler({ db }, { orgId: "org", stats: { errors: ["ledger refused account a0 (Salesforce 001X): deleted stream"] } });
  await m.releaseTick.handler({ db }, { orgId: "org", stats: { errors: [] } });
  assert.equal(((await db.get("state"))!.lastStats as { errors: string[] }).errors.length, 1);
});

test("a missing ledger stream returns a record rejection for inbound sync", async () => {
  const m = loadConvex(["canon.ts"])["canon.ts"];
  const out = await m.saveSyncedRecordPatch.handler({ db: memoryDb({}) }, {
    orgId: "org", object: "account", streamId: "gone", recordId: "a0", sfId: "001X",
    patch: { industry: "Fintech" }, at: 1, idempotencyKey: "missing",
  });
  assert.equal(out.status, "invalid");
  assert.equal(out.rejected.length, 1);
});

test("a bulk status request that hangs yields when its slice timeout aborts it", async () => {
  const objects: ObjectImportState[] = [{ apiName: "Account", sfTotal: 0, upserted: 0, merged: 0, rejected: 0, state: "running", bulkJobId: "bulk1" }];
  const conn = { instanceUrl: "https://fake.test", apiVersion: "60.0", getToken: async () => "fake",
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  // Keep the event loop alive as a real network request would; AbortSignal.timeout is unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await runImport({ conn, objects, orgId: "org", sink: memorySink(), deadlineAt: Date.now() + 100, checkpoint: async () => {} })).done, false);
    assert.equal(objects[0].state, "running");
  } finally { clearTimeout(keepAlive); }
});
