import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillPage, checkPartyEdit, resubmitUnprocessed, syncPartyBatch, compareParty, crmAccountValues, crmContactValues, editPartyRecord, ensurePartyStream, foundEmailEdit, mirrorPartyDecisions, mirrorPartyProposal,
  recordAccountValues, recordEditTarget, recordEditValues, writeFoundEmail, writeParty, writeRecordEdit, writeRecordLifecycle,
  type FoundBy, type PartyObject, type PartySeed, type PartySource, type PartyStores, type PartyValues, type RecordEditPorts,
} from "../convex/lib/canon/partyLedger.ts";
import { decideFacts, ensureEntity, ingestObservations, type FieldStateRow, type LedgerStore, type StoredFact } from "../convex/lib/canon/ledger.ts";
import { accountExternalIds, contactExternalIds } from "../convex/lib/canon/identity.ts";
import type { OwnershipOverride } from "../convex/lib/canon/gate.ts";
import type { SourceKind } from "../convex/lib/canon/policy.ts";
import { project, type FoldState, type ProjectedRow } from "../convex/lib/objects/fold.ts";
import { customFieldType, resolveObjectDef, STANDARD_OBJECTS, withCustomField, type OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import type { ObjectStore, Proposal, StoredEntry } from "../convex/lib/objects/write.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import { autoMap, classify, parseCsv, readRows, writeImportRow, type ImportMatch } from "../convex/lib/objects/csvImport.ts";

const ORG = "org1";

/** In-memory stores with the semantics of convexLedgerStore, convexObjectStore and canonFieldState (convex/canon.ts). */
function memory() {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const entities: Array<{ _id: string; orgId: string; entityType: string; projectionId: string }> = [];
  // canonExternalIds: identity and unique claims share one table, as in Convex.
  const externalIds: Array<{ orgId: string; entityId: string; provider: string; externalId: string }> = [];
  const findExt = (orgId: string, provider: string, externalId: string) =>
    externalIds.find((x) => x.orgId === orgId && x.provider === provider && x.externalId === externalId)?.entityId ?? null;
  const facts: StoredFact[] = [];
  const fieldState = new Map<string, FieldStateRow>();
  const factStore: LedgerStore = {
    async findEntityByExternalId(orgId, provider, externalId) {
      return findExt(orgId, provider, externalId);
    },
    async findEntityByProjection(orgId, projectionId) {
      return entities.find((e) => e.orgId === orgId && e.projectionId === projectionId)?._id ?? null;
    },
    async createEntity(e) {
      const _id = id("ent");
      entities.push({ _id, orgId: e.orgId, entityType: e.entityType, projectionId: e.projectionId });
      return _id;
    },
    async addExternalId(e) {
      externalIds.push(e);
    },
    async latestBySourceRef(orgId, sourceRef) {
      return facts.filter((f) => f.orgId === orgId && f.sourceRef === sourceRef).sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
    },
    async insertFact(f) {
      const _id = id("fact");
      facts.push({ ...f, _id });
      return _id;
    },
    async confirmFact(factId, at) {
      const f = facts.find((x) => x._id === factId);
      if (f) f.lastConfirmedAt = at;
    },
    async getFact(factId) {
      return facts.find((x) => x._id === factId) ?? null;
    },
    async decideFact(factId, d) {
      const f = facts.find((x) => x._id === factId);
      if (f) Object.assign(f, d);
    },
    async setLedgerFactId(factId, ledgerFactId) {
      const f = facts.find((x) => x._id === factId);
      if (f) f.ledgerFactId = ledgerFactId;
    },
    async factsFor(entityId, attribute) {
      return facts.map((f, i) => ({ f, i })).filter(({ f }) => f.entityId === entityId && f.attribute === attribute)
        .sort((a, b) => b.f.observedAt - a.f.observedAt || b.i - a.i).map(({ f }) => f);
    },
    async upsertFieldState(row) {
      fieldState.set(`${row.entityId}:${row.attribute}`, row);
    },
    async recordShadowOutbound() {},
    async hasStream(entityId) {
      return entries.some((e) => e.streamId === entityId);
    },
  };

  const entries: Array<StoredEntry & { orgId: string }> = [];
  const heads = new Map<string, number>();
  const hotRows = new Map<string, { state: FoldState; row: ProjectedRow }>();
  const proposals = new Map<string, Proposal>();
  const objectStore: ObjectStore = {
    async getStream(streamId) {
      const e = entities.find((x) => x._id === streamId);
      return e ? { orgId: e.orgId, object: e.entityType } : null;
    },
    async getHotRow(streamId) {
      return hotRows.get(streamId)?.state ?? null;
    },
    async readEntries(streamId, afterVersion, limit) {
      return entries.filter((e) => e.streamId === streamId && e.version > afterVersion).sort((a, b) => a.version - b.version).slice(0, limit);
    },
    async createStream() {
      throw new Error("account and contact streams are canonEntities rows");
    },
    async findByExternalId(orgId, provider, externalId) {
      return findExt(orgId, provider, externalId);
    },
    async addExternalId(orgId, entityId, provider, externalId) {
      externalIds.push({ orgId, entityId, provider, externalId });
    },
    async removeExternalId(orgId, entityId, provider, externalId) {
      const i = externalIds.findIndex((x) => x.orgId === orgId && x.entityId === entityId && x.provider === provider && x.externalId === externalId);
      if (i >= 0) externalIds.splice(i, 1);
    },
    async externalIdsOf(entityId, limit) {
      return externalIds.filter((x) => x.entityId === entityId).slice(0, limit).map((x) => ({ provider: x.provider, externalId: x.externalId }));
    },
    async nextSeq(orgId, shard) {
      const next = (heads.get(`${orgId}|${shard}`) ?? 0) + 1;
      heads.set(`${orgId}|${shard}`, next);
      return next;
    },
    async appendEntry(orgId, entry) {
      entries.push({ ...entry, orgId });
    },
    async putHotRow(_orgId, _def, state, row) {
      hotRows.set(state.streamId, { state, row });
    },
    async addProposal(_orgId, p) {
      proposals.set(p.factId, p);
    },
    async removeProposal(_orgId, factId) {
      proposals.delete(factId);
    },
  };
  // objectDefs: the org's custom fields, registered as convex/canon.ts partyDef does (no research agents here, so typed by value).
  const exts: Record<PartyObject, OrgObjectExtension | undefined> = {
    account: withCustomField(STANDARD_OBJECTS.account, undefined, "custom.uses_salesforce", "text") ?? undefined,
    contact: undefined,
  };
  // canonFieldOwnership: the org's overrides, which convex/canon.ts loads once per transaction.
  const ownership: OwnershipOverride[] = [];
  const stores: PartyStores = {
    facts: factStore,
    objects: objectStore,
    async ownership() {
      return ownership;
    },
    async factAttributes(entityId, limit) {
      return [...fieldState.values()].filter((s) => s.entityId === entityId).map((s) => s.attribute).sort().slice(0, limit);
    },
    async defWith(_orgId, object, values) {
      for (const [attribute, value] of Object.entries(values)) {
        const type = attribute.startsWith("custom.") ? customFieldType(value) : null;
        if (type) exts[object] = withCustomField(STANDARD_OBJECTS[object], exts[object], attribute, type) ?? exts[object];
      }
      return resolveObjectDef(STANDARD_OBJECTS[object], exts[object]);
    },
  };
  return { stores, factStore, entities, externalIds, facts, fieldState, entries, hotRows, proposals, ownership };
}

type Memory = ReturnType<typeof memory>;

/** The account definition the stores start from. */
const accountDef = resolveObjectDef(STANDARD_OBJECTS.account, withCustomField(STANDARD_OBJECTS.account, undefined, "custom.uses_salesforce", "text") ?? undefined);

const HUBSPOT_ROW = { name: "Atlas Cloud", domain: "atlascloud.example", industry: "Software", employeeCount: 420, annualRevenue: 12_000_000_00, ownerId: "user_a" };
const TAM_ROW = { id: "acc_atlascloud_example", domain: "atlascloud.example", name: "Atlas Cloud Inc", industry: "computer software", employees: 400, country: "united states", status: "new", updatedAt: 500 };

/** Find or create the record's entity the way convex/canon.ts saveParty does. */
const entityFor = (m: Memory, ids: { domain?: string; recordId?: string; crm?: { provider: string; crmId: string } }, projectionId: string) =>
  ensureEntity(m.factStore, { orgId: ORG, entityType: "account", projectionTable: ids.crm ? "crmAccounts" : "recordAccounts", projectionId, externalIds: accountExternalIds(ids) });

const write = (m: Memory, streamId: string, source: PartySource, values: PartyValues, now: number, seed?: PartySeed, object: PartyObject = "account") =>
  writeParty(m.stores, { orgId: ORG, object, streamId, now, source, values, ...(seed ? { seed: async () => seed } : {}) });

const hubspot = (modstamp: string): PartySource => ({ kind: "hubspot", crmId: "9001", rawData: { properties: { hs_lastmodifieddate: modstamp } } });

const kinds = (m: Memory, streamId: string) =>
  m.entries.filter((e) => e.streamId === streamId).map((e) => `${e.source.kind}:${e.body.kind === "lifecycle" ? e.body.op : e.body.kind === "assert" ? `assert/${e.body.status}` : e.body.kind}`);

const tamSeed: PartySeed = { source: { kind: "import", ref: `record:account:${TAM_ROW.id}`, actorId: "record-service", validFrom: TAM_ROW.updatedAt }, values: recordAccountValues(TAM_ROW) };

test("a person's first edit of a TAM account promotes it: the TAM row seeds the stream, the edit is one entry, the hot row shows both", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const out = await write(m, streamId, { kind: "user", userId: "u1" }, recordEditValues("account", { status: "working", employees: "450.4" }), 1000, tamSeed);
  assert.deepEqual({ status: out.result.status, version: "version" in out.result ? out.result.version : null }, { status: "applied", version: 3 });
  assert.deepEqual(kinds(m, streamId), ["import:create", "import:assert/accepted", "user:assert/accepted"]);
  const row = m.hotRows.get(streamId)!.row;
  assert.deepEqual(
    { name: row.values.name, domain: row.values.domain, industry: row.values.industry, employees: row.values.employees, status: row.values.status },
    { name: "Atlas Cloud Inc", domain: "atlascloud.example", industry: "computer software", employees: 450, status: "working" },
  );
  assert.deepEqual(
    m.facts.filter((f) => f.sourceKind === "user").map((f) => [f.attribute, f.value, f.sourceRef]),
    [["employees", 450, `user:u1:${streamId}:employees`]],
    "status is a ledger-only field: the facts mirror carries the fact-tracked employees",
  );
  assert.equal(m.fieldState.get(`${streamId}:employees`)?.value, 450);

  const again = await write(m, streamId, { kind: "user", userId: "u1" }, { status: "working" }, 2000, tamSeed);
  assert.deepEqual(again.result, { status: "unchanged", streamId, version: 3 });
});

test("a TAM seed respects the org's field ownership: an import the org denies industry does not seed it", async () => {
  const m = memory();
  m.ownership.push({ sourceKind: "import", attribute: "industry", allowed: false, entityType: "account" });
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  await write(m, streamId, { kind: "user", userId: "u1" }, recordEditValues("account", { status: "working" }), 1000, tamSeed);
  const row = m.hotRows.get(streamId)!.row;
  assert.equal(row.values.industry ?? null, null, "the TAM row's industry was not seeded");
  assert.equal(row.values.name, "Atlas Cloud Inc", "the other seeded fields landed");
  assert.equal(m.facts.some((f) => f.attribute === "industry"), false);
});

