import { test } from "node:test";
import assert from "node:assert/strict";
import type { ObjectImportState, RejectedRow, SfConn } from "../contracts.ts";
import { idempotencyKeyFor, planObjects, runImport } from "../engine.ts";
import { memorySink } from "../sinks.ts";
import { generateDataset, startFakeSalesforce, type FakeSalesforce } from "../testing/fakeSalesforce.ts";

function connFor(sim: FakeSalesforce): SfConn {
  return { instanceUrl: sim.baseUrl, apiVersion: "60.0", getToken: async () => sim.token, refreshToken: async () => sim.token };
}

async function importAll(sim: FakeSalesforce, sink: ReturnType<typeof memorySink>, opts: { deadlineEvery?: number; objects?: string[] } = {}) {
  const conn = connFor(sim);
  const objects = await planObjects(conn, opts.objects);
  const rejected: RejectedRow[] = [];
  let runs = 0;
  // Resumable: each run stops at a deadline; the next run picks up from the
  // persisted states, as the Convex action chain does.
  for (;;) {
    runs++;
    let budget = opts.deadlineEvery ?? Infinity;
    const persisted: ObjectImportState[] = structuredClone(objects);
    const { done } = await runImport({
      conn, sink, orgId: "org1", objects: persisted,
      checkpoint: async (objs, rej) => { rejected.push(...rej); budget--; },
      now: () => (budget <= 0 ? 1 : 0),
      deadlineAt: opts.deadlineEvery ? 1 : undefined,
    });
    objects.splice(0, objects.length, ...persisted);
    if (done && objects.every((o) => o.state === "done" || o.state === "failed")) break;
    if (runs > 500) throw new Error("no progress");
  }
  return { objects, rejected, runs };
}

test("10k accounts / 50k contacts: every row upserted or rejected with a reason; rerun is a no-op; TAM merges", { timeout: 300_000 }, async () => {
  const ds = generateDataset({ seed: 7, accounts: 10_000, contacts: 50_000, leads: 2_000, custom: 3_000, tamOverlap: 500 });
  const sim = await startFakeSalesforce(ds);
  try {
    const sink = memorySink({ accounts: ds.tamDomains.map((d) => ({ domain: d, name: `TAM ${d}` })), source: "pdl" });
    const tamIds = new Set(sink.accounts.keys());
    assert.ok(tamIds.size >= 400, `tam seeded: ${tamIds.size}`);

    const t0 = Date.now();
    const first = await importAll(sim, sink, { deadlineEvery: 3 });
    const ms = Date.now() - t0;
    assert.ok(first.runs > 3, "import resumed across several runs");
    for (const o of first.objects) {
      const src = ds.objects.get(o.apiName)!.rows.length;
      assert.equal(o.state, "done", `${o.apiName} ${o.error ?? ""}`);
      assert.equal(o.sfTotal, src, `${o.apiName} sfTotal`);
      assert.equal(o.seen, src, `${o.apiName} seen`);
      assert.equal(o.upserted + o.rejected, src, `${o.apiName}: upserted ${o.upserted} + rejected ${o.rejected} != ${src}`);
    }
    assert.equal(first.rejected.length, first.objects.reduce((n, o) => n + o.rejected, 0));
    for (const r of first.rejected) assert.ok(r.reason && r.reason.length > 5, `reason for ${r.sfId}`);
    const acct = first.objects.find((o) => o.apiName === "Account")!;
    assert.ok(acct.rejected >= ds.expect.accountsNoWebsite, "no-website accounts rejected");
    assert.ok(first.rejected.some((r) => /duplicate domain/.test(r.reason)), "duplicate-domain accounts rejected with reason");

    // Seeded TAM domains were merged, not duplicated: same record ids now carry sfId.
    const tamMerged = [...tamIds].filter((id) => sink.accounts.get(id)!.sfId);
    assert.equal(tamMerged.length, tamIds.size, "every TAM account matched by domain got its sfId");
    assert.ok(acct.merged >= tamIds.size);
    const domains = new Set([...sink.accounts.values()].map((a) => a.domain));
    assert.equal(domains.size, sink.accounts.size, "one account per domain");

    // Custom object rows landed with typed fields; the address field was skipped.
    const proj = sink.custom.get("Project__c")!;
    assert.equal(proj.size, 3_000);
    const anyRow = [...proj.values()][1];
    assert.equal(typeof anyRow.fields.Budget__c, "number");
    assert.ok(!("BillingAddress__c" in anyRow.fields));

    const totals = { a: sink.accounts.size, c: sink.contacts.size, p: proj.size };
    assert.equal(sink.duplicateSfIds(), 0);

    // Rerun: new bulk jobs, same data -> totals unchanged, no duplicate sfIds, nothing created.
    const second = await importAll(sim, sink);
    assert.deepEqual({ a: sink.accounts.size, c: sink.contacts.size, p: sink.custom.get("Project__c")!.size }, totals);
    assert.equal(sink.duplicateSfIds(), 0);
    for (const o of second.objects) {
      const f = first.objects.find((x) => x.apiName === o.apiName)!;
      assert.equal(o.upserted, f.upserted, `${o.apiName} upserted stable`);
      assert.equal(o.rejected, f.rejected, `${o.apiName} rejected stable`);
    }
    console.log(JSON.stringify({ ms, runs: first.runs, objects: first.objects.map(({ apiName, sfTotal, upserted, merged, rejected }) => ({ apiName, sfTotal, upserted, merged, rejected })), totals, sim: sim.calls }));
  } finally {
    await sim.stop();
  }
});

