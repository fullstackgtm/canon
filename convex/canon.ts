/**
 * CanonCRM ledger in Convex for deals, accounts and contacts
 * (docs/canoncrm-spec.md P0 and P2, docs/cp0-object-layer.md migration steps
 * 4 and 7).
 *
 * - saveDeal: called in the same mutation that writes a deal (CRM sync, user
 *   edit, owner write-back, create). Appends to the deal's object-layer
 *   stream, mirrors the appended facts into `facts`, patches the deals row
 *   from the fold's projection and (for provider syncs) records shadow
 *   outbound rows. lib/canon/dealLedger.ts holds the logic.
 * - saveCrmAccount, saveCrmContact, saveRecordEdit: the same for accounts and
 *   contacts once they are worked (lib/canon/partyLedger.ts). Their CRM
 *   mirror rows stay the provider's copy and are not patched.
 * - mirrorGateProposal, mirrorDecidedFacts: the agent write gate's proposals
 *   and decisions, mirrored into the record's stream.
 * - backfillDealLedger, backfillAccountContactLedger: convert existing facts
 *   and CRM rows into streams; checkDealLedger and checkAccountContactLedger
 *   prove the projections equal canonFieldState and the CRM rows.
 * - backfillDeals: records every existing deal's values as an `import`.
 * - dealAsOf: replays a deal's facts through the policy at a point in time.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { accessFor, dealVisible } from "./permissions";
import { hiddenFields } from "./lib/access";
import { DEAL_ATTRIBUTES, ensureEntity, type DealAttribute, type ExternalId, type LedgerStore, type NewFact, type ProjectionTable, type StoredFact } from "./lib/canon/ledger";
import { CUSTOM_ATTRIBUTE, type EntityType } from "./lib/canon/attributes";
import type { Decider } from "./lib/canon/decider";
import { ID, accountExternalIds, contactExternalIds } from "./lib/canon/identity";
import {
  backfillPage, checkPartyEdit, compareParty, crmAccountValues, crmContactValues, ensurePartyStream, mirrorPartyDecisions, mirrorPartyProposal, PARTY_ATTRIBUTES_MAX, PARTY_CONVERSION_FACTS_MAX,
  recordEditValues, writeParty, writeRecordEdit, writeRecordLifecycle,
  type BackfillOutcome, type PartyLookup, type PartyMismatch, type PartyObject, type PartySeed, type PartySource, type PartyStores, type PartyValues, type PartyWriteResult, type RecordPatch,
} from "./lib/canon/partyLedger";
import { compareDeal, ensureDealStream, isHistoricalSource, mirrorDecisions, mirrorProposal, writeDeal, writeDealLifecycle, type DealMismatch, type DealSource, type DealStores, type DealValues, type DealWriteResult } from "./lib/canon/dealLedger";
import type { OwnershipOverride } from "./lib/canon/gate";
import { resolveAttribute, type FactValue, type Resolution } from "./lib/canon/policy";
import { project } from "./lib/objects/fold";
import { coerce, customFieldType, resolveObjectDef, STANDARD_OBJECTS, withCustomField, matchPicklistOption, withPicklistOption, type CoerceError, type OrgObjectExtension, type ResolvedObjectDef } from "./lib/objects/registry";
import { partyFieldValue, fromStored, toStored as storedShape } from "./lib/objects/validators";
import { afterDealWrite, projectedStage } from "./lib/agents/crmEvents";
import { asState, convexObjectStore, recordLabel } from "./objects";

/** Facts read per (entity, attribute) when resolving; the write rule keeps this small. */
const FACTS_PER_ATTRIBUTE = 200;

function toStored(f: Doc<"facts">): StoredFact {
  return { ...f, _id: f._id, orgId: f.orgId, entityId: f.entityId };
}

/**
 * Facts one CRM sync mutation may read before it hands its remaining accounts
 * or contacts back (syncPartyBatch). Appending to a long-lived record's stream
 * re-resolves each appended field from up to 200 facts, so a batch of 100 such
 * records could pass Convex's 32,000 reads. The check runs before each record,
 * and one record reads at most a conversion (PARTY_CONVERSION_FACTS_MAX) plus
 * its appended fields' facts, which leaves room for the batch's other reads.
 */
const PARTY_SYNC_FACT_READ_BUDGET = 12_000;
const factReads = new WeakMap<MutationCtx, { count: number }>();

function factReadsFor(ctx: MutationCtx) {
  let reads = factReads.get(ctx);
  if (!reads) factReads.set(ctx, (reads = { count: 0 }));
  return reads;
}

/** Whether the transaction `ctx` runs in may still sync another account or contact (see PARTY_SYNC_FACT_READ_BUDGET). */
export const partySyncHasBudget = (ctx: MutationCtx) => factReadsFor(ctx).count < PARTY_SYNC_FACT_READ_BUDGET;

/** How many merges deep an identity is followed to its survivor. */
const MERGE_HOPS_MAX = 8;

/** The record an entity was merged into, following merges in turn; the entity itself when it was not merged. */
export async function survivorOf(ctx: { db: QueryCtx["db"] }, entityId: Id<"canonEntities">): Promise<Id<"canonEntities">> {
  let current = entityId;
  for (let hop = 0; hop < MERGE_HOPS_MAX; hop++) {
    const next = (await ctx.db.get(current))?.mergedInto;
    if (!next) return current;
    current = next;
  }
  return current;
}

export function convexLedgerStore(ctx: MutationCtx): LedgerStore {
  const orgId = (id: string) => id as Id<"organizations">;
  const reads = factReadsFor(ctx);
  return {
    // A merged record's identities name its survivor (CP15a), so an import or sync never recreates it.
    async findEntityByExternalId(org, provider, externalId) {
      const row = await ctx.db.query("canonExternalIds")
        .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId(org)).eq("provider", provider).eq("externalId", externalId))
        .first();
      return row ? survivorOf(ctx, row.entityId) : null;
    },
    async findEntityByProjection(org, projectionId) {
      const row = await ctx.db.query("canonEntities")
        .withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId(org)).eq("projectionId", projectionId))
        .first();
      return row ? survivorOf(ctx, row._id) : null;
    },
    async createEntity(e) {
      return ctx.db.insert("canonEntities", { ...e, orgId: orgId(e.orgId), createdAt: Date.now() });
    },
    async addExternalId(e) {
      await ctx.db.insert("canonExternalIds", { ...e, orgId: orgId(e.orgId), entityId: e.entityId as Id<"canonEntities"> });
    },
    async hasStream(entityId) {
      return hasEntries(ctx, entityId as Id<"canonEntities">);
    },
    async latestBySourceRef(org, sourceRef) {
      const row = await ctx.db.query("facts")
        .withIndex("by_orgId_sourceRef_observedAt", (q) => q.eq("orgId", orgId(org)).eq("sourceRef", sourceRef))
        .order("desc")
        .first();
      reads.count++;
      return row ? toStored(row) : null;
    },
    async insertFact(f: NewFact) {
      return ctx.db.insert("facts", {
        ...f, value: storedShape(f.value), orgId: orgId(f.orgId), entityId: f.entityId as Id<"canonEntities">,
        patchPlanId: f.patchPlanId as Id<"patchPlans"> | undefined,
      });
    },
    async confirmFact(factId, at) {
      await ctx.db.patch(factId as Id<"facts">, { lastConfirmedAt: at });
    },
    async getFact(factId) {
      const row = await ctx.db.get(factId as Id<"facts">);
      return row ? toStored(row) : null;
    },
    async decideFact(factId, d) {
      await ctx.db.patch(factId as Id<"facts">, d);
    },
    async setLedgerFactId(factId, ledgerFactId) {
      await ctx.db.patch(factId as Id<"facts">, { ledgerFactId });
    },
    async factsFor(entityId, attribute) {
      const rows = await ctx.db.query("facts")
        .withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", entityId as Id<"canonEntities">).eq("attribute", attribute))
        .order("desc")
        .take(FACTS_PER_ATTRIBUTE);
      reads.count += rows.length;
      return rows.map(toStored);
    },
    async upsertFieldState(row) {
      const entityId = row.entityId as Id<"canonEntities">;
      const existing = await ctx.db.query("canonFieldState")
        .withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId).eq("attribute", row.attribute))
        .first();
      const entity = await ctx.db.get(entityId);
      if (!entity) return;
      const doc = {
        orgId: entity.orgId, entityId, attribute: row.attribute, value: storedShape(row.value),
        factId: row.factId as Id<"facts"> | null, sourceKind: row.sourceKind, state: row.state,
        contestedBy: row.contestedBy as Id<"facts">[] | undefined, updatedAt: row.updatedAt,
      };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("canonFieldState", doc);
    },
    async recordShadowOutbound(row) {
      const entityId = row.entityId as Id<"canonEntities">;
      const existing = await ctx.db.query("canonOutboundShadow")
        .withIndex("by_entityId_provider_attribute", (q) => q.eq("entityId", entityId).eq("provider", row.provider).eq("attribute", row.attribute))
        .first();
      const doc = {
        orgId: orgId(row.orgId), entityId, provider: row.provider, attribute: row.attribute,
        providerValue: storedShape(row.providerValue), canonicalValue: storedShape(row.canonicalValue),
        factId: row.factId as Id<"facts"> | null, updatedAt: row.at,
      };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("canonOutboundShadow", doc);
    },
  };
}

