/**
 * Date ranges people type (docs/modules.md, "Reports and charts"): "last 2 quarters", "this fiscal year", "Q3 2026",
 * "since March", "2026-01-01 to 2026-03-31". Each reads as a first and a last day (`YYYY-MM-DD`, both in the range), or
 * null when it isn't one. Quarters and years follow the workspace's fiscal year (the month it starts in), a fiscal year
 * named by the year it ends in (FY2027: July 2026 to June 2027). "Last <n> <units>" is the n whole units before this
 * one; "last <n> days" ends today. Pure: the report builder, a page's date range and tests read it.
 */
export type DateRange = { from: string | null; to: string | null; label: string };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};
/** The last day of month `m` (1 to 12, or past it) of year `y`. */
const endOf = (y: number, m: number) => ymd(y, m + 1, 0);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const monthOf = (word: string): number | null => {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(w));
  return i >= 0 ? i + 1 : null;
};
/** The presets a range picker offers, in order. */
export const DATE_PRESETS = ["This month", "Last month", "This quarter", "Last quarter", "This fiscal year", "Last fiscal year", "Year to date", "Last 30 days", "Last 90 days", "All time"] as const;

/**
 * `text` as a range, on `today` (`YYYY-MM-DD`) in a workspace whose fiscal year starts in `fyStart` (1 to 12). "All
 * time" is a range with neither end.
 */
