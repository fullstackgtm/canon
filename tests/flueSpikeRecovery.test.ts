import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PUBLIC_LOCAL_FIXTURE_KEY } from "../convex/lib/research/piFixture.ts";
import { piServiceHeaders } from "../convex/lib/piRuntimeTokens.ts";

const spike = resolve("services/flue-spike");
const proof = process.env.FLUE_SPIKE_PROOF ?? "";
const skip = (name: "wakes" | "research") => ![name, "1"].includes(proof) && "Run explicitly with FLUE_SPIKE_PROOF=1, wakes or research after npm install in services/flue-spike";

type Receipt = {
  run: { id: string; status: string; done: number; answered: number; errors: number };
  traces: Array<{ id: string; recordId: string; status: string }>;
  facts: Array<{ id: string; status: string }>;
  plans: Array<{ id: string; status: string }>;
  effects: Array<{ stepId: string; operation: string; completed: boolean }>;
};
type ModelCalls = { bootId: string; modelCalls: Array<{ bootId: string; index: number | "done" }> };

async function until<T>(read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await delay(50); }
  throw new Error("Flue spike proof deadline exceeded");
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGKILL");
  await exited;
}

const run = (command: string, args: string[], cwd = process.cwd()) => new Promise<void>((accept, reject) => {
  const child = spawn(command, args, { cwd, stdio: "ignore", env: { ...process.env, CI: "1" } });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} ${args[0]} exited ${code}`)));
});

// A Workers for Platforms-shaped layout: one dispatcher plus one user Worker per org, each with its own DO namespace.
async function layout(directory: string, vars: Record<string, string>) {
  await run(process.execPath, [join(spike, "node_modules/vite/bin/vite.js"), "build"], spike);
  const built = JSON.parse(await readFile(join(spike, "dist/canon_org_worker/wrangler.json"), "utf8"));
  const configs: string[] = [];
  const dispatcher = join(directory, "dispatcher.json");
  await writeFile(dispatcher, JSON.stringify({ name: "canon-dispatcher", main: join(spike, "dispatcher/worker.ts"), compatibility_date: "2026-10-01",
    vars: { CANON_PI_SECRET: PUBLIC_LOCAL_FIXTURE_KEY }, services: ["a", "b"].map((org) => ({ binding: `ORG_${org.toUpperCase()}`, service: `canon-org-${org}` })) }));
  configs.push(dispatcher);
  for (const org of ["a", "b"]) {
    const config = join(directory, `org-${org}.json`);
    await writeFile(config, JSON.stringify({ ...built, name: `canon-org-${org}`, main: join(spike, "dist/canon_org_worker", built.main),
      vars: { ...vars, CANON_ORG: org, CANON_PI_SECRET: PUBLIC_LOCAL_FIXTURE_KEY } }));
    configs.push(config);
  }
  const workers: ChildProcess[] = [];
  const logs: string[] = [];
  const launch = async (port: number) => {
    let log = "";
    const child = spawn(process.execPath, [join(spike, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
      ...configs.flatMap((config) => ["-c", config]), "--persist-to", join(directory, "storage")], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
    workers.push(child);
    const index = logs.push("") - 1;
    const append = (chunk: unknown) => { log += String(chunk); logs[index] = log; };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const origin = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Local Wrangler exited during startup: ${log.slice(-2000)}`);
      return log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    return { child, origin };
  };
  const signed = async (origin: string, method: "GET" | "POST", path: string) => {
    const response = await fetch(`${origin}${path}`, { method, headers: await piServiceHeaders(PUBLIC_LOCAL_FIXTURE_KEY, method, path) });
    return { status: response.status, body: await response.text() };
  };
  return { launch, signed, workers, logs };
}

