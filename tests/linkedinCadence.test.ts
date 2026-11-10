import assert from "node:assert/strict";
import test from "node:test";
import { afterConnected, afterMessage, chooseWork, funnelOf, inStage, planEnrollment, publicIdentifierOf, rate, render, validateSteps, type Step } from "../convex/lib/linkedin/cadence.ts";
import { accountEffectOf, inviteRefusal, settleRetry } from "../convex/lib/linkedin/outcomes.ts";
import { activeWithinDaysOf, activityTimeOf, isDormant, latestOf, postTimes } from "../convex/lib/linkedin/activity.ts";
import { performInvite, performMessage, performSync, type EnrollmentRef } from "../convex/lib/linkedin/perform.ts";
import { UnipileError, timeOf, type UnipileClient } from "../convex/lib/linkedin/unipile.ts";
import { acceptanceCurve, acceptanceTimes, inviteCohorts } from "../convex/lib/linkedin/acceptance.ts";

const steps: Step[] = [
  { kind: "invite", note: "Hi {{firstName}}, saw {{company}} is hiring." },
  { kind: "message", body: "Thanks {{firstName}}. {{custom.hook}}", delayDays: 1 },
  { kind: "message", body: "Worth a chat?", delayDays: 3 },
];
const contact = (id: string, over: Record<string, unknown> = {}) => ({
  id, fullName: "Ada Lovelace", company: "Acme", title: "CRO", linkedinUrl: `https://www.linkedin.com/in/ada-${id}/`, custom: { "custom.hook": "Loved the post." }, ...over,
});

test("steps: invite first, 1-5 messages, known merge fields, note within the plan's limit", () => {
  assert.equal(validateSteps(steps, "premium"), null);
  assert.match(validateSteps([steps[1]], "premium") ?? "", /starts with a connection invite/);
  assert.equal(validateSteps([steps[0]], "premium"), null);
  assert.match(validateSteps([steps[0], { kind: "message", body: "Hi {{nickname}}", delayDays: 1 }], "premium") ?? "", /Unknown merge field \{\{nickname\}\}/);
  assert.match(validateSteps([{ kind: "invite", note: "x".repeat(250) }, steps[1]], "free") ?? "", /200 characters/);
  assert.deepEqual(render("Hi {{ firstName }}", { firstName: "Ada" }), { text: "Hi Ada" });
  assert.deepEqual(render("Hi {{firstName}} at {{company}}", { firstName: "Ada" }), { missing: ["company"] });
});

test("enrollment plan: keeps only usable profiles, says why the rest were skipped, stores only the fields used", () => {
  const out = planEnrollment(
    [
      contact("1"),
      contact("2", { linkedinUrl: "https://example.com/ada" }),
      contact("3", { custom: {} }),
      contact("4"),
      contact("5"),
      contact("6", { linkedinUrl: "linkedin.com/in/ada-1" }),
    ],
    steps,
    "premium",
    { active: new Set(["4"]), inCadence: new Set(["5"]) },
  );
  assert.deepEqual(out.enroll.map((e) => e.contactId), ["1"]);
  assert.deepEqual(out.enroll[0].vars, { firstName: "Ada", company: "Acme", "custom.hook": "Loved the post." });
  assert.deepEqual(out.skipped.map((s) => [s.contactId, s.reason]), [
    ["2", "No LinkedIn profile URL"],
    ["3", "No value for {{custom.hook}}"],
    ["4", "Already in another active LinkedIn cadence"],
    ["5", "Already enrolled in this cadence"],
    ["6", "Same LinkedIn profile as another contact"],
  ]);
  assert.equal(publicIdentifierOf("https://www.linkedin.com/in/j%C3%B6rg-x?trk=1"), "jörg-x");
  assert.equal(publicIdentifierOf("https://www.linkedin.com/company/acme"), null);
});

