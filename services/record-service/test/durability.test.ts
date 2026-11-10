// Kill the real server process mid-write (SIGKILL: no shutdown hooks run),
// restart it on the same data dir, and assert every acknowledged write survived.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
import { client, fixtureAccounts, tempDir, TOKEN } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function startServer(dataDir: string): Promise<{ proc: ChildProcess; base: string; exited: Promise<number | null> }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { ...process.env, RECORD_SERVICE_TOKEN: TOKEN, DATA_DIR: dataDir, PORT: "0", HOST: "127.0.0.1", CHECKPOINT_INTERVAL_MS: "3600000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += d;
      const m = /"port":(\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    proc.on("exit", (c) => reject(new Error(`server exited early (${c}): ${buf}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}`, exited };
}

describe("durability", () => {
  it("loses no acknowledged write when the process is SIGKILLed mid-write", async () => {
    const dataDir = tempDir("rs-crash-");
    const s1 = await startServer(dataDir);
    const ws = client(s1.base).ws("crash");
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", { records: fixtureAccounts(200), source: "t", idempotencyKey: "seed" });
    const ids: string[] = up.json.ids;

    // Fire a stream of edits and upserts; kill the process while they are in flight.
    const acked = new Map<string, string>(); // accountId -> ownerId that was acknowledged
    const ackedUpserts: string[] = [];
    let n = 0;
    let killed = false;
    const writers = Array.from({ length: 16 }, async (_, w) => {
      while (!killed) {
        const i = n++;
        try {
          if (i % 5 === 0) {
            const rec = { domain: `crash-${i}.example.com`, name: `Crash ${i}` };
            const r = await ws.post("accounts/upsert", { records: [rec], source: "t", idempotencyKey: `cu${i}` });
            if (r.status === 200) ackedUpserts.push(r.json.ids[0]);
          } else {
            const id = ids[i % ids.length];
            const owner = `w${w}-i${i}`;
            const r = await ws.post("records/edit", { object: "account", id, patch: { ownerId: owner }, actorId: "t", idempotencyKey: `ce${i}` });
            // Writes to the same id are serialized by the single writer, so the last ack per id is what must persist.
            if (r.status === 200) acked.set(id, `${r.json.version}:${owner}`);
          }
        } catch {
          // connection reset by the kill
        }
      }
    });
    // Kill once enough writes are acknowledged, not after a fixed delay: a slow
    // CI runner acked only 14 edits in 600 ms. Writers are still in flight here.
    const deadline = Date.now() + 30_000;
    while (acked.size <= 40 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    s1.proc.kill("SIGKILL");
    killed = true;
    await Promise.allSettled(writers);
    await s1.exited;
    assert.ok(acked.size > 20, `expected acknowledged writes before the kill, got ${acked.size}`);

    const s2 = await startServer(dataDir);
    try {
      const ws2 = client(s2.base).ws("crash");
      let lost = 0;
      for (const [id, vo] of acked) {
        const [version, owner] = vo.split(/:(.*)/s);
        const g = await ws2.post("accounts/get", { id });
        if (g.status !== 200) throw new Error(JSON.stringify(g));
        // A later, unacknowledged edit may also have committed, so the stored version is >= the acked one.
        if (g.json.account.version < Number(version) || (g.json.account.version === Number(version) && g.json.account.ownerId !== owner)) lost++;
      }
      for (const id of ackedUpserts) if ((await ws2.post("accounts/get", { id })).status !== 200) lost++;
      assert.equal(lost, 0, `lost ${lost} of ${acked.size + ackedUpserts.length} acknowledged writes`);
      // The outbox is still gap-free in order and covers every acknowledged edit.
      const ch = await ws2.get("changes?after=0&limit=500");
      const seqs = ch.json.changes.map((c: { seq: number }) => c.seq);
      assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
    } finally {
      s2.proc.kill("SIGTERM");
      assert.equal(await s2.exited, 0, "graceful SIGTERM exits 0");
    }
  });

  it("never reuses an outbox seq after SIGKILL (high-water mark survives the crash)", async () => {
    const dataDir = tempDir("rs-seq-");
    const seen = new Map<number, string>(); // seq -> "object:id:op" observed before the crash
    for (let round = 0; round < 3; round++) {
      const s = await startServer(dataDir);
      const ws = client(s.base).ws("seq");
      try {
        if (round === 0) await ws.post("provision");
        // Commit some writes (WAL only: the checkpoint interval is 1h), read the outbox, then crash.
        const up = await ws.post("accounts/upsert", { records: fixtureAccounts(25, round), source: "t", idempotencyKey: `s${round}` });
        assert.equal(up.status, 200, JSON.stringify(up.json));
        for (let i = 0; i < 10; i++) {
          const r = await ws.post("records/edit", { object: "account", id: up.json.ids[i], patch: { ownerId: `r${round}-${i}` }, actorId: "t", idempotencyKey: `se${round}-${i}` });
          assert.equal(r.status, 200);
        }
        let after = 0;
        const ch: Array<{ seq: number; object: string; id: string; op: string }> = [];
        for (;;) {
          const r = await ws.get(`changes?after=${after}&limit=500`);
          if (!r.json.changes.length) break;
          ch.push(...r.json.changes);
          after = r.json.lastSeq;
        }
        const maxBefore = Math.max(0, ...seen.keys());
        for (const c of ch) {
          const tag = `${c.object}:${c.id}:${c.op}`;
          if (seen.has(c.seq)) assert.equal(tag, seen.get(c.seq), `seq ${c.seq} was reused for a different change`);
          else assert.ok(c.seq > maxBefore, `new seq ${c.seq} must be above the pre-crash high-water mark ${maxBefore}`);
          seen.set(c.seq, tag);
        }
        assert.equal(ch.length, 35 * (round + 1), "every committed change is still in the outbox");
      } finally {
        s.proc.kill("SIGKILL");
        await s.exited;
      }
    }
  });

  it("SIGTERM drains queued writes before exiting", async () => {
    const dataDir = tempDir("rs-term-");
    const s1 = await startServer(dataDir);
    const ws = client(s1.base).ws("term");
    await ws.post("provision");
    const pending = Array.from({ length: 50 }, (_, i) =>
      ws.post("accounts/upsert", { records: fixtureAccounts(20, i), source: "t", idempotencyKey: `t${i}` }).catch(() => ({ status: 0 })));
    await new Promise((r) => setTimeout(r, 30));
    s1.proc.kill("SIGTERM");
    const results = await Promise.all(pending);
    assert.equal(await s1.exited, 0);
    const ok = results.filter((r) => r.status === 200).length;
    const s2 = await startServer(dataDir);
    try {
      const total = (await client(s2.base).ws("term").post("segments/count", { filter: {} })).json.total;
      assert.ok(total >= ok * 20, `acknowledged ${ok * 20} rows, found ${total}`);
    } finally {
      s2.proc.kill("SIGTERM");
      await s2.exited;
    }
  });
  it("waits for another process to release a workspace file (redeploy overlap)", async () => {
    const dataDir = tempDir("rs-lock-");
    const s1 = await startServer(dataDir);
    await client(s1.base).ws("lock").post("provision");
    s1.proc.kill("SIGTERM");
    await s1.exited;
    // Simulate the previous container still holding the file for ~1.5s.
    const holder = spawn(process.execPath, ["-e", `
      const { DuckDBInstance } = require(${JSON.stringify(require.resolve("@duckdb/node-api"))});
      DuckDBInstance.create(${JSON.stringify(dataDir + "/ws/lock.duckdb")}).then((db) => { console.log("held"); setTimeout(() => { db.closeSync(); process.exit(0); }, 1500); });
    `], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => holder.stdout!.once("data", () => r()));
    const s2 = await startServer(dataDir);
    try {
      const t0 = Date.now();
      const r = await client(s2.base).ws("lock").post("segments/count", { filter: {} });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.ok(Date.now() - t0 >= 500, "request should have waited for the lock");
    } finally {
      s2.proc.kill("SIGTERM");
      await s2.exited;
    }
  });
});
