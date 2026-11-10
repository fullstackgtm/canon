/**
 * #322: the visibility gaps left after CP14 (#316, #319, #321), each through
 * the Convex functions people and agents call, on the seed's shape: reps see
 * only their own companies and people; Avery owns Atlas Cloud and Sam Rivera,
 * Jordan owns Northstar Data and Lee Park. Each test also reads with no rules
 * saved, which must read as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb, type Handler } from "./convexHandlers.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow, ContactRow } from "../convex/lib/recordContract.ts";
import type { Access, ObjectRule } from "../convex/lib/access.ts";
import { ID } from "../convex/lib/canon/identity.ts";
import { cellKey } from "../convex/lib/staging.ts";

const ORG = "organizations:org";
const AVERY = "users:avery";
const ownOnly: ObjectRule[] = [{ object: "account", visibility: "own", unowned: false }, { object: "contact", visibility: "own", unowned: false }];

let signedIn: Record<string, unknown> | null = null;
let caller: { orgId: string; userId: string; access: Access } | null = null;
let records: Awaited<ReturnType<typeof workspace>>;
const M = loadConvex(["researchAgents.ts", "canonGate.ts", "agentTurns.ts", "agentSlack.ts", "staging.ts", "permissions.ts", "lib/modules/canonReads.ts", "lib/modules/recordReadAction.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => signedIn }),
  "agents.ts": (real) => ({ ...real, actingAgent: async (ctx: { db: ReturnType<typeof memoryDb> }, id: string) => ({ ok: true, agent: await ctx.db.get(id) }) }),
  "records.ts": (real) => ({
    ...real,
    requireCaller: async () => caller,
    clientFor: () => records,
    callerClient: (_ctx: unknown, c: { access: Access }) => scopedRecordClient(records, [c.access], async () => null),
    principalClient: (_ctx: unknown, _org: string, accesses: Access[]) => scopedRecordClient(records, accesses, async () => null),
  }),
});
const perms = M["permissions.ts"] as unknown as {
  accessFor: (ctx: unknown, user: unknown) => Promise<Access>;
  entitySight: (ctx: unknown, accesses: Access[], entity: unknown) => Promise<unknown>;
  sightAdmits: (sight: unknown, admitted: Set<string>) => boolean;
};
/** Values from the modules' own realm, as plain data this realm compares. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
/** A function by its reference path. */
const fn = (path: string): Handler => {
  const [file, name] = path.replace(/^(internal|api)\./, "").split(".");
  const h = M[`${file}.ts`]![name]!;
  return { handler: async (ctx, args) => plain(await h.handler(ctx, args)) };
};

async function workspace() {
  const store = createMemoryRecordStore();
  const account = (id: string, name: string, ownerId: string) =>
    ({ id, domain: `${id}.example`, name, fit: 0.5, status: "new", segmentIds: [], source: "pdl", updatedAt: 1, version: 1, ownerId }) as AccountRow;
  const contact = (id: string, accountId: string, fullName: string, ownerId: string) =>
    ({ id, accountId, fullName, email: `${id}@${accountId}.example`, status: "new", updatedAt: 1, ownerId }) as ContactRow;
  await store.putAccounts(ORG, [account("atlas", "Atlas Cloud", AVERY), account("northstar", "Northstar Data", "users:jordan")]);
  await store.putContacts(ORG, [contact("sam", "atlas", "Sam Rivera", AVERY), contact("lee", "northstar", "Lee Park", "users:jordan")]);
  return createFakeRecordClient({ store });
}

