import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { EMAIL_PATTERNS } from "./lib/emailFinder";

export const read = internalQuery({
  args: { domain: v.string() },
  handler: async (ctx, { domain }) => (await ctx.db.query("emailDomainPatterns").withIndex("by_domain", (q) => q.eq("domain", domain)).unique())?.pattern,
});
export const learn = internalMutation({
  args: { domain: v.string(), pattern: v.string() },
  handler: async (ctx, { domain, pattern }) => {
    if (!EMAIL_PATTERNS.includes(pattern as typeof EMAIL_PATTERNS[number])) throw new Error("Unknown email pattern.");
    const prior = await ctx.db.query("emailDomainPatterns").withIndex("by_domain", (q) => q.eq("domain", domain)).unique();
    if (prior) await ctx.db.patch(prior._id, { pattern, verifiedAt: Date.now() });
    else await ctx.db.insert("emailDomainPatterns", { domain, pattern, verifiedAt: Date.now() });
  },
});
