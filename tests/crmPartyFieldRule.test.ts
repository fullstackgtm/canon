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
/** The member a public function runs as. */
let signedIn: unknown = null;
const files = loadConvex(["hubspot.ts", "salesforce.ts", "canon.ts", "objects.ts", "fieldClaims.ts", "crmDisagreements.ts", "canonGate.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => signedIn }),
}, { Date: TickingDate });
const canon = files["canon.ts"] as any;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

type Party = "account" | "contact";
/** A workspace with two reps, and a company and a person each CRM path writes. */
function world() {
  const db = memoryDb({
    organizations: [{ _id: "org" }],
    users: ["admin", "ana", "ben"].map((n) => ({ _id: `users:${n}`, orgId: "org", name: n, role: "admin", isActive: true })),
  });
  const ctx = (): any => ({ db, scheduler: { runAfter: async () => null } });
  const account = (v: Record<string, unknown> = {}) => ({ crmId: "C1", name: "Acme", domain: "acme.test", industry: "Software", employeeCount: 50, ownerId: "users:ana", ...v });
  const contact = (v: Record<string, unknown> = {}) => ({ crmId: "P1", firstName: "Pat", lastName: "Lee", email: "pat@acme.test", title: "VP Sales", phone: "+1 555 0100", ownerId: "users:ana", ...v });
  const crm = {
    hubspot: (object: Party, v?: Record<string, unknown>) => object === "account"
      ? files["hubspot.ts"].upsertAccounts.handler(ctx(), { orgId: "org", accounts: [account(v)] })
      : files["hubspot.ts"].upsertContacts.handler(ctx(), { orgId: "org", contacts: [contact(v)] }),
    salesforceSync: (object: Party, v?: Record<string, unknown>) => object === "account"
      ? files["salesforce.ts"].upsertAccounts.handler(ctx(), { orgId: "org", accounts: [account(v)] })
      : files["salesforce.ts"].upsertContacts.handler(ctx(), { orgId: "org", contacts: [contact(v)] }),
  };
  /** The record a CRM path wrote, by its CRM id. */
  const stream = async (object: Party, provider = "hubspot") => {
    const crmId = object === "account" ? "C1" : "P1";
    const ext = await db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q: any) => q.eq("orgId", "org").eq("provider", `${provider}:${object}`).eq("externalId", crmId)).first();
    return ext?.entityId as string;
  };
  /** The record's values in Canon: its projection. */
  const values = async (object: Party, provider?: string) => {
    const objects = files["objects.ts"] as any;
    const state = await objects.convexObjectStore(ctx()).getHotRow(await stream(object, provider));
    const { project } = await import("../convex/lib/objects/fold.ts");
    return project(await objects.loadDef(ctx(), "org", object), state).values;
  };
  /** The Salesforce register sync's change to a record on the ledger (salesforceSync.ts registerRecordPort), as it sends it. */
  let op = 0;
  const register = async (object: Party, patch: Record<string, string | number | null>) => canon.saveSyncedRecordPatch.handler(ctx(), {
    orgId: "org", object, recordId: object === "account" ? "acc_1" : "con_1", sfId: object === "account" ? "C1" : "P1", streamId: await stream(object, "salesforce"),
    patch, at: TickingDate.now(), reassert: true, idempotencyKey: `op${++op}`,
  });
  /** A person's edit on the record's page (records.edit). */
  const edit = async (object: Party, patch: Record<string, unknown>, provider = "hubspot") => canon.saveRecordEdit.handler(ctx(), {
    orgId: "org", userId: "users:admin", object, recordId: object === "account" ? "acc_1" : "con_1", patch, idempotencyKey: `edit${++op}`, streamId: await stream(object, provider),
  });
  const claims = () => db.rows("parentDisagreements").map((d: any) => `${d.object}.${d.attribute}:${d.provider}:${JSON.stringify(d.crmValue)}`).sort();
  const take = async (i = 0) => (files["fieldClaims.ts"] as any).takeCrmValue(ctx(), await db.get("users:admin"), db.rows("parentDisagreements")[i]._id);
  return { db, ctx, crm, stream, values, register, edit, claims, take };
}
type Path = keyof ReturnType<typeof world>["crm"];
const PATHS: Path[] = ["hubspot", "salesforceSync"];
const provider = (path: Path) => (path === "hubspot" ? "hubspot" : "salesforce");

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

const pick = (v: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, v[k] ?? null]));
const ACCOUNT = ["name", "domain", "industry", "employees", "ownerId"] as const;
const CONTACT = ["fullName", "email", "title", "phone", "ownerId"] as const;

