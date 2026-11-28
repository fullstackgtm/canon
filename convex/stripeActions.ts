"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { connectorForOrg } from "./hubspotActions";
import { snapshotFromPages } from "./hygiene";
import {
  fetchStripeRevenue,
  type StripeConnectorOptions,
} from "../engine/src/connectors/stripe.ts";
import {
  bookableContracts,
  buildRevenueContracts,
  type RevenueImport,
  type StripeRevenueInvoice,
} from "../engine/src/revenueContracts.ts";
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

/**
 * Stripe → revenue contracts and closed-won backfill, app-side
 * (docs/revenue-contracts.md). Stripe is the revenue source of truth; these
 * actions read subscriptions and invoices, mirror them as contracts (one per
 * subscription, invoices attached), and drive the governed backfill, which
 * books ONE closed-won deal per subscription, never one per invoice:
 *
 *   preview (read-only, no writes anywhere)
 *     → approval in the normal patch-plan flow
 *       → apply (resolve-first deal creates in the CRM, deduped by subscription id)
 *
 * The plan builder and connectors are the open-source package's — the app
 * only supplies credentials and the approval surface.
 */

const STRIPE_VALIDATE_PATH = "/v1/customers?limit=1";
const UPSERT_BATCH = 100;

/** Stripe subscriptions + invoices grouped into contracts (read-only). */
async function readRevenue(options: StripeConnectorOptions): Promise<RevenueImport> {
  const { subscriptions, invoices } = await fetchStripeRevenue(options);
  return buildRevenueContracts(subscriptions, invoices);
}

/** The contracts a backfill books: real commitments, optionally started on/after `sinceIso`. */
function backfillInputs(revenue: RevenueImport, sinceIso?: string) {
  const since = sinceIso?.slice(0, 10);
  return {
    contracts: bookableContracts(revenue.contracts).filter((c) => !since || (c.startDate ?? "") >= since),
    unattachedInvoices: revenue.unattached,
  };
}

async function requireManagerUser(ctx: any) {
  const user = await ctx.runQuery(internal.users.currentUser, {});
  if (!user) throw new ConvexError("User not found");
  if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return user;
}

const STRIPE_INSTALL_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
const STRIPE_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConvexError(`${name} is not configured`);
  return value;
}

/** Where Stripe sends the install back: this deployment's HTTP actions. */
function callbackUrl(): string {
  return `${requiredEnv("CONVEX_SITE_URL").replace(/\/$/, "")}/api/stripe/callback`;
}

type StripeTokenResponse = {
  access_token: string;
  refresh_token: string;
  stripe_user_id?: string;
  livemode?: boolean;
  expires_in?: number;
};

/**
 * POST /v1/oauth/token, authenticated with the app developer's key
 * (STRIPE_APP_OAUTH_KEY: a Canon CRM account restricted key with Connect
 * OAuth write). Status only on failure: the body can echo the grant.
 */
