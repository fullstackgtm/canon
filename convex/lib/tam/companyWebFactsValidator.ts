import { v } from "convex/values";

export const companyWebFactsFields = {
  domain: v.string(),
  status: v.union(v.literal("ok"), v.literal("unreadable"), v.literal("error")),
  error: v.optional(v.string()),
  fetchedAt: v.number(),
  pages: v.array(v.object({ kind: v.union(v.literal("home"), v.literal("team"), v.literal("careers"), v.literal("locations"), v.literal("contact")), url: v.string() })),
  linkedinUrl: v.optional(v.string()),
  socials: v.array(v.string()),
  addresses: v.array(v.object({ text: v.string(), url: v.string() })),
  founded: v.optional(v.object({ year: v.number(), source: v.union(v.literal("site"), v.literal("wayback")), url: v.string(), quote: v.optional(v.string()) })),
  locationCount: v.optional(v.object({ count: v.number(), url: v.string() })),
  openRoles: v.optional(v.object({ count: v.number(), url: v.string() })),
  sizeCluesVersion: v.optional(v.number()),
  domainRegistered: v.optional(v.object({ year: v.number(), url: v.string() })),
  roleFamilies: v.optional(v.array(v.object({ family: v.union(v.literal("field/technician"), v.literal("sales"), v.literal("engineering"), v.literal("operations"), v.literal("other")), count: v.number(), url: v.string() }))),
  physicalOperations: v.optional(v.array(v.object({ quote: v.string(), url: v.string() }))),
  staff: v.optional(v.array(v.object({ fullName: v.string(), title: v.optional(v.string()), url: v.string(), quote: v.string() }))),
  staffModelStatus: v.optional(v.union(v.literal("complete"), v.literal("skipped-no-key"), v.literal("failed"))),
  emails: v.array(v.object({ address: v.string(), url: v.string() })),
};
