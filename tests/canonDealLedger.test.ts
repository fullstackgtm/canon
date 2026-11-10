import assert from "node:assert/strict";
import test from "node:test";
import { compareDeal, dealRowPatch, ensureDealStream, mirrorDecisions, mirrorProposal, projectDealRow, writeDeal, writeDealLifecycle, type DealSource, type DealStores, type DealValues } from "../convex/lib/canon/dealLedger.ts";
import { factsToEntries, mirrorAppended, type MirrorJob } from "../convex/lib/canon/streamLedger.ts";
import { DEAL_ATTRIBUTES, decideFacts, ensureEntity, ingestObservations, type FieldStateRow, type LedgerStore, type StoredFact } from "../convex/lib/canon/ledger.ts";
import { resolveAttribute, type SourceKind } from "../convex/lib/canon/policy.ts";
import { foldAll, project, type FoldState, type ProjectedRow } from "../convex/lib/objects/fold.ts";
import { coerce, matchPicklistOption, resolveObjectDef, STANDARD_OBJECTS, withPicklistOption, type OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import type { ObjectStore, Proposal, StoredEntry } from "../convex/lib/objects/write.ts";
import { planDealCreate, resolvePipelines, withStageOutcome } from "../convex/lib/pipelines.ts";
import { companyDeals } from "../convex/lib/dealCompany.ts";
import { autoMap, classifyDeals, dealCreateInput, matchCompanies, parseCsv, readRows } from "../convex/lib/objects/csvImport.ts";

const ORG = "org1";

/** In-memory stores with the semantics of convexLedgerStore, convexObjectStore and the deals table. */
function memory() {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const entities: Array<{ _id: string; orgId: string; projectionId: string }> = [];
  const externalIds: Array<{ orgId: string; entityId: string; provider: string; externalId: string }> = [];
  const facts: StoredFact[] = [];
  const fieldState = new Map<string, FieldStateRow>();
  const shadow = new Map<string, { providerValue: unknown; canonicalValue: unknown }>();
  const factStore: LedgerStore = {
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
      // As Convex reads the index: newest observedAt first, and on a tie the later-created fact first.
      return facts.map((f, i) => ({ f, i })).filter(({ f }) => f.entityId === entityId && f.attribute === attribute)
        .sort((a, b) => b.f.observedAt - a.f.observedAt || b.i - a.i).map(({ f }) => f);
    },
    async upsertFieldState(row) {
      fieldState.set(`${row.entityId}:${row.attribute}`, row);
    },
    async recordShadowOutbound(row) {
      shadow.set(`${row.attribute}`, { providerValue: row.providerValue, canonicalValue: row.canonicalValue });
    },
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
      return e ? { orgId: e.orgId, object: "deal" } : null;
    },
    async getHotRow(streamId) {
      return hotRows.get(streamId)?.state ?? null;
    },
    async readEntries(streamId, afterVersion, limit) {
      return entries.filter((e) => e.streamId === streamId && e.version > afterVersion).sort((a, b) => a.version - b.version).slice(0, limit);
    },
    async createStream() {
      throw new Error("deal streams are canonEntities rows");
    },
    async findByExternalId() {
      return null;
    },
    async addExternalId() {},
    async removeExternalId() {},
    async externalIdsOf() {
      return [];
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

  const rows = new Map<string, Record<string, unknown>>();
  const stores: DealStores = {
    facts: factStore,
    objects: objectStore,
    async getRow(dealId) {
      return rows.get(dealId) ?? null;
    },
    async patchRow(dealId, patch) {
      const row = rows.get(dealId)!;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete row[k];
        else row[k] = v;
      }
    },
  };
  return { stores, factStore, entities, facts, fieldState, shadow, entries, hotRows, proposals, rows };
}

type Memory = ReturnType<typeof memory>;

const STAGES = ["Discovery", "Negotiation", "Closed Won"];
let ext: OrgObjectExtension | undefined;
for (const stage of STAGES) ext = withPicklistOption(STANDARD_OBJECTS.deal, ext, "stage", stage) ?? ext;
const def = resolveObjectDef(STANDARD_OBJECTS.deal, ext);

const DEAL = {
  name: "Acme renewal", amount: 500000, currency: "USD", closeDate: "2026-12-01", stage: "Discovery",
  forecastCategory: "commit", probability: 0.4, isClosed: false, isWon: false, crmOwnerId: "005A", dealType: "renewal",
};

async function newDeal(m: Memory, dealId = "deal1", row: Record<string, unknown> = { ...DEAL }) {
  m.rows.set(dealId, row);
  const streamId = await ensureEntity(m.factStore, { orgId: ORG, projectionId: dealId });
  return { dealId, streamId };
}

const write = (m: Memory, d: { dealId: string; streamId: string }, source: DealSource, values: DealValues, now: number, evidence?: string) =>
  writeDeal(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, source, values, now, ...(evidence ? { evidence } : {}) });

const sync = (m: Memory, d: { dealId: string; streamId: string }, values: DealValues, modstamp: string, now: number) =>
  write(m, d, { kind: "salesforce", crmId: "006X", rawData: { SystemModstamp: modstamp } }, values, now);

const kinds = (m: Memory, streamId: string) =>
  m.entries.filter((e) => e.streamId === streamId).map((e) => (e.body.kind === "lifecycle" ? e.body.op : e.body.kind === "assert" ? `assert/${e.body.status}` : e.body.kind));