/** The seed's people and Canon entities, plus whatever a test adds; `rules: false` saves none. */
function seed(extra: Record<string, Array<Record<string, unknown>>> = {}, rules = true) {
  const entity = (id: string, entityType: string, table: string, label: string) => ({ _id: `canonEntities:${id}`, orgId: ORG, entityType, projectionTable: table, projectionId: id, label, createdAt: 1 });
  const fact = (entity: string, attribute: string, value: unknown) => ({ _id: `facts:${entity}:${attribute}`, orgId: ORG, entityId: `canonEntities:${entity}`, entityType: "account", attribute, value, status: "accepted", confidence: 0.9, evidence: `${entity} says so`, observedAt: 1, sourceKind: "agent_run" });
  return memoryDb({
    users: [{ _id: AVERY, orgId: ORG, role: "rep", isActive: true, name: "Avery Chen" }, { _id: "users:riley", orgId: ORG, role: "admin", isActive: true, name: "Riley" }],
    rolePermissions: rules ? [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: ownOnly }] : [],
    researchAgents: [{ _id: "researchAgents:gov", orgId: ORG, slug: "sells_gov", entityType: "account", label: "Sells to government" }],
    canonEntities: [
      entity("atlas", "account", "recordAccounts", "Atlas Cloud"), entity("northstar", "account", "recordAccounts", "Northstar Data"),
      entity("sam", "contact", "recordContacts", "Sam Rivera"), entity("lee", "contact", "recordContacts", "Lee Park"),
    ],
    canonExternalIds: [
      ...["atlas", "northstar"].map((id) => ({ _id: `canonExternalIds:${id}`, orgId: ORG, provider: ID.recordAccount, externalId: id, entityId: `canonEntities:${id}` })),
      ...["sam", "lee"].map((id) => ({ _id: `canonExternalIds:${id}`, orgId: ORG, provider: ID.recordContact, externalId: id, entityId: `canonEntities:${id}` })),
    ],
    facts: [fact("atlas", "custom.sells_gov", true), fact("northstar", "custom.sells_gov", false), fact("sam", "custom.role_fit", "yes"), fact("lee", "custom.role_fit", "no")],
    ...extra,
  });
}

/** A query or action context over `db`, signed in as `userId`: runQuery and runMutation call the real handlers. */
async function as(db: ReturnType<typeof memoryDb>, userId: string) {
  signedIn = await db.get(userId);
  caller = { orgId: ORG, userId, access: await perms.accessFor({ db }, signedIn) };
  const mutations: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const ctx = {
    db, scheduler: { runAfter: async () => null },
    runQuery: (ref: unknown, args: unknown) => fn(String(ref)).handler(ctx, args),
    runMutation: async (ref: unknown, args: Record<string, unknown>) => (mutations.push({ ref: String(ref), args: plain(args) }), null),
  };
  return { ctx, mutations };
}

test("a contact's AI answers: a rep reads only their own contacts', by any id", async () => {
  records = await workspace();
  const args = { slugs: ["role_fit"], recordIds: ["sam", "lee", "canonEntities:lee"] };
  const avery = await as(seed(), AVERY);
  // The live query cannot judge record-service contacts for her: it answers nothing and the page asks the action.
  assert.equal(await fn("researchAgents.contactAnswers").handler(avery.ctx, args), null);
  assert.deepEqual(Object.keys(await fn("researchAgents.contactAnswersScoped").handler(avery.ctx, args)), ["sam"]);
  const open = await as(seed({}, false), AVERY);
  assert.deepEqual(Object.keys(await fn("researchAgents.contactAnswers").handler(open.ctx, args)).sort(), ["canonEntities:lee", "lee", "sam"]);
});

test("a field's answers list shows a rep the answers on the records they see, not an empty list", async () => {
  records = await workspace();
  const avery = await as(seed(), AVERY);
  assert.equal(await fn("researchAgents.answers").handler(avery.ctx, { slug: "sells_gov" }), null);
  const rows = await fn("researchAgents.answersScoped").handler(avery.ctx, { slug: "sells_gov" });
  assert.deepEqual(rows.map((r: { account: string }) => r.account), ["Atlas Cloud"]);
  const open = await as(seed({}, false), AVERY);
  assert.equal((await fn("researchAgents.answers").handler(open.ctx, { slug: "sells_gov" })).length, 2);
  // The field hidden from reps, and deleted since (its facts stay): still none of its answers.
  const hidden = await as(seed({
    researchAgents: [],
    rolePermissions: [{ _id: "rolePermissions:rep", orgId: ORG, role: "rep", rules: [{ object: "account", fields: [{ apiName: "custom.sells_gov", level: "hidden" }] }] }],
  }), AVERY);
  assert.deepEqual(await fn("researchAgents.answersScoped").handler(hidden.ctx, { slug: "sells_gov" }), []);
});

