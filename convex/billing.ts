/**
 * The workspace's Stripe customer (Settings -> Billing). CanonCRM sells credits
 * only (convex/credits.ts, docs/credits.md); admins open the Stripe Customer
 * Portal for invoices and saved cards. The Starter subscription is retired:
 * the signed webhook still reports any subscription created before
 * (applySubscription, called from convex/http.ts) so it can end cleanly.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { appUrl } from "./lib/operatorConfig";
import { stripeClient } from "./lib/stripeBilling";

/** What Settings -> Billing shows. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const org = await ctx.db.get(user.orgId);
    if (!org) return null;
    return {
      canManage: can(user, "billing.manage"),
      configured: integrationEnabled("billing"),
      planTier: org.planTier ?? "free",
      status: org.stripeSubscriptionStatus ?? null,
      currentPeriodEnd: org.stripeCurrentPeriodEnd ?? null,
      cancelAtPeriodEnd: org.stripeCancelAtPeriodEnd ?? false,
      hasCustomer: Boolean(org.stripeCustomerId),
    };
  },
});

export const adminOrg = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!can(user, "billing.manage")) throw new ConvexError(refusal("billing.manage"));
    const org = await ctx.db.get(user.orgId);
    if (!org) throw new ConvexError("Workspace not found");
    return { orgId: org._id, name: org.name, email: user.email, stripeCustomerId: org.stripeCustomerId ?? null };
  },
});

export const setCustomer = internalMutation({
  args: { orgId: v.id("organizations"), stripeCustomerId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    // A customer is created once per org; never replace one the org already has.
    if (org && !org.stripeCustomerId) await ctx.db.patch(args.orgId, { stripeCustomerId: args.stripeCustomerId, updatedAt: Date.now() });
    return org?.stripeCustomerId ?? args.stripeCustomerId;
  },
});

/** Write a subscription's state onto the org that owns its Stripe Customer. False when no org does. */
export const applySubscription = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripeSubscriptionStatus: v.string(),
    stripePriceId: v.optional(v.string()),
    stripeCurrentPeriodEnd: v.optional(v.number()),
    stripeCancelAtPeriodEnd: v.boolean(),
    planTier: v.union(v.literal("free"), v.literal("starter"), v.literal("growth"), v.literal("enterprise")),
  },
  handler: async (ctx, { stripeCustomerId, ...billing }): Promise<boolean> => {
    const org = await ctx.db.query("organizations").withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", stripeCustomerId)).unique();
    if (!org) return false;
    // An ended subscription only downgrades the org if it is the one the org is on.
    if (billing.planTier === "free" && org.stripeSubscriptionId && org.stripeSubscriptionId !== billing.stripeSubscriptionId) return true;
    // Hand-set plans above Starter are not downgraded by a self-serve subscription.
    const planTier = org.planTier === "growth" || org.planTier === "enterprise" ? org.planTier : billing.planTier;
    await ctx.db.patch(org._id, { ...billing, planTier, updatedAt: Date.now() });
    return true;
  },
});

export async function customerFor(ctx: ActionCtx, stripe: NonNullable<ReturnType<typeof stripeClient>>, org: { orgId: Id<"organizations">; name: string; email?: string; stripeCustomerId: string | null }): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const customer = await stripe.customers.create(
    { name: org.name, ...(org.email ? { email: org.email } : {}), metadata: { canoncrm_org_id: org.orgId } },
    { idempotencyKey: `canoncrm-org-customer-${org.orgId}` },
  );
  return ctx.runMutation(internal.billing.setCustomer, { orgId: org.orgId, stripeCustomerId: customer.id });
}

export function origin(): string {
  const url = appUrl();
  if (!url) throw new ConvexError("This deployment doesn't know its web address (set APP_URL).");
  return url;
}

/** A Customer Portal session: the workspace's invoices and saved cards. */
export const openPortal = action({
  args: {},
  handler: async (ctx): Promise<{ url: string | null }> => {
    if (!integrationEnabled("billing")) return { url: null };
    const stripe = stripeClient();
    if (!stripe) throw new ConvexError("Billing isn't configured on this deployment.");
    const org = await ctx.runQuery(internal.billing.adminOrg, {});
    if (!org.stripeCustomerId) throw new ConvexError("This workspace has no billing account yet. Subscribe first.");
    const session = await stripe.billingPortal.sessions.create({ customer: org.stripeCustomerId, return_url: `${origin()}/dashboard/settings/billing` });
    return { url: session.url };
  },
});
