// Real-org end-to-end harness for the sync engine (polling mode; CDC is not
// enabled in the shared org). Uses the real Salesforce REST API for every
// Salesforce read/write, and the in-memory record store + plan sink for the
// FSGTM side (the Convex/record-service wiring is covered by tsc and the
// restart test).
//
// Safety: creates only Accounts named "FSGTMSYNC C-sync <n>" with Description
// "fsgtm-sync-test ws-c", touches only the ids it created, and deletes them
// (by id) in a finally block. The access token is read from `sf org display`
// and never printed.
//
// Run: node --experimental-strip-types engine/src/sync/salesforceSync/testing/realOrgHarness.ts
import { execFileSync } from "node:child_process";
import { guardSfPort, pollingSource, runTick, salesforceRest, type EnginePorts, type SyncPolicy, type SyncState } from "../index.ts";
import { FakeRecordStore, MemoryConflictSink, MemoryPlanSink } from "./fakes.ts";

const ORG = process.env.SF_ORG ?? "ryan.184a62440546@agentforce.com";
const N = Number(process.env.N_EDITS ?? 20);
const SOAK = Number(process.env.SOAK_TICKS ?? 100);
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
const TAG = "fsgtm-sync-test ws-c";

const display = JSON.parse(execFileSync("sf", ["org", "display", "-o", ORG, "--json"], { encoding: "utf8" })).result;
const instanceUrl: string = display.instanceUrl;
const accessToken: string = display.accessToken;
const V = "v62.0";
let apiCalls = 0;
const rest = salesforceRest({ instanceUrl, apiVersion: V, getToken: async () => accessToken, onCall: () => { apiCalls++; } });
const api = async (method: string, path: string, body?: unknown) => {
  apiCalls++;
  const res = await fetch(`${instanceUrl}/services/data/${V}${path}`, {
    method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
const log = (o: unknown) => console.log(JSON.stringify(o));

const created: string[] = [];
async function main() {
  // 1. Create tagged accounts.
  const res = await api("POST", "/composite/sobjects", {
    allOrNone: true,
    records: Array.from({ length: N }, (_, i) => ({ attributes: { type: "Account" }, Name: `FSGTMSYNC C-sync ${i}`, Description: TAG, Industry: "Software", NumberOfEmployees: 10 })),
  });
  for (const r of res) { if (!r.success) throw new Error(JSON.stringify(r.errors)); created.push(r.id); }
  log({ step: "created", count: created.length });

  const store = new FakeRecordStore();
  created.forEach((id, i) => store.seed("account", `a${i}`, id, { name: `FSGTMSYNC C-sync ${i}`, industry: "Software", employees: 10 }, Date.now()));
  const policy: SyncPolicy = { objects: [{ sf: "Account", local: "account", keyPrefix: "001", fields: [
    { sf: "Name", local: "name", authority: "newest" },
    { sf: "Industry", local: "industry", authority: "newest" },
    { sf: "NumberOfEmployees", local: "employees", authority: "newest" },
  ] }] };
  const state: SyncState = { readOnly: false, mode: "poll", inboundCursor: { modstampByObject: {} }, outboxCursor: 0 };
  const sf = guardSfPort(rest.port, () => state.readOnly);
  const plans = new MemoryPlanSink();
  const ports: EnginePorts = {
    records: store, sf, plans, conflicts: new MemoryConflictSink(),
    cdc: pollingSource({ soql: rest.soql, policy, now: () => Date.now() - 5_000 }),
    saveState: async () => {},
  };
  const tick = () => runTick(ports, policy, state);
  await tick(); // initialize poll cursor
  await sleep(1500);

  // 2. Inbound: 20 `sf data update record` edits, one every ~3 s, ticks every TICK_MS.
  const inStart = new Map<number, number>();
  const inLat: number[] = [];
  const editor = (async () => {
    for (let i = 0; i < N; i++) {
      execFileSync("sf", ["data", "update", "record", "-o", ORG, "-s", "Account", "-i", created[i], "-v", `Industry='In${i}'`, "--json"], { encoding: "utf8" });
      inStart.set(i, Date.now());
      await sleep(3000);
    }
  })();
  const deadline = Date.now() + 10 * 60_000;
  while (inLat.length < N && Date.now() < deadline) {
    await sleep(TICK_MS);
    await tick();
    for (const [i, t] of inStart) if ((await store.get("account", `a${i}`))!.fields.industry === `In${i}`) { inLat.push(Date.now() - t); inStart.delete(i); }
  }
  await editor;
  log({ step: "inbound", arrived: inLat.length, p95s: +(p95(inLat) / 1000).toFixed(1), maxS: +(Math.max(...inLat) / 1000).toFixed(1), sfWritesSoFar: sf.writes() });

  // 3. Outbound: 20 FSGTM edits.
  const outLat: number[] = [];
  const outStart = new Map<number, number>();
  const check = async () => {
    if (!outStart.size) return;
    const got = await rest.port.fetch("Account", [...outStart.keys()].map((i) => created[i]), ["NumberOfEmployees"]);
    for (const [i, t] of outStart) if (Number(got.get(created[i])?.NumberOfEmployees) === 1000 + i) { outLat.push(Date.now() - t); outStart.delete(i); }
  };
  // Edits arrive ~3 s apart; the engine ticks every TICK_MS; latency is read back from Salesforce after each tick.
  let lastTick = Date.now();
  for (let i = 0; i < N; i++) {
    store.userEdit("account", `a${i}`, { employees: 1000 + i });
    outStart.set(i, Date.now());
    await sleep(3000);
    if (Date.now() - lastTick >= TICK_MS) { await tick(); lastTick = Date.now(); await check(); }
  }
  await check();
  while (outStart.size && Date.now() < deadline + 5 * 60_000) { await sleep(TICK_MS); await tick(); await check(); }
  const audit = plans.audit;
  log({ step: "outbound", arrived: outLat.length, p95s: +(p95(outLat) / 1000).toFixed(1), sfWrites: sf.writes(), plans: plans.plans.size, audit: audit.length, auditWithPlanId: audit.filter((a) => a.patchPlanId).length });

  // 4. Echo check: the next polls see our own writes and change nothing locally.
  const editsBefore = store.edits;
  await sleep(2000); await tick();
  log({ step: "echo", localEditsFromEcho: store.edits - editsBefore });

  // 5. Read-only soak with inbound still arriving.
  state.readOnly = true;
  const writesBefore = sf.writes();
  const auditBefore = plans.audit.length;
  const inboundBefore = store.edits;
  for (let k = 0; k < SOAK; k++) {
    if (k % 10 === 0) execFileSync("sf", ["data", "update", "record", "-o", ORG, "-s", "Account", "-i", created[k % N], "-v", `Industry='RO${k}'`, "--json"], { encoding: "utf8" });
    store.userEdit("account", `a${k % N}`, { employees: 5000 + k });
    await tick();
    await sleep(300);
  }
  await sleep(2000); await tick();
  log({ step: "readOnlySoak", ticks: SOAK + 1, sfWrites: sf.writes() - writesBefore, writeAttempts: sf.writeAttempts(), newAudit: plans.audit.length - auditBefore, inboundEditsArrived: store.edits - inboundBefore });
}

try {
  await main();
} finally {
  // Cleanup: only our ids, and only if they still carry our tag.
  if (created.length) {
    const rows = await rest.soql(`SELECT Id FROM Account WHERE Id IN (${created.map((i) => `'${i}'`).join(",")}) AND Name LIKE 'FSGTMSYNC C-sync %'`);
    const ids = rows.map((r) => String(r.Id));
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const r = await api("DELETE", `/composite/sobjects?ids=${ids.slice(i, i + 200).join(",")}&allOrNone=false`);
      deleted += r.filter((x: any) => x.success).length;
    }
    const left = await rest.soql(`SELECT Id FROM Account WHERE Name LIKE 'FSGTMSYNC C-sync %'`);
    log({ step: "cleanup", created: created.length, deleted, remainingTagged: left.length, apiCalls });
  }
}
