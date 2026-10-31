"use node";

import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { applyDecision, requiredString } from "./lib/patchPlanGuards";
import { MODULE_RECORDS } from "../modules/kernel/proposals.ts";

export const apply = action({
  args: { patchPlanId: v.id("patchPlans") },
  handler: async (ctx, args): Promise<unknown> => {
    const context = await ctx.runQuery(internal.patchPlans.getApplyContextInternal, {
      patchPlanId: args.patchPlanId,
    });
    const { plan, deal, operations, document, valueOverrides } = context;

    // Writes always go through an explicit approval, regardless of the plan's
    // approvalRequirement flag — a provider mutation never happens from a
    // draft.
    const decision = applyDecision(plan);
    if (decision.kind === "already_applied") {
      return { patchPlanId: args.patchPlanId, status: "applied", alreadyApplied: true };
    }
    if (decision.kind === "blocked") {
      throw new ConvexError(decision.reason);
    }

    const approvedIds = new Set(plan.approvedOperationIds ?? []);
    const approvedOperations = (operations ?? []).filter((operation: any) =>
      typeof operation.packageOpId === "string" && approvedIds.has(operation.packageOpId),
    );
    if (approvedOperations.length === 0) throw new ConvexError("This plan has no approved operations.");

    // Claim after the immutable document and approval have been validated.
    // Convex mutations serialize competing claims, so only one online replica
    // enters connector capability checks and the provider write path.
    const claim = await ctx.runMutation(internal.patchPlans.claimHostedApply, { patchPlanId: args.patchPlanId });
    if (claim.alreadyApplied) return { patchPlanId: args.patchPlanId, status: "applied", alreadyApplied: true };
    if (!claim.claimId) throw new ConvexError("Unable to claim patch plan apply.");

    if (plan.operation === "cli.patch_plan") {
      try {
        const providerResult = await ctx.runAction(internal.replicatedPatchPlanActions.applyInternal, {
          orgId: plan.orgId,
          patchPlanId: args.patchPlanId,
          operations: approvedOperations,
          document,
          valueOverrides: valueOverrides ?? undefined,
        });
        const result = await ctx.runMutation(internal.patchPlans.apply, {
          patchPlanId: args.patchPlanId,
          providerResult,
          alreadyDispatched: true,
          claimId: claim.claimId,
        });
        return { ...asObject(result), providerResult };
      } catch (error) {
        await ctx.runMutation(internal.patchPlans.recordApplyFailure, {
          patchPlanId: args.patchPlanId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    // A module's proposed write to Canon's records: each approved row, as the person applying it, CAS on its version.
    if (plan.operation === MODULE_RECORDS) {
      try {
        const providerResult = await ctx.runAction(internal.moduleRecords.applyInternal, {
          patchPlanId: args.patchPlanId, claimId: claim.claimId,
        });
        const result = await ctx.runMutation(internal.patchPlans.apply, { patchPlanId: args.patchPlanId, providerResult, alreadyDispatched: true, claimId: claim.claimId });
        return { ...asObject(result), providerResult };
      } catch (error) {
        await ctx.runMutation(internal.patchPlans.recordApplyFailure, {
          patchPlanId: args.patchPlanId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    // `do` operations need an action context; dispatch them through the
    // internal registry — this path only runs AFTER the approval decision
    // above, so the public gtm.doAction dry_run-only gate stays intact.
    if (plan.verb === "do") {
      try {
        const doResult = await ctx.runAction(internal.gtm.applyDoInternal, {
          action: plan.operation,
          args: plan.args ?? {},
          operations: approvedOperations.map((operation: any) => ({
            _id: operation._id,
            objectType: operation.objectType,
            objectId: operation.objectId,
            fieldOrAction: operation.fieldOrAction,
            beforeValue: operation.beforeValue,
            afterValue: operation.afterValue,
            reason: operation.reason,
            sourceRuleOrPolicy: operation.sourceRuleOrPolicy,
            rollback: operation.rollback,
            packageOpId: operation.packageOpId,
          })),
          planDocument: document ?? undefined,
          patchPlanId: args.patchPlanId,
          valueOverrides: valueOverrides ?? undefined,
        });
        const result = await ctx.runMutation(internal.patchPlans.apply, {
          patchPlanId: args.patchPlanId,
          providerResult: doResult ?? null,
          alreadyDispatched: true,
          claimId: claim.claimId,
        });
        return { ...asObject(result), providerResult: doResult ?? null };
      } catch (error) {
        await ctx.runMutation(internal.patchPlans.recordApplyFailure, {
          patchPlanId: args.patchPlanId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    // CRM-native field write-back: deal.next_step lives only in the CRM, so
    // push it to the provider in addition to the Convex apply. Other set
    // operations are governed in Convex (the operating model's source of
    // record) and propagate to the CRM through the sync layer.
    let providerResult: unknown = null;
    try {
      if (plan.verb === "set" && plan.operation === "deal.next_step") {
        if (!deal) throw new ConvexError("Deal not found");
        const nextStep = requiredString(plan.args, "nextStep");
        if (deal.crmId && deal.crmProvider === "hubspot") {
          providerResult = await ctx.runAction(internal.hubspotActions.patchDealNextStep, {
            orgId: plan.orgId,
            crmId: deal.crmId,
            nextStep,
          });
        } else if (deal.crmId && deal.crmProvider === "salesforce") {
          providerResult = await ctx.runAction(internal.salesforceActions.patchDealNextStep, {
            orgId: plan.orgId,
            crmId: deal.crmId,
            nextStep,
          });
        } else {
          providerResult = { provider: "local", reason: "Deal has no supported CRM provider metadata" };
        }
      }

      // Convex-side apply for every `set` operation, dispatched through the
      // shared registry inside the mutation.
      const result = await ctx.runMutation(internal.patchPlans.apply, {
        patchPlanId: args.patchPlanId,
        providerResult,
        claimId: claim.claimId,
      });
      return { ...asObject(result), providerResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.patchPlans.recordApplyFailure, {
        patchPlanId: args.patchPlanId,
        error: message,
        providerResult,
      });
      throw error;
    }
  },
});

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
}
