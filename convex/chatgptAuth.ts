import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";

/**
 * Per-user "Sign in with ChatGPT" state. The device-code dance and token
 * refresh live in chatgptAuthActions.ts / lib/chatgptLlm.ts; this file holds
 * the row. Public functions expose status only — tokens never leave the
 * server.
 */

async function rowFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return ctx.db
    .query("chatgptAuth")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const row = await rowFor(ctx, user._id);
    if (!row) return { status: "signed-out" as const };
    if (row.status === "pending") {
      return {
        status: "pending" as const,
        userCode: row.userCode ?? null,
        verificationUrl: row.verificationUrl ?? null,
        expiresAt: row.deviceExpiresAt ?? null,
      };
    }
    if (row.status === "connected") {
      return {
        status: "connected" as const,
        email: row.email ?? null,
        planType: row.planType ?? null,
        connectedAt: row.connectedAt ?? null,
      };
    }
    return { status: "error" as const, error: row.error ?? "ChatGPT sign-in failed." };
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const row = await rowFor(ctx, user._id);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const currentUserId = internalQuery({
  args: {},
  handler: async (ctx) => (await getCurrentUser(ctx))?._id ?? null,
});

/** Full row, encrypted tokens included. Internal only. */
export const getRow = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => rowFor(ctx, args.userId),
});

export const savePending = internalMutation({
  args: {
    userId: v.id("users"),
    deviceAuthId: v.string(),
    userCode: v.string(),
    verificationUrl: v.string(),
    pollIntervalMs: v.number(),
    deviceExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.userId);
    // Starting over replaces whatever was there, a live session included:
    // the user asked to sign in again.
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("chatgptAuth", { ...args, status: "pending", updatedAt: Date.now() });
    return null;
  },
});

const tokenFields = {
  accessToken: v.string(),
  refreshToken: v.string(),
  idToken: v.string(),
  accessTokenExpiresAt: v.optional(v.number()),
};

/** Completes a pending login. No-op if the user restarted or disconnected meanwhile. */
export const saveConnected = internalMutation({
  args: {
    userId: v.id("users"),
    expectedUserCode: v.string(),
    ...tokenFields,
    accountId: v.string(),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
  },
  handler: async (ctx, { userId, expectedUserCode, ...fields }) => {
    const row = await rowFor(ctx, userId);
    if (!row || row.status !== "pending" || row.userCode !== expectedUserCode) return false;
    const now = Date.now();
    await ctx.db.replace(row._id, { userId, status: "connected", ...fields, connectedAt: now, updatedAt: now });
    return true;
  },
});

/**
 * Store refreshed tokens. CAS on the refresh token the caller started from:
 * if a concurrent refresh already rotated it, keep the winner's tokens.
 */
export const saveRefreshed = internalMutation({
  args: { userId: v.id("users"), expectedRefreshToken: v.string(), ...tokenFields },
  handler: async (ctx, { userId, expectedRefreshToken, ...fields }) => {
    const row = await rowFor(ctx, userId);
    if (!row || row.status !== "connected" || row.refreshToken !== expectedRefreshToken) return false;
    await ctx.db.patch(row._id, { ...fields, updatedAt: Date.now() });
    return true;
  },
});

export const markError = internalMutation({
  args: {
    userId: v.id("users"),
    error: v.string(),
    // Pending login: only fail the attempt that is still current.
    expectedUserCode: v.optional(v.string()),
    // Connected session: only fail it if nobody refreshed it meanwhile.
    expectedRefreshToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, args.userId);
    if (!row) return null;
    if (args.expectedUserCode !== undefined && row.userCode !== args.expectedUserCode) return null;
    if (args.expectedRefreshToken !== undefined && row.refreshToken !== args.expectedRefreshToken) return null;
    await ctx.db.replace(row._id, {
      userId: args.userId,
      status: "error",
      error: args.error.slice(0, 300),
      updatedAt: Date.now(),
    });
    return null;
  },
});
