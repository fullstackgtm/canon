/**
 * #326: the visibility classes #324 left, one test per family, through the
 * Convex handlers people and agents call (tests/convexHandlers.ts), on the
 * seed's shape: Avery (rep) owns Atlas Cloud and Sam Rivera, Jordan owns
 * Northstar Data and Lee Park; reps and managers see only their own companies
 * and people. Every test also reads with no rules saved, which reads as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb, type Handler } from "./convexHandlers.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { accountIdFor, createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow, ContactRow } from "../convex/lib/recordContract.ts";
import type { Access, ObjectRule } from "../convex/lib/access.ts";
import { ID } from "../convex/lib/canon/identity.ts";

const ORG = "organizations:org";
const AVERY = "users:avery";
const MORGAN = "users:morgan";
const ownOnly: ObjectRule[] = [{ object: "account", visibility: "own", unowned: false }, { object: "contact", visibility: "own", unowned: false }];

let signedIn: Record<string, unknown> | null = null;
let caller: { orgId: string; userId: string; access: Access } | null = null;
let records: ReturnType<typeof createFakeRecordClient>;
const requireSigned = async () => { if (!signedIn) throw new Error("Not authenticated"); return signedIn; };
const M = loadConvex(["objects.ts", "patchPlans.ts", "gtm.ts", "dialer.ts", "observations.ts", "recordMerges.ts", "cliRuns.ts", "salesforceImport.ts", "canonGate.ts", "canonEntities.ts", "staging.ts", "competitive.ts", "permissions.ts"], {
  "lib.ts": (real) => ({
    ...real, getCurrentUser: async () => signedIn, requireUser: requireSigned,
    requireCap: async () => { const u = await requireSigned(); if (u.role !== "admin" && u.role !== "manager") throw new Error("managers only"); return u; },
  }),
  "records.ts": (real) => ({
    ...real,
    requireCaller: async () => caller,
    clientFor: () => records,
    callerClient: (_ctx: unknown, c: { access: Access }) => scopedRecordClient(records, [c.access], async () => null),
    principalClient: (_ctx: unknown, _org: string, accesses: Access[]) => scopedRecordClient(records, accesses, async () => null),
  }),
});
const perms = M["permissions.ts"] as unknown as { accessFor: (ctx: unknown, user: unknown) => Promise<Access> };
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const fn = (path: string): Handler => {
  const [file, name] = path.replace(/^(internal|api)\./, "").split(".");
  const h = M[`${file}.ts`]![name]!;
  return { handler: async (ctx, args) => plain(await h.handler(ctx, args)) };
};
/** A call's error message, or null when it succeeds. */
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

async function workspace() {
  const store = createMemoryRecordStore();
  const account = (id: string, name: string, ownerId: string, extra: Partial<AccountRow> = {}) =>
    ({ id, domain: `${id}.example`, name, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId, ...extra }) as AccountRow;
  const contact = (id: string, accountId: string, fullName: string, ownerId: string) =>
    ({ id, accountId, fullName, email: `${id}@${accountId}.example`, status: "new", updatedAt: 1, ownerId }) as ContactRow;
  await store.putAccounts(ORG, [account("atlas", "Atlas Cloud", AVERY), account("northstar", "Northstar Data", "users:jordan")]);
  await store.putContacts(ORG, [contact("sam", "atlas", "Sam Rivera", AVERY), contact("lee", "northstar", "Lee Park", "users:jordan")]);
  return createFakeRecordClient({ store });
}

/** The seed's people and Canon entities, plus whatever a test adds; `rules: false` saves none. */
function seed(extra: Record<string, Array<Record<string, unknown>>> = {}, rules = true) {
  const entity = (id: string, entityType: string, table: string, label: string) => ({ _id: `canonEntities:${id}`, orgId: ORG, entityType, projectionTable: table, projectionId: id, label, createdAt: 1 });
  const { users = [], rolePermissions = [], canonEntities = [], canonExternalIds = [], ...rest } = extra;
  return memoryDb({
    users: [
      { _id: AVERY, orgId: ORG, role: "rep", isActive: true, name: "Avery Chen" }, { _id: MORGAN, orgId: ORG, role: "manager", isActive: true, name: "Morgan Lee" },
      { _id: "users:riley", orgId: ORG, role: "admin", isActive: true, name: "Riley" }, ...users,
    ],
    rolePermissions: rules ? [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: ownOnly }, { _id: "rolePermissions:manager", orgId: ORG, role: "manager", rules: ownOnly }, ...rolePermissions] : [],
    canonEntities: [
      entity("atlas", "account", "recordAccounts", "Atlas Cloud"), entity("northstar", "account", "recordAccounts", "Northstar Data"),
      entity("sam", "contact", "recordContacts", "Sam Rivera"), entity("lee", "contact", "recordContacts", "Lee Park"), ...canonEntities,
    ],
    canonExternalIds: [
      ...["atlas", "northstar"].map((id) => ({ _id: `canonExternalIds:${id}`, orgId: ORG, provider: ID.recordAccount, externalId: id, entityId: `canonEntities:${id}` })),
      ...["sam", "lee"].map((id) => ({ _id: `canonExternalIds:${id}`, orgId: ORG, provider: ID.recordContact, externalId: id, entityId: `canonEntities:${id}` })),
      ...canonExternalIds,
    ],
    ...rest,
  });
}

