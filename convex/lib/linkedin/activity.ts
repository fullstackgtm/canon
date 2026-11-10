/**
 * Recent LinkedIn activity, checked before an invite (docs/linkedin-cadences.md,
 * "Activity check"). The sender's own account reads the person's latest posts
 * and comments; someone with neither inside the cadence's window is stopped
 * instead of invited. A result is kept per org and reused for ACTIVITY_FRESH_MS,
 * so the same person is not looked at twice a month.
 *
 * Pure: no database access, no Node-only imports.
 */

const DAY_MS = 86_400_000;

/** A cadence with no setting skips people quiet for this many days. 0 turns the check off. */
export const ACTIVE_WITHIN_DAYS_DEFAULT = 90;
/** The choices the cadence editor offers. */
export const ACTIVE_WITHIN_DAYS_CHOICES = [0, 30, 60, 90, 180] as const;
/** A stored check is reused for this long. */
export const ACTIVITY_FRESH_MS = 30 * DAY_MS;
/** Calls one check makes (posts, comments); each counts as a lookup. */
export const ACTIVITY_LOOKUPS = 2;

/** The cadence's window in days, or null when the check is off. */
export function activeWithinDaysOf(setting: number | undefined): number | null {
  const days = setting ?? ACTIVE_WITHIN_DAYS_DEFAULT;
  return days > 0 ? days : null;
}

export function validActiveWithinDays(days: number): boolean {
  return (ACTIVE_WITHIN_DAYS_CHOICES as readonly number[]).includes(days);
}

const RELATIVE = /^(\d+)\s*(s|m|min|h|hr|d|w|wk|mo|y|yr)s?\b/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: DAY_MS, w: 7 * DAY_MS, wk: 7 * DAY_MS, mo: 30 * DAY_MS, y: 365 * DAY_MS, yr: 365 * DAY_MS };

/**
 * When something happened, as ms: epoch ms or seconds, ISO text, or LinkedIn's
 * relative text ("3d", "2w", "1mo", "now"), which is measured back from `now`.
 */
export function activityTimeOf(raw: unknown, now: number): number | null {
  if (typeof raw === "number") return raw > 0 && Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return activityTimeOf(Number(text), now);
  if (/^(now|just now)$/i.test(text)) return now;
  const rel = RELATIVE.exec(text);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The newest time among items, or null when none has one. A time in the future counts as now. */
export function latestOf(items: readonly unknown[], timesOf: (item: Record<string, unknown>) => unknown[], now: number): number | null {
  let latest: number | null = null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const raw of timesOf(item as Record<string, unknown>)) {
      const t = activityTimeOf(raw, now);
      if (t !== null) latest = Math.max(latest ?? 0, Math.min(t, now));
    }
  }
  return latest;
}

/** A post's time: when they reposted it, or when they wrote it. */
export const postTimes = (p: Record<string, unknown>) => (p.is_repost ? [p.repost_parsed_datetime, p.parsed_datetime, p.date] : [p.parsed_datetime, p.date]);
export const commentTimes = (c: Record<string, unknown>) => [c.created_at, c.date];

/** True when nothing they did falls inside the window. */
export function isDormant(lastActiveAt: number | null, now: number, withinDays: number): boolean {
  return lastActiveAt === null || lastActiveAt < now - withinDays * DAY_MS;
}

export function dormantReason(lastActiveAt: number | null, withinDays: number): string {
  return lastActiveAt === null
    ? "No recent posts or comments on LinkedIn; not invited"
    : `No LinkedIn posts or comments in ${withinDays} days; not invited`;
}

/** A stored check the worker can reuse. */
export function freshCheck<T extends { checkedAt: number }>(row: T | null | undefined, now: number): T | null {
  return row && now - row.checkedAt < ACTIVITY_FRESH_MS ? row : null;
}
