import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, loadavg, cpus } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { piServiceHeaders, signWatchTicket } from "../convex/lib/piRuntimeTokens.ts";

type Snapshot = { progress?: { completed: number; outputs: string[]; overheadMs: number[]; lastCommitAt: number }; task?: { id: number; outcome: string | null } };
type Sample = { host: string; restartReadyMs: number; resumeMs: number; checkpointMs: number[]; observedStepOverheadMs: number[]; observedSteps: Array<{ step: number; at: number }>; killedAt: number; totalMs: number; outputs: string[]; taskId: number; websocketFrames: number; transientPollFailures: number; leaseWaits: number };
type Conformance = { cases: number; passed: number; failures: string[] };
type LeaseConnection = { controller: AbortController; latest?: Snapshot; failed: boolean; ignore: boolean };

async function until<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await read();
    if (found !== undefined) return found;
    await delay(25);
  }
  throw new Error("Prototype deadline exceeded");
}

async function stop(child: ChildProcess, group: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (group) process.kill(-child.pid!, "SIGKILL");
  else child.kill("SIGKILL");
  await exited;
}

const mode = process.env.PI_RUNTIME_COMPARE;
const withConvex = mode === "1" || mode === "lease";
test(mode === "lease" ? "diagnose one local Convex lease crash recovery in workerd" : withConvex ? "compare five alternating Cloudflare SQLite and local Convex lease crash recoveries" : "prove five Cloudflare SQLite crash recoveries in workerd", {
  skip: !["1", "do", "lease"].includes(mode ?? "") && "Run explicitly with PI_RUNTIME_COMPARE=1 for both hosts, do for SQLite, or lease for one diagnostic",
  timeout: 240_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canon-pi-compare-"));
  const active = new Map<ChildProcess, boolean>();
  const sockets = new Set<WebSocket>();
  const streams = new Set<AbortController>();
  const samples: Sample[] = [];
  const artifact = `.devstack/pi-runtime/comparison${mode === "lease" ? "-lease" : withConvex ? "" : "-do"}.json`;
  const privateValues: string[] = [];
  const workerLogs: Array<{ key: string; read: () => string }> = [];
  let phase = "prepare";
  let failure: { phase: string; name: string } | null = null;
  let storageConformance: Conformance | null = null;
  let leaseFencing: boolean | null = null;
  let ownsStack = false;
  let cleanupFailed = false;
  const stackCommands: Array<{ command: string; code: number | null; at: string }> = [];
  const stack = (command: "dev:isolated" | "dev:stop") => new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", command, ...(command === "dev:isolated" ? ["--", "--background"] : [])], { stdio: "ignore" });
    active.set(child, false);
    child.once("error", () => reject(new Error("Managed stack command could not start")));
    child.once("exit", (code) => {
      stackCommands.push({ command, code, at: new Date().toISOString() });
      if (code === 0) resolve();
      else reject(new Error("Managed stack command failed; inspect .devstack/stack.log"));
    });
  });
  const interrupt = () => {
    for (const [child, group] of active) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (group) process.kill(-child.pid!, "SIGKILL");
          else child.kill("SIGTERM");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    if (withConvex) {
      phase = "backend-start";
      ownsStack = true;
      await stack("dev:isolated");
    }
    const secret = "canon-pi-fixture-with-no-external-authority";
    const config = join(directory, "wrangler.json");
    const ports = withConvex ? Object.fromEntries((await readFile(".devstack/ports.env", "utf8")).split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("="))) : {};
    const backend = withConvex ? JSON.parse(await readFile(".convex/local/default/config.json", "utf8")) : null;
    if (withConvex) assert.equal(backend.ports.cloud, Number(ports.CONVEX_PORT));
    privateValues.push(secret, ...(backend ? [backend.adminKey, backend.instanceSecret].filter((v): v is string => typeof v === "string" && v.length > 0) : []));
    await writeFile(config, JSON.stringify({
      name: "canon-pi-comparison", main: resolve("services/pi-runtime/src/prototype-worker.ts"), compatibility_date: "2026-10-01",
      durable_objects: { bindings: [{ name: "RUNS", class_name: "PiRun" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["PiRun"] }],
      vars: { CANON_PI_SECRET: secret, CANON_CONVEX_SITE: "http://127.0.0.1:1", PI_LOCAL_PROBE: "on" },
    }));
    await writeFile(join(directory, ".dev.vars"), `CANON_PI_SECRET=${secret}\nPI_LOCAL_PROBE=on\nPI_LOCAL_CONVEX_URL=http://127.0.0.1:${ports.CONVEX_PORT ?? 1}\nPI_LOCAL_ADMIN_KEY=${backend?.adminKey ?? ""}\nCANON_CONVEX_SITE=http://127.0.0.1:1\n`, { mode: 0o600 });
    const wrangler = resolve("services/pi-runtime/node_modules/wrangler/bin/wrangler.js");
    const watch = async (url: string, key: string) => {
      const ticket = await signWatchTicket(secret, key, "fixture-viewer");
      const socket = new WebSocket(`${url.replace("http:", "ws:")}/runs/${key}?ticket=${encodeURIComponent(ticket)}`);
      sockets.add(socket);
      const frames: Snapshot[] = [];
      socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Snapshot); });
      await until(async () => socket.readyState === WebSocket.OPEN ? true : undefined);
      return { socket, frames };
    };
    const launch = (key: string) => {
      const child = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", "0", "--config", config, "--persist-to", join(directory, key)],
      { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      active.set(child, true);
      let log = "";
      workerLogs.push({ key, read: () => log });
      child.stdout.on("data", (v) => { log += String(v); });
      child.stderr.on("data", (v) => { log += String(v); });
      const ready = until(async () => {
        assert.equal(child.exitCode, null, log.slice(-3000));
        assert.equal(child.signalCode, null, log.slice(-3000));
        return /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1];
      });
      return { child, ready };
    };
    for (let trial = 0; trial < (mode === "lease" ? 1 : 5); trial++) {
      for (const host of (mode === "lease" ? ["convex"] : withConvex ? ["do", "convex"] : ["do"]) as Array<"do" | "convex">) {
        const key = `pi-probe-${Date.now()}-${trial}-${host}`;
        phase = `${host}:${trial}:launch`;
        let current = launch(key);
        let url = await current.ready;
        if (host === "convex" && !storageConformance) {
          phase = "convex:storage-conformance";
          const response = await fetch(`${url}/lease-conformance`, { headers: { Authorization: `Bearer ${secret}` } });
          assert.equal(response.status, 200);
          storageConformance = await response.json() as Conformance;
          assert.ok(storageConformance && storageConformance.cases > 0);
          assert.deepEqual(storageConformance.failures, []);
          phase = "convex:lease-fencing";
          const leaseKey = `pi-probe-${crypto.randomUUID()}`;
          const operate = async (holder: string, epoch: number, operation: string) => {
            const response = await fetch(`http://127.0.0.1:${ports.CONVEX_PORT}/api/mutation`, {
              method: "POST", headers: { Authorization: `Convex ${backend.adminKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ path: "piPrototype:operate", format: "json", args: { key: leaseKey, holder, epoch, operation } }),
            });
            assert.ok(response.ok || response.status === 560);
            return await response.json() as { status: string; value: { epoch: number } };
          };
          const first = await operate("first", 0, "acquire");
          assert.equal(first.status, "success");
          assert.equal((await operate("second", 0, "acquire")).status, "error");
          await delay(3100);
          const second = await operate("second", 0, "acquire");
          assert.equal(second.status, "success");
          assert.ok(second.value.epoch > first.value.epoch);
          assert.equal((await operate("first", first.value.epoch, "mint")).status, "error");
          assert.equal((await operate("second", second.value.epoch, "mint")).status, "success");
          leaseFencing = true;
        }
        const startedAt = Date.now();
        const observed = new Map<number, number>();
        let leaseWaits = 0, transientPollFailures = 0;
        const lease: { current?: LeaseConnection } = {};
        const get = async (): Promise<Snapshot | undefined> => {
          try {
            let snapshot: Snapshot | undefined;
            if (host === "convex") {
              let stream = lease.current;
              if (!stream) {
                const controller = new AbortController();
                streams.add(controller);
                const res = await fetch(`${url}/leases/${key}`, { headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal });
                if (res.status === 409) { leaseWaits++; await res.text(); return undefined; }
                assert.equal(res.status, 200);
                const owner = { controller, latest: undefined as Snapshot | undefined, failed: false, ignore: false };
                lease.current = stream = owner;
                void (async () => {
                  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
                  let pending = "";
                  for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    pending += value;
                    const lines = pending.split("\n");
                    pending = lines.pop()!;
                    for (const line of lines) if (line) owner.latest = JSON.parse(line) as Snapshot;
                  }
                  if (!owner.ignore && owner.latest?.task?.outcome !== "completed") owner.failed = true;
                })().catch(() => { if (!owner.ignore) owner.failed = true; });
              }
              assert.equal(stream.failed, false, "Lease owner stream failed");
              snapshot = stream.latest;
            } else {
              const res = await fetch(`${url}/runs/${key}`, { headers: await piServiceHeaders(secret, "GET", `/runs/${key}`) });
              assert.equal(res.status, 200);
              snapshot = await res.json() as Snapshot;
            }
            if (!snapshot) return undefined;
            assert.ok(!snapshot.task?.outcome || snapshot.task.outcome === "completed", "Pi task did not complete successfully");
            if (snapshot.progress && !observed.has(snapshot.progress.completed)) observed.set(snapshot.progress.completed, Date.now());
            return snapshot;
          } catch (error) {
            if (error instanceof assert.AssertionError) throw error;
            transientPollFailures++;
            return undefined;
          }
        };
        if (host === "do") {
          const res = await fetch(`${url}/runs/${key}?probe=1`, { method: "POST", headers: await piServiceHeaders(secret, "POST", `/runs/${key}?probe=1`) });
          assert.equal(res.status, 202);
        }
        phase = `${host}:${trial}:before-crash`;
        const live = host === "do" ? await watch(url, key) : null;
        if (live) await until(async () => live.frames.some((frame) => (frame.progress?.completed ?? 0) >= 1) ? true : undefined);
        const saved = await until(async () => {
          const snapshot = await get();
          return snapshot?.progress && snapshot.progress.completed >= 2 ? snapshot : undefined;
        });
        assert.ok(saved.progress!.completed < 8);
        const killedAt = Date.now();
        if (lease.current) lease.current.ignore = true;
        await stop(current.child, true);
        lease.current?.controller.abort();
        lease.current = undefined;
        phase = `${host}:${trial}:restart`;
        current = launch(key);
        url = await current.ready;
        const readyAt = Date.now();
        const resumedLive = host === "do" ? await watch(url, key) : null;
        await until(async () => {
          const snapshot = await get();
          return snapshot?.progress && snapshot.progress.completed > saved.progress!.completed ? snapshot : undefined;
        });
        const resumedAt = Date.now();
        phase = `${host}:${trial}:complete`;
        const finished = await until(async () => {
          const snapshot = await get();
          return snapshot?.progress?.completed === 8 && snapshot.task?.outcome === "completed" ? snapshot : undefined;
        });
        const finishedAt = Date.now();
        assert.deepEqual(finished.progress!.outputs.map((output) => output.split("@")[0]), Array.from({ length: 8 }, (_, i) => `checkpoint-${i}`));
        assert.deepEqual(finished.progress!.outputs.slice(0, saved.progress!.completed), saved.progress!.outputs);
        assert.equal(finished.task!.id, saved.task!.id);
        if (resumedLive) {
          await until(async () => resumedLive.frames.some((frame) => frame.progress?.completed === 8) ? true : undefined);
          assert.ok(resumedLive.frames.every((frame) => !frame.progress || frame.progress.completed >= saved.progress!.completed));
          resumedLive.socket.close();
        }
        live?.socket.close();
        const observedStepOverheadMs = [...observed].flatMap(([step, at]) => {
          const previous = observed.get(step - 1);
          return previous === undefined || (previous <= killedAt && at >= killedAt) ? [] : [at - previous - 1500];
        });
        samples.push({ host, restartReadyMs: readyAt - killedAt, resumeMs: resumedAt - killedAt,
          checkpointMs: finished.progress!.overheadMs, observedStepOverheadMs,
          observedSteps: [...observed].map(([step, at]) => ({ step, at })), killedAt,
          totalMs: finishedAt - startedAt, outputs: finished.progress!.outputs, transientPollFailures, leaseWaits,
          taskId: finished.task!.id, websocketFrames: (live?.frames.length ?? 0) + (resumedLive?.frames.length ?? 0) });
        await stop(current.child, true);
      }
    }
    phase = "complete";
  } catch (error) {
    failure = { phase, name: error instanceof Error ? error.name : "UnknownError" };
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    for (const stream of streams) stream.abort();
    for (const [child, group] of active) await stop(child, group);
    if (ownsStack) {
      try { await stack("dev:stop"); } catch { cleanupFailed = true; }
    }
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
    await rm(directory, { recursive: true, force: true });
    await mkdir(".devstack/pi-runtime", { recursive: true });
    const redact = (value: string) => {
      for (const secret of privateValues) value = value.replaceAll(secret, "[redacted]");
      return value.replaceAll(process.cwd(), "<worktree>").replaceAll(directory, "<fixture>");
    };
    await writeFile(artifact, JSON.stringify({ at: new Date().toISOString(), wranglerLauncherNode: process.version,
      runtime: "workerd", mode, load: loadavg(), cores: cpus().length, phase, failure, cleanupFailed,
      workerErrors: failure ? workerLogs.map(({ key, read }) => ({ key, tail: redact(read()).slice(-5000) })) : [],
      stackCommands, storageConformance, leaseFencing, samples }, null, 2));
    console.log(JSON.stringify({ phase, failure, cleanupFailed, samples: samples.length, artifact }));
    assert.equal(cleanupFailed, false, "Managed stack cleanup failed");
  }
});