test("transitions and work order: messages before invites, sync first when due, retries end in failure", () => {
  const now = 1_000_000;
  assert.deepEqual(afterMessage(steps, 1, now), { state: "connected", stepIndex: 2, nextAt: now + 3 * 86_400_000 });
  assert.deepEqual(afterMessage(steps, 2, now), { state: "done" });
  assert.deepEqual(afterConnected([steps[0]], 1, now), { state: "done" });
  assert.deepEqual(afterConnected(steps, 0, now), { state: "connected", stepIndex: 1, nextAt: now + (steps[1] as { delayDays: number }).delayDays * 86_400_000 });
  const budget = { invites: 1, messages: 1, lookups: 1 };
  assert.equal(chooseWork({ messageDue: true, inviteDue: true, syncDue: false, budget }), "message");
  assert.equal(chooseWork({ messageDue: true, inviteDue: true, syncDue: false, budget: { ...budget, messages: 0 } }), "invite");
  assert.equal(chooseWork({ messageDue: false, inviteDue: true, syncDue: false, budget: { ...budget, lookups: 0 } }), null);
  assert.equal(chooseWork({ messageDue: true, inviteDue: false, syncDue: true, budget }), "sync");
  assert.equal(settleRetry(0, "x", now).state, "retry");
  assert.equal(settleRetry(2, "x", now).state, "failed");
  assert.deepEqual(inviteRefusal({ status: 422, type: "errors/already_connected" }), { kind: "connected" });
  assert.equal(accountEffectOf({ status: 422, type: "errors/limit_exceeded" }, "invite")?.inviteHoldMs, 86_400_000);
  assert.equal(accountEffectOf({ status: 422, type: "errors/limit_exceeded" }, "message"), null);
  assert.equal(accountEffectOf({ status: 403, type: "errors/account_restricted" }, "message")?.status, "paused");
});

/** A Unipile that records calls; each method can be replaced per test. */
function fakeClient(over: Partial<Record<keyof UnipileClient, (...args: never[]) => unknown>>) {
  const calls: string[] = [];
  const base = {
    getProfile: async () => ({ providerId: "ACoA1", publicIdentifier: "ada-1", connected: false, invitePending: false }),
    invite: async () => ({ invitationId: "inv1" }),
    chatsWith: async () => [],
    repliedSince: async () => false,
    startChat: async () => ({ chatId: "chat1" }),
    sendMessage: async () => undefined,
    relations: async () => ({ items: [], cursor: null }),
    sentInvites: async () => new Map(),
    cancelInvite: async () => undefined,
    recentPosts: async () => [],
    recentComments: async () => [],
  };
  const client = Object.fromEntries(
    Object.entries({ ...base, ...over }).map(([k, fn]) => [k, async (...args: unknown[]) => { calls.push(k); return (fn as (...a: unknown[]) => unknown)(...args); }]),
  ) as unknown as UnipileClient;
  return { client, calls };
}
const ref = (id: string, over: Partial<EnrollmentRef> = {}) => ({ id, providerId: null, publicIdentifier: "ada-1", invitationId: null, ...over }) as EnrollmentRef;

