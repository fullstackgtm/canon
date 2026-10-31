import assert from "node:assert/strict";
import { test } from "node:test";
import { ModuleCallCache } from "../src/lib/module-call-cache.ts";

test("read-only results are reused only for their key, including null and undefined", async () => {
  const cache = new ModuleCallCache<unknown>();
  assert.deepEqual([
    await cache.load("workspace-a/person-a/agents/list", async () => ["Original agent"]),
    await cache.load("workspace-a/person-a/agents/list", async () => ["Unexpected reload"]),
    await cache.load("workspace-b/person-a/agents/list", async () => ["Other workspace agent"]),
    await cache.load("workspace-a/person-b/agents/list", async () => ["Other person's agent"]),
    await cache.load("null", async () => null),
    await cache.load("null", async () => "Unexpected reload"),
    await cache.load("undefined", async () => undefined),
    await cache.load("undefined", async () => "Unexpected reload"),
  ], [["Original agent"], ["Original agent"], ["Other workspace agent"], ["Other person's agent"], null, null, undefined, undefined]);
});

test("invalidating after a write makes navigation back read the updated list", async () => {
  const cache = new ModuleCallCache<string[]>();
  assert.deepEqual(await cache.load("agents/list", async () => ["Original agent"]), ["Original agent"]);
  cache.invalidate();
  assert.deepEqual(await cache.load("agents/list", async () => ["Original agent", "A3 local proof"]), ["Original agent", "A3 local proof"]);
  assert.deepEqual(await cache.load("agents/list", async () => ["Unexpected reload"]), ["Original agent", "A3 local proof"]);
});

test("an old response may finish after invalidation without replacing the newer saved result", async () => {
  const cache = new ModuleCallCache<string[]>();
  let finish!: (value: string[]) => void;
  const old = cache.load("agents/list", () => new Promise((resolve) => { finish = resolve; }));
  cache.invalidate();
  assert.deepEqual(await cache.load("agents/list", async () => ["Original agent", "A3 local proof"]), ["Original agent", "A3 local proof"]);
  finish(["Original agent"]);
  assert.deepEqual(await old, ["Original agent"]);
  assert.deepEqual(await cache.load("agents/list", async () => ["Unexpected reload"]), ["Original agent", "A3 local proof"]);
});

test("an explicit refresh bypasses and replaces a saved value", async () => {
  const cache = new ModuleCallCache<string[]>();
  assert.deepEqual(await cache.load("agents/list", async () => ["Original agent"]), ["Original agent"]);
  assert.deepEqual(await cache.load("agents/list", async () => ["Updated agent"], true), ["Updated agent"]);
  assert.deepEqual(await cache.load("agents/list", async () => ["Unexpected reload"]), ["Updated agent"]);
});


test("a superseded refresh cannot replace the latest result for the same key", async () => {
  const cache = new ModuleCallCache<string[]>();
  let finish!: (value: string[]) => void;
  const old = cache.load("agents/list", () => new Promise((resolve) => { finish = resolve; }), true);
  assert.deepEqual(await cache.load("agents/list", async () => ["Updated agent"], true), ["Updated agent"]);
  finish(["Original agent"]);
  assert.deepEqual(await old, ["Original agent"]);
  assert.deepEqual(await cache.load("agents/list", async () => ["Unexpected reload"]), ["Updated agent"]);
});

test("pending reads coalesce without old cleanup removing a newer request and rejected reads can retry", async () => {
  const cache = new ModuleCallCache<string>();
  let finishOld!: (value: string) => void, finishNew!: (value: string) => void;
  const old = cache.load("people", () => new Promise((resolve) => { finishOld = resolve; }));
  cache.invalidate();
  const current = cache.load("people", () => new Promise((resolve) => { finishNew = resolve; }));
  finishOld("Before write");
  assert.equal(await old, "Before write");
  const shared = cache.load("people", async () => "Unexpected duplicate");
  finishNew("After write");
  assert.deepEqual(await Promise.all([current, shared]), ["After write", "After write"]);
  assert.deepEqual(cache.get("people"), { value: "After write" });
  await assert.rejects(cache.load("retry", async () => { throw new Error("Offline"); }), /Offline/);
  assert.equal(await cache.load("retry", async () => "Retry"), "Retry");
  for (let i = 0; i < 513; i++) await cache.load(String(i), async () => String(i));
  assert.equal(await cache.load("0", async () => "Evicted and reloaded"), "Evicted and reloaded");
  assert.equal(await cache.load("512", async () => "Unexpected reload"), "512");
});