test("replaying a chunk with the same idempotency key is a no-op (crash between upsert and checkpoint)", async () => {
  const ds = generateDataset({ seed: 3, accounts: 1200, contacts: 0 });
  const sim = await startFakeSalesforce(ds);
  try {
    const sink = memorySink();
    const conn = connFor(sim);
    const objects = await planObjects(conn, ["Account"]);
    // Crash after the first chunk's upsert, before its checkpoint lands.
    const saved: ObjectImportState[] = structuredClone(objects);
    let n = 0;
    await assert.rejects(runImport({
      conn, sink, orgId: "o", objects, chunkSize: 500,
      checkpoint: async (objs) => { if (++n === 2) throw new Error("crash"); Object.assign(saved, structuredClone(objs)); },
    }));
    assert.equal(saved[0].chunksDone, 0);
    const before = sink.calls.replays;
    await runImport({ conn, sink, orgId: "o", objects: saved, chunkSize: 500, checkpoint: async () => {} });
    assert.equal(sink.calls.replays, before + 1, "first chunk replayed by idempotency key");
    assert.equal(saved[0].upserted + saved[0].rejected, 1200);
    assert.equal(sink.duplicateSfIds(), 0);
    assert.equal(idempotencyKeyFor("o", "Account", saved[0].bulkJobId!, 0), `sf-import:o:Account:${saved[0].bulkJobId}:0`);
  } finally {
    await sim.stop();
  }
});

test("401 mid-import refreshes the token and continues", async () => {
  const ds = generateDataset({ seed: 5, accounts: 300, contacts: 600 });
  const sim = await startFakeSalesforce(ds);
  try {
    const sink = memorySink();
    const conn = connFor(sim);
    const objects = await planObjects(conn, ["Account", "Contact"]);
    let stale = sim.token;
    const c2: SfConn = { ...conn, getToken: async () => stale, refreshToken: async () => (stale = sim.token) };
    let k = 0;
    await runImport({ conn: c2, sink, orgId: "o", objects, chunkSize: 100, checkpoint: async () => { if (++k === 3) sim.expireToken(); } });
    assert.ok(sim.calls.unauthorized >= 1);
    for (const o of objects) assert.equal(o.state, "done");
    assert.equal(objects[1].upserted + objects[1].rejected, 600);
  } finally {
    await sim.stop();
  }
});
