import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { requireUser } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";

/**
 * Stripe billing integration state. Stripe is the revenue source of truth for
 * a consultancy org: a restricted key (read-only on invoices/customers) lets
 * the app compare CRM bookings against paid invoices and drive the governed
 * closed-won backfill (see stripeActions.ts). Key validation happens in the
 * action layer (mutations cannot fetch); this module only stores state.
 */

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
