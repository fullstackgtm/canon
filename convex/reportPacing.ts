/**
 * Reports pacing: what was booked (won deals by close date) or created (deals by created time) on each day of a
 * period, for the period now, the ones it is compared with and the four before it (the pace past periods kept,
 * modules/kernel/pacing.ts historicalShape). The page turns the days into running totals and reads targets from
 * the plan (convex/targets.ts). Counts only the deals the caller can see; amounts in cents.
 */
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { callerClient, requireCaller } from "./records";
import { listFilter } from "../modules/kernel/reportValidators";
import type { Id } from "./_generated/dataModel";

export type { PacingResult, PacingSeries } from "./lib/reports/runPacing";
import { runPacing, type PacingResult } from "./lib/reports/runPacing";

export const run = action({
  args: {
    measure: v.union(v.literal("booked"), v.literal("created")),
    grain: v.union(v.literal("month"), v.literal("quarter"), v.literal("year")),
    /** How many periods before this one to compare, or the same period last year. */
    compare: v.union(v.number(), v.literal("yoy")),
    /** A deal field to split the current period by, or "team". */
    split: v.optional(v.string()),
    filter: v.array(listFilter),
    teamIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<PacingResult> => {
    const caller = await requireCaller(ctx, { read: true });
    if (args.filter.some((f) => ["closeDate", "createdAt", "isWon"].includes(f.field))) throw new ConvexError("Pacing sets the dates and won deals itself; filter on other fields");
    return runPacing(callerClient(ctx, caller), caller.orgId, {
      object: "deal", date: args.measure === "booked" ? "closeDate" : "createdAt",
      dateType: args.measure === "booked" ? "date" : "datetime", amount: "amount",
      filter: args.measure === "booked" ? [{ field: "isWon", op: "eq", value: true }] : [],
    }, args, await ctx.runQuery(internal.targets.fyStart, { orgId: caller.orgId as Id<"organizations"> }), await ctx.runQuery(internal.targets.callerRoster, {}));
  },
});
