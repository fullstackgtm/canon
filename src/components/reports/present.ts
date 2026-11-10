/**
 * A report's answer as people read it: key labels (a stage's label, an
 * owner's name, "Q1 2026"), groups in the order the field means (a picklist's
 * option order, so stages run as the pipeline does), and values formatted by
 * what they measure (currency in cents). Pure, so the table, the charts and
 * the tests read one presentation.
 */
import type { AggregateGroup, AggregateResponse } from "../../../convex/lib/objects/reportSpec";
import type { ReportBucket } from "../../../modules/kernel/reportLanguage";
import type { Scalar } from "../../../convex/lib/objects/listSpec";
import type { ReportSpec } from "../../../modules/kernel/reportValidators";

/** What presenting needs to know about a field: its label, type and options. */
export type FieldInfo = { label: string; type: string; returns?: string; options?: readonly { value: string; label: string }[] };
export type Member = { _id: string; name: string };

export type PresentedGroup = { keys: (Scalar | null)[]; labels: string[]; values: (number | null)[] };
export type Presented = {
  keyLabels: string[];
  measureLabels: string[];
  groups: PresentedGroup[];
  /** One per first key, in the groups' order (two group keys only). */
  subtotals: PresentedGroup[];
  total: (number | null)[];
  rows: number;
  truncated: boolean;
  /** Whether the first measure adds up across groups (count, sum): only then do charts stack it or fold it into Other. */
  additive: boolean;
  /** Whether the first measure is a whole number (a count), so axes step by whole units. */
  whole: boolean;
  format: (measure: number, value: number | null) => string;
  formatCompact: (measure: number, value: number) => string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketLabel(day: string, bucket: ReportBucket): string {
  const [y, m, d] = day.split("-").map(Number);
  if (bucket === "year") return String(y);
  if (bucket === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (bucket === "month") return `${MONTHS[m - 1]} ${y}`;
  if (bucket === "day") return `${MONTHS[m - 1]} ${d}, ${y}`;
  return `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
}

const isMoney = (f: FieldInfo | undefined) => f?.type === "currency" || (f?.type === "formula" && f.returns === "currency");

const dollars = (cents: number, digits: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(cents / 100);
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function present(
  spec: Pick<ReportSpec, "groupBy" | "measures">,
  res: Pick<AggregateResponse, "groups" | "subtotals" | "total" | "rows" | "truncated">,
  keyFields: readonly (FieldInfo | undefined)[],
  measureFields: readonly (FieldInfo | undefined)[],
  team: readonly Member[] = [],
  /** The label of the relation a key follows ("Company"), by group index. */
  viaLabels: readonly (string | undefined)[] = [],
): Presented {
  const names = new Map(team.map((m) => [m._id, m.name]));
  const labelOf = (i: number, v: Scalar | null): string => {
    const f = keyFields[i];
    const g = spec.groupBy[i];
    if (v === null) return `No ${(f?.label ?? "value").toLowerCase()}`;
    if (f && (f.type === "date" || f.type === "datetime" || (f.type === "formula" && (f.returns === "date" || f.returns === "datetime"))) && typeof v === "string") return bucketLabel(v, g?.bucket ?? "month");
    if (typeof v === "boolean") return f ? (v ? f.label : `Not ${f.label.toLowerCase()}`) : v ? "Yes" : "No";
    if (f?.type === "user") return names.get(String(v)) ?? "Unknown user";
    const option = f?.options?.find((o) => o.value === v);
    return option ? option.label : String(v);
  };
  const rank = (i: number, v: Scalar | null): number => {
    if (v === null) return Number.MAX_SAFE_INTEGER;
    const at = keyFields[i]?.type === "picklist" ? keyFields[i]!.options?.findIndex((o) => o.value === v) ?? -1 : -1;
    return at >= 0 ? at : Number.MAX_SAFE_INTEGER - 1;
  };
  // Picklist keys follow option order; everything else keeps the service's key order. The first key orders first,
  // so a second key never reorders months or names.
  const firsts = [...new Set(res.groups.map((g) => JSON.stringify(g.keys[0])))]
    .map((k, i) => ({ k, i, r: rank(0, JSON.parse(k) as Scalar | null) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.k);
  const firstAt = new Map(firsts.map((k, i) => [k, i]));
  const shown = (g: AggregateGroup): PresentedGroup => ({ keys: g.keys, labels: g.keys.map((k, i) => labelOf(i, k)), values: g.values });
  const groups = res.groups.map((g, i) => ({ g, i }))
    .sort((a, b) => firstAt.get(JSON.stringify(a.g.keys[0]))! - firstAt.get(JSON.stringify(b.g.keys[0]))! || (a.g.keys.length > 1 ? rank(1, a.g.keys[1]) - rank(1, b.g.keys[1]) : 0) || a.i - b.i)
    .map(({ g }) => shown(g));
  const firstOrder = new Map<string, number>();
  groups.forEach((g, i) => { if (!firstOrder.has(JSON.stringify(g.keys[0]))) firstOrder.set(JSON.stringify(g.keys[0]), i); });
  const subtotals = [...res.subtotals]
    .sort((a, b) => (firstOrder.get(JSON.stringify(a.keys[0])) ?? Infinity) - (firstOrder.get(JSON.stringify(b.keys[0])) ?? Infinity))
    .map(shown);
  const measureLabels = spec.measures.map((m, i) => {
    if (m.label) return m.label;
    if (m.fn === "count") return "Count";
    const label = measureFields[i]?.label ?? m.field ?? "";
    return m.fn === "pctTrue" ? `% ${label}` : `${{ sum: "Sum", avg: "Average", min: "Min", max: "Max" }[m.fn]} of ${label}`;
  });
  const money = (i: number) => spec.measures[i].fn !== "count" && isMoney(measureFields[i]);
  return {
    keyLabels: spec.groupBy.map((g, i) => (g.via && viaLabels[i] ? `${viaLabels[i]}: ${keyFields[i]?.label ?? g.field}` : keyFields[i]?.label ?? g.field)),
    measureLabels,
    groups,
    subtotals,
    total: res.total,
    rows: res.rows,
    truncated: res.truncated,
    additive: spec.measures[0]?.fn === "count" || spec.measures[0]?.fn === "sum",
    whole: spec.measures[0]?.fn === "count",
    // A rate (pctTrue) is a share, 0 to 1, read as a percent.
    format: (i, v) => (v === null ? "-" : spec.measures[i].fn === "pctTrue" ? `${(v * 100).toFixed(1)}%` : money(i) ? dollars(v, spec.measures[i].fn === "avg" ? 2 : 0) : spec.measures[i].fn === "count" ? v.toLocaleString("en-US") : plain.format(v)),
    formatCompact: (i, v) => (spec.measures[i].fn === "pctTrue" ? `${Math.round(v * 100)}%` : money(i) ? `$${compact.format(v / 100)}` : compact.format(v)),
  };
}

/** The report the builder last loaded: which one, and the saved spec it loaded. */
export type Loaded = { reportId: string; spec: string };

/**
 * Whether the builder loads the report again: another one was opened, or its saved spec changed elsewhere while the
 * builder holds no unsaved edits. A rename or share leaves the spec alone, so it never discards edits.
 */
export function needsLoad(loaded: Loaded | null, reportId: string, active: { spec: unknown } | null, dirty: boolean): Loaded | null {
  const next = { reportId, spec: active ? JSON.stringify(active.spec) : "" };
  if (reportId && !active) return null;
  if (!loaded || loaded.reportId !== reportId) return next;
  return !dirty && loaded.spec !== next.spec ? next : null;
}