test("a user edit lands as one ledger entry, is mirrored as a fact, and patches the deals row", async () => {
  const m = memory();
  const d = await newDeal(m);
  const out = await write(m, d, { kind: "user", userId: "u1" }, { nextStep: "Send the MSA" }, 1000);
  assert.deepEqual({ ...out.result, shard: 0 }, { status: "applied", streamId: d.streamId, version: 2, shard: 0, seq: 2 });
  assert.deepEqual(kinds(m, d.streamId), ["create", "assert/accepted"]);
  assert.equal(m.rows.get("deal1")?.nextStep, "Send the MSA", "the projection, not the caller, wrote the row");
  assert.equal(m.hotRows.get(d.streamId)?.row.values.nextStep, "Send the MSA");
  assert.deepEqual(m.facts.map((f) => [f.attribute, f.value, f.sourceRef, f.status]), [["nextStep", "Send the MSA", "user:u1:deal1:nextStep", "accepted"]]);
  assert.equal(m.fieldState.get(`${d.streamId}:nextStep`)?.value, "Send the MSA");

  const again = await write(m, d, { kind: "user", userId: "u1" }, { nextStep: "Send the MSA" }, 2000);
  assert.deepEqual(again.result, { status: "unchanged", streamId: d.streamId, version: 2 });
  assert.equal(m.facts[0].lastConfirmedAt, 2000, "a re-observed value is confirmed, not duplicated");
});

test("archiving a deal deletes its stream and stamps the row; a sync can't edit it until it is restored", async () => {
  const m = memory();
  const d = await newDeal(m);
  const archive = (op: "delete" | "restore", now: number) => writeDealLifecycle(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, op, userId: "u1", now });
  const stale = await writeDealLifecycle(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, op: "delete", userId: "u1", now: 900, expectedVersion: 99 });
  assert.equal(stale.status, "conflict", "a page that saw an older version doesn't archive over a newer change");
  assert.equal(m.rows.get("deal1")?.archivedAt, undefined);
  assert.equal((await archive("delete", 1000)).status, "applied");
  assert.equal(m.rows.get("deal1")?.archivedAt, 1000);
  assert.equal((await sync(m, d, { amount: 1 }, "2026-01-01T00:00:00Z", 1500)).result.status, "invalid", "an archived deal takes no edits");
  assert.equal(m.rows.get("deal1")?.amount, 500000);
  assert.equal((await archive("restore", 2000)).status, "applied");
  assert.equal(m.rows.get("deal1")?.archivedAt, undefined);
  assert.deepEqual(kinds(m, d.streamId).slice(-2), ["delete", "restore"]);
});

test("a provider re-sync with unchanged values is unchanged and appends nothing", async () => {
  const m = memory();
  const d = await newDeal(m);
  const first = await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  assert.equal(first.result.status, "applied");
  const count = m.entries.length;
  const again = await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 2000);
  assert.deepEqual(again.result, { status: "unchanged", streamId: d.streamId, version: 2 });
  assert.equal(m.entries.length, count);
  assert.deepEqual(Object.fromEntries(m.facts.map((f) => [f.attribute, f.value])), DEAL, "sync records exactly the supplied attributes");
});

test("a newer provider modstamp wins; an older snapshot arriving later changes nothing", async () => {
  const m = memory();
  const d = await newDeal(m);
  await sync(m, d, { stage: "Negotiation" }, "2026-09-02T00:00:00Z", 1000);
  assert.equal(m.rows.get("deal1")?.stage, "Negotiation");
  const stale = await sync(m, d, { stage: "Discovery" }, "2026-09-01T00:00:00Z", 2000);
  assert.equal(stale.result.status, "unchanged");
  assert.equal(m.rows.get("deal1")?.stage, "Negotiation");
  await sync(m, d, { stage: "Closed Won" }, "2026-09-03T00:00:00Z", 3000);
  assert.equal(m.rows.get("deal1")?.stage, "Closed Won");
});

test("a user override outlives an older provider snapshot, which is shadowed; a newer changed value replaces it", async () => {
  const m = memory();
  const d = await newDeal(m);
  await sync(m, d, { forecastCategory: "commit" }, "2026-09-01T00:00:00Z", Date.parse("2026-09-01T01:00:00Z"));
  await write(m, d, { kind: "user", userId: "u1" }, { forecastCategory: "best_case" }, Date.parse("2026-09-02T00:00:00Z"));
  // The writer patches the row with the provider's value first, as the sync mutations do.
  m.rows.get("deal1")!.forecastCategory = "pipeline";
  await sync(m, d, { forecastCategory: "pipeline" }, "2026-09-01T12:00:00Z", Date.parse("2026-09-03T00:00:00Z"));
  assert.equal(m.rows.get("deal1")?.forecastCategory, "best_case");
  assert.deepEqual(m.shadow.get("forecastCategory"), { providerValue: "pipeline", canonicalValue: "best_case" });
  // Re-sending the same value later only confirms it, as the facts write rule does; a changed value wins.
  await sync(m, d, { forecastCategory: "pipeline" }, "2026-09-04T00:00:00Z", Date.parse("2026-09-04T01:00:00Z"));
  assert.equal(m.rows.get("deal1")?.forecastCategory, "best_case");
  await sync(m, d, { forecastCategory: "omit" }, "2026-09-05T00:00:00Z", Date.parse("2026-09-05T01:00:00Z"));
  assert.equal(m.rows.get("deal1")?.forecastCategory, "omit");
});

