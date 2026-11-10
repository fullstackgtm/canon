/**
 * TAM explorer view state: Group by (where the drill starts in the level
 * list), Filters (each a set of values for a dimension) and Values (the
 * metrics; the first sizes the treemap). The level list is fixed: the
 * firmographics, then jobs to be done, then every AI segment in the order
 * they were added. The treemap groups by the first level from Group by
 * onward that isn't narrowed to one value, so clicking a tile ("filter this
 * level to that value") steps down the list. Encoded in the URL as JSON (`pv`).
 */
import type { AccountsFilter } from "../../convex/lib/recordContract";
import { NONE, REGIONS, SIZE_BANDS } from "../../modules/kernel/dimensions.ts";
import { UNMAPPED_PREFIX, industryLabel, isCanonicalIndustry } from "../../modules/kernel/industries.ts";

/** `trait:<key>`: a Jev segment. `field:<slug>`: an AI field's accepted answer (record service 1.21.0). */
export type Dimension = "industry" | "sizeBand" | "region" | "country" | "segment" | `trait:${string}` | `field:${string}`;
/** `market`: companies that exist per tile, from the shared prospect index (docs/tam-and-icps.md). */
export type Metric = "count" | "opportunity" | "revenue" | "market";
export type Pivot = { group: Dimension; filters: Array<{ dim: Dimension; values: string[] }>; values: Metric[] };

export const METRICS: Metric[] = ["count", "market", "opportunity", "revenue"];
export const METRIC_LABEL: Record<Metric, string> = { count: "Accounts", market: "Market", opportunity: "Opportunity", revenue: "Revenue" };
export const FIRMOGRAPHIC: Dimension[] = ["industry", "sizeBand", "region", "country"];

/** URL limits. Filters can't exceed the level count (4 + jobs to be done + 50 AI segments); the controls enforce the value cap. */
export const MAX_FILTERS = 64;
export const MAX_FILTER_VALUES = 50;

export const DEFAULT_PIVOT: Pivot = { group: "industry", filters: [], values: ["count"] };
export const serializePivot = (p: Pivot) =>
  JSON.stringify({ g: p.group, f: p.filters.map((f) => [f.dim, f.values]), v: p.values });
export const DEFAULT_PV = serializePivot(DEFAULT_PIVOT);

