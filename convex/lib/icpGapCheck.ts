import { v } from "convex/values";

/** The last outside-TAM check on an ICP (icpFills.ts). */
export const icpGapCheckValidator = v.object({
  key: v.string(),
  at: v.number(),
  market: v.number(),
  tam: v.number(),
  outcome: v.union(v.literal("filling"), v.literal("covered"), v.literal("small"), v.literal("too_large"), v.literal("unavailable"), v.literal("busy")),
  jobId: v.optional(v.id("backgroundJobs")),
});