// Pinned before the change: a company or person no person touched takes every value each CRM sends, and an unchanged re-sync costs nothing.
test("an untouched company and person take each CRM's values as before, and an unchanged re-sync appends and writes nothing", async () => {
  for (const path of PATHS) {
    const w = world();
    await w.crm[path]("account");
    await w.crm[path]("account", { name: "Acme Inc", industry: "Fintech", employeeCount: 80, ownerId: "users:ben" });
    assert.deepEqual(plain(pick(await w.values("account", provider(path)), ACCOUNT)), { name: "Acme Inc", domain: "acme.test", industry: "Fintech", employees: 80, ownerId: "users:ben" }, path);
    await w.crm[path]("contact");
    await w.crm[path]("contact", { lastName: "Lee-Ray", title: "CRO", phone: "+1 555 0199", ownerId: "users:ben" });
    assert.deepEqual(plain(pick(await w.values("contact", provider(path)), CONTACT)), { fullName: "Pat Lee-Ray", email: "pat@acme.test", title: "CRO", phone: "+1 555 0199", ownerId: "users:ben" }, path);
    for (const object of ["account", "contact"] as const) {
      const v = object === "account" ? { name: "Acme Inc", industry: "Fintech", employeeCount: 80, ownerId: "users:ben" } : { lastName: "Lee-Ray", title: "CRO", phone: "+1 555 0199", ownerId: "users:ben" };
      assert.deepEqual(await cost(w, () => w.crm[path](object, v)), { writes: 0, entries: 0 }, `${path} ${object}`);
    }
  }
});

test("an untouched company takes the Salesforce register sync's change as before", async () => {
  const w = world();
  await w.crm.salesforceSync("account");
  const streamId = await w.stream("account", "salesforce");
  const patch = (industry: string, key: string) => canon.saveSyncedRecordPatch.handler(w.ctx(), {
    orgId: "org", object: "account", recordId: "acc_1", sfId: "C1", streamId, patch: { industry }, at: TickingDate.now(), reassert: true, idempotencyKey: key,
  });
  const out = await patch("Fintech", "k1");
  assert.deepEqual(plain([out.rejected, (await w.values("account", "salesforce")).industry]), [[], "Fintech"]);
});

/** Each CRM path's write of a company, and what it says about it. */
const ALL: Array<"hubspot" | "salesforceSync" | "register"> = ["hubspot", "salesforceSync", "register"];
async function sendAccount(w: ReturnType<typeof world>, path: (typeof ALL)[number], v: { name: string; industry: string }) {
  if (path === "register") return w.register("account", v);
  return w.crm[path]("account", v);
}

for (const path of ALL) {
  test(`${path}: a company field a person set holds, the CRM's value is noted once, and agreeing clears it and appends nothing`, async () => {
    const w = world();
    await w.crm[path === "hubspot" ? "hubspot" : "salesforceSync"]("account");
    const p = path === "hubspot" ? "hubspot" : "salesforce";
    await w.edit("account", { name: "Acme (ours)" }, p);
    const out = await sendAccount(w, path, { name: "Acme Corp", industry: "Fintech" });
    await sendAccount(w, path, { name: "Acme Corp", industry: "Fintech" });
    // The sync takes the held field as written, not refused, and the field it does not hold lands.
    if (path === "register") assert.deepEqual(plain(out.rejected), []);
    assert.deepEqual(plain([(await w.values("account", p)).name, (await w.values("account", p)).industry, w.claims()]), ["Acme (ours)", "Fintech", [`account.name:${p}:"Acme Corp"`]], path);
    // The register sync sends each Salesforce change once, reasserted; a sync's unchanged re-send costs nothing.
    if (path !== "register") assert.equal((await cost(w, () => sendAccount(w, path, { name: "Acme Corp", industry: "Fintech" }))).entries, 0, path);
    await sendAccount(w, path, { name: "Acme (ours)", industry: "Fintech" });
    assert.deepEqual([w.claims(), (await w.values("account", p)).name], [[], "Acme (ours)"], path);
  });
}

test("a person's owner, title and phone hold against each CRM; their other emails hold the primary with them, noted once", async () => {
  const w = world();
  await w.crm.hubspot("contact");
  await w.edit("contact", { title: "Head of Revenue", ownerId: "users:ben", phone: null, additionalEmails: ["pat@home.test"] });
  await w.crm.hubspot("contact", { title: "CRO", ownerId: "users:ana", phone: "+1 555 0101", email: "pat@new.test" });
  await w.crm.salesforceSync("contact", { title: "CRO" });
  const v = await w.values("contact");
  assert.deepEqual(plain([v.title, v.ownerId, v.phone, v.email, v.additionalEmails]), ["Head of Revenue", "users:ben", null, "pat@acme.test", ["pat@home.test"]]);
  assert.deepEqual(w.claims(), [
    'contact.email:hubspot:"pat@new.test"', 'contact.ownerId:hubspot:"users:ana"', 'contact.ownerId:salesforce:"users:ana"',
    'contact.phone:hubspot:"+1 555 0101"', 'contact.phone:salesforce:"+1 555 0100"', 'contact.title:hubspot:"CRO"', 'contact.title:salesforce:"CRO"',
  ]);
});

