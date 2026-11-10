/**
 * CanonCRM P1: the agent write gate (docs/canoncrm-spec.md, PR #278).
 *
 * Agents submit a batch of proposed facts about deals, accounts or contacts
 * over the CLI or MCP. Accounts and contacts are found in Canon: a synced CRM
 * row, or a TAM record promoted with canonEntities.promote, which an action
 * does first for one the caller sees (admitProposalTargets). The batch
 * is a patch plan (operation CANON_PROPOSAL_OP) whose operations each point at
 * one proposed fact (packageOpId = fact id). Facts for attributes the source
 * does not own are rejected at ingest. A person accepts or rejects facts from
 * the review queue; an org's auto-accept rule can accept a fact only after Jev
 * has checked its value against its evidence. Accepting a fact re-resolves the
 * attribute; nothing is pushed to a CRM.
 *
 * Deals, accounts and contacts are on the object-layer ledger (convex/canon.ts).
 * Their proposals still pass this gate in `facts`, normalized by the object's
 * definition first, and each proposal and decision is mirrored into the
 * record's stream; a deal's projection then patches its deal row.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { convexLedgerStore, customAttributesOf, factResolution, flushPartyMirror, mirrorDecidedFacts, mirrorGateProposal, normalizeProposal, orgOwnership, saveDealValues, saveParty } from "./canon";
import { decideFacts, ensureEntity, ingestObservations, type LedgerStore } from "./lib/canon/ledger";
import { deciderOf } from "./lib/canon/decider";
import { CORE_ATTRIBUTES, CUSTOM_ATTRIBUTE, ENTITY_NOUN, ENTITY_TYPES, attributeLabel, isScalarProposalAttribute, type EntityType } from "./lib/canon/attributes";
import { ID, accountExternalIds, contactExternalIds, normalizeDomain, normalizeEmail } from "./lib/canon/identity";
import { AGENT_SOURCES, CANON_PROPOSAL_OP, autoAcceptDecision, moduleOfSourceRef, needsVerification, ownershipGrid, type AutoAcceptRule, type OwnershipOverride } from "./lib/canon/gate";
import { jevAsk, JEV_MODEL } from "./lib/segments/jev";
import { declaredLabel, proposalSourceRefBase, provenanceOf, type Attribution } from "./lib/agents/attribution";
import { describeActor, type ActorCache } from "./agents";
import { accessFor, dealVisible, entitySight, principalAccess, querySees, sightAdmits, sightJudge, type PendingSight } from "./permissions";
import { callerClient, principalClient, requireCaller } from "./records";
import { admitThenRead, visibleIds } from "./lib/scopedRecordClient";
import { agentPrincipals, hiddenFields, may, mayWriteField, type Access } from "./lib/access";
import { PROMOTE_MAX, promoteAccounts, promoteContacts } from "./lib/recordPromotion";
import { FACT_OBJECTS, FACTS_MAX_IDS, FACTS_MAX_RECEIPTS, type FactObject, type FactReceipt, type FactValue, type FactsForRecordsRow, type ResolvedField } from "../modules/kernel/facts.ts";

const MAX_FACTS_PER_BATCH = 500;
const QUEUE_LIMIT = 200;

const agentSource = v.union(...AGENT_SOURCES.map((k) => v.literal(k)));
export const entityTypeValidator = v.union(...ENTITY_TYPES.map((k) => v.literal(k)));
const sourceKindValidator = v.union(
  v.literal("user"), v.literal("salesforce"), v.literal("hubspot"), v.literal("import"),
  v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("enrichment"), v.literal("pipeline"), v.literal("agent_run"), v.literal("canon_field"),
);
const factValue = v.union(v.string(), v.number(), v.boolean(), v.null());

export const proposedFactValidator = v.object({
  /** What the fact is about. Defaults to a deal. */
  entityType: v.optional(entityTypeValidator),
  /** Deal: the Canon deal id. */
  dealId: v.optional(v.string()),
  /** Account / contact: a synced CRM row (crmAccounts / crmContacts id). */
  accountId: v.optional(v.string()),
  contactId: v.optional(v.string()),
  /** Any type: a CRM record id with its provider. */
  crmProvider: v.optional(v.union(v.literal("salesforce"), v.literal("hubspot"))),
  crmId: v.optional(v.string()),
  /** Account / contact already in Canon: its entity id, record-service id, domain (accounts) or email (contacts). */
  entityId: v.optional(v.string()),
  recordId: v.optional(v.string()),
  domain: v.optional(v.string()),
  email: v.optional(v.string()),
  attribute: v.string(),
  value: factValue,
  evidence: v.optional(v.string()),
  confidence: v.optional(v.number()),
  validFrom: v.optional(v.number()),
});

async function orgRules(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">): Promise<AutoAcceptRule[]> {
  return (await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(500))
    .map((r) => ({ sourceKind: r.sourceKind, attribute: r.attribute, minConfidence: r.minConfidence, enabled: r.enabled, entityType: r.entityType }));
}

async function findDeal(ctx: MutationCtx, orgId: Id<"organizations">, f: { dealId?: string; crmProvider?: string; crmId?: string }): Promise<Doc<"deals"> | null> {
  if (f.dealId) {
    const id = ctx.db.normalizeId("deals", f.dealId);
    const deal = id ? await ctx.db.get(id) : null;
    return deal && deal.orgId === orgId ? deal : null;
  }
  if (f.crmProvider && f.crmId) {
    const ext = await ctx.db.query("canonExternalIds")
      .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId).eq("provider", f.crmProvider!).eq("externalId", f.crmId!))
      .first();
    const entity = ext ? await ctx.db.get(ext.entityId) : null;
    const id = entity ? ctx.db.normalizeId("deals", entity.projectionId) : null;
    const deal = id ? await ctx.db.get(id) : null;
    return deal && deal.orgId === orgId ? deal : null;
  }
  return null;
}

type ProposedFact = typeof proposedFactValidator.type;
type Target = { entityId: string; entityType: EntityType; objectKey: string; deal: Doc<"deals"> | null };
type TargetMiss = "unknown_deal" | "unknown_account" | "unknown_contact";

async function entityByExternalId(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, provider: string, externalId: string) {
  const ext = await ctx.db.query("canonExternalIds")
    .withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", orgId).eq("provider", provider).eq("externalId", externalId))
    .first();
  return ext ? await ctx.db.get(ext.entityId) : null;
}

/**
 * The entity a proposed fact is about. Deals and synced CRM rows get an entity
 * on first use. A TAM account or contact must have been promoted first (an
 * action's admitProposalTargets promotes one the caller sees), since a
 * mutation cannot read the record service to check that the row exists.
 */
