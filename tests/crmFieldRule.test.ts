import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { ingestObservations, type LedgerStore, type StoredFact } from "../convex/lib/canon/ledger.ts";
import type { EntryActor, EntrySource } from "../convex/lib/objects/fold.ts";
import { PERSON_HELD_FIELDS } from "../convex/lib/canon/personHold.ts";
import { REGISTER_COLUMNS } from "../services/record-service/src/core/objects/listSpec.ts";

/** A clock that moves a second each time it is read, so every write is newer than the last. */
let clock = Date.UTC(2026, 10, 10);
class TickingDate extends Date {
  constructor(...a: unknown[]) {
    super(...((a.length ? a : [clock]) as [number]));
  }
  static now() { return (clock += 1000); }
}
/** The member a public function runs as. */
let signedIn: unknown = null;
const files = loadConvex(["hubspot.ts", "salesforce.ts", "salesforceImportCanon.ts", "canon.ts", "fieldClaims.ts", "ownership.ts", "objects.ts", "canonGate.ts", "crmDisagreements.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => signedIn }),
}, { Date: TickingDate });
const canon = files["canon.ts"] as any;

/** Values the loaded modules made in their own realm, as plain values for deepEqual. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const users = ["admin", "ana", "ben", "cy", "dee"];
/** A workspace with reps and two companies Salesforce knows, and one deal D1 that each CRM path writes. */
function world() {
  const db = memoryDb({
    organizations: [{ _id: "org" }],
    users: [...users.map((n) => ({ _id: `users:${n}`, orgId: "org", name: n, role: "admin", isActive: true })), { _id: "users:far", orgId: "org2", name: "far" }],
    sfImportIds: [{ _id: "sfA", orgId: "org", object: "Account", sfId: "001A", canonId: "acc_a" }, { _id: "sfB", orgId: "org", object: "Account", sfId: "001B", canonId: "acc_b" }],
  });
  const ctx = (): any => ({ db, scheduler: { runAfter: async () => null } });
  const deal = async () => (await db.query("deals").withIndex("by_orgId_crmId", (q: any) => q.eq("orgId", "org").eq("crmId", "D1")).first())!;
  const id = (n: string | null) => (n ? `users:${n}` : undefined);
  /** `values`: what the CRM says beyond its owner (a sync's `closedAt`; the import derives it from the close date). */
  const synced = (owner: string | null, values: CrmValues = {}) => ({
    crmId: "D1", name: "Big deal", closeDate: "2026-12-01", dealType: "new_business", revenueType: "one_time", isClosed: false, isWon: false, ...values, ...(owner ? { primaryRepId: id(owner) } : {}),
  });
  const crm = {
    hubspot: (owner: string | null, values?: CrmValues) => files["hubspot.ts"].upsertDeals.handler(ctx(), { orgId: "org", deals: [synced(owner, values)] }),
    salesforceSync: (owner: string | null, values?: CrmValues) => files["salesforce.ts"].upsertDeals.handler(ctx(), { orgId: "org", instanceUrl: "https://sf.test", deals: [synced(owner, values)] }),
    salesforceImport: (owner: string | null, account?: string | null, values: CrmValues = {}) => files["salesforceImportCanon.ts"].upsertDeals.handler(ctx(), {
      orgId: "org", instanceUrl: "https://sf.test", deals: [{
        sfId: "D1", name: "Big deal", currency: "USD", closeDate: "2026-12-01", stage: "prospecting", probability: 0.1, isClosed: false, isWon: false,
        dealType: "new_business", revenueType: "one_time", ...Object.fromEntries(Object.entries(values).filter(([k]) => k !== "closedAt")),
        ...(owner ? { memberId: id(owner) } : {}), ...(account === null ? {} : { accountSfId: account ?? "001A" }),
      }],
    }),
  };
  /** A deal write as `source` (a person by default). */
  const write = async (values: Record<string, unknown>, source: Record<string, unknown> = { kind: "user", userId: "users:admin" }) =>
    canon.saveDealValues(ctx(), await deal(), source, values);
  const owner = async () => ((await deal()).primaryRepId as string | undefined)?.slice(6) ?? null;
  /** The deal page's owner: its projection, else the row's (objects.view). */
  const pageOwner = async () => {
    const view = await (files["objects.ts"] as any).view(ctx(), "org", (await stream()), 1000, new Map());
    return (view.values.ownerId as string | null)?.slice(6) ?? null;
  };
  const stream = async () => {
    const dealId = (await deal())._id;
    return (await db.query("canonEntities").withIndex("by_orgId_projectionId", (q: any) => q.eq("orgId", "org").eq("projectionId", dealId)).first())!._id as string;
  };
  const claims = () => db.rows("parentDisagreements").map((d: any) => `${d.attribute}:${d.provider}:${typeof d.crmValue === "string" ? d.crmValue.replace("users:", "") : d.crmValue}`).sort();
  /** How many values of `field` the deal's ledger holds. */
  const facts = (field: string) => db.rows("ledgerEntries").flatMap((e: any) => (e.body.kind === "assert" ? e.body.assertions : [])).filter((a: any) => a.fieldId === field).length;
  const take = async () => (files["fieldClaims.ts"] as any).takeCrmValue(ctx(), await db.get("users:admin"), db.rows("parentDisagreements")[0]._id);
  return { db, ctx, deal, crm, write, owner, pageOwner, claims, facts, take, stream };
}
type CrmPath = keyof ReturnType<typeof world>["crm"];
type CrmValues = Record<string, string | number | boolean>;
const PATHS: CrmPath[] = ["hubspot", "salesforceSync", "salesforceImport"];
/** Each CRM path with what it says about the deal. */
const send = (w: ReturnType<typeof world>, path: CrmPath, values: CrmValues, owner = "ana") =>
  path === "salesforceImport" ? w.crm.salesforceImport(owner, undefined, values) : w.crm[path](owner, values);