/** A query or action context over `db`, signed in as `userId`: runQuery calls the real handlers; runMutation is recorded. */
async function as(db: ReturnType<typeof memoryDb>, userId: string) {
  signedIn = await db.get(userId);
  caller = { orgId: ORG, userId, access: await perms.accessFor({ db }, signedIn) };
  const mutations: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const ctx = {
    db, scheduler: { runAfter: async () => null }, storage: { getUrl: async () => null },
    runQuery: (ref: unknown, args: unknown) => fn(String(ref)).handler(ctx, args),
    runMutation: async (ref: unknown, args: Record<string, unknown>) => (mutations.push({ ref: String(ref), args: plain(args) }), null),
  };
  return { ctx, mutations };
}

const page = { numItems: 25, cursor: null };
const entry = (stream: string, version: number) => ({
  _id: `ledgerEntries:${stream}:${version}`, orgId: ORG, streamId: `canonEntities:${stream}`, version, observedAt: version, shard: 0, seq: version,
  source: { kind: "user", ref: "user:x" }, actor: { kind: "user", id: "users:riley" }, body: { kind: "assert", assertions: [] },
});

test("a company's history: a rep reads only their own company's, through the action that admits it", async () => {
  records = await workspace();
  const history = {
    ledgerEntries: [entry("atlas", 1), entry("northstar", 1), entry("northstar", 2), entry("atlasMirror", 1)],
    // A company synced from the CRM before the register held it: one stream, linked to its register row by domain.
    canonEntities: [{ _id: "canonEntities:atlasMirror", orgId: ORG, entityType: "account", projectionTable: "crmAccounts", projectionId: "crmAccounts:a", label: "Atlas Cloud", createdAt: 1 }],
    canonExternalIds: [{ _id: "canonExternalIds:atlasMirror", orgId: ORG, provider: ID.domain, externalId: "atlas.example", entityId: "canonEntities:atlasMirror" }],
  };
  const avery = await as(seed(history), AVERY);
  assert.equal((await fn("objects.historyScoped").handler(avery.ctx, { streamId: "canonEntities:atlasMirror", paginationOpts: page })).page.length, 1);
  // The live query cannot judge a record-service company for her: nothing, not Jordan's Northstar entries.
  assert.equal((await fn("objects.history").handler(avery.ctx, { streamId: "canonEntities:northstar", paginationOpts: page })).page.length, 0);
  assert.equal((await fn("objects.historyScoped").handler(avery.ctx, { streamId: "canonEntities:northstar", paginationOpts: page })).page.length, 0);
  assert.equal((await fn("objects.historyScoped").handler(avery.ctx, { streamId: "canonEntities:atlas", paginationOpts: page })).page.length, 1);
  const open = await as(seed(history, false), AVERY);
  assert.equal((await fn("objects.history").handler(open.ctx, { streamId: "canonEntities:northstar", paginationOpts: page })).page.length, 2);
});

test("patch plans hold the CRM's before-values: a narrowed role neither reads them nor makes one", async () => {
  records = await workspace();
  const plans = {
    patchPlans: [{ _id: "patchPlans:p", orgId: ORG, createdBy: "users:riley", verb: "set", operation: "deal.next_step", args: {}, status: "pending_approval", createdAt: 1, updatedAt: 1 }],
    patchOperations: [{ _id: "patchOperations:o", orgId: ORG, patchPlanId: "patchPlans:p", objectType: "deal", objectId: "deals:d", fieldOrAction: "nextStep", beforeValue: "Northstar renewal call" }],
  };
  const morgan = await as(seed(plans), MORGAN);
  assert.deepEqual(await fn("patchPlans.list").handler(morgan.ctx, {}), []);
  assert.equal(await fn("patchPlans.get").handler(morgan.ctx, { patchPlanId: "patchPlans:p" }), null);
  assert.match((await refusal(fn("gtm.set").handler(morgan.ctx, { operation: "deal.next_step", args: { dealId: "deals:d", nextStep: "x" } })))!, /sees only some records/);
  const open = await as(seed(plans, false), MORGAN);
  assert.equal((await fn("patchPlans.list").handler(open.ctx, {})).length, 1);
  assert.equal((await fn("patchPlans.get").handler(open.ctx, { patchPlanId: "patchPlans:p" })).operations[0].beforeValue, "Northstar renewal call");
});