export type { DealSource };

/**
 * Facts one transaction may convert into records' streams, shared by all of
 * its deal, account and contact writes (keyed by the mutation's ctx). A
 * converted fact costs one read and at most three writes (its entry, and for a
 * pending proposal its ledgerFactId patch and its proposal-queue row; a decided
 * one costs its proposal and its decision). A record whose history does not
 * fit what is left waits, unless it is the transaction's first, so a
 * transaction converts at most 3,000 facts or one record's history: a deal
 * holds at most 12 x 200 facts and an account or contact is converted only
 * with at most PARTY_CONVERSION_FACTS_MAX (4,000) facts, about 12,000 writes,
 * inside Convex's 16,000 written and 32,000 read. Past the budget, records are
 * written to `facts` only and converted later; a larger account or contact
 * history stays in `facts`.
 */
const CONVERSION_FACT_BUDGET = 3_000;
const conversionBudgets = new WeakMap<MutationCtx, { remaining: number; limit: number }>();

/** The conversion budget of the transaction `ctx` runs in, shared by its deal, account and contact writes. */
function conversionBudgetFor(ctx: MutationCtx) {
  let budget = conversionBudgets.get(ctx);
  if (!budget) conversionBudgets.set(ctx, (budget = { remaining: CONVERSION_FACT_BUDGET, limit: CONVERSION_FACT_BUDGET }));
  return budget;
}

function dealStores(ctx: MutationCtx): DealStores {
  return {
    facts: convexLedgerStore(ctx),
    objects: convexObjectStore(ctx),
    conversionBudget: conversionBudgetFor(ctx),
    async getRow(dealId) {
      return ctx.db.get(dealId as Id<"deals">);
    },
    async patchRow(dealId, patch) {
      await ctx.db.patch(dealId as Id<"deals">, patch as Partial<Doc<"deals">>);
    },
  };
}

export async function readDealDef(ctx: QueryCtx, orgId: Id<"organizations">) {
  const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId).eq("apiName", "deal")).unique();
  return { row, ext: row ? fromStored<OrgObjectExtension>(row) : undefined };
}

/**
 * The org's deal definition. A stage a CRM or a person writes is registered
 * as one of the org's stage options first: the CRM is the system of record
 * for its pipeline's stage names, so its values are never rejected.
 */
async function dealDef(ctx: MutationCtx, orgId: Id<"organizations">, stage?: unknown): Promise<ResolvedObjectDef> {
  const { row, ext } = await readDealDef(ctx, orgId);
  const next = typeof stage === "string" && stage.trim() ? withPicklistOption(STANDARD_OBJECTS.deal, ext, "stage", stage) : null;
  if (next) {
    const picklistOptions = storedShape(next.picklistOptions ?? {});
    if (row) await ctx.db.patch(row._id, { picklistOptions, updatedAt: Date.now() });
    else await ctx.db.insert("objectDefs", { orgId, apiName: "deal", registryVersion: next.registryVersion, customFields: [], picklistOptions, updatedAt: Date.now() });
  }
  return resolveObjectDef(STANDARD_OBJECTS.deal, next ?? ext);
}

/**
 * A proposed deal value as the ledger will store it: coerced by the org's deal
 * definition (text trimmed, dates normalized). The gate stores this form in
 * `facts` too, so both ledgers hold the same value. Agents cannot add stages.
 */
async function normalizeDealProposal(ctx: MutationCtx, orgId: Id<"organizations">, attribute: string, value: FactValue): Promise<{ ok: true; value: FactValue } | { ok: false; message: string }> {
  const { ext } = await readDealDef(ctx, orgId);
  const coerced = coerce(resolveObjectDef(STANDARD_OBJECTS.deal, ext), { [attribute]: value }, { mode: "update" });
  if (!coerced.ok) return { ok: false, message: coerced.errors.map((e) => e.message).join("; ") };
  return { ok: true, value: (coerced.values[0]?.value ?? null) as FactValue };
}

async function dealEntity(ctx: MutationCtx, deal: Doc<"deals">, source?: DealSource): Promise<string> {
  const isProvider = source?.kind === "salesforce" || source?.kind === "hubspot";
  return ensureEntity(convexLedgerStore(ctx), {
    orgId: deal.orgId, projectionId: deal._id,
    ...(isProvider ? { provider: source.kind, externalId: source.crmId } : deal.crmId && deal.crmProvider ? { provider: deal.crmProvider, externalId: deal.crmId } : {}),
  });
}

function stageOptions(def: ResolvedObjectDef) {
  const stage = def.byApiName.get("stage");
  return stage && "options" in stage ? stage.options : [];
}

/** Write explicit values of a deal through its ledger stream (see lib/canon/dealLedger.ts writeDeal). */
export async function saveDealValues(
  ctx: MutationCtx,
  deal: Doc<"deals">,
  source: DealSource,
  values: DealValues,
  opts: { now?: number; evidence?: string; creates?: true } = {},
): Promise<DealWriteResult & { entityId: string }> {
  const entityId = await dealEntity(ctx, deal, source);
  // A stage a CRM names in its own words ("Closed Won") is the stage Canon already has ("closed_won"), not a second column.
  if (typeof values.stage === "string") {
    const known = matchPicklistOption(stageOptions(resolveObjectDef(STANDARD_OBJECTS.deal, (await readDealDef(ctx, deal.orgId)).ext)), values.stage);
    if (known) values = { ...values, stage: known };
  }
  const before = "stage" in values ? await projectedStage(ctx, deal.orgId, entityId) : null;
  const out = await writeDeal(dealStores(ctx), {
    orgId: deal.orgId, def: await dealDef(ctx, deal.orgId, values.stage), dealId: deal._id, streamId: entityId,
    source, values, now: opts.now ?? Date.now(), ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}), ...(opts.creates ? { creates: opts.creates } : {}),
  });
  // A stage change wakes event agents listening for it (lib/agents/crmEvents.ts). A dated past value from an import is
  // history, not a move happening now, so it never wakes them.
  if (before && !isHistoricalSource(source) && out.result.status === "applied") await afterDealWrite(ctx, deal, entityId, before, out.result.version);
  return { ...out, entityId };
}

