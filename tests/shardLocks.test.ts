// A sync's upserts wait for the ledger shards they take (convex/lib/shardLocks.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { shardLocks } from "../convex/lib/shardLocks.ts";

/** A task that records when it starts and ends, and finishes when `release` is called. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { release, task: async () => { log.push(`${name}+`); await done; log.push(`${name}-`); return name; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("writes on different shards run at once; writes sharing a shard run in the order asked", async () => {
  const run = shardLocks(16);
  const log: string[] = [];
  const [a, b, c] = [gate(log, "a"), gate(log, "b"), gate(log, "c")];
  const done = [run([1, 2], a.task), run([3], b.task), run([2, 5], c.task)];
  await tick();
  assert.deepEqual(log, ["a+", "b+"]);
  a.release();
  await tick();
  assert.deepEqual(log, ["a+", "b+", "a-", "c+"]);
  b.release();
  c.release();
  assert.deepEqual(await Promise.all(done), ["a", "b", "c"]);
});

test("a write that names no shards waits for every earlier write, and every later one waits for it", async () => {
  const run = shardLocks(4);
  const log: string[] = [];
  const [a, all, b] = [gate(log, "a"), gate(log, "all"), gate(log, "b")];
  const done = [run([0], a.task), run(null, all.task), run([7], b.task)];
  await tick();
  assert.deepEqual(log, ["a+"]);
  a.release();
  await tick();
  assert.deepEqual(log, ["a+", "a-", "all+"]);
  all.release();
  await tick();
  // Shard 7 of 4 is shard 3, which the write before it held.
  assert.deepEqual(log, ["a+", "a-", "all+", "all-", "b+"]);
  b.release();
  await Promise.all(done);
});

test("a failed write rejects for its caller and holds no shard", async () => {
  const run = shardLocks(4);
  const failed = run([1], async () => { throw new Error("conflict"); });
  const next = run([1], async () => "next");
  await assert.rejects(failed, /conflict/);
  assert.equal(await next, "next");
});