async function findTarget(ctx: MutationCtx, store: LedgerStore, orgId: Id<"organizations">, f: ProposedFact): Promise<Target | TargetMiss> {
  const entityType = f.entityType ?? "opportunity";
  if (entityType === "opportunity") {
    const deal = await findDeal(ctx, orgId, f);
    if (!deal) return "unknown_deal";
    const entityId = await ensureEntity(store, {
      orgId, projectionId: deal._id,
      ...(deal.crmId && deal.crmProvider ? { provider: deal.crmProvider, externalId: deal.crmId } : {}),
    });
    return { entityId, entityType, objectKey: deal._id, deal };
  }
  const miss: TargetMiss = entityType === "account" ? "unknown_account" : "unknown_contact";
  const found = (entityId: string): Target => ({ entityId, entityType, objectKey: entityId, deal: null });
  // A synced CRM row: anchor (or find) its entity.
  if (entityType === "account" && (f.accountId || (f.crmProvider && f.crmId))) {
    const row = f.accountId
      ? await getInOrg(ctx, orgId, ctx.db.normalizeId("crmAccounts", f.accountId))
      : (await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", f.crmId!)).take(10))
        .find((r) => r.provider === f.crmProvider) ?? null;
    if (!row) return miss;
    return found(await ensureEntity(store, {
      orgId, entityType, projectionTable: "crmAccounts", projectionId: row._id, label: row.name,
      externalIds: accountExternalIds({ domain: row.domain, crm: { provider: row.provider, crmId: row.crmId } }),
    }));
  }
  if (entityType === "contact" && (f.contactId || (f.crmProvider && f.crmId))) {
    const row = f.contactId
      ? await getInOrg(ctx, orgId, ctx.db.normalizeId("crmContacts", f.contactId))
      : (await ctx.db.query("crmContacts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", f.crmId!)).take(10))
        .find((r) => r.provider === f.crmProvider) ?? null;
    if (!row) return miss;
    const label = [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || "(unnamed contact)";
    return found(await ensureEntity(store, {
      orgId, entityType, projectionTable: "crmContacts", projectionId: row._id, label,
      externalIds: contactExternalIds({ email: row.email, crm: { provider: row.provider, crmId: row.crmId } }),
    }));
  }
  const entity = await findCanonEntity(ctx, orgId, entityType, f);
  return entity ? found(entity._id) : miss;
}

/** An account or contact already in Canon that a fact names: by entity id or a linked identifier. Reads only. */
async function findCanonEntity(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, entityType: "account" | "contact", f: ProposedFact) {
  let entity: Doc<"canonEntities"> | null = null;
  if (f.entityId) entity = await getInOrg(ctx, orgId, ctx.db.normalizeId("canonEntities", f.entityId));
  else if (f.recordId) entity = await entityByExternalId(ctx, orgId, entityType === "account" ? ID.recordAccount : ID.recordContact, f.recordId);
  else if (entityType === "account" && f.domain) entity = await entityByExternalId(ctx, orgId, ID.domain, normalizeDomain(f.domain));
  else if (entityType === "contact" && f.email) entity = await entityByExternalId(ctx, orgId, ID.email, normalizeEmail(f.email));
  return entity && entity.entityType === entityType && !entity.mergedInto ? entity : null;
}

type ProposalTargets = { accesses: Access[] | null; account: string[]; contact: string[]; unanchored: { account: string[]; contact: string[] } };

/**
 * The record-service ids of the companies and people a batch names, and the
 * access of the user it writes for: what an action admits through that
 * user's scoped client before the gate runs (admitProposalTargets). Those named
 * by a record id that has no Canon entity yet are `unanchored`, at most
 * PROMOTE_MAX of each.
 */
export const proposalTargets = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), facts: v.array(proposedFactValidator) },
  handler: async (ctx, args): Promise<ProposalTargets> => {
    const ids = { account: new Set<string>(), contact: new Set<string>() };
    const unanchored = { account: new Set<string>(), contact: new Set<string>() };
    for (const f of args.facts) {
      const entityType = f.entityType ?? "opportunity";
      if (entityType === "opportunity" || f.accountId || f.contactId || (f.crmProvider && f.crmId)) continue;
      const entity = await findCanonEntity(ctx, args.orgId, entityType, f);
      if (entity && (entity.projectionTable === "recordAccounts" || entity.projectionTable === "recordContacts")) ids[entityType].add(entity.projectionId);
      else if (!entity && !f.entityId && f.recordId && unanchored[entityType].size < PROMOTE_MAX) unanchored[entityType].add(f.recordId);
    }
    return {
      accesses: await principalAccess(ctx, args.orgId, [args.userId]), account: [...ids.account], contact: [...ids.contact],
      unanchored: { account: [...unanchored.account], contact: [...unanchored.contact] },
    };
  },
});

/**
 * The record-service ids among a batch's targets that `userId` sees (CP14),
 * read through their scoped client: the gate's `admitted` for a batch from
 * the CLI, MCP or a module's call. Companies and people the user cannot see
 * read as missing. One they see that has no Canon entity yet is promoted first,
 * as `canonEntities.promote` does when their role may edit it, so a fact about
 * it has a record to land on.
 */
export async function admitProposalTargets(ctx: ActionCtx, orgId: Id<"organizations">, userId: Id<"users">, facts: ProposedFact[]): Promise<string[]> {
  const t: ProposalTargets = await ctx.runQuery(internal.canonGate.proposalTargets, { orgId, userId, facts });
  const accesses = t.accesses;
  if (!accesses) return [];
  const client = principalClient(ctx, orgId, accesses);
  const edits = (object: "account" | "contact") => t.unanchored[object].length > 0 && accesses.every((a) => may(a, object, "edit"));
  const promoted = [
    ...(edits("account") ? (await promoteAccounts(ctx, client, orgId, t.unanchored.account)).promoted.map((p) => p.recordId) : []),
    ...(edits("contact") ? (await promoteContacts(ctx, client, orgId, t.unanchored.contact)).map((p) => p.recordId) : []),
  ];
  return [...await visibleIds(client, orgId, "account", t.account), ...await visibleIds(client, orgId, "contact", t.contact), ...promoted];
}

async function getInOrg<T extends "crmAccounts" | "crmContacts" | "canonEntities">(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, id: Id<T> | null) {
  const row = id ? await ctx.db.get(id) : null;
  return row && row.orgId === orgId ? row : null;
}

/** Close out a batch once none of its facts are still proposed. */
export async function settlePlan(ctx: MutationCtx, patchPlanId: Id<"patchPlans">, userId: Id<"users"> | undefined, at: number) {
  const plan = await ctx.db.get(patchPlanId);
  if (!plan || plan.operation !== CANON_PROPOSAL_OP) return;
  const ops = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", patchPlanId)).take(MAX_FACTS_PER_BATCH);
  let pending = 0, accepted = 0;
  for (const op of ops) {
    const fact = op.packageOpId ? await ctx.db.get(op.packageOpId as Id<"facts">) : null;
    const status = !fact ? "skipped" : fact.status === "accepted" ? "applied" : fact.status === "proposed" ? "pending" : "skipped";
    if (status === "pending") pending++;
    if (status === "applied") accepted++;
    if (op.status !== status) await ctx.db.patch(op._id, { status, updatedAt: at });
  }
  if (pending || !["pending_approval", "approved"].includes(plan.status)) return;
  const status = accepted ? "applied" : "rejected";
  await ctx.db.patch(patchPlanId, {
    status, updatedAt: at,
    ...(accepted ? { appliedAt: at, ...(userId ? { appliedBy: userId, approvedBy: userId, approvedAt: at } : {}) } : {}),
  });
  await ctx.db.insert("operationAuditLog", {
    orgId: plan.orgId, userId, patchPlanId, verb: plan.verb, operation: plan.operation,
    status, details: { accepted, total: ops.length }, createdAt: at, ...(plan.agentId ? { agentId: plan.agentId } : {}),
  });
}

/**
 * Ingest a batch of proposed facts from an authenticated CLI/MCP caller. The
 * wire field `agentId` is the caller's name for its tool (a DeclaredLabel),
 * not an identity: these batches are attributed to the user.
 */
const proposalArgs = {
  agentId: v.string(),
  sourceKind: agentSource,
  title: v.string(),
  reason: v.optional(v.string()),
  facts: v.array(proposedFactValidator),
};

export const submitProposals = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    cliTokenId: v.optional(v.id("cliTokens")),
    /** Record-service ids the caller admitted through the user's scoped client (admitProposalTargets). */
    admitted: v.array(v.string()),
    ...proposalArgs,
  },
  handler: (ctx, { orgId, userId, cliTokenId, agentId, ...batch }) =>
    submitProposalBatch(ctx, { ...batch, attribution: { kind: "user", orgId, userId, cliTokenId, label: declaredLabel(agentId) } }),
});