test("reads keyed by a record's id: a rep gets nothing about a contact, merge, run or import row they cannot see", async () => {
  records = await workspace();
  const keyed = {
    dialerCalls: [{ _id: "dialerCalls:c", orgId: ORG, userId: "users:jordan", contactId: "lee", to: "+15550100", state: "completed", startedAt: 1, transcriptStatus: "none" }],
    observations: [{ _id: "observations:o", orgId: ORG, shard: 0, seq: 1, observedAt: 1, subject: { contactId: "lee" }, body: { type: "note", key: "n:1" } }],
    recordMerges: [{ _id: "recordMerges:m", orgId: ORG, mergeId: "m1", object: "account", survivorId: "northstar", losers: [{ recordId: "northstar-old", title: "Northstar (old)" }], mergedAt: 1 }],
    cliRuns: [{ _id: "cliRuns:r", orgId: ORG, command: "audit", status: "success", findings: [{ objectType: "account", objectId: "northstar", severity: "high", ruleId: "r" }], createdAt: 1, startedAt: 1, finishedAt: 2 }],
    sfImportJobs: [{ _id: "sfImportJobs:j", orgId: ORG, status: "completed", objects: [], rejectedCount: 1, rejectedSample: [{ sfId: "001", reason: "bad", name: "Northstar Data" }], startedAt: 1 }],
  };
  const reads = async (rules: boolean) => {
    const avery = await as(seed(keyed, rules), AVERY);
    const ctx = avery.ctx;
    return [
      await fn("dialer.contactCalls").handler(ctx, { contactId: "lee" }),
      await fn("dialer.contactCallsScoped").handler(ctx, { contactId: "lee" }).then((r) => r.length),
      await fn("observations.forContactScoped").handler(ctx, { contactId: "lee" }).then((r) => r?.log.length ?? null),
      await fn("recordMerges.get").handler(ctx, { mergeId: "m1" }).then((r) => r?.losers[0].title ?? null),
      await fn("cliRuns.getRun").handler(ctx, { runId: "cliRuns:r" }).then((r) => r?.findings.length ?? null),
      await fn("salesforceImport.listRejected").handler(ctx, { jobId: "sfImportJobs:j" }).then((r) => [r.rows.length, r.total]),
    ];
  };
  assert.deepEqual(await reads(true), [null, 0, null, null, null, [0, 1]]);
  assert.deepEqual(await reads(false), [[{ _id: "dialerCalls:c", userId: "users:jordan", mine: false, to: "+15550100", state: "completed", startedAt: 1, durationSeconds: null, outcome: null, confirmed: false, notes: null, error: null, transcriptStatus: "none", recordingUrl: null, transcript: null, insightStatus: null, insights: [] }], 1, 1, "Northstar (old)", 1, [1, 1]]);
});

const facts = {
  facts: [
    { _id: "facts:a", orgId: ORG, entityId: "canonEntities:atlas", entityType: "account", attribute: "industry", value: "Software", status: "proposed", confidence: 0.9, evidence: "atlas says so", observedAt: 1, sourceKind: "enrichment", actor: { kind: "integration", id: "enrichment" } },
    { _id: "facts:n", orgId: ORG, entityId: "canonEntities:northstar", entityType: "account", attribute: "industry", value: "Data", status: "proposed", confidence: 0.9, evidence: "northstar says so", observedAt: 2, sourceKind: "enrichment", actor: { kind: "integration", id: "enrichment" } },
  ],
};

