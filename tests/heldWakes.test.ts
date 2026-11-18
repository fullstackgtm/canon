import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const files = loadConvex(["hubspot.ts", "canon.ts", "objects.ts"], {});

function world() {
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [{ _id: "users:ana", orgId: "org", name: "ana", role: "admin", isActive: true }] });
  const scheduled: unknown[] = [];
  const ctx = (): any => ({ db, scheduler: { runAfter: async (_ms: number, fn: unknown) => void scheduled.push(fn) } });
  const sync = (crmId: string, hold?: true) =>
    files["hubspot.ts"].upsertAccounts.handler(ctx(), { orgId: "org", accounts: [{ crmId, name: `Co ${crmId}`, domain: `${crmId}.test`, ownerId: "users:ana" }], ...(hold ? { hold } : {}) });
  const queued = () => db.query("partyMirrorQueue").withIndex("by_orgId", (q: any) => q.eq("orgId", "org")).collect();
  return { db, ctx, scheduled, sync, queued };
}

test("a sync write that holds its wakes schedules nothing, and the sync's wake starts the mirror's drain once", async () => {
  const w = world();
  await w.sync("C1", true);
  assert.equal(w.scheduled.length, 0, "a held write wakes no reader and no drain");
  assert.equal((await w.queued()).length > 0, true, "its mirror job is still queued");

  // How many functions one wake schedules.
  const wake = async (drain?: true) => {
    const before = w.scheduled.length;
    await (files["objects.ts"] as any).wakeHeldWrites.handler(w.ctx(), { orgId: "org", ...(drain ? { drain } : {}) });
    return w.scheduled.length - before;
  };
  const readers = await wake();
  assert.equal(await w.db.query("partyMirrorDrains").withIndex("by_orgId", (q: any) => q.eq("orgId", "org")).first(), null, "a wake during the sync leaves the drain for its end");
  assert.equal(await wake(true), readers + 1, "the sync's last wake also schedules the drain");
  assert.equal(await wake(true), readers, "a drain already scheduled is not scheduled again");
});

test("a write that holds nothing still schedules its mirror's drain", async () => {
  const w = world();
  await w.sync("C2");
  assert.equal(w.scheduled.length > 0, true);
});
