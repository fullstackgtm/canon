/**
 * The "Signed in as" switcher of a local stack: which seeded member the dev auth bypass (convex/lib.ts) signs an
 * unauthenticated caller in as, so a rep's actions can be run in the UI. It exists only while the bypass is on
 * (FSGTM_ENABLE_DEMO_DATA, which only a local stack sets) and only for a caller with no identity: on dev and prod the
 * query answers null and the mutation refuses, and the dashboard draws no switcher (DEV_MODE needs no Clerk key).
 */
import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { DEV_MEMBER_PREFIX, DEV_USER_CLERK_ID, devBypassUser, isDevAuthBypassEnabled } from "./lib";

/** Whether this caller rides the dev bypass: it is on, and the caller carries no identity of their own. */
async function onBypass(ctx: QueryCtx) {
  return isDevAuthBypassEnabled() && (await ctx.auth.getUserIdentity()) === null;
}

/** The seeded members of the demo workspace, and who the bypass signs in as now; null where the bypass is off. */
export const members = query({
  args: {},
  handler: async (ctx) => {
    if (!(await onBypass(ctx))) return null;
    const current = await devBypassUser(ctx);
    if (!current) return null;
    const admin = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!admin) return null;
    const rows = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", admin.orgId)).take(200);
    return {
      current: current._id,
      members: rows.filter((u) => u.isActive && u.clerkUserId.startsWith(DEV_MEMBER_PREFIX)).map((u) => ({ id: u._id, name: u.name, role: u.role })),
    };
  },
});

/** Sign the bypass in as a seeded member. Refused where the bypass is off, and for a caller signed in for real. */
export const actAs = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (!(await onBypass(ctx))) throw new ConvexError("Switching members is for a local stack's dev sign-in only.");
    const admin = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    const member = await ctx.db.get(args.userId);
    if (!admin || !member || member.orgId !== admin.orgId || !member.isActive || !member.clerkUserId.startsWith(DEV_MEMBER_PREFIX)) {
      throw new ConvexError("Only a seeded member of the demo workspace can be signed in as.");
    }
    const row = await ctx.db.query("devActAs").first();
    if (row) await ctx.db.patch(row._id, { clerkUserId: member.clerkUserId, updatedAt: Date.now() });
    else await ctx.db.insert("devActAs", { clerkUserId: member.clerkUserId, updatedAt: Date.now() });
    return { name: member.name, role: member.role };
  },
});
