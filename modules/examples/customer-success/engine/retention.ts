/**
 * Net and gross revenue retention (docs/module-plans/customer-success.md §6) over the ARR ledger. The cohort is the
 * companies with ARR the day before the period starts; new logos are reported apart, in neither ratio. Exact minor
 * units and fractions: the page rounds.
 */
import { addDays, arrOn, type Line } from "./contracts.ts";

export type Totals = {
  start: number; end: number; grrNumerator: number;
  /** end ÷ start and grrNumerator ÷ start, or null for an empty cohort. */
  nrr: number | null; grr: number | null;
  churn: number; contraction: number; expansion: number; accounts: number;
};
export type Outcome = "churned" | "contracted" | "expanded" | "flat" | "new";
export type CompanyRetention = { company: string; start: number; end: number; outcome: Outcome };

const empty = (): Totals => ({ start: 0, end: 0, grrNumerator: 0, nrr: null, grr: null, churn: 0, contraction: 0, expansion: 0, accounts: 0 });
function add(t: Totals, c: CompanyRetention) {
  t.start += c.start; t.end += c.end; t.grrNumerator += Math.min(c.start, c.end); t.accounts += 1;
  if (c.end === 0) t.churn += c.start;
  else if (c.end < c.start) t.contraction += c.start - c.end;
  else t.expansion += c.end - c.start;
}
const ratios = (t: Totals): Totals => ({ ...t, nrr: t.start > 0 ? t.end / t.start : null, grr: t.start > 0 ? t.grrNumerator / t.start : null });

/** Each company's ARR the day before `from` and on `to`: the cohort's, and the new logos' (none before, some at the end). */
export function companiesOver(lines: readonly Line[], from: string, to: string): CompanyRetention[] {
  const before = arrOn(lines, addDays(from, -1)), after = arrOn(lines, to);
  const out: CompanyRetention[] = [];
  for (const company of new Set([...before.keys(), ...after.keys()])) {
    const start = before.get(company) ?? 0, end = after.get(company) ?? 0;
    const outcome: Outcome = start === 0 ? "new" : end === 0 ? "churned" : end < start ? "contracted" : end > start ? "expanded" : "flat";
    out.push({ company, start, end, outcome });
  }
  return out.sort((a, b) => b.start - a.start || b.end - a.end || a.company.localeCompare(b.company));
}

/**
 * Retention for [from, to], in total and per group (`groupOf` names a company's segment or CSM): start, end, the
 * gross numerator Σ min(end, start), NRR, GRR, churn, contraction and expansion; and the new logos' ARR at the end.
 */
export function retention(lines: readonly Line[], from: string, to: string, groupOf?: (company: string) => string) {
  const companies = companiesOver(lines, from, to);
  const total = empty(), groups = new Map<string, Totals>();
  const newLogos = companies.filter((c) => c.outcome === "new");
  for (const c of companies) {
    if (c.outcome === "new") continue;
    add(total, c);
    if (groupOf) {
      const g = groupOf(c.company);
      if (!groups.has(g)) groups.set(g, empty());
      add(groups.get(g)!, c);
    }
  }
  return {
    total: ratios(total),
    groups: new Map([...groups].map(([g, t]) => [g, ratios(t)])),
    companies,
    newLogos: newLogos.map((c) => ({ company: c.company, arr: c.end })),
    newLogoArr: newLogos.reduce((n, c) => n + c.end, 0),
  };
}

/** NRR and GRR from `from` to each month's end in the period (the last point is `to`): how the period's ratios built up. */
export function monthly(lines: readonly Line[], from: string, to: string): Array<{ month: string; nrr: number | null; grr: number | null }> {
  const out: Array<{ month: string; nrr: number | null; grr: number | null }> = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7);) {
    const [y, mo] = m.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const { total } = retention(lines, from, monthEnd < to ? monthEnd : to);
    out.push({ month: m, nrr: total.nrr, grr: total.grr });
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  return out;
}
