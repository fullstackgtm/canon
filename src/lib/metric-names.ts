/** A metric's aggregation, as the report spec stores it. */
export type MetricFn = "count" | "sum" | "avg" | "min" | "max" | "pctTrue";

/** The word a person reads for each aggregation: the metric's "measured as". */
export const MEASURED_AS: Record<Exclude<MetricFn, "count" | "pctTrue">, string> = { sum: "Total", avg: "Average", max: "Largest", min: "Smallest" };

const lower = (s: string) => (s && s === s.toUpperCase() ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** A metric's plain name: its own label ("Pipeline"), else "Number of deals", "Total amount", "% won". */
export function metricName(m: { fn: MetricFn; label?: string }, fieldLabel: string, records: string): string {
  if (m.label) return m.label;
  if (m.fn === "count") return `Number of ${lower(records)}`;
  if (m.fn === "pctTrue") return `% ${lower(fieldLabel)}`;
  return `${MEASURED_AS[m.fn]} ${lower(fieldLabel)}`;
}

/** The line under a metric's name: what it adds up, leading with the word a click changes ("TOTAL of Amount"). */
export function metricDefinition(m: { fn: MetricFn }, fieldLabel: string, records: string): string {
  return m.fn === "count" ? `COUNT of ${lower(records)}` : m.fn === "pctTrue" ? `% YES of ${fieldLabel}` : `${MEASURED_AS[m.fn].toUpperCase()} of ${fieldLabel}`;
}

/** The word a metric's definition leads with. */
export const measureWord = (fn: MetricFn) => (fn === "count" ? "COUNT" : fn === "pctTrue" ? "% YES" : MEASURED_AS[fn].toUpperCase());

type Where = readonly { field: string; op: string; value?: unknown }[];
/** A metric's own filter in words: "Closed is no", "Won is yes", "Stage is Proposal". */
export function whereText(where: Where | undefined, labelOf: (field: string) => string): string {
  return (where ?? []).map((w) => {
    const v = w.value === true ? "yes" : w.value === false ? "no" : Array.isArray(w.value) ? w.value.join(" or ") : String(w.value ?? "");
    return w.op === "eq" ? `${labelOf(w.field)} is ${v}` : w.op === "neq" ? `${labelOf(w.field)} is not ${v}` : `${labelOf(w.field)} ${w.op} ${v}`;
  }).join(" · ");
}

/** A ready metric: a name, what it adds up, and the rows it reads (`where`), as a report's measure stores it. */
export type Preset = { fn: MetricFn; field?: string; label: string; where?: Array<{ field: string; op: "eq"; value: boolean }> };

/**
 * The ready metrics a source offers by name. Deals (a won and a closed flag, from each workspace's own stages, and an
 * amount) get Pipeline, Won revenue, Win rate and Average deal size; any other yes/no field its share of yes.
 */
export function presetMetrics(fields: readonly { name: string; label: string; type: string }[]): Preset[] {
  const has = (n: string) => fields.some((f) => f.name === n);
  const deals: Preset[] = has("isWon") && has("isClosed") && has("amount") ? [
    { fn: "sum", field: "amount", label: "Pipeline", where: [{ field: "isClosed", op: "eq", value: false }] },
    { fn: "sum", field: "amount", label: "Won revenue", where: [{ field: "isWon", op: "eq", value: true }] },
    { fn: "pctTrue", field: "isWon", label: "Win rate", where: [{ field: "isClosed", op: "eq", value: true }] },
    { fn: "avg", field: "amount", label: "Average deal size", where: [{ field: "isWon", op: "eq", value: true }] },
  ] : [];
  const flags = fields.filter((f) => f.type === "checkbox" && !(deals.length && (f.name === "isWon" || f.name === "isClosed")));
  return [...deals, ...flags.map((f): Preset => ({ fn: "pctTrue", field: f.name, label: `% ${lower(f.label)}` }))];
}

/**
 * The metrics a source suggests first: how many records, then each money field's total and average, then each other
 * number's average (a probability or a score averages; it doesn't add up).
 */
export function suggestedMetrics(fields: readonly { name: string; label: string; type: string }[]): Array<{ fn: MetricFn; field?: string }> {
  const money = fields.filter((f) => f.type === "currency");
  const numbers = fields.filter((f) => f.type === "number");
  return [{ fn: "count" }, ...money.flatMap((f) => [{ fn: "sum" as const, field: f.name }, { fn: "avg" as const, field: f.name }]), ...numbers.map((f) => ({ fn: "avg" as const, field: f.name }))];
}
