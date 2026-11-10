/**
 * Canon reads a module's read plan names, through the real Convex code. Deal history (P1a): the ledger's deal entries folded into versions, then read as they stood at a time
 * (`deals.asOf`) and between two times (`deals.changesBetween`), through the real deal writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

let now = 0;
class Clock extends Date { constructor(...a: unknown[]) { super(...((a.length ? a : [now]) as [number])); } static now() { return now; } }
const ADMIN = { _id: "users:ada", orgId: "organizations:org", role: "admin", name: "Ada", email: "a@x", isActive: true };
const M = loadConvex(["deals.ts", "objects.ts", "dealHistory.ts", "lib/modules/canonReads.ts", "permissions.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ADMIN, requireUser: async () => ADMIN }),
}, { Date: Clock });
const reads = M["lib/modules/canonReads.ts"] as unknown as { canonRead: (...a: unknown[]) => Promise<Array<Record<string, unknown>>> };
const manifest = { reads: { deals: ["amount", "closeDate", "ownerId"] } };

test("a deal reads as it stood at a time, and its changes between two times carry every close date and amount it held", async () => {
  const db = memoryDb({ organizations: [{ _id: ADMIN.orgId }], users: [ADMIN] });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const at = async (t: number, f: () => Promise<unknown>) => { now = t; return f(); };
  const access = await (M["permissions.ts"] as unknown as { accessFor: (c: unknown, u: unknown) => Promise<unknown> }).accessFor(ctx, ADMIN);
  const read = (name: string, args: Record<string, unknown>) => reads.canonRead(ctx, ADMIN.orgId, access, manifest, name, { from: "2026-11-01", to: "2026-11-30", ...args }, 100);

  const created = await at(1000, () => M["deals.ts"].create.handler(ctx, { name: "Acme", amount: 10_000, closeDate: "2026-11-15", stage: "prospecting" })) as { entityId?: string; streamId?: string; dealId?: string };
  const streamId = (db.rows("canonEntities") as unknown as Array<{ _id: string; projectionTable: string }>).find((e) => e.projectionTable === "deals")!._id;
  await at(2000, () => M["objects.ts"].write.handler(ctx, { object: "deal", streamId, values: { amount: 8_000 } }));
  await at(3000, () => M["objects.ts"].write.handler(ctx, { object: "deal", streamId, values: { closeDate: "2026-12-20" } }));
  assert.ok(created);

  // Until the fold has caught up once, the reads refuse rather than answer from part of the history.
  await assert.rejects(read("deals.asOf", { at: 1500 }), /Deal history is still being built/);
  await at(4000, () => M["dealHistory.ts"].step.handler(ctx, { orgId: ADMIN.orgId }));

  const pick = (rows: Array<Record<string, unknown>>) => JSON.parse(JSON.stringify(rows.map((r) => [r.amount, r.closeDate])));
  assert.deepEqual(pick(await read("deals.asOf", { at: 1500 })), [[10_000, "2026-11-15"]]);
  assert.deepEqual(pick(await read("deals.asOf", { at: 2500 })), [[8_000, "2026-11-15"]]);
  assert.deepEqual(pick(await read("deals.asOf", { at: 3500 })), [], "it slipped out of November");
  assert.deepEqual(pick(await read("deals.asOf", { at: 500 })), [], "it didn't exist yet");

  const [change] = await read("deals.changesBetween", { since: 1500, until: 3500 });
  assert.deepEqual(JSON.parse(JSON.stringify([change.before, change.after, change.closeDates, change.amounts])), [
    { amount: 10_000, closeDate: "2026-11-15", ownerId: ADMIN._id }, { amount: 8_000, closeDate: "2026-12-20", ownerId: ADMIN._id }, ["2026-11-15", "2026-12-20"], [10_000, 8_000],
  ]);
  // A module not granted closeDate gets neither the field nor its history; granted amount, it gets the amounts held.
  const [hidden] = await reads.canonRead(ctx, ADMIN.orgId, access, { reads: { deals: ["amount"] } }, "deals.changesBetween", { from: "2026-11-01", to: "2026-11-30", since: 1500, until: 3500 }, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(hidden)), { id: hidden.id, createdAt: hidden.createdAt, before: { amount: 10_000 }, after: { amount: 8_000 }, amounts: [10_000, 8_000] });
  // Nor categories, without a forecastCategory grant.
  assert.equal("categories" in hidden, false);
});

test("targets.forYear reads the saved plan by fiscal year, or by a day in it, with the months summed", async () => {
  const db = memoryDb({ organizations: [{ _id: "organizations:fy", fiscalYearStartMonth: 2 }] });
  const months = (n: number) => Array.from({ length: 12 }, () => n);
  db.insert("targetPlans", { orgId: "organizations:fy", year: 2027, total: 36_000, fyStart: 2, coverage: 3, repTeam: { a: "t", b: "t" }, repMonths: { a: months(1_000), b: months(2_000) }, teamMonths: { t: months(3_000) }, updatedAt: 9, updatedBy: "u" });
  const read = (args: Record<string, unknown>) => reads.canonRead({ db }, "organizations:fy", null, { reads: { targets: ["year", "months", "repMonths"] } }, "targets.forYear", args, 10);
  const strip = (rows: Array<Record<string, unknown>>) => JSON.parse(JSON.stringify(rows.map(({ id: _i, createdAt: _c, ...r }) => r)));
  assert.deepEqual(strip(await read({ on: "2026-03-15" })), [{ year: 2027, months: months(3_000), repMonths: { a: months(1_000), b: months(2_000) } }], "March 2026 is in the fiscal year that starts in February 2026");
  assert.deepEqual(strip(await read({ year: 2026 })), [], "no plan saved for that year");
  const before = now;
  now = Date.UTC(2026, 2, 15);
  try {
    assert.deepEqual(strip(await read({})), strip(await read({ year: 2027 })), "without arguments reads the current fiscal year");
    const [plan] = await reads.canonRead({ db }, "organizations:fy", null, { reads: { targets: ["coverage"] } }, "targets.forYear", {}, 1);
    assert.equal(plan.coverage, 3);
  } finally { now = before; }
});

test("latest closed deals apply caller row and field admission before the bounded challenge context", async () => {
  const orgId = "organizations:org";
  const db = memoryDb({
    deals: [
      { _id: "own", orgId, name: "Visible won", primaryRepId: "rep", isClosed: true, isWon: true, amount: 700, closeDate: "2026-10-20", createdAt: 1 },
      { _id: "private", orgId, name: "Private deal", primaryRepId: "other", isClosed: true, isWon: true, amount: 900, closeDate: "2026-10-21", createdAt: 2 },
      { _id: "lost", orgId, name: "Visible lost", primaryRepId: "rep", isClosed: true, isWon: false, closeDate: "2026-10-21", createdAt: 3 },
      { _id: "archived", orgId, name: "Archived", primaryRepId: "rep", isClosed: true, isWon: true, archivedAt: 4, createdAt: 4 },
    ],
  });
  const access = { userId: "rep", role: "rep", teamOwners: ["rep"], rules: { deal: { object: "deal", visibility: "own", fields: [{ apiName: "amount", level: "hidden" }] } } };
  const grant = { reads: { deals: ["name", "amount", "closeDate", "isClosed", "isWon"] } };
  const won = await reads.canonRead({ db }, orgId, access, grant, "deals.latestClosed", { won: true }, 15);
  assert.deepEqual(JSON.parse(JSON.stringify(won.map((r) => [r.id, r.name, r.amount]))), [["own", "Visible won", null]]);
  assert.deepEqual(JSON.parse(JSON.stringify((await reads.canonRead({ db }, orgId, access, grant, "deals.latestClosed", { won: false }, 15)).map((r) => r.id))), ["lost"]);
  const hiddenClosed = structuredClone(access); hiddenClosed.rules.deal.fields.push({ apiName: "isWon", level: "hidden" });
  assert.deepEqual(Array.from(await reads.canonRead({ db }, orgId, hiddenClosed, grant, "deals.latestClosed", { won: true }, 15)), []);
});
