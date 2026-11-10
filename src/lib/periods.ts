/** Calendar periods for the legacy gtm CLI's audit. Workspace periods follow the fiscal year: convex/lib/reports/pacing.ts. */
export function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function currentMonthRange(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: isoDate(new Date(Date.UTC(year, month, 1))),
    end: isoDate(new Date(Date.UTC(year, month + 1, 0))),
    label: `${year}-${String(month + 1).padStart(2, "0")}`,
  };
}

export function currentQuarterRange(now = new Date()) {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  return {
    start: isoDate(new Date(Date.UTC(year, startMonth, 1))),
    end: isoDate(new Date(Date.UTC(year, startMonth + 3, 0))),
    label: `Q${quarter} ${year}`,
  };
}
