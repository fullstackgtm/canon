/**
 * When invites get accepted: how many accept within N days of the invite,
 * week by week, and at what hour and weekday. Only invites old enough to
 * have had the full N days count toward an N-day rate, so a cadence that
 * keeps sending isn't penalised for invites that are still young.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { EnrollmentState } from "./cadence.ts";

const DAY_MS = 86_400_000;
/** Days after the invite at which acceptance is measured. 21 is when an invite is withdrawn. */
export const ACCEPT_WITHIN_DAYS = [1, 3, 7, 14, 21] as const;

export type Timed = { state: EnrollmentState; invitedAt?: number | null; connectedAt?: number | null; acceptedAt?: number | null };

/**
 * When an invited person accepted, or null. `acceptedAt` is LinkedIn's own
 * connection time; older rows only have `connectedAt`, when the sync (every
 * few hours) noticed it.
 */
export function acceptedAtOf(r: Timed): number | null {
  if (r.invitedAt == null || r.connectedAt == null) return null;
  return r.acceptedAt ?? r.connectedAt;
}

export type AcceptanceDay = { at: number; invited: number; accepted: number };

/** Cumulative daily totals in UTC, from the first invite through today. */
export function cumulativeAcceptance(rows: readonly Timed[], now: number): AcceptanceDay[] {
  const changes = new Map<number, { invited: number; accepted: number }>();
  const day = (at: number) => Math.floor(at / DAY_MS) * DAY_MS;
  const add = (at: number, key: "invited" | "accepted") => {
    const date = day(at);
    const counts = changes.get(date) ?? { invited: 0, accepted: 0 };
    counts[key]++;
    changes.set(date, counts);
  };
  for (const row of rows) {
    if (row.invitedAt == null || !Number.isFinite(row.invitedAt) || row.invitedAt > now) continue;
    add(row.invitedAt, "invited");
    const accepted = acceptedAtOf(row);
    if (accepted !== null && accepted >= row.invitedAt && accepted <= now) add(accepted, "accepted");
  }
  if (changes.size === 0) return [];
  const days: AcceptanceDay[] = [];
  let invited = 0;
  let accepted = 0;
  for (let at = Math.min(...changes.keys()); at <= day(now); at += DAY_MS) {
    const change = changes.get(at);
    invited += change?.invited ?? 0;
    accepted += change?.accepted ?? 0;
    days.push({ at, invited, accepted });
  }
  return days;
}

export type Window = { days: number; eligible: number; accepted: number };

/** Share of invites accepted within each window, counting only invites at least that old. */
export function acceptanceCurve(rows: readonly Timed[], now: number): Window[] {
  return ACCEPT_WITHIN_DAYS.map((days) => {
    let eligible = 0;
    let accepted = 0;
    for (const r of rows) {
      if (r.invitedAt == null || now - r.invitedAt < days * DAY_MS) continue;
      eligible++;
      const at = acceptedAtOf(r);
      if (at !== null && at - r.invitedAt <= days * DAY_MS) accepted++;
    }
    return { days, eligible, accepted };
  });
}

export type Cohort = { weekStart: number; invited: number; accepted: number; windows: Window[] };

/** Invites grouped by the UTC week (Monday) they went out, newest first, each with its own curve. */
export function inviteCohorts(rows: readonly Timed[], now: number): Cohort[] {
  const byWeek = new Map<number, Timed[]>();
  for (const r of rows) {
    if (r.invitedAt == null) continue;
    const day = Math.floor(r.invitedAt / DAY_MS);
    // Day 0 (1970-01-01) was a Thursday; Monday-based weeks start 3 days earlier.
    const week = (day - ((day + 3) % 7)) * DAY_MS;
    byWeek.set(week, [...(byWeek.get(week) ?? []), r]);
  }
  return [...byWeek.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([weekStart, group]) => ({
      weekStart,
      invited: group.length,
      accepted: group.filter((r) => acceptedAtOf(r) !== null).length,
      windows: acceptanceCurve(group, now),
    }));
}

export type AcceptanceTimes = { byHour: number[]; byWeekday: number[]; counted: number; approximate: number };

/**
 * Acceptances by local hour (0-23) and weekday (0 = Sunday) in `timezone`.
 * Only rows with LinkedIn's own time count: a sync time says when we looked,
 * not when they accepted.
 */
export function acceptanceTimes(rows: readonly Timed[], timezone: string): AcceptanceTimes {
  const byHour = Array<number>(24).fill(0);
  const byWeekday = Array<number>(7).fill(0);
  let counted = 0;
  let approximate = 0;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23", weekday: "short" });
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const r of rows) {
    if (acceptedAtOf(r) === null) continue;
    if (r.acceptedAt == null) { approximate++; continue; }
    const parts = fmt.formatToParts(r.acceptedAt);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
    if (!Number.isInteger(hour) || weekday < 0) continue;
    byHour[hour % 24]++;
    byWeekday[weekday]++;
    counted++;
  }
  return { byHour, byWeekday, counted, approximate };
}
