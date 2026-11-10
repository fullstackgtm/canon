import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sameOperationSubset } from "./lib/patchPlanGuards";

const operation = v.object({
  packageOpId: v.string(),
  objectType: v.string(),
  objectId: v.optional(v.string()),
  fieldOrAction: v.string(),
  beforeValue: v.any(),
  afterValue: v.any(),
  reason: v.optional(v.string()),
  sourceRuleOrPolicy: v.optional(v.string()),
  riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
  approvalRequired: v.boolean(),
  rollback: v.optional(v.string()),
});

export const getByExternalId = internalQuery({
  args: { orgId: v.id("organizations"), externalPlanId: v.string() },
  handler: async (ctx, args) =>
    ctx.db.query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.externalPlanId))
      .unique(),
});

export const getOperationReceipts = internalQuery({
  args: { orgId: v.id("organizations"), patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.patchPlanId);
    if (!plan || plan.orgId !== args.orgId) return [];
    const rows = [];
    for await (const row of ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", args.patchPlanId))) {
      if (!row.packageOpId || row.status === "pending") continue;
      rows.push({
        packageOpId: row.packageOpId,
        status: row.status,
        error: row.error,
        providerData: row.providerData,
        updatedAt: row.updatedAt,
      });
    }
    return rows;
  },
});

async function rowsForPlan(ctx: MutationCtx, patchPlanId: Id<"patchPlans">) {
  const rows = [];
  for await (const row of ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", patchPlanId))) {
    rows.push(row);
  }
  return rows;
}

