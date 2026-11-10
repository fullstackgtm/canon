/**
 * A local stack's second workspace, to prove a workspace import end to end (docs/workspace-export.md): `moveDevUser`
 * makes an empty workspace and moves the dev user into it, so the dev auth bypass signs in there, or moves them back.
 * Internal, and refused unless the dev auth bypass is on (only a local stack sets it).
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { DEV_USER_CLERK_ID, isDevAuthBypassEnabled } from "./lib";

export const moveDevUser = internalMutation({
  args: { to: v.optional(v.id("organizations")) },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Only a local stack has a dev user to move");
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const to = args.to ?? (await ctx.db.insert("organizations", {
      clerkOrgId: `dev_import_${now}`, name: "Imported workspace", slug: `imported-${now}`, fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC", onboardingCompletedAt: now, createdAt: now, updatedAt: now,
    }));
    await ctx.db.patch(user._id, { orgId: to });
    return { from: user.orgId, to };
  },
});

/** The id map of the dev user's workspace's import, old id to new, to compare its archive with the source's. */
export const importMap = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Only a local stack has a dev user");
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    const imp = user && (await ctx.db.query("workspaceImports").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").first());
    if (!imp) return null;
    const rows = await ctx.db.query("workspaceImportIds").withIndex("by_importId_oldId", (q) => q.eq("importId", imp._id)).take(8000);
    return { source: imp.sourceWorkspaceId, map: Object.fromEntries(rows.map((r) => [r.oldId, r.newId])) };
  },
});
