import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { usePageCallLoads } from "../src/components/modules/page-call-loads.ts";

type Args = Parameters<typeof usePageCallLoads>;
type Result = ReturnType<typeof usePageCallLoads>;
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Instance = { args: Args; slots: Slot[]; cursor: number; effects: Array<() => void> };
const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function browser() {
  let active: Instance;
  let now = 0, nextTimer = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const requests: Array<{ args: Parameters<Args[3]>[0]; resolve: (out: { value: unknown }) => void; reject: (error: Error) => void }> = [];
  const slot = () => active.slots[active.cursor++] ??= {};
  function memoValue<T>(fn: () => T, deps: readonly unknown[]): T {
    const s = slot();
    if (!same(s.deps, deps)) { s.value = fn(); s.deps = deps; }
    return s.value as T;
  }
  const hooks = {
    useMemo: memoValue,
    useCallback: <T>(fn: T, deps: readonly unknown[]) => memoValue(() => fn, deps),
    useRef: <T>(initial: T) => memoValue(() => ({ current: initial }), []),
    useState<T>(initial: T | (() => T)) {
      const s = slot();
      if (!("value" in s)) s.value = typeof initial === "function" ? (initial as () => T)() : initial;
      return [s.value, (next: T | ((old: T) => T)) => { s.value = typeof next === "function" ? (next as (old: T) => T)(s.value as T) : next; }];
    },
    useEffect(run: () => (() => void), deps: readonly unknown[]) {
      const s = slot();
      if (!same(s.deps, deps)) active.effects.push(() => { s.cleanup?.(); s.deps = deps; s.cleanup = run(); });
    },
  };
  const exports: { usePageCallLoads?: typeof usePageCallLoads } = {};
  const cache: { moduleCallCache?: { invalidate(): void } } = {};
  runInNewContext(ts.transpileModule(readFileSync("src/lib/module-call-cache.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText, { exports: cache });
  const source = readFileSync("src/components/modules/page-call-loads.ts", "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText, {
    exports, Date: class extends Date { static now() { return now; } },
    setTimeout: (run: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { run, at: now + ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (id: string) => {
      if (id === "react") return hooks;
      if (id === "@/lib/utils") return { getErrorMessage: String };
      if (id === "@/lib/module-call-cache") return cache;
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const runCall: Args[3] = (args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
  const mount = (principal = "org:rep", fresh = false): Instance => ({ args: [principal, "audiences", { count: { call: "count", args: { audience: "a" }, refreshMinutes: 15 } }, runCall, fresh], slots: [], cursor: 0, effects: [] });
  const draw = (i: Instance): Result => {
    active = i; i.cursor = 0;
    const result = exports.usePageCallLoads!(...i.args);
    for (const effect of i.effects.splice(0)) effect();
    return result;
  };
  const settle = async (request: number, value: unknown) => { requests[request].resolve({ value }); await new Promise<void>((done) => setImmediate(done)); };
  const fail = async (request: number) => { requests[request].reject(new Error("Read unavailable")); await new Promise<void>((done) => setImmediate(done)); };
  const tick = (ms: number) => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } };
  const unmount = (i: Instance) => { for (const s of i.slots) s.cleanup?.(); };
  return { mount, draw, settle, fail, tick, unmount, requests, timers, invalidate: () => cache.moduleCallCache!.invalidate() };
}

test("page loads coalesce and expire while fallback mounts force fresh values and discard superseded replies", async () => {
  const b = browser();
  const first = b.mount(), second = b.mount();
  b.draw(first); b.draw(second);
  assert.equal(b.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(b.requests[0].args)), { module: "audiences", call: "count", args: { audience: "a" } });
  await b.settle(0, 1);
  assert.equal(b.draw(first).loaded.count.value, 1);
  assert.equal(b.draw(second).loaded.count.value, 1);
  const cached = b.mount(); b.draw(cached);
  assert.equal(b.draw(cached).loaded.count.value, 1);
  const fallback = b.mount("org:rep", true), newer = b.mount("org:rep", true);
  b.draw(fallback); b.draw(newer);
  assert.equal(b.draw(fallback).loaded.count.busy, true);
  assert.equal(b.draw(fallback).loaded.count.value, undefined);
  assert.equal(b.requests.length, 3, "fresh mounts bypass cached and in-flight values");
  await b.settle(2, 3);
  await b.settle(1, 2);
  assert.equal(b.draw(newer).loaded.count.value, 3);
  const latest = b.mount(); b.draw(latest);
  assert.equal(b.draw(latest).loaded.count.value, 3, "an older response cannot overwrite the shared cache");
  b.tick(15 * 60_000 + 26);
  assert.equal(b.requests.length, 4, "simultaneous periodic refreshes share one current request");
  await b.settle(3, 4);
  for (const i of [first, second, cached, fallback, newer, latest]) {
    assert.equal(b.draw(i).loaded.count.value, 4);
    b.unmount(i);
  }
  assert.equal(b.timers.size, 0);
  b.tick(15 * 60_000);
  assert.equal(b.requests.length, 4, "unmounted pages stop refreshing");
  const moved = b.mount("org:other"); b.draw(moved);
  assert.equal(b.draw(moved).loaded.count.value, undefined);
  b.draw(moved).runLoad("count", true);
  await b.settle(5, 6);
  await b.settle(4, 5);
  assert.equal(b.draw(moved).loaded.count.value, 6, "a superseded response cannot replace the current page value");
  const otherCached = b.mount("org:other"); b.draw(otherCached);
  assert.equal(b.draw(otherCached).loaded.count.value, 6);
  b.unmount(moved); b.unmount(otherCached);
  assert.equal(b.timers.size, 0);
});

test("refresh completion waits for the current read and preserves saved form values when refresh fails", async () => {
  const b = browser(), page = b.mount();
  b.draw(page);
  await b.settle(0, { mode: "off", name: "Before" });
  b.invalidate();
  let done = false;
  const refresh = b.draw(page).runLoad("count", true).then((ok) => { done = true; return ok; });
  assert.equal(done, false);
  assert.equal(b.draw(page).loaded.count.busy, true);
  await b.settle(1, { mode: "off", name: "Saved" });
  assert.equal(await refresh, true);
  const destination = b.mount();
  assert.deepEqual(JSON.parse(JSON.stringify(b.draw(destination).loaded.count.value)), { mode: "off", name: "Saved" });
  b.invalidate();
  const failed = b.draw(page).runLoad("count", true);
  await b.fail(2);
  assert.equal(await failed, false);
  const retained = b.draw(page).loaded.count;
  assert.deepEqual(JSON.parse(JSON.stringify(retained.value)), { mode: "off", name: "Saved" });
  assert.equal(retained.busy, false);
  assert.match(retained.error!, /Read unavailable/);
  const old = b.draw(page).runLoad("count", true);
  const latest = b.draw(page).runLoad("count", true);
  await b.settle(3, { mode: "off", name: "Superseded" });
  assert.equal(await old, false);
  await b.settle(4, { mode: "off", name: "Latest" });
  assert.equal(await latest, true);
  assert.deepEqual(JSON.parse(JSON.stringify(b.draw(page).loaded.count.value)), { mode: "off", name: "Latest" });
  assert.equal(await b.draw(page).runLoad("missing", true), false);
  const unmounted = b.draw(page).runLoad("count", true);
  b.unmount(page); b.unmount(destination);
  await b.settle(5, { mode: "off", name: "Unmounted" });
  assert.equal(await unmounted, false);
  assert.equal(b.timers.size, 0);
});


test("a changed readable binding reloads a cached call while unchanged revisions keep its value", async () => {
  const b = browser(), page = b.mount();
  page.args[2].count.revision = "waiting";
  b.draw(page); await b.settle(0, 3);
  assert.equal(b.draw(page).loaded.count.value, 3);
  assert.equal(b.requests.length, 1);
  page.args[2] = { count: { ...page.args[2].count, revision: "completed" } };
  assert.equal(b.draw(page).loaded.count.value, undefined);
  assert.equal(b.requests.length, 2);
  await b.settle(1, 4);
  assert.equal(b.draw(page).loaded.count.value, 4);
  b.unmount(page);
});
