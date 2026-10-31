import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POLICY,
  guardSfPort,
  pollingSource,
  runTick,
  salesforceRest,
  simCdcSource,
  type EnginePorts,
  type SyncPolicy,
  type SyncState,
} from "../engine/src/sync/salesforceSync/index.ts";
import { startMiniSf } from "../engine/src/sync/salesforceSync/testing/miniSf.ts";
import { FakeRecordStore, MemoryConflictSink, MemoryPlanSink } from "../engine/src/sync/salesforceSync/testing/fakes.ts";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const accId = (i: number) => `001${String(i).padStart(15, "0")}`;
const conId = (i: number) => `003${String(i).padStart(15, "0")}`;

async function setup(o: { accounts?: number; contacts?: number; mode?: "cdc" | "poll"; policy?: SyncPolicy; readOnly?: boolean } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const nA = o.accounts ?? 20;
  const nC = o.contacts ?? 0;
  const accounts = Array.from({ length: nA }, (_, i) => ({ Id: accId(i), Name: `FSGTMSYNC Acct ${i}`, Industry: "Software", NumberOfEmployees: 10 + i, BillingCountry: "US", SystemModstamp: T0 - 60_000 }));
  const contacts = Array.from({ length: nC }, (_, i) => ({ Id: conId(i), Title: "VP", Email: `c${i}@example.com`, SystemModstamp: T0 - 60_000 }));
  const sim = await startMiniSf({ now, records: { Account: accounts, Contact: contacts } });
  const store = new FakeRecordStore(now);
  for (let i = 0; i < nA; i++) store.seed("account", `a${i}`, accId(i), { name: `FSGTMSYNC Acct ${i}`, industry: "Software", employees: 10 + i, country: "US" }, T0 - 60_000);
  for (let i = 0; i < nC; i++) store.seed("contact", `c${i}`, conId(i), { title: "VP", email: `c${i}@example.com` }, T0 - 60_000);
  const policy = o.policy ?? DEFAULT_POLICY;
  const state: SyncState = { readOnly: o.readOnly ?? false, mode: o.mode ?? "cdc", inboundCursor: { modstampByObject: {} }, outboxCursor: 0 };
  const rest = salesforceRest({ instanceUrl: sim.baseUrl, getToken: async () => sim.token() });
  const sf = guardSfPort(rest.port, () => state.readOnly);
  const plans = new MemoryPlanSink(now);
  const conflicts = new MemoryConflictSink();
  const saved: SyncState[] = [];
  const cdc = state.mode === "cdc"
    ? simCdcSource({ baseUrl: sim.baseUrl, getToken: async () => sim.token() })
    : pollingSource({ soql: rest.soql, policy, now });
  const ports: EnginePorts = { records: store, sf, cdc, plans, conflicts, now, saveState: async (s) => { saved.push(structuredClone(s)); } };
  const tick = () => runTick(ports, policy, state);
  return { clock, sim, store, state, sf, plans, conflicts, ports, policy, tick, saved };
}

const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

test("inbound: a Salesforce edit lands with source salesforce and is not echoed back", async () => {
  const h = await setup();
  try {
    h.clock.t += 1000;
    h.sim.edit("Account", accId(3), { Industry: "Fintech" });
    const s = await h.tick();
    assert.equal(s.inboundEdits, 1);
    assert.equal((await h.store.get("account", "a3"))!.fields.industry, "Fintech");
    const last = h.store.outbox.at(-1)!;
    assert.equal(last.origin, "salesforce");
    assert.equal(s.skippedEcho, 1);
    assert.equal(h.sim.writeCount(), 0);
    assert.equal(h.plans.plans.size, 0);
  } finally { await h.sim.stop(); }
});

test("outbound: an FSGTM edit becomes a patch plan, a Salesforce PATCH and an audit row; the CDC echo is a no-op", async () => {
  const h = await setup();
  try {
    h.clock.t += 1000;
    h.store.userEdit("account", "a5", { name: "FSGTMSYNC Renamed" });
    const s1 = await h.tick();
    assert.equal(s1.outboundPatches, 1);
    assert.equal(h.sim.get("Account", accId(5))!.Name, "FSGTMSYNC Renamed");
    assert.equal(h.plans.audit.length, 1);
    assert.ok(h.plans.audit.every((a) => a.patchPlanId && a.status === "applied"));
    const edits = h.store.edits;
    h.clock.t += 15_000;
    const s2 = await h.tick();
    assert.equal(s2.inboundEvents, 1); // the echo arrives
    assert.equal(h.store.edits, edits); // and changes nothing
    assert.equal(h.sim.writeCount(), 1);
  } finally { await h.sim.stop(); }
});