/** A deal's every synced value, as two CRM snapshots say them. */
const FIRST: CrmValues = { name: "Big deal", amount: 1000, closeDate: "2026-12-01", stage: "prospecting", forecastCategory: "pipeline", probability: 0.1, isClosed: false, isWon: false, dealType: "new_business" };
const NEXT: CrmValues = { name: "Bigger deal", amount: 2500, closeDate: "2027-01-15", stage: "closed_won", forecastCategory: "closed_won", probability: 1, isClosed: true, isWon: true, dealType: "expansion", closedAt: Date.UTC(2027, 0, 15) };
const SYNCED = ["name", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "dealType"] as const;
const synced = (d: Record<string, unknown>) => Object.fromEntries(SYNCED.map((k) => [k, d[k] ?? null]));
/** Database writes and ledger entries a call makes. */
async function cost(w: ReturnType<typeof world>, run: () => Promise<unknown>) {
  const db = w.db as any;
  let writes = 0;
  const real = { patch: db.patch, insert: db.insert, replace: db.replace, delete: db.delete };
  for (const k of Object.keys(real) as Array<keyof typeof real>) db[k] = (...a: unknown[]) => (writes++, real[k](...a));
  const entries = db.rows("ledgerEntries").length;
  try { await run(); } finally { Object.assign(db, real); }
  return { writes, entries: db.rows("ledgerEntries").length - entries };
}

// Pinned before the change: a deal no person touched takes every value each CRM sends, and an unchanged re-sync costs nothing.
test("an untouched deal takes each CRM's values as before, and an unchanged re-sync appends and writes nothing", async () => {
  for (const path of PATHS) {
    const w = world();
    await send(w, path, FIRST);
    await send(w, path, NEXT);
    const d = await w.deal();
    assert.deepEqual(plain(synced(d)), { ...synced(NEXT), currency: "USD" }, path);
    assert.equal(typeof d.closedAt, "number", path);
    const again = await cost(w, () => send(w, path, NEXT));
    assert.equal(again.entries, 0, path);
    if (path !== "salesforceImport") assert.equal(again.writes, 0, path);
  }
});

// Pinned before the change: a deal no person touched follows each CRM path's owner rules exactly as before.
test("an untouched deal follows each CRM's owner, its unmapped owner and a rep from another workspace as before", async () => {
  for (const path of ["hubspot", "salesforceSync"] as const) {
    const w = world();
    await w.crm[path]("ana");
    await w.crm[path]("ben");
    assert.equal(await w.owner(), "ben", path);
    // An unmapped CRM owner leaves the deal ownerless; a rep from another workspace skips the deal.
    await w.crm[path](null);
    assert.equal(await w.owner(), null, path);
    assert.equal(await w.pageOwner(), null, path);
    const skipped = await w.crm[path]("far");
    assert.equal(skipped.skipped, 1, path);
    assert.equal(await w.owner(), null, path);
  }
  const w = world();
  await w.crm.salesforceImport("ana");
  await w.crm.salesforceImport("ben");
  // The import's unmapped owner leaves the deal's rep as it was.
  await w.crm.salesforceImport(null);
  assert.deepEqual([await w.owner(), w.claims()], ["ben", []]);
});

