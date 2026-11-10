import { v } from "convex/values";
export const discoverySource = v.object({ kind: v.string(), url: v.string(), quote: v.string() });
export const candidateKeyValidator = v.object({ nameAddress: v.optional(v.string()), domain: v.optional(v.string()), linkedin: v.optional(v.string()), placeId: v.optional(v.string()), registryId: v.optional(v.string()) });
export const candidateFields = {
  name: v.string(), keys: candidateKeyValidator, domain: v.optional(v.string()), address: v.optional(v.string()), linkedinUrl: v.optional(v.string()), sources: v.array(discoverySource),
};
export const planSource = v.object({ kind: v.union(v.literal("directory"), v.literal("people_phrase"), v.literal("catalog")), ref: v.string(), label: v.string(), estimatedCompanies: v.number() });
export const investigationStatus = v.union(v.literal("planning"), v.literal("awaiting_start"), v.literal("running"), v.literal("paused_at_cap"), v.literal("done"), v.literal("failed"));