/** Archive or restore a deal as `userId` (see lib/canon/dealLedger.ts writeDealLifecycle). */
export async function saveDealLifecycle(ctx: MutationCtx, deal: Doc<"deals">, op: "delete" | "restore", userId: Id<"users">, expectedVersion?: number) {
  const streamId = await dealEntity(ctx, deal, { kind: "user", userId });
  return writeDealLifecycle(dealStores(ctx), {
    orgId: deal.orgId, def: await dealDef(ctx, deal.orgId), dealId: deal._id, streamId, op, userId, now: Date.now(), ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
}

/**
 * Record a deal write. Call it right after the writer's own insert or patch,
 * in the same mutation, with the attributes that write set; the deals row
 * ends equal to the ledger's projection.
 */
export async function saveDeal(
  ctx: MutationCtx,
  deal: Doc<"deals">,
  source: DealSource,
  attributes: readonly DealAttribute[],
  now = Date.now(),
): Promise<DealWriteResult & { entityId: string }> {
  const row = deal as unknown as Record<string, FactValue | undefined>;
  const values: DealValues = Object.fromEntries(attributes.map((a) => [a, row[a] ?? null]));
  return saveDealValues(ctx, deal, source, values, { now });
}

async function dealOfEntity(ctx: MutationCtx, entityId: string) {
  const entity = await ctx.db.get(entityId as Id<"canonEntities">);
  if (entity?.projectionTable !== "deals") return null;
  const id = ctx.db.normalizeId("deals", entity.projectionId);
  const deal = id ? await ctx.db.get(id) : null;
  return deal ? { entity, deal } : null;
}

/** Mirror a proposed deal fact the gate just stored into the deal's stream. Facts about accounts and contacts are skipped. */
async function mirrorDealProposal(ctx: MutationCtx, factId: string, ownership: readonly OwnershipOverride[]) {
  const fact = await convexLedgerStore(ctx).getFact(factId);
  const target = fact && (await dealOfEntity(ctx, fact.entityId));
  if (!fact || !target) return null;
  return mirrorProposal(dealStores(ctx), { orgId: target.deal.orgId, def: await dealDef(ctx, target.deal.orgId), fact, ownership });
}

/** Apply the gate's decisions to each decided deal's stream and re-project its row. Facts about accounts and contacts are skipped. */
async function mirrorDealDecisions(ctx: MutationCtx, decided: readonly StoredFact[], decider: Decider, at: number) {
  const byEntity = new Map<string, StoredFact[]>();
  for (const f of decided) byEntity.set(f.entityId, [...(byEntity.get(f.entityId) ?? []), f]);
  for (const [entityId, facts] of byEntity) {
    const target = await dealOfEntity(ctx, entityId);
    if (!target) continue;
    await mirrorDecisions(dealStores(ctx), {
      orgId: target.deal.orgId, def: await dealDef(ctx, target.deal.orgId), dealId: target.deal._id, streamId: entityId, decided: facts, decider, at,
    });
  }
}

/** The current `facts` resolution of one attribute of an entity. */
export async function factResolution(ctx: MutationCtx, entityId: string, attribute: string): Promise<Resolution> {
  return resolveAttribute(await convexLedgerStore(ctx).factsFor(entityId, attribute));
}

/** Attributes a provider deal sync sets (nextStep is not synced in P0). */
export const SYNCED_DEAL_ATTRIBUTES: readonly DealAttribute[] = DEAL_ATTRIBUTES.filter((a) => a !== "nextStep" && a !== "splitAllocations");

/** Record existing deals' values as `import` facts; reschedules itself until done. */
export const backfillDeals = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("deals").paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.batchSize ?? 25, 100) });
    let appended = 0;
    for (const deal of page.page) {
      const { result } = await saveDeal(ctx, deal, { kind: "import" }, DEAL_ATTRIBUTES);
      if (result.status === "applied") appended++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.canon.backfillDeals, { cursor: page.continueCursor, batchSize: args.batchSize });
    }
    return { deals: page.page.length, appended, done: page.isDone };
  },
});

/** Facts one backfill transaction converts before it hands the rest of its page to the next run (see CONVERSION_FACT_BUDGET). */
const BACKFILL_FACT_BUDGET = CONVERSION_FACT_BUDGET;

const ledgerTotals = v.object({ deals: v.number(), converted: v.number(), created: v.number(), existing: v.number(), factsRead: v.number() });
type LedgerTotals = typeof ledgerTotals.type;

/**
 * CP1d backfill: give every deal's stream its history, converted from the
 * deal's facts (a deal with none gets a create entry). Idempotent: a stream
 * with entries is skipped, so a run cut short resumes from its cursor and a
 * deal a live write already converted is left alone. Reschedules itself.
 */
export const backfillDealLedger = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batchSize: v.optional(v.number()), totals: v.optional(ledgerTotals) },
  handler: async (ctx, args): Promise<LedgerTotals & { done: boolean }> => {
    const totals = { ...(args.totals ?? { deals: 0, converted: 0, created: 0, existing: 0, factsRead: 0 }) };
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 25, 100));
    const page = await ctx.db.query("deals").paginate({ cursor: args.cursor ?? null, numItems: batchSize });
    const defs = new Map<string, ResolvedObjectDef>();
    let read = 0;
    for (const deal of page.page) {
      if (read >= BACKFILL_FACT_BUDGET) {
        // Rerun this page: deals done so far are skipped as existing.
        await ctx.scheduler.runAfter(0, internal.canon.backfillDealLedger, { cursor: args.cursor ?? null, batchSize, totals });
        return { ...totals, done: false };
      }
      let def = defs.get(deal.orgId);
      if (!def) defs.set(deal.orgId, (def = await dealDef(ctx, deal.orgId)));
      const init = await ensureDealStream(dealStores(ctx), { orgId: deal.orgId, def, streamId: await dealEntity(ctx, deal), now: Date.now() });
      if (init.status === "deferred") {
        await ctx.scheduler.runAfter(0, internal.canon.backfillDealLedger, { cursor: args.cursor ?? null, batchSize, totals });
        return { ...totals, done: false };
      }
      read += init.factsRead;
      if (init.status !== "existing") totals[init.status]++;
      totals.factsRead += init.factsRead;
    }
    totals.deals += page.page.length;
    totals.existing = totals.deals - totals.converted - totals.created;
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.canon.backfillDealLedger, { cursor: page.continueCursor, batchSize, totals });
    else console.log(`backfillDealLedger done ${JSON.stringify(totals)}`);
    return { ...totals, done: page.isDone };
  },
});

type DealCheck = {
  deals: number;
  matched: number;
  noStream: number;
  mismatched: Array<{ dealId: Id<"deals">; name: string; mismatches: DealMismatch[] }>;
  /** Per attribute: deals whose row holds a value the ledger never resolved. */
  unseen: Record<string, number>;
};

/**
 * CP1d proof, one page of deals: each deal's projection, folded from its
 * stream, must equal its canonFieldState and its deals row.
 */
