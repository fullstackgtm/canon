"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { connectorForOrg } from "./hubspotActions";
import { snapshotFromPages } from "./hygiene";
import {
  fetchStripePaidInvoices,
  type StripeConnectorOptions,
} from "../engine/src/connectors/stripe.ts";
import {
  buildStripeBackfillPlan,
  type StripeBackfillProposedAccount,
  type StripeBackfillUnmatched,
} from "../engine/src/backfill.ts";
import { suggestValues } from "../engine/src/suggest.ts";
import { applyLegacyRowsThroughConnector, applyThroughPackage, patchPlanFromDocument } from "./lib/applyThroughPackage";
import type { PatchPlan } from "../engine/src/types.ts";
import type { PersistedDoOperation } from "./gtm";
import type { Id } from "./_generated/dataModel";
import { activeClerkOrgIdFromIdentity } from "./lib";

/**
 * Stripe → closed-won backfill, app-side. Stripe is the revenue source of
 * truth; these actions read PAID invoices and drive the governed backfill:
 *
 *   preview (read-only, no writes anywhere)
 *     → approval in the normal patch-plan flow
 *       → apply (resolve-first deal creates in the CRM, deduped by invoice id)
 *
 * The plan builder and connectors are the open-source package's — the app
 * only supplies credentials and the approval surface.
 */

const STRIPE_VALIDATE_PATH = "/v1/customers?limit=1";

async function requireManagerUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
    clerkUserId: identity.subject,
    activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
  });
  if (!user) throw new ConvexError("User not found");
  if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return user;
}

async function stripeOptionsForOrg(
  ctx: any,
  orgId: Id<"organizations">,
): Promise<StripeConnectorOptions> {
  const integration = await ctx.runQuery(internal.stripe.getIntegration, {
    orgId,
  });
  if (!integration || !integration.isActive) {
    throw new ConvexError("No active Stripe integration. Connect Stripe first.");
  }
  const apiKey = await decryptFromStorage(integration.accessToken);
  return { getApiKey: () => apiKey };
}

/**
 * Connect Stripe with a restricted (read-only) or secret key. Validates the
 * key against the live API before storing it encrypted.
 */
