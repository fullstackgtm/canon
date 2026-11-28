import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getCurrentUser, requireUser } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";

/**
 * Stripe billing integration state. Stripe is the revenue source of truth for
 * a consultancy org: a restricted key (read-only on invoices/customers) lets
 * the app compare CRM bookings against paid invoices and drive the governed
 * closed-won backfill (see stripeActions.ts). Key validation happens in the
 * action layer (mutations cannot fetch); this module only stores state.
 *
 * Two ways in: the Canon CRM Stripe App's OAuth install (click-through,
 * read-only permissions; stripe-app/stripe-app.json), or a pasted restricted
 * key as a fallback. An OAuth row has `tokenExpiresAt` set and refreshes
 * through `refreshToken`; a key row has no expiry.
 */

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** True when this deployment has the Stripe App's OAuth client configured. */
export function stripeOAuthConfigured(): boolean {
  return Boolean(process.env.STRIPE_APP_CLIENT_ID && process.env.STRIPE_APP_OAUTH_KEY);
}

export const getIntegration = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", "stripe"),
      )
      .first();
  },
});

/** Whether Stripe is connected, and how many contracts the last import mirrored. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { connected: false, contracts: 0, oauthAvailable: false, method: null };
    const row = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", user.orgId).eq("provider", "stripe"))
      .first();
    const contracts = await ctx.db
      .query("revenueContracts")
      .withIndex("by_orgId_and_stripeSubscriptionId", (q) => q.eq("orgId", user.orgId))
      .take(1000);
    return {
      connected: Boolean(row?.isActive),
      contracts: contracts.length,
      oauthAvailable: stripeOAuthConfigured(),
      method: row?.isActive ? (row.tokenExpiresAt ? ("oauth" as const) : ("key" as const)) : null,
      account: row?.isActive ? (row.displayName ?? row.externalOrgId ?? null) : null,
    };
  },
});

export const store = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    secretKey: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptForStorage(args.secretKey);
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", "stripe"),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: encrypted,
        refreshToken: await encryptForStorage(""),
        tokenExpiresAt: undefined,
        scopes: undefined,
        isActive: true,
        connectedBy: args.userId,
        connectedAt: now,
        updatedAt: now,
        lastSyncError: undefined,
      });
      return existing._id;
    }
    return ctx.db.insert("integrations", {
      orgId: args.orgId,
      provider: "stripe",
      accessToken: encrypted,
      refreshToken: await encryptForStorage(""),
      isActive: true,
      connectedBy: args.userId,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", "stripe"),
      )
      .first();
    if (!existing) return { disconnected: false };
    await ctx.db.patch(existing._id, {
      isActive: false,
      updatedAt: Date.now(),
    });
    return { disconnected: true };
  },
});

export const createOAuthState = internalMutation({
  args: { state: v.string(), orgId: v.id("organizations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("oauthStates", {
      state: args.state,
      orgId: args.orgId,
      userId: args.userId,
      provider: "stripe",
      createdAt: now,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });
  },
});

/** One-time: the state row is deleted whether or not it is valid. */
export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
    if (!record) return null;
    await ctx.db.delete("oauthStates", record._id);
    if (record.provider !== "stripe" || !record.userId) return null;
    if (record.expiresAt && Date.now() > record.expiresAt) return null;
    return { orgId: record.orgId, userId: record.userId };
  },
});

/** Save an OAuth install's tokens (the code exchange or a refresh). */
export const storeOAuthTokens = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.optional(v.id("users")),
    accessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    stripeAccountId: v.optional(v.string()),
    livemode: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", "stripe"))
      .first();
    const tokens = {
      accessToken: await encryptForStorage(args.accessToken),
      refreshToken: await encryptForStorage(args.refreshToken),
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: ["stripe_apps"],
      updatedAt: now,
    };
    if (!args.userId) {
      // A refresh: only the tokens change.
      if (existing) await ctx.db.patch(existing._id, tokens);
      return existing?._id ?? null;
    }
    const install = {
      ...tokens,
      isActive: true,
      connectedBy: args.userId,
      connectedAt: now,
      lastSyncError: undefined,
      ...(args.stripeAccountId ? { externalOrgId: args.stripeAccountId } : {}),
      ...(args.livemode === false ? { displayName: "Test mode" } : { displayName: undefined }),
    };
    if (existing) {
      await ctx.db.patch(existing._id, install);
      return existing._id;
    }
    return ctx.db.insert("integrations", {
      orgId: args.orgId,
      provider: "stripe",
      ...install,
      createdAt: now,
    });
  },
});
