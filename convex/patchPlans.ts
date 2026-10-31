import { CANON_PROPOSAL_OP } from "./lib/canon/gate";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { requireUnrestricted, roleIn, unrestrictedUser } from "./permissions";
import { dispatchSetOperation } from "./gtm";
import { requiresHumanInput } from "../engine/src/rules.ts";
import {
  applyDecision,
  dispatchBlockReason,
  providerWritebackBlockReason,
  requiredString,
} from "./lib/patchPlanGuards";
import type { Doc, Id } from "./_generated/dataModel";
import { isModuleProposal } from "./lib/modules/proposals";
import { applyModuleProposal } from "./lib/modules/scope";
import { feedProposalOutcome } from "./lib/modules/recordProposals";
import { releasePlan } from "./lib/modules/grants";
import { MODULE_RECORDS } from "../modules/kernel/proposals.ts";

/** A plan a module made: its proposed module write, or its proposed write to Canon's records. Neither needs a CRM. */
const isModulePlan = (operation: string) => isModuleProposal(operation) || operation === MODULE_RECORDS;

function publicPlan(plan: Doc<"patchPlans">) {
  const { document: _document, runRecord: _runRecord, applyClaim, ...rest } = plan;
  // A claim id is an executor capability, not dashboard presentation data.
  const publicClaim = applyClaim ? { replica: applyClaim.replica, claimedAt: applyClaim.claimedAt } : undefined;
  return { ...rest, applyClaim: publicClaim };
}

async function patchOperationsForPlan(ctx: any, patchPlanId: Id<"patchPlans">, cap = 3000) {
  const rows = [];
  for await (const row of ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q: any) => q.eq("patchPlanId", patchPlanId))) {
    rows.push(row);
    if (rows.length >= cap) break;
  }
  return rows;
}

const planStatus = v.union(
  v.literal("draft"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("applied"),
  v.literal("rejected"),
  v.literal("cancelled"),
  v.literal("failed"),
);

export const list = query({
  args: { status: v.optional(planStatus), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const plans = args.status
      ? await ctx.db
          .query("patchPlans")
          .withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", args.status!))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("patchPlans")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .order("desc")
          .take(limit);
    return plans.map(publicPlan);
  },
});

export const get = query({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) return null;
    const [operations, approvals, audit] = await Promise.all([
      patchOperationsForPlan(ctx, args.patchPlanId),
      ctx.db.query("approvalRequests").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId)).take(20),
      ctx.db.query("operationAuditLog").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId)).take(100),
    ]);
    const crmRows = await ctx.db
      .query("integrations")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(100);
    const activeCrms = crmRows.filter((row) => row.isActive !== false && (row.provider === "hubspot" || row.provider === "salesforce"));
    const blockers: string[] = [];
    // A module proposal writes Canon's own module data: no CRM and no package document are involved.
    const crmPlan = !isModulePlan(plan.operation);
    if (crmPlan && (!plan.document || !Array.isArray((plan.document as any)?.operations))) blockers.push("Plan document is not fully synchronized.");
    if (plan.status !== "approved") blockers.push(plan.status === "applied" ? "Plan is already applied." : "Plan must be approved first.");
    if (crmPlan && activeCrms.length === 0) blockers.push("Connect HubSpot or Salesforce to apply from hosted.");
    if (crmPlan && activeCrms.length > 1) blockers.push("Multiple active CRMs are connected; select a single execution target.");
    if (plan.applyClaim) blockers.push(`Apply is already in progress on ${plan.applyClaim.replica}.`);
    return {
      plan: publicPlan(plan),
      operations,
      approvals,
      audit,
      execution: {
        canApplyHosted: blockers.length === 0,
        blockers,
        provider: activeCrms.length === 1 ? activeCrms[0].provider : undefined,
        syncState: plan.source === "cli" && (!plan.documentSha256 || !plan.externalRevision) ? "pending" : "current",
        executor: plan.applyClaim?.replica ?? plan.lastExecutionReplica,
      },
    };
  },
});

