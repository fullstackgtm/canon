/**
 * Clerk deleted an organization (`organization.deleted`, convex/http.ts): every member is turned off there as Clerk
 * turns one off (users.endMembershipFromClerk, which revokes what Canon issued them), its agents and automation rules
 * are paused, and nothing is deleted. A workspace of any size is worked a page at a time, each page its own
 * transaction scheduling the next, so a retried event or a crash midway just walks the pages again.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { endMembershipFromClerk } from "./users";

/** Members, agents or rules one transaction turns off: a member's credentials are a few reads and writes each. */
export const PAGE = 25;

export const RULE_PAUSED_REASON = "The workspace was deleted in Clerk";

type Step = { done: boolean; cursor: string | null };

/** The steps, in order. A step that changes the rows it reads (rules leaving `active`) restarts from the top each page. */
const STEPS: Array<(ctx: MutationCtx, orgId: Id<"organizations">, cursor: string | null) => Promise<Step>> = [
  async (ctx, orgId, cursor) => {
    const page = await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems: PAGE, cursor });
    for (const m of page.page) {
      const user = await ctx.db.get(m.userId);
      if (user) await endMembershipFromClerk(ctx, user, orgId);
    }
    return { done: page.isDone, cursor: page.continueCursor };
  },
  // A member whose home is this workspace and who has no membership row for it.
  async (ctx, orgId, cursor) => {
    const page = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems: PAGE, cursor });
    for (const user of page.page) await endMembershipFromClerk(ctx, user, orgId);
    return { done: page.isDone, cursor: page.continueCursor };
  },
  async (ctx, orgId, cursor) => {
    const page = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).paginate({ numItems: PAGE, cursor });
    // Paused by the system (no `by`), as an agent whose owner left is: a person resumes it.
    for (const agent of page.page) if (!agent.pause && agent.archivedAt === undefined) await ctx.db.patch(agent._id, { pause: { reason: "owner_not_member", at: Date.now() } });
    return { done: page.isDone, cursor: page.continueCursor };
  },
  async (ctx, orgId) => {
    const rules = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active")).take(PAGE);
    for (const rule of rules) await ctx.db.patch(rule._id, { status: "paused", pausedReason: RULE_PAUSED_REASON, updatedAt: Date.now() });
    return { done: rules.length < PAGE, cursor: null };
  },
];

async function run(ctx: MutationCtx, orgId: Id<"organizations">, step: number, cursor: string | null) {
  const next = await STEPS[step]!(ctx, orgId, cursor);
  const following = next.done ? { step: step + 1, cursor: null } : { step, cursor: next.cursor };
  if (following.step < STEPS.length) await ctx.scheduler.runAfter(0, internal.clerkOrgDeletion.continueDeletion, { orgId, ...following });
}

export const deleteFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId)).first();
    if (!org) return null;
    if (!org.clerkDeletedAt) await ctx.db.patch(org._id, { clerkDeletedAt: Date.now() });
    await run(ctx, org._id, 0, null);
    return null;
  },
});

export const continueDeletion = internalMutation({
  args: { orgId: v.id("organizations"), step: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    await run(ctx, args.orgId, args.step, args.cursor);
    return null;
  },
});
