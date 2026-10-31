import assert from "node:assert/strict";
import test from "node:test";
import {
  DEAL_ATTRIBUTES,
  decideFacts,
  dealObservations,
  dealPatch,
  divergences,
  ensureEntity,
  ingestObservations,
  providerModifiedAt,
  type FieldStateRow,
  type LedgerStore,
  type NewFact,
  type StoredFact,
} from "../convex/lib/canon/ledger.ts";
import { accountExternalIds, contactExternalIds } from "../convex/lib/canon/identity.ts";

/** In-memory LedgerStore with the same semantics as the Convex adapter. */
function memoryStore() {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const entities: Array<{ _id: string; orgId: string; projectionId: string }> = [];
  const externalIds: Array<{ orgId: string; entityId: string; provider: string; externalId: string }> = [];
  const facts: StoredFact[] = [];
  const fieldState = new Map<string, FieldStateRow>();
  const shadow = new Map<string, unknown>();
  const store: LedgerStore = {
    async findEntityByExternalId(orgId, provider, externalId) {
      return externalIds.find((x) => x.orgId === orgId && x.provider === provider && x.externalId === externalId)?.entityId ?? null;
    },
    async findEntityByProjection(orgId, projectionId) {
      return entities.find((e) => e.orgId === orgId && e.projectionId === projectionId)?._id ?? null;
    },
    async createEntity(e) {
      const _id = id("ent");
      entities.push({ _id, orgId: e.orgId, projectionId: e.projectionId });
      return _id;
    },
    async addExternalId(e) {
      externalIds.push(e);
    },
    async latestBySourceRef(orgId, sourceRef) {
      return facts.filter((f) => f.orgId === orgId && f.sourceRef === sourceRef).sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
    },
    async insertFact(f: NewFact) {
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
      return facts.filter((f) => f.entityId === entityId && f.attribute === attribute).sort((a, b) => b.observedAt - a.observedAt);
    },
    async upsertFieldState(row) {
      fieldState.set(`${row.entityId}:${row.attribute}`, row);
    },
    async recordShadowOutbound(row) {
      shadow.set(`${row.entityId}:${row.provider}:${row.attribute}`, row);
    },
    // No object-layer ledger here: no entity has a stream.
    async hasStream() {
      return false;
    },
  };
  return { store, facts, entities, externalIds, fieldState, shadow };
}

const ORG = "org1";
const deal = {
  name: "Acme renewal", amount: 500000, currency: "USD", closeDate: "2026-12-01", stage: "Negotiation",
  forecastCategory: "commit", probability: 0.7, isClosed: false, isWon: false, crmOwnerId: "005A", dealType: "renewal",
};
const SYNCED = DEAL_ATTRIBUTES.filter((a) => a !== "nextStep");

async function syncOnce(m: ReturnType<typeof memoryStore>, values: Partial<typeof deal>, at: number) {
  const entityId = await ensureEntity(m.store, { orgId: ORG, projectionId: "deal1", provider: "salesforce", externalId: "006X" });
  const observations = dealObservations({ ...deal, ...values }, SYNCED, at - 500);
  const result = await ingestObservations(m.store, {
    orgId: ORG, entityId, sourceKind: "salesforce", sourceRefBase: "salesforce:006X",
    actor: { kind: "integration", id: "salesforce" }, observedAt: at, observations,
  });
  return { entityId, observations, result };
}

test("ingest is idempotent: re-syncing unchanged values writes no new facts", async () => {
  const m = memoryStore();
  const first = await syncOnce(m, {}, 1000);
  assert.equal(first.result.written, SYNCED.length);
  assert.equal(m.facts.length, SYNCED.length);
  const second = await syncOnce(m, {}, 2000);
  assert.equal(second.result.written, 0);
  assert.equal(second.result.confirmed, SYNCED.length);
  assert.equal(m.facts.length, SYNCED.length, "no duplicates");
  assert.ok(m.facts.every((f) => f.lastConfirmedAt === 2000), "re-observation bumps lastConfirmedAt");
  assert.equal(m.entities.length, 1, "the provider id maps back to the same entity");
  assert.equal(m.externalIds.length, 1);
});

test("a changed value appends one fact and resolves to it; history is kept", async () => {
  const m = memoryStore();
  await syncOnce(m, {}, 1000);
  const r = await syncOnce(m, { amount: 650000 }, 2000);
  assert.equal(r.result.written, 1);
  assert.equal(r.result.resolved.amount.value, 650000);
  const amountFacts = m.facts.filter((f) => f.attribute === "amount").map((f) => f.value);
  assert.deepEqual(amountFacts, [500000, 650000], "the ledger keeps both values");
  assert.equal(m.fieldState.get(`${r.entityId}:amount`)?.state, "resolved");
});

