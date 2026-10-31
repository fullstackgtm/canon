/**
 * Standing write grants (docs/org-agents.md "Autonomy"; rules in
 * lib/agents/grants.ts). Admins create, list and revoke them here. These are
 * signed-in admins' mutations: hosted agents run only internal functions, and
 * create/revoke are kept off the gtm API, CLI and MCP tool surface
 * (src/lib/gtm-human-only-mutations.ts). A person's own session token is that
 * person, the same boundary as every other admin action.
 *
 * An event agent's turn (agentTurns.finishTurn) submits the answers a live
 * grant covers as their own proposal batch and calls `approveUnderGrant` in
 * the same transaction, after `actingAgent`. The batch goes through the same
 * write gate (ownership, normalization, dedupe) and the same decision path as
 * a reviewer's click; only the decider differs: the grant. A batch that
 * doesn't fit stays pending for a person, whole.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { MAX_GRANTS, signingKey, termsOf, usedToday } from "./lib/agents/grantRead";
import { agentReader } from "./lib/agentReads";
import { accessFor } from "./permissions";
import { convexLedgerStore, mirrorDecidedFacts } from "./canon";
import { settlePlan } from "./canonGate";
import { decideFacts } from "./lib/canon/ledger";
import { CANON_PROPOSAL_OP } from "./lib/canon/gate";
import { isStructuredAttribute } from "./lib/canon/attributes";
import { attributeFor } from "./lib/research/agentLoop";
import type { ActingAgent } from "./lib/agents/attribution";
import {
  GRANT_OPERATION, approvalDigest, grantRequestRefusal, grantState, planFits, planHash, signGrant,
  type GrantFact, type StoredGrant,
} from "./lib/agents/grants";
import { withEventDefinition } from "./lib/agents/definitions";

const MAX_PLAN_FACTS = 500;
type ReadCtx = { db: QueryCtx["db"] };

/** The agent's grants that verify, are unexpired and unrevoked now. */
export async function liveGrants(ctx: ReadCtx, agentId: Id<"agents">, now: number): Promise<StoredGrant[]> {
  const key = await signingKey();
  if (!key) return [];
  const out: StoredGrant[] = [];
  for (const g of await ctx.db.query("agentGrants").withIndex("by_agentId", (q) => q.eq("agentId", agentId)).take(MAX_GRANTS)) {
    const t = termsOf(g);
    if ((await grantState(t, key, now)) === "live") out.push(t);
  }
  return out;
}

/**
 * Approve a proposal batch under a grant, or leave it pending for a person.
 * Everything is re-checked here, in the transaction that decides: the
 * grant's signature, expiry and revocation, that every operation in the
 * batch is a still-proposed fact by this agent that fits the grant, and the
 * daily cap. `agent` must come from actingAgent in this same transaction.
 */
export async function approveUnderGrant(ctx: MutationCtx, a: {
  agent: ActingAgent; grantId: Id<"agentGrants">; patchPlanId: Id<"patchPlans">; turnId?: Id<"agentTurns">;
}): Promise<{ approved: true; factIds: Id<"facts">[] } | { approved: false; reason: string }> {
  const now = Date.now();
  const key = await signingKey();
  const grant = await ctx.db.get(a.grantId);
  const plan = await ctx.db.get(a.patchPlanId);
  if (!key || !grant || !plan) return { approved: false, reason: "grant or plan missing" };
  if (grant.orgId !== a.agent.orgId || grant.agentId !== a.agent._id || plan.orgId !== a.agent.orgId || plan.agentId !== a.agent._id
    || plan.operation !== CANON_PROPOSAL_OP || plan.status !== "pending_approval") {
    return { approved: false, reason: "plan is not this agent's pending proposal batch" };
  }
  const terms = termsOf(grant);
  const facts = await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(MAX_PLAN_FACTS + 1);
  const ops = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(MAX_PLAN_FACTS + 1);
  const gate: GrantFact[] = [];
  for (const f of facts) {
    if (isStructuredAttribute(f.entityType, f.attribute) || Array.isArray(f.value)) return { approved: false, reason: "standing grants do not approve structured fact values" };
    gate.push({ id: f._id, status: f.status, entityId: f.entityId, entityType: f.entityType, attribute: f.attribute, value: f.value, evidence: f.evidence, actor: f.actor });
  }
  const fit = planFits(terms, await grantState(terms, key, now), a.agent._id, gate, ops.length, await usedToday(ctx, grant._id, now));
  if (!fit.ok) return { approved: false, reason: fit.reason };
  const hash = await planHash(plan._id, gate);
  const digest = await approvalDigest(key, grant._id, grant.signature, hash);
  const decider = { kind: "grant", grantId: grant._id } as const;
  // The same decision path as a reviewer's click: only facts still proposed are decided.
  const out = await decideFacts(convexLedgerStore(ctx), {
    orgId: plan.orgId, decisions: facts.map((f) => ({ factId: f._id, status: "accepted" as const })), decider, at: now,
  });
  await mirrorDecidedFacts(ctx, out.decided, decider, now);
  await settlePlan(ctx, plan._id, undefined, now);
  await ctx.db.insert("agentGrantApprovals", {
    orgId: plan.orgId, grantId: grant._id, agentId: a.agent._id, patchPlanId: plan._id, ...(a.turnId ? { turnId: a.turnId } : {}),
    planHash: hash, digest, factCount: out.decided.length, at: now,
  });
  await ctx.db.insert("operationAuditLog", {
    orgId: plan.orgId, patchPlanId: plan._id, agentId: a.agent._id, verb: "set", operation: "agent.grant_approve", status: "approved",
    details: { grantId: grant._id, planHash: hash, digest, facts: out.decided.length }, createdAt: now,
  });
  return { approved: true, factIds: out.decided.map((f) => f._id as Id<"facts">) };
}