test("a CRM snapshot with an owned-away field and a taken domain still lands its other fields", async () => {
  const m = memory();
  m.ownership.push({ sourceKind: "hubspot", attribute: "industry", allowed: false, entityType: "account" });
  const holder = await entityFor(m, { domain: "orbit.example", crm: { provider: "hubspot", crmId: "9002" } }, "crm2");
  await write(m, holder, { kind: "hubspot", crmId: "9002" }, crmAccountValues({ name: "Orbit", domain: "orbit.example" }), 500);
  const atlas = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, atlas, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  const out = await write(m, atlas, hubspot("2026-09-02T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, name: "Atlas Cloud Inc", domain: "orbit.example", industry: "Space" }), 2000);
  assert.equal(out.result.status, "applied");
  assert.deepEqual(out.rejected.map((e) => e.field).sort(), ["domain", "industry"]);
  assert.equal(m.hotRows.get(atlas)!.row.values.name, "Atlas Cloud Inc");
});

test("a snapshot whose domain was taken is not consumed: once the holder releases it, the same snapshot re-synced lands it", async () => {
  const m = memory();
  const holder = await entityFor(m, { domain: "orbit.example", crm: { provider: "hubspot", crmId: "9002" } }, "crm2");
  await write(m, holder, { kind: "hubspot", crmId: "9002", rawData: { properties: { hs_lastmodifieddate: "2026-09-01T00:00:00Z" } } }, crmAccountValues({ name: "Orbit", domain: "orbit.example" }), 500);
  const atlas = await entityFor(m, { crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const snapshot = crmAccountValues({ ...HUBSPOT_ROW, domain: "orbit.example" });
  const first = await write(m, atlas, hubspot("2026-09-02T00:00:00Z"), snapshot, 1000);
  assert.deepEqual(first.rejected.map((e) => e.field), ["domain"]);
  assert.equal(m.hotRows.get(atlas)!.row.values.name, "Atlas Cloud");

  await write(m, holder, { kind: "hubspot", crmId: "9002", rawData: { properties: { hs_lastmodifieddate: "2026-09-03T00:00:00Z" } } }, crmAccountValues({ name: "Orbit", domain: "orbit.space" }), 1500);
  const retry = await write(m, atlas, hubspot("2026-09-02T00:00:00Z"), snapshot, 2000);
  assert.equal(retry.result.status, "applied");
  assert.equal(m.hotRows.get(atlas)!.row.values.domain, "orbit.example");
  assert.equal(m.hotRows.get(atlas)!.state.watermarks.find((w) => w.sourceKind === "hubspot")?.validFrom, Date.parse("2026-09-02T00:00:00Z"), "the whole snapshot landing marks it seen");
});

test("a HubSpot re-sync with unchanged values is unchanged and appends nothing", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const first = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  assert.equal(first.result.status, "applied");
  const count = m.entries.length;
  const again = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 2000);
  assert.deepEqual(again.result, { status: "unchanged", streamId, version: 2 });
  assert.equal(m.entries.length, count);
  assert.deepEqual(m.facts.map((f) => f.attribute).sort(), ["annualRevenue", "domain", "employees", "industry", "name", "ownerId"]);
  assert.ok(m.facts.every((f) => f.sourceRef.startsWith("hubspot:account:9001:")), "a company's facts are namespaced apart from a deal with the same HubSpot id");
});

test("a newer HubSpot modstamp wins; an older snapshot arriving later changes nothing", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, streamId, hubspot("2026-09-02T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, industry: "Cloud" }), 1000);
  const stale = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, industry: "Hardware" }), 2000);
  assert.equal(stale.result.status, "unchanged");
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Cloud");
  await write(m, streamId, hubspot("2026-09-03T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, industry: "Data" }), 3000);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Data");
});

test("a TAM row promoted by an edit and its HubSpot twin converge on one stream", async () => {
  const m = memory();
  const tam = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  await write(m, tam, { kind: "user", userId: "u1" }, { status: "qualified", industry: "Developer tools" }, Date.parse("2026-09-05T00:00:00Z"), tamSeed);
  const crm = await entityFor(m, { domain: "https://www.AtlasCloud.example/", crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  assert.equal(crm, tam, "the CRM row's domain resolves to the TAM row's stream");
  await write(m, crm, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), Date.parse("2026-09-06T00:00:00Z"));
  assert.deepEqual(m.externalIds.filter((x) => x.entityId === tam && !x.provider.startsWith("unique:")).map((x) => x.provider).sort(), ["domain", "hubspot:account", "record:account"]);
  assert.deepEqual(kinds(m, tam), ["import:create", "import:assert/accepted", "user:assert/accepted", "hubspot:assert/accepted"]);
  const row = m.hotRows.get(tam)!.row;
  assert.deepEqual(
    { name: row.values.name, industry: row.values.industry, status: row.values.status, ownerId: row.values.ownerId },
    { name: "Atlas Cloud", industry: "Developer tools", status: "qualified", ownerId: "user_a" },
    "HubSpot outranks the TAM import; the person's newer edit outranks HubSpot's older snapshot",
  );
  assert.equal(m.entities.length, 1);
});

test("an agent proposal for an account is mirrored as a proposal, and the gate's decision reaches the stream", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "agent_run", sourceRefBase: "agent_run:a1:acct", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "custom.uses_salesforce", value: "yes", evidence: "careers page lists Salesforce admin", confidence: 0.9 }],
  });
  const fact = (await m.factStore.getFact(r.factIds["custom.uses_salesforce"]))!;
  const mirrored = await mirrorPartyProposal(m.stores, { orgId: ORG, object: "account", fact });
  assert.equal("status" in mirrored && mirrored.status, "proposed");
  assert.equal(fact.ledgerFactId, `${streamId}@3#0`);
  assert.deepEqual([...m.proposals.values()].map((p) => [p.object, p.fieldId]), [["account", "custom.uses_salesforce"]]);
  assert.equal(m.hotRows.get(streamId)!.row.values["custom.uses_salesforce"], null, "a proposal does not reach the row");

  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000, decisions: [{ factId: fact._id, status: "accepted" }] });
  await mirrorPartyDecisions(m.stores, { orgId: ORG, object: "account", streamId, now: 3000, decided: out.decided, decider: { kind: "user", userId: "u9" } });
  const state = m.hotRows.get(streamId)!.state;
  assert.equal(m.hotRows.get(streamId)!.row.values["custom.uses_salesforce"], "yes");
  assert.equal(m.proposals.size, 0);
  assert.deepEqual(kinds(m, streamId), ["import:create", "hubspot:assert/accepted", "agent_run:assert/proposed", "user:decide"]);
  assert.deepEqual(compareParty(accountDef, "account", state, project(accountDef, state), fieldStates(m, streamId)), { mismatches: [], overridden: [] });
});

test("an agent fact is the first thing to touch a TAM account: its stream converts the fact and starts from identity", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "agent_run", sourceRefBase: "agent_run:a1:acct", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "custom.uses_salesforce", value: "no", evidence: "no CRM listed" }],
  });
  const fact = (await m.factStore.getFact(r.factIds["custom.uses_salesforce"]))!;
  const seed: PartySeed = { source: { kind: "import", ref: "canon:identity", actorId: "canon" }, values: { name: "Atlas Cloud Inc", domain: "atlascloud.example" } };
  const mirrored = await mirrorPartyProposal(m.stores, { orgId: ORG, object: "account", fact }, async () => seed);
  assert.deepEqual(mirrored, { status: "converted", factsRead: 1 });
  assert.deepEqual(kinds(m, streamId), ["agent_run:assert/proposed", "import:assert/accepted"]);
  assert.equal(m.hotRows.get(streamId)!.row.values.name, "Atlas Cloud Inc");
  assert.equal(m.proposals.size, 1, "the converted proposal is queued once, not mirrored twice");
});

test("a domain another account already holds is left out; the rest of the sync still lands", async () => {
  const m = memory();
  const first = await entityFor(m, { crm: { provider: "hubspot", crmId: "1" } }, "crm1");
  await write(m, first, { kind: "hubspot", crmId: "1" }, crmAccountValues(HUBSPOT_ROW), 1000);
  const second = await entityFor(m, { crm: { provider: "hubspot", crmId: "2" } }, "crm2");
  const out = await write(m, second, { kind: "hubspot", crmId: "2" }, crmAccountValues({ ...HUBSPOT_ROW, name: "Atlas (duplicate)" }), 2000);
  assert.equal(out.result.status, "applied");
  assert.deepEqual(out.rejected, [{ field: "domain", message: 'Domain "atlascloud.example" is already used by another account', retryable: true }]);
  assert.deepEqual([m.hotRows.get(second)!.row.values.name, m.hotRows.get(second)!.row.values.domain], ["Atlas (duplicate)", null]);
});

test("the facts-only fallback refuses a unique value another record holds, as a stream write does", async () => {
  const m = memory();
  const atlas = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, atlas, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  const other = await entityFor(m, { crm: { provider: "hubspot", crmId: "9002" } }, "crm2");
  m.stores.conversionBudget = { remaining: 0 };
  const out = await write(m, other, { kind: "hubspot", crmId: "9002" }, crmAccountValues({ name: "Copycat", domain: HUBSPOT_ROW.domain }), 2000);
  assert.equal(out.result.status, "deferred");
  assert.ok(out.rejected.some((e) => e.field === "domain" && e.retryable), JSON.stringify(out.rejected));
  const facts = m.facts.filter((f) => f.entityId === other).map((f) => f.attribute);
  assert.ok(facts.includes("name") && !facts.includes("domain"), "the name lands in facts, the taken domain does not");
});

test("past the transaction's conversion budget an account is written to facts only, and converts later", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  m.stores.conversionBudget = { remaining: 0 };
  const deferred = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  assert.deepEqual(deferred.result, { status: "deferred", streamId });
  assert.equal(m.entries.length, 0);
  assert.equal(m.fieldState.get(`${streamId}:industry`)?.value, "Software");

  m.stores.conversionBudget = { remaining: 3000, limit: 3000 };
  const later = await write(m, streamId, { kind: "user", userId: "u1" }, { status: "working" }, 2000);
  assert.equal(later.result.status, "applied");
  assert.deepEqual(kinds(m, streamId), ["hubspot:assert/accepted", "user:assert/accepted"]);
  assert.deepEqual([m.hotRows.get(streamId)!.row.values.industry, m.hotRows.get(streamId)!.row.values.status], ["Software", "working"]);
  assert.equal(m.stores.conversionBudget.remaining, 3000 - 6);
});

test("with a limit, a history larger than what is left waits for its own transaction", async () => {
  const m = memory();
  const a = await entityFor(m, { crm: { provider: "hubspot", crmId: "1" } }, "crm1");
  const b = await entityFor(m, { crm: { provider: "hubspot", crmId: "2" } }, "crm2");
  for (const [streamId, crmId] of [[a, "1"], [b, "2"]]) {
    await ingestObservations(m.factStore, {
      orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "hubspot", sourceRefBase: `hubspot:account:${crmId}`, actor: { kind: "integration", id: "hubspot" },
      observedAt: 100, observations: [{ attribute: "name", value: `Co ${crmId}` }, { attribute: "industry", value: "x" }, { attribute: "country", value: "y" }],
    });
  }
  m.stores.conversionBudget = { remaining: 4, limit: 4 };
  const target = (streamId: string) => ({ orgId: ORG, object: "account" as const, streamId, now: 1000 });
  assert.deepEqual(await ensurePartyStream(m.stores, target(a)), { status: "converted", factsRead: 3 });
  assert.deepEqual(await ensurePartyStream(m.stores, target(b)), { status: "deferred", factsRead: 3 });
  assert.equal(m.stores.conversionBudget.remaining, 0, "no further conversion is tried in this transaction");
  m.stores.conversionBudget = { remaining: 2, limit: 2 };
  assert.deepEqual(await ensurePartyStream(m.stores, target(b)), { status: "converted", factsRead: 3 }, "a transaction's first history always converts");
});

function fieldStates(m: Memory, streamId: string) {
  return new Map([...m.fieldState.values()].filter((s) => s.entityId === streamId).map((s) => [s.attribute, s]));
}