export const checkDealLedger = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())), batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<DealCheck & { continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db.query("deals").paginate({ cursor: args.cursor ?? null, numItems: Math.max(1, Math.min(args.batchSize ?? 100, 200)) });
    const out: DealCheck = { deals: 0, matched: 0, noStream: 0, mismatched: [], unseen: {} };
    const defs = new Map<string, ResolvedObjectDef>();
    for (const deal of page.page) {
      out.deals++;
      const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id)).first();
      const hot = entity && await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", deal.orgId).eq("streamId", entity._id)).unique();
      if (!entity || !hot) {
        out.noStream++;
        continue;
      }
      let def = defs.get(deal.orgId);
      if (!def) defs.set(deal.orgId, (def = resolveObjectDef(STANDARD_OBJECTS.deal, (await readDealDef(ctx, deal.orgId)).ext)));
      const states = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", entity._id)).take(100);
      const projected = project(def, asState(hot));
      const result = compareDeal(def, deal, projected, new Map(states.map((s) => [s.attribute, s])));
      for (const a of result.unseen) out.unseen[a] = (out.unseen[a] ?? 0) + 1;
      if (result.mismatches.length) out.mismatched.push({ dealId: deal._id, name: deal.name, mismatches: result.mismatches });
      else out.matched++;
    }
    return { ...out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Run checkDealLedger over every deal and add the pages up. */
export const checkAllDealLedgers = internalAction({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<DealCheck> => {
    const total: DealCheck = { deals: 0, matched: 0, noStream: 0, mismatched: [], unseen: {} };
    let cursor: string | null = null;
    for (;;) {
      const page: DealCheck & { continueCursor: string; isDone: boolean } = await ctx.runQuery(internal.canon.checkDealLedger, { cursor, batchSize: args.batchSize });
      total.deals += page.deals;
      total.matched += page.matched;
      total.noStream += page.noStream;
      total.mismatched.push(...page.mismatched.slice(0, Math.max(0, 50 - total.mismatched.length)));
      for (const [a, n] of Object.entries(page.unseen)) total.unseen[a] = (total.unseen[a] ?? 0) + n;
      if (page.isDone) return total;
      cursor = page.continueCursor;
    }
  },
});

async function factsForEntity(ctx: QueryCtx, entityId: Id<"canonEntities">, attribute: string) {
  return (await ctx.db.query("facts")
    .withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", entityId).eq("attribute", attribute))
    .order("desc")
    .take(FACTS_PER_ATTRIBUTE)).map(toStored);
}

/**
 * A deal as it stood at a point in time: `knownAt` (what Canon knew then,
 * transaction time) and/or `validAt` (what was true then, valid time).
 * Bounded: one entity, FACTS_PER_ATTRIBUTE per attribute.
 */
export const dealAsOf = query({
  args: { dealId: v.id("deals"), knownAt: v.optional(v.number()), validAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Record<string, { value: FactValue; state: Resolution["state"]; sourceKind: string | null }> | null> => {
    const user = await getCurrentUser(ctx);
    const deal = await ctx.db.get(args.dealId);
    if (!user || !deal || deal.orgId !== user.orgId || !dealVisible(await accessFor(ctx, user), deal)) return null;
    const entity = await ctx.db.query("canonEntities")
      .withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id))
      .first();
    if (!entity) return null;
    const out: Record<string, { value: FactValue; state: Resolution["state"]; sourceKind: string | null }> = {};
    // Fields hidden from the caller's role are not answered (CP14).
    const hidden = new Set(hiddenFields(await accessFor(ctx, user), "deal"));
    for (const attribute of DEAL_ATTRIBUTES) {
      if (hidden.has(attribute)) continue;
      const r = resolveAttribute(await factsForEntity(ctx, entity._id, attribute), undefined, { knownAt: args.knownAt, validAt: args.validAt });
      out[attribute] = { value: r.value, state: r.state, sourceKind: r.sourceKind };
    }
    return out;
  },
});

// ───────────────────────────── Accounts and contacts (CP2a) ─────────────────────────────

const PARTY_OBJECTS = ["account", "contact"] as const satisfies readonly PartyObject[];
const isPartyEntity = (e: Doc<"canonEntities">): e is Doc<"canonEntities"> & { entityType: PartyObject } =>
  (PARTY_OBJECTS as readonly string[]).includes(e.entityType);
const CRM_PROVIDERS = ["hubspot", "salesforce"] as const;
const crmProvider = (provider: string) => (CRM_PROVIDERS as readonly string[]).includes(provider) ? provider as (typeof CRM_PROVIDERS)[number] : null;

async function readPartyDef(ctx: QueryCtx, orgId: Id<"organizations">, object: PartyObject) {
  const row = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId).eq("apiName", object)).unique();
  return { row, ext: row ? fromStored<OrgObjectExtension>(row) : undefined };
}

/**
 * The field type of a `custom.<slug>` attribute: its research agent's answer
 * type when one defines it (a classify agent answers with an option key),
 * else the type of the value it is first written with.
 */
async function customType(ctx: QueryCtx, orgId: Id<"organizations">, attribute: string, value: unknown) {
  const agent = await ctx.db.query("researchAgents")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", attribute.slice("custom.".length))).unique();
  if (agent) return agent.kind === "classify" || !agent.answerType || agent.answerType === "text" ? "text" : agent.answerType === "boolean" ? "checkbox" : "number";
  return customFieldType(value);
}

/**
 * The org's account or contact definition, with each `custom.<slug>` field
 * in `values` registered first, so an agent's answer has a field to land in.
 */
async function partyDef(ctx: MutationCtx, orgId: Id<"organizations">, object: PartyObject, values: Record<string, unknown> = {}): Promise<ResolvedObjectDef> {
  const { row, ext } = await readPartyDef(ctx, orgId, object);
  let next = ext;
  for (const [attribute, value] of Object.entries(values)) {
    if (!CUSTOM_ATTRIBUTE.test(attribute) || resolveObjectDef(STANDARD_OBJECTS[object], next).byApiName.has(attribute)) continue;
    const type = await customType(ctx, orgId, attribute, value);
    if (type) next = withCustomField(STANDARD_OBJECTS[object], next, attribute, type) ?? next;
  }
  if (next && next !== ext) {
    const doc = { registryVersion: next.registryVersion, customFields: storedShape(next.customFields), updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("objectDefs", { orgId, apiName: object, ...doc, ...(next.picklistOptions ? { picklistOptions: storedShape(next.picklistOptions) } : {}) });
  }
  return resolveObjectDef(STANDARD_OBJECTS[object], next);
}

/** Register enrichment's `custom.<slug>` columns on the org's account or contact definition, typed by their values. */
export const ensureCustomFields = internalMutation({
  args: { orgId: v.id("organizations"), object: v.union(v.literal("account"), v.literal("contact")), fields: v.array(v.object({ attribute: v.string(), value: v.union(v.string(), v.number(), v.boolean()) })) },
  handler: async (ctx, a): Promise<null> => {
    await partyDef(ctx, a.orgId, a.object, Object.fromEntries(a.fields.map((f) => [f.attribute, f.value])));
    return null;
  },
});

export function partyStores(ctx: MutationCtx): PartyStores {
  return {
    facts: convexLedgerStore(ctx),
    objects: convexObjectStore(ctx),
    conversionBudget: conversionBudgetFor(ctx),
    async factAttributes(entityId, limit) {
      const rows = await ctx.db.query("canonFieldState")
        .withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId as Id<"canonEntities">))
        .take(limit);
      return rows.map((r) => r.attribute);
    },
    defWith: (orgId, object, values) => partyDef(ctx, orgId as Id<"organizations">, object, values),
    ownership: (orgId) => transactionOwnership(ctx, orgId as Id<"organizations">),
  };
}

