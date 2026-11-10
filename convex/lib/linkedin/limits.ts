/**
 * LinkedIn sending guardrails (docs/linkedin-cadences.md, "Guardrails").
 * Every cap, the warm-up ramp, the sending window and the health throttle live
 * here, so the worker, the settings editor and the tests share one set of
 * numbers. Unipile enforces none of these: if this module says no, nothing is
 * sent.
 *
 * Pure: no database access, no Node-only imports.
 */

export type Tier = "free" | "premium" | "sales_navigator";
export type LimitKey = "invitesPerDay" | "invitesPerWeek" | "messagesPerDay" | "lookupsPerDay";
export type Limits = Record<LimitKey, number>;
export const LIMIT_KEYS: readonly LimitKey[] = ["invitesPerDay", "invitesPerWeek", "messagesPerDay", "lookupsPerDay"];

/** Where a new or cold account starts. */
export const NEW_ACCOUNT: Limits = { invitesPerDay: 5, invitesPerWeek: 30, messagesPerDay: 10, lookupsPerDay: 30 };
/** Canon's recommendation for a warmed-up account. Going above it needs an admin. */
export const RECOMMENDED: Limits = { invitesPerDay: 15, invitesPerWeek: 80, messagesPerDay: 30, lookupsPerDay: 60 };
/** Nothing goes above these. */
export const HARD_CEILING: Limits = { invitesPerDay: 25, invitesPerWeek: 150, messagesPerDay: 100, lookupsPerDay: 100 };
/** Weekly invites a Sales Navigator account may reach when its owner opts in. */
export const SALES_NAV_WEEKLY_CEILING = 200;

/** Warm-up moves this share of the gap from NEW_ACCOUNT to the target each step (one step a week). */
export const RAMP_STEPS = 5;
/** The ramp only advances while the 7-day acceptance rate is at least this. */
export const RAMP_MIN_ACCEPTANCE = 0.3;
/** Accounts with fewer connections than this stay at LOW_NETWORK_INVITES_PER_DAY or below. */
export const LOW_NETWORK_CONNECTIONS = 150;
export const LOW_NETWORK_INVITES_PER_DAY = 10;

/** Below this 7-day acceptance rate the caps are halved; below the pause rate invites stop. */
export const THROTTLE_ACCEPTANCE = 0.25;
export const PAUSE_ACCEPTANCE = 0.15;
/** Acceptance is not judged on fewer invites than this (7-day window). */
export const ACCEPTANCE_MIN_SAMPLE = 20;
/** New invites pause while more than this many are pending. */
export const MAX_PENDING_INVITES = 400;
/** Pending invites are withdrawn after this many days. */
export const WITHDRAW_AFTER_DAYS = 21;

/** Random gap between two actions of one sender. */
export const MIN_GAP_MS = 45_000;
export const MAX_GAP_MS = 180_000;
/** About one working day in this many runs at LIGHT_DAY_FACTOR of its caps. */
export const LIGHT_DAY_ONE_IN = 10;
export const LIGHT_DAY_FACTOR = 0.5;

const DAY_MS = 86_400_000;

/** The ceiling for an account: Sales Navigator may opt in to a higher weekly invite cap. */
export function ceilingFor(tier: Tier, salesNavHighVolume = false): Limits {
  return tier === "sales_navigator" && salesNavHighVolume ? { ...HARD_CEILING, invitesPerWeek: SALES_NAV_WEEKLY_CEILING } : HARD_CEILING;
}

/** The longest invite note LinkedIn accepts on this tier. */
export const noteLimit = (tier: Tier) => (tier === "free" ? 200 : 300);

export type Overrides = Partial<Limits>;

/**
 * Check a user's overrides. Every value is a whole number from 0 to the
 * ceiling; a value above the recommendation needs an admin.
 */
export function validateOverrides(overrides: Overrides, opts: { tier: Tier; salesNavHighVolume?: boolean; isAdmin: boolean }): string | null {
  const ceiling = ceilingFor(opts.tier, opts.salesNavHighVolume);
  for (const key of LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) return `${LABELS[key]} must be a whole number of 0 or more.`;
    if (value > ceiling[key]) return `${LABELS[key]} can't go above ${ceiling[key]}.`;
    if (value > RECOMMENDED[key] && !opts.isAdmin) return `Only an admin can set ${LABELS[key].toLowerCase()} above Canon's recommendation of ${RECOMMENDED[key]}.`;
  }
  if ((overrides.invitesPerDay ?? 0) > (overrides.invitesPerWeek ?? Infinity)) return "Invites per day can't be more than invites per week.";
  return null;
}

export const LABELS: Record<LimitKey, string> = {
  invitesPerDay: "Invites per day",
  invitesPerWeek: "Invites per week",
  messagesPerDay: "Messages per day",
  lookupsPerDay: "Profile lookups per day",
};