const BUILTIN = new Set(["industry", "sizeBand", "region", "country", "segment"]);
const TRAIT_RE = /^trait:[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD_RE = /^field:[A-Za-z0-9_-]{1,64}$/;
export const isDimension = (d: unknown): d is Dimension => typeof d === "string" && (BUILTIN.has(d) || TRAIT_RE.test(d) || FIELD_RE.test(d));
const isMetric = (m: unknown): m is Metric => METRICS.includes(m as Metric);

export function parsePivot(raw: string | undefined): Pivot {
  try {
    const parsed = JSON.parse(raw || DEFAULT_PV) as { g?: unknown; f?: unknown; v?: unknown };
    if (!parsed || typeof parsed !== "object") return DEFAULT_PIVOT;
    const seen = new Set<string>();
    const filters: Pivot["filters"] = [];
    for (const entry of Array.isArray(parsed.f) ? parsed.f : []) {
      if (!Array.isArray(entry) || !isDimension(entry[0]) || seen.has(entry[0]) || !Array.isArray(entry[1])) continue;
      seen.add(entry[0]);
      const values = [...new Set(entry[1].filter((v): v is string => typeof v === "string" && v.length > 0))];
      filters.push({ dim: entry[0], values: values.slice(0, MAX_FILTER_VALUES).map((v) => v.slice(0, 200)) });
    }
    const values = Array.isArray(parsed.v) ? [...new Set(parsed.v.filter(isMetric))] : [];
    return {
      group: isDimension(parsed.g) ? parsed.g : DEFAULT_PIVOT.group,
      filters: filters.slice(0, MAX_FILTERS),
      values: values.length ? values : ["count"],
    };
  } catch {
    return DEFAULT_PIVOT;
  }
}

/**
 * Every level, in drill order: firmographics, Jev segments (Jobs to be done needs the workspace's
 * homepage research), then AI fields (choice and yes/no answers).
 */
export function levelsFor(segments: Array<{ key: string; field?: boolean }>, jtbdAvailable: boolean): Dimension[] {
  return [
    ...FIRMOGRAPHIC,
    ...(jtbdAvailable ? (["trait:jtbd"] as Dimension[]) : []),
    ...segments.filter((s) => !s.field && s.key !== "jtbd").map((s) => `trait:${s.key}` as Dimension),
    ...segments.filter((s) => s.field).map((s) => `field:${s.key}` as Dimension),
  ];
}

const filterOn = (p: Pivot, dim: Dimension) => p.filters.find((f) => f.dim === dim)?.values ?? [];
const startOf = (p: Pivot, levels: Dimension[]) => Math.max(0, levels.indexOf(p.group));

/** The level the treemap shows: the first from Group by onward not narrowed to a single value. */
export const currentRow = (p: Pivot, levels: Dimension[]): Dimension | null =>
  levels.slice(startOf(p, levels)).find((d) => filterOn(p, d).length !== 1) ?? null;

/** Filters as a record-service filter. Empty filters (no values picked yet) match everything. */
export function pivotFilter(p: Pivot, except?: Dimension): AccountsFilter {
  const f: AccountsFilter = {};
  for (const { dim, values } of p.filters) {
    if (!values.length || dim === except) continue;
    if (dim === "industry") f.industry = values;
    else if (dim === "country") f.country = values;
    else if (dim === "sizeBand") f.sizeBand = values;
    else if (dim === "region") f.region = values;
    else if (dim === "segment") f.segmentId = values[0];
    else if (dim.startsWith("field:")) f.custom = { ...f.custom, [dim.slice("field:".length)]: values };
    else f.traits = { ...f.traits, [dim.slice("trait:".length)]: values };
  }
  return f;
}

export function setFilter(p: Pivot, dim: Dimension, values: string[] | null): Pivot {
  if (values === null) return { ...p, filters: p.filters.filter((f) => f.dim !== dim) };
  const exists = p.filters.some((f) => f.dim === dim);
  return {
    ...p,
    filters: exists ? p.filters.map((f) => (f.dim === dim ? { dim, values } : f)) : [...p.filters, { dim, values }],
  };
}

/** Click a tile: narrow its level to that value, which steps the treemap to the next level. */
export const drill = (p: Pivot, dim: Dimension, value: string) => setFilter(p, dim, [value]);

/** Start the drill at `dim`, showing it even if a tile click had narrowed it. */
export function setGroup(p: Pivot, dim: Dimension): Pivot {
  const narrowed = filterOn(p, dim).length === 1;
  return { ...(narrowed ? setFilter(p, dim, null) : p), group: dim };
}

/** Undo the deepest drill: clear the last level between Group by and the current one that is narrowed to one value. */
export function zoomOut(p: Pivot, levels: Dimension[]): Pivot {
  const at = currentRow(p, levels);
  const path = levels.slice(startOf(p, levels), at === null ? levels.length : levels.indexOf(at));
  const last = [...path].reverse().find((d) => filterOn(p, d).length === 1);
  return last ? setFilter(p, last, null) : p;
}

/** Add (or move) a metric to `index`. The first metric sizes the treemap. */
export function placeValue(p: Pivot, m: Metric, index = p.values.length): Pivot {
  const values = p.values.filter((v) => v !== m);
  values.splice(Math.max(0, Math.min(index, values.length)), 0, m);
  return { ...p, values };
}

/** At least one metric always stays. */
export const removeValue = (p: Pivot, m: Metric): Pivot =>
  p.values.length > 1 ? { ...p, values: p.values.filter((v) => v !== m) } : p;

export type SegmentMeta = {
  key: string;
  kind: "noul" | "choice";
  label: string;
  criterion?: string;
  options?: Array<{ key: string; label: string }>;
  /** An AI field (level `field:<key>`) rather than a Jev segment (`trait:<key>`). */
  field?: boolean;
};

export function dimensionLabel(dim: Dimension, segments: SegmentMeta[] = []): string {
  switch (dim) {
    case "industry": return "Industry";
    case "sizeBand": return "Account size";
    case "region": return "Region";
    case "country": return "Country";
    case "segment": return "Starter segment";
    default: {
      if (dim.startsWith("field:")) return segments.find((s) => s.field && s.key === dim.slice("field:".length))?.label ?? dim.slice("field:".length);
      const key = dim.slice("trait:".length);
      if (key === "jtbd") return "Jobs to be done";
      return segments.find((s) => !s.field && s.key === key)?.label ?? key;
    }
  }
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, "and");

export function valueLabel(dim: Dimension, key: string, ctx: { segments?: SegmentMeta[]; starterSegments?: Array<{ id: string; name: string }> } = {}): string {
  if (dim.startsWith("field:")) {
    if (key === NONE) return "Not answered";
    const field = ctx.segments?.find((s) => s.field && s.key === dim.slice("field:".length));
    return field?.options?.find((o) => o.key.toLowerCase() === key)?.label ?? (key === "true" ? "Yes" : key === "false" ? "No" : key);
  }
  if (dim.startsWith("trait:")) {
    if (key === NONE) return "Not scored yet";
    if (key === "unsure") return "Unsure";
    const seg = ctx.segments?.find((s) => !s.field && s.key === dim.slice("trait:".length));
    if (seg?.kind === "choice") return key === "none" ? "None of these" : seg.options?.find((o) => o.key === key)?.label ?? key;
    return key === "yes" ? "Yes" : key === "no" ? "No" : key;
  }
  if (key === NONE) return "Unknown";
  if (dim === "sizeBand") return `${SIZE_BANDS.find((b) => b.key === key)?.label ?? key} employees`;
  if (dim === "region") return REGIONS.find((r) => r.key === key)?.label ?? key;
  if (dim === "segment") return ctx.starterSegments?.find((s) => s.id === key)?.name ?? key;
  // Canonical industries carry their own labels; a value no table maps reads "<value> (unmapped)".
  if (dim === "industry" && (isCanonicalIndustry(key) || key.startsWith(UNMAPPED_PREFIX))) return industryLabel(key);
  return key.length <= 3 ? key.toUpperCase() : titleCase(key);
}

/** The treemap folds its smallest groups into one tile with this key. */
export const OTHER_KEY = "__other__";

/** Groups that carry no positive identity (drawn neutral, hatched). */
export const isNeutralKey = (dim: Dimension, key: string) =>
  key === NONE || key === OTHER_KEY || (dim.startsWith("trait:") && (key === "unsure" || key === "none"));