export const getApplyContextInternal = internalQuery({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await requireUnrestricted(ctx, "patch plans over the CRM");
    if (!user) throw new ConvexError("Not authenticated");
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    if (plan.operation === CANON_PROPOSAL_OP) throw new ConvexError("Proposed facts are reviewed in the fact review queue");
    if (plan.applyClaim) throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}.`);
    const operations = await patchOperationsForPlan(ctx, args.patchPlanId);
    const dealId = plan.verb === "set" && plan.operation === "deal.next_step" ? requiredString(plan.args, "dealId") : null;
    const deal = dealId ? await ctx.db.get(dealId as Id<"deals">) : null;
    if (deal && deal.orgId !== user.orgId) throw new ConvexError("Deal not found");
    return { user, plan, operations, deal, document: plan.document ?? null, valueOverrides: plan.valueOverrides ?? null };
  },
});

export const approve = mutation({
  args: {
    patchPlanId: v.id("patchPlans"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reason: v.optional(v.string()),
    valueOverrides: v.optional(v.any()),
    approvedOperationIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "patch plans over the CRM");
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    if (plan.operation === CANON_PROPOSAL_OP) throw new ConvexError("Proposed facts are reviewed in the fact review queue");
    // A module proposal is an agent's write held for a person: an agent can't decide it, its own or another's.
    if (isModulePlan(plan.operation) && (await agentClientOf(ctx))) throw new ConvexError("An agent can't decide a module proposal; a person approves or rejects it on the Patch plans page.");
    if (plan.applyClaim) throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}.`);
    if (!["draft", "pending_approval", "approved"].includes(plan.status)) throw new ConvexError(`Patch plan is ${plan.status}`);
    await refuseGranted(ctx, plan);
    const now = Date.now();
    const nextStatus = args.decision === "approved" ? "approved" : "rejected";
    const valueOverrides =
      args.valueOverrides && typeof args.valueOverrides === "object" && !Array.isArray(args.valueOverrides)
        ? (args.valueOverrides as Record<string, unknown>)
        : {};
    const operationRows = await patchOperationsForPlan(ctx, args.patchPlanId);
    const availableOperationIds = operationRows
      .map((row: any) => row.packageOpId)
      .filter((id: unknown): id is string => typeof id === "string");
    const availableOperationIdSet = new Set(availableOperationIds);
    const approvedOperationIds = args.decision === "approved"
      ? Array.from(new Set(args.approvedOperationIds ?? availableOperationIds))
      : [];
    if (args.decision === "approved") {
      if (approvedOperationIds.length === 0) throw new ConvexError("Select at least one operation to approve.");
      const unknown = approvedOperationIds.find((id) => !availableOperationIdSet.has(id));
      if (unknown) throw new ConvexError(`Operation ${unknown} is not part of this plan.`);
    }
    if (args.decision === "approved" && plan.document?.operations && Array.isArray(plan.document.operations)) {
      const requiresHumanIds = new Set(
        plan.document.operations
          .filter((operation: any) => typeof operation?.id === "string" && approvedOperationIds.includes(operation.id) && requiresHumanInput(operation.afterValue))
          .map((operation: any) => operation.id as string),
      );
      for (const [operationId, value] of Object.entries(valueOverrides)) {
        if (!requiresHumanIds.has(operationId)) throw new ConvexError(`Override ${operationId} is not a human-input operation on this plan.`);
        if (typeof value !== "string" || value.trim().length === 0) throw new ConvexError(`Select a non-empty approved value for ${operationId}.`);
      }
      const missing = Array.from(requiresHumanIds as Set<string>)
        .filter((operationId: string) => valueOverrides[operationId] === undefined || typeof valueOverrides[operationId] !== "string" || String(valueOverrides[operationId]).trim().length === 0)
        .slice(0, 5);
      if (missing.length > 0) throw new ConvexError(`Select approved values for ${missing.join(", ")} before approving.`);
    }
    await ctx.db.patch(args.patchPlanId, {
      status: nextStatus,
      approvedBy: args.decision === "approved" ? user._id : undefined,
      approvedAt: args.decision === "approved" ? now : undefined,
      approvedOperationIds,
      valueOverrides: args.decision === "approved" ? valueOverrides : undefined,
      updatedAt: now,
    });
    const requests = await ctx.db.query("approvalRequests").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId)).take(20);
    for (const request of requests) {
      if (request.status !== "pending") continue;
      await ctx.db.patch(request._id, { status: args.decision, reason: args.reason, decidedBy: user._id, decidedAt: now, updatedAt: now });
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      patchPlanId: args.patchPlanId,
      verb: plan.verb,
      operation: plan.operation,
      status: args.decision,
      details: { reason: args.reason, approvedOperationIds, excludedOperationCount: availableOperationIds.length - approvedOperationIds.length },
      createdAt: now,
    });
    // A module that proposed this hears it was rejected (an approval it hears when the plan applies).
    if (nextStatus === "rejected") await feedProposalOutcome(ctx, plan);
    return { patchPlanId: args.patchPlanId, status: nextStatus };
  },
});

