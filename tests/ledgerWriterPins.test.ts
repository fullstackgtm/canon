/**
 * The rules every ledger write keeps, pinned per object kind through the entry points a person, a sync and the API
 * call, in process: a person's value holds against a CRM, a field set to follow a CRM follows it, a unique value is
 * refused to a second record, a write naming a non-member is refused, a stale version is a conflict, and an unchanged
 * re-sync appends and writes nothing. A record whose history is not on the ledger yet (written to `facts` only) holds
 * the same way. tests/ledgerWriterCensus.test.ts lists the functions that append.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

/** A clock that moves a second each time it is read, so every write is newer than the last. */
let clock = Date.UTC(2026, 10, 10);
class TickingDate extends Date {
  constructor(...a: unknown[]) {
    super(...((a.length ? a : [clock]) as [number]));
  }
  static now() { return (clock += 1000); }
}
let signedIn: unknown = null;
const files = loadConvex(["hubspot.ts", "canon.ts", "objects.ts", "crmDisagreements.ts", "lib/canon/dealLedger.ts", "lib/fieldClaimStore.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => signedIn }),
}, { Date: TickingDate });
const canon = files["canon.ts"] as any;
const objects = files["objects.ts"] as any;
const hubspot = files["hubspot.ts"] as any;
const page = files["crmDisagreements.ts"] as any;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const KIT = {
  apiName: "custom_kit", registryVersion: 1,
  object: { label: "Kit", pluralLabel: "Kits", icon: "box", titleField: "custom.name" },
  customFields: [
    { fieldId: "custom.name", apiName: "custom.name", label: "Name", type: "text", required: true },
    { fieldId: "custom.code", apiName: "custom.code", label: "Code", type: "text", unique: true },
    { fieldId: "custom.owner", apiName: "custom.owner", label: "Owner", type: "user" },
  ],
};
const DEAL_CODE = { apiName: "deal", registryVersion: 1, customFields: [{ fieldId: "custom.code", apiName: "custom.code", label: "Code", type: "text", unique: true }] };

function world() {
  const db = memoryDb({
    organizations: [{ _id: "org" }, { _id: "org2" }],
    users: [...["admin", "ana"].map((n) => ({ _id: `users:${n}`, orgId: "org", name: n, role: "admin", isActive: true })), { _id: "users:far", orgId: "org2", name: "far", role: "admin", isActive: true }],
    objectDefs: [{ _id: "objectDefs:kit", orgId: "org", ...KIT, updatedAt: 1 }, { _id: "objectDefs:deal", orgId: "org", ...DEAL_CODE, updatedAt: 1 }],
  });
  const ctx = (): any => ({ db, scheduler: { runAfter: async () => null }, auth: { getUserIdentity: async () => null } });
  signedIn = { _id: "users:admin", orgId: "org", name: "admin", role: "admin", isActive: true };
  return { db, ctx };
}
type World = ReturnType<typeof world>;

/** Database writes and ledger entries a call makes. */
async function cost(w: World, run: () => Promise<unknown>) {
  const db = w.db as any;
  let writes = 0;
  const real = { patch: db.patch, insert: db.insert, replace: db.replace, delete: db.delete };
  for (const k of Object.keys(real) as Array<keyof typeof real>) db[k] = (...a: unknown[]) => (writes++, real[k](...a));
  const entries = db.rows("ledgerEntries").length;
  try { await run(); } finally { Object.assign(db, real); }
  return { writes, entries: db.rows("ledgerEntries").length - entries };
}
const claims = (w: World) => w.db.rows("parentDisagreements").map((d: any) => `${d.object ?? "deal"}.${d.attribute}:${d.provider}`).sort();
const write = (w: World, args: Record<string, unknown>) => objects.write.handler(w.ctx(), args);
const errorFields = (r: any) => plain(r.status === "invalid" ? r.errors.map((e: any) => e.field) : r.status);