/** A small deterministic PRNG, so the property run is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("backfill equivalence: for 60 synthetic accounts (fixed seed), the converted projection equals canonFieldState and the CRM row's own snapshot", async () => {
  const m = memory();
  const rand = rng(20261007);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const ATTRIBUTES = ["name", "domain", "industry", "employees", "annualRevenue", "country", "linkedinUrl", "ownerId", "custom.uses_salesforce"];
  const AGENTS: SourceKind[] = ["agent_run", "enrichment"];
  const valueFor = (attribute: string, n: number) => {
    if (attribute === "domain") return `co${n}.example`;
    if (attribute === "employees" || attribute === "annualRevenue") return Math.floor(rand() * 4) * 100;
    if (rand() < 0.08 && attribute !== "name") return null;
    return `${attribute}-${Math.floor(rand() * 3)}`;
  };
  let t = 1_000;
  let contested = 0;
  for (let n = 0; n < 60; n++) {
    const crmId = `c${n}`;
    const streamId = await entityFor(m, { crm: { provider: "hubspot", crmId } }, `crm${n}`);
    const pending: string[] = [];
    for (let op = 0; op < 10; op++) {
      t += 1 + Math.floor(rand() * 3);
      const attributes = ATTRIBUTES.filter(() => rand() < 0.35);
      if (!attributes.length) continue;
      if (rand() < 0.6) {
        const kind = pick<SourceKind>(["hubspot", "salesforce", "user", "import"]);
        await ingestObservations(m.factStore, {
          orgId: ORG, entityId: streamId, entityType: "account", sourceKind: kind,
          sourceRefBase: kind === "hubspot" ? `hubspot:account:${crmId}` : `${kind}:rec${Math.floor(rand() * 2)}`, actor: { kind: "integration", id: kind },
          observedAt: t, observations: attributes.map((attribute) => ({ attribute, value: valueFor(attribute, n), ...(rand() < 0.5 ? { validFrom: t - Math.floor(rand() * 40) } : {}) })),
        });
      } else if (rand() < 0.6) {
        const kind = pick(AGENTS);
        const r = await ingestObservations(m.factStore, {
          orgId: ORG, entityId: streamId, entityType: "account", sourceKind: kind, sourceRefBase: `${kind}:a1:${streamId}`, actor: { kind: "agent", id: "a1" }, observedAt: t,
          observations: attributes.filter((a) => a !== "name" && a !== "domain" && a !== "ownerId").map((attribute) => ({ attribute, value: valueFor(attribute, n), evidence: `e${Math.floor(rand() * 2)}`, confidence: rand() })),
        });
        pending.push(...Object.values(r.factIds));
      } else if (pending.length) {
        const decisions = pending.splice(0, 1 + Math.floor(rand() * pending.length)).map((factId) => ({ factId, status: rand() < 0.6 ? ("accepted" as const) : ("rejected" as const) }));
        await decideFacts(m.factStore, { orgId: ORG, decisions, decider: pick([{ kind: "user", userId: "u1" }, { kind: "rule", rule: "auto_accept+jev" }] as const), at: t });
      }
    }
    const init = await ensurePartyStream(m.stores, { orgId: ORG, object: "account", streamId, now: t });
    const state = m.hotRows.get(streamId)!.state;
    const states = fieldStates(m, streamId);
    const crmRow: PartyValues = Object.fromEntries(ATTRIBUTES.map((a) => [a, null]));
    for (const a of ATTRIBUTES) {
      const latest = (await m.factStore.factsFor(streamId, a)).find((f) => f.sourceRef === `hubspot:account:${crmId}:${a}`);
      if (latest) crmRow[a] = latest.value;
    }
    const { "custom.uses_salesforce": _, ...mapped } = crmRow;
    const result = compareParty(accountDef, "account", state, project(accountDef, state), states, { sourceRef: `hubspot:account:${crmId}`, values: mapped });
    assert.deepEqual(result.mismatches, [], `account ${n} (${init.status})`);
    contested += [...states.values()].filter((s) => s.state === "contested").length;
    assert.equal([...m.proposals.values()].filter((p) => p.streamId === streamId).length, m.facts.filter((f) => f.entityId === streamId && f.status === "proposed").length, `account ${n} queue`);
  }
  assert.ok(contested > 10, `the run exercised contested fields (${contested})`);
});

test("the checker reports a CRM value its source record never asserted, and a value another source overrides", () => {
  const state: FoldState = {
    streamId: "s1", version: 2, createdAt: 0, updatedAt: 0, lifecycle: { status: "active" }, watermarks: [],
    fields: {
      industry: {
        candidates: [
          { factId: "s1@2#0", fieldId: "industry" as never, value: "Data", sourceKind: "user", sourceRef: "user:u1:s1", observedAt: 20, confidence: 1 },
          { factId: "s1@1#0", fieldId: "industry" as never, value: "Software", sourceKind: "hubspot", sourceRef: "hubspot:account:1", observedAt: 10, confidence: 1 },
        ],
        pending: [], observed: [{ sourceKind: "hubspot", sourceRef: "hubspot:account:1", value: "Software" }, { sourceKind: "user", sourceRef: "user:u1:s1", value: "Data" }],
      },
    },
  };
  const out = compareParty(accountDef, "account", state, project(accountDef, state), new Map([["industry", { value: "Data", state: "resolved" as const }]]), {
    sourceRef: "hubspot:account:1", values: { industry: "Software", country: "Canada" },
  });
  assert.deepEqual(out, { mismatches: [{ attribute: "country", against: "crmRow", ledger: null, other: "Canada" }], overridden: ["industry"] });
});

test("an edit replayed under its idempotency key after a newer edit changes nothing, and a late older edit never wins", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const user = (userId: string, at: number): PartySource => ({ kind: "user", userId, at, key: `${userId}@${at}` });
  await write(m, streamId, user("u1", 1000), { industry: "Edit A" }, 1000, tamSeed);
  await write(m, streamId, user("u1", 2000), { industry: "Edit B" }, 2000);
  const count = m.entries.length;
  const replay = await write(m, streamId, user("u1", 1000), { industry: "Edit A" }, 3000);
  assert.equal(replay.result.status, "unchanged");
  assert.equal(m.entries.length, count, "the replay appends nothing");
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Edit B");

  await write(m, streamId, user("u2", 1500), { industry: "Edit C" }, 4000);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Edit B", "an edit the record service applied before B, recorded late, does not override B");
});

test("a person's edits are patches: an older edit recorded after a newer one by the same person still lands its own fields", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const op = (key: string, at: number): PartySource => ({ kind: "user", userId: "u1", at, key });
  // The owner edit (k2) reaches the ledger first; the industry edit (k1), which the record service applied earlier, is recorded after it (a retry after its ledger write failed).
  await write(m, streamId, op("k2", 2000), { ownerId: "user_b" }, 2000, tamSeed);
  const late = await write(m, streamId, op("k1", 1000), { industry: "Developer tools" }, 3000);
  assert.equal(late.result.status, "applied");
  const { row } = m.hotRows.get(streamId)!;
  assert.deepEqual([row.values.industry, row.values.ownerId], ["Developer tools", "user_b"]);
  assert.equal(m.fieldState.get(`${streamId}:industry`)?.value, "Developer tools", "the facts mirror has it too");
  assert.deepEqual(m.facts.filter((f) => f.sourceKind === "user").map((f) => f.sourceRef).sort(), [`user:u1:${streamId}:k1:industry`, `user:u1:${streamId}:k2:ownerId`]);

  const count = m.entries.length;
  assert.equal((await write(m, streamId, op("k1", 1000), { industry: "Developer tools" }, 4000)).result.status, "unchanged", "a replay of one operation changes nothing");
  assert.equal(m.entries.length, count);
  await write(m, streamId, op("k3", 900), { industry: "Hardware" }, 5000);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Developer tools", "within a field the newer edit still wins");
});

test("many edits by people never push a CRM record's snapshot time out: an older HubSpot snapshot still changes nothing", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, streamId, hubspot("2026-09-02T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, industry: "Cloud" }), 1000);
  for (let i = 0; i < 30; i++) await write(m, streamId, { kind: "user", userId: "u1", at: 2000 + i, key: `k${i}` }, { industry: `Edit ${i}` }, 2000 + i);
  const stale = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, industry: "Hardware" }), 3000);
  assert.equal(stale.result.status, "unchanged");
  assert.deepEqual(m.hotRows.get(streamId)!.state.watermarks.map((w) => w.sourceKind), ["hubspot"]);
});

test("converting an account whose history has custom facts registers those fields first, so a CRM sync's projection carries them", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "hubspot", sourceRefBase: "hubspot:account:9001", actor: { kind: "integration", id: "hubspot" },
    observedAt: 100, observations: [{ attribute: "name", value: "Atlas Cloud" }],
  });
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "user", sourceRefBase: "user:u1:acct", actor: { kind: "user", id: "u1" },
    observedAt: 200, observations: [{ attribute: "custom.headcount_growth", value: 12 }, { attribute: "custom.tier", value: "gold" }],
  });
  const out = await writeParty(m.stores, { orgId: ORG, object: "account", streamId, now: 1000, source: hubspot("2026-09-01T00:00:00Z"), values: crmAccountValues(HUBSPOT_ROW) });
  assert.equal(out.result.status, "applied");
  const { row, state } = m.hotRows.get(streamId)!;
  assert.deepEqual([row.values["custom.headcount_growth"], row.values["custom.tier"]], [12, "gold"]);
  const def = await m.stores.defWith(ORG, "account", {});
  assert.deepEqual(["custom.headcount_growth", "custom.tier"].map((a) => def.byApiName.get(a)?.type), ["number", "text"]);
  assert.deepEqual(compareParty(def, "account", state, project(def, state), fieldStates(m, streamId)).mismatches, []);
});

test("the checker reports a custom field the definition lost: canonFieldState holds a value the projection does not show", () => {
  const state: FoldState = {
    streamId: "s1", version: 1, createdAt: 0, updatedAt: 0, lifecycle: { status: "active" }, watermarks: [],
    fields: {
      "custom.tier": {
        candidates: [{ factId: "s1@1#0", fieldId: "custom.tier" as never, value: "gold", sourceKind: "user", sourceRef: "user:u1:s1", observedAt: 10, confidence: 1 }],
        pending: [], observed: [{ sourceKind: "user", sourceRef: "user:u1:s1", value: "gold" }],
      },
    },
  };
  const bare = resolveObjectDef(STANDARD_OBJECTS.account);
  const out = compareParty(bare, "account", state, project(bare, state), new Map([["custom.tier", { value: "gold", state: "resolved" as const }]]));
  assert.deepEqual(out.mismatches, [{ attribute: "custom.tier", against: "fieldState", ledger: null, ledgerState: "empty", other: { value: "gold", state: "resolved" } }]);
});

test("an account with more than 32 fact attributes converts every attribute, not the first 32 by name", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const customs = Array.from({ length: 35 }, (_, i) => `custom.signal_${String(i).padStart(2, "0")}`);
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "hubspot", sourceRefBase: "hubspot:account:9001", actor: { kind: "integration", id: "hubspot" },
    observedAt: 100, observations: [{ attribute: "name", value: "Atlas Cloud" }, { attribute: "ownerId", value: "user_a" }, ...customs.map((attribute) => ({ attribute, value: "yes" }))],
  });
  const init = await ensurePartyStream(m.stores, { orgId: ORG, object: "account", streamId, now: 1000 });
  assert.deepEqual(init, { status: "converted", factsRead: 37 });
  const { row } = m.hotRows.get(streamId)!;
  assert.deepEqual([row.values.name, row.values.ownerId, row.values["custom.signal_34"]], ["Atlas Cloud", "user_a", "yes"]);
});

test("a contact's first edit starts its stream from the record-service row, so it converges with a CRM contact by email", async () => {
  const m = memory();
  const contactRow = { id: "con_1", accountId: "acc_atlascloud_example", fullName: "Ada Lovelace", email: "Ada@AtlasCloud.example", title: "CTO", status: "new", updatedAt: 500 };
  const edit = recordEditTarget("contact", contactRow.id, { title: "VP Engineering" }, contactRow);
  const streamId = await ensureEntity(m.factStore, { orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: contactRow.id, ...edit.identity });
  await writeParty(m.stores, {
    orgId: ORG, object: "contact", streamId, now: 1000, source: { kind: "user", userId: "u1" }, values: edit.values, seed: async () => edit.seed ?? null,
  });
  const crm = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crmc1",
    externalIds: contactExternalIds({ email: "ada@atlascloud.example", crm: { provider: "hubspot", crmId: "77" } }),
  });
  assert.equal(crm, streamId, "the CRM contact's email resolves to the edited contact's stream");
  const { row } = m.hotRows.get(streamId)!;
  assert.deepEqual([row.values.fullName, row.values.email, row.values.title], ["Ada Lovelace", "Ada@AtlasCloud.example", "VP Engineering"]);
  assert.deepEqual(kinds(m, streamId), ["import:create", "import:assert/accepted", "user:assert/accepted"]);
});

test("a history larger than one transaction converts is never converted in part: it stays in facts and writes go there", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const attributes = ["name", ...Array.from({ length: 32 }, (_, i) => `custom.signal_${String(i).padStart(2, "0")}`)];
  for (const attribute of attributes) {
    for (let i = 0; i < 200; i++) {
      m.facts.push({
        _id: `f-${attribute}-${i}`, orgId: ORG, entityType: "account", entityId: streamId, attribute, value: `${attribute} ${i}`, sourceKind: "hubspot",
        sourceRef: `hubspot:account:9001:${attribute}`, actor: { kind: "integration", id: "hubspot" }, confidence: 1, observedAt: 100 + i, lastConfirmedAt: 100 + i, status: "accepted",
      });
    }
    m.fieldState.set(`${streamId}:${attribute}`, { entityId: streamId, attribute, value: `${attribute} 199`, factId: `f-${attribute}-199`, sourceKind: "hubspot", state: "resolved", updatedAt: 299 });
  }
  m.stores.conversionBudget = { remaining: 3000, limit: 3000 };
  const out = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  assert.deepEqual(out.result, { status: "deferred", streamId, oversized: true });
  assert.equal(m.entries.length, 0, "no entry is appended, so the stream never counts as converted");
  assert.equal(m.fieldState.get(`${streamId}:industry`)?.value, "Software", "the sync still lands in facts");
});

test("a history whose conversion could write more than one transaction's 12,000-write budget is oversized: 4,200 facts, 525 of them pending proposals, at up to three writes each", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const attributes = ["name", ...Array.from({ length: 20 }, (_, i) => `custom.signal_${String(i).padStart(2, "0")}`)];
  for (const attribute of attributes) {
    for (let i = 0; i < 200; i++) {
      const proposed = i >= 175;
      m.facts.push({
        _id: `f-${attribute}-${i}`, orgId: ORG, entityType: "account", entityId: streamId, attribute, value: `${attribute} ${i}`,
        sourceKind: proposed ? "agent_run" : "hubspot", sourceRef: proposed ? `agent_run:a${i}:${attribute}` : `hubspot:account:9001:${attribute}`,
        actor: proposed ? { kind: "agent", id: `a${i}` } : { kind: "integration", id: "hubspot" }, confidence: proposed ? 0.8 : 1,
        observedAt: 100 + i, lastConfirmedAt: 100 + i, status: proposed ? "proposed" : "accepted",
      });
    }
    m.fieldState.set(`${streamId}:${attribute}`, { entityId: streamId, attribute, value: `${attribute} 174`, factId: `f-${attribute}-174`, sourceKind: "hubspot", state: "resolved", updatedAt: 274 });
  }
  m.stores.conversionBudget = { remaining: 3000, limit: 3000 };
  assert.deepEqual(await ensurePartyStream(m.stores, { orgId: ORG, object: "account", streamId, now: 1000 }), { status: "deferred", factsRead: 4200, oversized: true });
  assert.equal(m.entries.length, 0, "nothing of the history is appended");
});

test("backfill: a record whose history is oversized is skipped once, and the records after it on its page still convert", async () => {
  const m = memory();
  const big = await entityFor(m, { crm: { provider: "hubspot", crmId: "1" } }, "crm1");
  for (const attribute of ["name", ...Array.from({ length: 32 }, (_, i) => `custom.signal_${String(i).padStart(2, "0")}`)]) {
    for (let i = 0; i < 200; i++) {
      m.facts.push({
        _id: `f-${attribute}-${i}`, orgId: ORG, entityType: "account", entityId: big, attribute, value: `${attribute} ${i}`, sourceKind: "hubspot",
        sourceRef: `hubspot:account:1:${attribute}`, actor: { kind: "integration", id: "hubspot" }, confidence: 1, observedAt: 100 + i, lastConfirmedAt: 100 + i, status: "accepted",
      });
    }
    m.fieldState.set(`${big}:${attribute}`, { entityId: big, attribute, value: `${attribute} 199`, factId: `f-${attribute}-199`, sourceKind: "hubspot", state: "resolved", updatedAt: 299 });
  }
  const small: string[] = [];
  for (const crmId of ["2", "3"]) {
    const id = await entityFor(m, { crm: { provider: "hubspot", crmId } }, `crm${crmId}`);
    await ingestObservations(m.factStore, {
      orgId: ORG, entityId: id, entityType: "account", sourceKind: "hubspot", sourceRefBase: `hubspot:account:${crmId}`, actor: { kind: "integration", id: "hubspot" },
      observedAt: 100, observations: [{ attribute: "name", value: `Account ${crmId}` }],
    });
    small.push(id);
  }
  const page = [big, ...small];
  const totals = { records: 0, applied: 0, unchanged: 0, converted: 0, skipped: 0 };
  // Each pass is one scheduled transaction with its own conversion budget, as convex/canon.ts runs it.
  let after: string | undefined;
  let passes = 0;
  for (;;) {
    assert.ok(++passes <= 5, "the backfill finishes the page instead of rescheduling it forever");
    const budget = { remaining: 6_400, limit: 6_400 };
    m.stores.conversionBudget = budget;
    const out = await backfillPage(page, {
      key: (id) => id, after, hasBudget: () => budget.remaining > 0,
      visit: async (id) => {
        const init = await ensurePartyStream(m.stores, { orgId: ORG, object: "account", streamId: id, now: 1000 });
        return init.status === "deferred" ? (init.oversized ? "oversized" : "deferred") : init.status === "existing" ? "skipped" : "converted";
      },
    });
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += out.counted[k];
    if (!out.stopped) break;
    after = out.resumeAfter;
  }
  assert.deepEqual(totals, { records: 3, applied: 0, unchanged: 0, converted: 2, skipped: 1 });
  assert.deepEqual(small.map((id) => m.hotRows.get(id)?.row.values.name), ["Account 2", "Account 3"]);
  assert.equal(m.entries.filter((e) => e.streamId === big).length, 0, "the oversized history stays in facts");
});

test("the ledger resolves the edit the record service applied last, even when the callers' clocks disagree with that order", async () => {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  const { ids: [id] } = await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: id }, id);
  const edit = (industry: string, key: string, stampedAt: number) =>
    client.edit(ORG, { object: "account", id, patch: { industry }, actorId: "u1", idempotencyKey: key, sourceTimestamp: stampedAt });
  // A was stamped first, B second, but the service applied B and then A, so A's value is the row's.
  const b = await edit("Edit B", "kB", 1_101);
  const a = await edit("Edit A", "kA", 1_100);
  const service = (await client.get(ORG, id))!.account.industry;
  assert.equal(service, "Edit A");
  // Each ledger write carries the service's answer, in whichever order the actions get there.
  await write(m, streamId, { kind: "user", userId: "u1", at: a.at, key: "kA" }, { industry: "Edit A" }, 3_000, tamSeed);
  await write(m, streamId, { kind: "user", userId: "u1", at: b.at, key: "kB" }, { industry: "Edit B" }, 3_001);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, service);
});

test("converting a record whose name a person corrected keeps the correction: the identity seed fills only fields with no accepted fact", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "user", sourceRefBase: "user:u1", actor: { kind: "user", id: "u1" },
    observedAt: 1000, observations: [{ attribute: "name", value: "Corrected Name" }],
  });
  const identity: PartySeed = { source: { kind: "import", ref: "canon:identity", actorId: "canon" }, values: { name: "Old Name", domain: TAM_ROW.domain } };
  await write(m, streamId, { kind: "user", userId: "u2", at: 2000, key: "k1" }, { status: "working" }, 2000, identity);
  const { row } = m.hotRows.get(streamId)!;
  assert.deepEqual([row.values.name, row.values.domain, row.values.status], ["Corrected Name", TAM_ROW.domain, "working"]);
  assert.equal(m.fieldState.get(`${streamId}:name`)?.value, "Corrected Name", "the facts mirror agrees");
});

test("accepting an agent's email that another contact holds is refused: no second contact shows it and no second claim is made", async () => {
  const m = memory();
  const contact = (projectionId: string, email?: string) => ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId, externalIds: contactExternalIds({ email, recordId: projectionId }),
  });
  const ada = await contact("con_ada", "ada@atlascloud.example");
  await write(m, ada, { kind: "user", userId: "u1" }, { fullName: "Ada Lovelace", email: "ada@atlascloud.example" }, 1000, undefined, "contact");
  const bob = await contact("con_bob");
  await write(m, bob, { kind: "user", userId: "u1" }, { fullName: "Bob Byron" }, 1000, undefined, "contact");
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: bob, entityType: "contact", sourceKind: "agent_run", sourceRefBase: "agent_run:a1:bob", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "email", value: "ada@atlascloud.example", evidence: "team page", confidence: 0.9 }],
  });
  const fact = (await m.factStore.getFact(r.factIds.email))!;
  const mirrored = await mirrorPartyProposal(m.stores, { orgId: ORG, object: "contact", fact });
  assert.equal("status" in mirrored && mirrored.status, "invalid");

  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000, decisions: [{ factId: fact._id, status: "accepted" }] });
  const count = m.entries.length;
  await assert.rejects(
    mirrorPartyDecisions(m.stores, { orgId: ORG, object: "contact", streamId: bob, now: 3000, decided: out.decided, decider: { kind: "user", userId: "u9" } }),
    /Email "ada@atlascloud.example" is already used by another person/,
  );
  assert.equal(m.entries.length, count, "the refused decision appends nothing");
  assert.equal(m.hotRows.get(bob)!.row.values.email, null);
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "unique:contact.email").map((x) => [x.entityId, x.externalId]), [[ada, "ada@atlascloud.example"]]);
});

test("accepting a proposal that would make a record resolve back to a value another record now holds is refused", async () => {
  const m = memory();
  const contact = (projectionId: string, email?: string) => ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId, externalIds: contactExternalIds({ email, recordId: projectionId }),
  });
  const ada = await contact("con_ada", "x@atlascloud.example");
  await write(m, ada, { kind: "hubspot", crmId: "55", rawData: { properties: { lastmodifieddate: "2026-09-01T00:00:00Z" } } }, { fullName: "Ada Lovelace", email: "x@atlascloud.example" }, 1000, undefined, "contact");
  await write(m, ada, { kind: "user", userId: "u1" }, { email: "y@atlascloud.example" }, 2000, undefined, "contact");
  const bob = await contact("con_bob");
  await write(m, bob, { kind: "user", userId: "u1" }, { fullName: "Bob Byron", email: "x@atlascloud.example" }, 3000, undefined, "contact");
  assert.equal(m.hotRows.get(bob)!.row.values.email, "x@atlascloud.example");

  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: ada, entityType: "contact", sourceKind: "enrichment", sourceRefBase: "enrichment:e1:ada", actor: { kind: "agent", id: "e1" },
    observedAt: 4000, observations: [{ attribute: "email", value: "z@atlascloud.example", evidence: "bounce report", confidence: 0.9 }],
  });
  const fact = (await m.factStore.getFact(r.factIds.email))!;
  await mirrorPartyProposal(m.stores, { orgId: ORG, object: "contact", fact });
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 5000, decisions: [{ factId: fact._id, status: "accepted" }] });
  await assert.rejects(
    mirrorPartyDecisions(m.stores, { orgId: ORG, object: "contact", streamId: ada, now: 5000, decided: out.decided, decider: { kind: "user", userId: "u9" } }),
    /Email "x@atlascloud.example" is already used by another person/,
  );
  assert.equal(m.hotRows.get(ada)!.row.values.email, "y@atlascloud.example", "Ada still shows her own email");
});

test("an edit replayed after more than a field's worth of other edits still changes nothing", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const op = (i: number): PartySource => ({ kind: "user", userId: "u1", at: 1000 + i, key: `k${i}` });
  for (let i = 0; i < 12; i++) await write(m, streamId, op(i), { industry: `Edit ${i}` }, 1000 + i, tamSeed);
  const count = m.entries.length;
  const replay = await write(m, streamId, op(0), { industry: "Edit 0" }, 5000);
  assert.equal(replay.result.status, "unchanged");
  assert.equal(m.entries.length, count, "the replay appends nothing");
  assert.equal(m.facts.filter((f) => f.sourceRef === `user:u1:${streamId}:k0:industry`).length, 1);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Edit 11");

  const first = await write(m, streamId, op(12), { industry: "Edit 12" }, 6000);
  assert.equal(first.result.status, "applied", "an operation the ledger never recorded (its earlier transaction failed) still lands once");
});

/** People's edits made after the HubSpot snapshots below, so they win the field. */
const AFTER_SYNC = Date.parse("2026-09-05T00:00:00Z");