for (const path of PATHS) {
  test(`${path}: a person's owner holds, the CRM's says so once and moves with the CRM, and agreeing appends nothing`, async () => {
    const w = world();
    await w.crm[path]("ana");
    await w.write({ ownerId: "users:ben" });
    const before = w.facts("ownerId");
    await w.crm[path]("cy");
    await w.crm[path]("cy");
    assert.deepEqual([await w.owner(), await w.pageOwner(), w.claims()], ["ben", "ben", [`ownerId:${path === "hubspot" ? "hubspot" : "salesforce"}:cy`]]);
    await w.crm[path]("dee");
    assert.equal(w.claims().length, 1);
    assert.match(w.claims()[0], /:dee$/);
    // The CRM agreeing clears what it said and appends nothing, so the owner stays the person's.
    await w.crm[path]("ben");
    assert.deepEqual([w.claims(), w.facts("ownerId")], [[], before]);
    await w.crm[path]("cy");
    assert.equal(await w.owner(), "ben");
  });
}

test("a Salesforce snapshot already seen leaves the owner a person chose since", async () => {
  const w = world();
  const snapshot = (memberId: string) => files["salesforceImportCanon.ts"].upsertDeals.handler(w.ctx(), {
    orgId: "org", instanceUrl: "https://sf.test", deals: [{
      sfId: "D1", name: "Big deal", currency: "USD", closeDate: "2026-12-01", stage: "prospecting", probability: 0.1, isClosed: false, isWon: false,
      dealType: "new_business", revenueType: "one_time", memberId, accountSfId: "001A", modifiedAt: Date.UTC(2026, 9, 1),
    }],
  });
  await snapshot("users:ana");
  await w.write({ ownerId: "users:ben" });
  await snapshot("users:cy");
  assert.deepEqual([await w.owner(), await w.pageOwner()], ["ben", "ben"]);
});

test("a person who clears the owner keeps it clear; the CRM's owner is noted", async () => {
  const w = world();
  await w.crm.hubspot("ana");
  await w.write({ ownerId: null });
  await w.crm.hubspot("cy");
  assert.deepEqual([await w.owner(), await w.pageOwner(), w.claims()], [null, null, ["ownerId:hubspot:cy"]]);
});

test("using the CRM's owner applies it and hands the owner back, so the next CRM change lands", async () => {
  const w = world();
  await w.crm.salesforceSync("ana");
  await w.write({ ownerId: "users:ben" });
  await w.crm.salesforceSync("cy");
  await w.take();
  assert.deepEqual([await w.owner(), w.claims()], ["cy", []]);
  await w.crm.salesforceSync("dee");
  assert.equal(await w.owner(), "dee");
  // The person putting back the owner they chose before takes it again, though their own record said it already.
  await w.write({ ownerId: "users:ben" });
  await w.crm.salesforceSync("cy");
  assert.deepEqual([await w.owner(), w.claims()], ["ben", ["ownerId:salesforce:cy"]]);
});

test("a person editing the owner again clears what the CRM said", async () => {
  const w = world();
  await w.crm.hubspot("ana");
  await w.write({ ownerId: "users:ben" });
  await w.crm.hubspot("cy");
  await w.write({ ownerId: "users:dee" });
  assert.deepEqual(w.claims(), []);
});

test("an automation rule's owner and a CSV import's owner do not hold", async () => {
  for (const source of [{ kind: "user", userId: "users:admin", automation: { ruleId: "r1", depth: 1 } }, { kind: "csv", ref: "csv:imp1:1", actorId: "users:admin" }]) {
    const w = world();
    await w.crm.hubspot("ana");
    await w.write({ ownerId: "users:ben" }, source);
    await w.crm.hubspot("cy");
    assert.deepEqual([await w.owner(), w.claims()], ["cy", []], source.kind);
  }
});

test("two CRMs are held against one at a time, each keeping what it says", async () => {
  const w = world();
  await w.crm.hubspot("ana");
  await w.write({ ownerId: "users:ben" });
  await w.crm.hubspot("cy");
  await w.crm.salesforceSync("dee");
  assert.deepEqual([await w.owner(), w.claims()], ["ben", ["ownerId:hubspot:cy", "ownerId:salesforce:dee"]]);
});