test("three Agents SDK schedules on one Flue agent DO survive a hard kill and each fire once", { skip: skip("wakes"), timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canon-flue-wakes-"));
  const { launch, signed, workers, logs } = await layout(directory, { PI_LOCAL_PROBE: "on" });
  let evidence: Record<string, unknown> = {};
  try {
    let worker = await launch(0);
    const port = Number(new URL(worker.origin).port);
    const armed = JSON.parse((await signed(worker.origin, "POST", "/orgs/a/wakes/w1")).body) as { pending: number };
    assert.equal(armed.pending, 3);
    const armedAt = Date.now();
    await kill(worker.child);
    const killedAfterMs = Date.now() - armedAt;
    await delay(8_000);
    worker = await launch(port);
    const restartedAfterMs = Date.now() - armedAt;
    type Wakes = { fired: Array<{ label: string; firedAt: number; fires: number }>; pending: number };
    const after = await until(async () => {
      const wakes = JSON.parse((await signed(worker.origin, "GET", "/orgs/a/wakes/w1")).body) as Wakes;
      return wakes.fired.length === 3 && wakes.pending === 0 ? wakes : undefined;
    });
    await delay(3_000);
    const settled = JSON.parse((await signed(worker.origin, "GET", "/orgs/a/wakes/w1")).body) as Wakes;
    assert.deepEqual(settled.fired.map((wake) => [wake.label, wake.fires]), [["a", 1], ["b", 1], ["c", 1]]);
    const otherOrg = JSON.parse((await signed(worker.origin, "GET", "/orgs/b/wakes/w1")).body) as Wakes;
    assert.equal(otherOrg.fired.length, 0, "org b's Worker has its own DO namespace");
    const forged = await fetch(`${worker.origin}/orgs/a/wakes/w1`);
    assert.equal(forged.status, 401);
    evidence = { killedAfterMs, restartedAfterMs, armed, fired: settled.fired.map((wake) => ({ ...wake, msAfterArm: wake.firedAt - armedAt })), pending: after.pending, orgBFired: otherOrg.fired.length, unsignedStatus: forged.status };
  } finally {
    for (const child of workers) await kill(child);
    await mkdir(".devstack/flue-spike", { recursive: true });
    await writeFile(".devstack/flue-spike/wakes.json", JSON.stringify({ at: new Date().toISOString(), host: "workerd via wrangler 4.151.3, service-binding WfP emulation", ...evidence, workerLog: Object.keys(evidence).length ? undefined : logs.map((log) => log.slice(-4000)) }, null, 2));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Flue agent recovers a lost Canon landing acknowledgement without duplicate proposals, traces or model calls", { skip: skip("research"), timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canon-flue-research-"));
  const stack = (command: "dev:isolated" | "dev:stop") => run("npm", ["run", command, ...(command === "dev:isolated" ? ["--", "--background"] : [])]);
  let workers: ChildProcess[] = [];
  let logs: string[] = [];
  let evidence: Record<string, unknown> = {};
  let phase = "start-stack";
  const stopRuns: Array<() => Promise<unknown>> = [];
  const secrets: string[] = [];
  try {
    await stack("dev:isolated");
    const ports = Object.fromEntries((await readFile(".devstack/ports.env", "utf8")).split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split("=")));
    const backend = JSON.parse(await readFile(".convex/local/default/config.json", "utf8"));
    assert.equal(backend.ports.cloud, Number(ports.CONVEX_PORT));
    secrets.push(backend.adminKey);
    const api = async <T>(kind: "action" | "mutation" | "query", path: string, args: object): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${ports.CONVEX_PORT}/api/${kind}`, {
        method: "POST", headers: { Authorization: `Convex ${backend.adminKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ path, args, format: "json" }),
      });
      const result = await response.json() as { status: string; value: T };
      if (!response.ok || result.status !== "success") throw new Error(`Local Canon ${path} refused (${response.status})`);
      return result.value;
    };
    phase = "start-worker";
    const built = await layout(directory, { PI_LOCAL_PROBE: "on", PI_LOCAL_CONVEX_URL: `http://127.0.0.1:${ports.CONVEX_PORT}`, PI_LOCAL_ADMIN_KEY: backend.adminKey, CANON_CONVEX_SITE: `http://127.0.0.1:${ports.CONVEX_SITE_PORT}` });
    workers = built.workers;
    logs = built.logs;
    let worker = await built.launch(0);
    const port = Number(new URL(worker.origin).port);
    const fixture = await api<{ runId: string; slug: string }>("mutation", "piResearchFixtures:seed", { tag: crypto.randomUUID().slice(0, 8), origin: worker.origin });
    stopRuns.push(() => api("mutation", "piResearch:fail", { runId: fixture.runId }));
    const receipt = () => api<Receipt>("query", "piResearchFixtures:receipt", { runId: fixture.runId });
    const admit = async () => {
      const response = await built.signed(worker.origin, "POST", `/orgs/a/runs/${fixture.runId}`);
      assert.equal(response.status, 202, response.body);
      return JSON.parse(response.body) as { submissionId: string; uid: string; deduplicated?: boolean };
    };
    phase = "first-landing";
    const first = await admit();
    const before = await until(async () => { const value = await receipt(); return value.run.done === 1 ? value : undefined; });
    const callsBefore = JSON.parse((await built.signed(worker.origin, "GET", "/orgs/a/model-calls")).body) as ModelCalls;
    assert.equal(before.facts.length, 1, JSON.stringify(before));
    assert.equal(before.traces.length, 1);
    phase = "hard-kill";
    const killedAt = Date.now();
    await kill(worker.child);
    phase = "restart-no-attachment";
    worker = await built.launch(port);
    const after = await until(async () => { const value = await receipt(); return value.run.status === "done" ? value : undefined; }, 120_000);
    const resumeMs = Date.now() - killedAt;
    const callsAfter = JSON.parse((await built.signed(worker.origin, "GET", "/orgs/a/model-calls")).body) as ModelCalls;
    phase = "assert-landing";
    const again = await admit();
    assert.equal(again.submissionId, first.submissionId, "re-admission converges on the same Flue submission");
    assert.equal(again.uid, first.uid);
    assert.ok(after.run.done >= 2);
    assert.equal(after.run.errors, 0);
    assert.equal(after.run.answered, after.run.done);
    assert.equal(after.facts.length, after.run.done);
    assert.equal(after.traces.length, after.run.done);
    assert.equal(new Set(after.traces.map((trace) => trace.recordId)).size, after.run.done);
    assert.ok(after.facts.some((fact) => fact.id === before.facts[0].id));
    assert.ok(after.traces.some((trace) => trace.id === before.traces[0].id));
    assert.ok(after.facts.every((fact) => fact.status === "proposed"));
    assert.ok(after.plans.every((plan) => plan.status === "pending_approval"));
    assert.equal(after.effects.filter((effect) => effect.operation === "model" && effect.completed).length, after.run.done);
    const resentFirst = callsAfter.modelCalls.filter((call) => call.index === 0);
    assert.equal(resentFirst.length, 0, "the recorded tool-call response for index 0 is not requested again after restart");
    const isolation = await built.signed(worker.origin, "POST", `/orgs/b/runs/${fixture.runId}`);
    evidence = { fixture, firstSubmission: first, readmission: again, killedAt, resumeMs, before, after,
      fauxModelCalls: { beforeKill: callsBefore.modelCalls, afterRestart: callsAfter.modelCalls },
      orgBAdmissionOfOrgARun: isolation.status, dollarsSpent: 0, recoveryMode: "flue-wake-no-attachment",
      transport: "workerd Flue DO SQLite -> local admin Convex HTTP API -> existing Canon gates; dispatcher via service bindings (dispatch namespaces unsupported locally)" };
    phase = "complete";
  } finally {
    for (const child of workers) await kill(child);
    for (const stop of stopRuns) await stop().catch(() => {});
    await stack("dev:stop").catch(() => {});
    await mkdir(".devstack/flue-spike", { recursive: true });
    const redact = (log: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), log).replaceAll(process.cwd(), "[worktree]").slice(-6000);
    await writeFile(".devstack/flue-spike/research-recovery.json", JSON.stringify({ at: new Date().toISOString(), nodeLauncher: process.version, host: "workerd", phase, ...evidence, workerLog: phase === "complete" ? undefined : logs.map(redact) }, null, 2));
    await rm(directory, { recursive: true, force: true });
  }
});
