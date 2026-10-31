import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const clerkIdentity = internalQuery({
  args: { userId: v.id("users"), orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ clerkUserId: string; clerkOrgId: string | null } | null> => {
    const user = await ctx.db.get(args.userId);
    const org = await ctx.db.get(args.orgId);
    if (!user || !org || user.orgId !== org._id || !user.isActive) return null;
    return { clerkUserId: user.clerkUserId, clerkOrgId: org.clerkOrgId ?? null };
  },
});
