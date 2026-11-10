import { v } from "convex/values";

/** Stored shape of MarketSegments (marketSegments.ts) plus TAM estimates. */
export const marketSegmentValidator = v.object({
  archetype: v.string(),
  label: v.string(),
  group: v.string(),
  kind: v.union(v.literal("buyer"), v.literal("adjacent")),
  score: v.number(),
  why: v.string(),
  pdlIndustries: v.array(v.string()),
  /** Companies in the prospect index for the segment (in the ICP's countries). */
  estCount: v.union(v.number(), v.null()),
  /** tagged: companies tagged with the business type; industry: estimate from PDL industries. */
  countBasis: v.optional(v.union(v.literal("tagged"), v.literal("industry"))),
});

export const marketSegmentsValidator = v.object({
  buyers: v.array(marketSegmentValidator),
  adjacent: v.array(marketSegmentValidator),
  horizontal: v.boolean(),
  jobs: v.array(v.string()),
  note: v.optional(v.string()),
});
