/** Dates as `YYYY-MM-DD`, read and written in UTC so a day never shifts with the browser's zone. */
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => toDay(new Date(toDate(d).getTime() + n * 86_400_000));
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
const monthStart = (d: string, by: number) => { const x = toDate(d); return toDay(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + by, 1))); };
const monthEnd = (d: string) => addDays(monthStart(d, 1), -1);

/**
 * The period a range compares with: the same span just before it, by whole months when the range is whole months
 * (Q4 → Q3, a month → the month before), else by days. When the range runs past `today`, both stop the same number
 * of days in, so a quarter in progress meets the same 22 days of the last one, not all of it.
 */
export function previousPeriod(from: string, to: string, today: string): { from: string; to: string; partial: boolean } {
  const wholeMonths = from.endsWith("-01") && to === monthEnd(to);
  let prevFrom: string, prevTo: string;
  if (wholeMonths) {
    const span = (toDate(to).getUTCFullYear() - toDate(from).getUTCFullYear()) * 12 + toDate(to).getUTCMonth() - toDate(from).getUTCMonth() + 1;
    prevFrom = monthStart(from, -span);
    prevTo = monthEnd(monthStart(to, -span));
  } else {
    const len = daysBetween(from, to) + 1;
    prevFrom = addDays(from, -len);
    prevTo = addDays(to, -len);
  }
  const partial = today >= from && today < to;
  if (partial) prevTo = addDays(prevFrom, Math.min(daysBetween(from, today), daysBetween(prevFrom, prevTo)));
  return { from: prevFrom, to: prevTo, partial };
}

/** How a value moved: points for a rate, else a percent of the previous; null when there's nothing to compare. */
export function change(now: number | null, before: number | null, rate: boolean): { text: string; up: boolean } | null {
  if (now === null || before === null) return null;
  if (rate) { const pts = Math.round((now - before) * 1000) / 10; return { text: `${pts >= 0 ? "▲" : "▼"} ${Math.abs(pts)} pts`, up: pts >= 0 }; }
  if (before === 0) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  return { text: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}%`, up: pct >= 0 };
}