test("a deal: a person's value holds, a followed field follows, and unique, reference, version and re-sync rules hold", async () => {
  const w = world();
  const deal = (crmId: string, v: Record<string, unknown> = {}) => ({
    crmId, name: "Big deal", closeDate: "2026-12-01", dealType: "new_business", revenueType: "one_time", isClosed: false, isWon: false, stage: "prospecting", amount: 1000, ...v,
  });
  const sync = (...deals: Array<Record<string, unknown>>) => hubspot.upsertDeals.handler(w.ctx(), { orgId: "org", deals });
  await sync(deal("D1"), deal("D2", { name: "Other deal" }));
  const stream = async (crmId: string) => {
    const row = (await w.db.query("deals").withIndex("by_orgId_crmId", (q: any) => q.eq("orgId", "org").eq("crmId", crmId)).first())!;
    return (await w.db.query("canonEntities").withIndex("by_orgId_projectionId", (q: any) => q.eq("orgId", "org").eq("projectionId", row._id)).first())!._id as string;
  };
  const row = async () => (await w.db.query("deals").withIndex("by_orgId_crmId", (q: any) => q.eq("orgId", "org").eq("crmId", "D1")).first())!;
  const d1 = await stream("D1");

  assert.deepEqual(await cost(w, () => sync(deal("D1"))), { writes: 0, entries: 0 });

  assert.equal((await write(w, { object: "deal", streamId: d1, values: { name: "Mine", amount: 777 } })).status, "applied");
  await page.setFollow.handler(w.ctx(), { provider: "hubspot", field: "amount", follow: true });
  await sync(deal("D1", { name: "Renamed", amount: 2500 }));
  assert.deepEqual(plain([(await row()).name, (await row()).amount, claims(w)]), ["Mine", 2500, ["deal.name:hubspot"]]);

  assert.equal((await write(w, { object: "deal", streamId: d1, values: { "custom.code": "K-1" } })).status, "applied");
  assert.deepEqual(errorFields(await write(w, { object: "deal", streamId: await stream("D2"), values: { "custom.code": " k-1 " } })), ["custom.code"]);
  assert.deepEqual(errorFields(await write(w, { object: "deal", streamId: d1, values: { ownerId: "users:far" } })), ["ownerId"]);
  const version = (await w.db.query("recordRows").withIndex("by_orgId_streamId", (q: any) => q.eq("orgId", "org").eq("streamId", d1)).unique())!.version as number;
  assert.deepEqual(plain(await write(w, { object: "deal", streamId: d1, values: { name: "Late" }, expectedVersion: version - 1 })), { status: "conflict", streamId: d1, version, expectedVersion: version - 1 });
  assert.deepEqual(await cost(w, () => sync(deal("D1", { name: "Renamed", amount: 2500 }))), { writes: 0, entries: 0 });
});

const PARTY = {
  account: {
    sync: (w: World, v: Record<string, unknown> = {}) => hubspot.upsertAccounts.handler(w.ctx(), { orgId: "org", accounts: [{ crmId: "C1", name: "Acme", domain: "acme.test", industry: "Software", employeeCount: 50, ownerId: "users:ana", ...v }] }),
    recordId: "acc_1", held: "name", followed: "industry", unique: "domain", taken: "acme.test", other: { id: "acc_2", domain: "beta.test", name: "Beta", updatedAt: 1 },
  },
  contact: {
    sync: (w: World, v: Record<string, unknown> = {}) => hubspot.upsertContacts.handler(w.ctx(), { orgId: "org", contacts: [{ crmId: "P1", firstName: "Pat", lastName: "Lee", email: "pat@acme.test", title: "VP Sales", phone: "+1 555 0100", ownerId: "users:ana", ...v }] }),
    recordId: "con_1", held: "title", followed: "phone", unique: "email", taken: "pat@acme.test", other: { id: "con_2", fullName: "Sam Roe", email: "sam@beta.test", updatedAt: 1 },
  },
} as const;
const CHANGED = { account: { name: "Acme Corp", industry: "Fintech" }, contact: { title: "CRO", phone: "+1 555 0199" } } as const;