test("a narrowed manager reviews facts only on the records they see: the queue and receipts come back, a hidden fact reads as missing", async () => {
  records = await workspace();
  const morgan = await as(seed(facts), MORGAN);
  // The live queue cannot judge companies for him: null, and the page asks the action, which shows Atlas and not Northstar.
  assert.equal(await fn("canonGate.reviewQueue").handler(morgan.ctx, {}), null);
  const queue = await fn("canonGate.reviewQueueScoped").handler(morgan.ctx, {});
  assert.deepEqual(queue.proposed.map((p: { label: string }) => p.label), []);
  assert.equal((await fn("canonGate.entityReceiptsScoped").handler(morgan.ctx, { entityId: "canonEntities:northstar", attribute: "industry" })), null);
  // Deciding Northstar's fact: missing to him, through either path; the action admits nothing he cannot see.
  assert.match((await refusal(fn("canonGate.decide").handler(morgan.ctx, { decisions: [{ factId: "facts:n", status: "accepted" }] })))!, /Fact not found/);
  await fn("canonGate.decideScoped").handler(morgan.ctx, { decisions: [{ factId: "facts:n", status: "rejected" }] });
  assert.deepEqual(morgan.mutations.map((m) => m.args.admitted), [[]]);
  assert.match((await refusal(fn("internal.canonGate.decideAdmitted").handler(morgan.ctx, morgan.mutations[0]!.args)))!, /Fact not found/);
  // A whole-CRM job is refused to him.
  assert.match((await refusal(fn("competitive.generateFromDeals").handler(morgan.ctx, {})))!, /sees only some records/);
  // With no rules saved: the live queue shows both, as before.
  const open = await as(seed(facts, false), MORGAN);
  assert.deepEqual((await fn("canonGate.reviewQueue").handler(open.ctx, {})).proposed.map((p: { label: string }) => p.label).sort(), ["Atlas Cloud", "Northstar Data"]);
});

test("a rep's own company keeps its review rows, receipts and fit citations, through the actions that admit it", async () => {
  records = await workspace();
  const cited = {
    ...facts,
    canonFieldState: [{ _id: "canonFieldState:a", orgId: ORG, entityId: "canonEntities:atlas", attribute: "industry", state: "resolved", factId: "facts:c", value: "Software", sourceKind: "enrichment" }],
  };
  cited.facts = [...facts.facts, { ...facts.facts[0]!, _id: "facts:c", status: "accepted", evidence: "\"Atlas sells software\"\nSource: https://atlas.example/about" }];
  const avery = await as(seed(cited), AVERY);
  const queue = await fn("canonGate.reviewQueueScoped").handler(avery.ctx, {});
  assert.deepEqual(queue.proposed.map((p: { label: string }) => p.label), ["Atlas Cloud"]);
  assert.equal((await fn("canonGate.entityReceiptsScoped").handler(avery.ctx, { entityId: "canonEntities:atlas", attribute: "industry" })).facts.length, 2);
  assert.equal(await fn("canonEntities.fitCitations").handler(avery.ctx, { recordId: "atlas" }), null);
  assert.deepEqual((await fn("canonEntities.fitCitationsScoped").handler(avery.ctx, { recordId: "atlas" })).map((c: { attribute: string }) => c.attribute), ["industry"]);
  assert.deepEqual(await fn("canonEntities.fitCitationsScoped").handler(avery.ctx, { recordId: "northstar" }), []);
});

test("approving a staged fill as a narrowed manager writes no field onto a company he cannot see", async () => {
  const run = async (rules: boolean) => {
    // Jordan's Northstar, keyed as the record service keys a company by its domain, with no industry yet.
    const store = createMemoryRecordStore();
    await store.putAccounts(ORG, [{ id: accountIdFor("northstar.example"), domain: "northstar.example", name: "Northstar Data", fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId: "users:jordan" } as AccountRow]);
    records = createFakeRecordClient({ store });
    const staged = (key: string, name: string, existing: boolean) => ({
      _id: `stagedRecords:${key}`, jobId: "backgroundJobs:j", kind: "account", key: `${key}.example`, cell: "c", existing, name, domain: `${key}.example`,
      region: "NA", industry: "Software", sizeBand: "51-200", source: "pdl", employees: 120, country: "US",
    });
    const db = seed({
      backgroundJobs: [{ _id: "backgroundJobs:j", orgId: ORG, status: "completed", phases: [] }, { _id: "backgroundJobs:a", orgId: ORG, status: "processing", phases: [{ key: "add" }] }],
      stagedRuns: [{ _id: "stagedRuns:r", jobId: "backgroundJobs:j", orgId: ORG, state: "approving", approval: { jobId: "backgroundJobs:a", selection: {}, accounts: 2, contacts: 0, byUserId: MORGAN } }],
      stagedRecords: [staged("northstar", "Northstar Data", true), staged("fresh", "Fresh Co", false)],
    }, rules);
    const { ctx } = await as(db, MORGAN);
    await fn("internal.staging.promote").handler(ctx, { jobId: "backgroundJobs:j", kind: "account", cursor: null, added: 0 });
    const page = await records.listRegister(ORG, "account", { limit: 10 });
    return page.rows.map((r) => [r.values.domain, r.values.industry ?? null]).sort();
  };
  // Morgan sees only his own companies: Northstar (Jordan's) is not filled; the new company is added.
  assert.deepEqual(await run(true), [["fresh.example", "Software"], ["northstar.example", null]]);
  // No rules: Northstar's missing industry is filled, as before.
  assert.deepEqual(await run(false), [["fresh.example", "Software"], ["northstar.example", "Software"]]);
});