test("a CRM's own stage names are registered as options; an unregistered value is left out, not stored", async () => {
  assert.deepEqual(withPicklistOption(STANDARD_OBJECTS.deal, undefined, "stage", "Closed Won")?.picklistOptions?.stage?.map((o) => o.value),
    ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost", "Closed Won"]);
  assert.equal(withPicklistOption(STANDARD_OBJECTS.deal, ext, "stage", "Discovery"), null);
  const m = memory();
  const d = await newDeal(m);
  const out = await sync(m, d, { stage: "Verbal", amount: 7 }, "2026-09-01T00:00:00Z", 1000);
  assert.deepEqual(out.rejected, [{ field: "stage", message: 'Stage: "Verbal" is not an option' }]);
  assert.deepEqual(m.facts.map((f) => f.attribute), ["amount"]);
  assert.equal(m.rows.get("deal1")?.amount, 7);
});

test("dragging a deal to a won stage lands one entry with the stage's forecast category, closed and won", async () => {
  const m = memory();
  const d = await newDeal(m);
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const stage = def.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], []);
  const values = withStageOutcome(pipelines, { stage: "Closed Won" }) as DealValues;
  const out = await write(m, d, { kind: "user", userId: "u1" }, values, Date.parse("2026-09-02T00:00:00Z"));
  assert.equal(out.result.status, "applied");
  const last = m.entries.at(-1)!;
  assert.deepEqual(last.body.kind === "assert" ? Object.fromEntries(last.body.assertions.map((a) => [a.fieldId, a.value])) : null,
    { stage: "Closed Won", forecastCategory: "closed_won", probability: 1, isClosed: true, isWon: true });
  assert.deepEqual([m.rows.get("deal1")?.stage, m.rows.get("deal1")?.isClosed, m.rows.get("deal1")?.isWon], ["Closed Won", true, true]);
});

test("a deal created in Canon lands with its pipeline stage's outcome, created by the user; another pipeline's stage is refused", async () => {
  const stage = def.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], [
    { id: "p1", name: "Sales", stages: [{ value: "prospecting", probability: 10, forecastCategory: "pipeline" }], createdAt: 1 },
    { id: "p2", name: "Renewals", stages: [{ value: "Discovery", probability: 35, forecastCategory: "best_case" }], createdAt: 2 },
  ]);
  const input = { name: " Globex expansion ", amount: 1250000, closeDate: "2026-11-30", pipelineId: "p2", stage: "Discovery" };
  assert.equal(planDealCreate(pipelines, { ...input, pipelineId: "p1" }).ok, false);
  const plan = planDealCreate(pipelines, input);
  assert.ok(plan.ok);
  assert.equal(plan.revenueType, "recurring");

  const m = memory();
  const d = await newDeal(m, "deal9", { ...plan.deal, revenueType: plan.revenueType });
  const out = await writeDeal(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, source: { kind: "user", userId: "u1" }, values: plan.deal, now: 1000, creates: true });
  assert.equal(out.result.status, "applied");
  assert.deepEqual(m.entries.filter((e) => e.streamId === d.streamId).map((e) => [e.body.kind === "lifecycle" ? e.body.op : e.body.kind, e.actor]),
    [["create", { kind: "user", id: "u1" }], ["assert", { kind: "user", id: "u1" }]]);
  const { values } = m.hotRows.get(d.streamId)!.row;
  assert.deepEqual(
    Object.fromEntries(["name", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "dealType"].map((k) => [k, values[k]])),
    { name: "Globex expansion", amount: 1250000, currency: "USD", closeDate: "2026-11-30", stage: "Discovery", forecastCategory: "best_case", probability: 0.35, isClosed: false, isWon: false, dealType: "new_business" },
  );
});

test("a deal created with a company and moved to another is listed under the company it is linked to now", async () => {
  const m = memory();
  const d = await newDeal(m, "deal7", { ...DEAL, closeDate: "2026-11-01" });
  const user = { kind: "user", userId: "u1" } as const;
  await writeDeal(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, source: user, values: { companyId: "acc_globex" }, now: 1000, creates: true });
  await write(m, d, user, { companyId: "acc_initech" }, 2000);
  const row = { _id: d.dealId, ...m.rows.get(d.dealId)! } as { _id: string; closeDate: string; companyId?: string };
  assert.equal(row.companyId, "acc_initech");
  assert.deepEqual(m.entries.filter((e) => e.body.kind === "assert").map((e) => e.body.kind === "assert" && e.body.assertions.map((a) => [a.fieldId, a.value])),
    [[["companyId", "acc_globex"]], [["companyId", "acc_initech"]]]);
  assert.deepEqual(m.facts, [], "the company link is the ledger's alone, not mirrored to facts");
  assert.deepEqual(companyDeals("acc_initech", [], [row]).map((x) => [x._id, x.link]), [["deal7", { kind: "stored", companyId: "acc_initech" }]]);
  assert.deepEqual(companyDeals("acc_globex", [], [row]), []);
});

