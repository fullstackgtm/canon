/**
 * Market sizes for the treemap (docs/tam-and-icps.md, step 2): how many companies
 * exist per tile, from the shared prospect index, cached globally so every
 * customer reuses them. A fresh count is served from the cache; a stale one is
 * served while it refreshes in the background; a miss is fetched once.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { clientFor, requireCaller } from "./records";
import { filterValidator } from "./lib/scopeValidators";
import { cacheKey, MARKET_DIMENSIONS, MARKET_TTL_MS, marketFilter } from "./lib/marketSize";
import type { MarketDimension, MarketFacetsResponse, MarketFilter } from "./lib/recordContract";

const groupsValidator = v.array(v.object({ key: v.string(), count: v.number() }));
const LIMIT = 500;

export const cached = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => ctx.db.query("marketFacets").withIndex("by_key", (q) => q.eq("key", args.key)).unique(),
});

export const store = internalMutation({
  args: { key: v.string(), groupBy: v.string(), groups: groupsValidator, total: v.number(), truncated: v.boolean() },
  handler: async (ctx, args) => {
    const row = { ...args, source: "pdl" as const, fetchedAt: Date.now() };
    const existing = await ctx.db.query("marketFacets").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("marketFacets", row);
    return null;
  },
});

async function fetchAndStore(ctx: ActionCtx, filter: MarketFilter, groupBy: MarketDimension): Promise<MarketFacetsResponse> {
  const r = await clientFor(ctx).marketFacets(filter, groupBy, LIMIT);
  await ctx.runMutation(internal.marketSize.store, { key: cacheKey(filter, groupBy), groupBy, groups: r.groups, total: r.total, truncated: r.truncated });
  return r;
}

export type MarketView = MarketFacetsResponse & { fetchedAt: number };

/**
 * The market grouped by one dimension under a filter, from the cache when it holds the view (a stale
 * view is served and refreshed in the background), else fetched once and stored. Throws when the
 * index is unavailable.
 */
export async function marketView(ctx: ActionCtx, filter: MarketFilter, groupBy: MarketDimension): Promise<MarketView> {
  const hit = await ctx.runQuery(internal.marketSize.cached, { key: cacheKey(filter, groupBy) });
  if (hit) {
    if (Date.now() - hit.fetchedAt > MARKET_TTL_MS) await ctx.scheduler.runAfter(0, internal.marketSize.refresh, { filter, groupBy });
    return { groups: hit.groups, total: hit.total, truncated: hit.truncated, fetchedAt: hit.fetchedAt };
  }
  return { ...(await fetchAndStore(ctx, filter, groupBy)), fetchedAt: Date.now() };
}

/**
 * The market behind a treemap view: the shared index grouped like the view, or null when the view
 * narrows by something the market can't know, or when the index is unavailable (it isn't loaded locally).
 */
export const facets = action({
  args: { filter: v.optional(filterValidator), groupBy: v.string() },
  handler: async (ctx, args): Promise<MarketView | null> => {
    await requireCaller(ctx, { read: true });
    const groupBy = MARKET_DIMENSIONS.find((d) => d === args.groupBy);
    const filter = marketFilter(args.filter);
    if (!groupBy || !filter) return null;
    try {
      return await marketView(ctx, filter, groupBy);
    } catch (error) {
      console.warn(`market facets unavailable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return null;
    }
  },
});

const marketFilterValidator = v.object({
  industry: v.optional(v.array(v.string())),
  country: v.optional(v.array(v.string())),
  region: v.optional(v.array(v.string())),
  sizeBand: v.optional(v.array(v.string())),
});

export const refresh = internalAction({
  args: { filter: marketFilterValidator, groupBy: v.string() },
  handler: async (ctx, args) => {
    if (!integrationEnabled("recordService")) return null;
    const groupBy = MARKET_DIMENSIONS.find((d) => d === args.groupBy);
    if (groupBy) await fetchAndStore(ctx, args.filter, groupBy).catch((e) => console.warn(`market refresh failed: ${String(e).slice(0, 200)}`));
    return null;
  },
});

/** Warm the top-level views (each dimension, unfiltered), so a first treemap reads from the cache. */
export const warm = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!integrationEnabled("recordService")) return null;
    for (const groupBy of MARKET_DIMENSIONS) {
      await fetchAndStore(ctx, {}, groupBy).catch((e) => console.warn(`market warm ${groupBy} failed: ${String(e).slice(0, 200)}`));
    }
    return null;
  },
});