/**
 * The values a stream starts from when an agent fact or a decision is the
 * first thing to touch it: the record's CRM mirror row when that is its
 * projection, else its identity (name and domain, or name and email) as of
 * the entity's creation, so it never reads newer than the record's history.
 */
export async function identitySeed(ctx: MutationCtx, entityId: Id<"canonEntities">): Promise<PartySeed | null> {
  const entity = await ctx.db.get(entityId);
  if (!entity || !isPartyEntity(entity)) return null;
  const accountId = entity.projectionTable === "crmAccounts" ? ctx.db.normalizeId("crmAccounts", entity.projectionId) : null;
  const contactId = entity.projectionTable === "crmContacts" ? ctx.db.normalizeId("crmContacts", entity.projectionId) : null;
  const crmRow = accountId
    ? await ctx.db.get(accountId).then((row) => row && { row, values: crmAccountValues(row) })
    : contactId ? await ctx.db.get(contactId).then((row) => row && { row, values: crmContactValues(row) }) : null;
  const provider = crmRow && crmProvider(crmRow.row.provider);
  if (crmRow && provider) return { source: { kind: provider, crmId: crmRow.row.crmId, rawData: crmRow.row.rawData }, values: crmRow.values };
  const key = entity.entityType === "account" ? ID.domain : ID.email;
  const ext = await ctx.db.query("canonExternalIds").withIndex("by_entityId", (q) => q.eq("entityId", entityId)).take(20);
  const id = ext.find((x) => x.provider === key)?.externalId ?? null;
  const values: PartyValues = entity.entityType === "account" ? { name: entity.label ?? null, domain: id } : { fullName: entity.label ?? null, email: id };
  if (Object.values(values).every((x) => x === null)) return null;
  return { source: { kind: "import", ref: "canon:identity", actorId: "canon", validFrom: entity.createdAt }, values };
}

type PartyIdentity = { externalIds: ExternalId[]; projectionTable: ProjectionTable; projectionId: string; label?: string };

/**
 * Write values of an account or contact through its ledger stream (see
 * lib/canon/partyLedger.ts writeParty). The stream is found or created from
 * `identity`. `seed` starts a new stream; undefined seeds it from identity,
 * null not at all (the write is itself the record's first snapshot).
 */
export async function saveParty(ctx: MutationCtx, p: {
  orgId: Id<"organizations">; object: PartyObject; identity: PartyIdentity | { entityId: Id<"canonEntities"> };
  source: PartySource; values: PartyValues; evidence?: string; seed?: PartySeed | null; now?: number;
}): Promise<PartyWriteResult & { entityId: Id<"canonEntities"> }> {
  const entityId = "entityId" in p.identity ? p.identity.entityId : await ensureEntity(convexLedgerStore(ctx), {
    orgId: p.orgId, entityType: p.object, projectionTable: p.identity.projectionTable, projectionId: p.identity.projectionId,
    externalIds: p.identity.externalIds, ...(p.identity.label ? { label: p.identity.label } : {}),
  }) as Id<"canonEntities">;
  const out = await writeParty(partyStores(ctx), {
    orgId: p.orgId, object: p.object, streamId: entityId, now: p.now ?? Date.now(),
    source: p.source, values: p.values, ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
    seed: async () => (p.seed === undefined ? identitySeed(ctx, entityId) : p.seed),
  });
  return { ...out, entityId };
}

/** Record a crmAccounts row a sync just wrote. Call it in the same mutation, after the insert or patch. */
export async function saveCrmAccount(ctx: MutationCtx, row: Doc<"crmAccounts">, extra: PartyValues = {}) {
  const provider = crmProvider(row.provider);
  if (!provider) return null;
  const out = await saveParty(ctx, {
    orgId: row.orgId, object: "account", seed: null,
    identity: { externalIds: accountExternalIds({ domain: row.domain, crm: { provider, crmId: row.crmId } }), projectionTable: "crmAccounts", projectionId: row._id, label: row.name },
    source: { kind: provider, crmId: row.crmId, rawData: row.rawData }, values: crmAccountValues(row),
  });
  // A portal import's further values (custom properties), with no snapshot time, as saveCrmContact writes them.
  if (!Object.keys(extra).length) return out;
  return saveParty(ctx, { orgId: row.orgId, object: "account", seed: null, identity: { entityId: out.entityId }, source: { kind: provider, crmId: row.crmId }, values: extra });
}

/** Record a crmContacts row a sync or import just wrote. Call it in the same mutation, after the insert or patch. */
export async function saveCrmContact(ctx: MutationCtx, row: Doc<"crmContacts">, extra: PartyValues = {}) {
  const provider = crmProvider(row.provider);
  if (!provider) return null;
  const values = crmContactValues(row);
  const out = await saveParty(ctx, {
    orgId: row.orgId, object: "contact", seed: null,
    identity: {
      // A portal import's other emails name the person too, so a CRM contact whose second address Canon has as someone's primary lands on them.
      externalIds: contactExternalIds({ email: row.email, otherEmails: Array.isArray(extra.additionalEmails) ? extra.additionalEmails : null, crm: { provider, crmId: row.crmId } }),
      projectionTable: "crmContacts", projectionId: row._id,
      ...(typeof values.fullName === "string" ? { label: values.fullName } : {}),
    },
    source: { kind: provider, crmId: row.crmId, rawData: row.rawData }, values,
  });
  // What a portal import reads beside the mirror row (lifecycle stage, lead status), from the same source record. It
  // carries no snapshot time: a sync's snapshot at the same time, which left these fields out, must not refuse them.
  if (!Object.keys(extra).length) return out;
  return saveParty(ctx, { orgId: row.orgId, object: "contact", seed: null, identity: { entityId: out.entityId }, source: { kind: provider, crmId: row.crmId }, values: extra });
}

const accountSnapshot = v.object({
  id: v.string(), domain: v.string(), name: v.string(), updatedAt: v.number(),
  industry: v.optional(v.string()), employees: v.optional(v.number()), country: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()), status: v.optional(v.string()), ownerId: v.optional(v.string()),
});
const contactSnapshot = v.object({
  id: v.string(), fullName: v.string(), updatedAt: v.number(),
  email: v.optional(v.string()), title: v.optional(v.string()), linkedinUrl: v.optional(v.string()),
});