test("re-importing the same deals CSV finds each deal by name and company and changes nothing", async () => {
  const stage = def.byApiName.get("stage")!;
  const pipelines = resolvePipelines("options" in stage ? stage.options : [], []);
  const csv = parseCsv("Deal name,Company,Amount,Close date,Stage,Next step\nAcme renewal,acme.com,5000,2026-12-01,discovery,Call Jane\n");
  const companies = matchCompanies(["acme.com"], [{ id: "acc_acme", name: "Acme", domain: "acme.com" }], false);
  const dryRun = (deals: Map<string, Array<{ dealId: string; companyId: string | null; crmAccount: boolean }>>) =>
    classifyDeals(readRows("deal", def, autoMap("deal", def, csv[0]), csv, pipelines), deals, companies, pipelines, true)[0];
  const source = { kind: "csv", ref: "csv:deal-1:2", actorId: "u1" } as const;

  const first = dryRun(new Map());
  assert.equal(first.kind, "create");
  const plan = planDealCreate(pipelines, dealCreateInput(first.kind === "create" ? first.values : {}));
  assert.ok(plan.ok && first.kind === "create");
  const m = memory();
  const d = await newDeal(m, "deal1", { ...plan.deal });
  await writeDeal(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, source, values: { ...first.values, ...plan.deal, companyId: "acc_acme" } as DealValues, now: 1000, creates: true });
  const written = m.entries.length;

  const second = dryRun(new Map([["Acme renewal", [{ dealId: "deal1", companyId: (m.rows.get("deal1")!.companyId as string) ?? null, crmAccount: false }]]]));
  assert.deepEqual(second.kind === "update" && second.match, { dealId: "deal1", companyId: "acc_acme", crmAccount: false });
  const again = second.kind === "update" ? withStageOutcome(pipelines, { ...second.values, companyId: "acc_acme" }) : {};
  const out = await write(m, d, source, again as DealValues, 2000);
  assert.equal(out.result.status, "unchanged");
  assert.equal(m.entries.length, written);
  assert.deepEqual([m.rows.get("deal1")!.amount, m.rows.get("deal1")!.nextStep, m.rows.get("deal1")!.companyId], [500000, "Call Jane", "acc_acme"]);
});

test("a CRM deal is listed under the company of its CRM account, unless a person linked it to another", () => {
  const deals = [
    { _id: "d1", closeDate: "2026-12-01", accountId: "crm1" },
    { _id: "d2", closeDate: "2026-10-01", accountId: "crm1", companyId: "acc_other" },
    { _id: "d3", closeDate: "2026-11-01", companyId: "acc_acme" },
    { _id: "d4", closeDate: "2026-09-01", accountId: "crm2" },
    { _id: "d3", closeDate: "2026-11-01", companyId: "acc_acme" },
  ];
  assert.deepEqual(companyDeals("acc_acme", ["crm1"], deals).map((x) => [x._id, x.link]), [
    ["d3", { kind: "stored", companyId: "acc_acme" }],
    ["d1", { kind: "crm", crmAccountId: "crm1" }],
  ]);
});

test("the projection never clears a required column, and does clear an optional one", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  for (const attribute of ["name", "amount"]) {
    await m.factStore.insertFact({
      orgId: ORG, entityType: "opportunity", entityId: d.streamId, attribute, value: null, sourceKind: "import", sourceRef: `import:deal:deal1:${attribute}`,
      actor: { kind: "integration", id: "backfill" }, confidence: 1, observedAt: 1000, lastConfirmedAt: 1000, status: "accepted",
    });
  }
  await ensureDealStream(m.stores, { orgId: ORG, def, streamId: d.streamId, now: 2000 });
  const patch = await projectDealRow(m.stores, { def, dealId: "deal1", streamId: d.streamId });
  assert.deepEqual(patch, { amount: undefined });
  assert.equal(m.rows.get("deal1")?.name, "Acme renewal");
  assert.equal("amount" in m.rows.get("deal1")!, false);
});

test("agent proposals stay proposals until the gate decides; decisions reach the ledger and the row", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: d.streamId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, patchPlanId: "plan1", observations: [{ attribute: "nextStep", value: "Book a pricing call", evidence: "call notes", confidence: 0.8 }],
  });
  const r2 = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: d.streamId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, patchPlanId: "plan1", observations: [{ attribute: "closeDate", value: "2027-01-15", evidence: "email" }],
  });
  for (const factId of [r.factIds.nextStep, r2.factIds.closeDate]) {
    const mirrored = await mirrorProposal(m.stores, { orgId: ORG, def, fact: (await m.factStore.getFact(factId))! });
    assert.equal("status" in mirrored && mirrored.status, "proposed");
  }
  assert.equal(m.proposals.size, 2);
  assert.equal(m.rows.get("deal1")?.nextStep, undefined, "a proposal does not reach the row");

  const out = await decideFacts(m.factStore, {
    orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000,
    decisions: [{ factId: r.factIds.nextStep, status: "accepted" }, { factId: r2.factIds.closeDate, status: "rejected" }],
  });
  const patch = await mirrorDecisions(m.stores, { orgId: ORG, def, dealId: "deal1", streamId: d.streamId, decided: out.decided, decider: { kind: "user", userId: "u9" }, at: 3000 });
  assert.deepEqual(patch, { nextStep: "Book a pricing call" });
  assert.equal(m.rows.get("deal1")?.updatedAt, 3000);
  assert.equal(m.rows.get("deal1")?.closeDate, "2026-12-01", "a rejected proposal leaves the CRM value");
  assert.equal(m.proposals.size, 0, "the queue empties as the gate decides");
  assert.deepEqual(kinds(m, d.streamId), ["create", "assert/accepted", "assert/proposed", "assert/proposed", "decide"]);
  assert.deepEqual(compareDeal(def, m.rows.get("deal1")!, m.hotRows.get(d.streamId)!.row, fieldStates(m, d.streamId)), { mismatches: [], unseen: [] });
});