test("Salesforce's company holds against a person's company and clear, and follows Salesforce when no person set it", async () => {
  const w = world();
  await w.crm.salesforceImport("ana", "001A");
  await w.crm.salesforceImport("ana", "001B");
  assert.equal((await w.deal()).companyId, "acc_b");
  await w.crm.salesforceImport("ana", null);
  assert.equal((await w.deal()).companyId, undefined);
  await w.crm.salesforceImport("ana", "001A");
  await w.write({ companyId: "acc_b" });
  await w.crm.salesforceImport("ana", "001A");
  // The import reports the held company as written, not as rejected.
  const out = await w.crm.salesforceImport("ana", null);
  assert.deepEqual(plain([(await w.deal()).companyId, w.claims(), out.rejected]), ["acc_b", ["companyId:salesforce:null"], []]);
  await w.write({ companyId: null });
  await w.crm.salesforceImport("ana", "001A");
  assert.deepEqual([(await w.deal()).companyId, w.claims()], [undefined, ["companyId:salesforce:acc_a"]]);
});

test("a write reports the fields a person holds as held, not rejected", async () => {
  const w = world();
  await w.crm.hubspot("ana");
  await w.write({ ownerId: "users:ben" });
  const out = await w.write({ ownerId: "users:cy", name: "Bigger deal" }, { kind: "hubspot", crmId: "D1" });
  assert.deepEqual(plain([out.held, out.rejected, out.result.status, (await w.deal()).name]), [["ownerId"], [], "applied", "Bigger deal"]);
});

test("a merge's pick is a person's and holds", async () => {
  const w = world();
  const objects = files["objects.ts"] as any;
  const store = objects.convexObjectStore(w.ctx());
  await w.crm.hubspot("ana");
  const streamId = await w.stream();
  const def = await objects.loadDef(w.ctx(), "org", "deal");
  const at = (source: EntrySource, actor: EntryActor) => ({ orgId: "org", def, source, actor, now: TickingDate.now() });
  const { save } = await import("../convex/lib/objects/write.ts");
  await save(store, at({ kind: "user", ref: "user:users:admin:merge-pick:m1" }, { kind: "user", id: "users:admin" }), { op: "update", streamId, values: { ownerId: "users:ben" }, reassert: true });
  const out = await save(store, at({ kind: "hubspot", ref: "hubspot:D1" }, { kind: "integration", id: "hubspot" }), { op: "update", streamId, values: { ownerId: "users:cy" }, reassert: true });
  assert.deepEqual([out.status, (out as { held?: string[] }).held], ["unchanged", ["ownerId"]]);
});

test("a deal written to facts only, before its stream converts, holds the same way", async () => {
  const facts: StoredFact[] = [];
  const store = {
    latestBySourceRef: async (_o: string, ref: string) => facts.filter((f) => f.sourceRef === ref).at(-1) ?? null,
    insertFact: async (f: Omit<StoredFact, "_id">) => (facts.push({ ...f, _id: `f${facts.length}` } as StoredFact), `f${facts.length - 1}`),
    confirmFact: async () => {},
    factsFor: async (_e: string, attribute: string) => facts.filter((f) => f.attribute === attribute).reverse(),
    upsertFieldState: async () => {},
  } as unknown as LedgerStore;
  const ingest = (sourceKind: "user" | "hubspot", sourceRefBase: string, value: string) => ingestObservations(store, {
    orgId: "org", entityId: "e1", sourceKind, sourceRefBase, actor: sourceKind === "user" ? { kind: "user", id: "u" } : { kind: "integration", id: "hubspot" },
    observedAt: TickingDate.now(), observations: [{ attribute: "ownerId", value }],
  });
  await ingest("hubspot", "hubspot:D1", "ana");
  await ingest("user", "user:u:e1", "ben");
  const out = await ingest("hubspot", "hubspot:D1", "cy");
  assert.deepEqual([out.held, out.written, out.resolved.ownerId?.value], [["ownerId"], 0, "ben"]);
  await ingest("user", "automation:r1:1:user:u:e1", "dee");
  assert.deepEqual((await ingest("hubspot", "hubspot:D1", "cy")).held, []);
});

test("an owner written back to the CRM stays the approver's choice, and the CRM's echo is agreement", async () => {
  const w = world();
  await w.crm.hubspot(null);
  await files["ownership.ts"].patchDealOwner.handler(w.ctx(), { dealId: (await w.deal())._id, userId: "users:ben", crmOwnerId: "hs-ben", approvedBy: "users:admin" });
  const before = w.facts("ownerId");
  await w.crm.hubspot("ben");
  assert.deepEqual([await w.owner(), w.claims(), w.facts("ownerId")], ["ben", [], before]);
  await w.crm.hubspot("cy");
  assert.deepEqual([await w.owner(), w.claims()], ["ben", ["ownerId:hubspot:cy"]]);
});

