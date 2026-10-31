import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Snapshot = { progress?: { completed: number; outputs: string[]; overheadMs: number[]; lastCommitAt: number } };

async function poll<T>(read: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for persisted progress");
}

function launch(kind: string, key: string, output: string) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "tests/fixtures/pi-runtime/sqlite-host.ts", kind, key, output], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += String(value); });
  child.stderr.on("data", (value) => { stderr += String(value); });
  return { child, ready: () => poll(async () => {
    assert.equal(child.exitCode, null, stderr);
    assert.equal(child.signalCode, null, stderr);
    return stdout.includes('"ready":true') ? Date.now() : undefined;
  }), errors: () => stderr };
}

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeSupportsPi = major > 22 || (major === 22 && minor >= 19);

test("SIGKILL resumes Pi's persisted checkpoint without repeating completed fake-model steps", { timeout: 30_000, skip: !nodeSupportsPi && "Pi Node adapter declares Node >=22.19" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canon-pi-crash-"));
  const output = join(directory, "progress.json");
  let child: ChildProcess | undefined;
  try {
    const first = launch("sqlite", "pi-probe-process", output);
    child = first.child;
    await first.ready();
    const saved = await poll(async () => {
      const value = await readFile(output, "utf8").then((s) => JSON.parse(s) as Snapshot).catch(() => undefined);
      return value?.progress && value.progress.completed >= 2 ? value : undefined;
    });
    assert.ok(saved.progress!.completed < 8);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const second = launch("sqlite", "pi-probe-process", output);
    child = second.child;
    await second.ready();
    const finished = await poll(async () => {
      const value = await readFile(output, "utf8").then((s) => JSON.parse(s) as Snapshot).catch(() => undefined);
      return value?.progress?.completed === 8 ? value : undefined;
    });
    assert.deepEqual(finished.progress!.outputs.map((output) => output.split("@")[0]), Array.from({ length: 8 }, (_, i) => `checkpoint-${i}`));
    assert.deepEqual(finished.progress!.outputs.slice(0, saved.progress!.completed), saved.progress!.outputs);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0, second.errors());
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