/**
 * Propose facts as the signed-in user. A mutation cannot read the record
 * service, so a role that sees only some companies or people can propose on
 * them only through proposeScoped (which hosted MCP calls).
 */
export const propose = mutation({
  args: proposalArgs,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { agentId, ...batch } = args;
    // Nothing admitted: a company or person only the record service can judge reads as missing for a narrowed role.
    return submitProposalBatch(ctx, { ...batch, admitted: [], attribution: { kind: "user", orgId: user.orgId, userId: user._id, label: declaredLabel(agentId) } });
  },
});

/** Propose facts as the signed-in user, on the records they see (CP14): hosted MCP's canon_propose_facts. */
export const proposeScoped = action({
  args: proposalArgs,
  handler: async (ctx, args): Promise<BatchResult> => {
    const caller = await requireCaller(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const admitted = await admitProposalTargets(ctx, orgId, userId, args.facts);
    return ctx.runMutation(internal.canonGate.submitProposals, { ...args, orgId, userId, admitted });
  },
});

type BatchResult = { patchPlanId: Id<"patchPlans">; proposed: number; unchanged: number; verifying: number; rejected: Array<{ index: number; attribute: string; reason: string }> };

/**
 * The one writer of proposal batches. Who the batch is from (actor, plan
 * author, agent, org, sourceRef namespace) is derived from the attribution
 * alone, so no caller can pair a verified agent with someone else's org or
 * namespace.
 */
export async function submitProposalBatch(ctx: MutationCtx, args: {
  attribution: Attribution; sourceKind: (typeof AGENT_SOURCES)[number]; title: string; reason?: string;
  facts: ProposedFact[];
  /**
   * Trusted callers only (an AI field run, never a public mutation): per fact, Jev's own read of the
   * record when the answer is Jev's inference rather than a quote. It is the fact's verification score,
   * so the field's auto-accept threshold applies to it directly instead of a second check of its evidence.
   */
  reads?: ReadonlyArray<number | null | undefined>;
  /**
   * Trusted callers only: record-service ids of companies and people the caller read or admitted through the
   * batch's principals' scoped client. A target only the record service can judge is written only when listed
   * here (CP14); otherwise it reads as missing, like any record a principal cannot see.
   */
  admitted: readonly string[];
  /**
   * A module's batch: a `custom.<slug>` the org has no field for (canon.ts customAttributesOf) is `unknown_attribute`,
   * not a new field. Other callers' first answer to a slug registers its field.
   */
  knownCustomOnly?: true;
}) {
  {
    if (!args.facts.length) throw new ConvexError("A batch needs at least one fact");
    if (args.facts.length > MAX_FACTS_PER_BATCH) throw new ConvexError(`A batch holds at most ${MAX_FACTS_PER_BATCH} facts`);
    const p = provenanceOf(args.attribution);
    const orgId = p.orgId;
    const now = Date.now();
    const patchPlanId = await ctx.db.insert("patchPlans", {
      orgId, createdBy: p.createdBy, verb: "set", operation: CANON_PROPOSAL_OP,
      args: { sourceKind: args.sourceKind, agentId: p.refKey, title: args.title.slice(0, 200) },
      reason: args.reason?.slice(0, 2000), status: "pending_approval", riskLevel: "medium", approvalRequirement: "required",
      createdAt: now, updatedAt: now, source: "cli", cliTokenId: p.cliTokenId, totalOperationCount: args.facts.length,
      ...(p.agentId ? { agentId: p.agentId } : {}),
    });
    const store = convexLedgerStore(ctx);
    const ownership = await orgOwnership(ctx, orgId);
    const rules = await orgRules(ctx, orgId);
    // Who the batch writes as (CP14): an agent's principals (its owner, and the person who started its run), or the token's user.
    const principals = await principalAccess(ctx, orgId, args.attribution.kind === "agent"
      ? agentPrincipals({ ownerUserId: args.attribution.agent.ownerUserId, startedBy: args.attribution.triggeredBy })
      : [args.attribution.userId]);
    if (!principals) throw new ConvexError("The person this batch writes for is no longer a member of this workspace");
    const admitted = new Set(args.admitted);
    const rejected: Array<{ index: number; attribute: string; reason: TargetMiss | "unknown_attribute" | "not_owned" | "invalid_value" | "field_locked" }> = [];
    let proposed = 0, unchanged = 0, toVerify = 0;
    const readScores: Array<{ factId: Id<"facts">; score: number }> = [];
    const customOf = new Map<"account" | "contact", Set<string>>();
    const knownCustom = async (entityType: "account" | "contact", attribute: string) => {
      if (!customOf.has(entityType)) customOf.set(entityType, await customAttributesOf(ctx, orgId, entityType, args.facts.filter((f) => f.entityType === entityType).map((f) => f.attribute)));
      return customOf.get(entityType)!.has(attribute);
    };
    for (const [index, f] of args.facts.entries()) {
      const entityType = f.entityType ?? "opportunity";
      if (!isScalarProposalAttribute(entityType, f.attribute) || (args.knownCustomOnly && entityType !== "opportunity" && CUSTOM_ATTRIBUTE.test(f.attribute) && !(await knownCustom(entityType, f.attribute)))) {
        rejected.push({ index, attribute: f.attribute, reason: "unknown_attribute" });
        continue;
      }
      // A field a principal's role may only read, or not see, is not theirs to write, nor their agent's.
      if (!principals.every((a) => mayWriteField(a, entityType === "opportunity" ? "deal" : entityType, f.attribute))) { rejected.push({ index, attribute: f.attribute, reason: "field_locked" }); continue; }
      const target = await findTarget(ctx, store, orgId, f);
      if (typeof target === "string") { rejected.push({ index, attribute: f.attribute, reason: target }); continue; }
      const { entityId, deal } = target;
      // A record a principal cannot see reads as missing (CP14), so a proposal cannot probe for it.
      const entity = await ctx.db.get(entityId as Id<"canonEntities">);
      if (!entity || !sightAdmits(await entitySight(ctx, principals, entity), admitted)) {
        rejected.push({ index, attribute: f.attribute, reason: entityType === "opportunity" ? "unknown_deal" : entityType === "account" ? "unknown_account" : "unknown_contact" });
        continue;
      }
      const normalized = await normalizeProposal(ctx, orgId, entityType, f.attribute, f.value);
      if (!normalized.ok) { rejected.push({ index, attribute: f.attribute, reason: "invalid_value" }); continue; }
      const value = normalized.value;
      // A CRM sync's queued mirror lands first, so the before-value is the record's current one (canon.ts flushPartyMirror).
      await flushPartyMirror(ctx, entityId);
      const before = await ctx.db.query("canonFieldState")
        .withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId as Id<"canonEntities">).eq("attribute", f.attribute)).first();
      const evidence = f.evidence?.slice(0, 4000);
      const result = await ingestObservations(store, {
        orgId, entityId, entityType, sourceKind: args.sourceKind, sourceRefBase: proposalSourceRefBase(args.sourceKind, p, target.objectKey),
        actor: p.actor, observedAt: now, patchPlanId, ownership,
        observations: [{ attribute: f.attribute, value, evidence, validFrom: f.validFrom, confidence: Math.min(1, Math.max(0, f.confidence ?? 0.5)) }],
      });
      if (result.rejected.length) { rejected.push({ index, attribute: f.attribute, reason: "not_owned" }); continue; }
      const factId = result.factIds[f.attribute];
      if (!factId) { unchanged++; continue; } // the same namespace already proposed this value with this evidence
      proposed++;
      await mirrorGateProposal(ctx, factId, ownership);
      const read = args.reads?.[index];
      if (typeof read === "number" && Number.isFinite(read)) readScores.push({ factId: factId as Id<"facts">, score: Math.min(1, Math.max(0, read)) });
      else if (needsVerification({ sourceKind: args.sourceKind, attribute: f.attribute, evidence, entityType, sourceRef: proposalSourceRefBase(args.sourceKind, p, target.objectKey) + ":" }, rules)) toVerify++;
      await ctx.db.insert("patchOperations", {
        orgId, patchPlanId, objectType: entityType, objectId: target.objectKey, fieldOrAction: f.attribute,
        beforeValue: before?.value ?? (deal ? ((deal as Record<string, unknown>)[f.attribute] ?? null) : null), afterValue: value,
        reason: evidence, sourceRuleOrPolicy: `${args.sourceKind}:${p.refKey}`, riskLevel: "medium", approvalRequirement: "required",
        status: "pending", packageOpId: factId, createdAt: now, updatedAt: now,
      });
    }
    await ctx.db.patch(patchPlanId, { storedOperationCount: proposed, ...(proposed ? {} : { status: "rejected" as const, error: "No facts were proposed" }) });
    if (readScores.length) await applyScores(ctx, patchPlanId, readScores, "read");
    if (toVerify) await ctx.scheduler.runAfter(0, internal.canonGate.verifyProposals, { patchPlanId });
    return { patchPlanId, proposed, unchanged, rejected, verifying: toVerify };
  }
}