test("replaying a workspace's ledger reproduces a CRM that overwrote a person before the rule", async () => {
  const w = world();
  await w.crm.hubspot("ana");
  const streamId = await w.stream();
  const objects = files["objects.ts"] as any;
  const def = await objects.loadDef(w.ctx(), "org", "deal");
  const { appendHistory } = await import("../convex/lib/objects/write.ts");
  const { project } = await import("../convex/lib/objects/fold.ts");
  const version = Math.max(...w.db.rows("ledgerEntries").map((e: any) => e.version));
  const entry = (v: number, source: unknown, actor: unknown, value: string) =>
    ({ streamId, version: v, observedAt: TickingDate.now(), source, actor, body: { kind: "assert", status: "accepted", assertions: [{ fieldId: "ownerId", value }] } });
  const state = await appendHistory(objects.convexObjectStore(w.ctx()), { orgId: "org", def, now: TickingDate.now() }, streamId, [
    entry(version + 1, { kind: "user", ref: "user:users:admin:x" }, { kind: "user", id: "users:admin" }, "users:ben"),
    entry(version + 2, { kind: "hubspot", ref: "hubspot:D1" }, { kind: "integration", id: "hubspot" }, "users:cy"),
  ] as never);
  assert.equal(project(def, state!).values.ownerId, "users:cy");
});

for (const path of PATHS) {
  test(`${path}: every synced value a person set holds, and the stage and the amount are each noted once`, async () => {
    const w = world();
    await send(w, path, FIRST);
    // A person's stage holds its whole group: the CRM's forecast, probability, closed, won and closed date don't land.
    await w.write({ name: "Mine", amount: 777, closeDate: "2027-03-01", dealType: "renewal", stage: "negotiation" });
    await send(w, path, NEXT);
    const d = await w.deal();
    assert.deepEqual(plain(synced(d)), { ...synced(FIRST), name: "Mine", amount: 777, closeDate: "2027-03-01", dealType: "renewal", stage: "negotiation", currency: "USD" }, path);
    assert.equal(d.closedAt, undefined, path);
    assert.deepEqual(w.claims().map((c: string) => c.split(":")[0]), ["amount", "closeDate", "dealType", "name", "stage"], path);
    assert.equal((await cost(w, () => send(w, path, NEXT))).entries, 0, path);
  });
}

test("using the CRM's stage hands back its whole group, dates the close, and the CRM's next outcome lands", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await w.crm.salesforceSync("ana", FIRST);
  await w.write({ stage: "negotiation", forecastCategory: "commit" });
  await w.crm.salesforceSync("ana", NEXT);
  const notes = await (files["fieldClaims.ts"] as any).forDeal.handler(w.ctx(), { streamId: await w.stream() });
  assert.deepEqual(plain(notes.map((n: any) => [n.field, n.values.map((v: any) => v.field)])), [["stage", ["stage", "forecastCategory", "probability", "isClosed", "isWon"]]]);
  await w.take();
  const d = await w.deal();
  assert.deepEqual(plain([d.stage, d.forecastCategory, d.probability, d.isClosed, d.isWon, typeof d.closedAt, w.claims()]), ["closed_won", "closed_won", 1, true, true, "number", []]);
  await w.crm.salesforceSync("ana", { ...NEXT, stage: "closed_lost", forecastCategory: "closed_lost", isWon: false, probability: 0 });
  assert.deepEqual(plain([(await w.deal()).stage, (await w.deal()).isWon]), ["closed_lost", false]);
});

test("settling a contested field on a CRM's value hands it back to that CRM; on a person's, it holds", async () => {
  for (const pick of ["salesforce", "user"] as const) {
    const w = world();
    signedIn = await w.db.get("users:admin");
    await w.crm.salesforceSync("ana", FIRST);
    await w.write({ name: "Their name" }, { kind: "salesforce", crmId: "D1" });
    await w.write({ name: "My name" });
    const fact = w.db.rows("facts").filter((f: any) => f.attribute === "name" && f.sourceKind === pick).at(-1);
    await (files["canonGate.ts"] as any).resolveContested.handler(w.ctx(), { factId: fact!._id });
    await w.crm.salesforceSync("ana", NEXT);
    assert.equal((await w.deal()).name, pick === "salesforce" ? "Bigger deal" : "My name", pick);
  }
});