test("an MCP or CLI proposal on a company its user cannot see reads as missing", async () => {
  records = await workspace();
  const facts = [
    { entityType: "account", recordId: "atlas", attribute: "industry", value: "Software", evidence: "x" },
    { entityType: "account", recordId: "northstar", attribute: "industry", value: "Software", evidence: "x" },
    { entityType: "account", entityId: "canonEntities:northstar", attribute: "industry", value: "Software", evidence: "x" },
  ];
  // MCP's canon_propose_facts admits what Avery sees, then the gate writes; the CLI's submit does the same as the token's user.
  const propose = async (rules: boolean) => {
    const db = seed({}, rules);
    const avery = await as(db, AVERY);
    await fn("canonGate.proposeScoped").handler(avery.ctx, { agentId: "claude-code", sourceKind: "enrichment", title: "t", facts });
    const [submit] = avery.mutations;
    assert.equal(submit!.ref, "internal.canonGate.submitProposals");
    const result = await fn(submit!.ref).handler(avery.ctx, submit!.args);
    return [submit!.args.admitted, result.proposed, result.rejected.map((r: { index: number; reason: string }) => [r.index, r.reason])];
  };
  assert.deepEqual(await propose(true), [["atlas"], 1, [[1, "unknown_account"], [2, "unknown_account"]]]);
  // No rules: both companies, as before (the second Northstar fact repeats the first, so it is unchanged).
  assert.deepEqual(await propose(false), [["atlas", "northstar"], 2, []]);
});

const dealEvent = (rules: boolean) => seed({
  crmAccounts: [{ _id: "crmAccounts:n", orgId: ORG, name: "Northstar Data", domain: "northstar.example" }],
  deals: [{ _id: "deals:d", orgId: ORG, name: "Northstar - Expansion", primaryRepId: AVERY, accountId: "crmAccounts:n" }],
  agents: [{ _id: "agents:a", orgId: ORG, slug: "watch", label: "Deal watcher", ownerUserId: AVERY, fieldSlugs: ["sells_gov"], crmTrigger: { event: "deal.stage_changed" }, slack: { mode: "all" } }],
  chatgptAuth: [{ _id: "chatgptAuth:a", userId: AVERY, status: "connected" }],
  integrations: [{ _id: "integrations:s", orgId: ORG, provider: "slack", isActive: true, accessToken: "cipher" }],
}, rules);

test("a deal-stage turn keeps its deal, never the name of an account its owner cannot see", async () => {
  for (const rules of [true, false]) {
    const db = dealEvent(rules);
    await fn("agentTurns.crmEvent").handler({ db, scheduler: { runAfter: async () => null } }, { orgId: ORG, dealId: "deals:d", version: 2, to: "Proposal" });
    const [turn] = plain(db.rows("agentTurns"));
    assert.doesNotMatch(JSON.stringify(turn), /Northstar Data/);
    assert.deepEqual(turn.subject, {});
    // The run reads the account from the deal and keeps it only if the owner's scoped client finds it.
    assert.equal((await fn("agentTurns.loadTurn").handler({ db }, { turnId: turn._id })).domain, "northstar.example");
  }
});

test("an event agent's Slack post names a deal event's account only when its turn found it", async () => {
  const db = dealEvent(true);
  // A turn kept before this fix: skipped, as its owner's reads found no account, with the account's domain as its subject.
  await db.insert("agentTurns", {
    _id: "agentTurns:t", orgId: ORG, agentId: "agents:a", trigger: "crm_event", eventKey: "deal.stage_changed:deals:d@1", status: "skipped",
    skip: { reason: "no_account", message: "No account in this workspace has the event's domain." }, subject: { domain: "northstar.example" },
    payload: JSON.stringify({ event: "deal.stage_changed", account: { name: "Northstar Data", domain: "northstar.example" } }), outputs: [], createdAt: 1, updatedAt: 1,
  });
  const job = await fn("agentSlack.prepare").handler({ db }, { turnId: "agentTurns:t" });
  assert.match(job.text, /Deal watcher/);
  assert.doesNotMatch(job.text, /northstar/i);
  const avery = await as(db, AVERY);
  const [shown] = await fn("agentTurns.turns").handler(avery.ctx, { agentId: "agents:a" });
  assert.doesNotMatch(JSON.stringify([shown.subject, shown.payload]), /northstar/i);
});