export const ingest = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    cliTokenId: v.id("cliTokens"),
    externalPlanId: v.string(),
    documentSha256: v.string(),
    externalRevision: v.number(),
    title: v.string(),
    summary: v.string(),
    riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    document: v.any(),
    operations: v.array(operation),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.externalPlanId))
      .unique();
    if (existing) {
      if (existing.documentSha256 !== args.documentSha256) {
        throw new ConvexError({ code: "CLI_PLAN_CONFLICT", currentHash: existing.documentSha256 });
      }
      if ((existing.externalRevision ?? 0) < args.externalRevision) {
        await ctx.db.patch(existing._id, { externalRevision: args.externalRevision, updatedAt: Date.now() });
      }
      return { patchPlanId: existing._id, status: existing.status, created: false };
    }
    const now = Date.now();
    const patchPlanId = await ctx.db.insert("patchPlans", {
      orgId: args.orgId,
      createdBy: args.userId,
      verb: "do",
      operation: "cli.patch_plan",
      args: { title: args.title, externalPlanId: args.externalPlanId },
      reason: args.summary,
      status: "pending_approval",
      riskLevel: args.riskLevel,
      approvalRequirement: "required",
      createdAt: args.createdAt,
      updatedAt: now,
      document: args.document,
      totalOperationCount: args.operations.length,
      storedOperationCount: args.operations.length,
      truncatedOperations: false,
      source: "cli",
      externalPlanId: args.externalPlanId,
      documentSha256: args.documentSha256,
      externalRevision: args.externalRevision,
      cliTokenId: args.cliTokenId,
      executionAuthority: "cli",
      approvedOperationIds: [],
    });
    for (const op of args.operations) {
      await ctx.db.insert("patchOperations", {
        orgId: args.orgId,
        patchPlanId,
        objectType: op.objectType,
        objectId: op.objectId,
        fieldOrAction: op.fieldOrAction,
        beforeValue: op.beforeValue,
        afterValue: op.afterValue,
        reason: op.reason,
        sourceRuleOrPolicy: op.sourceRuleOrPolicy,
        riskLevel: op.riskLevel,
        approvalRequirement: op.approvalRequired ? "required" : "not_required",
        rollback: op.rollback,
        status: "pending",
        packageOpId: op.packageOpId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("approvalRequests", {
      orgId: args.orgId,
      patchPlanId,
      requestedBy: args.userId,
      status: "pending",
      reason: `Imported from paired CLI plan ${args.externalPlanId}`,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("operationAuditLog", {
      orgId: args.orgId,
      userId: args.userId,
      patchPlanId,
      verb: "do",
      operation: "cli.patch_plan",
      status: "previewed",
      details: { externalPlanId: args.externalPlanId, operationCount: args.operations.length },
      createdAt: now,
    });
    return { patchPlanId, status: "pending_approval" as const, created: true };
  },
});

export const reportLifecycle = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    externalPlanId: v.string(),
    documentSha256: v.string(),
    status: v.union(v.literal("approved"), v.literal("rejected"), v.literal("applied")),
    approvedOperationIds: v.optional(v.array(v.string())),
    claimId: v.optional(v.string()),
    cliTokenId: v.id("cliTokens"),
    runRecord: v.optional(v.any()),
    operationReceipts: v.optional(v.array(v.object({
      packageOpId: v.string(),
      status: v.union(v.literal("applied"), v.literal("skipped"), v.literal("failed"), v.literal("conflict")),
      error: v.optional(v.string()),
      providerData: v.optional(v.any()),
      updatedAt: v.optional(v.number()),
    }))),
  },
  handler: async (ctx, args) => {
    const plan = await ctx.db.query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.externalPlanId))
      .unique();
    if (!plan || plan.documentSha256 !== args.documentSha256) throw new ConvexError("CLI plan mirror not found or content changed");
    if (plan.applyClaim && args.status !== "applied") {
      throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}`);
    }
    if (args.status === "applied" && plan.status !== "approved" && plan.status !== "applied") {
      throw new ConvexError(`Patch plan must be approved before apply (is ${plan.status})`);
    }
    if (args.status === "applied" && plan.applyClaim && plan.applyClaim.id !== args.claimId) {
      throw new ConvexError("This plan is claimed by another executor");
    }
    if (args.status === "applied" && plan.applyClaim?.cliTokenId && plan.applyClaim.cliTokenId !== args.cliTokenId) {
      throw new ConvexError("This apply claim belongs to another CLI replica");
    }
    if (
      (plan.status === "applied" && args.status !== "applied") ||
      (plan.status === "rejected" && args.status === "approved") ||
      (plan.status === "approved" && args.status === "rejected")
    ) {
      throw new ConvexError({ code: "CLI_PLAN_DECISION_CONFLICT", currentStatus: plan.status });
    }
    const rows = await rowsForPlan(ctx, plan._id);
    const known = new Set(rows.map((row) => row.packageOpId).filter((id): id is string => Boolean(id)));
    const approved = args.approvedOperationIds ?? [];
    if (approved.some((id) => !known.has(id))) throw new ConvexError("Unknown approved operation id");
    if (args.status === "approved" && plan.status === "approved" && !sameOperationSubset(plan.approvedOperationIds ?? [], approved)) {
      throw new ConvexError({ code: "CLI_PLAN_DECISION_CONFLICT", currentStatus: plan.status });
    }
    const now = Date.now();
    const receipts = args.operationReceipts ?? [];
    if (receipts.some((receipt) => !known.has(receipt.packageOpId))) throw new ConvexError("Unknown operation receipt id");
    if (args.status === "applied") {
      const storedApproval = plan.approvedOperationIds ?? [];
      if (!sameOperationSubset(storedApproval, approved)) {
        throw new ConvexError("Applied operation subset does not match the approved revision");
      }
      const receiptIds = receipts.map((receipt) => receipt.packageOpId);
      if (!sameOperationSubset(storedApproval, receiptIds)) {
        throw new ConvexError("A terminal receipt is required for every approved operation, and only approved operations");
      }
      if (receipts.some((receipt) => receipt.status !== "applied" && receipt.status !== "skipped")) {
        throw new ConvexError("A plan with failed or conflicting receipts cannot be reported as applied");
      }
    }
    await ctx.db.patch(plan._id, {
      status: args.status,
      approvedOperationIds: args.status === "approved" || args.status === "applied" ? approved : [],
      approvedBy: args.status === "approved" || args.status === "applied" ? args.userId : undefined,
      approvedAt: args.status === "approved" || args.status === "applied" ? now : undefined,
      appliedBy: args.status === "applied" ? args.userId : undefined,
      appliedAt: args.status === "applied" ? now : undefined,
      lastExecutionReplica: args.status === "applied" ? "cli" : plan.lastExecutionReplica,
      applyClaim: args.status === "applied" ? undefined : plan.applyClaim,
      updatedAt: now,
      runRecord: args.runRecord ?? plan.runRecord,
    });
    if (args.status === "applied") {
      const approvedSet = new Set(approved);
      const receiptById = new Map(receipts.map((receipt) => [receipt.packageOpId, receipt]));
      for (const row of rows) {
        const receipt = row.packageOpId ? receiptById.get(row.packageOpId) : undefined;
        if (receipt) {
          await ctx.db.patch(row._id, {
            status: receipt.status,
            error: receipt.status === "failed" || receipt.status === "conflict" ? receipt.error : undefined,
            providerData: receipt.providerData,
            updatedAt: receipt.updatedAt ?? now,
          });
          continue;
        }
        const isApproved = Boolean(row.packageOpId && approvedSet.has(row.packageOpId));
        await ctx.db.patch(row._id, isApproved
          ? { status: "applied", updatedAt: now }
          : { status: "skipped", providerData: { detail: "Excluded from the approved operation subset." }, updatedAt: now });
      }
    }
    return { patchPlanId: plan._id, status: args.status };
  },
});

export const claimApply = internalMutation({
  args: {
    orgId: v.id("organizations"),
    externalPlanId: v.string(),
    documentSha256: v.string(),
    cliTokenId: v.id("cliTokens"),
  },
  handler: async (ctx, args) => {
    const plan = await ctx.db.query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.externalPlanId))
      .unique();
    if (!plan || plan.documentSha256 !== args.documentSha256) {
      throw new ConvexError("CLI plan mirror not found or content changed");
    }
    if (plan.status === "applied") {
      return { patchPlanId: plan._id, status: "applied" as const, alreadyApplied: true, claimId: null };
    }
    if (plan.status !== "approved") throw new ConvexError(`Patch plan must be approved before apply (is ${plan.status})`);
    const now = Date.now();
    if (plan.applyClaim) {
      throw new ConvexError(`Apply is already in progress on ${plan.applyClaim.replica}.`);
    }
    const claimId = `cli:${plan._id}:${now}`;
    const expiresAt = 8_640_000_000_000_000;
    await ctx.db.patch(plan._id, {
      applyClaim: { id: claimId, replica: "cli", claimedAt: now, expiresAt, cliTokenId: args.cliTokenId },
      updatedAt: now,
    });
    return { patchPlanId: plan._id, status: "claimed" as const, alreadyApplied: false, claimId, expiresAt };
  },
});

/** Release a CLI claim only during preflight, before any provider I/O. */
export const releaseApplyClaim = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    externalPlanId: v.string(),
    documentSha256: v.string(),
    cliTokenId: v.id("cliTokens"),
    claimId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const plan = await ctx.db.query("patchPlans")
      .withIndex("by_orgId_externalPlanId", (q) => q.eq("orgId", args.orgId).eq("externalPlanId", args.externalPlanId))
      .unique();
    if (!plan || plan.documentSha256 !== args.documentSha256) throw new ConvexError("CLI plan mirror not found or content changed");
    const claim = plan.applyClaim;
    if (!claim || claim.id !== args.claimId || claim.replica !== "cli" || claim.cliTokenId !== args.cliTokenId) {
      throw new ConvexError("This apply claim belongs to another executor");
    }
    const reason = args.reason.trim();
    if (reason.length < 10) throw new ConvexError("Provide a preflight release reason of at least 10 characters");
    const now = Date.now();
    await ctx.db.patch(plan._id, { applyClaim: undefined, updatedAt: now });
    await ctx.db.insert("operationAuditLog", {
      orgId: args.orgId,
      userId: args.userId,
      patchPlanId: plan._id,
      verb: plan.verb,
      operation: plan.operation,
      status: "previewed",
      details: { event: "cli_apply_claim_released_preflight", reason, claimId: claim.id },
      createdAt: now,
    });
    return { patchPlanId: plan._id, released: true };
  },
});
