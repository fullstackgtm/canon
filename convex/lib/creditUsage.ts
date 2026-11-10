/**
 * A month of credit activity by UTC day, for Settings -> Billing (#427): what the workspace had
 * to spend each day and what it has spent so far, so a rep can see how fast credits go.
 */

const DAY = 86_400_000;

/** One ledger row in credits: a spend is negative and counts its free part in `amount`. */
export type UsageRow = { at: number; kind: string; amount: number; free: number };

export type UsageDay = {
  /** The day's UTC midnight. */
  at: number;
  /** Credits spent that day, free and bought, holds included. */
  used: number;
  /** Credits bought, refunded or adjusted that day. */
  added: number;
  /** The month's allowance plus bought credits at the end of the day: the ceiling spend runs against. */
  available: number;
  /** Credits spent this month by the end of the day. */
  cumulative: number;
  entries: number;
};

/** UTC midnight on the first of `now`'s month, and how many days the month has. */
export function monthOf(now: number): { start: number; days: number } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), days: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() };
}

/**
 * Every day of the month up to today. `paidNow` is the bought balance now; walking the month's rows
 * back from it gives the balance on the first, since a spend takes `amount + free` off the bought balance.
 */
export function dailyUsage(rows: UsageRow[], now: number, paidNow: number, allowance: number): UsageDay[] {
  const { start } = monthOf(now);
  const month = rows.filter((r) => r.at >= start && r.at <= now);
  let available = paidNow - month.reduce((s, r) => s + r.amount + r.free, 0) + allowance;
  let cumulative = 0;
  return Array.from({ length: new Date(now).getUTCDate() }, (_, i) => {
    const at = start + i * DAY;
    const today = month.filter((r) => r.at >= at && r.at < at + DAY);
    const used = today.reduce((s, r) => s + (r.kind === "spend" ? -r.amount : 0), 0);
    const added = today.reduce((s, r) => s + (r.kind === "spend" ? 0 : r.amount), 0);
    available += added;
    cumulative += used;
    return { at, used, added, available, cumulative, entries: today.length };
  });
}
