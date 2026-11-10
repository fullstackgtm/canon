/**
 * A module and the fact ledger (docs/modules.md, "Facts", "Proposing facts"). facts.forRecords reads the fields of the
 * records its caller sees, planned in the call's query and read in its action; facts.propose holds facts on the review
 * queue through the gate's one writer, admitted through the caller's scoped client as a call's action admits them.
 * Avery, a rep, sees only her own companies when her role says so: Atlas Cloud, not Northstar Data. Rae is an admin.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadConvex, memoryDb, type Handler } from "./convexHandlers.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import type { Access } from "../convex/lib/access.ts";
import type { RecordReadSpec } from "../convex/lib/modules/recordReads.ts";
import type { ReadValue } from "../modules/kernel/calls.ts";
import { ID } from "../convex/lib/canon/identity.ts";
import { parseModuleManifest, type ModuleManifest } from "../modules/kernel/manifest.ts";
import { FACT_ATTRIBUTES, factsProposeProblem, type FactsProposeArgs } from "../modules/kernel/facts.ts";
import { STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import { declaredLabel } from "../convex/lib/agents/attribution.ts";

const ORG = "organizations:org";
const AVERY = "users:avery";
let signedIn: Record<string, unknown> | null = null;
let caller: { orgId: string; userId: string; access: Access } | null = null;
let records: ReturnType<typeof createFakeRecordClient>;
const RAE = "users:rae";
const M = loadConvex(["researchAgents.ts", "canonGate.ts", "canonEntities.ts", "permissions.ts", "lib/modules/canonReads.ts", "lib/modules/recordReadAction.ts", "lib/modules/factProposals.ts", "lib/modules/recordProposals.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn, requireUser: async () => signedIn }),
  "records.ts": (real) => ({
    ...real,
    requireCaller: async () => caller,
    callerClient: (_ctx: unknown, c: { access: Access }) => scopedRecordClient(records, [c.access], async () => null),
    principalClient: (_ctx: unknown, _org: unknown, accesses: Access[]) => scopedRecordClient(records, accesses, async () => null),
    clientFor: () => records,
  }),
});
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const fn = (path: string): Handler => {
  const [file, name] = path.replace(/^(internal|api)\./, "").split(".");
  const h = M[`${file}.ts`]![name]!;
  return { handler: async (ctx, args) => plain(await h.handler(ctx, args)) };
};
const perms = M["permissions.ts"] as unknown as { accessFor: (ctx: unknown, user: unknown) => Promise<Access> };
const plan = (M["lib/modules/canonReads.ts"] as unknown as { planRecordRead: (...args: unknown[]) => Promise<RecordReadSpec> }).planRecordRead;
const actionReads = M["lib/modules/recordReadAction.ts"] as unknown as typeof import("../convex/lib/modules/recordReadAction.ts");
const factProposals = M["lib/modules/factProposals.ts"] as unknown as typeof import("../convex/lib/modules/factProposals.ts");
const outcomes = (M["lib/modules/recordProposals.ts"] as unknown as typeof import("../convex/lib/modules/recordProposals.ts")).proposalOutcomes;
const admit = (M["canonGate.ts"] as unknown as typeof import("../convex/canonGate.ts")).admitProposalTargets;

/** A fixture module (Monthly goals) that also reads two company attributes and a deal's stage from the ledger. */
const base = JSON.parse(readFileSync("modules/examples/monthly-goals/module.json", "utf8"));
const parsed = parseModuleManifest({ ...base, facts: { companies: { read: ["industry", "custom.tier"], propose: ["industry", "custom.tier", "name", "employees"] }, deals: { read: ["stage"], propose: ["stage", "amount"] } } });
assert.equal(parsed.ok, true, JSON.stringify(parsed));
const manifest = (parsed as { manifest: ModuleManifest }).manifest;

