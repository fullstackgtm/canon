import { addDays } from "./contracts.ts";

export type Metrics = Record<string, number>;
export type Usage = { day: string; metrics: Metrics };
export type GrowSettings = { declinePercent: number; inactiveDays: number; renewalDays: number; seatPercent: number; growthPercent: number };
export const GROW_DEFAULTS: GrowSettings = { declinePercent: 30, inactiveDays: 14, renewalDays: 90, seatPercent: 90, growthPercent: 25 };
export const SIGNAL_KINDS = ["declining", "inactive", "renewal", "seats", "growth"] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];
export type Signal = { kind: SignalKind; category: "Churn risk" | "Expansion"; title: string; evidence: string };
export const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export const domainOf = (x: unknown): string | null => {
  if (typeof x !== "string") return null;
  const domain = x.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
};

export function dailyUsage(data: unknown, today: string): Usage | string {
  if (!object(data) || typeof data.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.day)
    || !Number.isFinite(Date.parse(data.day)) || new Date(data.day).toISOString().slice(0, 10) !== data.day) return "A daily aggregate needs a valid UTC day (YYYY-MM-DD).";
  if (data.day > today || data.day < addDays(today, -90)) return "The day must be within the last 90 days, including today.";
  if (!object(data.metrics) || !Object.keys(data.metrics).length || Object.keys(data.metrics).length > 30) return "Supply 1 to 30 numeric daily metrics.";
  const metrics: Metrics = {};
  for (const [name, value] of Object.entries(data.metrics)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12) return "Metrics need names in snake_case and finite values from 0 to 1 trillion.";
    metrics[name] = value;
  }
  return { day: data.day, metrics };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const round = (n: number) => Math.round(n * 10) / 10;

/** Missing days are unknown. Comparisons require at least 21 reported days in each complete 28-day window. */
export function usageSignals(usage: readonly Usage[], account: { renewalOn?: string }, today: string, settings: GrowSettings = GROW_DEFAULTS): Signal[] {
  const rows = [...new Map(usage.filter((u) => u.day <= today).map((u) => [u.day, u])).values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!rows.length) return [];
  const out: Signal[] = [];
  const add = (kind: SignalKind, category: Signal["category"], title: string, evidence: string) => out.push({ kind, category, title, evidence });
  const active = rows.filter((u) => u.metrics.active_users !== undefined);
  const window = (from: number, to: number) => active.filter((u) => u.day >= addDays(today, from) && u.day < addDays(today, to));
  const prior = window(-56, -28), recent = window(-28, 0);
  const mean = (items: Usage[]) => items.reduce((n, u) => n + u.metrics.active_users, 0) / items.length;
  const baseline = mean(prior), current = mean(recent);
  const covered = prior.length >= 21 && recent.length >= 21;
  const drop = covered && baseline > 0 ? (baseline - current) / baseline * 100 : 0;
  const comparison = `Active users/day ${round(baseline)} to ${round(current)} (${round(drop)}% down). ${addDays(today, -56)}–${addDays(today, -29)}: ${prior.length}/28 days; ${addDays(today, -28)}–${addDays(today, -1)}: ${recent.length}/28 days.`;
  if (covered && drop >= settings.declinePercent) add("declining", "Churn risk", "Active users declining", `${comparison} Threshold ${settings.declinePercent}%.`);
  const renewalIn = account.renewalOn ? daysBetween(today, account.renewalOn) : -1;
  if (covered && drop >= settings.declinePercent && renewalIn >= 0 && renewalIn <= settings.renewalDays) add("renewal", "Churn risk", "Renewal with declining usage", `Renews ${account.renewalOn}, in ${renewalIn} days (within ${settings.renewalDays}). ${comparison} Decline threshold ${settings.declinePercent}%.`);
  const activity = rows.filter((u) => u.metrics.active_users !== undefined || u.metrics.key_events !== undefined);
  const lastPositive = activity.filter((u) => (u.metrics.active_users ?? 0) > 0 || (u.metrics.key_events ?? 0) > 0).at(-1);
  const lastReport = activity.at(-1);
  if (lastReport) {
    const since = lastPositive?.day ?? activity[0].day;
    const days = daysBetween(since, today);
    if (days >= settings.inactiveDays) add("inactive", "Churn risk", "No reported usage", `${days} days since ${lastPositive ? "positive activity" : "tracking began with zero activity"} on ${since}; threshold ${settings.inactiveDays}. Last activity report ${lastReport.day}, ${daysBetween(lastReport.day, today)} days ago. Missing reports may indicate a feed outage.`);
  }
  const seats = rows.filter((u) => u.metrics.seats_used !== undefined && (u.metrics.seats_purchased ?? 0) > 0).at(-1);
  if (seats && daysBetween(seats.day, today) <= 2) {
    const ratio = seats.metrics.seats_used / seats.metrics.seats_purchased * 100;
    if (ratio >= settings.seatPercent) add("seats", "Expansion", "Seats near limit", `${seats.metrics.seats_used}/${seats.metrics.seats_purchased} seats used (${round(ratio)}%) on ${seats.day}; threshold ${settings.seatPercent}%.`);
  }
  const weeks = Array.from({ length: 4 }, (_, i) => window(-28 + i * 7, -21 + i * 7));
  if (covered && baseline > 0 && weeks.every((w) => w.length >= 5 && mean(w) >= baseline * (1 + settings.growthPercent / 100))) add("growth", "Expansion", "Sustained usage growth", `Prior 4-week active users/day ${round(baseline)} (${prior.length}/28 days). Each recent week averages ${weeks.map((w) => round(mean(w))).join(", ")} with ${weeks.map((w) => w.length).join(", ")} reported days; each at least ${settings.growthPercent}% above baseline.`);
  return out;
}
