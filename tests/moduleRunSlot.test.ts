import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

type Jobs = typeof import("../convex/lib/modules/jobs");
const jobs = loadConvex(["lib/modules/jobs.ts"])["lib/modules/jobs.ts"] as unknown as Jobs;
const ctxOf = () => ({ db: memoryDb({ moduleCursors: [] }) }) as never;

test("one run holds a module's slot; a second run ends until it is released or expires", async () => {
  const ctx = ctxOf();
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "a", 1_000), true);
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "b", 2_000), false);
  // The holder hands on to itself.
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "a", 3_000), true);
  assert.equal(await jobs.holdsRunSlot((ctx as { db: never }).db, "org" as never, "m", "b", 3_000), false);
  await jobs.releaseRunSlot(ctx, "org" as never, "m", "a");
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "b", 4_000), true);
  // A dead run's claim lapses.
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "c", 4_000 + jobs.RUN_HOLD_MS + 1), true);
});

test("leases past the hourly read budget pause the runner until the hour ends", async () => {
  const ctx = ctxOf();
  const db = (ctx as { db: never }).db;
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "a", 0), true);
  assert.equal(await jobs.chargeLeaseRows(ctx, "org" as never, "m", jobs.LEASE_ROWS_PER_HOUR, 10), null);
  const paused = await jobs.chargeLeaseRows(ctx, "org" as never, "m", 1, 20);
  assert.match(paused ?? "", /Paused/);
  assert.equal(await jobs.holdsRunSlot(db, "org" as never, "m", "a", 30), false);
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "b", 30), false);
  assert.match(await jobs.runnerPaused(db, "org" as never, "m", 30) ?? "", /Paused/);
  // A new hour: the runner may claim again, and its count starts over.
  const later = 3_600_000 + 1;
  assert.equal(await jobs.runnerPaused(db, "org" as never, "m", later), null);
  assert.equal(await jobs.claimRunSlot(ctx, "org" as never, "m", "b", later), true);
  assert.equal(await jobs.chargeLeaseRows(ctx, "org" as never, "m", 100, later), null);
});
