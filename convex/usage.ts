import { query } from "./_generated/server";
import { can } from "./lib/capabilities";
import { getCurrentUser } from "./lib";
import { EMAIL_LOOKUPS_PER_DAY, PAID_EMAIL_HITS_PER_MONTH } from "./lib/providers/registry";
import { categorizeProviderCalls, isPaidEmailHit, utcMonthWindow } from "./lib/usage";

/** This UTC month's metered work for the caller's workspace. Admins and managers only. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "usage.view")) return null;
    const orgId = user.orgId as string;
    const now = Date.now();
    const { start, resetsAt } = utcMonthWindow(now);
    const calls = await ctx.db
      .query("providerCalls")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", orgId).gte("at", start))
      .collect();
    const day = new Date(now).toISOString().slice(0, 10);
    const today = await ctx.db
      .query("emailLookups")
      .withIndex("by_orgId_and_day", (q) => q.eq("orgId", orgId).eq("day", day))
      .unique();
    const categories = categorizeProviderCalls(calls);
    return {
      monthStart: start,
      resetsAt,
      paidEmailHits: calls.filter(isPaidEmailHit).length,
      paidEmailAllowance: PAID_EMAIL_HITS_PER_MONTH,
      emailLookupsToday: today?.count ?? 0,
      emailLookupsPerDay: EMAIL_LOOKUPS_PER_DAY,
      totalMicro: categories.reduce((sum, c) => sum + c.costMicro, 0),
      categories,
    };
  },
});

/** What is left of this month's paid email hits, for the cost preview before a bulk reveal. Any member. */
export const emailAllowance = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const { start, resetsAt } = utcMonthWindow(Date.now());
    const calls = await ctx.db
      .query("providerCalls")
      .withIndex("by_orgId_and_at", (q) => q.eq("orgId", user.orgId as string).gte("at", start))
      .collect();
    const used = calls.filter(isPaidEmailHit).length;
    return { used, allowance: PAID_EMAIL_HITS_PER_MONTH, remaining: Math.max(0, PAID_EMAIL_HITS_PER_MONTH - used), resetsAt };
  },
});