test("eleven keyed edits by people never evict a CRM record's observation: an unchanged HubSpot re-sync appends no second fact", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  for (let i = 0; i < 11; i++) await write(m, streamId, { kind: "user", userId: "u1", at: AFTER_SYNC + i, key: `k${i}` }, { industry: `Edit ${i}` }, 2000 + i);
  const count = m.entries.length;
  // A sync with no modstamp: nothing but the write rule can tell the value is unchanged.
  const again = await write(m, streamId, { kind: "hubspot", crmId: "9001" }, crmAccountValues(HUBSPOT_ROW), 3000);
  assert.equal(again.result.status, "unchanged");
  assert.equal(m.entries.length, count, "the unchanged re-sync appends nothing");
  // A newer modstamp with the same values moves the watermark with a confirm entry and still asserts nothing.
  await write(m, streamId, hubspot("2026-09-02T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 4000);
  assert.deepEqual(kinds(m, streamId).slice(count), ["hubspot:confirm"]);
  assert.equal(m.facts.filter((f) => f.sourceRef === "hubspot:account:9001:industry").length, 1, "HubSpot's industry is one fact");
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Edit 10");
});

test("after eleven keyed edits the checker reports the person's industry as an override of the CRM row, not a mismatch", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  for (let i = 0; i < 11; i++) await write(m, streamId, { kind: "user", userId: "u1", at: AFTER_SYNC + i, key: `k${i}` }, { industry: `Edit ${i}` }, 2000 + i);
  const { state, row } = m.hotRows.get(streamId)!;
  const states = new Map([...m.fieldState.values()].filter((s) => s.entityId === streamId).map((s) => [s.attribute, s]));
  const out = compareParty(accountDef, "account", state, row, states, { sourceRef: "hubspot:account:9001", values: crmAccountValues(HUBSPOT_ROW) });
  assert.deepEqual(out, { mismatches: [], overridden: ["industry"] });
});

