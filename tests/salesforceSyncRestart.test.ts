// Outbound sync against the REAL record service (services/record-service,
// DuckDB) with a SIGKILL + restart mid-stream. Asserts no missed and no
// duplicated Salesforce patches. Salesforce side is the in-process fake.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_POLICY,
  recordServicePort,
  runTick,
  salesforceRest,
  type EnginePorts,
  type RecordPort,
  type SyncState,
} from "../engine/src/sync/salesforceSync/index.ts";
import { startMiniSf } from "../engine/src/sync/salesforceSync/testing/miniSf.ts";
import { MemoryConflictSink, MemoryPlanSink } from "../engine/src/sync/salesforceSync/testing/fakes.ts";

const TOKEN = "restart-test-token-0123456789";
const WS = "sfsync_restart";
const SERVICE = join(import.meta.dirname, "..", "services", "record-service");

function startService(dataDir: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/main.ts"], {
    cwd: SERVICE,
    env: { ...process.env, RECORD_SERVICE_TOKEN: TOKEN, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, BACKUP_S3_BUCKET: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => { out += d; if (out.includes("record service listening")) resolve(child); });
    child.stderr!.on("data", (d) => { err += d; });
    child.on("exit", (c) => reject(new Error(`service exited ${c}: ${out}\n${err.slice(-2000)}`)));
  });
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/v1/workspaces/${WS}/${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-workspace-id": WS, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

test("record service SIGKILL + restart mid-stream: no missed or duplicated Salesforce patches", { timeout: 120_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sfsync-rs-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let svc = await startService(dataDir, port);
  const N = 20;
  const accId = (i: number) => `001${String(i).padStart(15, "0")}`;
  const sim = await startMiniSf({
    records: { Account: Array.from({ length: N }, (_, i) => ({ Id: accId(i), Name: `FSGTMSYNC R${i}`, Industry: "Software", NumberOfEmployees: 1, BillingCountry: "US" })) },
    cdc: false,
  });
  try {
    assert.equal((await call(base, "POST", "provision", {})).status, 200);
    const up = await call(base, "POST", "accounts/upsert", {
      records: Array.from({ length: N }, (_, i) => ({ domain: `r${i}.fsgtmsync.test`, name: `FSGTMSYNC R${i}`, industry: "Software" })),
      source: "test", idempotencyKey: "seed-1",
    });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const sfIdByLocal = new Map<string, string>(up.json.ids.map((id: string, i: number) => [id, accId(i)]));
    const ids: string[] = up.json.ids;

    // Record-service 1.1.0 has no sfId column yet (workstream A adds it): inject the mapping.
    const inner = recordServicePort({ baseUrl: base, token: TOKEN, workspaceId: WS });
    const records: RecordPort = { ...inner, get: async (o, id) => { const r = await inner.get(o, id); return r && { ...r, sfId: sfIdByLocal.get(id) }; } };
    const rest = salesforceRest({ instanceUrl: sim.baseUrl, getToken: async () => sim.token() });
    let patches = 0;
    const perRecordPatches = new Map<string, number>();
    const sf = { fetch: rest.port.fetch, patch: async (o: string, id: string, f: Record<string, unknown>) => { await rest.port.patch(o, id, f); patches++; perRecordPatches.set(id, (perRecordPatches.get(id) ?? 0) + 1); } };
    const plans = new MemoryPlanSink();
    // Persisted state is what saveState wrote last (as Convex would hold it).
    let persisted: SyncState = { readOnly: false, mode: "poll", inboundCursor: { modstampByObject: {} }, outboxCursor: 0 };
    const ports: EnginePorts = {
      records, sf, plans, conflicts: new MemoryConflictSink(),
      cdc: { kind: "poll", next: async (c) => ({ events: [], cursor: c }) },
      saveState: async (s) => { persisted = structuredClone(s); },
    };
    // Start after the seed upserts (Convex would start the cursor at the import's lastSeq).
    persisted.outboxCursor = (await call(base, "GET", "changes?after=0&limit=500")).json.lastSeq;
    const tick = async () => { const st = structuredClone(persisted); await runTick(ports, DEFAULT_POLICY, st, { outboxBatchSize: 7 }); };

    const expected = new Map<string, string>();
    const editRound = async (round: number) => {
      for (let i = 0; i < N; i++) {
        const value = `Ind-${round}-${i}`;
        const r = await call(base, "POST", "records/edit", { object: "account", id: ids[i], patch: { industry: value }, actorId: "u1", idempotencyKey: `e-${round}-${i}` });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        expected.set(accId(i), value);
      }
    };

    await editRound(1);
    await tick();
    await editRound(2);
    // Kill mid-stream: a tick is in flight when the service dies.
    const inflight = tick().catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    svc.kill("SIGKILL");
    await new Promise((r) => svc.once("exit", r));
    const err = await inflight;
    console.log(`in-flight tick after SIGKILL: ${err instanceof Error ? "failed (" + err.message.slice(0, 60) + ")" : "completed"}`);
    const seqBeforeRestart = persisted.outboxCursor;
    svc = await startService(dataDir, port);
    await editRound(3);
    const after = await call(base, "GET", `changes?after=0&limit=500`);
    const seqs = after.json.changes.map((c: any) => c.seq);
    assert.equal(new Set(seqs).size, seqs.length, "outbox seq reused after restart");
    for (let i = 0; i < 10; i++) await tick();

    let missed = 0;
    for (let i = 0; i < N; i++) if (sim.get("Account", accId(i))!.Industry !== expected.get(accId(i))) missed++;
    const keys = [...plans.plans.keys()];
    const applied = [...plans.plans.values()].filter((p) => p.status === "applied").length;
    console.log(`restart: cursorBeforeRestart=${seqBeforeRestart} final=${persisted.outboxCursor} patches=${patches} plansApplied=${applied} audit=${plans.audit.length} missed=${missed}`);
    assert.equal(missed, 0, "missed patches");
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(patches, applied, "a plan was patched more than once");
    assert.equal(plans.audit.length, applied);
  } finally {
    svc.kill("SIGKILL");
    await sim.stop();
  }
});

test("the engine's record-service port reads a contact through contacts/get", { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sfsync-rs-contact-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const svc = await startService(dataDir, port);
  try {
    assert.equal((await call(base, "POST", "provision", {})).status, 200);
    assert.equal((await call(base, "POST", "accounts/upsert", { records: [{ domain: "c.fsgtmsync.test", name: "C" }], source: "test", idempotencyKey: "a" })).status, 200);
    const up = await call(base, "POST", "contacts/upsert", { records: [{ accountDomain: "c.fsgtmsync.test", fullName: "Ada Lovelace", email: "ada@c.fsgtmsync.test" }], source: "test", idempotencyKey: "c" });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const records = recordServicePort({ baseUrl: base, token: TOKEN, workspaceId: WS });
    const contact = await records.get("contact", up.json.ids[0]);
    assert.deepEqual([contact?.id, contact?.fields.fullName, contact?.fields.email], [up.json.ids[0], "Ada Lovelace", "ada@c.fsgtmsync.test"]);
    assert.equal(await records.get("contact", "con_missing"), null);
  } finally {
    svc.kill("SIGKILL");
  }
});