for (const object of ["account", "contact"] as const) {
  test(`a ${object === "account" ? "company" : "person"}: a person's value holds, a followed field follows, and unique, reference, version and re-sync rules hold`, async () => {
    const w = world();
    const p = PARTY[object];
    await p.sync(w);
    const ext = await w.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q: any) => q.eq("orgId", "org").eq("provider", `hubspot:${object}`).eq("externalId", object === "account" ? "C1" : "P1")).first();
    const streamId = ext.entityId as string;
    const values = async () => {
      const { project } = await import("../convex/lib/objects/fold.ts");
      return project(await objects.loadDef(w.ctx(), "org", object), await objects.convexObjectStore(w.ctx()).getHotRow(streamId)).values;
    };
    let op = 0;
    const edit = (recordId: string, patch: Record<string, unknown>, more: Record<string, unknown> = {}) => canon.saveRecordEdit.handler(w.ctx(), {
      orgId: "org", userId: "users:admin", object, recordId, patch, idempotencyKey: `edit${++op}`, ...more,
    });
    const check = (recordId: string, patch: Record<string, unknown>, more: Record<string, unknown> = {}) => canon.checkRecordEdit.handler(w.ctx(), {
      orgId: "org", object, recordId, patch, idempotencyKey: `check${++op}`, ...more,
    });

    assert.deepEqual(await cost(w, () => p.sync(w)), { writes: 0, entries: 0 });

    assert.equal((await edit(p.recordId, { [p.held]: "Ours", [p.followed]: "Ours too" }, { streamId })).status, "applied");
    await page.setFollow.handler(w.ctx(), { provider: "hubspot", object, field: p.followed, follow: true });
    await p.sync(w, object === "account" ? { name: CHANGED.account.name, industry: CHANGED.account.industry } : { title: CHANGED.contact.title, phone: CHANGED.contact.phone });
    const now = await values();
    assert.deepEqual(plain([now[p.held], now[p.followed], claims(w)]), ["Ours", CHANGED[object][p.followed as keyof (typeof CHANGED)[typeof object]], [`${object}.${p.held}:hubspot`]]);

    const taken = { [p.unique]: p.taken };
    if (object === "contact") {
      assert.deepEqual(plain((await check(p.other.id, taken, { snapshot: p.other })).refused.map((e: any) => e.field)), [p.unique]);
      assert.deepEqual(plain((await edit(p.other.id, taken, { snapshot: p.other })).rejected.map((e: any) => e.field)), [p.unique]);
    } else {
      // A company's domain is not a records.edit field: a second HubSpot company that later says the first one's domain is refused it.
      const second = (domain: string) => hubspot.upsertAccounts.handler(w.ctx(), { orgId: "org", accounts: [{ crmId: "C2", name: "Beta", domain, industry: "Software", employeeCount: 5 }] });
      await second("beta.test");
      await second(p.taken);
      const beta = await w.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q: any) => q.eq("orgId", "org").eq("provider", "hubspot:account").eq("externalId", "C2")).first();
      const { project } = await import("../convex/lib/objects/fold.ts");
      const betaValues = project(await objects.loadDef(w.ctx(), "org", object), await objects.convexObjectStore(w.ctx()).getHotRow(beta.entityId)).values;
      assert.deepEqual([beta.entityId === streamId, betaValues.domain, (await values()).domain], [false, "beta.test", "acme.test"]);
    }
    assert.deepEqual(plain((await check(p.recordId, { ownerId: "users:far" }, { streamId, references: { userId: "users:admin", admitted: [] } })).unnamed.map((e: any) => e.field)), ["ownerId"]);
    const stale = await edit(p.recordId, { [p.held]: "Late" }, { streamId, expect: { [p.held]: "Not it" } });
    assert.deepEqual([stale.status, (await values())[p.held]], ["conflict", "Ours"]);

    assert.deepEqual(await cost(w, () => p.sync(w, object === "account" ? { name: CHANGED.account.name, industry: CHANGED.account.industry } : { title: CHANGED.contact.title, phone: CHANGED.contact.phone })), { writes: 0, entries: 0 });
  });
}

