import { v } from "convex/values";

export const peopleSource = v.union(v.literal("linkedin_titles"), v.literal("linkedin_any"), v.literal("website_staff"), v.literal("review_replies"), v.literal("exa_owner"));
export const keptPerson = v.object({
  fullName: v.string(), title: v.optional(v.string()), headline: v.optional(v.string()), linkedinUrl: v.optional(v.string()), url: v.string(), quote: v.optional(v.string()),
  role: v.union(v.literal("decision_maker"), v.literal("champion"), v.literal("other")), reasoning: v.string(), source: peopleSource,
  email: v.union(v.string(), v.null()), emailStatus: v.union(v.literal("valid"), v.literal("catch_all"), v.literal("invalid"), v.literal("not_checked")), sendable: v.boolean(), contactId: v.string(),
});
