import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { unrestrictedUser } from "./permissions";
import { can } from "./lib/capabilities";

/**
 * The enrichment source each HubSpot company matched in free fill's coverage check (convex/enrichFreeFill.ts), with the
 * source's raw values. Field consolidation reads them as `@pdl.<field>` and `@crustdata.<field>` source columns.
 */

/** Matches written per mutation. */
export const UPSERT_BATCH = 200;
/** Records looked up per query: one HubSpot page. */
const LOOKUP_BATCH = 100;
/** The summary counts this many matches at most; `more` says there are others. */
const SUMMARY_CAP = 1000;

const matchValidator = v.object({
  recordId: v.string(),
  source: v.union(v.literal("pdl"), v.literal("crustdata")),
  via: v.union(v.literal("domain"), v.literal("name"), v.literal("root"), v.literal("crustdata"), v.literal("lookup")),
  domain: v.string(),
  values: v.object({
    industry: v.optional(v.string()),
    numberofemployees: v.optional(v.number()),
    annualrevenue: v.optional(v.number()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    country: v.optional(v.string()),
    linkedin_company_page: v.optional(v.string()),
    founded_year: v.optional(v.number()),
  }),
});

const byRecord = (ctx: QueryCtx, orgId: Id<"organizations">, recordId: string) =>
  ctx.db.query("enrichmentMatches").withIndex("by_orgId_and_recordId", (q) => q.eq("orgId", orgId).eq("recordId", recordId)).first();

export const upsert = internalMutation({
  args: { orgId: v.id("organizations"), matches: v.array(matchValidator) },
  handler: async (ctx, args) => {
    if (args.matches.length > UPSERT_BATCH) throw new ConvexError(`At most ${UPSERT_BATCH} matches per call.`);
    const matchedAt = Date.now();
    for (const match of args.matches) {
      const doc = { orgId: args.orgId, ...match, matchedAt };
      const existing = await byRecord(ctx, args.orgId, match.recordId);
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("enrichmentMatches", doc);
    }
    return null;
  },
});

/** Each record's match by record id; records with none are absent. */
export const forRecords = internalQuery({
  args: { orgId: v.id("organizations"), recordIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.recordIds.length > LOOKUP_BATCH) throw new ConvexError(`At most ${LOOKUP_BATCH} records per call.`);
    const out: Record<string, Pick<Doc<"enrichmentMatches">, "source" | "values">> = {};
    for (const recordId of new Set(args.recordIds)) {
      const match = await byRecord(ctx, args.orgId, recordId);
      if (match) out[recordId] = { source: match.source, values: match.values };
    }
    return out;
  },
});

async function summarize(ctx: QueryCtx, orgId: Id<"organizations">) {
  const rows = await ctx.db.query("enrichmentMatches").withIndex("by_orgId_and_matchedAt", (q) => q.eq("orgId", orgId)).order("desc").take(SUMMARY_CAP + 1);
  return { matched: Math.min(rows.length, SUMMARY_CAP), more: rows.length > SUMMARY_CAP, newestAt: rows[0]?.matchedAt ?? null };
}

export const summary = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => summarize(ctx, args.orgId),
});

/** How fresh the caller's enrichment sources are: none matched yet means a coverage check has to read them first. */
export const freshness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user || !can(user, "integrations.manage")) return null;
    return await summarize(ctx, user.orgId);
  },
});
