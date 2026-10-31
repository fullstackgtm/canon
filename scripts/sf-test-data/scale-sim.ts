/**
 * Phase 1b integrated scale run on the simulator, no mocks between the pieces:
 * @fsgtm/sf-sim (10k accounts / 50k contacts, Bulk 2.0, CDC) -> import engine
 * -> a real local record service (DuckDB, spawned from services/record-service)
 * -> sync engine (sim CDC inbound, outbox outbound) on a 15 s wall-clock tick.
 * Convex-side plan/conflict sinks are the in-memory ones.
 *
 *   node --experimental-strip-types scripts/sf-test-data/scale-sim.ts [--accounts 10000 --contacts 50000]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSfSim } from "../../packages/sf-sim/src/index.ts";
import type { ObjectImportState, RejectedRow, SfConn } from "../../engine/src/sync/salesforceImport/contracts.ts";
import { planObjects, runImport } from "../../engine/src/sync/salesforceImport/engine.ts";
import { httpSink } from "../../engine/src/sync/salesforceImport/sinks.ts";
import { DEFAULT_POLICY, guardSfPort, runTick, salesforceRest, simCdcSource, type EnginePorts, type SyncState } from "../../engine/src/sync/salesforceSync/index.ts";
import { recordServicePort } from "../../engine/src/sync/salesforceSync/httpPorts.ts";
import { MemoryConflictSink, MemoryPlanSink } from "../../engine/src/sync/salesforceSync/testing/fakes.ts";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const N_ACC = arg("accounts", 10_000), N_CON = arg("contacts", 50_000), TICK_MS = arg("tick", 15_000);
const TOKEN = "scale-sim-token-0123456789abcdef";
const WS = "scale_sim";
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (o: unknown) => console.log(JSON.stringify(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

function startService(dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"], {
    cwd: join(import.meta.dirname, "..", "..", "services", "record-service"),
    env: { ...process.env, RECORD_SERVICE_TOKEN: TOKEN, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, BACKUP_S3_BUCKET: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => { out += d; if (out.includes("record service listening")) resolve(child); });
    child.on("exit", (c) => reject(new Error(`record service exited ${c}`)));
  });
}
/** Highest committed outbox seq (the changes route echoes `after` when nothing is newer, so page from 0). */
async function headSeq(): Promise<number> {
  let after = 0;
  for (;;) {
    const r = await rs("GET", `changes?after=${after}&limit=500`);
    if (!r.changes.length) return after;
    after = r.changes[r.changes.length - 1].seq;
  }
}
const rs = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/v1/workspaces/${WS}/${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "x-workspace-id": WS, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<any>;
};

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "fsgtm-scale-"));
  const sim = await startSfSim({ seed: 7, accounts: N_ACC, contacts: N_CON, leads: 0, opportunities: 0, cdc: true });
  const svc = await startService(dataDir);
  try {
    await rs("POST", "provision", {});
    const conn: SfConn = { instanceUrl: sim.baseUrl, apiVersion: sim.apiVersion.replace(/^v/, ""), getToken: async () => sim.token };
    const sink = httpSink({ baseUrl: BASE, token: TOKEN, ws: WS });

    const importOnce = async () => {
      const objects: ObjectImportState[] = await planObjects(conn, ["Account", "Contact"]);
      const rejected: RejectedRow[] = [];
      const t0 = Date.now();
      await runImport({ conn, sink, orgId: WS, objects, checkpoint: async (_o, r) => { rejected.push(...r); } });
      return { ms: Date.now() - t0, objects: objects.map((o) => ({ object: o.apiName, sfTotal: o.sfTotal, upserted: o.upserted, merged: o.merged, rejected: o.rejected, balanced: o.upserted + o.rejected === o.sfTotal, state: o.state })), rejectedWithoutReason: rejected.filter((r) => !r.reason).length };
    };
    const counts = async () => {
      const a = await rs("POST", "accounts/list", { limit: 1 });
      const c = await rs("POST", "contacts/list", { limit: 1 });
      return { accounts: a.total, contacts: c.total };
    };
    const first = await importOnce();
    const after1 = await counts();
    const seqAfter1 = await headSeq();
    const second = await importOnce();
    const after2 = await counts();
    const seqAfter2 = await headSeq();
    // duplicate sfIds: each sfId resolves to exactly one row
    const sample = (await rs("POST", "accounts/list", { limit: 200 })).rows.filter((r: any) => r.sfId);
    let dup = 0;
    for (const r of sample) { const m = await rs("POST", "accounts/list", { filter: { sfId: r.sfId }, limit: 5 }); if (m.total !== 1) dup++; }
    log({ step: "import", first, second, after1, after2, rerunNoop: JSON.stringify(after1) === JSON.stringify(after2) && seqAfter1 === seqAfter2, outboxSeqAfter1: seqAfter1, outboxSeqAfter2: seqAfter2, dupSfIdsInSample: dup, sampled: sample.length });

    // ---- sync latency, wall clock, 15 s tick ----
    const lastSeq = await headSeq();
    const state: SyncState = { readOnly: false, mode: "cdc", inboundCursor: { modstampByObject: {} }, outboxCursor: lastSeq };
    // Start CDC at the head so the run does not replay import-time history.
    const head = await (await fetch(`${sim.baseUrl}/sim/cdc`, { headers: { authorization: `Bearer ${sim.token}` } })).json() as any;
    state.inboundCursor.replayId = String(head.latestReplayId ?? head.replayId ?? (head.events?.length ? head.events[head.events.length - 1].replayId : 0));
    const rest = salesforceRest({ instanceUrl: sim.baseUrl, apiVersion: sim.apiVersion, getToken: async () => sim.token });
    const sf = guardSfPort(rest.port, () => state.readOnly);
    const plans = new MemoryPlanSink();
    const ports: EnginePorts = { records: recordServicePort({ baseUrl: BASE, token: TOKEN, workspaceId: WS }), sf, cdc: simCdcSource({ baseUrl: sim.baseUrl, getToken: async () => sim.token }), plans, conflicts: new MemoryConflictSink(), saveState: async () => {} };
    let stop = false; const tickWall: number[] = [];
    const loop = (async () => { while (!stop) { const t = Date.now(); const st = await runTick(ports, DEFAULT_POLICY, state); if (st.errors.length || st.outboundChanges) console.log(JSON.stringify({ tick: st })); tickWall.push(Date.now() - t); await sleep(TICK_MS); } })();

    const accts = (await rs("POST", "accounts/list", { limit: 60, sort: { field: "name", dir: "asc" } })).rows.filter((r: any) => r.sfId);
    const inbound = accts.slice(0, 20), outbound = accts.slice(20, 40);
    const inLat: number[] = [], outLat: number[] = [];
    const inPending = new Map<string, { want: number; at: number }>();
    for (let i = 0; i < 20; i++) { const want = 50_000 + i; sim.edit("Account", inbound[i].sfId, { NumberOfEmployees: want }); inPending.set(inbound[i].id, { want, at: Date.now() }); await sleep(250); }
    const outPending = new Map<string, { want: string; at: number }>();
    for (let i = 0; i < 20; i++) { const want = `Scale Industry ${i}`; await rs("POST", "records/edit", { object: "account", id: outbound[i].id, patch: { industry: want }, actorId: "scale", idempotencyKey: `scale-out-${i}`, source: "fsgtm" }); outPending.set(outbound[i].sfId, { want, at: Date.now() }); await sleep(250); }
    const deadline = Date.now() + 180_000;
    while ((inPending.size || outPending.size) && Date.now() < deadline) {
      await sleep(1000);
      for (const [id, p] of inPending) { const g = await rs("POST", "accounts/get", { id }); if (g.account.employees === p.want) { inLat.push(Date.now() - p.at); inPending.delete(id); } }
      for (const [sfId, p] of outPending) { if (sim.get("Account", sfId)?.Industry === p.want) { outLat.push(Date.now() - p.at); outPending.delete(sfId); } }
    }
    stop = true; await loop;
    log({ step: "sync", tickMs: TICK_MS, inbound: { arrived: inLat.length, missing: inPending.size, p95ms: p95(inLat) }, outbound: { arrived: outLat.length, missing: outPending.size, p95ms: p95(outLat) }, audit: plans.audit.length, auditWithPlanId: plans.audit.filter((a: any) => a.patchPlanId).length, maxTickMs: Math.max(...tickWall), simWrites: sim.writeCount() });
  } finally {
    svc.kill("SIGTERM");
    await sim.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