test("CRM and import facts are accepted on ingest; other sources are proposed", async () => {
  const m = memoryStore();
  const { entityId } = await syncOnce(m, {}, 1000);
  assert.ok(m.facts.every((f) => f.status === "accepted"));
  const r = await ingestObservations(m.store, {
    orgId: ORG, entityId, sourceKind: "enrichment", sourceRefBase: "clay:run9", actor: { kind: "agent", id: "clay" },
    observedAt: 3000, observations: [{ attribute: "closeDate", value: "2027-03-01" }],
  });
  assert.equal(m.facts.find((f) => f.sourceKind === "enrichment")?.status, "proposed");
  assert.equal(r.resolved.closeDate.value, "2026-12-01", "a proposed fact does not change the canonical value");
});

test("a user override survives an unchanged re-sync: the row is re-projected and the diff shadowed", async () => {
  const m = memoryStore();
  const { entityId } = await syncOnce(m, {}, 1000);
  await ingestObservations(m.store, {
    orgId: ORG, entityId, sourceKind: "user", sourceRefBase: "user:u1:deal1", actor: { kind: "user", id: "u1" },
    observedAt: 2000, observations: [{ attribute: "forecastCategory", value: "best_case" }],
  });
  // The next sync still says "commit" (unchanged in Salesforce, so its fact is only re-confirmed).
  const again = await syncOnce(m, {}, 3000);
  const diffs = divergences(again.observations, again.result.resolved);
  assert.deepEqual(diffs.map((d) => [d.attribute, d.providerValue, d.canonicalValue]), [["forecastCategory", "commit", "best_case"]]);
  assert.deepEqual(dealPatch(diffs), { forecastCategory: "best_case" });
  // If the rep then changes it in Salesforce, the newer CRM fact wins.
  const changed = await syncOnce(m, { forecastCategory: "pipeline" }, 4000);
  assert.equal(changed.result.resolved.forecastCategory.value, "pipeline");
  assert.equal(divergences(changed.observations, changed.result.resolved).length, 0);
});

test("projection never clears a required deal column", () => {
  assert.deepEqual(dealPatch([{ attribute: "name", canonicalValue: null }, { attribute: "amount", canonicalValue: null }]), { amount: undefined });
});

test("valid time comes from the provider's modified timestamp", () => {
  assert.equal(providerModifiedAt({ SystemModstamp: "2026-09-30T12:00:00.000+0000" }), Date.parse("2026-09-30T12:00:00.000+0000"));
  assert.equal(providerModifiedAt({ updatedAt: "2026-09-30T12:00:00Z" }), Date.parse("2026-09-30T12:00:00Z"));
  assert.equal(providerModifiedAt({ properties: { hs_lastmodifieddate: "2026-09-29T00:00:00Z" } }), Date.parse("2026-09-29T00:00:00Z"));
  assert.equal(providerModifiedAt({}), undefined);
  assert.equal(providerModifiedAt(null), undefined);
});

async function propose(m: ReturnType<typeof memoryStore>, entityId: string, observations: Array<{ attribute: string; value: string | number; evidence?: string }>, at: number) {
  return ingestObservations(m.store, {
    orgId: ORG, entityId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: at, observations, patchPlanId: "plan1",
  });
}

test("field ownership: an agent may not write protected fields; they are rejected at ingest", async () => {
  const m = memoryStore();
  const { entityId } = await syncOnce(m, {}, 1000);
  const before = m.facts.length;
  const r = await propose(m, entityId, [{ attribute: "crmOwnerId", value: "005B" }, { attribute: "amount", value: 1 }, { attribute: "nextStep", value: "Send MSA" }], 2000);
  assert.deepEqual(r.rejected, ["crmOwnerId", "amount"]);
  assert.equal(m.facts.length, before + 1, "nothing is stored for disallowed fields");
  const ns = m.facts.find((f) => f.attribute === "nextStep");
  assert.equal(ns?.status, "proposed");
  assert.equal(ns?.patchPlanId, "plan1");
  // An org override lets the agent propose (still only propose) a close date and amount.
  const allowed = await ingestObservations(m.store, {
    orgId: ORG, entityId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: 3000, observations: [{ attribute: "amount", value: 1 }], ownership: [{ sourceKind: "agent_run", attribute: "amount", allowed: true }],
  });
  assert.deepEqual(allowed.rejected, []);
  assert.equal(allowed.resolved.amount.value, 500000, "a proposal never changes the canonical value");
});

