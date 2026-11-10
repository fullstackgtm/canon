/**
 * Deepline connection: the workspace's own API key (bring your own key), so
 * Find email runs Deepline's email waterfall first (records.findEmail) and
 * Deepline bills the workspace's Deepline account. Canon charges no credits for
 * it. The key is stored like Explee's and Instantly's: encrypted on the
 * `integrations` row, decrypted only inside actions, never returned.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";
import { createDeeplineClient, DeeplineError } from "./lib/deepline";

const deeplineRow = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "deepline")).first();

/** Whether Deepline is connected: never the key. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const row = user && (await deeplineRow(ctx, user.orgId));
    return { connected: Boolean(row?.isActive), connectedAt: row?.connectedAt ?? null };
  },
});

/** The encrypted key, for actions only; null when Deepline is not connected. */
export const apiKey = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await deeplineRow(ctx, args.orgId);
    return row?.isActive ? row.accessToken : null;
  },
});

export const storeKey = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), apiKey: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptForStorage(args.apiKey);
    const existing = await deeplineRow(ctx, args.orgId);
    if (existing) {
      await ctx.db.patch(existing._id, { accessToken: encrypted, isActive: true, connectedBy: args.userId, connectedAt: now, updatedAt: now });
      return;
    }
    await ctx.db.insert("integrations", {
      orgId: args.orgId, provider: "deepline", accessToken: encrypted, refreshToken: await encryptForStorage(""),
      isActive: true, connectedBy: args.userId, connectedAt: now, createdAt: now, updatedAt: now,
    });
  },
});

/** Connect Deepline: the key is checked against the live API, then stored encrypted. */
export const connect = action({
  args: { apiKey: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await ctx.runQuery(internal.audiences.caller, {});
    if (!caller) throw new ConvexError("Not authenticated");
    if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new ConvexError("Paste your Deepline API key.");
    try {
      await createDeeplineClient({ apiKey, fetchImpl: fetch }).validate();
    } catch (cause) {
      if (cause instanceof DeeplineError) throw new ConvexError(cause.message);
      throw cause;
    }
    await ctx.runMutation(internal.deepline.storeKey, { orgId: caller.orgId, userId: caller.userId, apiKey });
    return { ok: true };
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await deeplineRow(ctx, user.orgId);
    if (row) await ctx.db.patch(row._id, { isActive: false, accessToken: await encryptForStorage(""), updatedAt: Date.now() });
  },
});