export function parseDateRange(text: string, today: string, fyStart = 1): DateRange | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  /** The text as typed, its first letter capital: the range's label. */
  const said = text.trim().replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (!t) return null;
  const [ty, tm, td] = today.split("-").map(Number);
  const fy = Number.isInteger(fyStart) && fyStart >= 1 && fyStart <= 12 ? fyStart : 1;
  /** The fiscal year (by its last year) holding month `m` of year `y`, and the quarter (0-3) and its first month. */
  const fyOf = (y: number, m: number) => (fy === 1 ? y : m >= fy ? y + 1 : y);
  const fyStartOf = (year: number) => ({ y: fy === 1 ? year : year - 1, m: fy });
  const quarterStart = (y: number, m: number) => { const off = (m - fy + 12) % 12; const back = off % 3; return m - back < 1 ? { y: y - 1, m: m - back + 12 } : { y, m: m - back }; };
  const month = (y: number, m: number) => ({ from: ymd(y, m, 1), to: endOf(y, m) });
  const span = (y: number, m: number, months: number) => ({ from: ymd(y, m, 1), to: endOf(y, m + months - 1) });
  const fyName = (year: number) => (fy === 1 ? String(year) : `FY${year}`);
  const out = (r: { from: string | null; to: string | null }, label: string): DateRange => ({ ...r, label });
  const date = (s: string): string | null => {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (us) return ymd(Number(us[3]), Number(us[1]), Number(us[2]));
    const named = /^([a-z]+)\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(s);
    if (named && monthOf(named[1])) return ymd(named[3] ? Number(named[3]) : ty, monthOf(named[1])!, Number(named[2]));
    return null;
  };
  /** A period a word names, as its first and last day: a date, a month, a quarter, a fiscal year, a year. */
  const period = (s: string): { from: string; to: string } | null => {
    const d = date(s);
    if (d) return { from: d, to: d };
    const q = /^q([1-4])(?: (?:fy)?(\d{2,4}))?$/.exec(s.replace(/^fy(\d{2,4}) q([1-4])$/, "q$2 $1"));
    if (q) {
      const year = q[2] ? (q[2].length === 2 ? 2000 + Number(q[2]) : Number(q[2])) : fyOf(ty, tm);
      const s0 = fyStartOf(year);
      return span(s0.y, s0.m + (Number(q[1]) - 1) * 3, 3);
    }
    const f = /^fy ?(\d{2}|\d{4})$/.exec(s);
    if (f) { const year = f[1].length === 2 ? 2000 + Number(f[1]) : Number(f[1]); const s0 = fyStartOf(year); return span(s0.y, s0.m, 12); }
    const y = /^(\d{4})$/.exec(s);
    if (y) return span(Number(y[1]), 1, 12);
    const my = /^([a-z]+)\.?(?: (\d{4}))?$/.exec(s);
    if (my && monthOf(my[1])) {
      const m = monthOf(my[1])!;
      // A month without a year is the latest one by today: "March" in February is last March.
      const year = my[2] ? Number(my[2]) : m > tm ? ty - 1 : ty;
      return month(year, m);
    }
    return null;
  };

  if (t === "all time" || t === "all" || t === "any time") return out({ from: null, to: null }, "All time");
  if (t === "today") return out({ from: today, to: today }, "Today");
  if (t === "yesterday") { const d = ymd(ty, tm, td - 1); return out({ from: d, to: d }, "Yesterday"); }
  const unitRe = "(day|week|month|quarter|year|fiscal year)s?";
  const rel = new RegExp(`^(this|current|last|previous|prior|next) (?:(\\d+|${Object.keys(NUMBERS).join("|")}) )?${unitRe}$`).exec(t)
    ?? new RegExp(`^(past|trailing) (?:(\\d+|${Object.keys(NUMBERS).join("|")}) )?${unitRe}$`).exec(t);
  if (rel) {
    const which = rel[1] === "current" ? "this" : rel[1] === "previous" || rel[1] === "prior" ? "last" : rel[1] === "trailing" ? "past" : rel[1];
    const n = rel[2] ? Number(rel[2]) || NUMBERS[rel[2]] || 1 : 1;
    if (n > 120) return null;
    const unit = rel[3];
    const label = text.trim().replace(/^./, (c) => c.toUpperCase());
    if (unit === "day") {
      if (which === "this") return out({ from: today, to: today }, "Today");
      if (which === "next") return out({ from: ymd(ty, tm, td + 1), to: ymd(ty, tm, td + n) }, label);
      return out({ from: ymd(ty, tm, td - n + 1), to: today }, label);
    }
    if (unit === "week") {
      const dow = (new Date(Date.UTC(ty, tm - 1, td)).getUTCDay() + 6) % 7;
      const monday = td - dow;
      if (which === "this") return out({ from: ymd(ty, tm, monday), to: ymd(ty, tm, monday + 6) }, label);
      if (which === "next") return out({ from: ymd(ty, tm, monday + 7), to: ymd(ty, tm, monday + 7 * n + 6) }, label);
      if (which === "past") return out({ from: ymd(ty, tm, td - 7 * n + 1), to: today }, label);
      return out({ from: ymd(ty, tm, monday - 7 * n), to: ymd(ty, tm, monday - 1) }, label);
    }
    const months = unit === "month" ? 1 : unit === "quarter" ? 3 : 12;
    const start = unit === "month" ? { y: ty, m: tm } : unit === "quarter" ? quarterStart(ty, tm) : unit === "year" ? { y: ty, m: 1 } : fyStartOf(fyOf(ty, tm));
    if (which === "this") return out(span(start.y, start.m, months), unit === "fiscal year" ? fyName(fyOf(ty, tm)) : label);
    if (which === "next") return out(span(start.y, start.m + months, months * n), label);
    if (which === "past") return out({ from: ymd(ty, tm - months * n + 1, 1), to: today }, label);
    return out(span(start.y, start.m - months * n, months * n), unit === "fiscal year" && n === 1 ? fyName(fyOf(ty, tm) - 1) : label);
  }
  const todate = /^(year|quarter|month|fiscal year)[ -]to[ -]date$|^(ytd|qtd|mtd|fytd)$/.exec(t);
  if (todate) {
    const u = todate[1] ?? { ytd: "year", qtd: "quarter", mtd: "month", fytd: "fiscal year" }[todate[2]]!;
    const s0 = u === "month" ? { y: ty, m: tm } : u === "quarter" ? quarterStart(ty, tm) : u === "year" ? { y: ty, m: 1 } : fyStartOf(fyOf(ty, tm));
    return out({ from: ymd(s0.y, s0.m, 1), to: today }, `${u.replace(/^./, (c) => c.toUpperCase())} to date`);
  }
  const since = /^(since|from|after) (.+)$/.exec(t);
  if (since && !/ (to|until|through|-) /.test(since[2])) { const p = period(since[2]); if (p) return out({ from: since[1] === "after" ? ymd(Number(p.to.slice(0, 4)), Number(p.to.slice(5, 7)), Number(p.to.slice(8)) + 1) : p.from, to: null }, said); }
  const before = /^(before|until|through) (.+)$/.exec(t);
  if (before) { const p = period(before[2]); if (p) return out({ from: null, to: before[1] === "before" ? ymd(Number(p.from.slice(0, 4)), Number(p.from.slice(5, 7)), Number(p.from.slice(8)) - 1) : p.to }, said); }
  const between = /^(?:from |between )?(.+?) (?:to|until|through|and|-) (.+)$/.exec(t);
  if (between) {
    const a = period(between[1]), b = period(between[2]);
    if (a && b && a.from <= b.to) return out({ from: a.from, to: b.to }, said);
  }
  const one = period(t);
  if (one) return out(one, said);
  return null;
}
