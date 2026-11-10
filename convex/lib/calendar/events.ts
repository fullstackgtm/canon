/**
 * Calendar events as meetings (docs/calendar-meetings.md): whether one event from a member's calendar is logged as
 * a `meeting`, and what it is about. Provider-neutral: a transport (Unipile on hosted, Google or Microsoft directly
 * later) turns its events into `CalendarEvent`s, recurring ones already expanded into instances, as Google's
 * `singleEvents`, Microsoft's `calendarView` and Unipile's `expand_recurring` return them.
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "../calls/granola.ts";
import { isOurSide, type Team } from "../calls/suggestions.ts";

const DAY_MS = 86_400_000;
/** Instances from this far back are logged... */
export const PAST_DAYS = 90;
/** ...and up to this far ahead. */
export const FUTURE_DAYS = 30;
/** An event with more people than this is a broadcast, not a meeting. */
export const ATTENDEES_MAX = 25;
/** A Granola note joins the calendar's meeting when the scheduled starts are this close (and someone is on both). */
export const MERGE_WINDOW_MS = 10 * 60_000;
/** Event types that are time blocks, not meetings (Google's names; providers that have none send "default"). */
const BLOCK_TYPES = new Set(["outofoffice", "focustime", "workinglocation"]);

export type CalendarAttendee = { email: string; name?: string; response: "accepted" | "declined" | "tentative" | "pending" };

export type CalendarEvent = {
  /** RFC 5545 UID: the same on every calendar the event is on, and on every instance of a recurring one. */
  icalUid: string;
  /** When this instance was first scheduled (its recurrence id), so a moved instance keeps its identity; a single event's start. */
  instanceStart: number;
  title: string;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
  cancelled: boolean;
  visibility: "default" | "public" | "private" | "confidential";
  eventType: string;
  /** Everyone invited, the organizer and the member included. */
  attendees: CalendarAttendee[];
  location?: string;
};

export type SkipReason = "outside_window" | "private" | "all_day" | "time_block" | "too_many" | "declined" | "internal" | "no_match";

export type EventDecision =
  | { log: false; reason: SkipReason }
  | { log: true; contactIds: string[]; accountIds: string[]; outside: CalendarAttendee[]; unknown: CalendarAttendee[] };

/**
 * Whether `member`'s calendar event is logged: it is when someone outside the team on it is a Canon person (by email)
 * or works at a Canon company (by business domain). Skipped: instances outside the window, private or confidential
 * events, all-day events, time blocks (out of office, focus time, working location), events with more than
 * `ATTENDEES_MAX` people, events the member declined, and events with no one from outside. `unknown` are the outside
 * people with a business domain who match nothing: suggestions, never records.
 */
export function decideEvent(
  event: CalendarEvent,
  ctx: { member: string; team: Team; contacts: ReadonlyMap<string, string>; accounts: ReadonlyMap<string, string>; now: number },
): EventDecision {
  const at = event.instanceStart;
  if (at < ctx.now - PAST_DAYS * DAY_MS || at > ctx.now + FUTURE_DAYS * DAY_MS) return { log: false, reason: "outside_window" };
  if (event.visibility === "private" || event.visibility === "confidential") return { log: false, reason: "private" };
  if (event.allDay) return { log: false, reason: "all_day" };
  if (BLOCK_TYPES.has(event.eventType.toLowerCase())) return { log: false, reason: "time_block" };
  if (event.attendees.length > ATTENDEES_MAX) return { log: false, reason: "too_many" };
  const member = ctx.member.toLowerCase();
  if (event.attendees.some((a) => a.email.toLowerCase() === member && a.response === "declined")) return { log: false, reason: "declined" };
  const outside = event.attendees.filter((a) => a.email.toLowerCase() !== member && !isOurSide(ctx.team, a.email));
  if (!outside.length) return { log: false, reason: "internal" };
  const contactIds: string[] = [];
  const accountIds: string[] = [];
  const unknown: CalendarAttendee[] = [];
  for (const a of outside) {
    const contactId = ctx.contacts.get(a.email.toLowerCase());
    const domain = domainOfEmail(a.email);
    const accountId = FREE_EMAIL_DOMAINS.has(domain) ? undefined : ctx.accounts.get(domain);
    if (contactId && !contactIds.includes(contactId)) contactIds.push(contactId);
    if (accountId && !accountIds.includes(accountId)) accountIds.push(accountId);
    if (!contactId && !FREE_EMAIL_DOMAINS.has(domain)) unknown.push(a);
  }
  if (!contactIds.length && !accountIds.length) return { log: false, reason: "no_match" };
  return { log: true, contactIds, accountIds, outside, unknown };
}

/** The meeting an event writes: a cancelled one is `canceled`; any other is `scheduled` until notes say it happened. */
export function meetingValuesOf(event: CalendarEvent): Record<string, unknown> {
  return {
    title: (event.title.trim() || "Meeting").slice(0, 500),
    startAt: event.startAt,
    ...(event.endAt !== null && event.endAt > event.startAt ? { endAt: event.endAt } : {}),
    ...(event.location ? { location: event.location.slice(0, 500) } : {}),
    outcome: event.cancelled ? "canceled" : "scheduled",
  };
}
