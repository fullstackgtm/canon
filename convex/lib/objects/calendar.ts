/**
 * A calendar view (docs/core-crm-parity.md, "Group-by and views on any object"): which day a record falls on, the
 * month's range a calendar reads, and the month grid. Pure: the list view and tests share it.
 *
 * The rule. A `date` field is a calendar day (`YYYY-MM-DD`) and lands on that day for everyone, never shifted by
 * a time zone. A date-time (an instant) lands on its day in the workspace's time zone (`organizations.timezone`,
 * UTC when it has none that parses, as automations read it), so one shared view shows every viewer the same day.
 * Reports' grouped counts bucket an instant by its UTC day instead; a calendar places a record on a day someone
 * reads, so it uses the workspace's.
 */
import { localTime, validTimezone } from "../timeZone.ts";
import { groupKeyKind } from "./reportSpec.ts";
import type { ListFilter, Scalar } from "./listSpec.ts";
import type { ResolvedObjectDef } from "./registry.ts";

/** Records a calendar reads for one month, in pages of the list's largest (200). Past them it asks for a narrower filter. */
export const CALENDAR_MONTH_MAX = 600;
/** Records a day's cell shows before "N more", which opens the day's own list. */
export const CALENDAR_DAY_SHOWN = 3;
/** Weeks start on Monday, as reports' week buckets do; a workspace has no week-start setting. */
export const WEEK_STARTS_ON = 1;

/** How a calendar reads its field: a calendar day, or an instant placed in the workspace's zone. */
export type CalendarKind = "day" | "instant";

/** How `name` places records on a calendar, or null when it is not a date or a date-time. */
export function calendarKind(def: ResolvedObjectDef, name: string): CalendarKind | null {
  const kind = groupKeyKind(def, name);
  return kind === "day" || kind === "instant" ? kind : null;
}

/** The zone a calendar places instants in: the workspace's, or UTC when it has none that parses. */
export const calendarZone = (timezone: string | null | undefined): string => (timezone && validTimezone(timezone) ? timezone : "UTC");

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseDay = (day: string): Date => {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};
/** `day` moved by `n` calendar days. */
export const addDays = (day: string, n: number): string => ymd(new Date(parseDay(day).getTime() + n * 86_400_000));

/**
 * The instant `zone`'s clocks read `day` at `minute` past midnight, found by correcting a guess until the local date
 * and time match, so a DST change on that day moves neither. A time a spring-forward skips lands an hour off, on the same day.
 */
export function zoneTime(day: string, minute: number, zone: string): number {
  let at = parseDay(day).getTime() + minute * 60_000;
  for (let i = 0; i < 4; i++) {
    const t = localTime(at, zone);
    const days = Math.round((parseDay(day).getTime() - parseDay(t.date).getTime()) / 86_400_000);
    const off = days * 1440 + minute - t.minute;
    if (off === 0) break;
    at += off * 60_000;
  }
  return at;
}

/** When `day` begins in `zone`, as epoch ms. */
export const zoneMidnight = (day: string, zone: string): number => zoneTime(day, 0, zone);

/** The day a record's value falls on: a date as it is, an instant's local date in `zone`; null for none. */
export function dayOf(kind: CalendarKind, value: unknown, zone: string): string | null {
  if (kind === "day") return typeof value === "string" && DAY.test(value) ? value : null;
  return typeof value === "number" && Number.isFinite(value) ? localTime(value, zone).date : null;
}

/** The filters that select the records on days `from` up to, not including, `to`. */
export function daysFilter(field: string, kind: CalendarKind, from: string, to: string, zone: string): Array<ListFilter & { value: Scalar }> {
  const at = (day: string) => (kind === "day" ? day : zoneMidnight(day, zone));
  return [{ field, op: "gte", value: at(from) }, { field, op: "lt", value: at(to) }];
}

/** A month's first day and the next month's, for `month` as `YYYY-MM`. */
export function monthBounds(month: string): { from: string; to: string } {
  const from = parseDay(`${month}-01`);
  return { from: ymd(from), to: ymd(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))) };
}

/** `month` moved by `n` months. */
export function addMonths(month: string, n: number): string {
  const d = parseDay(`${month}-01`);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}`;
}

/** The month grid: whole weeks from the week holding the 1st to the week holding the last day, each day `YYYY-MM-DD`. */
export function monthWeeks(month: string): string[][] {
  const { from, to } = monthBounds(month);
  const lead = (parseDay(from).getUTCDay() - WEEK_STARTS_ON + 7) % 7;
  const weeks: string[][] = [];
  for (let day = addDays(from, -lead); day < to; day = addDays(day, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
  return weeks;
}

/** Records by the day they fall on, each day's in the order given. */
export function placeByDay<R extends { values: Record<string, unknown> }>(rows: readonly R[], fieldId: string, kind: CalendarKind, zone: string): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const day = dayOf(kind, row.values[fieldId], zone);
    if (!day) continue;
    const list = out.get(day) ?? [];
    list.push(row);
    out.set(day, list);
  }
  return out;
}

/** A day's cell: the records it shows, and how many more open in the day's list. */
export function dayCell<R>(rows: readonly R[] | undefined): { shown: R[]; more: number } {
  const all = rows ?? [];
  return { shown: all.slice(0, CALENDAR_DAY_SHOWN), more: Math.max(0, all.length - CALENDAR_DAY_SHOWN) };
}

/**
 * The value a record dragged to `day` takes: the day itself for a date; for an instant, the same time of day in the
 * workspace's zone on the new day.
 */
export function movedTo(kind: CalendarKind, value: unknown, day: string, zone: string): Scalar {
  if (kind === "day" || typeof value !== "number") return kind === "day" ? day : zoneMidnight(day, zone);
  return zoneTime(day, localTime(value, zone).minute, zone) + (value % 60_000);
}
