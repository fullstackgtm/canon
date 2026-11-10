import assert from "node:assert/strict";
import test from "node:test";
import { teamOf } from "../convex/lib/calls/suggestions.ts";
import { decideEvent, type CalendarEvent } from "../convex/lib/calendar/events.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const event = (extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  icalUid: "uid-1", instanceStart: NOW + DAY, title: "Pilot review", startAt: NOW + DAY, endAt: NOW + DAY + HOUR, allDay: false, cancelled: false,
  visibility: "default", eventType: "default",
  attendees: [{ email: "ada@example.com", response: "accepted" }, { email: "grace@example.org", name: "Grace Hopper", response: "accepted" }],
  ...extra,
});
const ctx = {
  member: "ada@example.com", team: teamOf(["ada@example.com", "bob@example.com"], []), now: NOW,
  contacts: new Map([["grace@example.org", "contact-grace"]]), accounts: new Map([["example.org", "acc-example-org"], ["example.net", "acc-example-net"]]),
};
const why = (e: CalendarEvent) => { const d = decideEvent(e, ctx); return d.log ? "log" : d.reason; };

test("a calendar event is a meeting only when someone from outside the team on it is in Canon", () => {
  const people = (...emails: string[]) => [{ email: "ada@example.com", response: "accepted" as const }, ...emails.map((email) => ({ email, response: "pending" as const }))];
  assert.deepEqual(plain(decideEvent(event({ attendees: [...people("grace@example.org", "alan@example.org", "pat@gmail.com"), { email: "bob@example.com", response: "accepted" }] }), ctx)), {
    log: true, contactIds: ["contact-grace"], accountIds: ["acc-example-org"],
    outside: [{ email: "grace@example.org", response: "pending" }, { email: "alan@example.org", response: "pending" }, { email: "pat@gmail.com", response: "pending" }],
    unknown: [{ email: "alan@example.org", response: "pending" }],
  });
  const cases: Array<[string, Partial<CalendarEvent>]> = [
    ["log", { attendees: people("someone@example.net") }],
    ["private", { visibility: "private" }],
    ["private", { visibility: "confidential" }],
    ["all_day", { allDay: true }],
    ["time_block", { eventType: "outOfOffice" }],
    ["time_block", { eventType: "focusTime" }],
    ["time_block", { eventType: "workingLocation" }],
    ["too_many", { attendees: people(...Array.from({ length: 25 }, (_, i) => `p${i}@example.org`)) }],
    ["declined", { attendees: [{ email: "ADA@example.com", response: "declined" }, { email: "grace@example.org", response: "accepted" }] }],
    ["internal", { attendees: people("bob@example.com") }],
    ["no_match", { attendees: people("stranger@example.edu", "friend@gmail.com") }],
  ];
  assert.deepEqual(cases.map(([, e]) => why(event(e))), cases.map(([want]) => want));
});

test("only instances first scheduled from 90 days back to 30 days ahead are logged", () => {
  const at = (days: number) => why(event({ instanceStart: NOW + days * DAY, startAt: NOW + days * DAY }));
  assert.deepEqual([-91, -89, 0, 29, 31].map(at), ["outside_window", "log", "log", "log", "outside_window"]);
});

function harness() {
  const db = memoryDb({ users: [{ _id: "users:ada", orgId: "organizations:o", email: "ada@example.com", name: "Ada", role: "rep", isActive: true }] });
  const writes: Array<{ op: string; streamId: string; values: Record<string, unknown> }> = [];
  let made = 0;
  const M = loadConvex(["calendarEvents.ts", "granola.ts", "callSuggestions.ts"], {
    "objects.ts": (real) => ({
      ...real,
      saveAsCaller: async (_c: unknown, _u: unknown, object: string, cmd: { op: string; streamId?: string; values: Record<string, unknown> }) => {
        const streamId = cmd.op === "create" ? `meeting-${++made}` : cmd.streamId!;
        if (object === "meeting") writes.push({ op: cmd.op, streamId, values: cmd.values });
        return { status: "applied", streamId };
      },
    }),
    "activityTargets.ts": (real) => ({ ...real, attachTargets: async () => {} }),
    "permissions.ts": (real) => ({ ...real, accessFor: async () => ({ userId: "users:ada", role: "rep" }) }),
    "records.ts": (real) => ({
      ...real,
      principalClient: () => ({
        listRegister: async (_o: string, object: string) => ({ rows: object === "contact" ? [{ id: "contact-grace", values: { email: "grace@example.org" } }] : [{ id: "acc-example-org", values: { domain: "example.org" } }] }),
      }),
    }),
  });
  const mctx = { db, scheduler: { runAfter: async () => {} } };
  const run = async (ref: unknown, args: Record<string, unknown>) => {
    const [, file, fn] = String(ref).split(".");
    if (file === "dealPlays") return { access: {} };
    if (file === "conversations") return { memberEmails: ["ada@example.com"], ourTeam: [] };
    return M[`${file}.ts`][fn].handler(mctx, args);
  };
  const log = (e: CalendarEvent) => M["calendarEvents.ts"].logEvent.handler(mctx, { orgId: "organizations:o", userId: "users:ada", event: e, contactIds: ["contact-grace"], companies: [{ id: "acc-example-org", domain: "example.org" }] });
  const ingest = (events: CalendarEvent[]) => M["calendarEvents.ts"].ingest.handler({ runQuery: run, runMutation: run, runAction: run }, { orgId: "organizations:o", userId: "users:ada", memberEmail: "ada@example.com", events });
  return { db, M, mctx, writes, log, ingest };
}

