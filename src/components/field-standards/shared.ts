import type { CSSProperties } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import {
  COLUMN_OBJECTS, DEFAULT_TOLERANCE, agreement, compactAmount, coverageWaterfall, destinationFits, inDestination, mapKey, mapOf, mappedShare, pairKey, parseColumnKey,
  optionFor, quantityShare, ratioAgreement, resolveValue, scaleOf, sourceFits,
  type Column, type ConsolidationStatus, type DestinationMode, type FieldDefinition, type MapEntry, type Measure, type ObjectProfile, type RunOutcome,
} from "../../../convex/lib/consolidate";

export type Consolidation = NonNullable<FunctionReturnType<typeof api.fieldConsolidations.get>>;
export type Run = NonNullable<Consolidation["run"]>;
export type PreviewSection = Run["sections"][number];

export const primary =
  "inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
export const secondary =
  "inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50";
export const small = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

export const STAGE_LABEL: Record<Consolidation["stage"], string> = {
  discovering: "Finding columns",
  profiling: "Reading values",
  ready: "Ready",
  error: "Stopped",
};

export const num = (n: number) => n.toLocaleString();
export const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
export const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Canon fields sit above every CRM, so they have one page. */
export const fieldsHref = (id?: string) => `/dashboard/canon-fields${id ? `/${id}` : ""}`;

const STANDARD_ATTRIBUTE_LABEL: Record<string, string> = { industry: "Industry", annualRevenue: "Annual revenue", employees: "Employees", country: "Country", title: "Job title" };

/** The Canon attribute a field's values are saved in, as the record pages name it; null until a preview saves them. */
export function attributeLabel(c: Consolidation): string | null {
  if (!c.attribute) return null;
  return STANDARD_ATTRIBUTE_LABEL[c.attribute] ?? `${c.concept} (custom)`;
}

/** What the latest preview saved in Canon, in words. */
export function storedText(stored: { written: number; unchanged: number; missing: number }): string {
  return [
    `${num(stored.written)} new or changed`,
    stored.unchanged ? `${num(stored.unchanged)} unchanged` : null,
    stored.missing ? `${num(stored.missing)} not in Canon yet` : null,
  ].filter(Boolean).join(", ");
}

/** The columns the field writes or shadows, with their modes, in order. */
export function destinationColumns(c: Consolidation): Array<{ column: Column; mode: DestinationMode }> {
  return c.destinations.flatMap((d) => {
    const column = c.columns.find((col) => col.key === d.column);
    return column ? [{ column, mode: d.mode }] : [];
  });
}

/** Columns the field could also write: writable columns of its kind on its records, in any CRM, not already destinations. */
export function destinationChoices(c: Consolidation, field: FieldDefinition): Column[] {
  const taken = new Set(c.destinations.map((d) => d.column));
  return c.columns.filter((col) => !taken.has(col.key) && destinationFits(col, field));
}

export const STATUS_LABEL: Record<ConsolidationStatus["state"], string> = {
  findingColumns: "Finding columns",
  chooseStandard: "Define the field",
  readyToPreview: "Ready to preview",
  previewing: "Previewing",
  readyToApply: "Ready to apply",
  applying: "Applying",
  applied: "Applied",
  undoing: "Undoing",
  undone: "Undone",
  stopped: "Stopped",
};

export function outcomeText(o: RunOutcome, verb: string) {
  return [
    `${num(o.applied)} ${verb}`,
    o.conflict ? `${num(o.conflict)} left alone because the record changed since` : null,
    o.failed ? `${num(o.failed)} failed` : null,
  ].filter(Boolean).join(", ");
}

/** The status in plain words: "Applied Nov 2: 12,469 written". `sep` joins the state and its outcome. */
export function statusText(s: ConsolidationStatus, sep = ": "): string {
  switch (s.state) {
    case "readyToPreview":
      return s.changedSince ? `Settings changed since the preview of ${day(s.changedSince)}` : "Ready to preview";
    case "readyToApply":
      return s.writes
        ? `Previewed ${day(s.previewedAt)}${sep}${num(s.fill)} to fill, ${num(s.change)} to change`
        : `Previewed ${day(s.previewedAt)}${sep}nothing to write`;
    case "applying":
      return `Applying ${num(s.writes)} changes…`;
    case "applied":
      return `Applied ${day(s.at)}${sep}${outcomeText(s.outcome, "written")}`;
    case "undone":
      return `Undone ${day(s.at)}${sep}${outcomeText(s.outcome, "put back")}`;
    case "stopped":
      return `Stopped during the ${s.during === "columns" ? "column read" : s.during}${s.error ? `${sep}${s.error}` : ""}`;
    case "previewing":
    case "undoing":
      return `${STATUS_LABEL[s.state]}…`;
    default:
      return STATUS_LABEL[s.state];
  }
}

