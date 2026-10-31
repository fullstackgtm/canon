/**
 * A waterfall (a bridge): a start total, signed steps that walk it up and down, and an end total. Each bar floats
 * from the running total before it to the one after; the totals stand on zero.
 */
export type WaterfallBar = {
  label: string;
  /** The bar's own value: a total, or a step's signed change. */
  value: number;
  /** The running total before and after the bar (a total runs from 0 to itself). */
  from: number;
  to: number;
  kind: "total" | "up" | "down";
  /** The step's row index among the rows given, for a click; absent on the totals. */
  row?: number;
};

export type Waterfall = {
  bars: WaterfallBar[];
  /** The lowest and highest point any bar reaches, with zero always in range. */
  min: number;
  max: number;
  /** How far the stated end is from start + the steps, or null when they agree (or no end was given). */
  gap: number | null;
};

/**
 * The bars of a waterfall from its start, its steps in the order given, and its end. With no end, the end is start +
 * the steps; with one that disagrees, the end bar shows the stated end and `gap` says by how much it's off.
 */
export function waterfall(
  start: { label: string; value: number },
  steps: readonly { label: string; value: number }[],
  end: { label: string; value?: number | null },
): Waterfall {
  const bars: WaterfallBar[] = [{ label: start.label, value: start.value, from: 0, to: start.value, kind: "total" }];
  let at = start.value;
  steps.forEach((s, row) => {
    if (!Number.isFinite(s.value) || s.value === 0) return;
    bars.push({ label: s.label, value: s.value, from: at, to: at + s.value, kind: s.value > 0 ? "up" : "down", row });
    at += s.value;
  });
  const stated = end.value ?? null;
  const last = stated ?? at;
  bars.push({ label: end.label, value: last, from: 0, to: last, kind: "total" });
  const points = bars.flatMap((b) => [b.from, b.to]);
  // Money in cents and counts add up exactly; a sub-unit difference is float noise, not a gap.
  const gap = stated === null || Math.abs(stated - at) < 0.5 ? null : stated - at;
  return { bars, min: Math.min(0, ...points), max: Math.max(0, ...points), gap };
}

/**
 * A waterfall's values as text: money (in cents) as dollars, a fraction as a percent, else a number. Full money keeps
 * its cents, as the KPI figures do; `compact` abbreviates.
 */
export function waterfallFigure(format: string | undefined, compact: boolean) {
  const n = new Intl.NumberFormat("en-US", compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
  return (v: number) => {
    const sign = v < 0 ? "−" : "", a = Math.abs(v);
    if (format === "money") return `${sign}$${(compact ? n : money).format(a / 100)}`;
    return `${sign}${format === "percent" ? pct.format(a) : n.format(a)}`;
  };
}
