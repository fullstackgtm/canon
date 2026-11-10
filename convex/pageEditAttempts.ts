/** The log of customize-mode instructions (schema: pageEditAttempts). Written by pageCustomize.edit, read by admins. */
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getCurrentUser } from "./lib";
import { internal } from "./_generated/api";

const outcome = v.union(v.literal("changed"), v.literal("unchanged"), v.literal("refused"), v.literal("error"));

export const record = internalMutation({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), recipeId: v.string(), request: v.string(),
    pointed: v.optional(v.string()), target: v.optional(v.object({ component: v.string(), nth: v.optional(v.number()) })),
    outcome, refusedBy: v.optional(v.string()), by: v.string(), route: v.string(), summary: v.string(), ms: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("pageEditAttempts", { ...args, request: args.request.slice(0, 1_000), pointed: args.pointed?.slice(0, 500), route: args.route.slice(0, 2_000), summary: args.summary.slice(0, 1_000), at: Date.now() });
    // Failures show on /operatortools at once, not at the next cron.
  },
});

/** The workspace's recent attempts, newest first, for an admin looking into edits that didn't land. */
export const recent = query({
  args: { outcome: v.optional(outcome), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user || user.role !== "admin") return [];
    const rows = await ctx.db.query("pageEditAttempts").withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId)).order("desc").take(Math.min(args.limit ?? 50, 200));
    return args.outcome ? rows.filter((r) => r.outcome === args.outcome) : rows;
  },
});