test("a staged fill tells only a reviewer who sees every record which companies are already in the CRM", async () => {
  const dims = { region: "NA", industry: "Software", sizeBand: "51-200" };
  const known = cellKey("account", { ...dims, existing: true });
  const fresh = cellKey("account", { ...dims, existing: false });
  const fill = (rules: boolean) => seed({
    users: [{ _id: "users:morgan", orgId: ORG, role: "manager", isActive: true, name: "Morgan" }],
    rolePermissions: rules ? [{ _id: "rolePermissions:manager", orgId: ORG, role: "manager", rules: ownOnly }] : [],
    backgroundJobs: [{ _id: "backgroundJobs:j", orgId: ORG, status: "completed", phases: [] }],
    stagedRuns: [{ _id: "stagedRuns:r", jobId: "backgroundJobs:j", orgId: ORG, title: "Fill", state: "ready", createdAt: 1, expiresAt: 2 }],
    stagedCells: [{ _id: "stagedCells:1", jobId: "backgroundJobs:j", cell: known, count: 1 }, { _id: "stagedCells:2", jobId: "backgroundJobs:j", cell: fresh, count: 2 }],
    stagedRecords: [{ _id: "stagedRecords:n", jobId: "backgroundJobs:j", kind: "account", key: "northstar.example", cell: known, existing: true, name: "Northstar Data", domain: "northstar.example", ...dims }],
  });
  const review = async (rules: boolean) => {
    const morgan = await as(fill(rules), "users:morgan");
    const run = await fn("staging.run").handler(morgan.ctx, { jobId: "backgroundJobs:j" });
    const only = await fn("staging.sample").handler(morgan.ctx, { jobId: "backgroundJobs:j", kind: "account", selection: { existing: "existing" } });
    return [run.knowsExisting, run.cells.map((c: { count: number; dims: { existing: boolean } }) => [c.count, c.dims.existing]), only.map((r: { existing: boolean }) => r.existing)];
  };
  // Morgan, a manager who sees only his own companies: one cell, nothing marked; "only those" keeps every record, unmarked.
  assert.deepEqual(await review(true), [false, [[3, false]], [false]]);
  assert.deepEqual(await review(false), [true, [[1, true], [2, false]], [true]]);
});