export function profileOf(c: Consolidation, object: string): ObjectProfile | null {
  return (c.profiles.find((p) => p.object === object)?.profile as ObjectProfile | null) ?? null;
}

/**
 * A column's values in the field's terms, so two columns can be compared: a destination's (or the column the field was
 * defined from) through its options, any other column's through the value map. Before the field is defined, values
 * compare as written (ignoring case and punctuation).
 */
export function fieldMapper(c: Consolidation, entries: readonly MapEntry[]) {
  const field = c.field;
  const own = new Set([...c.destinations.map((d) => d.column), c.optionsFrom ?? c.target].filter(Boolean));
  const map = mapOf(entries);
  return (column: Column, value: string): string | null => {
    if (!field) return mapKey(value);
    if (own.has(column.key) && column.kind === "picklist") return field.options.find((o) => inDestination(o.value, field, column) === value)?.value ?? null;
    return resolveValue(value, map, field.options)?.to ?? null;
  };
}

/** What the field holds; a category until it is defined. */
export function measureOfC(c: Consolidation): Measure {
  return c.field?.measure ?? "category";
}

/** A value as the page shows it: a quantity's amount in short form ("23.5M"), a category's option label. */
export function shownValue(value: string | null, measure: Measure, labelOf?: ReadonlyMap<string, string>): string {
  if (value === null) return "(blank)";
  if (measure === "quantity") {
    const n = Number(value);
    return Number.isFinite(n) ? compactAmount(n) : value;
  }
  return labelOf?.get(value) ?? value;
}

export type Agreement = { other: Column; rate: number; compared: number };

/**
 * How often a column agrees with each other column on the same records, best first. A category compares values in
 * the field's terms; a quantity compares amounts after each column's scale, within the policy's tolerance.
 */
export function agreementsFor(c: Consolidation, column: Column, entries: readonly MapEntry[]): Agreement[] {
  const profile = profileOf(c, column.object);
  if (!profile) return [];
  const quantity = measureOfC(c) === "quantity";
  const toTarget = fieldMapper(c, entries);
  return c.columns
    .filter((other) => other.object === column.object && other.key !== column.key)
    .flatMap((other) => {
      const pair = profile.pairs[pairKey(column.name, other.name)];
      if (!pair) return [];
      if (quantity) {
        const [a, b] = column.name < other.name ? [column, other] : [other, column];
        const r = ratioAgreement(pair.ratios ?? [], scaleOf(c.scales, a.key) / scaleOf(c.scales, b.key), c.policy.tolerance ?? DEFAULT_TOLERANCE);
        return r.compared ? [{ other, rate: r.agree / r.compared, compared: r.compared }] : [];
      }
      const r = agreement(pair, column.name < other.name, (side, value) => toTarget(side === "a" ? column : other, value));
      return r.compared ? [{ other, rate: r.agree / r.compared, compared: r.compared }] : [];
    })
    .sort((a, b) => b.compared - a.compared);
}

export type ValueRow = {
  key: string;
  value: string;
  count: number;
  columns: Column[];
  to: string | null;
  origin: MapEntry["origin"] | "self" | null;
  confidence: number | null;
};