const fact = (id: string, entity: string, attribute: string, value: unknown, observedAt: number, extra: Record<string, unknown> = {}) => ({
  _id: `facts:${id}`, orgId: ORG, entityId: `canonEntities:${entity}`, entityType: "account", attribute, value, status: "accepted", confidence: 0.9,
  evidence: `${id} says so`, observedAt, lastConfirmedAt: observedAt, sourceKind: "enrichment", sourceRef: id, actor: { kind: "integration", id: "enrichment" }, ...extra,
});
const state = (entity: string, attribute: string, value: unknown, factId: string, extra: Record<string, unknown> = {}) => ({
  _id: `canonFieldState:${entity}:${attribute}`, orgId: ORG, entityId: `canonEntities:${entity}`, attribute, value, factId: `facts:${factId}`, sourceKind: "enrichment", state: "resolved", updatedAt: 1, ...extra,
});

function seed(rules: Array<Record<string, unknown>>, more: Record<string, Array<Record<string, unknown>>> = {}) {
  const entity = (id: string, entityType: string, table: string) => ({ _id: `canonEntities:${id}`, orgId: ORG, entityType, projectionTable: table, projectionId: id, createdAt: 1 });
  return memoryDb({
    ...more,
    users: [{ _id: AVERY, orgId: ORG, role: "rep", isActive: true, name: "Avery Chen" }, { _id: RAE, orgId: ORG, role: "admin", isActive: true, name: "Rae Kim" }],
    rolePermissions: rules.length ? [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules }] : [],
    deals: [{ _id: "deals:big", orgId: ORG, name: "Big deal", primaryRepId: AVERY }],
    // The workspace's custom.tier: a research agent's answer slot.
    researchAgents: [{ _id: "researchAgents:tier", orgId: ORG, slug: "tier", entityType: "account", kind: "text", question: "Which tier?" }],
    canonEntities: [entity("atlas", "account", "recordAccounts"), entity("northstar", "account", "recordAccounts"), entity("deals:big", "opportunity", "deals")],
    canonExternalIds: ["atlas", "northstar"].map((id) => ({ _id: `canonExternalIds:${id}`, orgId: ORG, provider: ID.recordAccount, externalId: id, entityId: `canonEntities:${id}` })),
    facts: [
      // Atlas's industry: an old CRM value, then enrichment's, confirmed again at 900.
      fact("i1", "atlas", "industry", "Hardware", 100, { sourceKind: "salesforce", status: "superseded", actor: { kind: "integration", id: "salesforce" } }),
      fact("i2", "atlas", "industry", "Software", 200, { lastConfirmedAt: 900 }),
      fact("i3", "atlas", "industry", "SaaS", 300, { status: "proposed", actor: { kind: "user", id: AVERY } }),
      fact("t1", "atlas", "custom.tier", "A", 400),
      fact("t2", "atlas", "custom.tier", "B", 500),
      fact("n1", "northstar", "industry", "Data", 100),
      fact("s1", "deals:big", "stage", "negotiation", 50, { entityType: "opportunity" }),
    ],
    canonFieldState: [
      state("atlas", "industry", "Software", "i2"),
      state("atlas", "custom.tier", "A", "t1", { state: "contested", contestedBy: ["facts:t2"] }),
      state("northstar", "industry", "Data", "n1"),
      state("deals:big", "stage", "negotiation", "s1"),
    ],
  });
}

let scheduled: string[] = [];
/**
 * Signed in as `user`, with the record service holding Atlas (Avery's) and Northstar (Jordan's), on the ledger, and
 * Lumen (Avery's) and Orion (Jordan's), which aren't yet.
 */
async function as(db: ReturnType<typeof memoryDb>, user = AVERY) {
  const store = createMemoryRecordStore();
  const account = (id: string, ownerId: string, more: Partial<AccountRow> = {}) => ({ id, domain: `${id}.example`, name: id, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId, ...more }) as AccountRow;
  await store.putAccounts(ORG, [account("atlas", AVERY), account("northstar", "users:jordan"), account("lumen", AVERY, { country: "Canada" }), account("orion", "users:jordan")]);
  records = createFakeRecordClient({ store });
  signedIn = await db.get(user);
  caller = { orgId: ORG, userId: user, access: await perms.accessFor({ db }, signedIn) };
  const ctx = { db, runQuery: (ref: unknown, a: unknown) => fn(String(ref)).handler(ctx, a), runMutation: (ref: unknown, a: unknown) => fn(String(ref)).handler(ctx, a), scheduler: { runAfter: async (_ms: number, ref: unknown) => { scheduled.push(String(ref)); } } };
  return ctx;
}