async function stripeToken(params: Record<string, string>): Promise<StripeTokenResponse> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${requiredEnv("STRIPE_APP_OAUTH_KEY")}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw new ConvexError(`Stripe OAuth token request failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as StripeTokenResponse;
}

/** Stripe App access tokens last one hour. */
function expiresAt(token: StripeTokenResponse): number {
  return Date.now() + (token.expires_in ?? 3600) * 1000;
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
  let apiKey = await decryptFromStorage(integration.accessToken);
  // An OAuth install expires hourly; a pasted key has no expiry.
  if (integration.tokenExpiresAt && Date.now() > integration.tokenExpiresAt - REFRESH_MARGIN_MS) {
    apiKey = await refreshAccessToken(ctx, orgId, integration);
  }
  return { getApiKey: () => apiKey };
}

/**
 * Refresh an OAuth install. Stripe rotates the refresh token on every
 * exchange, so the new one is saved before the access token is used. Two
 * refreshes racing: the loser's exchange fails on the already-rotated token,
 * and it takes the winner's fresh access token instead.
 */
async function refreshAccessToken(ctx: any, orgId: Id<"organizations">, integration: any): Promise<string> {
  try {
    const token = await stripeToken({
      grant_type: "refresh_token",
      refresh_token: await decryptFromStorage(integration.refreshToken),
    });
    await ctx.runMutation(internal.stripe.storeOAuthTokens, {
      orgId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: expiresAt(token),
    });
    return token.access_token;
  } catch (error) {
    // The winner may still be saving its tokens: wait for them, briefly.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const latest = await ctx.runQuery(internal.stripe.getIntegration, { orgId });
      if (latest?.isActive && latest.tokenExpiresAt && latest.tokenExpiresAt > Date.now() + REFRESH_MARGIN_MS) {
        return decryptFromStorage(latest.accessToken);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ConvexError(
      error instanceof ConvexError
        ? "Stripe access expired and could not be renewed. Connect Stripe again."
        : "Stripe access could not be renewed.",
    );
  }
}

/**
 * Start the click-through install: the Stripe App's install page, asking
 * for its read-only permissions. STRIPE_APP_INSTALL_URL overrides the public
 * link with an external-testing link while the app is unreviewed.
 */
export const getAuthUrl = action({
  args: {},
  handler: async (ctx): Promise<{ authUrl: string }> => {
    const user = await requireManagerUser(ctx);
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.runMutation(internal.stripe.createOAuthState, { state, orgId: user.orgId, userId: user._id });
    const params = new URLSearchParams({
      client_id: requiredEnv("STRIPE_APP_CLIENT_ID"),
      redirect_uri: callbackUrl(),
      state,
    });
    const base = process.env.STRIPE_APP_INSTALL_URL || STRIPE_INSTALL_URL;
    return { authUrl: `${base}${base.includes("?") ? "&" : "?"}${params.toString()}` };
  },
});

/** The install callback: consume the one-time state, exchange the code, save the tokens. */
export const exchangeCodeInternal = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<{ ok: true } | { error: string }> => {
    const grant = await ctx.runMutation(internal.stripe.consumeOAuthState, { state: args.state });
    if (!grant) return { error: "stripe_invalid_state" };
    const token = await stripeToken({ grant_type: "authorization_code", code: args.code });
    await ctx.runMutation(internal.stripe.storeOAuthTokens, {
      orgId: grant.orgId,
      userId: grant.userId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: expiresAt(token),
      stripeAccountId: token.stripe_user_id,
      livemode: token.livemode,
    });
    return { ok: true };
  },
});

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
 * Dry-run: Stripe contracts vs the synced CRM. Returns the would-be plan summary
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
    contractCount: number;
    operationCount: number;
    unattachedInvoices: StripeRevenueInvoice[];
    summary: string;
    unmatched: StripeBackfillUnmatched[];
    proposedAccounts: StripeBackfillProposedAccount[];
    operations: Array<{ id: string; objectId?: string; reason: string }>;
  }> => {
    const user = await requireManagerUser(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "the Stripe backfill over the CRM" });
    const options = await stripeOptionsForOrg(ctx, user.orgId);

    const { contracts, unattachedInvoices } = backfillInputs(await readRevenue(options), args.sinceIso);
    const snapshot = await snapshotFromPages(ctx, user.orgId);
    const { plan, unmatched, proposedAccounts } = buildStripeBackfillPlan(
      contracts,
      snapshot,
      { pipeline: args.pipeline, unattachedInvoices },
    );

    return {
      contractCount: contracts.length,
      unattachedInvoices,
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

    const { contracts, unattachedInvoices } = backfillInputs(await readRevenue(options), args.sinceIso);
    const snapshot = await snapshotFromPages(ctx, user.orgId);
    const { plan, unmatched, proposedAccounts } = buildStripeBackfillPlan(
      contracts,
      snapshot,
      { pipeline: args.pipeline, unattachedInvoices },
    );
    if (plan.operations.length === 0) {
      throw new ConvexError(
        "Nothing to backfill: every Stripe subscription already has a matching deal (or its customer has no usable identity).",
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
 * create (subscription-id property for deals, domain-then-name for accounts), so
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
 * Resolve-first per subscription id — the connector re-checks the dedupe key at
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

    const { contracts, unattachedInvoices } = backfillInputs(await readRevenue(options), args.sinceIso);
    const snapshot = await snapshotFromPages(ctx, args.orgId);
    const { plan, unmatched } = buildStripeBackfillPlan(contracts, snapshot, {
      pipeline: args.pipeline,
      unattachedInvoices,
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

/**
 * Mirror Stripe into Canon's revenue tables: one contract per subscription,
 * every invoice attached to its contract. Read-only on Stripe; idempotent
 * (upserts keyed by Stripe ids). Creates no deals: bookings go through the
 * governed backfill plan above.
 */
export const importRevenue = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ contracts: number; invoices: number; attached: number; unattached: number }> => {
    const user = await requireManagerUser(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "the Stripe revenue import" });
    const options = await stripeOptionsForOrg(ctx, user.orgId);
    const revenue = await readRevenue(options);
    const importedAt = Date.now();

    for (let i = 0; i < revenue.contracts.length; i += UPSERT_BATCH) {
      await ctx.runMutation(internal.revenueContracts.upsertContractsInternal, {
        orgId: user.orgId,
        importedAt,
        contracts: revenue.contracts.slice(i, i + UPSERT_BATCH).map((c) => ({
          stripeSubscriptionId: c.stripeSubscriptionId,
          stripeCustomerId: c.customerId,
          customerName: c.customerName,
          customerEmail: c.customerEmail,
          customerDomain: c.customerDomain,
          status: c.status,
          stripeStatus: c.stripeStatus,
          startDate: c.startDate,
          endDate: c.endDate,
          currency: c.currency,
          mrr: c.mrr,
          arr: c.arr,
          billingInterval: c.billingInterval,
          lines: c.lines,
          billed: c.billed,
          collected: c.collected,
          outstanding: c.outstanding,
          invoiceCount: c.invoiceIds.length,
          firstInvoiceAt: c.firstInvoiceAt,
          lastInvoiceAt: c.lastInvoiceAt,
        })),
      });
    }
    for (let i = 0; i < revenue.invoices.length; i += UPSERT_BATCH) {
      await ctx.runMutation(internal.revenueContracts.upsertInvoicesInternal, {
        orgId: user.orgId,
        importedAt,
        invoices: revenue.invoices.slice(i, i + UPSERT_BATCH).map((invoice) => ({
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: invoice.contractSubscriptionId,
          stripeCustomerId: invoice.customerId,
          customerName: invoice.customerName,
          customerDomain: invoice.customerDomain,
          number: invoice.number,
          status: invoice.status,
          amountDue: invoice.amountDue,
          amountPaid: invoice.amountPaid,
          amountRemaining: invoice.amountRemaining,
          currency: invoice.currency,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          dueDate: invoice.dueDate,
          paidAt: invoice.paidAt,
          createdDate: invoice.createdAt,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        })),
      });
    }
    return {
      contracts: revenue.contracts.length,
      invoices: revenue.invoices.length,
      attached: revenue.invoices.length - revenue.unattached.length,
      unattached: revenue.unattached.length,
    };
  },
});
