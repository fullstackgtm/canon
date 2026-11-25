import test from "node:test";
import assert from "node:assert/strict";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

class FixedDate extends Date {
  constructor(value?: string | number) { super(value ?? "2026-11-15T12:00:00Z"); }
  static now() { return Date.parse("2026-11-15T12:00:00Z"); }
}
const { summary } = loadConvex(["dashboard.ts"], {
  "permissions.ts": (real) => ({ ...real, unrestrictedUser: async () => ({ orgId: "org" }) }),
}, { Date: FixedDate })["dashboard.ts"];
const closeDate = "2026-11-01";
const deal = (i: number, extra = {}) => ({ _id: `deals:${i}`, orgId: "org", closeDate, amount: 10, isClosed: true, isWon: true, forecastCategory: "closed_won", ...extra });

test("summary reads recent close dates beyond old deals and excludes archived and other orgs", async () => {
  const db = memoryDb({ deals: [
    ...Array.from({ length: 3501 }, (_, i) => deal(i, { closeDate: "2000-01-01" })),
    deal(4000), deal(4001, { archivedAt: 1 }), deal(4002, { orgId: "other" }),
  ] });
  const result = await summary.handler({ db }, {});
  assert.equal(result.metrics.mtdRevenue, 10);
  assert.equal(result.metrics.winRate, 1);
  assert.equal(result.truncated.deals, true);
  assert.equal(result.truncated.window, false);
  assert.equal(result.metrics.totalDeals, null);
});

test("summary signals overflow and suppresses incomplete metrics within its read budget", async () => {
  const db = memoryDb({ organizations: [{ _id: "org", crmCounts: { openPipeline: 42, openDeals: 99, deals: 1501, unownedDeals: 7 } }],
    deals: Array.from({ length: 1501 }, (_, i) => deal(i)),
    users: Array.from({ length: 201 }, (_, i) => ({ _id: `users:${i}`, orgId: "org", name: "Rep", isActive: true })),
    integrations: Array.from({ length: 21 }, (_, i) => ({ _id: `integrations:${i}`, orgId: "org", isActive: true })),
  });
  let reads = 0;
  const query = db.query;
  db.query = (table) => {
    const q = query(table);
    const take = q.take;
    q.take = async (n) => { const rows = await take(n); reads += rows.length; return rows; };
    return q;
  };
  const result = await summary.handler({ db }, {});
  assert.equal(reads, 2724);
  assert.ok(Object.values(result.truncated).every(Boolean));
  for (const metric of ["mtdRevenue", "winRate", "activeTeam", "connectedCrmCount"]) assert.equal(result.metrics[metric], null);
  assert.equal(result.changes.mtdRevenue, undefined);
  assert.equal(result.metrics.openPipeline, 42);
  assert.equal(result.metrics.openDeals, 99);
  assert.equal(result.metrics.totalDeals, 1501);
  assert.equal(result.metrics.unownedDeals, 7);
});