/** Whether a record-service account or contact already has a ledger stream (records.edit reads its row only when not). */
export const recordHasStream = internalQuery({
  args: { orgId: v.id("organizations"), object: v.union(v.literal("account"), v.literal("contact")), recordId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const ext = await ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", args.orgId).eq("provider", args.object === "account" ? ID.recordAccount : ID.recordContact).eq("externalId", args.recordId))
      .first();
    if (!ext) return false;
    return (await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", ext.entityId)).first()) !== null;
  },
});

/**
 * A person's edit of a record-service account or contact (records.edit),
 * appended to its stream. A record worked for the first time is promoted:
 * its stream starts from `snapshot`, the row as it was before the edit. The
 * edit is one operation, named by its idempotency key: a replay of it changes
 * nothing, and `at`, the record service's time for it, orders it against the
 * person's other edits of the same field.
 */
/**
 * The Salesforce live sync's inbound change to a record on the ledger: a
 * partial Salesforce snapshot of the fields the ledger tracks, dated by the
 * change's commit time. The register row takes it from the projector's
 * write-back (docs/cp0-object-layer.md, "One register"), so the sync never
 * writes those fields to the row itself.
 */
export const saveSyncedRecordPatch = internalMutation({
  args: {
    orgId: v.id("organizations"),
    object: v.union(v.literal("account"), v.literal("contact")),
    recordId: v.string(),
    sfId: v.string(),
    /** The stream the register links the row to: the change lands there, and the row's and Salesforce's ids become its identity. */
    streamId: v.string(),
    patch: v.record(v.string(), v.union(v.string(), v.number(), v.null())),
    at: v.number(),
    /** The sync applies these values because Salesforce wins them (its authority, or a person's resolution), not because they are newer. */
    reassert: v.optional(v.boolean()),
    /** The sync operation's key, claimed with the write: a retry replays without writing again, so it never re-dates a value over a later edit. */
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const s = partyStores(ctx);
    const entityId = await registerStream(ctx, args.orgId, args.object, args.streamId);
    if (!entityId) throw new ConvexError(`stream ${args.streamId} is not this org's ${args.object}`);
    const op = { provider: `op:sync:${args.object}`, key: args.idempotencyKey };
    if ((await s.objects.findByExternalId(args.orgId, op.provider, op.key)) !== null) return { entityId, status: "unchanged", rejected: [] };
    const ids = args.object === "account"
      ? accountExternalIds({ recordId: args.recordId, crm: { provider: "salesforce", crmId: args.sfId } })
      : contactExternalIds({ recordId: args.recordId, crm: { provider: "salesforce", crmId: args.sfId } });
    for (const id of ids) {
      if ((await s.objects.findByExternalId(args.orgId, id.provider, id.externalId)) === null) await s.objects.addExternalId(args.orgId, entityId, id.provider, id.externalId);
    }
    const out = await writeParty(s, {
      orgId: args.orgId, object: args.object, streamId: entityId, now: Date.now(), values: recordEditValues(args.object, args.patch),
      source: { kind: "salesforce", crmId: args.sfId, rawData: { SystemModstamp: args.at } }, partial: true,
      ...(args.reassert ? { reassert: true as const } : {}),
      ownership: await transactionOwnership(ctx, args.orgId),
    });
    if (!out.rejected.length) await s.objects.addExternalId(args.orgId, entityId, op.provider, op.key);
    return { entityId, status: out.result.status, rejected: out.rejected };
  },
});

/**
 * The stream a register row names, when it is this org's record of that object. A row merged into another
 * names its survivor (CP15a): a Salesforce change to the merged record lands on the record it became.
 */
async function registerStream(ctx: MutationCtx, orgId: Id<"organizations">, object: "account" | "contact", streamId: string) {
  const named = ctx.db.normalizeId("canonEntities", streamId);
  const entityId = named ? await survivorOf(ctx, named) : null;
  const entity = entityId ? await ctx.db.get(entityId) : null;
  if (!entity || entity.orgId !== orgId || entity.entityType !== object) return undefined;
  return entity._id;
}

export const saveRecordEdit = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    object: v.union(v.literal("account"), v.literal("contact")),
    recordId: v.string(),
    patch: v.record(v.string(), partyFieldValue),
    snapshot: v.optional(v.union(accountSnapshot, contactSnapshot)),
    idempotencyKey: v.string(),
    at: v.optional(v.number()),
    /** The stream the record-service row is linked to (one register): the edit goes there, and the row's id becomes its identity. */
    streamId: v.optional(v.string()),
    /** The paid provider call that found the values, when the person ran a work-email lookup rather than typing them. */
    found: v.optional(v.object({ provider: v.string(), callId: v.id("providerCalls") })),
    /** Values the record must still hold when this writes (a module's approved proposal, CAS): else nothing is written. */
    expect: v.optional(v.record(v.string(), v.union(v.string(), v.null()))),
  },
  handler: async (ctx, args) => {
    const streamId = args.streamId ? await registerStream(ctx, args.orgId, args.object, args.streamId) : undefined;
    const out = await writeRecordEdit(partyStores(ctx), {
      ...(args.expect ? { expect: args.expect } : {}),
      ...(streamId ? { streamId } : {}),
      orgId: args.orgId, object: args.object, recordId: args.recordId, patch: args.patch, userId: args.userId, key: args.idempotencyKey,
      now: Date.now(), ownership: await transactionOwnership(ctx, args.orgId), identitySeed: (entityId) => identitySeed(ctx, entityId as Id<"canonEntities">),
      ...(args.at !== undefined ? { at: args.at } : {}), ...(args.snapshot ? { snapshot: args.snapshot } : {}), ...(args.found ? { found: args.found } : {}),
    });
    const version = "version" in out.result ? out.result.version : undefined;
    return { entityId: out.entityId, status: out.result.status, rejected: out.rejected, ...(version !== undefined ? { version } : {}) };
  },
});

/**
 * Delete or restore a register row (records.bulkRegister): a `lifecycle` entry
 * on its stream, which an unworked row gets by being promoted first
 * (lib/canon/partyLedger.ts writeRecordLifecycle).
 */
export const saveRecordLifecycle = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    object: v.union(v.literal("account"), v.literal("contact")),
    recordId: v.string(),
    op: v.union(v.literal("delete"), v.literal("restore")),
    snapshot: v.optional(v.union(accountSnapshot, contactSnapshot)),
    /** The stream the record-service row is linked to, when it has one. */
    streamId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: string; message?: string }> => {
    const streamId = args.streamId ? await registerStream(ctx, args.orgId, args.object, args.streamId) : undefined;
    const { result } = await writeRecordLifecycle(partyStores(ctx), {
      ...(streamId ? { streamId } : {}),
      orgId: args.orgId, object: args.object, recordId: args.recordId, op: args.op, userId: args.userId, now: Date.now(),
      identitySeed: (entityId) => identitySeed(ctx, entityId as Id<"canonEntities">), ...(args.snapshot ? { snapshot: args.snapshot } : {}),
    });
    if (result.status === "deferred") return { status: "invalid", message: "This record's history is still being moved onto the ledger; try again in a moment" };
    if (result.status === "invalid") return { status: "invalid", message: result.errors.map((e) => e.message).join("; ") };
    if (result.status === "conflict") return { status: "invalid", message: "Someone else changed this record; reload and try again" };
    return { status: result.status };
  },
});

/**
 * Would saveRecordEdit take this edit whole? The fields it would leave out
 * (an invalid value, a field the user's ownership denies, a unique value
 * another record holds), read before records.edit writes the record service.
 */
export const checkRecordEdit = internalQuery({
  args: {
    orgId: v.id("organizations"),
    object: v.union(v.literal("account"), v.literal("contact")),
    recordId: v.string(),
    patch: v.record(v.string(), partyFieldValue),
    snapshot: v.optional(v.union(accountSnapshot, contactSnapshot)),
    idempotencyKey: v.string(),
    streamId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ patch: RecordPatch; refused: CoerceError[] }> => {
    const lookup: PartyLookup = {
      async findEntityByExternalId(orgId, provider, externalId) {
        const row = await ctx.db.query("canonExternalIds")
          .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId as Id<"organizations">).eq("provider", provider).eq("externalId", externalId))
          .first();
        return row ? survivorOf(ctx, row.entityId) : null;
      },
      async findEntityByProjection(orgId, projectionId) {
        const row = await ctx.db.query("canonEntities")
          .withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId as Id<"organizations">).eq("projectionId", projectionId))
          .first();
        return row ? survivorOf(ctx, row._id) : null;
      },
      labelOf: (entityId) => recordLabel(ctx, entityId),
    };
    // An edit's fields are standard ones (recordEditValues), so the stored definition is the one the save resolves.
    const def = resolveObjectDef(STANDARD_OBJECTS[args.object], (await readPartyDef(ctx, args.orgId, args.object)).ext);
    return checkPartyEdit(lookup, {
      orgId: args.orgId, object: args.object, def, recordId: args.recordId, patch: args.patch, key: args.idempotencyKey,
      ownership: await orgOwnership(ctx, args.orgId), ...(args.snapshot ? { snapshot: args.snapshot } : {}),
      ...(args.streamId ? { streamId: args.streamId } : {}),
    });
  },
});