/**
 * convex/records.ts recordEditPorts over the memory stores and the fake record
 * service: checkRecordEdit, saveRecordEdit, then the service's edit of the
 * fields only it keeps. A record with no stream yet is promoted from its row
 * as it was before the edit.
 */
/** Each edit's time: records.edit writes at Convex's clock, which moves forward. */
let editClock = 1_000;

async function editPorts(
  m: Memory, client: RecordClient,
  a: { object: PartyObject; id: string; patch: Record<string, string | number | null | string[]>; key: string; userId?: string; found?: FoundBy },
): Promise<RecordEditPorts> {
  const userId = a.userId ?? "u1";
  const provider = a.object === "account" ? "record:account" : "record:contact";
  const known = m.externalIds.find((x) => x.provider === provider && x.externalId === a.id);
  const promoting = !known || !m.entries.some((e) => e.streamId === known.entityId);
  const row = promoting && a.object === "contact" ? await client.getContact(ORG, a.id) : null;
  const snapshot = row ? { id: row.id, fullName: row.fullName, updatedAt: row.updatedAt, ...(row.email ? { email: row.email } : {}), ...(row.title ? { title: row.title } : {}) } : undefined;
  return {
    object: a.object,
    register: true,
    check: async () => checkPartyEdit(m.factStore, { orgId: ORG, object: a.object, def: await m.stores.defWith(ORG, a.object, {}), recordId: a.id, patch: a.patch, snapshot, key: a.key }),
    ledger: async (patch, at) => {
      const out = await writeRecordEdit(m.stores, {
        orgId: ORG, object: a.object, recordId: a.id, patch, userId, key: a.key, now: ++editClock, snapshot,
        ...(at !== undefined ? { at } : {}), ...(a.found ? { found: a.found } : {}),
      });
      return { rejected: out.rejected, deferred: out.result.status === "deferred", ...("version" in out.result ? { version: out.result.version } : {}) };
    },
    // The projector's write-back (services/record-service/src/register.ts), as the fake record service can take it: the stream's values onto the row.
    settle: async () => {
      const stream = m.externalIds.find((x) => x.provider === provider && x.externalId === a.id)?.entityId;
      const values = stream ? m.hotRows.get(stream)?.row.values : undefined;
      if (!values) return;
      const fields = a.object === "account" ? ["name", "industry", "employees", "country", "linkedinUrl", "status", "ownerId"] : ["fullName", "title", "email", "linkedinUrl"];
      const patch = Object.fromEntries(fields.map((f) => [f, (values[f] ?? null) as string | number | null]).filter(([f, v]) => !(v === null && (f === "name" || f === "fullName"))));
      await client.edit(ORG, { object: a.object, id: a.id, patch, actorId: "ledger", idempotencyKey: `writeback:${a.key}:${JSON.stringify(patch)}` });
    },
    service: (patch, opts) => client.edit(ORG, {
      object: a.object, id: a.id, patch: patch as Record<string, string | number | null>, actorId: userId, idempotencyKey: `${a.key}${opts?.keySuffix ?? ""}`, ...(opts?.payload ? { payload: opts.payload } : {}),
    }),
  };
}

/** Two contacts in the record service: Ada with a work email, Bob without one. */
async function twoContacts() {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  const { ids: [ada, bob] } = await client.upsertContacts(ORG, {
    records: [{ accountDomain: TAM_ROW.domain, fullName: "Ada Lovelace", email: "ada@atlascloud.example" }, { accountDomain: TAM_ROW.domain, fullName: "Bob Byron" }],
    source: "pipe0", idempotencyKey: "people",
  });
  const edit = async (id: string, patch: Record<string, string | number | null | string[]>, key: string) =>
    editPartyRecord(await editPorts(m, client, { object: "contact", id, patch, key }));
  // Both are worked: each has a stream, and Ada's holds her email's unique claim.
  await edit(ada, { title: "CTO" }, "a1");
  await edit(bob, { title: "VP Sales" }, "b1");
  const streamOf = (id: string) => m.externalIds.find((x) => x.provider === "record:contact" && x.externalId === id)!.entityId;
  return { m, client, ada, bob, edit, streamOf };
}

test("an edit the ledger would refuse is refused before the record service is written: an email another contact holds", async () => {
  const { m, client, bob, edit, streamOf } = await twoContacts();
  const count = m.entries.length;
  await assert.rejects(edit(bob, { email: "ada@atlascloud.example" }, "b2"), /Email "ada@atlascloud\.example" is already used by another person/);
  assert.equal((await client.getContact(ORG, bob))!.email, undefined, "the record service was not written");
  assert.equal(m.entries.length, count, "nor the ledger");
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.email, null);
  assert.equal(m.externalIds.some((x) => x.provider === "op:contact" && x.externalId === "b2"), false);
});

test("a person's second email is theirs alone: making it primary keeps the record and both claims, and no one else can take it", async () => {
  const { m, bob, ada, edit, streamOf } = await twoContacts();
  const stream = streamOf(ada);
  const holder = (email: string) => m.externalIds.filter((x) => (x.provider === "email" || x.provider === "unique:contact.email") && x.externalId === email).map((x) => x.entityId);
  await edit(ada, { additionalEmails: ["Ada@Home.example"] }, "a2");
  assert.deepEqual(m.hotRows.get(stream)!.row.values.additionalEmails, ["ada@home.example"]);
  assert.deepEqual(holder("ada@home.example"), [stream, stream], "the second email is claimed and identifies Ada");

  // Make it primary: the old primary moves into the list, and the record and its claims stay put.
  await edit(ada, { email: "ada@home.example" }, "a3");
  assert.equal(streamOf(ada), stream);
  assert.equal(m.hotRows.get(stream)!.row.values.email, "ada@home.example");
  assert.deepEqual(m.hotRows.get(stream)!.row.values.additionalEmails, ["ada@atlascloud.example"]);
  assert.deepEqual(holder("ada@atlascloud.example"), [stream, stream]);
  assert.deepEqual(holder("ada@home.example"), [stream, stream]);

  // Bob cannot take either address, as a primary or as another email.
  await assert.rejects(edit(bob, { additionalEmails: ["ada@atlascloud.example"] }, "b2"), /Email "ada@atlascloud\.example" is already used by another person/);
  await assert.rejects(edit(bob, { email: "ada@home.example" }, "b3"), /already used by another person/);
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.additionalEmails, null);
});

test("a CRM snapshot repeating its own primary after a person switched primaries moves neither field", async () => {
  const { m, ada, edit, streamOf } = await twoContacts();
  const stream = streamOf(ada);
  const sync = () => writeParty(m.stores, { orgId: ORG, object: "contact", streamId: stream, now: ++editClock, values: { email: "ada@atlascloud.example" }, source: { kind: "hubspot", crmId: "h1" } });
  await sync();
  await edit(ada, { email: "ada@home.example", additionalEmails: ["ada@atlascloud.example"] }, "a2");
  await sync();
  const values = m.hotRows.get(stream)!.row.values;
  assert.deepEqual([values.email, values.additionalEmails], ["ada@home.example", ["ada@atlascloud.example"]]);
  // A source that may not write the others cannot move them by naming one as its primary.
  const ownership = [{ sourceKind: "salesforce" as const, attribute: "additionalEmails", allowed: false, entityType: "contact" as const }];
  await writeParty(m.stores, { orgId: ORG, object: "contact", streamId: stream, now: ++editClock, values: { email: "ada@atlascloud.example" }, source: { kind: "salesforce", crmId: "003" }, ownership });
  const after = m.hotRows.get(stream)!.row.values;
  assert.deepEqual([after.email, after.additionalEmails], ["ada@home.example", ["ada@atlascloud.example"]]);
});

test("an import that names a person's other email finds them and leaves their primary", async () => {
  const { m, ada, edit, streamOf } = await twoContacts();
  const stream = streamOf(ada);
  await edit(ada, { additionalEmails: ["ada@home.example"] }, "a2");
  // A CSV row keyed by the second email resolves to Ada by its identity, and lands its other values on her.
  const ids = contactExternalIds({ email: "ada@home.example" });
  const entity = await ensureEntity(m.factStore, { orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "csv:f:2", externalIds: ids });
  assert.equal(entity, stream);
  await writeParty(m.stores, { orgId: ORG, object: "contact", streamId: entity, now: ++editClock, values: { email: "ada@home.example", title: "CEO" }, source: { kind: "import", ref: "csv:f:2", actorId: "u1" } });
  assert.equal(m.hotRows.get(stream)!.row.values.email, "ada@atlascloud.example", "the primary stays");
  assert.deepEqual(m.hotRows.get(stream)!.row.values.additionalEmails, ["ada@home.example"]);
  assert.equal(m.hotRows.get(stream)!.row.values.title, "CEO");
});

test("a field the ledger still refuses after the record service took the edit (a race) leaves the operation unclaimed and fails, so a retry completes it", async () => {
  const { m, client, ada, bob, edit, streamOf } = await twoContacts();
  // Ada's claim landed between the check and the write: the check saw nothing to refuse.
  const raced = { ...(await editPorts(m, client, { object: "contact", id: bob, patch: { email: "ada@atlascloud.example", title: "Head of Sales" }, key: "b2" })), check: async () => ({ patch: { email: "ada@atlascloud.example", title: "Head of Sales" }, refused: [] }) };
  await assert.rejects(editPartyRecord(raced), /already used by another person/);
  assert.equal(m.externalIds.some((x) => x.provider === "op:contact" && x.externalId === "b2"), false, "the operation is not claimed");
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.title, "Head of Sales", "the fields the ledger took stay");

  await edit(ada, { email: "ada.lovelace@atlascloud.example" }, "a2");
  await edit(bob, { email: "ada@atlascloud.example", title: "Head of Sales" }, "b2");
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.email, "ada@atlascloud.example", "the retry lands the field the race refused");
  assert.equal((await client.getContact(ORG, bob))!.email, "ada@atlascloud.example");
  assert.equal(m.externalIds.some((x) => x.provider === "op:contact" && x.externalId === "b2"), true);
  assert.equal(m.facts.filter((f) => f.entityId === streamOf(bob) && f.attribute === "title" && f.value === "Head of Sales").length, 1, "the retry did not repeat the title");
});

/** The providerCalls row a lookup recorded (convex/records.ts recordProviderCall). */
const LOOKUP: FoundBy = { provider: "treg:hunter", callId: "call_41" };
const writeFound = async (m: Memory, client: RecordClient, id: string, email: string | null) => {
  const found = foundEmailEdit(id, "2026-10-06", email, LOOKUP);
  return writeFoundEmail(await editPorts(m, client, { object: "contact", id, patch: found.patch, key: found.idempotencyKey, found: found.found }), found.patch);
};
/** Every non-empty email a record's stream was told, with its source and actor. */
const emailHistory = (m: Memory, stream: string) => m.entries.filter((e) => e.streamId === stream).flatMap((e) => (e.body.kind === "assert" ? e.body.assertions : [])
  .filter((a) => a.fieldId === "email" && a.value !== null).map((a) => [e.source.kind, e.source.ref, e.actor, a.value]));
const emailState = (m: Memory, stream: string) => {
  const s = m.fieldState.get(`${stream}:email`)!;
  return { value: s.value, state: s.state, sourceKind: s.sourceKind };
};

test("a found work email fills an empty email as enrichment under its provider call, accepted by the person who ran the lookup", async () => {
  const { m, client, bob, streamOf } = await twoContacts();
  await writeFound(m, client, bob, "bob@atlascloud.example");
  const stream = streamOf(bob);
  assert.equal((await client.getContact(ORG, bob))!.email, "bob@atlascloud.example");
  assert.equal(m.hotRows.get(stream)!.row.values.email, "bob@atlascloud.example");
  assert.deepEqual(emailState(m, stream), { value: "bob@atlascloud.example", state: "resolved", sourceKind: "enrichment" });
  assert.deepEqual(emailHistory(m, stream), [["enrichment", "treg:hunter:call_41", { kind: "user", id: "u1" }, "bob@atlascloud.example"]]);
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "unique:contact.email" && x.externalId === "bob@atlascloud.example").map((x) => x.entityId), [stream]);
});