export const verificationCandidates = internalQuery({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan) return [];
    const rules = await orgRules(ctx, plan.orgId);
    const facts = await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId)).take(MAX_FACTS_PER_BATCH);
    const out = [];
    for (const f of facts) {
      if (f.status !== "proposed" || f.verification || !needsVerification(f, rules)) continue;
      out.push({ factId: f._id, entityType: f.entityType, attribute: f.attribute, value: f.value, evidence: f.evidence ?? "", field: await customField(ctx, plan.orgId, f) });
    }
    return out;
  },
});

/**
 * What an AI field's answer means, for Jev: the field's question, and for a
 * classify field the chosen option's label and description. A slug like
 * `locations` or an option key like `a` alone can't be checked.
 */
async function customField(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, f: Doc<"facts">) {
  if (!f.attribute.startsWith("custom.")) return null;
  const agent = await ctx.db.query("researchAgents")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", f.attribute.slice("custom.".length))).unique();
  if (!agent || agent.entityType !== f.entityType) return null;
  const option = agent.kind === "classify" ? agent.options?.find((o) => o.key === f.value) : undefined;
  return {
    question: agent.question,
    ...(option ? { meaning: option.description ? `${option.label}: ${option.description}` : option.label } : {}),
  };
}

/** Jev checks each candidate's value against its evidence; scores feed the auto-accept rules. */
export const verifyProposals = internalAction({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const candidates = await ctx.runQuery(internal.canonGate.verificationCandidates, args);
    if (!candidates.length) return { verified: 0 };
    const key = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
    if (!key) return { verified: 0, skipped: "JEV_API_KEY is not set; facts stay proposed" };
    const ask = jevAsk(key);
    const scores: Array<{ factId: Id<"facts">; score: number }> = [];
    for (const c of candidates) {
      try {
        const label = attributeLabel(c.entityType, c.attribute);
        const noun = ENTITY_NOUN[c.entityType];
        const claim = c.field
          ? { question: c.field.question, answer: c.field.meaning ?? c.value }
          : { field: label, value: c.value };
        const instructions = c.field
          ? `Does the text in \`evidence\` directly state or clearly imply that \`claim.answer\` is the answer to \`claim.question\` for this ${noun}?`
          : `Does the text in \`evidence\` directly state or clearly imply that the ${label} of this ${noun} is the value in \`claim.value\`?`;
        const answers = await ask({ evidence: c.evidence.slice(0, 4000), claim }, {
          supported: {
            type: "noul",
            instructions,
            criteria: { true: "The evidence states or clearly implies this value.", false: "The evidence is silent, ambiguous, or says otherwise." },
          },
        }, 120 + Math.ceil(c.evidence.length / 3));
        scores.push({ factId: c.factId, score: answers.supported ?? 0 });
      } catch {
        // An unchecked fact stays proposed for a person.
      }
    }
    if (scores.length) await ctx.runMutation(internal.canonGate.applyVerification, { patchPlanId: args.patchPlanId, scores });
    return { verified: scores.length };
  },
});

export const applyVerification = internalMutation({
  args: { patchPlanId: v.id("patchPlans"), scores: v.array(v.object({ factId: v.id("facts"), score: v.number() })) },
  handler: (ctx, args) => applyScores(ctx, args.patchPlanId, args.scores, "evidence"),
});

/**
 * Record each fact's Jev score and auto-accept those an enabled rule's threshold admits. `kind`:
 * "evidence" is Jev's check of the value against its evidence; "read" is Jev's own read of the record,
 * which an inferred answer carries instead (submitProposalBatch `reads`).
 */
async function applyScores(ctx: MutationCtx, patchPlanId: Id<"patchPlans">, scores: ReadonlyArray<{ factId: Id<"facts">; score: number }>, kind: "evidence" | "read") {
  const plan = await ctx.db.get(patchPlanId);
  if (!plan) return { accepted: 0 };
  const now = Date.now();
  const rules = await orgRules(ctx, plan.orgId);
  const decisions: Array<{ factId: string; status: "accepted" }> = [];
  for (const s of scores) {
    const fact = await ctx.db.get(s.factId);
    if (!fact || fact.status !== "proposed" || fact.patchPlanId !== patchPlanId) continue;
    await ctx.db.patch(fact._id, { verification: { score: s.score, model: JEV_MODEL, checkedAt: now, kind } });
    const d = autoAcceptDecision(fact, rules, s.score);
    if (d.accept) decisions.push({ factId: fact._id, status: "accepted" });
  }
  if (!decisions.length) return { accepted: 0 };
  const decider = { kind: "rule", rule: "auto_accept+jev" } as const;
  const out = await decideFacts(convexLedgerStore(ctx), { orgId: plan.orgId, decisions, decider, at: now });
  await mirrorDecidedFacts(ctx, out.decided, decider, now);
  await settlePlan(ctx, patchPlanId, undefined, now);
  return { accepted: out.decided.length };
}

/** Facts one reapply step reads. */
const REAPPLY_PAGE = 100;

/**
 * A rule's threshold was lowered or turned on: accept the attribute's facts still waiting for review
 * whose stored Jev score now clears it, oldest first, a page per step. Facts never scored stay as they
 * are. Raising a threshold applies to new facts only: an accepted fact is not reopened.
 */
export const reapplyRule = internalMutation({
  args: {
    orgId: v.id("organizations"), sourceKind: agentSource, attribute: v.string(), entityType: entityTypeValidator,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const rules = await orgRules(ctx, args.orgId);
    const page = await ctx.db.query("facts")
      .withIndex("by_orgId_attribute_observedAt", (q) => q.eq("orgId", args.orgId).eq("attribute", args.attribute))
      .paginate({ numItems: REAPPLY_PAGE, cursor: args.cursor ?? null });
    const decisions: Array<{ factId: string; status: "accepted" }> = [];
    for (const f of page.page) {
      if (f.status !== "proposed" || f.sourceKind !== args.sourceKind || f.entityType !== args.entityType || !f.verification) continue;
      if (autoAcceptDecision(f, rules, f.verification.score).accept) decisions.push({ factId: f._id, status: "accepted" });
    }
    if (decisions.length) {
      const now = Date.now();
      const decider = { kind: "rule", rule: "auto_accept+jev" } as const;
      const out = await decideFacts(convexLedgerStore(ctx), { orgId: args.orgId, decisions, decider, at: now });
      await mirrorDecidedFacts(ctx, out.decided, decider, now);
      const plans = new Set(out.decided.map((f) => f.patchPlanId).filter((id): id is string => !!id));
      for (const id of plans) await settlePlan(ctx, id as Id<"patchPlans">, undefined, now);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.canonGate.reapplyRule, { ...args, cursor: page.continueCursor });
    return { accepted: decisions.length };
  },
});