test("settling on a CRM's stage needs every field of its group to be editable by the reviewer", async () => {
  const w = world();
  await w.db.insert("users", { _id: "users:mgr", orgId: "org", name: "mgr", role: "manager", isActive: true });
  await w.db.insert("rolePermissions", { orgId: "org", role: "manager", rules: [{ object: "deal", fields: [{ apiName: "forecastCategory", level: "readOnly" }] }] });
  signedIn = await w.db.get("users:mgr");
  await w.crm.salesforceSync("ana", FIRST);
  await w.write({ stage: "qualification", forecastCategory: "best_case" }, { kind: "salesforce", crmId: "D1" });
  await w.write({ stage: "negotiation" });
  const fact = w.db.rows("facts").filter((f: any) => f.attribute === "stage" && f.sourceKind === "salesforce").at(-1)!;
  await assert.rejects((files["canonGate.ts"] as any).resolveContested.handler(w.ctx(), { factId: fact._id }), /forecastCategory|Forecast category|read-only/i);
  assert.equal((await w.deal()).stage, "negotiation");
});

test("a Salesforce snapshot already seen leaves the closed date of a stage a person holds", async () => {
  const w = world();
  const snapshot = () => w.crm.salesforceImport("ana", undefined, { ...NEXT, modifiedAt: Date.UTC(2026, 9, 1) });
  await snapshot();
  await w.write({ stage: "negotiation", forecastCategory: "commit", isClosed: false, isWon: false });
  assert.equal((await w.deal()).closedAt, undefined);
  await snapshot();
  assert.deepEqual(plain([(await w.deal()).isClosed, (await w.deal()).closedAt ?? null]), [false, null]);
});

/** The admin page (convex/crmDisagreements.ts): its list, a selection, and a job that runs its scheduled steps. */
const page = files["crmDisagreements.ts"] as any;
const listed = async (w: ReturnType<typeof world>, filter: Record<string, string> = {}) =>
  plain((await page.list.handler(w.ctx(), { ...filter, paginationOpts: { numItems: 50, cursor: null } })).page.map((r: any) => `${r.field}:${r.provider}:${r.title}`).sort());

test("the disagreements page lists what each CRM says by field, filters by CRM and field, and shows nothing to a non-admin", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await w.crm.hubspot("ana", FIRST);
  await w.write({ name: "Mine", stage: "negotiation" });
  await w.crm.hubspot("ana", NEXT);
  await w.crm.salesforceSync("ana", NEXT);
  assert.deepEqual(await listed(w), ["name:hubspot:Mine", "name:salesforce:Mine", "stage:hubspot:Mine", "stage:salesforce:Mine"]);
  assert.deepEqual(await listed(w, { provider: "salesforce", field: "stage" }), ["stage:salesforce:Mine"]);
  signedIn = { ...(await w.db.get("users:ben")), role: "manager" };
  assert.deepEqual(await listed(w), []);
});

test("an amount row carries its currency when Canon and the CRM agree on it", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await w.crm.salesforceImport("ana", undefined, { amount: 1000, currency: "EUR" });
  await w.write({ amount: 900 });
  await w.crm.salesforceImport("ana", undefined, { amount: 1200, currency: "EUR" });
  const [row] = (await page.list.handler(w.ctx(), { paginationOpts: { numItems: 50, cursor: null } })).page;
  assert.deepEqual(plain([row.values, row.currency]), [[{ field: "amount", crm: 1200, canon: 900 }], { crm: "EUR", canon: "EUR" }]);
});

test("using the CRM's values for a selection hands each field back to its CRM", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await w.crm.salesforceSync("ana", FIRST);
  await w.write({ name: "Mine", stage: "negotiation" });
  await w.crm.salesforceSync("ana", NEXT);
  const ids = w.db.rows("parentDisagreements").map((d: any) => d._id);
  const out = await page.useCrmValues.handler(w.ctx(), { ids });
  const d = await w.deal();
  assert.deepEqual(plain([out.taken, out.failed, d.name, d.stage, d.isWon, w.claims()]), [2, [], "Bigger deal", "closed_won", true, []]);
});