/**
 * A plan a module's standing grant approved is applied under that grant (moduleGrants.applyGranted), never decided or
 * applied again from this page: revoking the grant stops it, and sends it back here for a person.
 */
async function refuseGranted(ctx: MutationCtx, plan: Doc<"patchPlans">) {
  if (plan.status !== "approved") return;
  const use = await ctx.db.query("moduleGrantUses").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).unique();
  if (use) throw new ConvexError("A module's standing grant approved this plan and it is being applied. Revoke the grant on the Customization page to stop it; the plan then waits here.");
}

/**
 * Back an approved plan out to pending_approval BEFORE it is applied.
 * Approval is a transitory state, not a one-way door: until apply runs,
 * revoking costs nothing (nothing has been written) and returns the plan to
 * the review queue where it can be re-approved or rejected. Applied plans
 * cannot be revoked — the write already happened; roll forward instead.
 */
export const revokeApproval = mutation({
  args: { patchPlanId: v.id("patchPlans"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "patch plans over the CRM");
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    await refuseGranted(ctx, plan);
    if (plan.status !== "approved") {
      throw new ConvexError(
        plan.status === "applied"
          ? "This plan was already applied — the writes happened. Create a corrective plan instead."
          : `Only approved plans can be revoked (this one is ${plan.status}).`,
      );
    }
    if (plan.applyClaim) throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}.`);

    const now = Date.now();
    await ctx.db.patch(args.patchPlanId, {
      status: "pending_approval",
      approvedBy: undefined,
      approvedAt: undefined,
      updatedAt: now,
    });
    const requests = await ctx.db
      .query("approvalRequests")
      .withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId))
      .take(20);
    for (const request of requests) {
      if (request.status !== "approved") continue;
      await ctx.db.patch(request._id, {
        status: "pending",
        reason: args.reason,
        decidedBy: undefined,
        decidedAt: undefined,
        updatedAt: now,
      });
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      patchPlanId: args.patchPlanId,
      verb: plan.verb,
      operation: plan.operation,
      status: "approval_revoked",
      details: { reason: args.reason, previousApprover: plan.approvedBy ?? null },
      createdAt: now,
    });
    return { patchPlanId: args.patchPlanId, status: "pending_approval" };
  },
});

// Claims do not auto-expire: a slow provider write must never overlap a
// second executor because a wall-clock lease elapsed. Completion/failure
// clears the claim; stale recovery must be an explicit audited action.
const APPLY_CLAIM_SENTINEL_EXPIRY = 8_640_000_000_000_000;

/**
 * Who applies a plan: the signed-in member, or, from a standing grant's apply (moduleGrants.applyGranted, internal
 * only), the admin who gave the grant, while they are still an admin of the plan's workspace.
 */
async function applier(ctx: MutationCtx, patchPlanId: Id<"patchPlans">, actor: Id<"users"> | undefined, failing = false) {
  if (!actor) return requireUser(ctx);
  const plan = await ctx.db.get(patchPlanId);
  const user = await ctx.db.get(actor);
  // Recording a failure needs no authority: an admin demoted mid-apply still leaves the plan failed, never stuck.
  if (!plan || !user || (!failing && (await roleIn(ctx, user, plan.orgId)) !== "admin")) throw new ConvexError("The admin who gave the grant can't apply it");
  return { ...user, orgId: plan.orgId, role: "admin" as const };
}

/** Atomically reserve an approved plan for a capable hosted executor. */
export const claimHostedApply = internalMutation({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    // A plan a module's grant approved is applied only under the grant, which is checked when it claims.
    await refuseGranted(ctx, plan);
    const decision = applyDecision(plan);
    if (decision.kind === "already_applied") {
      return { status: "applied" as const, alreadyApplied: true, claimId: null };
    }
    if (decision.kind === "blocked") throw new ConvexError(decision.reason);
    const now = Date.now();
    if (plan.applyClaim) {
      throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}.`);
    }
    const claimId = `hosted:${args.patchPlanId}:${user._id}:${now}`;
    await ctx.db.patch(args.patchPlanId, {
      applyClaim: { id: claimId, replica: "hosted", claimedAt: now, expiresAt: APPLY_CLAIM_SENTINEL_EXPIRY },
      updatedAt: now,
    });
    return { status: "claimed" as const, alreadyApplied: false, claimId };
  },
});