test("invite: looks the profile up, invites with the note, and maps LinkedIn's refusals", async () => {
  const ok = fakeClient({});
  const out = await performInvite(ok.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1"), note: "Hi Ada", activeWithinDays: null });
  assert.deepEqual(ok.calls, ["getProfile", "invite"]);
  assert.deepEqual(out.sends.map((s) => s.kind), ["lookup", "invite"]);
  assert.deepEqual(out.events, [{ event: "invited", id: "e1", providerId: "ACoA1", invitationId: "inv1" }]);

  const already = fakeClient({ getProfile: async () => ({ providerId: "ACoA1", publicIdentifier: null, connected: true, invitePending: false }) });
  assert.equal((await performInvite(already.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1"), note: null, activeWithinDays: null })).events[0].event, "connected");
  assert.deepEqual(already.calls, ["getProfile"]);

  const limited = fakeClient({ invite: async () => { throw new UnipileError(422, "errors/limit_exceeded"); } });
  const refused = await performInvite(limited.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1", { providerId: "ACoA1" }), note: null, activeWithinDays: null });
  assert.deepEqual(limited.calls, ["invite"]);
  assert.deepEqual(refused.sends, [{ kind: "invite", ok: false, error: "errors/limit_exceeded", enrollmentId: "e1" }]);
  assert.equal(refused.events[0].event, "retry");
  assert.equal(refused.effect?.inviteHoldMs, 86_400_000);
});

test("message: a reply since the invite stops the cadence before anything is sent", async () => {
  const job = { kind: "message" as const, unipileAccountId: "acc", enrollment: { ...ref("e1", { providerId: "ACoA1" }), chatId: null, since: 0 }, text: "Hi" };
  const replied = fakeClient({ chatsWith: async () => ["chat9"], repliedSince: async () => true });
  assert.deepEqual((await performMessage(replied.client, job)).events, [{ event: "replied", id: "e1" }]);
  assert.deepEqual(replied.calls, ["chatsWith", "repliedSince"]);

  const fresh = fakeClient({});
  const sent = await performMessage(fresh.client, job);
  assert.deepEqual(fresh.calls, ["chatsWith", "startChat"]);
  assert.deepEqual(sent.events, [{ event: "sent", id: "e1", chatId: "chat1" }]);
});

test("sync: accepted invites connect; overdue ones are checked, then withdrawn by their invitation id", async () => {
  const { client, calls } = fakeClient({
    relations: async () => ({ items: [{ memberId: "ACoA1", publicIdentifier: null, connectedAt: 1_700_000_000_000 }], cursor: null }),
    getProfile: async () => ({ providerId: "ACoA3", publicIdentifier: "c", connected: false, invitePending: true }),
    sentInvites: async () => new Map([["ACoA3", "inv3"]]),
  });
  const out = await performSync(client, {
    kind: "sync", unipileAccountId: "acc", lookups: 5,
    invited: [ref("e1", { providerId: "ACoA1" }), ref("e2", { providerId: "ACoA2", publicIdentifier: "b" }), ref("e3", { providerId: "ACoA3", publicIdentifier: "c" })],
    overdue: [ref("e3", { providerId: "ACoA3", publicIdentifier: "c" })],
  });
  assert.deepEqual(out.events, [{ event: "connected", id: "e1", accepted: true, acceptedAt: 1_700_000_000_000 }, { event: "withdrawn", id: "e3" }]);
  assert.deepEqual(calls, ["relations", "getProfile", "sentInvites", "cancelInvite"]);
  assert.deepEqual(out.sends.map((s) => s.kind), ["sync", "lookup", "withdraw"]);
});

test("funnel: completed, stopped and failed enrollments retain their historical sends and acceptances", () => {
  const f = funnelOf([
    { state: "done", invitedAt: 1, connectedAt: 2, lastSentAt: 3 },
    { state: "stopped", invitedAt: 1, connectedAt: 2, lastSentAt: 3 },
    { state: "failed", invitedAt: 1, connectedAt: 2 },
    { state: "withdrawn", invitedAt: 1 },
    { state: "failed" },
  ]);
  assert.deepEqual(f, { enrolled: 5, invited: 4, pending: 0, accepted: 3, alreadyConnected: 0, messaged: 2, replied: 0 });
  assert.equal(rate(f.accepted, f.invited), 75);
});

test("funnel: a new cadence has no historical outcomes or acceptance rate", () => {
  const f = funnelOf([]);
  assert.deepEqual(f, { enrolled: 0, invited: 0, pending: 0, accepted: 0, alreadyConnected: 0, messaged: 0, replied: 0 });
  assert.equal(rate(f.accepted, f.invited), null);
});

test("funnel: acceptance counts only people we invited; existing connections and pending invites are kept apart", () => {
  const f = funnelOf([
    { state: "queued" },
    { state: "invited", invitedAt: 1 },
    { state: "withdrawn", invitedAt: 1 },
    { state: "connected", invitedAt: 1, connectedAt: 2 },
    { state: "replied", invitedAt: 1, connectedAt: 2, lastSentAt: 3 },
    { state: "done", connectedAt: 2, lastSentAt: 3 },
  ]);
  assert.deepEqual(f, { enrolled: 6, invited: 4, pending: 1, accepted: 2, alreadyConnected: 1, messaged: 2, replied: 1 });
  assert.equal(rate(f.accepted, f.invited), 50);
  assert.equal(rate(0, 0), null);
});

const DAY = 86_400_000;
const MON = Date.UTC(2026, 9, 5); // Monday 2026-10-05

test("acceptance timing: an N-day rate counts only invites at least N days old, week by week", () => {
  const now = MON + 10 * DAY;
  const rows = [
    { state: "connected" as const, invitedAt: MON, connectedAt: MON + 0.5 * DAY, acceptedAt: MON + 0.4 * DAY },
    { state: "withdrawn" as const, invitedAt: MON },
    { state: "done" as const, invitedAt: MON + DAY, connectedAt: MON + 5 * DAY }, // sync time only
    { state: "invited" as const, invitedAt: MON + 8 * DAY }, // next week, 2 days old
    { state: "queued" as const },
  ];
  const curve = acceptanceCurve(rows, now);
  assert.deepEqual(curve.slice(0, 3), [
    { days: 1, eligible: 4, accepted: 1 },
    { days: 3, eligible: 3, accepted: 1 },
    { days: 7, eligible: 3, accepted: 2 },
  ]);
  assert.deepEqual(curve.at(-1), { days: 21, eligible: 0, accepted: 0 });
  const weeks = inviteCohorts(rows, now);
  assert.deepEqual(weeks.map((w) => [w.weekStart, w.invited, w.accepted]), [[MON + 7 * DAY, 1, 0], [MON, 3, 2]]);
  assert.deepEqual(weeks[0].windows[1], { days: 3, eligible: 0, accepted: 0 });
  // Only LinkedIn's own time places an acceptance by hour: 0.4 days past midnight UTC is 09:36, 05:36 in New York.
  const times = acceptanceTimes(rows, "America/New_York");
  assert.equal(times.byHour[5], 1);
  assert.equal(times.byWeekday[1], 1);
  assert.deepEqual([times.counted, times.approximate], [1, 1]);
});

test("funnel stages list exactly the people they count", () => {
  const rows = [{ state: "invited" as const, invitedAt: 1 }, { state: "done" as const, connectedAt: 2, lastSentAt: 3 }];
  assert.deepEqual(rows.map((r) => inStage(r, "pending")), [true, false]);
  assert.deepEqual(rows.map((r) => inStage(r, "alreadyConnected")), [false, true]);
  assert.equal(funnelOf(rows).messaged, rows.filter((r) => inStage(r, "messaged")).length);
});

test("Unipile timestamps: ms, seconds and ISO text all read as ms", () => {
  assert.equal(timeOf(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(timeOf(1_700_000_000), 1_700_000_000_000);
  assert.equal(timeOf("2023-11-14T22:13:20.000Z"), 1_700_000_000_000);
  assert.equal(timeOf(null), null);
  assert.equal(timeOf("soon"), null);
});

test("activity: times parse from ISO, epoch and LinkedIn's relative text", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(activityTimeOf("2026-10-01T00:00:00Z", now), Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(activityTimeOf(1_760_000_000, now), 1_760_000_000_000);
  assert.equal(activityTimeOf("3d", now), now - 3 * 86_400_000);
  assert.equal(activityTimeOf("2mo", now), now - 60 * 86_400_000);
  assert.equal(activityTimeOf("1 yr", now), now - 365 * 86_400_000);
  assert.equal(activityTimeOf("garbage", now), null);
  const reposted = { is_repost: true, repost_parsed_datetime: "2026-10-20T00:00:00Z", parsed_datetime: "2025-01-01T00:00:00Z" };
  assert.equal(latestOf([reposted, { parsed_datetime: "2026-09-01T00:00:00Z" }], postTimes, now), Date.parse("2026-10-20T00:00:00Z"));
  assert.equal(isDormant(null, now, 90), true);
  assert.equal(isDormant(now - 89 * 86_400_000, now, 90), false);
  assert.equal(activeWithinDaysOf(undefined), 90);
  assert.equal(activeWithinDaysOf(0), null);
});

test("invite: a quiet profile is stopped before the invite; an active one is invited", async () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const quiet = fakeClient({ recentPosts: async () => [{ parsed_datetime: "2025-01-01T00:00:00Z" }] });
  const stopped = await performInvite(quiet.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1"), note: null, activeWithinDays: 90 }, now);
  assert.deepEqual(quiet.calls, ["getProfile", "recentPosts", "recentComments"]);
  assert.deepEqual(stopped.events.map((e) => e.event), ["activity", "dormant"]);
  assert.equal(stopped.sends.filter((s) => s.kind === "lookup").length, 3, "each activity call counts as a lookup");

  const active = fakeClient({ recentComments: async () => [{ date: "5d" }] });
  const invited = await performInvite(active.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1", { providerId: "ACoA1" }), note: null, activeWithinDays: 30 }, now);
  assert.deepEqual(active.calls, ["recentPosts", "recentComments", "invite"]);
  assert.deepEqual(invited.events.map((e) => e.event), ["activity", "invited"]);
  assert.equal((invited.events[0] as { lastActiveAt: number }).lastActiveAt, now - 5 * 86_400_000);

  const connected = fakeClient({ getProfile: async () => ({ providerId: "ACoA1", publicIdentifier: null, connected: true, invitePending: false }) });
  await performInvite(connected.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1"), note: null, activeWithinDays: 90 }, now);
  assert.deepEqual(connected.calls, ["getProfile"], "already connected: no activity check");

  const limited = fakeClient({ recentPosts: async () => { throw new UnipileError(429, "errors/too_many_requests"); } });
  const held = await performInvite(limited.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1", { providerId: "ACoA1" }), note: null, activeWithinDays: 90 }, now);
  assert.equal(held.events[0].event, "retry");
  assert.ok(!limited.calls.includes("invite"));

  const refused = fakeClient({ invite: async () => { throw new UnipileError(422, "errors/limit_exceeded"); } });
  const kept = await performInvite(refused.client, { kind: "invite", unipileAccountId: "acc", enrollment: ref("e1", { providerId: "ACoA1" }), note: null, activeWithinDays: 90 }, now);
  assert.equal(kept.events[0].event, "activity", "a finished check is kept when the invite fails");
});