test("newest: simultaneous edits converge on the later timestamp, both orders", async () => {
  const h = await setup();
  try {
    // FSGTM first, Salesforce later: Salesforce wins.
    h.clock.t += 1000;
    h.store.userEdit("account", "a1", { industry: "FromFSGTM" });
    h.clock.t += 500;
    h.sim.edit("Account", accId(1), { Industry: "FromSF" });
    // Salesforce first, FSGTM later: FSGTM wins.
    h.clock.t += 1000;
    h.sim.edit("Account", accId(2), { Industry: "FromSF" });
    h.clock.t += 500;
    h.store.userEdit("account", "a2", { industry: "FromFSGTM" });
    await h.tick();
    h.clock.t += 15_000;
    await h.tick();
    assert.equal((await h.store.get("account", "a1"))!.fields.industry, "FromSF");
    assert.equal(h.sim.get("Account", accId(1))!.Industry, "FromSF");
    assert.equal((await h.store.get("account", "a2"))!.fields.industry, "FromFSGTM");
    assert.equal(h.sim.get("Account", accId(2))!.Industry, "FromFSGTM");
    assert.equal(h.conflicts.list().length, 0);
  } finally { await h.sim.stop(); }
});

test("review: differing values open a conflict and write nothing; fsgtm/salesforce authorities hold", async () => {
  const policy: SyncPolicy = {
    objects: [{ sf: "Account", local: "account", keyPrefix: "001", fields: [
      { sf: "Industry", local: "industry", authority: "review" },
      { sf: "Name", local: "name", authority: "fsgtm" },
      { sf: "BillingCountry", local: "country", authority: "salesforce" },
    ] }],
  };
  const h = await setup({ policy });
  try {
    h.clock.t += 1000;
    h.sim.edit("Account", accId(0), { Industry: "SF-Ind", Name: "SF name", BillingCountry: "DE" });
    h.store.userEdit("account", "a1", { industry: "FS-Ind", name: "FSGTMSYNC FS name", country: "FR" });
    await h.tick();
    const c = h.conflicts.list().sort((a, b) => a.recordId.localeCompare(b.recordId));
    assert.equal(c.length, 2);
    assert.deepEqual(c.map((x) => [x.recordId, x.field, x.fsgtmValue, x.sfValue]), [["a0", "industry", "Software", "SF-Ind"], ["a1", "industry", "FS-Ind", "Software"]]);
    const a0 = (await h.store.get("account", "a0"))!.fields;
    assert.equal(a0.industry, "Software"); // review: untouched
    assert.equal(a0.name, "FSGTMSYNC Acct 0"); // fsgtm authority: inbound skipped
    assert.equal(a0.country, "DE"); // salesforce authority: inbound applied
    const s1 = h.sim.get("Account", accId(1))!;
    assert.equal(s1.Name, "FSGTMSYNC FS name"); // fsgtm authority: outbound applied
    assert.equal(s1.BillingCountry, "US"); // salesforce authority: outbound skipped
    assert.equal(s1.Industry, "Software"); // review: untouched
  } finally { await h.sim.stop(); }
});

test("crash between Salesforce PATCH and cursor save replays without a duplicate patch", async () => {
  const h = await setup();
  try {
    h.clock.t += 1000;
    h.store.userEdit("account", "a7", { employees: 777 });
    let calls = 0;
    const real = h.ports.saveState;
    h.ports.saveState = async (s) => { if (s.outboxCursor > 0 && calls++ === 0) throw new Error("crash before cursor save"); return real(s); };
    await assert.rejects(h.tick(), /crash/);
    h.state.outboxCursor = 0; // the saved state never advanced
    assert.equal(h.sim.writeCount(), 1);
    await h.tick();
    assert.equal(h.sim.writeCount(), 1, "replay must not PATCH again");
    assert.equal(h.plans.plans.size, 1);
    assert.equal(h.plans.audit.length, 1);
  } finally { await h.sim.stop(); }
});

test("token refresh: a 401 retries once with a forced refresh", async () => {
  const h = await setup();
  try {
    let forced = 0;
    let cached = h.sim.token();
    const rest = salesforceRest({ instanceUrl: h.sim.baseUrl, getToken: async (force) => { if (force) { forced++; cached = h.sim.token(); } return cached; } });
    h.sim.rotateToken();
    const got = await rest.port.fetch("Account", [accId(0)], ["Name"]);
    assert.equal(got.get(accId(0))!.Name, "FSGTMSYNC Acct 0");
    assert.equal(forced, 1);
  } finally { await h.sim.stop(); }
});