test("an update moves the meeting's start and a cancellation cancels it; a cancellation Canon never logged stores nothing", async () => {
  const h = harness();
  assert.equal((await h.log(event({ icalUid: "gone", cancelled: true }))).status, "skipped");
  assert.equal((await h.log(event())).status, "logged");
  assert.equal((await h.log(event())).status, "skipped");
  assert.equal((await h.log(event({ startAt: NOW + DAY + HOUR, endAt: NOW + DAY + 2 * HOUR }))).status, "updated");
  assert.equal((await h.log(event({ startAt: NOW + DAY + HOUR, cancelled: true }))).status, "updated");
  assert.deepEqual(plain(h.writes.map((w) => [w.op, w.streamId, w.values.startAt ?? null, w.values.outcome ?? null])), [
    ["create", "meeting-1", NOW + DAY, "scheduled"],
    ["update", "meeting-1", NOW + DAY + HOUR, null],
    ["update", "meeting-1", null, "canceled"],
  ]);
  assert.equal(h.db.rows("calendarEventLinks").length, 1);
});

test("a calendar event and its Granola note are one meeting, whichever arrives first", async () => {
  const note = async (h: ReturnType<typeof harness>, callId: string, meetingStreamId?: string) => {
    await h.db.insert("callRecordings", {
      // Recording began 25 minutes after the scheduled start: the scheduled start is what matches.
      _id: callId, orgId: "organizations:o", provider: "granola", ownerId: "users:ada", title: "Pilot review", callDate: new Date(NOW + DAY + 25 * 60_000).toISOString(),
      sourceMetadata: { provider: "granola", ...(meetingStreamId ? { meetingStreamId, contactIds: ["contact-grace"] } : {}) }, createdAt: 0, updatedAt: 0,
    });
    const [call] = h.db.rows("callRecordings").filter((c) => c.title === "Pilot review").slice(-1);
    return call._id as string;
  };
  const granola = (h: ReturnType<typeof harness>, callId: string) => h.M["granola.ts"].logMeeting.handler(h.mctx, {
    orgId: "organizations:o", userId: "users:ada", callId, title: "Pilot review", startAt: NOW + DAY + 25 * 60_000, scheduledStartAt: NOW + DAY,
    notes: "Budget approved.", contactIds: ["contact-grace"], companies: [],
  });

  const eventFirst = harness();
  await eventFirst.log(event());
  assert.equal((await granola(eventFirst, await note(eventFirst, "callRecordings:c1"))).status, "updated");
  assert.deepEqual(plain(eventFirst.writes.map((w) => [w.op, w.streamId, w.values.outcome])), [["create", "meeting-1", "scheduled"], ["update", "meeting-1", "completed"]]);

  const notesFirst = harness();
  const callId = await note(notesFirst, "callRecordings:c2");
  assert.equal((await granola(notesFirst, callId)).status, "logged");
  assert.equal((await notesFirst.log(event())).status, "linked");
  assert.deepEqual(plain(notesFirst.writes.map((w) => [w.op, w.streamId])), [["create", "meeting-1"]]);
  assert.deepEqual(plain(notesFirst.db.rows("calendarEventLinks").map((l) => l.meetingStreamId)), ["meeting-1"]);
});

test("an unknown colleague on a logged meeting is suggested, and an internal-only event stores nothing", async () => {
  const h = harness();
  const internal = event({ icalUid: "standup", attendees: [{ email: "ada@example.com", response: "accepted" }, { email: "bob@example.com", response: "accepted" }] });
  const withColleague = event({ attendees: [...event().attendees, { email: "alan@example.org", name: "Alan Turing", response: "pending" }] });
  assert.deepEqual(plain(await h.ingest([internal, withColleague])), ["internal", "logged"]);
  assert.equal(h.db.rows("calendarEventLinks").length, 1);
  assert.deepEqual(plain(h.db.rows("callSuggestions").map((s) => [s.kind, s.key, s.meetingStreamId, s.status])), [["contact", "alan@example.org", "meeting-1", "pending"]]);
});