/** Plan `facts.forRecords` in the call's query and read it in its action, as Avery. */
async function read(db: ReturnType<typeof memoryDb>, args: Record<string, unknown>, m = manifest): Promise<ReadValue> {
  const ctx = await as(db);
  const spec = await plan(ctx, ORG, caller!.access, m, "facts.forRecords", args, 100);
  const out: Record<string, ReadValue> = {};
  await actionReads.readRecordsOf(ctx as never, { records: { facts: spec } } as never, out);
  return plain(out.facts);
}

test("a module reads each declared field's value, state and last confirmation, and its newest receipts when asked", async () => {
  const db = seed([]);
  assert.deepEqual(await read(db, { object: "companies", ids: ["atlas", "gone"] }), [{
    id: "atlas",
    fields: [
      { attribute: "industry", value: "Software", state: "resolved", winner: "facts:i2", confirmedAt: 900 },
      { attribute: "custom.tier", value: "A", state: "contested", winner: "facts:t1", contestedBy: ["facts:t2"], confirmedAt: 400 },
    ],
  }]);
  const [row] = await read(db, { object: "companies", ids: ["atlas"], attributes: ["industry"], receipts: 2 }) as Array<{ receipts: Record<string, unknown[]> }>;
  assert.deepEqual(row!.receipts, { industry: [
    { id: "facts:i3", value: "SaaS", status: "proposed", source: { kind: "enrichment", actor: `user:${AVERY}` }, evidence: "i3 says so", confidence: 0.9, observedAt: 300, validFrom: null, lastConfirmedAt: 300, validTo: null, decidedAt: null },
    { id: "facts:i2", value: "Software", status: "accepted", source: { kind: "enrichment", actor: "integration:enrichment" }, evidence: "i2 says so", confidence: 0.9, observedAt: 200, validFrom: null, lastConfirmedAt: 900, validTo: null, decidedAt: null },
  ] });
  assert.deepEqual(await read(db, { object: "deals", ids: ["deals:big", "atlas"] }), [{ id: "deals:big", fields: [{ attribute: "stage", value: "negotiation", state: "resolved", winner: "facts:s1", confirmedAt: 50 }] }], "a company's id read as a deal reads nothing");
});

test("a company the caller can't see has no row, and a field their role hides has no field", async () => {
  const db = seed([{ object: "account", visibility: "own", unowned: false, fields: [{ apiName: "custom.tier", level: "hidden" }] }]);
  assert.deepEqual(await read(db, { object: "companies", ids: ["atlas", "northstar"], receipts: 1 }), [{
    id: "atlas",
    fields: [{ attribute: "industry", value: "Software", state: "resolved", winner: "facts:i2", confirmedAt: 900 }],
    receipts: { industry: [{ id: "facts:i3", value: "SaaS", status: "proposed", source: { kind: "enrichment", actor: `user:${AVERY}` }, evidence: "i3 says so", confidence: 0.9, observedAt: 300, validFrom: null, lastConfirmedAt: 300, validTo: null, decidedAt: null }] },
  }]);
});