test("a found work email does not replace an email a CRM sync set, and both stay in the record's history", async () => {
  const { m, client, bob, streamOf } = await twoContacts();
  const stream = streamOf(bob);
  await write(m, stream, hubspot("2026-09-01T00:00:00Z"), { email: "bob.byron@atlascloud.example" }, AFTER_SYNC - 1, undefined, "contact");
  editClock = Math.max(editClock, AFTER_SYNC);
  await writeFound(m, client, bob, "bob@atlascloud.example");
  assert.equal(m.hotRows.get(stream)!.row.values.email, "bob.byron@atlascloud.example");
  assert.deepEqual(emailState(m, stream), { value: "bob.byron@atlascloud.example", state: "resolved", sourceKind: "hubspot" });
  assert.deepEqual(emailHistory(m, stream), [
    ["hubspot", "hubspot:contact:9001", { kind: "integration", id: "hubspot" }, "bob.byron@atlascloud.example"],
    ["enrichment", "treg:hunter:call_41", { kind: "user", id: "u1" }, "bob@atlascloud.example"],
  ]);
});

test("a found work email another contact holds is refused before the record service is written", async () => {
  const { m, client, bob, streamOf } = await twoContacts();
  await assert.rejects(writeFound(m, client, bob, "ada@atlascloud.example"), /already used/);
  assert.equal((await client.getContact(ORG, bob))!.email, undefined);
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.email, null);
});

test("a lookup that finds no email sets only the record service's emailStatus and does not put the contact on the ledger", async () => {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  const { ids: [cara] } = await client.upsertContacts(ORG, { records: [{ accountDomain: TAM_ROW.domain, fullName: "Cara Quill" }], source: "pipe0", idempotencyKey: "people" });
  await writeFound(m, client, cara, null);
  assert.equal((await client.getContact(ORG, cara))!.emailStatus, "not_found");
  assert.equal(m.entries.length, 0);
});

/** twoContacts plus Cara: in the record service, never worked, with no email, so no identity mapping but her record id. */
async function withUnworkedContact() {
  const t = await twoContacts();
  const { ids: [cara] } = await t.client.upsertContacts(ORG, { records: [{ accountDomain: TAM_ROW.domain, fullName: "Cara Quill" }], source: "pipe0", idempotencyKey: "cara" });
  return { ...t, cara };
}

test("an unworked contact's edit to another contact's email is refused, not resolved to that contact's stream", async () => {
  const { m, client, ada, cara, edit, streamOf } = await withUnworkedContact();
  const adaStream = streamOf(ada);
  const count = m.entries.length;
  await assert.rejects(edit(cara, { email: "ada@atlascloud.example", title: "COO" }, "c1"), /Email "ada@atlascloud\.example" is already used by another person/);
  assert.equal((await client.getContact(ORG, cara))!.email, undefined, "the record service was not written");
  assert.equal(m.entries.length, count, "nor the ledger");
  assert.equal(m.externalIds.some((x) => x.entityId === adaStream && x.externalId === cara), false, "Cara's record is not linked to Ada's stream");
  assert.equal(m.hotRows.get(adaStream)!.row.values.title, "CTO");
});

test("a found email another contact holds is refused for an unworked contact too", async () => {
  const { m, client, ada, cara, streamOf } = await withUnworkedContact();
  await assert.rejects(writeFound(m, client, cara, "ada@atlascloud.example"), /already used/);
  assert.equal((await client.getContact(ORG, cara))!.email, undefined);
  assert.equal(m.externalIds.some((x) => x.entityId === streamOf(ada) && x.externalId === cara), false);
});

test("an edit to an email that identifies another person (a CRM contact with no stream yet) is refused, and the ledger write refuses it too", async () => {
  const { m, client, cara } = await withUnworkedContact();
  const dan = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crm_dan", externalIds: contactExternalIds({ email: "dan@atlascloud.example", crm: { provider: "hubspot", crmId: "88" } }),
  });
  const ports = await editPorts(m, client, { object: "contact", id: cara, patch: { email: "dan@atlascloud.example" }, key: "c1" });
  const checked = await ports.check();
  assert.match(checked.refused.map((e) => e.message).join(), /already used by another person/);
  const out = await ports.ledger(checked.patch);
  assert.match(out.rejected.map((e) => e.message).join(), /already used by another person/, "a race past the check is still refused");
  assert.notEqual(m.externalIds.find((x) => x.provider === "record:contact" && x.externalId === cara)?.entityId, dan, "Cara's record is not linked to Dan");
  assert.equal(m.entries.some((e) => e.streamId === dan), false, "nothing was written to Dan's stream");
});

test("a new email an edit sets becomes an identity of the edited contact's own stream", async () => {
  const { m, cara, edit } = await withUnworkedContact();
  await edit(cara, { email: "Cara@AtlasCloud.example" }, "c1");
  const caraStream = m.externalIds.find((x) => x.provider === "record:contact" && x.externalId === cara)!.entityId;
  assert.equal(m.externalIds.find((x) => x.provider === "email" && x.externalId === "cara@atlascloud.example")?.entityId, caraStream);
  assert.equal(m.hotRows.get(caraStream)!.row.values.email, "Cara@AtlasCloud.example");
});

test("a deferred edit's fields the facts ledger does not track are reported, so the operation stays unclaimed and a retry lands them", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const op: PartySource = { kind: "user", userId: "u1", at: 1000, key: "k1" };
  m.stores.conversionBudget = { remaining: 0 };
  const deferred = await write(m, streamId, op, { status: "working", industry: "Data" }, 1000, tamSeed);
  assert.deepEqual(deferred.rejected.map((e) => e.field), ["status"]);
  assert.equal(m.externalIds.some((x) => x.provider === "op:account" && x.externalId === "k1"), false, "the operation is not claimed");

  m.stores.conversionBudget = { remaining: 3000, limit: 3000 };
  const retry = await write(m, streamId, op, { status: "working", industry: "Data" }, 2000, tamSeed);
  assert.deepEqual(retry.rejected, []);
  assert.deepEqual([m.hotRows.get(streamId)!.row.values.status, m.hotRows.get(streamId)!.row.values.industry], ["working", "Data"]);
  assert.equal(m.externalIds.some((x) => x.provider === "op:account" && x.externalId === "k1"), true);
  assert.equal(m.facts.filter((f) => f.attribute === "industry" && f.value === "Data").length, 1, "the retry did not repeat the fact-tracked field");
});

test("an email follows the contact that holds it: once Ada gives hers up and Bob takes it, a CRM sync and a promotion with that email resolve to Bob", async () => {
  const { m, ada, bob, edit, streamOf } = await twoContacts();
  await edit(ada, { email: "ada.lovelace@atlascloud.example" }, "a2");
  await edit(bob, { email: "ada@atlascloud.example" }, "b2");
  const holders = (email: string) => m.externalIds.filter((x) => x.provider === "email" && x.externalId === email).map((x) => x.entityId);
  assert.deepEqual(holders("ada@atlascloud.example"), [streamOf(bob)]);
  assert.deepEqual(holders("ada.lovelace@atlascloud.example"), [streamOf(ada)]);

  // convex/canon.ts saveCrmContact for Bob's HubSpot row.
  const bobCrm = { firstName: "Bob", lastName: "Byron", email: "ada@atlascloud.example", title: "Head of Sales" };
  const synced = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crm_bob", externalIds: contactExternalIds({ email: bobCrm.email, crm: { provider: "hubspot", crmId: "77" } }),
  });
  assert.equal(synced, streamOf(bob), "the CRM sync resolves to Bob's stream");
  await writeParty(m.stores, { orgId: ORG, object: "contact", streamId: synced, now: 5_000, source: { kind: "hubspot", crmId: "77" }, values: crmContactValues(bobCrm) });
  const adaRow = m.hotRows.get(streamOf(ada))!.row;
  assert.deepEqual([adaRow.values.fullName, adaRow.values.title, adaRow.values.email], ["Ada Lovelace", "CTO", "ada.lovelace@atlascloud.example"], "nothing of Bob reached Ada's stream");

  // convex/canonEntities.ts promoteRecords for a TAM row with that email.
  const promoted = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "con_bob_tam", externalIds: contactExternalIds({ email: "ADA@atlascloud.example", recordId: "con_bob_tam" }),
  });
  assert.equal(promoted, streamOf(bob));
});

test("a CRM row seen before resolves by its own id even when its email went stale and now belongs to someone else", async () => {
  const { m, ada, bob, edit, streamOf } = await twoContacts();
  const adaCrm = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crm_ada", externalIds: contactExternalIds({ email: "ada@atlascloud.example", crm: { provider: "hubspot", crmId: "55" } }),
  });
  assert.equal(adaCrm, streamOf(ada));
  await edit(ada, { email: "ada.lovelace@atlascloud.example" }, "a2");
  await edit(bob, { email: "ada@atlascloud.example" }, "b2");
  const resynced = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crm_ada", externalIds: contactExternalIds({ email: "ada@atlascloud.example", crm: { provider: "hubspot", crmId: "55" } }),
  });
  assert.equal(resynced, streamOf(ada), "Ada's HubSpot row still carrying her old email resolves to Ada, not to Bob who holds it now");
});

test("replaying an older email edit never restores the email identity the contact gave up", async () => {
  const { m, bob, edit, streamOf } = await twoContacts();
  await edit(bob, { email: "old@byron.example" }, "b2");
  await edit(bob, { email: "new@byron.example" }, "b3");
  await edit(bob, { email: "old@byron.example" }, "b2");
  const emailsOf = (stream: string) => m.externalIds.filter((x) => x.provider === "email" && x.entityId === stream).map((x) => x.externalId).sort();
  assert.deepEqual(emailsOf(streamOf(bob)), ["new@byron.example"]);
  assert.equal(m.hotRows.get(streamOf(bob))!.row.values.email, "new@byron.example");
});

test("converting a contact whose history resolves to a new email releases the old email it was identified by, so a later contact with that email gets its own stream", async () => {
  const m = memory();
  const ada = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "con_ada", externalIds: contactExternalIds({ email: "old@example.com", recordId: "con_ada" }),
  });
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: ada, entityType: "contact", sourceKind: "hubspot", sourceRefBase: "hubspot:contact:55", actor: { kind: "integration", id: "hubspot" },
    observedAt: 100, observations: [{ attribute: "fullName", value: "Ada Lovelace" }, { attribute: "email", value: "New@Example.com" }],
  });
  await write(m, ada, { kind: "user", userId: "u1" }, { title: "CTO" }, 1000, undefined, "contact");
  assert.equal(m.hotRows.get(ada)!.row.values.email, "New@Example.com");
  const emailsOf = (stream: string) => m.externalIds.filter((x) => x.provider === "email" && x.entityId === stream).map((x) => x.externalId).sort();
  assert.deepEqual(emailsOf(ada), ["new@example.com"]);
  const later = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "con_other", externalIds: contactExternalIds({ email: "old@example.com", recordId: "con_other" }),
  });
  assert.notEqual(later, ada, "the released email no longer resolves to Ada");
});

test("converting a contact whose history never mentions email keeps the email it was identified by", async () => {
  const m = memory();
  const ada = await ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "con_ada", externalIds: contactExternalIds({ email: "ada@example.com", recordId: "con_ada" }),
  });
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: ada, entityType: "contact", sourceKind: "hubspot", sourceRefBase: "hubspot:contact:55", actor: { kind: "integration", id: "hubspot" },
    observedAt: 100, observations: [{ attribute: "fullName", value: "Ada Lovelace" }],
  });
  await write(m, ada, { kind: "user", userId: "u1" }, { title: "CTO" }, 1000, undefined, "contact");
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "email" && x.entityId === ada).map((x) => x.externalId), ["ada@example.com"]);
});