/** After a rule is saved: re-apply it to the attribute's waiting facts when it is on. */
export async function scheduleReapply(ctx: MutationCtx, orgId: Id<"organizations">, sourceKind: (typeof AGENT_SOURCES)[number], attribute: string, entityType: "opportunity" | "account" | "contact", enabled: boolean) {
  if (enabled) await ctx.scheduler.runAfter(0, internal.canonGate.reapplyRule, { orgId, sourceKind, attribute, entityType });
}

async function requireReviewer(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!can(user, "facts.review")) throw new ConvexError(refusal("facts.review"));
  return user;
}

const decisionsArg = v.array(v.object({ factId: v.id("facts"), status: v.union(v.literal("accepted"), v.literal("rejected")) }));

/**
 * The reviewer's judgment of the facts they decide (CP14): each fact's record
 * must be one their role sees (sightJudge; a company or person only an action
 * can judge must be `admitted`), and its field not hidden from them. Accepting
 * writes the field, so it must also be a field they may edit. A fact they may
 * not see reads as missing.
 */
async function judgeDecisions(ctx: MutationCtx, user: Doc<"users">, decisions: ReadonlyArray<{ factId: Id<"facts">; status: "accepted" | "rejected" }>, admitted: ReadonlySet<string>) {
  const access = await accessFor(ctx, user);
  const judge = sightJudge(ctx, [access], admitted);
  for (const d of decisions) {
    const fact = await ctx.db.get(d.factId);
    const entity = fact && fact.orgId === user.orgId ? await ctx.db.get(fact.entityId) : null;
    if (!fact || !entity) continue; // decideFacts skips a missing fact
    const object = entity.entityType === "opportunity" ? "deal" : entity.entityType;
    if (hiddenFields(access, object).includes(fact.attribute) || !(await judge.entity(entity))) throw new ConvexError("Fact not found");
    if (d.status === "accepted" && !mayWriteField(access, object, fact.attribute)) throw new ConvexError(`${fact.attribute} is read-only for your role`);
  }
}

async function decideAs(ctx: MutationCtx, decisions: ReadonlyArray<{ factId: Id<"facts">; status: "accepted" | "rejected" }>, admitted: ReadonlySet<string>) {
  const user = await requireReviewer(ctx);
  if (decisions.length > QUEUE_LIMIT) throw new ConvexError(`Decide at most ${QUEUE_LIMIT} facts at a time`);
  await judgeDecisions(ctx, user, decisions, admitted);
  const now = Date.now();
  const decider = { kind: "user", userId: user._id } as const;
  const out = await decideFacts(convexLedgerStore(ctx), { orgId: user.orgId, decisions: [...decisions], decider, at: now });
  await mirrorDecidedFacts(ctx, out.decided, decider, now);
  const plans = new Set(out.decided.map((f) => f.patchPlanId).filter((id): id is string => Boolean(id)));
  for (const planId of plans) await settlePlan(ctx, planId as Id<"patchPlans">, user._id, now);
  return { decided: out.decided.length, skipped: out.skipped.length };
}

/**
 * A person's decision on proposed facts (any batches). Accepted facts become
 * canonical at once. A role that sees only some companies or people decides
 * facts on them through decideScoped, which admits them first.
 */
export const decide = mutation({
  args: { decisions: decisionsArg },
  handler: (ctx, args) => decideAs(ctx, args.decisions, new Set()),
});

/** The companies and people behind some facts that the signed-in reviewer's query cannot judge, for an action to admit. */
export const factSights = internalQuery({
  args: { factIds: v.array(v.id("facts")) },
  handler: async (ctx, args): Promise<PendingSight[]> => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const judge = sightJudge(ctx, [await accessFor(ctx, user)]);
    for (const id of args.factIds.slice(0, QUEUE_LIMIT)) {
      const fact = await ctx.db.get(id);
      if (fact && fact.orgId === user.orgId) await judge.entity(await ctx.db.get(fact.entityId));
    }
    return judge.pending;
  },
});

/** The record-service ids of `factIds`' companies and people the caller sees, admitted through their scoped client. */
async function admitFacts(ctx: ActionCtx, factIds: Id<"facts">[]): Promise<string[]> {
  const caller = await requireCaller(ctx);
  return admitThenRead(callerClient(ctx, caller), caller.orgId, async (admitted) =>
    admitted.length ? { pending: [], value: admitted } : { pending: await ctx.runQuery(internal.canonGate.factSights, { factIds }), value: [] });
}

export const decideAdmitted = internalMutation({
  args: { decisions: decisionsArg, admitted: v.array(v.string()) },
  handler: (ctx, args) => decideAs(ctx, args.decisions, new Set(args.admitted)),
});

/** `decide` for a reviewer who sees only some companies or people: the facts' records are admitted through their scoped client. */
export const decideScoped = action({
  args: { decisions: decisionsArg },
  handler: async (ctx, args): Promise<{ decided: number; skipped: number }> => {
    const admitted = await admitFacts(ctx, args.decisions.map((d) => d.factId));
    return ctx.runMutation(internal.canonGate.decideAdmitted, { decisions: args.decisions, admitted });
  },
});

/** Settle a contested field: the reviewer picks one fact's value, recorded as a user fact. */
export const resolveContested = mutation({
  args: { factId: v.id("facts") },
  handler: (ctx, args) => resolveAs(ctx, args.factId, new Set()),
});

export const resolveAdmitted = internalMutation({
  args: { factId: v.id("facts"), admitted: v.array(v.string()) },
  handler: (ctx, args) => resolveAs(ctx, args.factId, new Set(args.admitted)),
});

/** `resolveContested` for a reviewer who sees only some companies or people. */
export const resolveContestedScoped = action({
  args: { factId: v.id("facts") },
  handler: async (ctx, args): Promise<unknown> => {
    const admitted = await admitFacts(ctx, [args.factId]);
    return ctx.runMutation(internal.canonGate.resolveAdmitted, { factId: args.factId, admitted });
  },
});

async function resolveAs(ctx: MutationCtx, factId: Id<"facts">, admitted: ReadonlySet<string>) {
  {
    const user = await requireReviewer(ctx);
    const fact = await ctx.db.get(factId);
    if (!fact || fact.orgId !== user.orgId || fact.status !== "accepted") throw new ConvexError("Fact not found");
    const entity = await ctx.db.get(fact.entityId);
    if (!entity || !isFactEntity(entity)) throw new ConvexError("Fact not found");
    await judgeDecisions(ctx, user, [{ factId: fact._id, status: "accepted" }], admitted);
    const evidence = `chose fact ${fact._id} (${fact.sourceKind})`;
    if (entity.projectionTable === "deals") {
      const dealId = ctx.db.normalizeId("deals", entity.projectionId);
      const deal = dealId ? await ctx.db.get(dealId) : null;
      if (!deal) throw new ConvexError("Fact not found");
      const out = await saveDealValues(ctx, deal, { kind: "user", userId: user._id }, { [fact.attribute]: fact.value }, { evidence });
      return out.resolved[fact.attribute] ?? (await factResolution(ctx, entity._id, fact.attribute));
    }
    if (entity.entityType === "opportunity") throw new ConvexError("Fact not found");
    const out = await saveParty(ctx, {
      orgId: user.orgId, object: entity.entityType, identity: { entityId: entity._id }, source: { kind: "user", userId: user._id },
      values: { [fact.attribute]: fact.value }, evidence,
    });
    const refused = out.rejected.find((e) => e.field === fact.attribute);
    if (refused) throw new ConvexError(`Could not use this value: ${refused.message}`);
    return out.resolved[fact.attribute] ?? (await factResolution(ctx, entity._id, fact.attribute));
  }
}

