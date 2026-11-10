/**
 * The two arrival orders of one meeting, which end as one meeting (docs/calendar-meetings.md): a Granola note of a
 * meeting the calendar logged updates that meeting (`calendarMeetingFor`, convex/granola.ts logMeeting), and a
 * calendar event of a meeting a Granola note logged links to it (`granolaMeetingFor`, convex/calendarEvents.ts).
 * Both match the same owner, a scheduled start within MERGE_WINDOW_MS, and at least one Canon person on both.
 */
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { MERGE_WINDOW_MS } from "./events.ts";

const CANDIDATES_MAX = 20;
/** How far a note's recorded start (its call's date) can be from the calendar's: a recording started late, or early. */
const RECORDED_SLACK_MS = 6 * 3_600_000;
const overlaps = (a: readonly string[], b: readonly string[]) => a.some((x) => b.includes(x));

/** The meeting stream of `userId`'s calendar event starting near `startAt` with one of `contactIds`, or null. */
export async function calendarMeetingFor(ctx: QueryCtx, userId: Id<"users">, startAt: number, contactIds: readonly string[]): Promise<string | null> {
  const links = await ctx.db.query("calendarEventLinks")
    .withIndex("by_ownerUserId_and_startAt", (q) => q.eq("ownerUserId", userId).gte("startAt", startAt - MERGE_WINDOW_MS).lte("startAt", startAt + MERGE_WINDOW_MS))
    .take(CANDIDATES_MAX);
  return links.find((l) => overlaps(l.contactIds, contactIds))?.meetingStreamId ?? null;
}

/**
 * The meeting stream a Granola note of `userId`'s logged for a meeting scheduled near `startAt`, with one of
 * `contactIds`, or null. The call's date is when recording began; the scheduled start it kept is what matches.
 */
export async function granolaMeetingFor(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">, startAt: number, contactIds: readonly string[]): Promise<string | null> {
  const iso = (t: number) => new Date(t).toISOString();
  const calls = await ctx.db.query("callRecordings")
    .withIndex("by_orgId_callDate", (q) => q.eq("orgId", orgId).gte("callDate", iso(startAt - RECORDED_SLACK_MS)).lte("callDate", iso(startAt + RECORDED_SLACK_MS)))
    .take(CANDIDATES_MAX * 5);
  for (const call of calls) {
    const m = (call.sourceMetadata ?? {}) as { meetingStreamId?: unknown; contactIds?: unknown; scheduledStartAt?: unknown };
    const people = Array.isArray(m.contactIds) ? m.contactIds.filter((x): x is string => typeof x === "string") : [];
    const scheduled = typeof m.scheduledStartAt === "number" ? m.scheduledStartAt : call.callDate ? Date.parse(call.callDate) : NaN;
    if (call.provider === "granola" && call.ownerId === userId && typeof m.meetingStreamId === "string" && Math.abs(scheduled - startAt) <= MERGE_WINDOW_MS && overlaps(people, contactIds)) return m.meetingStreamId;
  }
  return null;
}