test("using a CRM's email releases the person's other emails with it, though the CRM never sent them", async () => {
  const w = world();
  await w.crm.hubspot("contact");
  await w.edit("contact", { additionalEmails: ["pat@home.test"] });
  await w.crm.hubspot("contact", { email: "pat@new.test" });
  await w.take();
  assert.deepEqual(plain([(await w.values("contact")).email, (await w.values("contact")).additionalEmails, w.claims()]), ["pat@new.test", ["pat@home.test"], []]);
  await w.crm.hubspot("contact", { email: "pat@newer.test" });
  assert.equal((await w.values("contact")).email, "pat@newer.test");
});

test("using the CRM's value on a company hands the field back, so the CRM's next change lands", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  await w.crm.hubspot("account");
  await w.edit("account", { industry: "Robotics" });
  await w.crm.hubspot("account", { industry: "Fintech" });
  const notes = await (files["fieldClaims.ts"] as any).forRecord.handler(w.ctx(), { streamId: await w.stream("account") });
  assert.deepEqual(plain(notes.map((n: any) => [n.field, n.value])), [["industry", "Fintech"]]);
  await w.take();
  assert.deepEqual([(await w.values("account")).industry, w.claims()], ["Fintech", []]);
  await w.crm.hubspot("account", { industry: "Insurance" });
  assert.equal((await w.values("account")).industry, "Insurance");
});

test("settling a contested company field on a CRM's value hands it back to that CRM; on a person's, it holds", async () => {
  for (const pick of ["hubspot", "user"] as const) {
    const w = world();
    signedIn = await w.db.get("users:admin");
    await w.crm.hubspot("account");
    await w.edit("account", { industry: "Robotics" });
    const fact = w.db.rows("facts").filter((f: any) => f.attribute === "industry" && f.sourceKind === pick).at(-1);
    await (files["canonGate.ts"] as any).resolveContested.handler(w.ctx(), { factId: fact!._id });
    await w.crm.hubspot("account", { industry: "Fintech" });
    assert.equal((await w.values("account")).industry, pick === "hubspot" ? "Fintech" : "Robotics", pick);
  }
});

test("a company field set to always follow a CRM takes its value over a person's, even on an unchanged re-sync; the other CRM is still held", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  const page = files["crmDisagreements.ts"] as any;
  await w.crm.hubspot("account");
  await w.edit("account", { name: "Acme (ours)", industry: "Robotics" });
  await page.setFollow.handler(w.ctx(), { provider: "hubspot", object: "account", field: "industry", follow: true });
  // HubSpot says what it said before: the setting alone makes the next sync write the company.
  await w.crm.hubspot("account");
  assert.deepEqual(plain([(await w.values("account")).industry, (await w.values("account")).name, w.claims()]), ["Software", "Acme (ours)", ['account.name:hubspot:"Acme"']]);
  // A person's edit since lasts until the next sync, though HubSpot still says the same.
  await w.edit("account", { industry: "Robotics" });
  await w.crm.hubspot("account");
  assert.equal((await w.values("account")).industry, "Software");
  // The deal field of the same name is not followed, and an unchanged re-sync after that costs nothing.
  assert.deepEqual(plain(await page.follows.handler(w.ctx(), {})), [{ object: "account", field: "industry", provider: "hubspot" }]);
  assert.deepEqual(await cost(w, () => w.crm.hubspot("account")), { writes: 0, entries: 0 });
});

test("the disagreements page lists companies and people beside deals, by record type, and takes a whole filter as a job", async () => {
  const w = world();
  signedIn = await w.db.get("users:admin");
  const page = files["crmDisagreements.ts"] as any;
  await w.crm.hubspot("account");
  await w.crm.hubspot("contact");
  await w.edit("account", { name: "Acme (ours)" });
  await w.edit("contact", { title: "Head of Revenue" });
  await w.crm.hubspot("account", { name: "Acme Corp" });
  await w.crm.hubspot("contact", { title: "CRO" });
  const listed = async (filter: Record<string, string> = {}) =>
    plain((await page.list.handler(w.ctx(), { ...filter, paginationOpts: { numItems: 50, cursor: null } })).page.map((r: any) => `${r.object}:${r.field}:${r.title}:${r.pageId}`).sort());
  assert.deepEqual(await listed(), ["account:name:Acme (ours):acc_1", "contact:title:Pat Lee:con_1"]);
  assert.deepEqual(await listed({ object: "contact" }), ["contact:title:Pat Lee:con_1"]);
  assert.deepEqual(await listed({ object: "deal" }), []);
  const queued: unknown[] = [];
  const ctx = () => ({ ...w.ctx(), scheduler: { runAfter: async (_ms: number, _fn: unknown, args: unknown) => { queued.push(args); } } });
  await page.startUseAll.handler(ctx(), { object: "account" });
  while (queued.length) await page.runJob.handler(ctx(), queued.shift());
  assert.deepEqual([(await w.values("account")).name, (await w.values("contact")).title, w.claims()], ["Acme Corp", "Head of Revenue", ['contact.title:hubspot:"CRO"']]);
});