test("a decision finds its mirrored proposal even when the mirror trimmed the value", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: d.streamId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "nextStep", value: "  Book a pricing call  ", evidence: "call notes" }],
  });
  await mirrorProposal(m.stores, { orgId: ORG, def, fact: (await m.factStore.getFact(r.factIds.nextStep))! });
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000, decisions: [{ factId: r.factIds.nextStep, status: "rejected" }] });
  await mirrorDecisions(m.stores, { orgId: ORG, def, dealId: "deal1", streamId: d.streamId, decided: out.decided, decider: { kind: "user", userId: "u9" }, at: 3000 });
  assert.equal(m.proposals.size, 0, "the rejected proposal left the queue");
  assert.deepEqual(m.hotRows.get(d.streamId)?.state.fields.nextStep?.pending, []);
});

test("accepting a proposal the gate normalized leaves the row, canonFieldState and the receipt equal", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const normalized = coerce(def, { nextStep: "  Book a pricing call  " }, { mode: "update" });
  assert.ok(normalized.ok);
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: d.streamId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt: 2000, observations: [{ attribute: "nextStep", value: normalized.values[0].value as string, evidence: "call notes" }],
  });
  await mirrorProposal(m.stores, { orgId: ORG, def, fact: (await m.factStore.getFact(r.factIds.nextStep))! });
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at: 3000, decisions: [{ factId: r.factIds.nextStep, status: "accepted" }] });
  await mirrorDecisions(m.stores, { orgId: ORG, def, dealId: "deal1", streamId: d.streamId, decided: out.decided, decider: { kind: "user", userId: "u9" }, at: 3000 });
  assert.equal(m.rows.get("deal1")?.nextStep, "Book a pricing call");
  assert.equal(m.fieldState.get(`${d.streamId}:nextStep`)?.value, "Book a pricing call");
  assert.deepEqual(compareDeal(def, m.rows.get("deal1")!, m.hotRows.get(d.streamId)!.row, fieldStates(m, d.streamId)), { mismatches: [], unseen: [] });
});

async function propose(m: Memory, d: { streamId: string }, value: string, evidence: string, observedAt: number) {
  const r = await ingestObservations(m.factStore, {
    orgId: ORG, entityId: d.streamId, sourceKind: "agent_run", sourceRefBase: "agent_run:a1:deal1", actor: { kind: "agent", id: "a1" },
    observedAt, observations: [{ attribute: "nextStep", value, evidence }],
  });
  const fact = (await m.factStore.getFact(r.factIds.nextStep))!;
  await mirrorProposal(m.stores, { orgId: ORG, def, fact });
  return fact._id;
}

const decide = async (m: Memory, d: { dealId: string; streamId: string }, factId: string, status: "accepted" | "rejected", at: number) => {
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: { kind: "user", userId: "u9" }, at, decisions: [{ factId, status }] });
  await mirrorDecisions(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, decided: out.decided, decider: { kind: "user", userId: "u9" }, at });
};

test("an auto-accept rule's decision is recorded as the rule's, on the fact and in the ledger", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const factId = await propose(m, d, "Book a pricing call", "call notes", 2000);
  const rule = { kind: "rule", rule: "auto_accept+jev" } as const;
  const out = await decideFacts(m.factStore, { orgId: ORG, decider: rule, at: 3000, decisions: [{ factId, status: "accepted" }] });
  await mirrorDecisions(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, decided: out.decided, decider: rule, at: 3000 });
  const last = m.entries.filter((e) => e.streamId === d.streamId).at(-1)!;
  assert.deepEqual([last.body.kind, last.source, last.actor], ["decide", { kind: "user", ref: "rule:auto_accept+jev" }, { kind: "rule", id: "auto_accept+jev" }]);
  const fact = await m.factStore.getFact(factId);
  assert.deepEqual([fact?.decider, fact?.decidedBy], [rule, "rule:auto_accept+jev"]);
});

test("two same-value proposals with different evidence are decided by identity, not by value", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  await propose(m, d, "Book a pricing call", "email from the buyer", 2000);
  const second = await propose(m, d, "Book a pricing call", "call transcript", 2000);
  await decide(m, d, second, "accepted", 3000);
  const field = m.hotRows.get(d.streamId)!.state.fields.nextStep!;
  assert.deepEqual(field.pending.map((p) => p.evidence), ["email from the buyer"], "the other proposal is still pending");
  assert.equal(field.candidates.find((c) => c.sourceKind === "agent_run")?.evidence, "call transcript");
  assert.equal(m.proposals.size, 1);
});

test("approving tied proposals out of order keeps the later-written one, as facts resolve it", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const older = await propose(m, d, "old", "first look", 2000);
  const newer = await propose(m, d, "new", "second look", 2000);
  await decide(m, d, newer, "accepted", 3000);
  await decide(m, d, older, "accepted", 4000);
  assert.equal(m.fieldState.get(`${d.streamId}:nextStep`)?.value, "new");
  assert.equal(m.rows.get("deal1")?.nextStep, "new");
  assert.deepEqual(compareDeal(def, m.rows.get("deal1")!, m.hotRows.get(d.streamId)!.row, fieldStates(m, d.streamId)), { mismatches: [], unseen: [] });
});