export const connect = action({
  args: { secretKey: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const user = await requireManagerUser(ctx);

    const key = args.secretKey.trim();
    if (!key.startsWith("sk_") && !key.startsWith("rk_")) {
      throw new ConvexError(
        "That doesn't look like a Stripe secret or restricted key (sk_... / rk_...).",
      );
    }
    const response = await fetch(`https://api.stripe.com${STRIPE_VALIDATE_PATH}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      // Status only — never echo a response body tied to a live billing key.
      throw new ConvexError(
        `Stripe rejected the key (HTTP ${response.status}). Check the key and its permissions.`,
      );
    }

    await ctx.runMutation(internal.stripe.store, {
      orgId: user.orgId,
      userId: user._id,
      secretKey: key,
    });
    return { ok: true };
  },
});

/**
 * Dry-run: paid invoices vs the synced CRM. Returns the would-be plan summary
 * plus unmatched customers. Writes nothing.
 */
export const backfillPreview = action({
  args: {
    sinceIso: v.optional(v.string()),
    pipeline: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    invoiceCount: number;
    operationCount: number;
    summary: string;
    unmatched: StripeBackfillUnmatched[];
    proposedAccounts: StripeBackfillProposedAccount[];
    operations: Array<{ id: string; objectId?: string; reason: string }>;
  }> => {
    const user = await requireManagerUser(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "the Stripe backfill over the CRM" });
    const options = await stripeOptionsForOrg(ctx, user.orgId);

    const invoices = await fetchStripePaidInvoices(options, {
      sinceIso: args.sinceIso,
    });
    const snapshot = await snapshotFromPages(ctx, user.orgId);
    const { plan, unmatched, proposedAccounts } = buildStripeBackfillPlan(
      invoices,
      snapshot,
      { pipeline: args.pipeline },
    );

    return {
      invoiceCount: invoices.length,
      operationCount: plan.operations.length,
      summary: plan.summary,
      unmatched,
      proposedAccounts,
      operations: plan.operations.map((op) => ({
        id: op.id,
        objectId: op.objectId,
        reason: op.reason,
      })),
    };
  },
});

/**
 * Create the governed backfill patch plan WITH its full reviewed operation
 * list — every deal and account create is persisted as its own patchOperations
 * row, so the Patch Plans page shows exactly what will run and apply executes
 * exactly what was approved (not a recomputation).
 */
export const proposeBackfillPlan = action({
  args: {
    sinceIso: v.optional(v.string()),
    pipeline: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    patchPlanId: unknown;
    operationCount: number;
    summary: string;
    unmatched: StripeBackfillUnmatched[];
    proposedAccounts: StripeBackfillProposedAccount[];
  }> => {
    const user = await requireManagerUser(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "the Stripe backfill over the CRM" });
    const options = await stripeOptionsForOrg(ctx, user.orgId);

    const invoices = await fetchStripePaidInvoices(options, {
      sinceIso: args.sinceIso,
    });
    const snapshot = await snapshotFromPages(ctx, user.orgId);
    const { plan, unmatched, proposedAccounts } = buildStripeBackfillPlan(
      invoices,
      snapshot,
      { pipeline: args.pipeline },
    );
    if (plan.operations.length === 0) {
      throw new ConvexError(
        "Nothing to backfill: every paid invoice already has a matching deal (or its customer has no usable identity).",
      );
    }
    // Write-cap protection: each operation is a patchOperations row, and a
    // plan this size strains review and the apply transaction alike.
    if (plan.operations.length > 2000) {
      throw new ConvexError(
        `This backfill would create ${plan.operations.length} operations, over the 2000-operation review/apply cap. Narrow the range with the since-date (sinceIso) and run it in slices.`,
      );
    }

    const suggestionsByOperationId = new Map(suggestValues(plan, snapshot).map((suggestion) => [suggestion.operationId, suggestion]));
    const persisted = await ctx.runMutation(internal.gtm.persistDoPlanInternal, {
      userId: user._id,
      operation: "backfill.stripe",
      args: {
        ...(args.sinceIso ? { sinceIso: args.sinceIso } : {}),
        ...(args.pipeline ? { pipeline: args.pipeline } : {}),
      },
      reason: args.reason ?? plan.summary,
      operations: plan.operations.map((operation) => ({
        objectType: operation.objectType,
        objectId: operation.objectId,
        fieldOrAction: operation.field ?? operation.operation,
        beforeValue: operation.beforeValue ?? null,
        afterValue: operation.afterValue,
        reason: operation.reason,
        sourceRuleOrPolicy: operation.sourceRuleOrPolicy,
        riskLevel: operation.riskLevel,
        approvalRequirement: "required",
        rollback: operation.rollback,
        packageOpId: operation.id,
        suggestion: suggestionsByOperationId.get(operation.id),
      })),
      document: JSON.parse(JSON.stringify(plan)),
    });

    return {
      patchPlanId: (persisted as { patchPlanId?: unknown }).patchPlanId,
      operationCount: plan.operations.length,
      summary: plan.summary,
      unmatched,
      proposedAccounts,
    };
  },
});

/**
 * Apply EXACTLY the persisted, approved operations of a backfill plan.
 * INTERNAL-ONLY: reached solely through patchPlanActions.apply →
 * gtm.applyDoInternal after the approval decision. Resolve-first on every
 * create (invoice-id property for deals, domain-then-name for accounts), so
 * re-running never double-creates.
 */
export const backfillApplyOpsInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    operations: v.array(v.any()),
    planDocument: v.optional(v.any()),
    patchPlanId: v.optional(v.id("patchPlans")),
    valueOverrides: v.optional(v.any()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ applied: number; skipped: number; failed: number; conflicts: number; firstErrors?: string[] }> => {
    const connector = await connectorForOrg(ctx, args.orgId);
    const plan = patchPlanFromDocument(args.planDocument);
    const rows = args.operations as Array<PersistedDoOperation & { _id?: Id<"patchOperations"> }>;
    const result = plan
      ? await applyThroughPackage(ctx, {
          connector,
          plan: plan as PatchPlan,
          rows,
          patchPlanId: args.patchPlanId,
          valueOverrides: args.valueOverrides as Record<string, unknown> | undefined,
          checkConflicts: true,
        })
      : await applyLegacyRowsThroughConnector(ctx, { connector, rows });

    // Refresh the CRM mirror so the new records show up in Revenue/Home.
    await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
      orgId: args.orgId,
      trigger: "system",
    });

    return result;
  },
});

/**
 * Execute the backfill against the CRM by recomputing from Stripe + the CRM
 * snapshot. INTERNAL-ONLY fallback for legacy arg-only plans; new plans carry
 * persisted operations and go through backfillApplyOpsInternal instead.
 * Resolve-first per invoice id — the connector re-checks the dedupe key at
 * apply time, so re-running never double-creates.
 */
export const backfillApplyInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    sinceIso: v.optional(v.string()),
    pipeline: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    applied: number;
    skipped: number;
    failed: number;
    unmatched: StripeBackfillUnmatched[];
  }> => {
    const options = await stripeOptionsForOrg(ctx, args.orgId);

    const invoices = await fetchStripePaidInvoices(options, {
      sinceIso: args.sinceIso,
    });
    const snapshot = await snapshotFromPages(ctx, args.orgId);
    const { plan, unmatched } = buildStripeBackfillPlan(invoices, snapshot, {
      pipeline: args.pipeline,
    });

    const connector = await connectorForOrg(ctx, args.orgId);
    const results = [];
    for (const operation of plan.operations) {
      results.push(await connector.applyOperation!(operation));
    }

    const applied = results.filter((r) => r.status === "applied").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter(
      (r) => r.status !== "applied" && r.status !== "skipped",
    ).length;

    // Refresh the CRM mirror so the new deals show up in Revenue/Home.
    await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
      orgId: args.orgId,
      trigger: "system",
    });

    return { applied, skipped, failed, unmatched };
  },
});
