/**
 * Market sizes (docs/tam-and-icps.md): which treemap views have one, and the
 * cache key a view's counts are stored under. Pure.
 */
import type { AccountsFilter, MarketDimension, MarketFacetsResponse, MarketFilter } from "./recordContract.ts";
import { parseQuery } from "./icpQuery.ts";
import { icpGeosToCountries } from "./researchPipeline.ts";
import { industryFilterKeys } from "../../modules/kernel/industries.ts";

export const MARKET_DIMENSIONS: readonly MarketDimension[] = ["industry", "country", "region", "sizeBand"];
/** How long a count is fresh; older ones are served while they refresh. */
export const MARKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The market part of a TAM filter, or null when the view narrows by something the market
 * can't know (owner, status, fit, a search, segments, AI answers, an ICP).
 */
export function marketFilter(filter: AccountsFilter | undefined): MarketFilter | null {
  const f = filter ?? {};
  const workspaceOnly = [f.segmentId, f.status, f.ownerId, f.minFit, f.q, f.icpId, f.employeeMin, f.employeeMax, f.archetype]
    .some((v) => v !== undefined && v !== "") || Object.keys(f.traits ?? {}).length > 0 || Object.keys(f.custom ?? {}).length > 0;
  if (workspaceOnly) return null;
  const out: MarketFilter = {};
  if (f.industry?.length) out.industry = industryFilterKeys(f.industry);
  if (f.country?.length) out.country = f.country.map((c) => c.toLowerCase());
  if (f.region?.length) out.region = f.region;
  if (f.sizeBand?.length) out.sizeBand = f.sizeBand;
  return out;
}

/** One key per view: the dimension, then each narrowed dimension's sorted values. */
export function cacheKey(filter: MarketFilter, groupBy: MarketDimension): string {
  const parts = MARKET_DIMENSIONS.filter((d) => filter[d]?.length).map((d) => `${d}=${[...new Set(filter[d]!)].sort().join(",")}`);
  return `${groupBy}|${parts.join("|")}`;
}

export type QueryMarketFilter = MarketFilter | 0 | null;

export function marketFilterOfLines(lines: readonly string[]): QueryMarketFilter {
  const filter: MarketFilter = {};
  let empty = false;
  for (const line of lines) {
    const { query, errors } = parseQuery(line, "segment");
    if (errors.length || query.has.length) return null;
    for (const clause of query.clauses) {
      if (clause.neg || !(clause.key === "industry" || clause.key === "size" || clause.key === "country" || clause.key === "region")) return null;
      const key = clause.key === "size" ? "sizeBand" : clause.key;
      const values = key === "country" ? icpGeosToCountries(clause.values) : key === "industry" ? industryFilterKeys(clause.values) : clause.values;
      filter[key] = [...new Set(filter[key] ? filter[key]!.filter((v) => values.includes(v)) : values)];
      if (!filter[key]!.length) empty = true;
    }
  }
  return empty ? 0 : filter;
}

export type MarketReadSpec = { filter: QueryMarketFilter; groupBy: MarketDimension };
export type MarketReader = (filter: QueryMarketFilter, groupBy: MarketDimension) => Promise<MarketFacetsResponse | null>;

export function planMarketRead(args: Record<string, unknown>): MarketReadSpec {
  if (typeof args.query !== "string") throw new Error("market.facets needs query as a string.");
  const groupBy = args.groupBy ?? "region";
  if (!MARKET_DIMENSIONS.includes(groupBy as MarketDimension)) throw new Error("market.facets needs a market dimension for groupBy.");
  return { filter: marketFilterOfLines([args.query]), groupBy: groupBy as MarketDimension };
}

export function memoizedMarketReader(view: (filter: MarketFilter, groupBy: MarketDimension) => Promise<MarketFacetsResponse>): MarketReader {
  const views = new Map<string, Promise<MarketFacetsResponse | null>>();
  return async (filter, groupBy) => {
    if (filter === null) return null;
    if (filter === 0) return { total: 0, groups: [], truncated: false };
    const key = cacheKey(filter, groupBy);
    if (!views.has(key)) views.set(key, view(filter, groupBy).then(({ total, groups, truncated }) => ({ total, groups, truncated })).catch(() => null));
    return views.get(key)!;
  };
}
