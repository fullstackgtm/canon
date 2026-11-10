"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { touchCliToken } from "./cliAuth";
import type { Doc, Id } from "./_generated/dataModel";

type CliIdentity = { _id: Id<"cliTokens">; orgId: Id<"organizations">; userId: Id<"users"> };

async function authenticate(ctx: ActionCtx, cliToken: string): Promise<CliIdentity> {
  const tokenHash = createHash("sha256").update(cliToken).digest("hex");
  const token: CliIdentity | null = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
  if (!token) throw new ConvexError("Invalid or revoked CLI token");
  await touchCliToken(ctx, token);
  // A plan audits and writes the whole CRM: only for a token whose user sees all of it (CP14).
  await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: token.orgId, userId: token.userId, what: "patch plans over the CRM" });
  return token;
}

const baseArgs = { cliToken: v.string(), externalPlanId: v.string() };

export const get = action({
  args: baseArgs,
  handler: async (ctx, args): Promise<{
    patchPlanId: Id<"patchPlans">; externalPlanId?: string; documentSha256?: string; status: string;
    approvedOperationIds: string[]; valueOverrides: unknown; updatedAt: number;
    runRecord?: unknown;
    operationReceipts: Array<{ packageOpId: string; status: string; error?: string; providerData?: unknown; updatedAt: number }>;
  } | null> => {
    const token = await authenticate(ctx, args.cliToken);
    const plan: Doc<"patchPlans"> | null = await ctx.runQuery(internal.cliPatchPlans.getByExternalId, { orgId: token.orgId, externalPlanId: args.externalPlanId });
    if (!plan) return null;
    const operationReceipts = await ctx.runQuery(internal.cliPatchPlans.getOperationReceipts, {
      orgId: token.orgId,
      patchPlanId: plan._id,
    });
    return {
      patchPlanId: plan._id,
      externalPlanId: plan.externalPlanId,
      documentSha256: plan.documentSha256,
      status: plan.status,
      approvedOperationIds: plan.approvedOperationIds ?? [],
      valueOverrides: plan.valueOverrides ?? {},
      updatedAt: plan.updatedAt,
      runRecord: plan.runRecord,
      operationReceipts,
    };
  },
});

export const ingest = action({
  args: {
    ...baseArgs,
    documentSha256: v.string(), externalRevision: v.number(), title: v.string(), summary: v.string(),
    riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    document: v.any(), operations: v.array(v.any()), createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ patchPlanId: Id<"patchPlans">; status: string; created: boolean }> => {
    const token = await authenticate(ctx, args.cliToken);
    return ctx.runMutation(internal.cliPatchPlans.ingest, {
      orgId: token.orgId, userId: token.userId, cliTokenId: token._id,
      externalPlanId: args.externalPlanId, documentSha256: args.documentSha256, externalRevision: args.externalRevision,
      title: args.title, summary: args.summary, riskLevel: args.riskLevel, document: args.document,
      operations: args.operations, createdAt: args.createdAt,
    });
  },
});

export const reportLifecycle = action({
  args: {
    ...baseArgs, documentSha256: v.string(),
    status: v.union(v.literal("approved"), v.literal("rejected"), v.literal("applied")),
    approvedOperationIds: v.optional(v.array(v.string())),
    claimId: v.optional(v.string()),
    runRecord: v.optional(v.any()),
    operationReceipts: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args): Promise<{ patchPlanId: Id<"patchPlans">; status: string }> => {
    const token = await authenticate(ctx, args.cliToken);
    return ctx.runMutation(internal.cliPatchPlans.reportLifecycle, {
      orgId: token.orgId, userId: token.userId, externalPlanId: args.externalPlanId,
      documentSha256: args.documentSha256, status: args.status, approvedOperationIds: args.approvedOperationIds,
      claimId: args.claimId,
      runRecord: args.runRecord,
      operationReceipts: args.operationReceipts,
      cliTokenId: token._id,
    });
  },
});

export const claimApply = action({
  args: { ...baseArgs, documentSha256: v.string() },
  handler: async (ctx, args): Promise<{
    patchPlanId: Id<"patchPlans">;
    status: "applied" | "claimed";
    alreadyApplied: boolean;
    claimId: string | null;
    expiresAt?: number;
  }> => {
    const token = await authenticate(ctx, args.cliToken);
    return ctx.runMutation(internal.cliPatchPlans.claimApply, {
      orgId: token.orgId,
      externalPlanId: args.externalPlanId,
      documentSha256: args.documentSha256,
      cliTokenId: token._id,
    });
  },
});

export const releaseApplyClaim = action({
  args: { ...baseArgs, documentSha256: v.string(), claimId: v.string(), reason: v.string() },
  handler: async (ctx, args): Promise<{ patchPlanId: Id<"patchPlans">; released: boolean }> => {
    const token = await authenticate(ctx, args.cliToken);
    return ctx.runMutation(internal.cliPatchPlans.releaseApplyClaim, {
      orgId: token.orgId,
      userId: token.userId,
      externalPlanId: args.externalPlanId,
      documentSha256: args.documentSha256,
      cliTokenId: token._id,
      claimId: args.claimId,
      reason: args.reason,
    });
  },
});
