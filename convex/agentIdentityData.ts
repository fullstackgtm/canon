import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { credentialMember } from "./lib/membership";

export const clerkIdentity = internalQuery({
  args: { userId: v.id("users"), orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ clerkUserId: string; clerkOrgId: string | null } | null> => {
    const org = await ctx.db.get(args.orgId);
    const user = org ? await credentialMember(ctx, await ctx.db.get(args.userId), org._id) : null;
    if (!user || !org) return null;
    return { clerkUserId: user.clerkUserId, clerkOrgId: org.clerkOrgId ?? null };
  },
});