test("hosted research reads keep old selected runs scoped to their field and CP14 principals", async () => {
  const db = seed({
    researchAgents: [{ _id: "researchAgents:gov", orgId: ORG, slug: "sells_gov", kind: "qa", question: "Government?", entityType: "account", createdBy: AVERY }],
    researchRuns: Array.from({ length: 12 }, (_, i) => ({
      _id: `researchRuns:${i}`, orgId: ORG, agentId: "researchAgents:gov", createdAt: i, createdBy: "users:riley", trigger: "probe", status: "done",
      planned: 1, done: 1, answered: 1, errors: 0, sample: [{ label: "Atlas Cloud", status: "answered", value: true, quote: "Private quote" }],
    })),
    researchTraces: [{ _id: "researchTraces:old", orgId: ORG, runId: "researchRuns:0", label: "Atlas Cloud", quote: "Private quote", steps: [] }],
  });
  await db.insert("users", { _id: "users:jordan", orgId: ORG, role: "rep", isActive: true });
  const canon = M["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<Array<Record<string, unknown>>> };
  const manifest = { reads: { researchRuns: ["sample", "answered"], researchTraces: ["label", "quote"] } } as never;
  const read = async (user: string, name: "research.runs" | "research.traces", args: Record<string, unknown>) => {
    const h = await as(db, user);
    return plain(await canon.canonRead(h.ctx as never, ORG as never, caller!.access, manifest, name, args, 20));
  };
  const history = await read(AVERY, "research.runs", { slug: "sells_gov" });
  assert.equal(history.length, 10);
  assert.equal(history.some((r) => r.id === "researchRuns:0"), false);
  const old = await read(AVERY, "research.runs", { slug: "sells_gov", run: "researchRuns:0" });
  assert.deepEqual([old[0].id, old[0].answered, (old[0].sample as unknown[]).length], ["researchRuns:0", 1, 1]);
  assert.equal((await read(AVERY, "research.traces", { run: "researchRuns:0" })).length, 1);
  assert.deepEqual((await read("users:jordan", "research.runs", { slug: "sells_gov", run: "researchRuns:0" }))[0].sample, []);
  assert.deepEqual(await read("users:jordan", "research.traces", { run: "researchRuns:0" }), []);
  await db.patch("researchRuns:0", { createdBy: "users:jordan" });
  assert.equal((await read("users:jordan", "research.traces", { run: "researchRuns:0" })).length, 1);
  await db.patch("researchRuns:0", { agentId: "researchAgents:other" });
  assert.deepEqual(await read(AVERY, "research.runs", { slug: "sells_gov", run: "researchRuns:0" }), []);
  await db.patch("researchRuns:0", { agentId: "researchAgents:gov", orgId: "organizations:away" });
  assert.deepEqual(await read(AVERY, "research.runs", { slug: "sells_gov", run: "researchRuns:0" }), []);
  assert.deepEqual(await read(AVERY, "research.traces", { run: "researchRuns:0" }), []);
});

test("module answer actions admit record-service scope before projecting evidence and refuse query or background reads", async () => {
  records = await workspace();
  const actionReads = M["lib/modules/recordReadAction.ts"] as unknown as typeof import("../convex/lib/modules/recordReadAction.ts");
  const canon = M["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<Array<Record<string, unknown>>> };
  const snap = { researchAnswers: { answers: { slug: "sells_gov", limit: 50, fields: ["account", "value", "evidence"] } } };
  const db = seed();
  const h = await as(db, AVERY);
  const read: Record<string, import("../modules/kernel/calls.ts").ReadValue> = {};
  await actionReads.readRecordsOf(h.ctx as never, snap, read);
  assert.deepEqual(plain(read.answers), [{ id: "facts:atlas:custom.sells_gov", createdAt: 1, account: "Atlas Cloud", value: true, evidence: "atlas says so" }]);
  await assert.rejects(canon.canonRead(h.ctx as never, ORG as never, caller!.access, { reads: { researchAnswers: ["evidence"] } } as never, "research.answers", { slug: "sells_gov" }, 50));
  await assert.rejects(actionReads.readRecordsOf(h.ctx as never, snap, {}, ORG as never));
  await assert.rejects(actionReads.readRecordsOf(h.ctx as never, snap, {}, undefined, { orgId: ORG as never, userId: AVERY as never }));
  await db.patch("rolePermissions:rep", { rules: [{ object: "account", fields: [{ apiName: "custom.sells_gov", level: "hidden" }] }] });
  const hidden = await as(db, AVERY);
  await actionReads.readRecordsOf(hidden.ctx as never, snap, read);
  assert.deepEqual(plain(read.answers), []);
});

test("a module's company page and the facts it feeds hold only the companies the caller sees; a job reads every one", async () => {
  records = await workspace();
  const actionReads = M["lib/modules/recordReadAction.ts"] as unknown as typeof import("../convex/lib/modules/recordReadAction.ts");
  const canon = M["lib/modules/canonReads.ts"] as unknown as typeof import("../convex/lib/modules/canonReads.ts");
  const manifest = { reads: { companies: ["name"] }, facts: { companies: { read: ["custom.sells_gov"] } } } as never;
  const db = seed();
  const page = (access: Access | null) => canon.planRecordRead({ db } as never, ORG as never, access, manifest, "companies.updatedSince", { since: 0 }, 1000);
  const h = await as(db, AVERY);
  const read: Record<string, import("../modules/kernel/calls.ts").ReadValue> = {};
  // The plan reaches the action with its keys sorted, so the read that takes the page's ids can come first.
  await actionReads.readRecordsOf(h.ctx as never, { records: {
    facts: { ...await canon.planRecordRead({ db } as never, ORG as never, caller!.access, manifest, "facts.forRecords", { object: "companies", ids: [] }, 1000), idsFrom: { read: "page" } },
    page: await page(caller!.access),
  } }, read);
  assert.deepEqual(plain(read.page), [{ id: "atlas", createdAt: 1, updatedAt: 1, name: "Atlas Cloud" }]);
  assert.deepEqual(plain(read.facts as Array<{ id: string }>).map((r) => r.id), ["atlas"]);
  const job: Record<string, import("../modules/kernel/calls.ts").ReadValue> = {};
  await actionReads.readRecordsOf(h.ctx as never, { records: { page: await page(null) } }, job, ORG as never);
  assert.deepEqual(plain(job.page as Array<{ id: string }>).map((r) => r.id), ["atlas", "northstar"]);
});