test("approving a proposed fact makes it canonical; rejecting leaves the value; decisions apply once", async () => {
  const m = memoryStore();
  const { entityId } = await syncOnce(m, {}, 1000);
  const r = await propose(m, entityId, [{ attribute: "nextStep", value: "Send MSA" }, { attribute: "closeDate", value: "2027-01-15" }], 2000);
  const out = await decideFacts(m.store, {
    orgId: ORG, decider: { kind: "user", userId: "u1" }, at: 3000,
    decisions: [{ factId: r.factIds.nextStep, status: "accepted" }, { factId: r.factIds.closeDate, status: "rejected" }],
  });
  assert.equal(out.decided.length, 2);
  assert.equal(out.resolved.get(entityId)?.nextStep.value, "Send MSA");
  assert.equal(out.resolved.get(entityId)?.closeDate.value, "2026-12-01", "the CRM value stands");
  assert.equal(m.facts.find((f) => f._id === r.factIds.nextStep)?.decidedBy, "user:u1");
  const again = await decideFacts(m.store, { orgId: ORG, decider: { kind: "user", userId: "u2" }, at: 4000, decisions: [{ factId: r.factIds.closeDate, status: "accepted" }] });
  assert.deepEqual(again.skipped, [r.factIds.closeDate], "a decided fact cannot be re-decided");
  const otherOrg = await decideFacts(m.store, { orgId: "org2", decider: { kind: "user", userId: "x" }, at: 4000, decisions: [{ factId: r.factIds.nextStep, status: "rejected" }] });
  assert.equal(otherOrg.decided.length, 0, "another org cannot decide this org's facts");
});

test("accounts: a CRM row and the TAM row for the same company share one entity through the domain", async () => {
  const m = memoryStore();
  const tam = await ensureEntity(m.store, {
    orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "acc_acme_com", label: "Acme",
    externalIds: accountExternalIds({ domain: "https://www.Acme.com/", recordId: "acc_acme_com" }),
  });
  const crm = await ensureEntity(m.store, {
    orgId: ORG, entityType: "account", projectionTable: "crmAccounts", projectionId: "crmrow1", label: "Acme Inc",
    externalIds: accountExternalIds({ domain: "acme.com", crm: { provider: "hubspot", crmId: "901" } }),
  });
  assert.equal(crm, tam);
  assert.equal(m.entities.length, 1);
  assert.deepEqual(m.externalIds.map((x) => `${x.provider}=${x.externalId}`).sort(), ["domain=acme.com", "hubspot:account=901", "record:account=acc_acme_com"]);
  // Idempotent: promoting again adds nothing.
  await ensureEntity(m.store, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "acc_acme_com", externalIds: accountExternalIds({ domain: "acme.com", recordId: "acc_acme_com" }) });
  assert.equal(m.externalIds.length, 3);
  // A HubSpot company id never matches a HubSpot deal with the same id.
  const dealEntity = await ensureEntity(m.store, { orgId: ORG, projectionId: "deal9", provider: "hubspot", externalId: "901" });
  assert.notEqual(dealEntity, tam);
});

test("contacts are keyed by email first; a contact without email falls back to its record id", async () => {
  const m = memoryStore();
  const a = await ensureEntity(m.store, { orgId: ORG, entityType: "contact", projectionTable: "recordContacts", projectionId: "con_1", externalIds: contactExternalIds({ email: " Ana@Acme.com ", recordId: "con_1" }) });
  const b = await ensureEntity(m.store, { orgId: ORG, entityType: "contact", projectionTable: "crmContacts", projectionId: "row7", externalIds: contactExternalIds({ email: "ana@acme.com", crm: { provider: "salesforce", crmId: "003A" } }) });
  assert.equal(a, b);
  assert.deepEqual(contactExternalIds({ email: "not-an-email", recordId: "con_2" }), [{ provider: "record:contact", externalId: "con_2" }]);
});

test("account facts carry their entity type; agents may not rename or re-own an account but may answer custom attributes", async () => {
  const m = memoryStore();
  const entityId = await ensureEntity(m.store, { orgId: ORG, entityType: "account", projectionTable: "recordAccounts", projectionId: "acc_acme_com", externalIds: accountExternalIds({ domain: "acme.com" }) });
  const r = await ingestObservations(m.store, {
    orgId: ORG, entityId, entityType: "account", sourceKind: "agent_run", sourceRefBase: `agent_run:ehr:${entityId}`, actor: { kind: "agent", id: "ehr" }, observedAt: 1000,
    observations: [
      { attribute: "domain", value: "acme.io" },
      { attribute: "ownerId", value: "u2" },
      { attribute: "custom.ehr_vendor", value: "Epic", evidence: "We run on Epic." },
      { attribute: "industry", value: "Healthcare" },
    ],
  });
  assert.deepEqual(r.rejected, ["domain", "ownerId"]);
  assert.equal(m.facts.length, 2);
  assert.ok(m.facts.every((f) => f.entityType === "account" && f.status === "proposed"));
  assert.equal(r.resolved["custom.ehr_vendor"].value, null, "a proposal is not canonical until accepted");
  // A deal-scoped override does not open the same attribute on accounts.
  const scoped = await ingestObservations(m.store, {
    orgId: ORG, entityId, entityType: "account", sourceKind: "agent_run", sourceRefBase: `agent_run:ehr:${entityId}`, actor: { kind: "agent", id: "ehr" }, observedAt: 2000,
    observations: [{ attribute: "name", value: "Acme Health" }], ownership: [{ sourceKind: "agent_run", attribute: "name", allowed: true }],
  });
  assert.deepEqual(scoped.rejected, ["name"]);
});