/** Entities the `facts` ledger tracks; object-layer records (convex/objects.ts) have their own ledger. */
const isFactEntity = (e: Doc<"canonEntities">): e is Doc<"canonEntities"> & { entityType: EntityType } =>
  (ENTITY_TYPES as readonly string[]).includes(e.entityType);

/** What a fact is about, for the queue: its type, a display name, and the deal id for deals. */
export async function entityInfo(ctx: { db: QueryCtx["db"] }, entityId: Id<"canonEntities">) {
  const entity = await ctx.db.get(entityId);
  if (!entity || !isFactEntity(entity)) return { entityId, entityType: "opportunity" as EntityType, label: "(deleted)", dealId: null };
  let label = entity.label;
  let dealId: Id<"deals"> | null = null;
  if (entity.projectionTable === "deals") {
    const id = ctx.db.normalizeId("deals", entity.projectionId);
    const deal = id ? await ctx.db.get(id) : null;
    dealId = deal?._id ?? null;
    label = deal?.name ?? "(deleted deal)";
  } else if (entity.projectionTable === "crmAccounts") {
    const id = ctx.db.normalizeId("crmAccounts", entity.projectionId);
    label = (id ? (await ctx.db.get(id))?.name : undefined) ?? label;
  }
  return { entityId: entity._id, entityType: entity.entityType, label: label ?? `(unnamed ${ENTITY_NOUN[entity.entityType]})`, dealId };
}

/**
 * Whether a fact about `entity`'s `attribute` may be shown to `accesses`
 * (CP14): every one of them sees the record (querySees) and none has the
 * field hidden. `admitted`: record-service ids an action admitted.
 */
async function showsFact(ctx: QueryCtx, accesses: readonly Access[], entity: Doc<"canonEntities"> | null, attribute: string, admitted?: ReadonlySet<string>) {
  if (!entity) return false;
  const object = entity.entityType === "opportunity" ? "deal" : entity.entityType;
  if (accesses.some((a) => hiddenFields(a, object).includes(attribute))) return false;
  return querySees(ctx, accesses, entity, admitted);
}

/** showsFact over many facts (sightJudge): what it could not judge is in `pending`, for an action twin to admit. */
export function factJudge(ctx: QueryCtx, accesses: readonly Access[], admitted: ReadonlySet<string>) {
  const judge = sightJudge(ctx, accesses, admitted);
  return {
    pending: judge.pending,
    shows: async (entity: Doc<"canonEntities"> | null, attribute: string) => {
      if (!entity) return false;
      const object = entity.entityType === "opportunity" ? "deal" : entity.entityType;
      return !accesses.some((a) => hiddenFields(a, object).includes(attribute)) && judge.entity(entity);
    },
  };
}

/** A query's answer from a judged read: null when some record needs its action twin (permissions.sightJudge). */
const liveOrNull = <T,>(r: { pending: readonly unknown[]; value: T }) => (r.pending.length ? null : r.value);

/**
 * The review queue: proposed facts (newest first) and contested fields, on
 * the records and fields the caller sees. Null for a role that sees only some
 * companies or people while any row is one of them: reviewQueueScoped admits
 * them through the caller's scoped client.
 */
export const reviewQueue = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return liveOrNull(await reviewQueueAs(ctx, user, [await accessFor(ctx, user)], new Set()));
  },
});

export const reviewQueueFor = internalQuery({
  args: { admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? reviewQueueAs(ctx, user, [await accessFor(ctx, user)], new Set(args.admitted)) : { pending: [], value: null };
  },
});

type ReviewQueue = NonNullable<Awaited<ReturnType<typeof reviewQueueAs>>["value"]>;

/** The review queue for a role that sees only some companies or people (CP14). */
export const reviewQueueScoped = action({
  args: {},
  handler: async (ctx): Promise<ReviewQueue | null> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.canonGate.reviewQueueFor, { admitted }));
  },
});

async function reviewQueueAs(ctx: QueryCtx, user: Doc<"users">, access: readonly Access[], admitted: ReadonlySet<string>) {
  {
    const judge = factJudge(ctx, access, admitted);
    const proposedRows = await ctx.db.query("facts").withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", "proposed")).order("desc").take(QUEUE_LIMIT);
    const actors: ActorCache = new Map();
    const proposed = [];
    for (const f of proposedRows) {
      if (!(await judge.shows(await ctx.db.get(f.entityId), f.attribute))) continue;
      const info = await entityInfo(ctx, f.entityId);
      const state = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", f.entityId).eq("attribute", f.attribute)).first();
      proposed.push({
        factId: f._id, entityId: info.entityId, entityType: info.entityType, label: info.label,
        dealId: info.dealId, dealName: info.label, attribute: f.attribute,
        value: f.value, currentValue: state?.value ?? null, sourceKind: f.sourceKind, actor: await describeActor(ctx, f, actors),
        evidence: f.evidence ?? null, confidence: f.confidence, verification: f.verification ?? null,
        observedAt: f.observedAt, patchPlanId: f.patchPlanId ?? null,
      });
    }
    const contestedRows = await ctx.db.query("canonFieldState").withIndex("by_orgId_state", (q) => q.eq("orgId", user.orgId).eq("state", "contested")).take(100);
    const contested = [];
    for (const s of contestedRows) {
      if (!(await judge.shows(await ctx.db.get(s.entityId), s.attribute))) continue;
      const info = await entityInfo(ctx, s.entityId);
      const ids = [s.factId, ...(s.contestedBy ?? [])].filter((id): id is Id<"facts"> => id !== null);
      const options = [];
      for (const id of ids) {
        const f = await ctx.db.get(id);
        if (f) options.push({ factId: f._id, value: f.value, sourceKind: f.sourceKind, observedAt: f.observedAt, validFrom: f.validFrom ?? null, winner: id === s.factId });
      }
      contested.push({
        entityId: info.entityId, entityType: info.entityType, label: info.label,
        dealId: info.dealId, dealName: info.label, attribute: s.attribute, value: s.value, options,
      });
    }
    return { pending: judge.pending, value: { proposed, contested, canReview: can(user, "facts.review") } };
  }
}

/** One field's resolved state and its newest `take` facts (the receipt drawer reads 50): `confirmedAt` is the winner's last confirmation. */
async function receipts(ctx: QueryCtx, entityId: Id<"canonEntities">, attribute: string, take = 50) {
  const state = await ctx.db.query("canonFieldState").withIndex("by_entityId_attribute", (q) => q.eq("entityId", entityId).eq("attribute", attribute)).first();
  const facts = take ? await ctx.db.query("facts").withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", entityId).eq("attribute", attribute)).order("desc").take(take) : [];
  const winner = state?.factId ? (facts.find((f) => f._id === state.factId) ?? await ctx.db.get(state.factId)) : null;
  const actors: ActorCache = new Map();
  const described = await Promise.all(facts.map((f) => describeActor(ctx, f, actors)));
  return {
    state: state ? { value: state.value, state: state.state, factId: state.factId, sourceKind: state.sourceKind, contestedBy: state.contestedBy ?? [], confirmedAt: winner?.lastConfirmedAt ?? null } : null,
    facts: facts.map((f, i) => ({
      factId: f._id, value: f.value, status: f.status, sourceKind: f.sourceKind, sourceRef: f.sourceRef, actor: described[i],
      evidence: f.evidence ?? null, confidence: f.confidence, verification: f.verification ?? null, patchPlanId: f.patchPlanId ?? null,
      observedAt: f.observedAt, validFrom: f.validFrom ?? null, validTo: f.validTo ?? null, lastConfirmedAt: f.lastConfirmedAt,
      decidedBy: f.decidedBy ?? null, decider: f.decider || f.decidedBy ? deciderOf(f) : null, decidedAt: f.decidedAt ?? null,
    })),
  };
}