/** The warm-up step after a week: forward while acceptance holds (or is not yet judged), otherwise held. */
export function nextRampStep(step: number, acceptance: Acceptance): number {
  if (step >= RAMP_STEPS) return RAMP_STEPS;
  const judged = acceptance.sent >= ACCEPTANCE_MIN_SAMPLE;
  return judged && acceptance.accepted / acceptance.sent < RAMP_MIN_ACCEPTANCE ? step : step + 1;
}

/** Invites sent and accepted in the last 7 days. */
export type Acceptance = { sent: number; accepted: number };

export type Health = {
  /** Why invites are paused, or null. Messages to existing connections still go. */
  invitePause: string | null;
  /** Multiplier on every cap: 1, or THROTTLE when acceptance is low. */
  factor: number;
};

export function healthOf(acceptance: Acceptance, pendingInvites: number): Health {
  if (pendingInvites > MAX_PENDING_INVITES) {
    return { invitePause: `${pendingInvites} invites are pending (limit ${MAX_PENDING_INVITES}). Withdraw old ones first.`, factor: 1 };
  }
  if (acceptance.sent < ACCEPTANCE_MIN_SAMPLE) return { invitePause: null, factor: 1 };
  const rate = acceptance.accepted / acceptance.sent;
  if (rate < PAUSE_ACCEPTANCE) return { invitePause: `Only ${Math.round(rate * 100)}% of invites were accepted this week. Tighten the audience or the note.`, factor: 1 };
  return { invitePause: null, factor: rate < THROTTLE_ACCEPTANCE ? 0.5 : 1 };
}

export type AccountShape = {
  tier: Tier;
  salesNavHighVolume?: boolean;
  overrides?: Overrides;
  rampStep: number;
  connectionCount?: number;
};

/**
 * The caps that apply today: the user's target (their override, else the
 * recommendation), limited by the warm-up ramp, the ceiling, a small network,
 * the health factor and a light day.
 */
export function effectiveLimits(account: AccountShape, health: Health, lightDay = false): Limits {
  const ceiling = ceilingFor(account.tier, account.salesNavHighVolume);
  const ramp = Math.min(Math.max(account.rampStep, 0), RAMP_STEPS) / RAMP_STEPS;
  const out = {} as Limits;
  for (const key of LIMIT_KEYS) {
    const target = Math.min(account.overrides?.[key] ?? RECOMMENDED[key], ceiling[key]);
    // The ramp starts at NEW_ACCOUNT but never above what the user asked for.
    const start = Math.min(NEW_ACCOUNT[key], target);
    let cap = Math.floor(start + (target - start) * ramp);
    cap = Math.floor(cap * health.factor * (lightDay ? LIGHT_DAY_FACTOR : 1));
    out[key] = cap;
  }
  if ((account.connectionCount ?? Infinity) < LOW_NETWORK_CONNECTIONS) out.invitesPerDay = Math.min(out.invitesPerDay, LOW_NETWORK_INVITES_PER_DAY);
  if (health.invitePause) {
    out.invitesPerDay = 0;
    out.invitesPerWeek = 0;
  }
  return out;
}

/** What one sender has done: today (in its timezone) and over the last 7 days. */
export type Usage = { invitesToday: number; invitesWeek: number; messagesToday: number; lookupsToday: number };

export type ActionKind = "invite" | "message" | "lookup";

/** How many more of this action the sender may take now. */
export function remaining(limits: Limits, usage: Usage, kind: ActionKind): number {
  const left =
    kind === "invite"
      ? Math.min(limits.invitesPerDay - usage.invitesToday, limits.invitesPerWeek - usage.invitesWeek)
      : kind === "message"
        ? limits.messagesPerDay - usage.messagesToday
        : limits.lookupsPerDay - usage.lookupsToday;
  return Math.max(0, left);
}

// ───────────────────────────── Sending window ─────────────────────────────

/** Days are 0 (Sunday) to 6; minutes count from local midnight. */
export type SendWindow = { days: number[]; startMinute: number; endMinute: number };
export const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], startMinute: 8 * 60 + 30, endMinute: 18 * 60 };
export const DEFAULT_TIMEZONE = "America/New_York";