/** Every source value across the chosen source columns, most common first, with what it maps to in the field's options. */
export function valueRows(c: Consolidation, entries: readonly MapEntry[]): ValueRow[] {
  const byKey = new Map(c.columns.map((col) => [col.key, col]));
  const options = c.field?.options;
  const map = mapOf(entries);
  const out = new Map<string, ValueRow>();
  for (const key of c.sources ?? []) {
    const column = byKey.get(key);
    if (!column) continue;
    for (const [value, n] of profileOf(c, column.object)?.columns[column.name]?.values ?? []) {
      const k = mapKey(value);
      if (!k) continue;
      let row = out.get(k);
      if (!row) {
        const entry = map.get(k);
        const self = entry || !options ? null : optionFor(value, options);
        row = {
          key: k, value, count: 0, columns: [],
          to: entry ? entry.to : (self?.value ?? null),
          origin: entry ? entry.origin : self ? "self" : null,
          confidence: entry ? entry.confidence : self ? 1 : null,
        };
        out.set(k, row);
      }
      row.count += n;
      if (!row.columns.includes(column)) row.columns.push(column);
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

/** How much of the source values the map covers at the policy's threshold. */
export function mapCoverage(rows: readonly ValueRow[], threshold: number) {
  const mapped = rows.filter((r) => r.to !== null && (r.confidence ?? 0) >= threshold);
  return {
    mapped,
    records: rows.reduce((s, r) => s + r.count, 0),
    mappedRecords: mapped.reduce((s, r) => s + r.count, 0),
    unmapped: rows.filter((r) => r.to === null).length,
  };
}

export const systemLabel = (column: Column) => (COLUMN_OBJECTS[column.object].system === "hubspot" ? "HubSpot" : "Salesforce");

export function fillOf(c: Consolidation, column: Column): { filled: number; read: number; distinct: number } | null {
  const profile = profileOf(c, column.object);
  const stats = profile?.columns[column.name];
  return profile && stats ? { filled: stats.filled, read: profile.read, distinct: stats.distinct } : null;
}

/** Columns that likely hold the same thing in the other CRM: same kind of column on the same kind of record, writable. */
export function counterpartCandidates(columns: readonly Column[], column: Column): Column[] {
  const t = COLUMN_OBJECTS[column.object];
  return columns.filter((m) => {
    const o = COLUMN_OBJECTS[m.object];
    return m.kind === column.kind && !m.readOnly && !m.enrichment && o.system !== t.system && o.level === t.level && o.writable;
  });
}

/** The counterpart most likely synced with a column: same kind of record in the other CRM, same name ignoring case. */
export function likelyCounterpart(columns: readonly Column[], column: Column): Column | undefined {
  const candidates = counterpartCandidates(columns, column);
  const name = mapKey(column.name).replace(/ c$/, "");
  return candidates.find((m) => mapKey(m.name).replace(/ c$/, "") === name) ?? candidates.find((m) => mapKey(m.label) === mapKey(column.label));
}

/**
 * Every other filled column on the field's kind of record, in any CRM, columns of the field's kind first, fullest
 * first. Empty columns stay unused, and so do columns with no amounts for a quantity.
 */
export function defaultSources(c: Consolidation, field: FieldDefinition, destinations: readonly string[]): string[] {
  const quantity = field.measure === "quantity";
  const kind = quantity ? "number" : "picklist";
  const fill = (col: Column) => (quantity ? (profileOf(c, col.object)?.columns[col.name]?.quantity?.read ?? 0) : (fillOf(c, col)?.filled ?? 0));
  return c.columns
    .filter((col) => sourceFits(col, field) && !destinations.includes(col.key) && fill(col) > 0)
    .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind) || fill(b) - fill(a))
    .map((col) => col.key);
}

const SOURCE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const SOURCE_COLORS_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
const NEUTRAL = "#8a8983";

/** A source's color by its priority (0-based). Pair with `paint`, then use `var(--c)`; never cycled past six. */
export function sourceColor(priority: number): CSSProperties {
  return { "--sw": SOURCE_COLORS[priority] ?? NEUTRAL, "--sw-dark": SOURCE_COLORS_DARK[priority] ?? NEUTRAL } as CSSProperties;
}
export const paint = "[--c:var(--sw)] dark:[--c:var(--sw-dark)]";

export type Coverage = {
  total: number;
  alreadySet: number;
  owned: number;
  bySource: Array<{ key: string; adds: number }>;
  blank: number;
  /** The preview's date when the numbers are its exact counts. */
  exactAt: number | null;
};

/**
 * How a destination column gets filled, source by source: the latest preview's counts when it is current and used
 * these sources in this order (sources on linked records included), otherwise the estimate from the profile, which
 * counts only the sources on the destination's own records. Null when the profile predates coverage.
 */
export function coverageFor(c: Consolidation, destination: Column, sources: readonly string[]): Coverage | null {
  const run = c.run;
  const section = run && !run.stale && run.status !== "previewing" ? run.sections.find((s) => s.column.key === destination.key) : undefined;
  if (run && section?.bySource && section.blank !== undefined && (c.sources ?? []).join("|") === sources.join("|")) {
    // Runs count by source column key; those previewed before destinations, by its label.
    const label = new Map(c.columns.map((col) => [col.key, col.label]));
    const bySource = sources.map((key) => ({ key, adds: section.bySource![key] ?? section.bySource![label.get(key) ?? ""] ?? 0 }));
    const written = Object.values(section.bySource).reduce((s, n) => s + n, 0);
    const owned = section.counts.salesforceOwned;
    return { total: section.read, alreadySet: section.read - owned - written - section.blank, owned, bySource, blank: section.blank, exactAt: run.createdAt };
  }
  const profile = profileOf(c, destination.object);
  const field = c.field;
  if (!profile?.signatures || !field) return null;
  const map = mapOf(c.valueMap);
  const quantity = field.measure === "quantity";
  // The estimate reads one object's profile, so it counts the sources on the destination's own records.
  const w = coverageWaterfall({
    profile,
    target: destination.key,
    sources: sources.filter((k) => parseColumnKey(k).object === destination.object),
    share: (key) => {
      const stats = profile.columns[parseColumnKey(key).name];
      return quantity
        ? quantityShare(stats?.quantity, stats?.filled ?? 0, c.policy.minConfidence)
        : mappedShare(stats?.values ?? [], map, field.options, c.policy.minConfidence);
    },
    mode: c.policy.mode,
  });
  return { ...w, exactAt: null };
}