// ───────────────────────────── People ─────────────────────────────

/** An agent's grants, newest first, with their state and today's use. */
export const list = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const reader = user ? await agentReader(ctx, user.orgId, await accessFor(ctx, user), "legacy") : null;
    return reader ? reader.grants(args.agentId) : null;
  },
});

/** Admin: let the agent set one of its AI fields without a reviewer, within limits, until it expires. */
export const createAgentGrantArgs = v.object({
  agentId: v.id("agents"), fieldSlug: v.string(), days: v.number(),
  allowedValues: v.optional(v.array(v.string())), maxPerDay: v.optional(v.number()),
});

export async function createAgentGrant(ctx: MutationCtx, args: typeof createAgentGrantArgs.type) {
  const user = await requireUser(ctx);
  const principal = await ctx.db.get(args.agentId);
  const agent = principal?.orgId === user.orgId ? await withEventDefinition(ctx, principal) : null;
  const live = agent && agent.orgId === user.orgId && agent.archivedAt === undefined && agent.fieldSlugs ? agent : null;
  const field = live ? await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", live.orgId).eq("slug", args.fieldSlug)).unique() : null;
  const allowedValues = args.allowedValues ? [...new Set(args.allowedValues.map((s) => s.trim()))] : undefined;
  const refusal = grantRequestRefusal({
    viewerRole: user.role,
    agent: live ? { orgId: live.orgId, agentId: live._id, fieldSlugs: live.fieldSlugs ?? [] } : null,
    field: field ? { slug: field.slug, entityType: field.entityType, choices: field.options?.map((o) => o.key) ?? (field.answerType === "boolean" ? ["true", "false"] : []) } : null,
    allowedValues, maxPerDay: args.maxPerDay, days: args.days,
  });
  if (refusal || !live || !field) throw new ConvexError(refusal ?? "Agent not found");
  const existing = await ctx.db.query("agentGrants").withIndex("by_agentId", (q) => q.eq("agentId", live._id)).take(MAX_GRANTS);
  if (existing.length >= MAX_GRANTS) throw new ConvexError(`An agent has at most ${MAX_GRANTS} grants.`);
  const key = await signingKey();
  if (!key) throw new ConvexError("Grants can't be signed on this deployment yet: its encryption key isn't configured.");
  const now = Date.now();
  const row = {
    orgId: live.orgId, agentId: live._id, operation: GRANT_OPERATION, entityType: field.entityType, attribute: attributeFor(field.slug),
    ...(allowedValues ? { allowedValues } : {}), ...(args.maxPerDay !== undefined ? { maxPerDay: args.maxPerDay } : {}),
    expiresAt: now + args.days * 24 * 60 * 60 * 1000, createdBy: user._id, createdAt: now,
  };
  // The id is part of the signed terms, so the row is signed once it exists (same transaction).
  const grantId = await ctx.db.insert("agentGrants", { ...row, signature: "" });
  await ctx.db.patch(grantId, { signature: await signGrant({ ...row, grantId }, key) });
  await ctx.db.insert("operationAuditLog", {
    orgId: live.orgId, userId: user._id, agentId: live._id, verb: "do", operation: "agent.grant_create", status: "applied",
    details: { grantId, attribute: row.attribute, allowedValues: allowedValues ?? null, maxPerDay: args.maxPerDay ?? null, expiresAt: row.expiresAt }, createdAt: now,
  });
  return { grantId };
}

export const create = mutation({
  args: createAgentGrantArgs,
  handler: createAgentGrant,
});

/** Admin: revoke a grant. It approves nothing from now on, including turns already running. */
export const revokeAgentGrantArgs = v.object({ grantId: v.id("agentGrants") });

export async function revokeAgentGrant(ctx: MutationCtx, args: typeof revokeAgentGrantArgs.type) {
  const user = await requireUser(ctx);
  if (!can(user, "grants.manage")) throw new ConvexError(refusal("grants.manage"));
  const grant = await ctx.db.get(args.grantId);
  if (!grant || grant.orgId !== user.orgId) throw new ConvexError("Grant not found");
  if (grant.revokedAt !== undefined) return null;
  const now = Date.now();
  await ctx.db.patch(grant._id, { revokedAt: now, revokedBy: user._id });
  await ctx.db.insert("operationAuditLog", {
    orgId: grant.orgId, userId: user._id, agentId: grant.agentId, verb: "do", operation: "agent.grant_revoke", status: "applied",
    details: { grantId: grant._id }, createdAt: now,
  });
  return null;
}

export const revoke = mutation({
  args: revokeAgentGrantArgs,
  handler: revokeAgentGrant,
});
