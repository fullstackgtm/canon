import assert from "node:assert/strict";
import test from "node:test";
import {
  abTest, addScheduleDays, arm, funnel, MANUAL_STEPS, onOutcome, placeDay, plan, skipReasons,
  type Candidate, type Due, type Outcome, type OutcomeKind, type Room, type Schedule, type Step, type Touch,
} from "../modules/examples/sequences/engine.ts";

// docs/module-plans/sequences.md §12, "Northwind", re-cut 2026-10-18: Avery's two linked Gmail accounts, 10 first
// emails and 10 follow-ups a day each (dailyNewPerSender), one LinkedIn account at 5 invites a day.
const TZ = "America/New_York";
const SCHEDULE: Schedule = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timeZone: TZ, holidays: [] };
const STEPS: Step[] = [
  { kind: "auto_email", delayDays: 0, variants: [{ id: "A", weight: 50, subject: "Q4 planning", body: "Hi {{firstName | default \"there\"}}, {{custom.pain}}" }, { id: "B", weight: 50, subject: "Q4 at {{company}}", body: "Hi {{firstName | default \"there\"}}, {{custom.pain}}" }] },
  { kind: "auto_email", delayDays: 3, thread: true, variants: [{ id: "A", weight: 100, body: "Following up." }] },
  { kind: "linkedin_invite", delayDays: 0 },
  { kind: "call", delayDays: 2 },
  { kind: "auto_email", delayDays: 3, variants: [{ id: "A", weight: 100, subject: "Last note", body: "Closing the loop." }] },
];
const ids = Array.from({ length: 40 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
const MON = Date.parse("2026-11-02T13:00:00Z"); // 08:00 New York

function enrollNorthwind() {
  const contacts: Candidate[] = ids.map((id) => ({ id, email: id === "c39" ? null : `${id}@northwind.test`, linkedinUrl: `https://linkedin.com/in/${id}`, fields: { firstName: id, company: "Northwind", "custom.pain": id === "c40" ? null : "pipeline" } }));
  return skipReasons(contacts, {
    suppressed: new Map([["c34", "unsubscribed"], ["c35", "hard bounce"], ["c36", "domain"]]),
    activeElsewhere: new Set(["c37", "c38"]), enrolledBefore: new Set(), addPolicy: "once",
    lastContactedAt: new Map(), contactLatencyDays: 0, steps: STEPS, now: MON,
  });
}

test("Northwind's enroll preview: 33 enrolled, 7 skipped by named reason", () => {
  const { enroll, skipped } = enrollNorthwind();
  assert.equal(enroll.length, 33);
  assert.deepEqual(skipped, [
    { id: "c34", reason: "suppressed" }, { id: "c35", reason: "suppressed" }, { id: "c36", reason: "suppressed" },
    { id: "c37", reason: "active_elsewhere" }, { id: "c38", reason: "active_elsewhere" },
    { id: "c39", reason: "no_email" }, { id: "c40", reason: "unresolved_field" },
  ]);
});

test("Northwind's two weeks: sends per day, the scripted outcomes, and the 11-13 report", () => {
  const { enroll } = enrollNorthwind();
  type E = { key: string; state: "active" | "held" | "finished"; stepIndex: number; lastDay: string | null; due: string; holdUntil?: string; finishReason?: string; sender?: string };
  const es = new Map<string, E>(enroll.map((key) => [key, { key, state: "active", stepIndex: 0, lastDay: null, due: plan({ stepIndex: 0, lastDay: null }, STEPS, SCHEDULE, MON).done ? "" : (plan({ stepIndex: 0, lastDay: null }, STEPS, SCHEDULE, MON) as { day: string }).day }]));
  const touches: Touch[] = [];
  const outcomes: Array<{ enrollment: string; kind: OutcomeKind; hard?: boolean }> = [];
  const script: Record<string, Array<[string, Outcome]>> = {
    "2026-11-02": [["c07", { kind: "bounce", hard: true, at: 0 }]],
    "2026-11-03": [["c04", { kind: "reply", at: 0 }], ["c09", { kind: "auto_reply", returnOn: "2026-11-09", at: 0 }]],
    "2026-11-04": [["c12", { kind: "unsubscribe", at: 0 }], ["c15", { kind: "meeting", at: 0 }]],
  };
  const perDay: Record<string, { email: number; first: number; linkedin: number }> = {};
  let day = "2026-11-02";
  while (day <= "2026-11-13") {
    for (const e of es.values()) if (e.state === "held" && e.holdUntil! <= day) { e.state = "active"; e.due = day; }
    const due: Due[] = [];
    for (const e of es.values()) {
      if (e.state !== "active" || e.due > day) continue;
      const step = STEPS[e.stepIndex];
      if (MANUAL_STEPS.includes(step.kind)) continue; // a task waits for the rep; none is done in the golden
      due.push({ key: e.key, channel: step.kind.startsWith("linkedin") ? "linkedin" : "email", first: e.stepIndex === 0, ...(step.thread ? { sender: e.sender } : {}), dueDay: e.due });
    }
    const rooms: Room[] = [
      { id: "avery@northwind-mail.test", channel: "email", newLeft: 10, followLeft: 10 },
      { id: "avery@northwind-hq.test", channel: "email", newLeft: 10, followLeft: 10 },
      { id: "linkedin:avery", channel: "linkedin", newLeft: 0, followLeft: 5 },
    ];
    // Email first, then LinkedIn: a step 2 sent today makes step 3 (+0) due today too.
    const counts = { email: 0, first: 0, linkedin: 0 };
    for (const channel of ["email", "linkedin"] as const) {
      const today = channel === "email" ? due.filter((d) => d.channel === "email") : [...es.values()].filter((e) => e.state === "active" && e.due <= day && STEPS[e.stepIndex]?.kind === "linkedin_invite").map((e): Due => ({ key: e.key, channel: "linkedin", dueDay: e.due }));
      for (const s of placeDay(today, rooms).sent) {
        const e = es.get(s.key)!;
        const step = STEPS[e.stepIndex];
        touches.push({ enrollment: e.key, stepIndex: e.stepIndex, kind: step.kind, variant: step.variants ? arm(e.key, e.stepIndex, step.variants)?.id : null, state: "sent" });
        if (e.stepIndex === 0) { e.sender = s.sender; counts.first++; }
        counts[channel]++;
        e.lastDay = day;
        e.stepIndex++;
        const next = plan({ stepIndex: e.stepIndex, lastDay: day }, STEPS, SCHEDULE, MON);
        if (next.done) { e.state = "finished"; e.finishReason = "completed"; } else e.due = next.day;
      }
    }
    perDay[day] = counts;
    for (const [key, o] of script[day] ?? []) {
      const e = es.get(key)!;
      outcomes.push({ enrollment: key, kind: o.kind, ...(o.hard !== undefined ? { hard: o.hard } : {}) });
      const fx = onOutcome(o, TZ);
      if (fx.transition === "finish") { e.state = "finished"; e.finishReason = fx.finishReason; }
      if (fx.transition === "hold") { e.state = "held"; e.holdUntil = fx.holdUntil; }
    }
    day = addScheduleDays(day, 1, SCHEDULE);
  }
  // Sends (§12): step 1 Mon 20 and Tue 13; step 2 Thu 15, Fri 13, Mon 1 (c09 after its hold); invites 5 a day = 29.
  assert.deepEqual(Object.fromEntries(Object.entries(perDay).map(([d, c]) => [d, [c.email, c.first, c.linkedin]])), {
    "2026-11-02": [20, 20, 0], "2026-11-03": [13, 13, 0], "2026-11-04": [0, 0, 0], "2026-11-05": [15, 0, 5], "2026-11-06": [13, 0, 5],
    "2026-11-09": [1, 0, 5], "2026-11-10": [0, 0, 5], "2026-11-11": [0, 0, 5], "2026-11-12": [0, 0, 4], "2026-11-13": [0, 0, 0],
  });
  // First emails alternate between the two accounts; each follow-up stays on its thread's.
  assert.equal(es.get("c01")!.sender, "avery@northwind-mail.test");
  assert.equal(es.get("c02")!.sender, "avery@northwind-hq.test");
  assert.deepEqual(funnel([...es.values()], touches, outcomes), {
    enrolled: 33, firstSent: 33, bounced: 1, delivered: 32, replies: 1, replyRate: 3.1, ooo: 1, unsubscribed: 1, meetings: 1, finished: 4, activeOrHeld: 29,
  });
  // Per-variant first sends come from the pinned hash: fixed once here, then checked exactly.
  const firsts = touches.filter((t) => t.stepIndex === 0);
  assert.deepEqual([firsts.filter((t) => t.variant === "A").length, firsts.filter((t) => t.variant === "B").length], [18, 15]);
});

test("an arm is stable across reruns and keeps its share when only another variant pauses", () => {
  const vs = [{ id: "A", weight: 50, body: "a" }, { id: "B", weight: 50, body: "b" }];
  const before = ids.map((c) => arm(c, 0, vs)!.id);
  assert.deepEqual(ids.map((c) => arm(c, 0, vs)!.id), before);
  // Picking A as the winner pauses B: every contact gets A, and A's contacts kept it.
  assert.ok(ids.every((c) => arm(c, 0, [vs[0], { ...vs[1], paused: true }])!.id === "A"));
  assert.equal(arm("c01", 0, vs.map((v) => ({ ...v, paused: true }))), null);
});

test("schedule days skip weekends and holidays; an OOO without a date holds 7 days; a winner needs 100 sends an arm", () => {
  const thanksgiving = { ...SCHEDULE, holidays: ["2026-11-26"] };
  assert.equal(addScheduleDays("2026-11-25", 1, thanksgiving), "2026-11-27");
  assert.equal(addScheduleDays("2026-11-06", 1, SCHEDULE), "2026-11-09");
  const late = plan({ stepIndex: 0, lastDay: null }, STEPS, SCHEDULE, Date.parse("2026-11-06T22:30:00Z")); // Fri 17:30 NY
  assert.deepEqual(late, { done: false, stepIndex: 0, day: "2026-11-09", nextAt: Date.parse("2026-11-09T13:00:00Z") });
  assert.deepEqual(onOutcome({ kind: "auto_reply", returnOn: null, at: MON }, TZ), { transition: "hold", holdUntil: "2026-11-09" });
  assert.deepEqual(onOutcome({ kind: "bounce", hard: false, at: MON }, TZ), { transition: "none" });
  assert.deepEqual(abTest({ sent: 99, replies: 9 }, { sent: 120, replies: 3 }), { z: 2.13, enough: false });
});

test("confirming before a page is checked loses no one: the page's check starts its enrollment", async () => {
  const { calls } = await import("../modules/examples/sequences/server.ts");
  const doc = (key: string, data: Record<string, unknown>, version = 1) => ({ key, owner: "u1", parentKey: null, version, createdAt: 0, data });
  const run = doc("r1", { sequence: "s1", snapshot: "r1", pages: 2, status: "enrolling" });
  const sequence = doc("s1", { status: "draft", addPolicy: "once" });
  const ctx = (page: string) => ({ args: { keys: [`r1|${page}`], run: "r1", page }, now: MON, caller: { userId: "system", role: "admin" } }) as never;
  // Page 0 confirmed before it was copied: nothing to enroll yet, and page 1 is dirtied.
  assert.deepEqual((await calls.enrollPage(ctx("0"), { run, sheet: [], sequence, existing: [] } as never)).byKey, { "r1|0": [{ op: "dirty", job: "enroll", key: "r1|1" }] });
  // Its check, on an enrolling run, dirties its enrollment.
  const sheet = doc("r1|0", { run: "r1", page: "0", ids: ["p1"], people: [{ id: "p1", name: "Pat Lee", email: "pat@x.test" }] });
  const checked = (await calls.checkPage(ctx("0"), { run, sheet: [sheet], sequence, steps: [doc("st", { position: 1, kind: "auto_email", delayDays: 0 })], existing: [] } as never)).byKey!["r1|0"];
  assert.deepEqual(checked.at(-1), { op: "dirty", job: "enroll", key: "r1|0" });
  // And the enrollment then writes the person.
  const enrolled = (await calls.enrollPage(ctx("1"), { run, sheet: [doc("r1|1", { ...sheet.data, page: "1", enroll: ["p1"] })], sequence, existing: [] } as never)).byKey!["r1|1"];
  assert.equal(enrolled.filter((i) => i.op === "put").length, 1);
});

test("a first step's delay counts from the day the person started, however often they wake", async () => {
  const { calls } = await import("../modules/examples/sequences/server.ts");
  const doc = (key: string, data: Record<string, unknown>, version = 1) => ({ key, owner: "u1", parentKey: null, version, createdAt: 0, data });
  const sequence = doc("s1", { status: "active" });
  const steps = [doc("st", { position: 1, kind: "call", delayDays: 1 })];
  const run = async (e: ReturnType<typeof doc>, now: number) =>
    (await calls.advance({ args: { keys: ["s1|p1"], sequence: "s1", contact: ["p1"] }, now, caller: { userId: "system", role: "admin" } } as never,
      { sequence, steps, schedule: null, enrollments: [e], tasks: [] } as never)).byKey!["s1|p1"];
  // Started Mon 11-02: the call is due Tue. A wake on Mon schedules Tue; a wake on Tue opens the task, due Tue.
  const mon = await run(doc("s1|p1", { sequence: "s1", contact: "p1", state: "active", stepIndex: 0 }), MON);
  const patched = mon[0] as { data: Record<string, unknown> };
  assert.deepEqual([patched.data.startDay, patched.data.nextAt], ["2026-11-02", Date.parse("2026-11-03T13:00:00Z")]);
  const tue = await run(doc("s1|p1", { sequence: "s1", contact: "p1", state: "active", stepIndex: 0, startDay: "2026-11-02" }, 2), Date.parse("2026-11-03T13:00:00Z"));
  assert.deepEqual(tue.filter((i) => i.op === "put").map((i) => (i as { data: Record<string, unknown> }).data.dueDay), ["2026-11-03"]);
});

test("adding a person who finished a sequence refuses rather than overwrite their history", async () => {
  const { calls } = await import("../modules/examples/sequences/server.ts");
  const doc = (key: string, data: Record<string, unknown>) => ({ key, owner: "u1", parentKey: null, version: 1, createdAt: 0, data });
  const reads = {
    sequence: doc("s1", { status: "active", addPolicy: "any", name: "Q4" }), steps: [doc("st", { position: 1, kind: "call", delayDays: 0 })],
    existing: [doc("s1|p1", { sequence: "s1", contact: "p1", state: "finished", finishReason: "replied" })], person: [{ id: "p1", name: "Pat Lee" }],
  };
  await assert.rejects(async () => calls.enrollOne({ args: { sequence: "s1", contact: "p1" }, now: MON, caller: { userId: "u1", role: "rep" } } as never, reads as never), /was in this sequence before/);
});
