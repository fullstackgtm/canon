import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { publishEnrollment, publishSender } from "./lib/linkedin/feedProjection";

const cursor = v.optional(v.union(v.string(), v.null()));
const SENDERS_PER_REFRESH = 1;

export const refreshSenders = internalMutation({
  args: { cursor },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db.query("linkedinAccounts").withIndex("by_status").paginate({ numItems: SENDERS_PER_REFRESH, cursor: args.cursor ?? null });
    for (const account of page.page) await publishSender(ctx, account._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.linkedinFeeds.refreshSenders, { cursor: page.continueCursor });
  },
});

export const refreshCadence = internalMutation({
  args: { cadenceId: v.id("linkedinCadences"), cursor },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db.query("linkedinEnrollments")
      .withIndex("by_cadenceId_and_enrolledAt", (q) => q.eq("cadenceId", args.cadenceId))
      .paginate({ numItems: 50, cursor: args.cursor ?? null });
    for (const row of page.page) await publishEnrollment(ctx, row._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.linkedinFeeds.refreshCadence, { ...args, cursor: page.continueCursor });
  },
});

export const backfillSender = internalMutation({
  args: { accountId: v.id("linkedinAccounts"), cursor },
  handler: async (ctx, args): Promise<void> => {
    const page = await ctx.db.query("linkedinEnrollments")
      .withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", args.accountId))
      .paginate({ numItems: 50, cursor: args.cursor ?? null });
    for (const row of page.page) await publishEnrollment(ctx, row._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.linkedinFeeds.backfillSender, { ...args, cursor: page.continueCursor });
  },
});