test("another spelling of a domain an account holds is refused, and its identity stays with the holder", async () => {
  const m = memory();
  const atlas = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, atlas, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  const other = await entityFor(m, { crm: { provider: "hubspot", crmId: "9003" } }, "crm3");
  await write(m, other, { kind: "hubspot", crmId: "9003", rawData: { hs_lastmodifieddate: "2026-09-01T00:00:00Z" } }, crmAccountValues({ name: "Copycat", domain: `https://www.${HUBSPOT_ROW.domain}/about` }), 2000);
  assert.equal(m.externalIds.find((x) => x.provider === "domain" && x.externalId === HUBSPOT_ROW.domain)?.entityId, atlas);
  assert.equal(await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9004" } }, "crm4"), atlas, "a new CRM account with that domain joins the holder");
});

test("a domain follows the account that holds it: once one company moves to a new domain, another syncing the old one gets its own stream", async () => {
  const m = memory();
  const atlas = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await write(m, atlas, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  await write(m, atlas, hubspot("2026-09-02T00:00:00Z"), crmAccountValues({ ...HUBSPOT_ROW, domain: "atlas.example" }), 2000);
  assert.equal(m.externalIds.some((x) => x.provider === "domain" && x.externalId === HUBSPOT_ROW.domain), false, "the old domain no longer identifies Atlas");

  const other = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9002" } }, "crm2");
  assert.notEqual(other, atlas);
  await writeParty(m.stores, { orgId: ORG, object: "account", streamId: other, now: 3000, source: { kind: "hubspot", crmId: "9002" }, values: crmAccountValues({ name: "Atlas Cloud Labs", domain: HUBSPOT_ROW.domain }) });
  assert.equal(m.hotRows.get(atlas)!.row.values.name, "Atlas Cloud");
  assert.equal(await entityFor(m, { domain: HUBSPOT_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id), other, "a promotion of the TAM row resolves to the company that holds the domain");
});

test("an edit's ledger fields go only to the ledger, normalized once; the HTTP record service gets just the fields only it keeps", async () => {
  const m = memory();
  const sent: unknown[] = [];
  const client = createHttpRecordClient({
    baseUrl: "http://records.test", token: "t",
    fetchImpl: async (url, init) => {
      if (!String(url).endsWith("/records/edit")) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body));
      sent.push(body.payload ? { patch: body.patch, payload: true } : body.patch);
      return Response.json({ version: 2, at: 1_500 });
    },
  });
  const settled: string[] = [];
  const ports = { ...(await editPorts(m, client, { object: "account", id: "acc_1", patch: { industry: " Software ", country: "", employees: "450.4" }, key: "k1" })), settle: async () => void settled.push("acc_1") };
  await editPartyRecord(ports);
  assert.deepEqual(sent, [{ patch: {}, payload: true }], "the service only claims the key for the whole edit; the row takes the ledger's values from the projector's write-back");
  assert.deepEqual(settled, ["acc_1"], "the edit waits for the write-back");
  const stream = m.externalIds.find((x) => x.provider === "record:account" && x.externalId === "acc_1")!.entityId;
  const { row } = m.hotRows.get(stream)!;
  assert.deepEqual([row.values.industry, row.values.country, row.values.employees], ["Software", null, 450]);

  // A contact's triage status is the service's own: it goes there, the title to the ledger.
  const contactPorts = { ...(await editPorts(m, client, { object: "contact", id: "con_1", patch: { title: "CTO", status: "working" }, key: "k2" })), settle: async () => {} };
  contactPorts.check = async () => ({ patch: { title: "CTO", status: "working" }, refused: [] });
  await editPartyRecord(contactPorts);
  assert.deepEqual(sent.slice(1), [{ patch: { status: "working" }, payload: true }]);
  const contact = m.externalIds.find((x) => x.provider === "record:contact" && x.externalId === "con_1")!.entityId;
  assert.equal(m.hotRows.get(contact)!.row.values.title, "CTO");
});

test("accepting a pre-ledger email proposal on a contact with no stream is refused when another contact holds the email, as on a stream", async () => {
  const m = memory();
  const contact = (projectionId: string, email?: string) => ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId, externalIds: contactExternalIds({ email, recordId: projectionId }),
  });
  const ada = await contact("con_ada", "ada@atlascloud.example");
  await write(m, ada, { kind: "user", userId: "u1" }, { fullName: "Ada Lovelace", email: "ada@atlascloud.example" }, 1000, undefined, "contact");
  const bob = await contact("con_bob");
  // Stored before CP2a: in `facts` only, never mirrored to a stream.
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: bob, entityType: "contact", sourceKind: "agent_run", sourceRefBase: "agent_run:a1:bob", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "email", value: "ada@atlascloud.example", evidence: "team page", confidence: 0.9 }],
  });
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000, decisions: [{ factId: r.factIds.email, status: "accepted" }] });
  await assert.rejects(
    mirrorPartyDecisions(m.stores, { orgId: ORG, object: "contact", streamId: bob, now: 3000, decided: out.decided, decider: { kind: "user", userId: "u9" } }),
    /Email "ada@atlascloud.example" is already used by another person/,
  );
  assert.equal(m.entries.some((e) => e.streamId === bob), false, "Bob's stream was not converted with the duplicate");
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "unique:contact.email").map((x) => [x.entityId, x.externalId]), [[ada, "ada@atlascloud.example"]]);
});

test("an unchanged stale CRM re-sync does not re-link the domain the account gave up, and a new record for that domain gets its own stream", async () => {
  const m = memory();
  // convex/canon.ts saveCrmAccount: find the entity from the row's identity, then write its snapshot.
  const sync = async (modstamp: string, domain: string, now: number) => {
    const streamId = await entityFor(m, { domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
    await write(m, streamId, hubspot(modstamp), crmAccountValues({ ...HUBSPOT_ROW, domain }), now);
    return streamId;
  };
  const atlas = await sync("2026-09-01T00:00:00Z", HUBSPOT_ROW.domain, 1000);
  await sync("2026-09-02T00:00:00Z", "atlas.example", 2000);
  assert.equal(await sync("2026-09-01T00:00:00Z", HUBSPOT_ROW.domain, 3000), atlas, "the stale snapshot resolves to Atlas by its CRM id");
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "domain").map((x) => [x.entityId, x.externalId]), [[atlas, "atlas.example"]], "the old domain is not linked back to Atlas");
  assert.equal(m.hotRows.get(atlas)!.row.values.domain, "atlas.example");
  const tam = await entityFor(m, { domain: HUBSPOT_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  assert.notEqual(tam, atlas, "a promotion of a TAM row with the old domain does not join Atlas");
});

test("an unchanged stale CRM re-sync does not re-link the email the contact gave up, and a new record for that email gets its own stream", async () => {
  const m = memory();
  const contact = (projectionId: string, ids: { email?: string; recordId?: string; crm?: { provider: string; crmId: string } }) => ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: ids.crm ? "crmContacts" : "recordContacts", projectionId, externalIds: contactExternalIds(ids),
  });
  const sync = async (modstamp: string, email: string, now: number) => {
    const streamId = await contact("crm_ada", { email, crm: { provider: "hubspot", crmId: "55" } });
    await writeParty(m.stores, {
      orgId: ORG, object: "contact", streamId, now, source: { kind: "hubspot", crmId: "55", rawData: { properties: { hs_lastmodifieddate: modstamp } } },
      values: crmContactValues({ firstName: "Ada", lastName: "Lovelace", email, title: "CTO" }),
    });
    return streamId;
  };
  const ada = await sync("2026-09-01T00:00:00Z", "ada@atlascloud.example", 1000);
  await sync("2026-09-02T00:00:00Z", "ada.lovelace@atlascloud.example", 2000);
  assert.equal(await sync("2026-09-01T00:00:00Z", "ada@atlascloud.example", 3000), ada);
  assert.deepEqual(m.externalIds.filter((x) => x.provider === "email").map((x) => [x.entityId, x.externalId]), [[ada, "ada.lovelace@atlascloud.example"]], "the old email is not linked back to Ada");
  const promoted = await contact("con_bob", { email: "ada@atlascloud.example", recordId: "con_bob" });
  assert.notEqual(promoted, ada, "a promotion of a TAM row with the old email does not join Ada");
});

test("an org that denies HubSpot the industry field: a HubSpot sync appends every other field and no industry, on a stream or in facts only", async () => {
  const m = memory();
  m.ownership.push({ sourceKind: "hubspot", attribute: "industry", allowed: false, entityType: "account" });
  const atlas = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  const out = await write(m, atlas, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 1000);
  assert.equal(out.result.status, "applied");
  assert.deepEqual(out.rejected.map((e) => e.field), ["industry"]);
  const row = m.hotRows.get(atlas)!.row;
  assert.deepEqual([row.values.name, row.values.domain, row.values.industry ?? null], ["Atlas Cloud", HUBSPOT_ROW.domain, null]);
  assert.equal(m.facts.some((f) => f.attribute === "industry"), false);

  // No stream yet and no conversion budget: the facts-only fallback applies the same ownership.
  const other = await entityFor(m, { domain: "orbit.example", crm: { provider: "hubspot", crmId: "9002" } }, "crm2");
  m.stores.conversionBudget = { remaining: 0 };
  const deferred = await write(m, other, { kind: "hubspot", crmId: "9002" }, crmAccountValues({ name: "Orbit", domain: "orbit.example", industry: "Space" }), 2000);
  assert.equal(deferred.result.status, "deferred");
  assert.ok(deferred.rejected.some((e) => e.field === "industry"));
  const otherFacts = m.facts.filter((f) => f.entityId === other).map((f) => f.attribute);
  assert.ok(otherFacts.includes("name") && otherFacts.includes("domain"), "the other fields land in facts");
  assert.equal(otherFacts.includes("industry"), false, "industry is not written to facts");
});

test("a CRM seed that leaves out a field the history already accepted does not mark its snapshot seen: the full sync at the same stamp lands that field", async () => {
  const m = memory();
  const streamId = await entityFor(m, { domain: HUBSPOT_ROW.domain, crm: { provider: "hubspot", crmId: "9001" } }, "crm1");
  await ingestObservations(m.factStore, {
    orgId: ORG, entityId: streamId, entityType: "account", sourceKind: "user", sourceRefBase: "user:u1", actor: { kind: "user", id: "u1" },
    observedAt: 1000, observations: [{ attribute: "industry", value: "Old industry" }],
  });
  const crmSeed: PartySeed = { source: hubspot("2026-09-01T00:00:00Z"), values: crmAccountValues(HUBSPOT_ROW) };
  await write(m, streamId, { kind: "user", userId: "u2", at: 2000, key: "k1" }, { status: "working" }, 2000, crmSeed);
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Old industry", "the seed fills only fields with no accepted fact");

  const sync = await write(m, streamId, hubspot("2026-09-01T00:00:00Z"), crmAccountValues(HUBSPOT_ROW), 3000);
  assert.equal(sync.result.status, "applied");
  assert.equal(m.hotRows.get(streamId)!.row.values.industry, "Software", "HubSpot's newer snapshot outranks the older user fact");
  assert.equal(m.hotRows.get(streamId)!.state.watermarks.find((w) => w.sourceKind === "hubspot")?.validFrom, Date.parse("2026-09-01T00:00:00Z"));
});

test("a CRM sync batch stops before a record once its facts-read budget is spent, hands back the rest, and resubmitting them completes the batch", async () => {
  const m = memory();
  let factReads = 0;
  const factsFor = m.factStore.factsFor.bind(m.factStore);
  m.factStore.factsFor = async (entityId, attribute) => {
    const out = await factsFor(entityId, attribute);
    factReads += out.length;
    return out;
  };
  const rows = ["1", "2", "3", "4"].map((crmId) => ({ crmId, name: `Co ${crmId}` }));
  const streams = new Map<string, string>();
  for (const r of rows) streams.set(r.crmId, await entityFor(m, { crm: { provider: "hubspot", crmId: r.crmId } }, `crm${r.crmId}`));
  const sync = (r: { crmId: string; name: string }, industry: string, stamp: string) =>
    write(m, streams.get(r.crmId)!, { kind: "hubspot", crmId: r.crmId, rawData: { properties: { hs_lastmodifieddate: stamp } } }, crmAccountValues({ name: r.name, industry }), Date.parse(stamp));
  for (const r of rows) await sync(r, "Software", "2026-09-01T00:00:00Z");

  // Each record's re-sync appends industry and re-resolves it from its two facts: two reads per record, four per transaction.
  const submitted: string[][] = [];
  await resubmitUnprocessed(rows, async (batch) => {
    submitted.push(batch.map((r) => r.crmId));
    factReads = 0;
    const { unprocessed } = await syncPartyBatch(batch, { hasBudget: () => factReads < 4, visit: (r) => sync(r, "Data", "2026-09-02T00:00:00Z") });
    return unprocessed;
  });
  assert.deepEqual(submitted, [["1", "2", "3", "4"], ["3", "4"]]);
  assert.deepEqual(rows.map((r) => m.hotRows.get(streams.get(r.crmId)!)!.row.values.industry), ["Data", "Data", "Data", "Data"]);

  const spent = await syncPartyBatch(rows, { hasBudget: () => false, visit: (r) => sync(r, "Hardware", "2026-09-03T00:00:00Z") });
  assert.deepEqual(spent.unprocessed.map((r) => r.crmId), ["2", "3", "4"], "a transaction always takes its first record, so every resubmission makes progress");
  assert.equal(m.hotRows.get(streams.get("1")!)!.row.values.industry, "Hardware");
});