const ownershipReads = new WeakMap<MutationCtx, Map<string, Promise<OwnershipOverride[]>>>();

/** orgOwnership read once per transaction: every account and contact write in it (sync, promotion, backfill, edits) applies the same overrides. */
function transactionOwnership(ctx: MutationCtx, orgId: Id<"organizations">): Promise<OwnershipOverride[]> {
  let reads = ownershipReads.get(ctx);
  if (!reads) ownershipReads.set(ctx, (reads = new Map()));
  let read = reads.get(orgId);
  if (!read) reads.set(orgId, (read = orgOwnership(ctx, orgId)));
  return read;
}

/** The org's field-ownership overrides (canonFieldOwnership), as the gate and record edits apply them. */
export async function orgOwnership(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">): Promise<OwnershipOverride[]> {
  return (await ctx.db.query("canonFieldOwnership").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500))
    .map((r) => ({ sourceKind: r.sourceKind, attribute: r.attribute, allowed: r.allowed, entityType: r.entityType }));
}

/**
 * A proposed value as both ledgers will store it: coerced by the org's
 * definition (text trimmed, dates normalized). A `custom.<slug>` attribute is
 * registered as a field first. Agents cannot add deal stages.
 */
export async function normalizeProposal(ctx: MutationCtx, orgId: Id<"organizations">, entityType: EntityType, attribute: string, value: FactValue): Promise<{ ok: true; value: FactValue } | { ok: false; message: string }> {
  if (entityType === "opportunity") return normalizeDealProposal(ctx, orgId, attribute, value);
  const coerced = coerce(await partyDef(ctx, orgId, entityType, { [attribute]: value }), { [attribute]: value }, { mode: "update" });
  if (!coerced.ok) return { ok: false, message: coerced.errors.map((e) => e.message).join("; ") };
  return { ok: true, value: (coerced.values[0]?.value ?? null) as FactValue };
}

/** Mirror a proposed fact the gate just stored into its deal's, account's or contact's stream. */
export async function mirrorGateProposal(ctx: MutationCtx, factId: string, ownership: readonly OwnershipOverride[]) {
  const fact = await convexLedgerStore(ctx).getFact(factId);
  if (!fact) return null;
  const entity = await ctx.db.get(fact.entityId as Id<"canonEntities">);
  if (!entity) return null;
  if (entity.projectionTable === "deals") return mirrorDealProposal(ctx, factId, ownership);
  if (!isPartyEntity(entity)) return null;
  return mirrorPartyProposal(partyStores(ctx), { orgId: entity.orgId, object: entity.entityType, fact, ownership }, () => identitySeed(ctx, entity._id));
}

/** Apply the gate's decisions to each decided record's stream; a deal's row is re-projected. */
export async function mirrorDecidedFacts(ctx: MutationCtx, decided: readonly StoredFact[], decider: Decider, at: number) {
  await mirrorDealDecisions(ctx, decided, decider, at);
  const byEntity = new Map<string, StoredFact[]>();
  for (const f of decided) byEntity.set(f.entityId, [...(byEntity.get(f.entityId) ?? []), f]);
  for (const [entityId, facts] of byEntity) {
    const entity = await ctx.db.get(entityId as Id<"canonEntities">);
    if (!entity || !isPartyEntity(entity)) continue;
    await mirrorPartyDecisions(partyStores(ctx), {
      orgId: entity.orgId, object: entity.entityType, streamId: entity._id, now: at, decided: facts, decider,
    }, () => identitySeed(ctx, entity._id));
  }
}

const PARTY_PHASES = ["crmAccounts", "crmContacts", "entities"] as const;
type PartyPhase = (typeof PARTY_PHASES)[number];
const partyPhase = v.union(...PARTY_PHASES.map((p) => v.literal(p)));
const partyTotals = v.object({ records: v.number(), applied: v.number(), unchanged: v.number(), converted: v.number(), skipped: v.number() });
type PartyTotals = typeof partyTotals.type;

/** Has the stream any entries? A record-service promotion or a pre-CP2a gate target may have identity and no stream. */
async function hasEntries(ctx: QueryCtx, entityId: Id<"canonEntities">) {
  return (await ctx.db.query("ledgerEntries").withIndex("by_streamId_version", (q) => q.eq("streamId", entityId)).first()) !== null;
}

/**
 * CP2a backfill: give every worked account and contact its stream. Phase
 * `crmAccounts` and `crmContacts` record each CRM mirror row as its provider's
 * snapshot (converting the record's facts first); phase `entities` converts
 * every other account or contact that has facts. An entity with identity and
 * no facts (a TAM row a research run only looked at) is not worked and is
 * not visited. Idempotent: an unchanged snapshot appends nothing and a stream with
 * entries is not converted again, so a run cut short resumes from its cursor.
 * A page whose records' histories do not fit one transaction's conversion
 * budget is rerun from the record after the last one visited. A record whose
 * history no transaction can convert is counted as skipped and logged once.
 * Reschedules itself.
 */
export const backfillAccountContactLedger = internalMutation({
  args: {
    phase: v.optional(partyPhase), cursor: v.optional(v.union(v.string(), v.null())), batchSize: v.optional(v.number()), totals: v.optional(partyTotals),
    /** Phase `entities`: the entity the previous page ended in, so an entity split across pages is visited once. */
    lastEntity: v.optional(v.string()),
    /** A rerun of the page at `cursor`: the id of the last document it visited. */
    after: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<PartyTotals & { phase: PartyPhase; done: boolean }> => {
    const phase = args.phase ?? "crmAccounts";
    const totals = { ...(args.totals ?? { records: 0, applied: 0, unchanged: 0, converted: 0, skipped: 0 }) };
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 25, 100));
    // Both budgets: conversions, and the facts a long-lived record's appended fields re-resolve from (as a CRM sync's are).
    const hasBudget = () => conversionBudgetFor(ctx).remaining > 0 && partySyncHasBudget(ctx);
    const oversized = (entityId: string): BackfillOutcome => {
      console.warn(`backfillAccountContactLedger: ${entityId} has more than ${PARTY_ATTRIBUTES_MAX} fact attributes or ${PARTY_CONVERSION_FACTS_MAX} facts; it stays in facts`);
      return "oversized";
    };
    let page: { isDone: boolean; continueCursor: string };
    let out: Awaited<ReturnType<typeof backfillPage>>;
    let lastEntity = args.lastEntity;
    if (phase !== "entities") {
      const rows = await ctx.db.query(phase).paginate({ cursor: args.cursor ?? null, numItems: batchSize });
      page = rows;
      out = await backfillPage<Doc<"crmAccounts"> | Doc<"crmContacts">>(rows.page, {
        key: (doc) => doc._id, after: args.after, hasBudget,
        visit: async (doc) => {
          const saved = phase === "crmAccounts" ? await saveCrmAccount(ctx, doc as Doc<"crmAccounts">) : await saveCrmContact(ctx, doc as Doc<"crmContacts">);
          if (!saved) return "skipped";
          if (saved.result.status === "deferred") return saved.result.oversized ? oversized(saved.entityId) : "deferred";
          return saved.result.status === "applied" ? "applied" : "unchanged";
        },
      });
    } else {
      // Entities with facts are exactly those with canonFieldState rows, which the index keeps together per entity.
      const rows = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute").paginate({ cursor: args.cursor ?? null, numItems: batchSize * 4 });
      page = rows;
      out = await backfillPage(rows.page, {
        key: (row) => row._id, after: args.after, hasBudget,
        visit: async (row) => {
          if (row.entityId === lastEntity) return "ignored";
          const entity = await ctx.db.get(row.entityId);
          let outcome: BackfillOutcome;
          if (!entity || !isPartyEntity(entity) || entity.mergedInto) outcome = "ignored";
          else if (await hasEntries(ctx, entity._id)) outcome = "skipped";
          else {
            const init = await ensurePartyStream(partyStores(ctx), { orgId: entity.orgId, object: entity.entityType, streamId: entity._id, now: Date.now() }, () => identitySeed(ctx, entity._id));
            if (init.status === "deferred" && !init.oversized) return "deferred";
            outcome = init.status === "deferred" ? oversized(entity._id) : "converted";
          }
          lastEntity = row.entityId;
          return outcome;
        },
      });
    }
    for (const k of Object.keys(out.counted) as (keyof PartyTotals)[]) totals[k] += out.counted[k];
    const entityArg = lastEntity ? { lastEntity } : {};
    if (out.stopped) {
      await ctx.scheduler.runAfter(0, internal.canon.backfillAccountContactLedger, {
        phase, cursor: args.cursor ?? null, batchSize, totals, ...entityArg, ...(out.resumeAfter !== undefined ? { after: out.resumeAfter } : {}),
      });
      return { ...totals, phase, done: false };
    }
    const next = PARTY_PHASES[PARTY_PHASES.indexOf(phase) + 1];
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.canon.backfillAccountContactLedger, { phase, cursor: page.continueCursor, batchSize, totals, ...entityArg });
    else if (next) await ctx.scheduler.runAfter(0, internal.canon.backfillAccountContactLedger, { phase: next, cursor: null, batchSize, totals });
    else console.log(`backfillAccountContactLedger done ${JSON.stringify(totals)}`);
    return { ...totals, phase, done: page.isDone && !next };
  },
});

