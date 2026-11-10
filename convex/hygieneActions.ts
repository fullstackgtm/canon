"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { connectorForOrg as hubspotConnectorForOrg } from "./hubspotActions";
import { connectorForOrg as salesforceConnectorForOrg } from "./salesforceActions";
import { applyLegacyRowsThroughConnector, applyThroughPackage, patchPlanFromDocument } from "./lib/applyThroughPackage";
import type { Id } from "./_generated/dataModel";
import type { PersistedDoOperation } from "./gtm";

type OperationRow = PersistedDoOperation & { _id?: Id<"patchOperations">; beforeValue?: unknown; status?: string };

type AnyConnector =
  | Awaited<ReturnType<typeof hubspotConnectorForOrg>>
  | Awaited<ReturnType<typeof salesforceConnectorForOrg>>["connector"];

type Provider = "hubspot" | "salesforce";

/** The plan's own CRM when it names one (orgs with both connected), else the one active CRM. */
async function connectorFor(ctx: ActionCtx, orgId: Id<"organizations">, named?: Provider): Promise<{ provider: Provider; connector: AnyConnector }> {
  const provider: Provider = named ?? (await ctx.runQuery(internal.integrations.activeCrmProviderForOrg, { orgId }));
  return {
    provider,
    connector: provider === "salesforce" ? (await salesforceConnectorForOrg(ctx, orgId)).connector : await hubspotConnectorForOrg(ctx, orgId),
  };
}

export const applyOperationsInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    provider: v.optional(v.union(v.literal("hubspot"), v.literal("salesforce"))),
    operations: v.array(v.any()),
    planDocument: v.optional(v.any()),
    patchPlanId: v.optional(v.id("patchPlans")),
    valueOverrides: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ applied: number; skipped: number; failed: number; conflicts: number; firstErrors: string[] }> => {
    const plan = patchPlanFromDocument(args.planDocument);
    const { provider, connector } = await connectorFor(ctx, args.orgId, args.provider);
    const rows = args.operations as OperationRow[];
    const result = plan
      ? await applyThroughPackage(ctx, {
          connector,
          plan,
          rows,
          patchPlanId: args.patchPlanId,
          valueOverrides: args.valueOverrides as Record<string, unknown> | undefined,
          checkConflicts: true,
        })
      : await applyLegacyRowsThroughConnector(ctx, { connector, rows });
    if (result.applied > 0) {
      await ctx.scheduler.runAfter(0, provider === "salesforce" ? internal.salesforceActions.syncAllInternal : internal.hubspotActions.syncAllInternal, {
        orgId: args.orgId,
        trigger: "system",
      });
    }
    return result;
  },
});