test("a CRM sync onto a contact with the email of another contact that has identity but no stream is refused, the other keeps its email, and its own CRM twin still converges", async () => {
  const m = memory();
  const contact = (projectionId: string, ids: { email?: string; recordId?: string; crm?: { provider: string; crmId: string } }) => ensureEntity(m.factStore, {
    orgId: ORG, entityType: "contact", projectionTable: ids.crm ? "crmContacts" : "recordContacts", projectionId, externalIds: contactExternalIds(ids),
  });
  // Bea: a TAM contact a research run only anchored (convex/canonEntities.ts promoteRecords without seed): an email identity, no stream.
  const bea = await contact("con_bea", { email: "bea@atlascloud.example", recordId: "con_bea" });
  // convex/canon.ts saveCrmContact: find the entity from the row's identity, then write its snapshot.
  const sync = async (projectionId: string, crmId: string, email: string, stamp: string, now: number) => {
    const streamId = await contact(projectionId, { email, crm: { provider: "hubspot", crmId } });
    const out = await writeParty(m.stores, {
      orgId: ORG, object: "contact", streamId, now, source: { kind: "hubspot", crmId, rawData: { properties: { hs_lastmodifieddate: stamp } } },
      values: crmContactValues({ firstName: "Ada", lastName: "Lovelace", email, title: "CTO" }),
    });
    return { streamId, out };
  };
  const ada = await sync("crm_ada", "55", "ada@atlascloud.example", "2026-09-01T00:00:00Z", 1000);
  const moved = await sync("crm_ada", "55", "bea@atlascloud.example", "2026-09-02T00:00:00Z", 2000);
  assert.equal(moved.streamId, ada.streamId, "the re-sync resolves to Ada by her CRM id");
  assert.deepEqual(moved.out.rejected.map((e) => [e.field, e.retryable]), [["email", true]], "refused for now, so the snapshot is retried");
  const emailHolders = (email: string) => m.externalIds.filter((x) => x.externalId === email && (x.provider === "email" || x.provider === "unique:contact.email")).map((x) => [x.provider, x.entityId]);
  assert.deepEqual(emailHolders("bea@atlascloud.example"), [["email", bea]], "Bea keeps her email identity and nobody claims it");
  assert.equal(m.hotRows.get(ada.streamId)!.row.values.email, "ada@atlascloud.example");

  // Bea's own HubSpot row carries her email: it resolves to her entity, which holds the identity, so it is no conflict.
  const twin = await sync("crm_bea", "66", "bea@atlascloud.example", "2026-09-03T00:00:00Z", 3000);
  assert.equal(twin.streamId, bea);
  assert.deepEqual(twin.out.rejected, []);
  assert.deepEqual(emailHolders("bea@atlascloud.example").sort(), [["email", bea], ["unique:contact.email", bea]]);
});

test("a promotion's contacts run within the facts-read budget: those a transaction did not reach go in the next one with their account, and an account with no people is still promoted", async () => {
  // convex/canonEntities.ts promote over promoteRecords: each transaction writes the account, then contacts while its budget holds.
  const promote = async (contacts: string[], perTransaction: number) => {
    const transactions: Array<{ account: string; contacts: string[] }> = [];
    await resubmitUnprocessed(contacts, async (batch) => {
      const t = { account: "acc_1", contacts: [] as string[] };
      transactions.push(t);
      const { unprocessed } = await syncPartyBatch(batch, { hasBudget: () => t.contacts.length < perTransaction, visit: async (c) => t.contacts.push(c) });
      return unprocessed;
    });
    return transactions;
  };
  assert.deepEqual(await promote(["c1", "c2", "c3", "c4", "c5"], 2), [
    { account: "acc_1", contacts: ["c1", "c2"] },
    { account: "acc_1", contacts: ["c3", "c4"] },
    { account: "acc_1", contacts: ["c5"] },
  ]);
  assert.deepEqual(await promote([], 2), [{ account: "acc_1", contacts: [] }]);
});

test("without a record service that keeps the register (an older one mid-deploy, or the fake), the row is also sent the ledger's fields", async () => {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  const { ids: [acc] } = await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  let settled = false;
  const ports = { ...(await editPorts(m, client, { object: "account", id: acc, patch: { industry: "Software" }, key: "k1" })), register: false, settle: async () => void (settled = true) };
  const response = await editPartyRecord(ports);
  assert.equal((await client.get(ORG, acc))!.account.industry, "Software", "the row took the edit directly");
  const entry = m.entries.at(-1)!;
  const assertion = entry.body.kind === "assert" ? entry.body.assertions.find((x) => x.fieldId === "industry") : undefined;
  assert.equal(assertion?.validFrom, response.at, "the ledger's copy is ordered by the service's commit time");
  assert.equal(settled, false, "nothing waits for a write-back that will not come");
  const stream = m.externalIds.find((x) => x.provider === "record:account" && x.externalId === acc)!.entityId;
  assert.equal(m.hotRows.get(stream)!.row.values.industry, "Software");
});

test("an edit the ledger could only defer (a history too large for this transaction) reaches the row directly, since nothing will write it back", async () => {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  const { ids: [acc] } = await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  let settled = false;
  const ports = {
    ...(await editPorts(m, client, { object: "account", id: acc, patch: { industry: "Software" }, key: "k1" })),
    ledger: async () => ({ rejected: [], deferred: true }),
    settle: async () => void (settled = true),
  };
  await editPartyRecord(ports);
  assert.equal((await client.get(ORG, acc))!.account.industry, "Software");
  assert.equal(settled, false);
});

test("a key reused for a different edit is refused before the ledger is written, not answered as a replay", async () => {
  const { m, ada, edit, streamOf } = await twoContacts();
  await edit(ada, { title: "VP Engineering" }, "same-key");
  await edit(ada, { title: "VP Engineering" }, "same-key");
  const count = m.entries.length;
  await assert.rejects(edit(ada, { title: "CEO" }, "same-key"), /idempotency key same-key was already used for a different request/);
  assert.equal(m.entries.length, count);
  assert.equal(m.hotRows.get(streamOf(ada))!.row.values.title, "VP Engineering");
});

test("an edit of a row the register links to a stream lands on that stream, even when nothing else identifies the record", async () => {
  const m = memory();
  // A CRM-only contact with no email: its stream exists, and the projector added a row for it.
  const dan = await ensureEntity(m.factStore, { orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "crm_dan", externalIds: contactExternalIds({ crm: { provider: "hubspot", crmId: "88" } }) });
  await write(m, dan, { kind: "hubspot", crmId: "88" }, { fullName: "Dan Moss" }, 1000, undefined, "contact");
  const out = await writeRecordEdit(m.stores, { orgId: ORG, object: "contact", recordId: "con_s_dan", patch: { title: "CFO" }, userId: "u1", key: "d1", now: 2000, streamId: dan });
  assert.equal(out.entityId, dan, "no second stream");
  assert.equal(m.hotRows.get(dan)!.row.values.title, "CFO");
  assert.equal(m.externalIds.find((x) => x.provider === "record:contact" && x.externalId === "con_s_dan")?.entityId, dan);
});

test("the record service claims a key for the whole edit: reusing it with another service-only field is refused before the ledger is written", async () => {
  const { m, client, ada, streamOf } = await twoContacts();
  const ports = async (patch: Record<string, string | number | null>) => ({ ...(await editPorts(m, client, { object: "contact", id: ada, patch, key: "k9" })), check: async () => ({ patch, refused: [] }) });
  await editPartyRecord(await ports({ title: "CTO" }));
  const count = m.entries.length;
  await assert.rejects(editPartyRecord(await ports({ title: "CTO", status: "working" })), /already used for a different request/);
  assert.equal(m.entries.length, count);
  assert.equal(m.hotRows.get(streamOf(ada))!.row.values.title, "CTO");
});

test("an edit of a record the service does not have fails before the ledger is written", async () => {
  const m = memory();
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 1_000 });
  await client.upsertAccounts(ORG, { records: [{ domain: TAM_ROW.domain, name: TAM_ROW.name }], source: "pdl", idempotencyKey: "seed" });
  await assert.rejects(editPartyRecord(await editPorts(m, client, { object: "account", id: "acc_missing", patch: { industry: "Software" }, key: "k1" })), /not found/);
  assert.equal(m.entries.length, 0);
});

test("a Salesforce value the sync decided wins (its authority, or a person's resolution) is re-asserted, so it beats a newer edit; a plain repeat does not", async () => {
  const m = memory();
  const acc = await ensureEntity(m.factStore, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "acc_r", externalIds: accountExternalIds({ recordId: "acc_r", crm: { provider: "salesforce", crmId: "001R" } }) });
  const sf = (at: number) => ({ kind: "salesforce" as const, crmId: "001R", rawData: { SystemModstamp: at } });
  await write(m, acc, sf(1000), { name: "R Co", industry: "Retail" }, 1000);
  await write(m, acc, { kind: "user", userId: "u1" }, { industry: "Software" }, 2000);
  const again = (at: number, reassert: boolean) => writeParty(m.stores, {
    orgId: ORG, object: "account", streamId: acc, now: at, values: { industry: "Retail" }, source: sf(at), partial: true, ...(reassert ? { reassert: true as const } : {}),
  });
  await again(3000, false);
  assert.equal(m.hotRows.get(acc)!.row.values.industry, "Software", "Salesforce repeating itself is not news");
  await again(3000, true);
  assert.equal(m.hotRows.get(acc)!.row.values.industry, "Retail");
});

test("importing the same CSV twice changes nothing the second time, matched and new rows alike", async () => {
  const m = memory();
  const tam = await entityFor(m, { domain: TAM_ROW.domain, recordId: TAM_ROW.id }, TAM_ROW.id);
  const records = parseCsv("Company,Website,Industry\nAtlas,atlascloud.example,Cloud\nBeacon,beacon.example,Retail\nNo Domain Co,,Retail\n");
  const match: ImportMatch = { recordId: TAM_ROW.id, stream: null, snapshot: TAM_ROW };
  const run = async (now: number) => {
    const outcomes = classify("account", accountDef, readRows("account", accountDef, autoMap("account", accountDef, records[0]), records), new Map([[TAM_ROW.domain, match]]));
    const statuses = [];
    for (const outcome of outcomes) {
      if (outcome.kind !== "create" && outcome.kind !== "update") continue;
      const out = await writeImportRow(m.stores, { orgId: ORG, object: "account", importId: "account-file1", actorId: "u1", now, outcome });
      statuses.push(out.result.status);
    }
    return statuses;
  };
  assert.deepEqual(await run(1000), ["applied", "applied", "applied"]);
  assert.equal(m.hotRows.get(tam)!.row.values.industry, "Cloud", "the matched TAM row is promoted onto its stream, the CSV value newer than its seed");
  const counts = () => [m.entries.length, m.entities.length, m.facts.length];
  const before = counts();
  assert.deepEqual(await run(2000), ["unchanged", "unchanged", "unchanged"]);
  assert.deepEqual(counts(), before);
});

test("deleting an unworked TAM account promotes it first; restoring it brings it back, and a repeat of either changes nothing", async () => {
  const m = memory();
  const lifecycle = (op: "delete" | "restore", now: number) =>
    writeRecordLifecycle(m.stores, { orgId: ORG, object: "account", recordId: TAM_ROW.id, op, userId: "u1", now, snapshot: TAM_ROW });
  const deleted = await lifecycle("delete", 1000);
  assert.equal(deleted.result.status, "applied");
  assert.deepEqual(kinds(m, deleted.entityId), ["import:create", "import:assert/accepted", "user:delete"]);
  const hot = () => m.hotRows.get(deleted.entityId)!;
  assert.deepEqual([hot().state.lifecycle.status, hot().row.values.name], ["deleted", "Atlas Cloud Inc"]);

  assert.equal((await lifecycle("delete", 2000)).result.status, "unchanged");
  assert.equal((await lifecycle("restore", 3000)).result.status, "applied");
  assert.equal(hot().state.lifecycle.status, "active");
  assert.deepEqual(kinds(m, deleted.entityId).slice(-2), ["user:delete", "user:restore"]);
  assert.equal(m.entities.length, 1, "restore found the same stream");
});

test("an edit made on a condition writes only while the record still holds it, checked in the write's own transaction", async () => {
  const m = memory();
  const snapshot = { ...TAM_ROW, ownerId: "u_ava" };
  const edit = (key: string, ownerId: string, expect: string, now: number) =>
    writeRecordEdit(m.stores, { orgId: ORG, object: "account", recordId: TAM_ROW.id, patch: { ownerId }, userId: "u1", key, now, snapshot, expect: { ownerId: expect } });
  // A first edit promotes the row: the condition is judged against the row it starts from.
  assert.equal((await edit("e1", "u_ben", "u_cal", 1000)).result.status, "conflict");
  assert.equal(m.entries.length, 0, "nothing written");
  assert.equal((await edit("e2", "u_ben", "u_ava", 2000)).result.status, "applied");
  const count = m.entries.length;
  // The record moved on (now u_ben): a proposal that read u_ava writes nothing.
  assert.equal((await edit("e3", "u_cal", "u_ava", 3000)).result.status, "conflict");
  assert.equal(m.entries.length, count);
});
