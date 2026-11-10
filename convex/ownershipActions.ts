"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { connectorForOrg } from "./hubspotActions";
import { applyLegacyRowsThroughConnector, applyThroughPackage, patchPlanFromDocument } from "./lib/applyThroughPackage";
import type { PatchOperationResult } from "../engine/src/types.ts";
import type { PersistedDoOperation } from "./gtm";
import type { Id } from "./_generated/dataModel";

type OwnerAssignPayload = {
  dealId: Id<"deals">;
  crmId: string | null;
  provider: string | null;
  value: string;
  userId: Id<"users">;
  userName?: string;
  dealName?: string;
};

/**
 * Apply EXACTLY the persisted, approved owner assignments through the package
 * PatchPlan/applyPatchPlan path, then update the local mirror for rows whose
 * CRM write succeeded.
 */
export const applyDealOwnersInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    operations: v.array(v.any()),
    planDocument: v.optional(v.any()),
    patchPlanId: v.optional(v.id("patchPlans")),
    valueOverrides: v.optional(v.any()),
    /** The person who approved the plan: the owners are their choice (ownership.patchDealOwner). */
    approvedBy: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ applied: number; skipped: number; failed: number; conflicts: number; firstErrors: string[] }> => {
    const plan = patchPlanFromDocument(args.planDocument);
    const connector = await connectorForOrg(ctx, args.orgId);
    const rows = args.operations as Array<PersistedDoOperation & { _id?: Id<"patchOperations">; packageOpId?: string }>;
    const preResults: Array<{ operationId: Id<"patchOperations">; status: "applied" | "skipped"; providerData?: unknown }> = [];
    for (const row of rows) {
      const payload = row.afterValue as OwnerAssignPayload | undefined;
      if (!row._id || !payload) continue;
      if (!payload.crmId) {
        await ctx.runMutation(internal.ownership.patchDealOwner, { dealId: payload.dealId, userId: payload.userId, crmOwnerId: payload.value, approvedBy: args.approvedBy });
        preResults.push({ operationId: row._id, status: "applied", providerData: { detail: "Local-only deal mirror updated; no CRM write." } });
      } else if (payload.provider !== "hubspot") {
        preResults.push({ operationId: row._id, status: "skipped", providerData: { detail: `Skipped ${payload.provider ?? "unknown"} deal; owner backfill writes only the active HubSpot provider.` } });
      }
    }
    if (preResults.length > 0) await ctx.runMutation(internal.patchPlans.recordOperationResults, { results: preResults });
    const connectorRows = rows.filter((row) => {
      const payload = row.afterValue as OwnerAssignPayload | undefined;
      return Boolean(payload?.crmId && payload.provider === "hubspot");
    });
    const payloadByRowId = new Map(connectorRows.map((row) => [String(row._id), row.afterValue as OwnerAssignPayload]));

    const result = plan
      ? await applyThroughPackage(ctx, {
          connector,
          plan,
          rows: connectorRows,
          patchPlanId: args.patchPlanId,
          valueOverrides: args.valueOverrides as Record<string, unknown> | undefined,
          checkConflicts: true,
          afterResult: async (operationResult: PatchOperationResult, row) => {
            if (operationResult.status !== "applied") return;
            const payload = (row as PersistedDoOperation | undefined)?.afterValue as OwnerAssignPayload | undefined;
            if (!payload?.dealId || !payload.value || !payload.userId) return;
            await ctx.runMutation(internal.ownership.patchDealOwner, {
              dealId: payload.dealId,
              userId: payload.userId,
              crmOwnerId: payload.value,
              approvedBy: args.approvedBy,
            });
          },
        })
      : await applyLegacyRowsThroughConnector(ctx, {
          connector,
          rows: connectorRows.map((row) => {
            const payload = row.afterValue as OwnerAssignPayload | undefined;
            return { ...row, objectId: payload?.crmId ?? row.objectId, afterValue: payload?.value ?? row.afterValue };
          }),
          afterResult: async (operationResult: PatchOperationResult, row) => {
            if (operationResult.status !== "applied") return;
            const payload = row?._id ? payloadByRowId.get(String(row._id)) : undefined;
            if (!payload?.dealId || !payload.value || !payload.userId) return;
            await ctx.runMutation(internal.ownership.patchDealOwner, { dealId: payload.dealId, userId: payload.userId, crmOwnerId: payload.value, approvedBy: args.approvedBy });
          },
        });
    result.applied += preResults.filter((row) => row.status === "applied").length;
    result.skipped += preResults.filter((row) => row.status === "skipped").length;

    if (result.applied > 0) {
      await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
        orgId: args.orgId,
        trigger: "system",
      });
    }
    return result;
  },
});