type PartyCheck = {
  records: number;
  matched: number;
  /** Worked records (a CRM row, or facts) whose stream has no hot row yet. */
  noStream: number;
  /** Per field: records where another source wins over the CRM row's value. */
  overridden: Record<string, number>;
  mismatched: Array<{ phase: PartyPhase; id: string; label: string; mismatches: PartyMismatch[] }>;
};
const emptyCheck = (): PartyCheck => ({ records: 0, matched: 0, noStream: 0, overridden: {}, mismatched: [] });

/**
 * CP2a proof, one page of one phase. For a CRM mirror row: its record's
 * projection equals its canonFieldState, and the row equals the latest values
 * its own source record asserted in the stream. For another worked account or
 * contact: projection equals canonFieldState.
 */
export const checkAccountContactLedger = internalQuery({
  args: { phase: partyPhase, cursor: v.optional(v.union(v.string(), v.null())), batchSize: v.optional(v.number()), lastEntity: v.optional(v.string()) },
  handler: async (ctx, args): Promise<PartyCheck & { continueCursor: string; isDone: boolean; lastEntity?: string }> => {
    const numItems = Math.max(1, Math.min(args.batchSize ?? 100, 200));
    const out = emptyCheck();
    const defs = new Map<string, ResolvedObjectDef>();
    const defFor = async (orgId: Id<"organizations">, object: PartyObject) => {
      const key = `${orgId}:${object}`;
      let def = defs.get(key);
      if (!def) defs.set(key, (def = resolveObjectDef(STANDARD_OBJECTS[object], (await readPartyDef(ctx, orgId, object)).ext)));
      return def;
    };
    const check = async (orgId: Id<"organizations">, object: PartyObject, entityId: Id<"canonEntities">, id: string, label: string, crm?: { sourceRef: string; values: PartyValues }) => {
      const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", entityId)).unique();
      const states = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId)).take(PARTY_ATTRIBUTES_MAX);
      if (!hot) {
        out.noStream++;
        return;
      }
      out.records++;
      const def = await defFor(orgId, object);
      const state = asState(hot);
      const result = compareParty(def, object, state, project(def, state), new Map(states.map((s) => [s.attribute, s])), crm);
      for (const a of result.overridden) out.overridden[a] = (out.overridden[a] ?? 0) + 1;
      if (result.mismatches.length) out.mismatched.push({ phase: args.phase, id, label, mismatches: result.mismatches });
      else out.matched++;
    };
    const crmEntity = async (orgId: Id<"organizations">, provider: string, crmId: string) =>
      (await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId).eq("provider", provider).eq("externalId", crmId)).first())?.entityId ?? null;

    if (args.phase === "entities") {
      // Accounts and contacts with facts, other than CRM rows' (checked with their row above).
      const page = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute").paginate({ cursor: args.cursor ?? null, numItems: numItems * 4 });
      let lastEntity = args.lastEntity;
      for (const row of page.page) {
        if (row.entityId === lastEntity) continue;
        lastEntity = row.entityId;
        const e = await ctx.db.get(row.entityId);
        if (!e || !isPartyEntity(e) || e.mergedInto || e.projectionTable === "crmAccounts" || e.projectionTable === "crmContacts") continue;
        await check(e.orgId, e.entityType, e._id, e._id, e.label ?? "");
      }
      return { ...out, continueCursor: page.continueCursor, isDone: page.isDone, ...(lastEntity ? { lastEntity } : {}) };
    }
    if (args.phase === "crmAccounts") {
      const page = await ctx.db.query("crmAccounts").paginate({ cursor: args.cursor ?? null, numItems });
      for (const row of page.page) {
        const entityId = await crmEntity(row.orgId, ID.crmAccount(row.provider), row.crmId);
        if (!entityId) { out.noStream++; continue; }
        await check(row.orgId, "account", entityId, row._id, row.name, { sourceRef: `${row.provider}:account:${row.crmId}`, values: crmAccountValues(row) });
      }
      return { ...out, continueCursor: page.continueCursor, isDone: page.isDone };
    }
    const page = await ctx.db.query("crmContacts").paginate({ cursor: args.cursor ?? null, numItems });
    for (const row of page.page) {
      const entityId = await crmEntity(row.orgId, ID.crmContact(row.provider), row.crmId);
      if (!entityId) { out.noStream++; continue; }
      const values = crmContactValues(row);
      await check(row.orgId, "contact", entityId, row._id, String(values.fullName ?? row.email ?? ""), { sourceRef: `${row.provider}:contact:${row.crmId}`, values });
    }
    return { ...out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Run checkAccountContactLedger over every phase and add the pages up. */
export const checkAllAccountContactLedgers = internalAction({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<PartyCheck> => {
    const total = emptyCheck();
    for (const phase of PARTY_PHASES) {
      let cursor: string | null = null;
      let lastEntity: string | undefined;
      for (;;) {
        const page: PartyCheck & { continueCursor: string; isDone: boolean; lastEntity?: string } = await ctx.runQuery(internal.canon.checkAccountContactLedger, {
          phase, cursor, batchSize: args.batchSize, ...(lastEntity ? { lastEntity } : {}),
        });
        lastEntity = page.lastEntity;
        total.records += page.records;
        total.matched += page.matched;
        total.noStream += page.noStream;
        for (const [a, n] of Object.entries(page.overridden)) total.overridden[a] = (total.overridden[a] ?? 0) + n;
        total.mismatched.push(...page.mismatched.slice(0, Math.max(0, 50 - total.mismatched.length)));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }
    return total;
  },
});