/** Explicit escape hatch for a crashed executor; never happens on a timer. */
export const recoverStaleApplyClaim = mutation({
  args: { patchPlanId: v.id("patchPlans"), reason: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "patchPlans.recover")) throw new ConvexError(refusal("patchPlans.recover"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    // A plan a module's grant approved whose apply never finished goes back to waiting for a person.
    const granted = plan.status === "approved" && (await ctx.db.query("moduleGrantUses").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).unique()) !== null;
    if (!plan.applyClaim && !granted) return { patchPlanId: plan._id, recovered: false };
    if (Date.now() - (plan.applyClaim?.claimedAt ?? plan.approvedAt ?? 0) < 15 * 60 * 1000) {
      throw new ConvexError("Wait at least 15 minutes before recovering an executor claim.");
    }
    if (args.reason.trim().length < 10) throw new ConvexError("Provide a recovery reason of at least 10 characters.");
    const claim = plan.applyClaim ?? null;
    const now = Date.now();
    await ctx.db.patch(plan._id, { applyClaim: undefined, updatedAt: now });
    if (granted) await releasePlan(ctx, plan, `its grant's apply was recovered: ${args.reason.trim()}`, now);
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      patchPlanId: plan._id,
      verb: plan.verb,
      operation: plan.operation,
      status: "previewed",
      details: { event: "stale_apply_claim_recovered", reason: args.reason.trim(), claim },
      createdAt: now,
    });
    return { patchPlanId: plan._id, recovered: true };
  },
});