/** The receipt drawer: every fact behind one field of one deal, newest first. */
export const fieldReceipts = query({
  args: { dealId: v.id("deals"), attribute: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const deal = await ctx.db.get(args.dealId);
    if (!user || !deal || deal.orgId !== user.orgId) return null;
    const access = await accessFor(ctx, user);
    if (!dealVisible(access, deal) || hiddenFields(access, "deal").includes(args.attribute)) return null;
    const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", deal.orgId).eq("projectionId", deal._id)).first();
    if (!entity) return { state: null, facts: [] };
    return receipts(ctx, entity._id, args.attribute);
  },
});

/** Every fact behind one field of any entity (deal, account or contact), newest first: null for a record or field the caller does not see. */
export const entityReceipts = query({
  args: { entityId: v.id("canonEntities"), attribute: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? liveOrNull(await entityReceiptsAs(ctx, user.orgId, [await accessFor(ctx, user)], args, new Set())) : null;
  },
});

async function entityReceiptsAs(ctx: QueryCtx, orgId: Id<"organizations">, accesses: readonly Access[], args: { entityId: Id<"canonEntities">; attribute: string }, admitted: ReadonlySet<string>) {
  const judge = factJudge(ctx, accesses, admitted);
  const entity = await ctx.db.get(args.entityId);
  const shown = entity !== null && entity.orgId === orgId && (await judge.shows(entity, args.attribute));
  return { pending: judge.pending, value: shown ? await receipts(ctx, args.entityId, args.attribute) : null };
}

export const entityReceiptsAdmitted = internalQuery({
  args: { entityId: v.id("canonEntities"), attribute: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, { admitted, ...args }) => {
    const user = await getCurrentUser(ctx);
    return user ? entityReceiptsAs(ctx, user.orgId, [await accessFor(ctx, user)], args, new Set(admitted)) : { pending: [], value: null };
  },
});

/** entityReceipts for a role that sees only some companies or people (CP14): the record is admitted through the caller's scoped client. */
export const entityReceiptsScoped = action({
  args: { entityId: v.id("canonEntities"), attribute: v.string() },
  handler: async (ctx, args): Promise<Awaited<ReturnType<typeof receipts>> | null> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.canonGate.entityReceiptsAdmitted, { ...args, admitted }));
  },
});

/** entityReceipts for an action that admitted the record through the caller's scoped client (Ask Canon). */
export const entityReceiptsFor = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()), entityId: v.id("canonEntities"), attribute: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const entity = await ctx.db.get(args.entityId);
    if (!entity || entity.orgId !== args.orgId || !(await showsFact(ctx, args.accesses as Access[], entity, args.attribute, new Set(args.admitted)))) return null;
    return receipts(ctx, entity._id, args.attribute);
  },
});

/** For a fact a module proposed, the module in its source and the proposal it came in (docs/modules.md, "Proposing facts"). */
const moduleSource = (f: { sourceKind: string; sourceRef: string; patchPlanId: string | null; actor: Awaited<ReturnType<typeof describeActor>> }) => {
  const proposer = moduleOfSourceRef(f.sourceRef);
  return { source: { kind: f.sourceKind, actor: actorRef(f.actor), ...(proposer ? { module: proposer } : {}) }, ...(proposer && f.patchPlanId ? { proposal: f.patchPlanId } : {}) };
};
/** A ledger value as a module reads it: one value. Structured ones (deal splits) are refused when the read is planned. */
const oneValue = (v: Doc<"facts">["value"]): FactValue => (v !== null && typeof v === "object" ? null : v);
const FACT_ENTITY_TYPES = { deals: "opportunity", companies: "account", people: "contact" } as const satisfies Record<FactObject, EntityType>;

/** A fact's actor as a stable reference: `user:<member id>`, `agent:<agent id>`, `integration:<id>`, or a legacy label. */
const actorRef = (a: Awaited<ReturnType<typeof describeActor>>) =>
  a.kind === "user" ? `user:${a.userId}` : a.kind === "agent" ? `agent:${a.agentId}` : a.kind === "integration" ? `integration:${a.id}` : `legacy:${a.label}`;

/**
 * A module's `facts.forRecords` (docs/modules.md, "Facts"): each record's fields as the receipt drawer reads them
 * (receipts) for a member who sees them (showsFact), with the companies and people the call's action admitted through
 * their scoped client. A record they don't see has no row; a field hidden from them has no field. A company or person
 * they see (admitted) that isn't on the ledger yet has its fields `empty`, and a `custom.<slug>` the workspace has no
 * field for is `unknown`.
 */
