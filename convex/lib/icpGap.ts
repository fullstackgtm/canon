/**
 * Outside-TAM fills (docs/tam-and-icps.md, step 3): when an active ICP's market is
 * bigger than what the TAM holds of it, a free fill of the gap starts on its own,
 * held for review. Pure: what the market filter is, and whether to fill.
 */
import type { IcpSpec } from "./icpSpec.ts";
import type { MarketFilter } from "./recordContract.ts";
import { icpGeosToCountries } from "./researchPipeline.ts";
import { canonIndustry } from "../../services/record-service/src/industries.ts";

/** A gap smaller than this isn't worth a fill. */
export const MIN_GAP = 25;
/** Below this share of the market held, the TAM has a gap. */
export const COVERED_SHARE = 0.8;
/** Fills run to the end of their search, so the automatic one starts only for a gap up to this size. */
export const MAX_AUTO_GAP = 5000;
/** The same criteria aren't refilled automatically within this window. */
export const REFILL_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The provider-searchable part of an ICP (industries, company countries, sizes), or null when it narrows nothing. */
export function icpMarketFilter(spec: IcpSpec): MarketFilter | null {
  const industry = [...new Set(spec.market.industries.map((i) => canonIndustry(i)).filter((i): i is string => Boolean(i)))];
  const country = icpGeosToCountries(spec.market.countries);
  const sizeBand = spec.market.employeeBands;
  if (!industry.length && !country.length && !sizeBand.length) return null;
  return { ...(industry.length ? { industry } : {}), ...(country.length ? { country } : {}), ...(sizeBand.length ? { sizeBand } : {}) };
}

/** What the automatic fill looks at; a change to it is new criteria. */
export function gapKey(spec: IcpSpec): string {
  const sorted = (v: readonly string[] | undefined) => [...(v ?? [])].sort();
  return JSON.stringify([
    sorted(spec.market.industries), sorted(spec.market.countries), sorted(spec.market.employeeBands),
    sorted(spec.persona.levels), sorted(spec.persona.departments), sorted(spec.persona.titles), sorted(spec.persona.countries),
    sorted(spec.exclude.industries), sorted(spec.exclude.countries), sorted(spec.exclude.titles),
  ]);
}

export type GapDecision =
  | { fill: true; gap: number }
  | { fill: false; gap: number; reason: "covered" | "small" | "too_large" };

export function gapDecision(market: number, tam: number): GapDecision {
  const gap = Math.max(0, market - tam);
  if (market === 0 || tam >= market * COVERED_SHARE) return { fill: false, gap, reason: "covered" };
  if (gap < MIN_GAP) return { fill: false, gap, reason: "small" };
  if (gap > MAX_AUTO_GAP) return { fill: false, gap, reason: "too_large" };
  return { fill: true, gap };
}
