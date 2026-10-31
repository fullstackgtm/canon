import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const keyArgs = {
  orgId: v.id("organizations"),
  key: v.string(),
};

export const get = internalQuery({
  args: keyArgs,
  handler: async (ctx, args) =>
    ctx.db
      .query("acquisitionCheckpoints")
      .withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", args.key))
      .unique(),
});

export const upsert = internalMutation({
  args: {
    ...keyArgs,
    userId: v.id("users"),
    cliTokenId: v.id("cliTokens"),
    expectedVersion: v.optional(v.number()),
    checkpoint: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("acquisitionCheckpoints")
      .withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", args.key))
      .unique();
    const currentVersion = existing?.version ?? 0;
    if (args.expectedVersion !== undefined && args.expectedVersion !== currentVersion) {
      throw new ConvexError({
        code: "CHECKPOINT_CONFLICT",
        current: existing
          ? { checkpoint: existing.checkpoint, version: existing.version, updatedAt: existing.updatedAt }
          : null,
      });
    }
    const version = currentVersion + 1;
    const updatedAt = Date.now();
    const value = {
      checkpoint: args.checkpoint,
      version,
      updatedAt,
      updatedByUserId: args.userId,
      updatedByCliTokenId: args.cliTokenId,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else {
      await ctx.db.insert("acquisitionCheckpoints", {
        orgId: args.orgId,
        key: args.key,
        ...value,
      });
    }
    return { checkpoint: args.checkpoint, version, updatedAt };
  },
});