export const factsForRecords = internalQuery({
  // Access objects as lib/access.ts accessOf builds them; internal callers only.
  args: {
    orgId: v.id("organizations"), accesses: v.array(v.any()), object: v.union(...FACT_OBJECTS.map((o) => v.literal(o))),
    ids: v.array(v.string()), attributes: v.array(v.string()), receipts: v.number(), admitted: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<FactsForRecordsRow[]> => {
    const accesses = args.accesses as Access[], admitted = new Set(args.admitted), entityType = FACT_ENTITY_TYPES[args.object];
    const take = Math.min(Math.max(0, Math.floor(args.receipts)), FACTS_MAX_RECEIPTS);
    const rows: FactsForRecordsRow[] = [];
    const custom = entityType === "opportunity" ? new Set<string>() : await customAttributesOf(ctx, args.orgId, entityType, args.attributes);
    const known = (a: string) => (CUSTOM_ATTRIBUTE.test(a) ? custom.has(a) : CORE_ATTRIBUTES[entityType].includes(a));
    const object = entityType === "opportunity" ? "deal" : entityType;
    const unhidden = args.attributes.filter((a) => !accesses.some((x) => hiddenFields(x, object).includes(a)));
    const none = (attribute: string): ResolvedField => ({ attribute, value: null, state: known(attribute) ? "empty" : "unknown", winner: null });
    for (const id of args.ids.slice(0, FACTS_MAX_IDS)) {
      // A deal by its row, as the receipt drawer finds it; a company or person by its record-service id, as a proposal does.
      // Only an entity of the object asked for: a company's id read as a deal must not reach the company's facts.
      const entity = entityType === "opportunity"
        ? (await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", id)).take(10)).find((e) => e.entityType === "opportunity" && e.projectionTable === "deals") ?? null
        : await findCanonEntity(ctx, args.orgId, entityType, { entityType, recordId: id, attribute: "", value: null });
      // Admitted means the caller's scoped client read the record, so saying it has no facts yet reveals nothing.
      if (!entity && entityType !== "opportunity" && admitted.has(id)) {
        rows.push({ id, fields: unhidden.map(none), ...(take ? { receipts: Object.fromEntries(unhidden.map((a) => [a, []])) } : {}) });
        continue;
      }
      if (!entity || !(await querySees(ctx, accesses, entity, admitted))) continue;
      const fields: ResolvedField[] = [];
      const byAttribute: Record<string, FactReceipt[]> = {};
      for (const attribute of args.attributes) {
        if (!(await showsFact(ctx, accesses, entity, attribute, admitted))) continue;
        if (!known(attribute)) { fields.push(none(attribute)); if (take) byAttribute[attribute] = []; continue; }
        const { state, facts } = await receipts(ctx, entity._id, attribute, take);
        fields.push({
          attribute, value: oneValue(state?.value ?? null), state: state?.state ?? "empty", winner: state?.factId ?? null,
          ...(state?.contestedBy.length ? { contestedBy: state.contestedBy } : {}),
          ...(state?.confirmedAt != null ? { confirmedAt: state.confirmedAt } : {}),
        });
        if (take) byAttribute[attribute] = facts.map((f) => ({
          id: f.factId, value: oneValue(f.value), status: f.status, ...moduleSource(f),
          evidence: f.evidence, confidence: f.confidence, observedAt: f.observedAt, validFrom: f.validFrom,
          lastConfirmedAt: f.lastConfirmedAt, validTo: f.validTo, decidedAt: f.decidedAt,
        }));
      }
      rows.push({ id, fields, ...(take ? { receipts: byAttribute } : {}) });
    }
    return rows;
  },
});

/** Write-gate settings: the ownership grid (defaults + overrides), auto-accept rules, and approval history per cell. */
export const settings = query({
  args: { entityType: v.optional(entityTypeValidator) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const entityType = args.entityType ?? "opportunity";
    const ownership = await orgOwnership(ctx, user.orgId);
    const rules = await orgRules(ctx, user.orgId);
    // Calibration data: how people decided each (source, attribute) so far (bounded sample).
    const history: Record<string, { accepted: number; rejected: number }> = {};
    for (const status of ["accepted", "rejected"] as const) {
      const rows = await ctx.db.query("facts").withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", status)).order("desc").take(1000);
      for (const f of rows) {
        if (deciderOf(f).kind !== "user" || f.entityType !== entityType) continue;
        const k = `${f.sourceKind}:${f.attribute}`;
        history[k] ??= { accepted: 0, rejected: 0 };
        history[k][status]++;
      }
    }
    const attributes = CORE_ATTRIBUTES[entityType].filter((attribute) => isScalarProposalAttribute(entityType, attribute));
    return {
      entityType, attributes, grid: ownershipGrid(attributes, ownership, entityType),
      rules: rules.filter((r) => (r.entityType ?? "opportunity") === entityType), history, canEdit: can(user, "writeGate.edit"),
    };
  },
});

async function requireAdmin(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  if (!can(user, "writeGate.edit")) throw new ConvexError(refusal("writeGate.edit"));
  return user;
}

/** Stored rules leave entityType unset for deals, as rules written before accounts and contacts did. */
const sameCell = (r: { sourceKind: string; attribute: string; entityType?: EntityType }, k: string, a: string, t: EntityType) =>
  r.sourceKind === k && r.attribute === a && (r.entityType ?? "opportunity") === t;
const storedType = (t: EntityType) => (t === "opportunity" ? {} : { entityType: t });

export const setOwnership = mutation({
  args: { sourceKind: sourceKindValidator, attribute: v.string(), allowed: v.union(v.boolean(), v.null()), entityType: v.optional(entityTypeValidator) },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const entityType = args.entityType ?? "opportunity";
    if (!isScalarProposalAttribute(entityType, args.attribute)) throw new ConvexError("Unknown attribute");
    const rows = await ctx.db.query("canonFieldOwnership").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    const existing = rows.find((r) => sameCell(r, args.sourceKind, args.attribute, entityType));
    if (args.allowed === null) { if (existing) await ctx.db.delete(existing._id); return null; } // back to the default
    const doc = { orgId: user.orgId, sourceKind: args.sourceKind, attribute: args.attribute, allowed: args.allowed, ...storedType(entityType), updatedBy: user._id, updatedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("canonFieldOwnership", doc);
    return null;
  },
});

export const setAutoAcceptRule = mutation({
  args: { sourceKind: agentSource, attribute: v.string(), minConfidence: v.number(), enabled: v.boolean(), entityType: v.optional(entityTypeValidator) },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx);
    const entityType = args.entityType ?? "opportunity";
    if (!isScalarProposalAttribute(entityType, args.attribute)) throw new ConvexError("Unknown attribute");
    if (!(args.minConfidence >= 0.5 && args.minConfidence <= 1)) throw new ConvexError("The threshold must be between 0.5 and 1");
    const rows = await ctx.db.query("canonAutoAcceptRules").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    const existing = rows.find((r) => sameCell(r, args.sourceKind, args.attribute, entityType));
    const doc = {
      orgId: user.orgId, sourceKind: args.sourceKind, attribute: args.attribute, minConfidence: args.minConfidence, enabled: args.enabled,
      ...storedType(entityType), updatedBy: user._id, updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, doc);
    else await ctx.db.insert("canonAutoAcceptRules", doc);
    await scheduleReapply(ctx, user.orgId, args.sourceKind, args.attribute, entityType, args.enabled);
    return null;
  },
});

/** Batch status for the CLI/MCP: how many facts are still proposed, accepted, rejected. */
/** A batch's status for a CLI token's user (canonGateActions.status). */
export const batchStatus = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users"), patchPlanId: v.string(), admitted: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const accesses = await principalAccess(ctx, args.orgId, [args.userId]);
    if (!accesses) return { accesses: null, pending: [], value: null };
    return { accesses, ...(await proposalBatchStatus(ctx, { orgId: args.orgId, patchPlanId: args.patchPlanId, accesses }, new Set(args.admitted))) };
  },
});

/** A proposal batch's status for the signed-in user's org; null while it holds a company or person only myBatchStatusScoped can judge for them. */
export const myBatchStatus = query({
  args: { patchPlanId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? liveOrNull(await proposalBatchStatus(ctx, { orgId: user.orgId, patchPlanId: args.patchPlanId, accesses: [await accessFor(ctx, user)] }, new Set())) : null;
  },
});

export const myBatchStatusFor = internalQuery({
  args: { patchPlanId: v.string(), admitted: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    return user ? proposalBatchStatus(ctx, { orgId: user.orgId, patchPlanId: args.patchPlanId, accesses: [await accessFor(ctx, user)] }, new Set(args.admitted)) : { pending: [], value: null };
  },
});

type BatchStatus = Awaited<ReturnType<typeof proposalBatchStatus>>["value"];

/** myBatchStatus for a role that sees only some companies or people (hosted MCP's batch status). */
export const myBatchStatusScoped = action({
  args: { patchPlanId: v.string() },
  handler: async (ctx, args): Promise<BatchStatus> => {
    const caller = await requireCaller(ctx, { read: true });
    return admitThenRead(callerClient(ctx, caller), caller.orgId, (admitted) => ctx.runQuery(internal.canonGate.myBatchStatusFor, { ...args, admitted }));
  },
});

/** A batch's facts on the records and fields `accesses` see (factJudge); the rest are left out of its counts too. */
async function proposalBatchStatus(ctx: QueryCtx, args: { orgId: Id<"organizations">; patchPlanId: string; accesses: readonly Access[] }, admitted: ReadonlySet<string>) {
  {
    const judge = factJudge(ctx, args.accesses, admitted);
    const id = ctx.db.normalizeId("patchPlans", args.patchPlanId);
    const plan = id ? await ctx.db.get(id) : null;
    if (!plan || plan.orgId !== args.orgId || plan.operation !== CANON_PROPOSAL_OP) return { pending: [], value: null };
    const facts = [];
    for (const f of await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(MAX_FACTS_PER_BATCH)) {
      if (await judge.shows(await ctx.db.get(f.entityId), f.attribute)) facts.push(f);
    }
    const counts = { proposed: 0, accepted: 0, rejected: 0, superseded: 0 };
    for (const f of facts) counts[f.status]++;
    return {
      pending: judge.pending,
      value: {
        patchPlanId: plan._id, status: plan.status, counts,
        facts: facts.map((f) => ({ factId: f._id, entityType: f.entityType, attribute: f.attribute, value: f.value, status: f.status, decidedBy: f.decidedBy ?? null, verificationScore: f.verification?.score ?? null })),
      },
    };
  }
}
