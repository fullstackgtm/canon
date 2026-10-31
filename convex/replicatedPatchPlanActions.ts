"use node";

import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { connectorForOrg as hubspotConnectorForOrg } from "./hubspotActions";
import { connectorForOrg as salesforceConnectorForOrg } from "./salesforceActions";
import { applyThroughPackage, patchPlanFromDocument } from "./lib/applyThroughPackage";
import type { Id } from "./_generated/dataModel";

type HostedApplyResult = {
  applied: number;
  skipped: number;
  failed: number;
  conflicts: number;
  firstErrors: string[];
  provider: "hubspot" | "salesforce";
};

/** Execute a fully mirrored CLI plan through the organization's hosted CRM. */
export const applyInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    patchPlanId: v.id("patchPlans"),
    operations: v.array(v.any()),
    document: v.any(),
    valueOverrides: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<HostedApplyResult> => {
    const plan = patchPlanFromDocument(args.document);
    if (!plan) throw new ConvexError("The CLI plan has not fully synchronized its immutable document.");
    const provider: "hubspot" | "salesforce" | null = await ctx.runQuery(
      internal.integrations.activeCrmProviderForOrg,
      { orgId: args.orgId },
    );
    if (!provider) throw new ConvexError("Connect HubSpot or Salesforce before applying from hosted.");
    const connector = provider === "salesforce"
      ? (await salesforceConnectorForOrg(ctx, args.orgId)).connector
      : await hubspotConnectorForOrg(ctx, args.orgId);
    if (!connector.applyOperation) {
      throw new ConvexError(`The hosted ${provider} connector cannot execute this plan.`);
    }
    const result = await applyThroughPackage(ctx, {
      connector,
      plan,
      rows: args.operations as Array<{ _id?: Id<"patchOperations">; packageOpId?: string }>,
      patchPlanId: args.patchPlanId,
      valueOverrides: args.valueOverrides as Record<string, unknown> | undefined,
      checkConflicts: true,
    });
    if (result.applied > 0) {
      const syncAction = provider === "salesforce"
        ? internal.salesforceActions.syncAllInternal
        : internal.hubspotActions.syncAllInternal;
      await ctx.scheduler.runAfter(0, syncAction, { orgId: args.orgId, trigger: "system" });
    }
    return { ...result, provider };
  },
});