test("polling fallback: SystemModstamp cursor picks up edits, full pages with ties re-read instead of skipping", async () => {
  const h = await setup({ mode: "poll", accounts: 450 });
  try {
    await h.tick(); // initializes cursors at now
    h.clock.t += 2000;
    for (let i = 0; i < 450; i++) h.sim.edit("Account", accId(i), { Industry: `P${i}` });
    h.clock.t += 15_000;
    await h.tick();
    for (let i = 0; i < 450; i++) assert.equal((await h.store.get("account", `a${i}`))!.fields.industry, `P${i}`, `a${i}`);
    assert.equal(h.sim.writeCount(), 0);
  } finally { await h.sim.stop(); }
});

test("read-only soak: 400 ticks (two passes over every account) with inbound and local edits produce zero Salesforce writes", async () => {
  const h = await setup({ accounts: 200, readOnly: true });
  try {
    const inboundBefore = h.store.edits;
    for (let i = 0; i < 400; i++) {
      h.clock.t += 15_000;
      h.sim.edit("Account", accId(i % 200), { Industry: `RO${i}` });
      h.store.userEdit("account", `a${(i * 7) % 200}`, { name: `FSGTMSYNC RO ${i}` });
      await h.tick();
    }
    assert.equal(h.sim.writeCount(), 0);
    assert.equal(h.sf.writeAttempts(), 0);
    assert.equal(h.plans.audit.length, 0);
    assert.equal(h.store.edits - inboundBefore, 400, "every inbound edit arrived");
    assert.equal(h.state.outboxCursor, 0, "outbox held while read-only");
    // Flip read-only off: the held outbox drains.
    h.state.readOnly = false;
    await h.tick();
    assert.ok(h.sim.writeCount() > 0);
      } finally { await h.sim.stop(); }
});

test("latency harness at 10k accounts / 50k contacts: 20 edits each direction, p95 < 60 s with a 15 s tick", async () => {
  const h = await setup({ accounts: 10_000, contacts: 50_000 });
  try {
    const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
    const inboundAt = new Map<number, number>();
    const outboundAt = new Map<number, number>();
    const schedule: Array<{ at: number; dir: "in" | "out"; i: number }> = [];
    for (let i = 0; i < 20; i++) schedule.push({ at: T0 + Math.floor(rnd() * 300_000), dir: "in", i });
    for (let i = 0; i < 20; i++) schedule.push({ at: T0 + Math.floor(rnd() * 300_000), dir: "out", i });
    schedule.sort((a, b) => a.at - b.at);
    const inLat: number[] = [];
    const outLat: number[] = [];
    const wallMs: number[] = [];
    let next = T0 + 15_000;
    let k = 0;
    while (inLat.length < 20 || outLat.length < 20) {
      while (k < schedule.length && schedule[k].at <= next) {
        const e = schedule[k++];
        h.clock.t = e.at;
        if (e.dir === "in") { h.sim.edit("Contact", conId(e.i * 2500), { Title: `Lat${e.i}` }); inboundAt.set(e.i, e.at); }
        else { h.store.userEdit("account", `a${e.i * 500}`, { industry: `Lat${e.i}` }); outboundAt.set(e.i, e.at); }
      }
      h.clock.t = next;
      const w0 = performance.now();
      await h.tick();
      const w = performance.now() - w0;
      wallMs.push(w);
      for (const [i, at] of inboundAt) if ((await h.store.get("contact", `c${i * 2500}`))!.fields.title === `Lat${i}`) { inLat.push(next - at + w); inboundAt.delete(i); }
      for (const [i, at] of outboundAt) if (h.sim.get("Account", accId(i * 500))!.Industry === `Lat${i}`) { outLat.push(next - at + w); outboundAt.delete(i); }
      next += 15_000;
      assert.ok(next < T0 + 3_600_000, "edits never arrived");
    }
    const audit = h.plans.audit;
    console.log(`latency: inbound p95=${(p95(inLat) / 1000).toFixed(2)}s outbound p95=${(p95(outLat) / 1000).toFixed(2)}s maxTickWall=${Math.max(...wallMs).toFixed(0)}ms audit=${audit.length} withPlanId=${audit.filter((a) => a.patchPlanId).length}`);
    assert.ok(p95(inLat) < 60_000);
    assert.ok(p95(outLat) < 60_000);
    assert.equal(audit.length, 20);
    assert.ok(audit.every((a) => a.patchPlanId.startsWith("pp_")));
  } finally { await h.sim.stop(); }
});