test("a read is refused for an undeclared attribute or object, past 100 ids or 20 receipts, and outside a member's call", async () => {
  const db = seed([]);
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
  await assert.rejects(read(db, { object: "companies", ids: ["atlas"], attributes: ["industry", "employees"] }), /doesn't declare facts\.companies employees/);
  await assert.rejects(read(db, { object: "people", ids: ["sam"] }), /doesn't declare facts\.people/);
  await assert.rejects(read(db, { object: "companies", ids: ids(101) }), /at most 100 records/);
  assert.equal((await read(db, { object: "companies", ids: ids(100) }) as unknown[]).length, 0);
  await assert.rejects(read(db, { object: "companies", ids: ["atlas"], receipts: 21 }), /0 to 20 receipts/);
  await assert.rejects(plan({ db }, ORG, null, manifest, "facts.forRecords", { object: "companies", ids: ["atlas"] }, 100), /requires a member/);
  const job = { label: "Job", system: true, roles: ["admin"], agent: "allowed", writes: [], returns: "value", reads: { facts: { canon: "facts.forRecords", args: { object: "companies", ids: { arg: "ids" } } } } };
  assert.match(JSON.stringify(parseModuleManifest({ ...manifest, calls: { ...manifest.calls, job } })), /system call can't read them/);
});

/** Propose facts as Avery, admitting the companies they name as a call's action does; the plan's outcome as proposals.byIds reads it. */
async function propose(db: ReturnType<typeof memoryDb>, args: FactsProposeArgs) {
  const ctx = await as(db);
  const admitted = await admit(ctx as never, ORG as never, AVERY as never, factProposals.gateFacts(args));
  const { id } = await factProposals.proposeModuleFacts(ctx as never, { orgId: ORG as never, userId: AVERY as never, module: { id: manifest.id, title: manifest.title }, args, reason: "From the 10-K", admitted });
  const [outcome] = plain(await outcomes(ctx as never, ORG as never, manifest.id, caller!.access, [id]));
  return { id, outcome: outcome! };
}

test("a module's fact waits on the review queue as the member's, from the module, and once accepted facts.forRecords reads it", async () => {
  const db = seed([]);
  const { id, outcome } = await propose(db, { object: "companies", facts: [{ id: "atlas", attribute: "employees", value: 120, evidence: "Atlas Cloud's 10-K: 120 employees", confidence: 0.8 }] });
  assert.deepEqual([outcome.operation, outcome.status, outcome.total, outcome.pending, outcome.rejected], ["facts.propose", "pending_approval", 1, 1, []]);
  const fact = db.rows("facts").find((f) => f.value === 120)!;
  assert.deepEqual(plain([fact.status, fact.sourceKind, fact.actor, fact.evidence, fact.patchPlanId]), ["proposed", "agent_run", { kind: "user", id: AVERY }, "Atlas Cloud's 10-K: 120 employees", id]);

  const ctx = await as(db, RAE);
  const queue = await fn("canonGate.reviewQueue").handler(ctx, {});
  const row = queue.proposed.find((p: { factId: string }) => p.factId === fact._id);
  assert.deepEqual([row.attribute, row.value, row.actor.name, row.actor.via, row.evidence], ["employees", 120, "Avery Chen", "module:@canon/monthly-goals", "Atlas Cloud's 10-K: 120 employees"]);
  await fn("canonGate.decide").handler(ctx, { decisions: [{ factId: fact._id, status: "accepted" }] });

  const reads = { ...manifest, facts: { ...manifest.facts, companies: { read: ["employees"] } } };
  const [atlas] = await read(db, { object: "companies", ids: ["atlas"], receipts: 1 }, reads) as Array<{ fields: Array<{ value: unknown; winner: string }>; receipts: Record<string, Array<{ status: string; source: unknown; proposal?: string }>> }>;
  assert.deepEqual([atlas!.fields[0]!.value, atlas!.fields[0]!.winner], [120, fact._id]);
  assert.deepEqual(atlas!.receipts.employees!.map((r) => [r.status, r.source, r.proposal]), [["accepted", { kind: "agent_run", actor: `user:${AVERY}`, module: "@canon/monthly-goals" }, id]]);
  const [after] = plain(await outcomes(ctx as never, ORG as never, manifest.id, caller!.access, [id]));
  assert.deepEqual([after!.status, after!.applied, after!.pending], ["applied", 1, 0]);
});

test("a proposal names each fact the ledger didn't take: a record the caller can't see, another object's id, a locked or unowned field", async () => {
  const db = seed([{ object: "account", visibility: "own", unowned: false, fields: [{ apiName: "custom.tier", level: "readOnly" }] }]);
  const companies = await propose(db, { object: "companies", facts: [
    { id: "northstar", attribute: "industry", value: "Data", evidence: "Their site" },
    { id: "deals:big", attribute: "industry", value: "Data", evidence: "Their site" },
    { id: "atlas", attribute: "custom.tier", value: "C", evidence: "Their site" },
    { id: "atlas", attribute: "name", value: "Atlas", evidence: "Their site" },
    { id: "atlas", attribute: "industry", value: "Fintech", evidence: "Their site" },
  ] });
  assert.deepEqual([companies.outcome.total, companies.outcome.pending, companies.outcome.rejected], [5, 1, [
    { index: 0, reason: "unknown_record" }, { index: 1, reason: "unknown_record" }, { index: 2, reason: "field_locked" }, { index: 3, reason: "not_owned" },
  ]]);
  const deals = await propose(db, { object: "deals", facts: [{ id: "atlas", attribute: "stage", value: "won", evidence: "Signed" }, { id: "deals:big", attribute: "amount", value: 5000, evidence: "Signed" }] });
  assert.deepEqual([deals.outcome.status, deals.outcome.rejected], ["rejected", [{ index: 0, reason: "unknown_record" }, { index: 1, reason: "not_owned" }]], "a company's id proposed as a deal reaches no record");
  assert.deepEqual(plain(db.rows("facts").filter((f) => f.sourceKind === "agent_run").map((f) => [f.entityId, f.attribute, f.value])), [["canonEntities:atlas", "industry", "Fintech"]]);
});

test("no rule accepts a module's fact, even one an enabled auto-accept rule covers with a perfect check", async () => {
  const db = seed([], { canonAutoAcceptRules: [{ _id: "canonAutoAcceptRules:1", orgId: ORG, sourceKind: "agent_run", attribute: "industry", entityType: "account", minConfidence: 0, enabled: true }] });
  scheduled = [];
  const { id } = await propose(db, { object: "companies", facts: [{ id: "atlas", attribute: "industry", value: "Fintech", evidence: "Atlas Cloud's 10-K: a payments company" }] });
  assert.deepEqual(scheduled, [], "no verification is scheduled");
  const fact = db.rows("facts").find((f) => f.value === "Fintech")!;
  assert.deepEqual(plain(await fn("canonGate.applyVerification").handler(await as(db), { patchPlanId: id, scores: [{ factId: fact._id, score: 1 }] })), { accepted: 0 });
  assert.equal(db.rows("facts").find((f) => f._id === fact._id)!.status, "proposed");
  assert.throws(() => declaredLabel("module:@canon/monthly-goals"), /reserved/, "a CLI batch can't write as a module");
});

test("a proposal is refused for an undeclared attribute or no grant, empty evidence or past 100 facts, and an upgrade that proposes a new attribute needs approval", () => {
  const fact = { id: "atlas", attribute: "industry", value: "Fintech", evidence: "10-K" };
  assert.match(String(factsProposeProblem({ object: "companies", facts: [{ ...fact, attribute: "annualRevenue" }] }, manifest.facts)), /doesn't declare facts\.companies\.propose annualRevenue/);
  assert.match(String(factsProposeProblem({ object: "companies", facts: [{ ...fact, evidence: " " }] }, manifest.facts)), /needs evidence/);
  assert.match(String(factsProposeProblem({ object: "companies", facts: Array.from({ length: 101 }, () => fact) }, manifest.facts)), /1 to 100 facts/);
  assert.equal(factsProposeProblem({ object: "companies", facts: [fact] }, manifest.facts), null);
  assert.match(String(factsProposeProblem({ object: "companies", facts: [fact] }, undefined)), /doesn't declare facts\.companies\.propose industry/, "a module with no facts grant proposes nothing");
  const next = { ...manifest, version: "1.2.0", facts: { ...manifest.facts, companies: { ...manifest.facts!.companies, propose: [...manifest.facts!.companies!.propose!, "annualRevenue"] } } };
  assert.deepEqual(planUpgrade(manifest, defaultSlots(manifest), next).newReads, ["facts.companies.propose.annualRevenue"]);
});

test("a manifest naming an attribute its object doesn't have is refused, and the kernel's attributes are the registry's fields as the docs list them", () => {
  const refused = parseModuleManifest({ ...base, facts: { companies: { read: ["industry", "city"] } } });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /facts\.companies\.read names city/);
  const KIND = { text: "text", number: "number", currency: "money", date: "date", checkbox: "boolean", picklist: "choice", user: "user", splits: "splits" } as Record<string, string>;
  const docs = readFileSync("docs/modules.md", "utf8");
  for (const [object, registry] of [["companies", "account"], ["people", "contact"], ["deals", "deal"]] as const) {
    const fields = new Map<string, string>(STANDARD_OBJECTS[registry].fields.map((f) => [f.apiName, f.type]));
    assert.deepEqual(FACT_ATTRIBUTES[object].map((a) => [a.name, a.kind]), FACT_ATTRIBUTES[object].map((a) => [a.name, KIND[fields.get(a.name) ?? ""]]), `${object}: each attribute is a ${registry} field of its kind`);
    assert.ok(docs.includes(`| \`${object}\` | ${FACT_ATTRIBUTES[object].map((a) => `\`${a.name}\` ${a.kind}`).join(", ")} |`), `docs/modules.md lists ${object}'s attributes`);
  }
});

test("a custom attribute the workspace has no field for reads as unknown, not empty, and a proposal of it adds no field", async () => {
  const db = seed([]);
  const m = { ...manifest, facts: { companies: { read: ["industry", "custom.nope"] } } };
  assert.deepEqual(await read(db, { object: "companies", ids: ["atlas"] }, m), [{ id: "atlas", fields: [
    { attribute: "industry", value: "Software", state: "resolved", winner: "facts:i2", confirmedAt: 900 },
    { attribute: "custom.nope", value: null, state: "unknown", winner: null },
  ] }]);
  const { outcome } = await propose(db, { object: "companies", facts: [{ id: "atlas", attribute: "custom.nope", value: "x", evidence: "Their site" }] });
  assert.deepEqual(outcome.rejected, [{ index: 0, reason: "unknown_attribute" }]);
  assert.deepEqual(db.rows("objectDefs"), [], "no custom field was registered");
});

const ownCompanies = [{ object: "account", visibility: "own", unowned: false }];

test("a company the caller sees that isn't on the ledger reads as empty fields, and a proposal on it promotes it and waits for review", async () => {
  const db = seed(ownCompanies);
  assert.deepEqual(await read(db, { object: "companies", ids: ["lumen"] }), [{ id: "lumen", fields: [
    { attribute: "industry", value: null, state: "empty", winner: null },
    { attribute: "custom.tier", value: null, state: "empty", winner: null },
  ] }]);
  const { outcome } = await propose(db, { object: "companies", facts: [{ id: "lumen", attribute: "industry", value: "Logistics", evidence: "Lumen's site: freight software" }] });
  assert.deepEqual([outcome.status, outcome.pending, outcome.rejected], ["pending_approval", 1, []]);
  const entity = db.rows("canonEntities").find((e) => e.projectionId === "lumen")!;
  assert.deepEqual(plain([entity.entityType, entity.projectionTable]), ["account", "recordAccounts"]);
  const queue = await fn("canonGate.reviewQueue").handler(await as(db, RAE), {});
  assert.deepEqual(queue.proposed.filter((p: { value: unknown }) => p.value === "Logistics").map((p: { attribute: string; actor: { via: string } }) => [p.attribute, p.actor.via]), [["industry", "module:@canon/monthly-goals"]]);
});

test("a proposal on a company the caller can't see is unknown_record and puts nothing on the ledger", async () => {
  const db = seed(ownCompanies);
  assert.deepEqual(await read(db, { object: "companies", ids: ["orion"] }), []);
  const { outcome } = await propose(db, { object: "companies", facts: [{ id: "orion", attribute: "industry", value: "Space", evidence: "Their site" }] });
  assert.deepEqual(outcome.rejected, [{ index: 0, reason: "unknown_record" }]);
  assert.equal(db.rows("canonEntities").some((e) => e.projectionId === "orion"), false);
});

test("promoting a company for a proposal starts its stream from the whole row, so a field the caller's role hides isn't cleared", async () => {
  const db = seed([{ ...ownCompanies[0], fields: [{ apiName: "country", level: "hidden" }] }]);
  const { outcome } = await propose(db, { object: "companies", facts: [{ id: "lumen", attribute: "industry", value: "Logistics", evidence: "Lumen's site: freight software" }] });
  assert.deepEqual(outcome.rejected, []);
  const entity = db.rows("canonEntities").find((e) => e.projectionId === "lumen")!;
  assert.deepEqual(plain(db.rows("canonFieldState").filter((s) => s.entityId === entity._id && s.attribute === "country").map((s) => s.value)), ["Canada"]);
});
