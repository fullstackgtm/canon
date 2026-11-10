/**
 * Which sequence steps a person does, when a step runs and which A/B variant a contact gets. The Sequences module
 * plans its enrollments with these, and Canon applies the same rules when it runs a launched sequence
 * (convex/lib/sequences/lifecycle.ts) and prepares its emails (convex/lib/outbound/sq1Preparation.ts), so both agree.
 * No reads, no clock: everything comes in as arguments.
 */

/** A named schedule: the days (0 Sunday … 6 Saturday) and hours sends go out, in the sender's time zone. */
export type Schedule = { days: readonly number[]; start: string; end: string; timeZone: string; holidays: readonly string[] };
export type StepKind = "auto_email" | "manual_email" | "linkedin_invite" | "linkedin_message" | "linkedin_task" | "call" | "task";
export type Variant = { id: string; weight: number; paused?: boolean; subject?: string; body: string };
export type Step = { kind: StepKind; delayDays: number; thread?: boolean; variants?: readonly Variant[] };

/** Steps a person does (a task in the inbox): the enrollment waits on them. The rest Canon sends. */
export const MANUAL_STEPS: readonly StepKind[] = ["manual_email", "linkedin_task", "call", "task"];

// ── Dates in a schedule's time zone ──

export const DAY_MS = 86_400_000;
const parts = (ms: number, timeZone: string) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
};
/** The calendar date ("YYYY-MM-DD") it is at `ms` in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  const { y, m, d } = parts(ms, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** The instant a local date and time ("HH:MM") is in `timeZone`. */
export function zonedMs(date: string, hhmm: string, timeZone: string): number {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 0, minutesOf(hhmm));
  const offset = (ms: number) => { const p = parts(ms, timeZone); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000; };
  const first = guess - offset(guess);
  return guess - offset(first);
}
/** The calendar date `n` days after `date`. */
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const isOpenDay = (date: string, s: Schedule) => s.days.includes(weekday(date)) && !s.holidays.includes(date);
/** The first open day on or after `date`. */
export function nextOpenDay(date: string, s: Schedule): string {
  let d = date;
  for (let i = 0; i < 400 && !isOpenDay(d, s); i++) d = addDays(d, 1);
  return d;
}
/** `n` schedule days after `date` (0: `date` itself, or the next open day when it is closed). */
export function addScheduleDays(date: string, n: number, s: Schedule): string {
  let d = nextOpenDay(date, s);
  for (let i = 0; i < n; i++) d = nextOpenDay(addDays(d, 1), s);
  return d;
}
/** The day an enrollment made at `now` can first send: today while the window is still open, else the next open day. */
export function firstDay(now: number, s: Schedule): string {
  const today = localDate(now, s.timeZone);
  const { h, min } = parts(now, s.timeZone);
  return isOpenDay(today, s) && h * 60 + min < minutesOf(s.end) ? today : nextOpenDay(addDays(today, 1), s);
}

// ── Planning ──

/** Where an enrollment stands: the next step to run (`stepIndex`) and the day its last step ran, if any. */
export type Position = { stepIndex: number; lastDay: string | null };
export type Planned = { done: true } | { done: false; stepIndex: number; day: string; nextAt: number };

/**
 * When the next step runs: its delay after the day the last step ran (the first step's after the first day it can),
 * in schedule days, or in calendar days rolled onto an open day. `nextAt` is that day's opening, never before `now`.
 */
export function plan(pos: Position, steps: readonly Step[], s: Schedule, now: number, interval: "schedule_days" | "calendar_days" = "schedule_days"): Planned {
  const step = steps[pos.stepIndex];
  if (!step) return { done: true };
  const base = pos.lastDay ?? firstDay(now, s);
  const day = interval === "schedule_days" ? addScheduleDays(base, step.delayDays, s) : nextOpenDay(addDays(base, step.delayDays), s);
  return { done: false, stepIndex: pos.stepIndex, day, nextAt: Math.max(zonedMs(day, s.start, s.timeZone), now) };
}

/** FNV-1a, 32 bits: the same text always lands on the same number, on every runtime. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
/**
 * A contact's A/B arm on a step: `hash(contact:stepIndex)` into the live variants' weights (paused ones out, the rest
 * scaled to their sum). No randomness and nothing stored: a rerun gives the same arm. Null when every variant is paused.
 */
export function arm(contact: string, stepIndex: number, variants: readonly Variant[]): Variant | null {
  const live = variants.filter((v) => !v.paused && v.weight > 0);
  const total = live.reduce((n, v) => n + v.weight, 0);
  if (!live.length) return null;
  let point = (hash32(`${contact}:${stepIndex}`) % 10_000) / 10_000 * total;
  for (const v of live) { if (point < v.weight) return v; point -= v.weight; }
  return live[live.length - 1];
}