test("using the CRM's values for a whole filter runs as a job, step by step, and reports its progress", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  const queued: Array<{ args: unknown }> = [];
  const ctx = () => ({ ...w.ctx(), scheduler: { runAfter: async (_ms: number, _fn: unknown, args: unknown) => { queued.push({ args }); } } });
  const deals = (name: (i: number) => string) => Array.from({ length: 25 }, (_, i) => ({ crmId: `J${i}`, name: name(i), closeDate: "2026-12-01", dealType: "new_business", revenueType: "one_time", isClosed: false, isWon: false }));
  await files["hubspot.ts"].upsertDeals.handler(w.ctx(), { orgId: "org", deals: deals((i) => `Deal ${i}`) });
  for (const d of w.db.rows("deals")) await canon.saveDealValues(w.ctx(), d, { kind: "user", userId: "users:admin" }, { name: `${d.name} (mine)` });
  await files["hubspot.ts"].upsertDeals.handler(w.ctx(), { orgId: "org", deals: deals((i) => `Deal ${i} renamed`) });
  assert.equal(w.claims().length, 25);
  await page.startUseAll.handler(ctx(), { provider: "hubspot", field: "name" });
  let steps = 0;
  while (queued.length) { await page.runJob.handler(ctx(), queued.shift()!.args); steps++; }
  const { job } = await page.status.handler(w.ctx(), {});
  assert.deepEqual(plain([steps > 1, job.status, job.taken, job.failed, w.claims().length]), [true, "done", 25, 0, 0]);
  assert.ok(w.db.rows("deals").every((d: any) => d.name.endsWith("renamed")));
});

test("a field set to always follow a CRM takes that CRM's value over a person's, with no note; the other CRM is still held", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await page.setFollow.handler(w.ctx(), { provider: "salesforce", field: "stage", follow: true });
  await w.crm.salesforceSync("ana", FIRST);
  await w.write({ stage: "negotiation", name: "Mine" });
  await w.crm.salesforceSync("ana", NEXT);
  const d = await w.deal();
  // The whole stage group follows Salesforce; the name, not set to follow, still holds.
  assert.deepEqual(plain([d.stage, d.isWon, d.name, w.claims().map((c: string) => c.split(":")[0])]), ["closed_won", true, "Mine", ["name"]]);
  await w.write({ stage: "negotiation" });
  await w.crm.hubspot("ana", NEXT);
  assert.equal((await w.deal()).stage, "negotiation");
  signedIn = { ...(await w.db.get("users:ben")), role: "manager" };
  await assert.rejects(page.setFollow.handler(w.ctx(), { provider: "hubspot", field: "name", follow: true }));
});

test("a followed field takes back what the CRM says on its next sync, though the CRM repeats a value it sent before", async () => {
  for (const path of PATHS) {
    const w = world();
    signedIn = await w.db.get("users:admin");
    // The import resends one Salesforce snapshot; the syncs resend the same values, which their fingerprint would skip.
    const same = path === "salesforceImport" ? { ...FIRST, modifiedAt: Date.UTC(2026, 9, 1) } : FIRST;
    await send(w, path, same);
    await w.write({ stage: "negotiation", closeDate: "2027-05-01" });
    await page.setFollow.handler(w.ctx(), { provider: path === "hubspot" ? "hubspot" : "salesforce", field: "stage", follow: true });
    await send(w, path, same);
    assert.deepEqual(plain([(await w.deal()).stage, (await w.deal()).closeDate]), ["prospecting", "2027-05-01"], path);
    // A person's edit after the setting lasts until the next sync too.
    await w.write({ stage: "proposal" });
    await send(w, path, same);
    assert.equal((await w.deal()).stage, "prospecting", path);
  }
});

/**
 * Every file that writes field values to the deal and party ledgers, and as whom. An `integration` is a CRM: it writes
 * through the ledger as its CRM record (lib/canon/personHold.ts holds a person's values against it) and never patches
 * a held column itself. A `person` writes as the member acting; `import` as a CSV or backfill source; `canon` as a
 * Canon field; `writer` is the ledger itself; `seed` is demo data. A new writer must be added here with a test.
 */
const FIELD_WRITERS: Record<string, "integration" | "person" | "import" | "canon" | "writer" | "seed"> = {
  "convex/lib/canon/dealLedger.ts": "writer",
  "convex/lib/canon/partyLedger.ts": "writer",
  "convex/canon.ts": "writer",
  "convex/hubspot.ts": "integration",
  "convex/salesforce.ts": "integration",
  "convex/salesforceImportCanon.ts": "integration",
  "convex/hubspotImport.ts": "integration",
  // The Salesforce register sync writes companies and people through canon.saveSyncedRecordPatch.
  "convex/salesforceSync.ts": "integration",
  "convex/ownership.ts": "person",
  "convex/fieldClaims.ts": "person",
  "convex/deals.ts": "person",
  "convex/objects.ts": "person",
  "convex/callSuggestions.ts": "person",
  "convex/canonGate.ts": "person",
  "convex/dealGaps.ts": "person",
  "convex/recordMerges.ts": "person",
  "convex/lib/canon/partyMerge.ts": "person",
  "convex/csvImports.ts": "import",
  "convex/lib/objects/csvImport.ts": "import",
  "convex/canonEntities.ts": "import",
  "convex/fieldConsolidations.ts": "canon",
  "convex/devSeed.ts": "seed",
  "convex/devPerfSeed.ts": "seed",
  "convex/sampleData.ts": "seed",
};
/**
 * The deal columns a person holds that a ledger write projects (lib/canon/personHold.ts): only the deal writer patches
 * them. The owner and company never reach a row from a CRM path; the rest may start a new deal's row.
 */