export function validateWindow(w: SendWindow): string | null {
  if (!w.days.length || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Pick at least one sending day.";
  if (new Set(w.days).size !== w.days.length) return "Each sending day appears once.";
  if (!Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.endMinute > 1440) return "Sending hours are within one day.";
  if (w.endMinute - w.startMinute < 60) return "The sending window is at least one hour.";
  return null;
}

import { localTime } from "../timeZone.ts";

export { localTime, validTimezone } from "../timeZone.ts";

export function inWindow(nowMs: number, window: SendWindow, tz: string): boolean {
  const t = localTime(nowMs, tz);
  return window.days.includes(t.weekday) && t.minute >= window.startMinute && t.minute < window.endMinute;
}

/** When the sender's local day began: the boundary for "today" counts. */
export function localDayStart(nowMs: number, tz: string): number {
  const t = localTime(nowMs, tz);
  // Step back the local minutes, then correct for a DST change within the day.
  let start = nowMs - t.minute * 60_000 - (nowMs % 60_000);
  for (let i = 0; i < 2; i++) {
    const s = localTime(start, tz);
    if (s.date === t.date && s.minute === 0) break;
    start -= (s.date === t.date ? s.minute : s.minute - 1440) * 60_000;
  }
  return start;
}

export const weekStart = (nowMs: number) => nowMs - 7 * DAY_MS;

/** A stable ~1-in-LIGHT_DAY_ONE_IN pick of light days per sender, so the load is never the same every day. */
export function isLightDay(senderKey: string, localDate: string): boolean {
  let h = 2166136261;
  for (const ch of `${senderKey}|${localDate}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % LIGHT_DAY_ONE_IN === 0;
}

/** Today's sending window as timestamps, from the sender's local midnight (an hour off on a DST change day). */
export function windowBounds(nowMs: number, window: SendWindow, tz: string): { start: number; end: number } {
  const day = localDayStart(nowMs, tz);
  return { start: day + window.startMinute * 60_000, end: day + window.endMinute * 60_000 };
}

/**
 * When the next invite may go, so a day's invites are spread across the
 * sending window instead of sent in a burst when it opens: the time left is
 * split evenly over the invites left, and the next one lands at a random point
 * of its share. `rand` is in [0, 1). With nothing left today, the window's end.
 */
export function nextInviteSlot(from: number, windowEnd: number, invitesLeft: number, rand: number): number {
  if (invitesLeft <= 0 || from >= windowEnd) return windowEnd;
  const share = (windowEnd - from) / invitesLeft;
  return Math.min(windowEnd, from + Math.max(MIN_GAP_MS, Math.round(share * Math.min(Math.max(rand, 0), 1))));
}

/** The pause before a sender's next action; `rand` is in [0, 1). */
export const nextGapMs = (rand: number) => Math.round(MIN_GAP_MS + (MAX_GAP_MS - MIN_GAP_MS) * Math.min(Math.max(rand, 0), 1));

// ───────────────────────────── Queue estimate ─────────────────────────────

const ESTIMATE_STEP_MS = 15 * 60_000;
export const ESTIMATE_HORIZON_DAYS = 60;

/**
 * When each queued invite is likely to go out, replaying the worker's rules:
 * only inside the sending window, at most the day's cap (light days halved,
 * today's sends counted) and the rolling 7-day cap, spread across the window.
 * Returns one time per queue position, in queue order; null past the horizon. An estimate:
 * messages, holds and ramp changes can move it.
 */
export function estimateInviteTimes(a: {
  queued: number;
  now: number;
  window: SendWindow;
  timezone: string;
  senderKey: string;
  account: AccountShape;
  health: Health;
  invitesToday: number;
  /** When each invite of the last 7 days went out. */
  recentInvites: number[];
}): (number | null)[] {
  const out: (number | null)[] = [];
  const sent = [...a.recentInvites];
  const today = localTime(a.now, a.timezone).date;
  const end = a.now + ESTIMATE_HORIZON_DAYS * DAY_MS;
  let lastDate = "";
  // After `now`, step on quarter hours so a window opening at 8:30 is hit exactly.
  for (let t = a.now; out.length < a.queued && t < end; t = (Math.floor(t / ESTIMATE_STEP_MS) + 1) * ESTIMATE_STEP_MS) {
    if (!inWindow(t, a.window, a.timezone)) continue;
    const date = localTime(t, a.timezone).date;
    if (date === lastDate) continue;
    lastDate = date;
    const limits = effectiveLimits(a.account, a.health, isLightDay(a.senderKey, date));
    const inWeek = sent.filter((s) => s > t - 7 * DAY_MS).length;
    const room = Math.max(0, Math.min(limits.invitesPerDay - (date === today ? a.invitesToday : 0), limits.invitesPerWeek - inWeek));
    // The worker spreads the day's invites over what is left of the window; place each mid-share.
    const span = Math.max(0, windowBounds(t, a.window, a.timezone).end - t);
    for (let i = 0; i < room && out.length < a.queued; i++) {
      const at = t + Math.round(((i + 0.5) * span) / room);
      out.push(at);
      sent.push(at);
    }
    // Tomorrow's window opens at least ~23 hours after today's did.
    t += 12 * 60 * 60_000;
  }
  while (out.length < a.queued) out.push(null);
  return out;
}
