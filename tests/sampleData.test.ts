import assert from "node:assert/strict";
import test from "node:test";
import { DEV_DEPLOYMENT as DEV } from "../convex/lib/devDeployment.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const ORG = "organizations:org";
const ADMIN = "users:admin";
const MANAGER = "users:manager";

let signedIn: Record<string, unknown> | null = null;
const seeded: Array<{ fn: string; orgId: string; accountId: string; prefix: string }> = [];
const M = loadConvex(["sampleData.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => { if (!signedIn) throw new Error("Not authenticated"); return signedIn; } }),
  "devSeed.ts": (real) => ({
    ...real,
    seedNorthwind: async (_ctx: unknown, orgId: string, accountId: string, prefix: string) => void seeded.push({ fn: "northwind", orgId, accountId, prefix }),
    ensureAccount: async (ctx: { db: { insert: (t: string, d: unknown) => Promise<string> } }, input: { orgId: string; crmId: string }) => ctx.db.insert("crmAccounts", { orgId: input.orgId, crmId: input.crmId }),
  }),
});
const sample = M["sampleData.ts"]!;

function workspace() {
  const user = (id: string, role: string) => ({ _id: id, orgId: ORG, role, isActive: true, name: id, email: `${id}@acme.test` });
  const db = memoryDb({ users: [user(ADMIN, "admin"), user(MANAGER, "manager")] });
  return { db, ctx: { db } };
}

async function on<T>(url: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = url;
  try { return await work(); } finally { if (before === undefined) delete process.env.CONVEX_CLOUD_URL; else process.env.CONVEX_CLOUD_URL = before; }
}

test("an admin on dev loads Northwind into their own workspace, with members namespaced by it", async () => {
  const w = workspace();
  signedIn = await w.db.get(ADMIN);
  seeded.length = 0;
  await on(DEV, async () => {
    assert.deepEqual(JSON.parse(JSON.stringify(await sample.status.handler(w.ctx, {}))), { available: true, loaded: [] });
    await sample.loadNorthwind.handler(w.ctx, {});
  });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.orgId, ORG);
  assert.equal(seeded[0]!.prefix, `sample_${ORG}_northwind_`);
  const account = await w.db.get(seeded[0]!.accountId);
  assert.equal(account?.orgId, ORG);
});

test("production and non-admins can neither see nor load sample data", async () => {
  const w = workspace();
  seeded.length = 0;
  signedIn = await w.db.get(ADMIN);
  await on("https://production-example.convex.cloud", async () => {
    assert.deepEqual(JSON.parse(JSON.stringify(await sample.status.handler(w.ctx, {}))), { available: false, loaded: [] });
    await assert.rejects(sample.loadNorthwind.handler(w.ctx, {}));
  });
  signedIn = await w.db.get(MANAGER);
  await on(DEV, async () => {
    assert.deepEqual(JSON.parse(JSON.stringify(await sample.status.handler(w.ctx, {}))), { available: false, loaded: [] });
    await assert.rejects(sample.loadNorthwind.handler(w.ctx, {}));
  });
  assert.equal(seeded.length, 0);
});

test("the large set is the same for a day, and every deal's history reads in order up to that day", async () => {
  const { sampleDataset, SAMPLE_SIZES } = await import("../convex/lib/sampleDataset.ts");
  const today = "2026-10-25";
  const set = sampleDataset(today);
  assert.deepEqual(sampleDataset(today), set);
  assert.equal(set.companies.length, SAMPLE_SIZES.companies);
  assert.equal(new Set(set.companies.map((c) => c.domain)).size, set.companies.length);
  assert.equal(set.people.length, SAMPLE_SIZES.companies * SAMPLE_SIZES.peoplePerCompany);
  assert.equal(set.deals.length, SAMPLE_SIZES.deals);
  let closed = 0, slipped = 0;
  for (const d of set.deals) {
    assert.ok(d.created < today, d.key);
    let last = d.created;
    for (const c of d.changes) {
      assert.ok(c.day > d.created && c.day < today && c.day >= last, `${d.key} ${c.day}`);
      last = c.day;
    }
    const final = { closeDate: d.closeDate, isClosed: false, ...Object.assign({}, ...d.changes.map((c) => c.values)) };
    if (final.isClosed) { closed++; assert.ok(final.closeDate < today, d.key); } else assert.ok(final.closeDate > today, d.key);
    if (d.changes.some((c) => "closeDate" in c.values && !("isClosed" in c.values))) slipped++;
  }
  // Enough of each kind for the reports to read: decided deals, open pipeline, and slips.
  assert.ok(closed > 150 && set.deals.length - closed > 100 && slipped > 50, `${closed} closed, ${slipped} slipped`);
});

test("picking a set loads what it needs: deals bring companies and the team, people bring companies", async () => {
  const { withNeeds } = await import("../convex/lib/sampleDataset.ts");
  assert.deepEqual(withNeeds(["deals"]), ["team", "companies", "deals"]);
  assert.deepEqual(withNeeds(["people", "forecast"]), ["companies", "people", "forecast"]);
  assert.deepEqual(withNeeds([]), []);
});