test("proposals evicted from the pending cap keep their ledger identity, so review order still cannot change the winner", async () => {
  const m = memory();
  const d = await newDeal(m, "deal1", { ...DEAL });
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const older = await propose(m, d, "old", "first look", 2000);
  const newer = await propose(m, d, "new", "second look", 2000);
  for (let i = 0; i < 20; i++) await propose(m, d, `filler ${i}`, `note ${i}`, 2100 + i);
  const pending = m.hotRows.get(d.streamId)!.state.fields.nextStep!.pending.map((p) => p.value);
  assert.ok(!pending.includes("old") && !pending.includes("new"), "both were evicted from the pending list");
  await decide(m, d, newer, "accepted", 3000);
  await decide(m, d, older, "accepted", 4000);
  assert.equal(m.fieldState.get(`${d.streamId}:nextStep`)?.value, "new");
  assert.equal(m.hotRows.get(d.streamId)!.row.values.nextStep, "new");
});

test("the ledger refuses an agent value for a field the agent does not own", async () => {
  const m = memory();
  const d = await newDeal(m);
  await sync(m, d, DEAL, "2026-09-01T00:00:00Z", 1000);
  const fact: StoredFact = {
    _id: "forged", orgId: ORG, entityType: "opportunity", entityId: d.streamId, attribute: "amount", value: 1, sourceKind: "agent_run",
    sourceRef: "agent_run:a1:deal1:amount", actor: { kind: "agent", id: "a1" }, confidence: 1, observedAt: 2000, lastConfirmedAt: 2000, status: "proposed",
  };
  assert.deepEqual(await mirrorProposal(m.stores, { orgId: ORG, def, fact }), { status: "invalid", errors: [{ field: "amount", message: "agent_run may not write amount" }] });
  assert.equal(m.rows.get("deal1")?.amount, 500000);
});

function fieldStates(m: Memory, streamId: string) {
  return new Map([...m.fieldState.values()].filter((s) => s.entityId === streamId).map((s) => [s.attribute, s]));
}

test("past the transaction's conversion budget a deal without a stream is written to facts only, and converts later", async () => {
  const m = memory();
  const d = await newDeal(m);
  m.stores.conversionBudget = { remaining: 0 };
  const deferred = await sync(m, d, { ...DEAL, amount: 650000 }, "2026-09-01T00:00:00Z", 1000);
  assert.deepEqual(deferred.result, { status: "deferred", streamId: d.streamId });
  assert.equal(m.entries.length, 0, "no stream was started");
  assert.equal(m.rows.get("deal1")?.amount, 650000);
  assert.ok(m.facts.some((f) => f.attribute === "amount" && f.value === 650000 && f.sourceRef === "salesforce:006X:amount"));

  m.stores.conversionBudget = { remaining: 12_000 };
  const later = await write(m, d, { kind: "user", userId: "u1" }, { nextStep: "Send the MSA" }, 2000);
  assert.equal(later.result.status, "applied");
  assert.deepEqual(kinds(m, d.streamId), ["assert/accepted", "assert/accepted"], "the deferred sync was converted first, then the edit appended");
  assert.equal(m.hotRows.get(d.streamId)?.row.values.amount, 650000);
  assert.equal(m.stores.conversionBudget.remaining, 12_000 - m.facts.filter((f) => f.attribute !== "nextStep").length);
});

test("a company link written while a deal was deferred reaches its ledger when the stream converts", async () => {
  const m = memory();
  const d = await newDeal(m);
  m.stores.conversionBudget = { remaining: 0 };
  const deferred = await write(m, d, { kind: "user", userId: "u1" }, { companyId: "acc_atlas" }, 1000);
  assert.equal(deferred.result.status, "deferred");

  m.stores.conversionBudget = { remaining: 12_000 };
  await write(m, d, { kind: "user", userId: "u1" }, { nextStep: "Send the MSA" }, 2000);
  assert.equal(m.hotRows.get(d.streamId)?.row.values.companyId, "acc_atlas");
  assert.equal(m.rows.get("deal1")?.companyId, "acc_atlas");
});

test("converting a deal's facts gives literal entries: one per write, proposals decided by copy", () => {
  const base = { actor: { kind: "integration" as const, id: "salesforce" }, confidence: 1 };
  const entries = factsToEntries("s1", [
    { ...base, _id: "f1", attribute: "amount", value: 10, sourceKind: "salesforce", sourceRef: "salesforce:006X:amount", observedAt: 100, validFrom: 90, status: "accepted" },
    { ...base, _id: "f2", attribute: "stage", value: "Discovery", sourceKind: "salesforce", sourceRef: "salesforce:006X:stage", observedAt: 100, validFrom: 90, status: "accepted" },
    { _id: "f3", attribute: "nextStep", value: "Call", sourceKind: "call", sourceRef: "call:c1:deal1:nextStep", actor: { kind: "agent", id: "c1" }, confidence: 0.7, evidence: "said so", observedAt: 200, status: "accepted", decidedBy: "rule:auto_accept+jev", decidedAt: 300 },
  ]);
  assert.deepEqual(entries, [
    {
      streamId: "s1", version: 1, observedAt: 100, source: { kind: "salesforce", ref: "salesforce:006X" }, actor: base.actor,
      body: { kind: "assert", status: "accepted", assertions: [{ fieldId: "amount", value: 10, confidence: 1, validFrom: 90 }, { fieldId: "stage", value: "Discovery", confidence: 1, validFrom: 90 }] },
    },
    {
      streamId: "s1", version: 2, observedAt: 200, source: { kind: "call", ref: "call:c1:deal1" }, actor: { kind: "agent", id: "c1" },
      body: { kind: "assert", status: "proposed", assertions: [{ fieldId: "nextStep", value: "Call", confidence: 0.7, evidence: "said so" }] },
    },
    {
      streamId: "s1", version: 3, observedAt: 300, source: { kind: "user", ref: "rule:auto_accept+jev" }, actor: { kind: "rule", id: "auto_accept+jev" },
      body: {
        kind: "decide",
        decisions: [{ status: "accepted", fact: { factId: "s1@2#0", fieldId: "nextStep", value: "Call", sourceKind: "call", sourceRef: "call:c1:deal1", observedAt: 200, confidence: 0.7, evidence: "said so" } }],
      },
    },
  ]);
  const projected = project(def, foldAll(entries)!);
  assert.deepEqual([projected.values.amount, projected.values.stage, projected.values.nextStep], [10, "Discovery", "Call"]);
});