test("a custom object: unique, reference and version rules hold, and an unchanged save appends and writes nothing", async () => {
  const w = world();
  const first = await write(w, { object: "custom_kit", values: { "custom.name": "First", "custom.code": "K-1" } });
  assert.equal(first.status, "applied");
  assert.deepEqual(errorFields(await write(w, { object: "custom_kit", values: { "custom.name": "Second", "custom.code": " k-1 " } })), ["custom.code"]);
  assert.deepEqual(errorFields(await write(w, { object: "custom_kit", streamId: first.streamId, values: { "custom.owner": "users:far" } })), ["custom.owner"]);
  assert.deepEqual(plain(await write(w, { object: "custom_kit", streamId: first.streamId, values: { "custom.name": "Late" }, expectedVersion: 0 })), { status: "conflict", streamId: first.streamId, version: 1, expectedVersion: 0 });
  assert.deepEqual(await cost(w, () => write(w, { object: "custom_kit", streamId: first.streamId, values: { "custom.name": "First" } })), { writes: 0, entries: 0 });
});

test("a deal and a company written to facts only hold a person's value against a CRM the same way", async () => {
  const w = world();
  // A deal with no stream, in a transaction with no conversion budget left: its writes go to `facts` only.
  const { writeDeal } = files["lib/canon/dealLedger.ts"] as any;
  const facts = canon.convexLedgerStore(w.ctx());
  const dealId = await w.db.insert("deals", { orgId: "org", name: "Big deal", closeDate: "2026-12-01", dealType: "new_business", isClosed: false, isWon: false, currency: "USD" });
  const streamId = await w.db.insert("canonEntities", { orgId: "org", entityType: "opportunity", projectionTable: "deals", projectionId: dealId, createdAt: 1 });
  const stores = () => ({
    facts, objects: objects.convexObjectStore(w.ctx()), conversionBudget: { remaining: 0 }, fieldClaims: (files["lib/fieldClaimStore.ts"] as any).fieldClaimStore(w.ctx()),
    getRow: (id: string) => w.db.get(id), patchRow: (id: string, patch: Record<string, unknown>) => w.db.patch(id, patch),
  });
  const def = await objects.loadDef(w.ctx(), "org", "deal");
  const writeAs = (source: Record<string, unknown>, values: Record<string, unknown>) => writeDeal(stores(), { orgId: "org", def, dealId, streamId, source, values, now: TickingDate.now() });
  await writeAs({ kind: "hubspot", crmId: "D1" }, { name: "Big deal", ownerId: "users:ana" });
  await writeAs({ kind: "user", userId: "users:admin" }, { name: "Mine" });
  const out = await writeAs({ kind: "hubspot", crmId: "D1" }, { name: "Renamed", ownerId: "users:admin" });
  assert.deepEqual(plain([out.result.status, out.held, (await w.db.get(dealId))!.name, w.db.rows("ledgerEntries").length, claims(w)]), ["deferred", ["name"], "Mine", 0, ["deal.name:hubspot"]]);

  // A company whose history is too large to convert: its writes go to `facts` only, for good.
  const company = await w.db.insert("canonEntities", { orgId: "org", entityType: "account", projectionTable: "crmAccounts", projectionId: "x", createdAt: 1 });
  await w.db.insert("canonExternalIds", { orgId: "org", entityId: company, provider: "hubspot:account", externalId: "C1" });
  for (let i = 0; i <= 256; i++) await w.db.insert("canonFieldState", { orgId: "org", entityId: company, attribute: `custom.f${i}`, value: null, factId: null, sourceKind: "import", state: "empty", updatedAt: 1 });
  await PARTY.account.sync(w);
  const edited = await canon.saveRecordEdit.handler(w.ctx(), { orgId: "org", userId: "users:admin", object: "account", recordId: "acc_1", patch: { name: "Ours" }, idempotencyKey: "e1", streamId: company });
  await PARTY.account.sync(w, { name: "Acme Corp" });
  const named = await w.db.query("canonFieldState").withIndex("by_entityId_attribute", (q: any) => q.eq("entityId", company).eq("attribute", "name")).first();
  assert.deepEqual(plain([edited.status, named.value, w.db.rows("ledgerEntries").length, claims(w)]), ["deferred", "Ours", 0, ["account.name:hubspot", "deal.name:hubspot"]]);
});