const HELD_COLUMNS = PERSON_HELD_FIELDS.deal!.map((f) => (f === "ownerId" ? "primaryRepId" : f));
const NEVER_INSERTED = ["primaryRepId", "companyId"];

/** The text of each call's arguments, from `start` to its closing parenthesis. */
function callArgs(source: string, start: RegExp): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(start)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const from = i;
    for (; i < source.length && depth > 0; i++) depth += source[i] === "(" ? 1 : source[i] === ")" ? -1 : 0;
    out.push(source.slice(from, i - 1));
  }
  return out;
}

test("every field writer is listed, and no CRM path writes a held column to the deals row itself", () => {
  const root = join(import.meta.dirname, "..");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "_generated" || name === "node_modules") continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /\b(saveDeal|saveDealValues|saveDealEdit|writeDeal|saveParty|saveCrmAccount|saveCrmContact|saveSyncedRecordPatch|writeParty)\(|internal\.canon\.saveSyncedRecordPatch\b/.test(readFileSync(path, "utf8"))) found.push(relative(root, path));
    }
  };
  for (const dir of ["convex", "modules/kernel", "services/record-service/src"]) walk(join(root, dir));
  assert.deepEqual(found.sort(), Object.keys(FIELD_WRITERS).sort());
  // A CRM path's row values are built in its own file, or for HubSpot in lib/hubspotSyncValue.ts.
  const sources = [...Object.keys(FIELD_WRITERS).filter((f) => FIELD_WRITERS[f] === "integration"), "convex/lib/hubspotSyncValue.ts"].map((file) => [file, readFileSync(join(root, file), "utf8")] as const);
  for (const [file, source] of sources) {
    // What a CRM path writes to a row: each db write's arguments, and the row values its sync builds (`…SyncValue`).
    const writes = [...callArgs(source, /ctx\.db\.(?:patch|insert|replace)\(/g), ...source.split(/function \w+SyncValue\(/).slice(1).map((t) => t.split("\n}\n")[0]!)];
    for (const text of writes) for (const column of NEVER_INSERTED) assert.doesNotMatch(text, new RegExp(`\\b${column}\\b`), `${file} writes ${column} to a row: ${text.slice(0, 120)}`);
    // A deal's handlers patch none of its held columns, and its row builder (`deal…SyncValue`) names none: what the CRM
    // says about them (`deal…SyncValues`) goes to the ledger, or starts a new row.
    const dealHandlers = source.split(/\nexport const (?:prepareDeals|upsertDeals) = /).slice(1).map((t) => t.split(/\n(?:export )?(?:const|function|async function) /)[0]!);
    const dealWrites = [...dealHandlers.flatMap((t) => callArgs(t, /ctx\.db\.(?:patch|replace)\(/g)), ...source.split(/function deal\w*SyncValue\(/).slice(1).map((t) => t.split("\n}\n")[0]!)];
    for (const text of dealWrites) {
      assert.doesNotMatch(text, /SyncValues\(/, `${file} patches a deal with the CRM's values: ${text.slice(0, 120)}`);
      for (const column of HELD_COLUMNS) assert.doesNotMatch(text, new RegExp(`\\b${column}\\b`), `${file} writes ${column} to a deal's row: ${text.slice(0, 120)}`);
    }
  }
  // The census sees each CRM path's deal handlers.
  assert.equal(sources.filter(([, t]) => /\nexport const upsertDeals = /.test(t)).length, 3);
});

// A CRM import into the record service (Salesforce's bulk import, an API upsert) never changes a ledger column of a row
// on the ledger (services/record-service/src/register.ts LEDGER_OWNED): a company's or person's held field reaches the
// row only from its stream, where the hold applies.
test("the record service keeps every held company and person field of a row on the ledger from a CRM import", () => {
  for (const object of ["account", "contact"] as const) {
    assert.deepEqual(PERSON_HELD_FIELDS[object]!.filter((f) => !(f in REGISTER_COLUMNS[object])), [], object);
  }
});
