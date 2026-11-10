/**
 * The ARR ledger (docs/module-plans/customer-success.md §6): a company's contract lines from its closed-won recurring
 * deals, and its ARR on any day. Pure: no clock, money in minor units, exact. Golden-tested against §12 (Acme) in
 * tests/customerSuccessEngine.test.ts.
 */

/** A deal as the module reads it (`reads.deals`). Amounts are minor units. */
export type Deal = {
  id: string; name?: string; amount?: number | null; arr?: number | null; closeDate?: string | null;
  dealType?: string | null; revenueType?: string | null; contractLengthMonths?: number | null;
  isClosed?: boolean; isWon?: boolean; companyId?: string | null; companyName?: unknown; ownerId?: string | null;
};
export type Kind = "new" | "renewal" | "expansion" | "contraction";
/** What a line took on trust because the deal didn't say (plan §13 risk 2). */
export type Assumption = "arr_from_amount" | "length_assumed" | "renews_nothing";
export type Line = {
  deal: string; dealName: string; company: string; kind: Kind; start: string;
  /** The contract's end: start plus its length. */
  end: string;
  /** When it stops counting: its end, or the start of the renewal that replaced it, whichever is first. */
  until: string;
  arr: number; owner: string | null;
  /** The lines this renewal replaced, and their ARR together. */
  renews: string[]; renewedArr: number | null;
  assumed: Assumption[];
};
export type SkipWhy = "no_company" | "no_arr" | "no_close_date";
export type Skip = { deal: string; dealName: string; company: string | null; closeDate: string | null; why: SkipWhy };

/** A renewal replaces the lines that end within this many days of its start. */
export const RENEWAL_WINDOW_DAYS = 30;
const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number) => new Date(ms(day) + n * DAY).toISOString().slice(0, 10);

/** A date `months` on, its day clipped to the month's last: 2026-01-31 plus one month is 2026-02-28. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Won and recurring: the deals ARR comes from. One-time deals and open or lost ones count nowhere. */
const recurringWin = (d: Deal) => !!d.isWon && d.revenueType !== "one_time" && d.dealType !== "one_time";
const ORDER: Record<string, number> = { new_business: 0, renewal: 1, expansion: 2 };

/**
 * Every company's contract lines, and the won recurring deals left out with why. A deal's line starts on its close
 * date and runs its contract length (12 months when unset) at its ARR (its amount when unset). A renewal replaces
 * every line of its company still counting that ends within 30 days of its start, and is a contraction when it is
 * below them; an expansion or a new deal adds.
 */
export function ledger(deals: readonly Deal[]): { lines: Line[]; skipped: Skip[] } {
  const skipped: Skip[] = [];
  const byCompany = new Map<string, Deal[]>();
  for (const d of deals) {
    if (!recurringWin(d)) continue;
    const skip = (why: SkipWhy) => skipped.push({ deal: d.id, dealName: d.name ?? d.id, company: d.companyId ?? null, closeDate: d.closeDate ?? null, why });
    if (!d.closeDate) skip("no_close_date");
    else if (!d.companyId) skip("no_company");
    else if (!((d.arr ?? d.amount ?? 0) > 0)) skip("no_arr");
    else byCompany.set(d.companyId, [...(byCompany.get(d.companyId) ?? []), d]);
  }
  const lines: Line[] = [];
  for (const [company, list] of byCompany) {
    const sorted = [...list].sort((a, b) => a.closeDate!.localeCompare(b.closeDate!) || (ORDER[a.dealType ?? ""] ?? 0) - (ORDER[b.dealType ?? ""] ?? 0) || a.id.localeCompare(b.id));
    const mine: Line[] = [];
    for (const d of sorted) {
      const start = d.closeDate!, assumed: Assumption[] = [];
      if (!(d.arr && d.arr > 0)) assumed.push("arr_from_amount");
      if (!(d.contractLengthMonths && d.contractLengthMonths > 0)) assumed.push("length_assumed");
      const end = addMonths(start, d.contractLengthMonths && d.contractLengthMonths > 0 ? d.contractLengthMonths : 12);
      const arr = d.arr && d.arr > 0 ? d.arr : d.amount!;
      let kind: Kind = d.dealType === "expansion" ? "expansion" : "new";
      let renews: Line[] = [];
      if (d.dealType === "renewal") {
        renews = mine.filter((l) => l.until > addDays(start, -RENEWAL_WINDOW_DAYS) && Math.abs(ms(l.end) - ms(start)) <= RENEWAL_WINDOW_DAYS * DAY);
        if (!renews.length) assumed.push("renews_nothing");
        for (const l of renews) if (l.until > start) l.until = start;
        const before = renews.reduce((n, l) => n + l.arr, 0);
        kind = renews.length && arr < before ? "contraction" : "renewal";
      }
      mine.push({
        deal: d.id, dealName: d.name ?? d.id, company, kind, start, end, until: end, arr, owner: d.ownerId ?? null,
        renews: renews.map((l) => l.deal), renewedArr: renews.length ? renews.reduce((n, l) => n + l.arr, 0) : null, assumed,
      });
    }
    lines.push(...mine);
  }
  return { lines, skipped };
}

/** A line counts on `day` from its start up to the day before it stops. */
export const counts = (l: Line, day: string) => l.start <= day && day < l.until;

/** Each company's ARR on `day`: the sum of its lines counting then. */
export function arrOn(lines: readonly Line[], day: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) if (counts(l, day)) out.set(l.company, (out.get(l.company) ?? 0) + l.arr);
  return out;
}

/**
 * A company's account as of `today`: its ARR, its next renewal (the earliest end among the lines counting today),
 * when it became a customer, and its newest deal and that deal's owner (the CSM it starts with).
 */
export function accountOf(lines: readonly Line[], today: string) {
  const live = lines.filter((l) => counts(l, today));
  const latest = lines.reduce<Line | null>((m, l) => (!m || l.start > m.start || (l.start === m.start && l.deal > m.deal) ? l : m), null);
  return {
    arr: live.reduce((n, l) => n + l.arr, 0),
    renewalOn: live.length ? live.map((l) => l.end).sort()[0] : null,
    since: lines.length ? lines.map((l) => l.start).sort()[0] : null,
    lastDeal: latest?.deal ?? null,
    lastOwner: latest?.owner ?? null,
  };
}