export const apply = internalMutation({
  args: {
    patchPlanId: v.id("patchPlans"),
    providerResult: v.optional(v.any()),
    // Set when the caller (patchPlanActions.apply) already executed a `do`
    // operation in an action context; this mutation then only records status.
    alreadyDispatched: v.optional(v.boolean()),
    claimId: v.optional(v.string()),
    actor: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const user = await applier(ctx, args.patchPlanId, args.actor);
    if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    if (plan.applyClaim && plan.applyClaim.id !== args.claimId) {
      throw new ConvexError("This plan is claimed by another executor.");
    }
    const decision = applyDecision(plan);
    if (decision.kind === "already_applied") return { patchPlanId: args.patchPlanId, status: "applied", alreadyApplied: true };
    if (decision.kind === "blocked") throw new ConvexError(decision.reason);

    const operations = await patchOperationsForPlan(ctx, args.patchPlanId);
    const now = Date.now();
    const providerResult = args.providerResult ?? null;
    try {
      if (!args.alreadyDispatched) {
        // Dispatch through the shared operation registry — every `set`
        // operation the app supports is applyable, not just deal.next_step.
        // `do` operations require an action context and are dispatched by
        // patchPlanActions.apply before it calls this mutation.
        const dispatchBlock = dispatchBlockReason(plan, false);
        if (dispatchBlock) throw new ConvexError(dispatchBlock);
        if (plan.operation === "deal.next_step") {
          // deal.next_step is CRM-inherited: a CRM-backed deal must carry a
          // matching provider writeback result before it can be marked applied.
          const dealId = requiredString(plan.args, "dealId") as Id<"deals">;
          const deal = await ctx.db.get(dealId);
          if (!deal || deal.orgId !== user.orgId) throw new ConvexError("Deal not found");
          const writebackBlock = providerWritebackBlockReason(deal, providerResult);
          if (writebackBlock) throw new ConvexError(writebackBlock);
        }
        // A module proposal runs its op or transition again, as the person applying it, in this transaction.
        if (isModuleProposal(plan.operation)) await applyModuleProposal(ctx, plan);
        else await dispatchSetOperation(ctx, plan.operation, (plan.args ?? {}) as Record<string, unknown>);
      }

      // Plan-level outcome from the provider's aggregate counts (do-path
      // handlers like the Stripe backfill return {applied, skipped, failed}).
      // There is no "partial" plan status — any failed op fails the plan, and
      // the per-op rows carry the detail.
      const counts =
        providerResult && typeof providerResult === "object" && !Array.isArray(providerResult)
          ? (providerResult as Record<string, unknown>)
          : null;
      const failedCount = counts && typeof counts.failed === "number" ? counts.failed : 0;
      const planFailed = failedCount > 0;
      const totalOps =
        counts && typeof counts.applied === "number" && typeof counts.skipped === "number" && typeof counts.failed === "number"
          ? (counts.applied as number) + (counts.skipped as number) + (counts.failed as number)
          : operations.length;

      // Only flip rows still pending: on the do-path the handler may already
      // have written real per-op outcomes (applied/skipped/failed) — never
      // blanket-overwrite them. When the aggregate reports failures, pending
      // rows have no confirmed outcome, so they stay pending too.
      if (!planFailed) {
        const approvedIds = new Set(plan.approvedOperationIds ?? []);
        for (const operation of operations) {
          if (operation.status !== "pending") continue;
          const approved = Boolean(operation.packageOpId && approvedIds.has(operation.packageOpId));
          await ctx.db.patch(operation._id, approved
            ? { status: "applied", updatedAt: now }
            : { status: "skipped", providerData: { detail: "Excluded from the approved operation subset." }, updatedAt: now });
        }
      }

      if (planFailed) {
        const message = `${failedCount} of ${totalOps} operations failed — see operation rows`;
        await ctx.db.patch(args.patchPlanId, { status: "failed", error: message, applyClaim: undefined, updatedAt: now });
        await ctx.db.insert("operationAuditLog", {
          orgId: user.orgId,
          userId: user._id,
          patchPlanId: args.patchPlanId,
          verb: plan.verb,
          operation: plan.operation,
          status: "failed",
          details: { operationCount: operations.length, providerResult, error: message },
          createdAt: now,
        });
        await feedProposalOutcome(ctx, plan);
        return { patchPlanId: args.patchPlanId, status: "failed", operationCount: operations.length, error: message };
      }

      await ctx.db.patch(args.patchPlanId, { status: "applied", appliedBy: user._id, appliedAt: now, lastExecutionReplica: plan.applyClaim?.replica ?? "hosted", applyClaim: undefined, updatedAt: now, error: undefined });
      await ctx.db.insert("operationAuditLog", {
        orgId: user.orgId,
        userId: user._id,
        patchPlanId: args.patchPlanId,
        verb: plan.verb,
        operation: plan.operation,
        status: "applied",
        details: {
          operationCount: operations.length,
          providerResult,
          verification: {
            status: "pending",
            todo: "Read back provider deal.next_step and compare with expected value.",
          },
        },
        createdAt: now,
      });
      await feedProposalOutcome(ctx, plan);
      return { patchPlanId: args.patchPlanId, status: "applied", operationCount: operations.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.db.patch(args.patchPlanId, { status: "failed", error: message, applyClaim: undefined, updatedAt: now });
      for (const operation of operations) {
        if (operation.status !== "pending") continue;
        await ctx.db.patch(operation._id, { status: "failed", error: message, updatedAt: now });
      }
      await ctx.db.insert("operationAuditLog", {
        orgId: user.orgId,
        userId: user._id,
        patchPlanId: args.patchPlanId,
        verb: plan.verb,
        operation: plan.operation,
        status: "failed",
        details: { error: message, providerResult },
        createdAt: now,
      });
      throw error;
    }
  },
});

/**
 * Write per-operation apply outcomes back onto their patchOperations rows.
 * Internal-only: called by do-path apply handlers (stripeActions.
 * backfillApplyOpsInternal) in chunks so each mutation stays well under the
 * transaction write limits. `error` is only set for failed rows; applied and
 * skipped rows carry their connector detail in providerData.
 */
export const recordOperationResults = internalMutation({
  args: {
    results: v.array(
      v.object({
        operationId: v.id("patchOperations"),
        status: v.union(v.literal("applied"), v.literal("skipped"), v.literal("failed"), v.literal("conflict")),
        error: v.optional(v.string()),
        providerData: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const result of args.results) {
      const operation = await ctx.db.get(result.operationId);
      if (!operation) continue;
      await ctx.db.patch(result.operationId, {
        status: result.status,
        error: result.status === "failed" || result.status === "conflict" ? result.error : undefined,
        providerData: result.providerData,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const recordPatchPlanRun = internalMutation({
  args: {
    patchPlanId: v.id("patchPlans"),
    runRecord: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.patchPlanId, { runRecord: args.runRecord, updatedAt: Date.now() });
    return null;
  },
});

export const recordApplyFailure = internalMutation({
  args: {
    patchPlanId: v.id("patchPlans"),
    error: v.string(),
    providerResult: v.optional(v.any()),
    actor: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const user = await applier(ctx, args.patchPlanId, args.actor, true);
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== user.orgId) throw new ConvexError("Patch plan not found");
    const operations = await patchOperationsForPlan(ctx, args.patchPlanId);
    const now = Date.now();
    await ctx.db.patch(args.patchPlanId, { status: "failed", error: args.error, applyClaim: undefined, updatedAt: now });
    // Only rows still pending get the failure message — rows the handler
    // already resolved (applied/skipped, e.g. provider writes that succeeded
    // before the failure) keep their real outcome.
    for (const operation of operations) {
      if (operation.status !== "pending") continue;
      await ctx.db.patch(operation._id, { status: "failed", error: args.error, updatedAt: now });
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      patchPlanId: args.patchPlanId,
      verb: plan.verb,
      operation: plan.operation,
      status: "failed",
      details: {
        error: args.error,
        providerResult: args.providerResult ?? null,
        phase: "provider_writeback",
      },
      createdAt: now,
    });
    await feedProposalOutcome(ctx, plan);
    return { patchPlanId: args.patchPlanId, status: "failed" };
  },
});
