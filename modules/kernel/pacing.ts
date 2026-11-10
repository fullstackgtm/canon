export const PACING_COMPARE_MAX = 8;

/**
 * Pacing: a running total by day of the period, one line per cohort (this
 * quarter, last quarter, ...), so periods of different lengths read on one
 * axis. Pure, so the chart, the reports service and the tests share it.
 * Days are `YYYY-MM-DD` calendar days, read in UTC.
 */

export type Grain = "month" | "quarter" | "year";
export type Period = { key: string; label: string; start: string; days: number };
/** One record that counts: the day it counts on, its amount, and the fields a filter or split reads. */
export type PacingRow = { day: string; amount: number; attrs: Record<string, string> };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const SPAN: Record<Grain, number> = { month: 1, quarter: 3, year: 12 };

/*
 * Quarters and years follow the workspace's fiscal year, which starts in month `fyStart` (1-12). A fiscal year is named
 * for the calendar year it ends in: with a February start, February 2026 opens FY27. Months are counted from year 0.
 */
const monthIndex = (day: string) => {
  const [y, m] = day.split("-").map(Number);
  return y * 12 + m - 1;
};
const firstMonth = (fy: number, fyStart: number) => (fy - (fyStart > 1 ? 1 : 0)) * 12 + fyStart - 1;
const fiscalYearOf = (month: number, fyStart: number) => Math.floor((month - fyStart + 1) / 12) + (fyStart > 1 ? 1 : 0);

/** How a fiscal year reads: the calendar year when it is one, else FY and its last two digits. */
export const fiscalYearName = (fy: number, fyStart = 1) => (fyStart === 1 ? String(fy) : `FY${String(fy).slice(-2)}`);

/** The first day of month `m` (0-11) of fiscal year `fy`. */
export function monthStart(fy: number, m: number, fyStart = 1): string {
  const a = firstMonth(fy, fyStart) + m;
  return `${Math.floor(a / 12)}-${String((a % 12) + 1).padStart(2, "0")}-01`;
}

/** The fiscal year holding `day`, and the month (0-11) of it `day` falls in. */
export function fiscalMonth(day: string, fyStart = 1): { fy: number; m: number } {
  const a = monthIndex(day);
  const fy = fiscalYearOf(a, fyStart);
  return { fy, m: a - firstMonth(fy, fyStart) };
}

function periodFrom(first: number, grain: Grain, fyStart: number): Period {
  const fy = fiscalYearOf(first, fyStart);
  const q = Math.floor((first - firstMonth(fy, fyStart)) / 3) + 1;
  const y = Math.floor(first / 12);
  const m = first % 12;
  const label = grain === "month" ? `${MONTHS[m]} ${y}` : grain === "quarter" ? `Q${q} ${fiscalYearName(fy, fyStart)}` : fiscalYearName(fy, fyStart);
  const key = grain === "month" ? `${y}-${String(m + 1).padStart(2, "0")}` : grain === "quarter" ? `${fy}-Q${q}` : String(fy);
  const start = Date.UTC(y, m, 1);
  return { key, label, start: iso(start), days: Math.round((Date.UTC(y, m + SPAN[grain], 1) - start) / DAY) };
}

export function periodOf(day: string, grain: Grain, fyStart = 1): Period {
  const offset = grain === "month" ? 0 : fyStart - 1;
  return periodFrom(Math.floor((monthIndex(day) - offset) / SPAN[grain]) * SPAN[grain] + offset, grain, fyStart);
}

/** The period `n` steps from `p` (negative goes back). */
export function shiftPeriod(p: Period, grain: Grain, n: number, fyStart = 1): Period {
  return periodFrom(monthIndex(p.start) + n * SPAN[grain], grain, fyStart);
}

/** The period's last day. */
export const lastDay = (p: Period) => iso(ms(p.start) + (p.days - 1) * DAY);

/** The period holding `day` and the `count - 1` before it, newest first. */
export function cohorts(day: string, grain: Grain, count: number, fyStart = 1): Period[] {
  const now = periodOf(day, grain, fyStart);
  return Array.from({ length: count }, (_, i) => shiftPeriod(now, grain, -i, fyStart));
}

/** The 0-based day of `day` in `p`, or -1 outside it. */
export function dayOf(day: string, p: Period): number {
  const d = Math.round((ms(day) - ms(p.start)) / DAY);
  return d >= 0 && d < p.days ? d : -1;
}

/** Whether a row passes: every filtered field holds one of its chosen values. An empty choice passes everything. */
export function passes(row: PacingRow, filter: Record<string, readonly string[]>): boolean {
  return Object.entries(filter).every(([f, vals]) => vals.length === 0 || vals.includes(row.attrs[f] ?? ""));
}

/**
 * The running total at the end of each day of `p`. With `through` (a day), days after it are null: the current
 * period's line stops at today.
 */
export function cumulative(rows: readonly PacingRow[], p: Period, measure: "sum" | "count" = "sum", through?: string): (number | null)[] {
  const daily = new Array<number>(p.days).fill(0);
  for (const r of rows) {
    const d = dayOf(r.day, p);
    if (d >= 0) daily[d] += measure === "sum" ? r.amount : 1;
  }
  const end = ms(p.start) + (p.days - 1) * DAY;
  const last = !through || ms(through) >= end ? p.days - 1 : ms(through) < ms(p.start) ? -1 : dayOf(through, p);
  let run = 0;
  return daily.map((v, i) => {
    run += v;
    return i > last ? null : run;
  });
}

/**
 * The share of a period's total typically reached by each fraction of it, from finished cohorts' lines:
 * `shape(f)` for f in [0, 1]. Each cohort counts once whatever its length; one with no total is skipped.
 * With no history it is straight (f itself).
 */
export function historicalShape(lines: readonly (readonly (number | null)[])[]): (f: number) => number {
  const usable = lines.filter((l) => (l.at(-1) ?? 0) > 0);
  if (!usable.length) return (f) => f;
  return (f) => {
    const sum = usable.reduce((s, l) => {
      const i = Math.min(l.length - 1, Math.max(0, Math.round(f * l.length) - 1));
      return s + (f <= 0 ? 0 : (l[i] ?? 0) / (l.at(-1) as number));
    }, 0);
    return sum / usable.length;
  };
}

export type TargetShape = "flat" | "linear" | "historical";

/** A target drawn over `days`: flat at the target, a straight pace from 0, or the pace finished cohorts kept. */
export function targetLine(target: number, days: number, shape: TargetShape, curve: (f: number) => number = (f) => f): number[] {
  return Array.from({ length: days }, (_, i) => {
    const f = (i + 1) / days;
    return shape === "flat" ? target : target * (shape === "linear" ? f : curve(f));
  });
}

/** Where a line stands against its target's pace on `day`: the gap (+ ahead) and the share of target reached. */
export function paceGap(line: readonly (number | null)[], pace: readonly number[], target: number) {
  let i = line.length - 1;
  while (i > 0 && line[i] === null) i--;
  const now = line[i] ?? 0;
  return { now, expected: pace[i] ?? 0, gap: now - (pace[i] ?? 0), attained: target > 0 ? now / target : 0, day: i + 1 };
}