/** A small deterministic PRNG, so the property run is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("conversion keeps interleaved equal-time writes apart, so the last one still wins", () => {
  const user = { actor: { kind: "user" as const, id: "u1" }, confidence: 1, sourceKind: "user" as const, sourceRef: "user:u1:deal1:nextStep", observedAt: 100, status: "accepted" as const, attribute: "nextStep" };
  const facts = [
    { ...user, _id: "a", value: "A", _creationTime: 1 },
    { _id: "b", attribute: "nextStep", value: "B", sourceKind: "salesforce" as const, sourceRef: "salesforce:006X:nextStep", actor: { kind: "integration" as const, id: "salesforce" }, confidence: 1, observedAt: 100, status: "accepted" as const, _creationTime: 2 },
    { ...user, _id: "c", value: "C", _creationTime: 3 },
  ];
  const state = foldAll(factsToEntries("s1", facts));
  assert.ok(state);
  assert.equal(project(def, state).values.nextStep, resolveAttribute([...facts].reverse()).value);
  assert.equal(project(def, state).values.nextStep, "C");
});

test("backfill equivalence: for 60 synthetic deals (fixed seed), the converted projection equals canonFieldState", async () => {
  const m = memory();
  const rand = rng(20261006);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const AUTO: SourceKind[] = ["salesforce", "hubspot", "import", "user"];
  const AGENTS: SourceKind[] = ["agent_run", "call", "enrichment"];
  const valueFor = (attribute: string): string | number | boolean | null => {
    if (rand() < 0.08) return attribute === "name" ? "Fallback" : null;
    switch (attribute) {
      case "amount": case "probability": return Math.floor(rand() * 4) * 100;
      case "isClosed": case "isWon": return rand() < 0.5;
      default: return `${attribute}-${Math.floor(rand() * 3)}`;
    }
  };
  let t = 1_000;
  let contested = 0;
  for (let n = 0; n < 60; n++) {
    const d = await newDeal(m, `deal${n}`);
    const pending: string[] = [];
    for (let op = 0; op < 12; op++) {
      t += 1 + Math.floor(rand() * 3);
      const attributes = DEAL_ATTRIBUTES.filter(() => rand() < 0.35);
      if (!attributes.length) continue;
      if (rand() < 0.65) {
        const kind = pick(AUTO);
        await ingestObservations(m.factStore, {
          orgId: ORG, entityId: d.streamId, sourceKind: kind, sourceRefBase: `${kind}:rec${Math.floor(rand() * 2)}`, actor: { kind: "integration", id: kind },
          observedAt: t, observations: attributes.map((attribute) => ({ attribute, value: valueFor(attribute), ...(rand() < 0.5 ? { validFrom: t - Math.floor(rand() * 40) } : {}) })),
        });
      } else if (rand() < 0.6) {
        const kind = pick(AGENTS);
        const r = await ingestObservations(m.factStore, {
          orgId: ORG, entityId: d.streamId, sourceKind: kind, sourceRefBase: `${kind}:a1:deal${n}`, actor: { kind: "agent", id: "a1" }, observedAt: t,
          ownership: DEAL_ATTRIBUTES.map((attribute) => ({ sourceKind: kind, attribute, allowed: true })),
          observations: attributes.map((attribute) => ({ attribute, value: valueFor(attribute), evidence: `e${Math.floor(rand() * 2)}`, confidence: rand() })),
        });
        pending.push(...Object.values(r.factIds));
      } else if (pending.length) {
        const decisions = pending.splice(0, 1 + Math.floor(rand() * pending.length)).map((factId) => ({ factId, status: rand() < 0.6 ? ("accepted" as const) : ("rejected" as const) }));
        await decideFacts(m.factStore, { orgId: ORG, decisions, decider: pick([{ kind: "user", userId: "u1" }, { kind: "rule", rule: "auto_accept+jev" }] as const), at: t });
      }
    }
    const init = await ensureDealStream(m.stores, { orgId: ORG, def, streamId: d.streamId, now: t });
    const projected = m.hotRows.get(d.streamId)!.row;
    const states = fieldStates(m, d.streamId);
    assert.deepEqual(compareDeal(def, m.rows.get(d.dealId)!, projected, states).mismatches.filter((x) => x.against === "fieldState"), [], `deal${n} (${init.status})`);
    contested += [...states.values()].filter((s) => s.state === "contested").length;
    const stillProposed = m.facts.filter((f) => f.entityId === d.streamId && f.status === "proposed").length;
    assert.equal([...m.proposals.values()].filter((p) => p.streamId === d.streamId).length, stillProposed, `deal${n} queue`);
  }
  assert.ok(contested > 20, `the run exercised contested fields (${contested})`);
  const before = m.entries.length;
  const again = await ensureDealStream(m.stores, { orgId: ORG, def, streamId: m.entities[0]._id, now: t });
  assert.deepEqual([again.status, m.entries.length], ["existing", before], "a converted stream is left alone");
});

test("a deals row is compared field by field; fields the ledger never saw are reported, not failed", () => {
  const m = { values: Object.fromEntries(DEAL_ATTRIBUTES.map((a) => [a, null])), meta: {}, createdAt: 0, updatedAt: 0, deletedAt: null, mergedInto: null } as unknown as ProjectedRow;
  const projected: ProjectedRow = { ...m, values: { ...m.values, amount: 5 }, meta: { amount: { state: "resolved", factId: "s@1#0", sourceKind: "user" } } };
  const out = compareDeal(def, { ...DEAL, amount: 6 }, projected, new Map([["amount", { value: 5, state: "resolved" as const }]]));
  assert.deepEqual(out.mismatches, [{ attribute: "amount", against: "row", ledger: 5, ledgerState: "resolved", other: 6 }]);
  assert.deepEqual(out.unseen, ["name", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "crmOwnerId", "dealType"]);
  assert.deepEqual(dealRowPatch(def, { ...DEAL, amount: 6 }, projected), { amount: 5 });
});

test("a deal's owner is set through its ledger and lands on the row's primaryRepId, with history", async () => {
  const m = memory();
  const d = await newDeal(m);
  const out = await write(m, d, { kind: "user", userId: "u1" }, { ownerId: "user_b" }, 1000);
  assert.equal(out.result.status, "applied");
  assert.equal(m.rows.get("deal1")?.primaryRepId, "user_b");
  assert.equal(m.rows.get("deal1")?.ownerId, undefined, "the owner is not a second column");
  assert.equal(m.hotRows.get(d.streamId)?.row.values.ownerId, "user_b");
  assert.equal(m.entries.filter((e) => e.streamId === d.streamId && e.actor.kind === "user" && e.actor.id === "u1").length, 1);
  m.rows.get("deal1")!.primaryRepId = "user_c"; // an ownership write-back sets the row directly
  await write(m, d, { kind: "user", userId: "u1" }, { nextStep: "Call" }, 1500);
  assert.equal(m.rows.get("deal1")?.primaryRepId, "user_c", "a later write does not project the older ledger owner over it");
  const cleared = await write(m, d, { kind: "user", userId: "u1" }, { ownerId: null }, 2000);
  assert.equal(cleared.result.status, "applied");
  assert.equal(m.rows.get("deal1")?.primaryRepId, undefined);
});

test("a CRM's own spelling of a stage is the stage Canon has, so no second column appears", () => {
  const stage = resolveObjectDef(STANDARD_OBJECTS.deal, undefined).byApiName.get("stage");
  const list = stage && "options" in stage ? stage.options : [];
  assert.equal(matchPicklistOption(list, "Closed Won"), "closed_won");
  assert.equal(matchPicklistOption(list, "closedwon"), "closed_won");
  assert.equal(matchPicklistOption(list, "Proposal"), "proposal");
  assert.equal(matchPicklistOption(list, "Discovery"), null);
});

test("a CRM sync's deferred deal mirror writes the same facts, field states and row as the inline one, once its queue runs", async () => {
  const inline = memory();
  const deferred = memory();
  const queue: MirrorJob[] = [];
  deferred.stores.queueMirror = async (job) => {
    queue.push(structuredClone(job));
  };
  const run = async (m: Memory, defer: boolean) => {
    const d = await newDeal(m);
    const hubspot = (modstamp: string): DealSource => ({ kind: "hubspot", crmId: "77", rawData: { properties: { hs_lastmodifieddate: modstamp } } });
    const sync = (values: DealValues, modstamp: string, now: number) =>
      writeDeal(m.stores, { orgId: ORG, def, dealId: d.dealId, streamId: d.streamId, source: hubspot(modstamp), values, now, ...(defer ? { deferMirror: true as const } : {}) });
    await sync({ ...DEAL } as DealValues, "2026-09-01T00:00:00Z", 1000);
    if (defer) assert.equal(m.facts.filter((f) => f.sourceKind === "hubspot").length, 0, "nothing in facts before the queue runs");
    await sync({ ...DEAL } as DealValues, "2026-09-01T00:00:00Z", 2000);
    await sync({ ...DEAL, stage: "Negotiation", amount: 650000 } as DealValues, "2026-10-01T00:00:00Z", 3000);
    return d;
  };
  const a = await run(inline, false);
  const b = await run(deferred, true);
  assert.ok(queue.length >= 2);
  for (const job of queue) await mirrorAppended(deferred.stores, job);

  const facts = (m: Memory) => m.facts.map(({ _id, ...f }) => ({ ...f, entityId: "stream" })).sort((x, y) => `${x.sourceRef}${x.observedAt}`.localeCompare(`${y.sourceRef}${y.observedAt}`));
  assert.deepEqual(facts(deferred), facts(inline));
  const states = (m: Memory, streamId: string) => [...fieldStates(m, streamId).values()].map(({ entityId: _e, factId: _f, contestedBy: _c, ...s }) => s).sort((x, y) => x.attribute.localeCompare(y.attribute));
  assert.deepEqual(states(deferred, b.streamId), states(inline, a.streamId));
  assert.deepEqual(deferred.rows.get(b.dealId), inline.rows.get(a.dealId));
});
