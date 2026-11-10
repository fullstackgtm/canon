import assert from "node:assert/strict";
import { test } from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { Activity } from "../convex/lib/activities.ts";
import type { Event, SendRow } from "../convex/lib/linkedin/perform.ts";
import { eraseContactLog, logLinkedinEvent, type ContactLog, type Rendered } from "../convex/lib/signals/contactLog.ts";
import type { LoggedObservation } from "../convex/lib/signals/observations.ts";
import { recordTimeline } from "../convex/lib/timeline.ts";

const E = "enr_1" as Id<"linkedinEnrollments">;
const C = "cad_1" as Id<"linkedinCadences">;
const enrollment = { _id: E, cadenceId: C, contactId: "con_ada" };

function memoryLog() {
  const rows: Array<LoggedObservation & { id: string; contactId: string }> = [];
  const log: ContactLog = {
    has: async (contactId, key) => rows.some((r) => r.contactId === contactId && r.body.key === key),
    append: async (contactId, entry) => void rows.push({ ...entry, id: `o${rows.length + 1}`, seq: rows.length + 1, contactId }),
    unerased: async (contactId, limit) => rows.filter((r) => r.contactId === contactId && r.body.type !== "erased").slice(0, limit),
    replace: async (id, body) => void Object.assign(rows.find((r) => r.id === id)!, { body }),
  };
  return { rows, log };
}

/** One finish call: the sends and events of a run, with what claim rendered. */
async function finish(log: ContactLog, sends: SendRow[], events: Event[], rendered: Rendered | undefined, now: number) {
  for (const ev of events) await logLinkedinEvent(log, ev, enrollment, sends, rendered, now);
}

async function cadenceRun(log: ContactLog) {
  const invite: Rendered = { enrollmentId: E, cadenceId: C, step: 0, text: "Hi Ada, saw your talk." };
  const inviteRun: [SendRow[], Event[]] = [[{ kind: "lookup", ok: true, enrollmentId: E }, { kind: "invite", ok: true, enrollmentId: E }], [{ event: "invited", id: E, providerId: "p1" }]];
  await finish(log, ...inviteRun, invite, 100);
  await finish(log, ...inviteRun, invite, 101);
  await finish(log, [{ kind: "sync", ok: true }], [{ event: "connected", id: E, accepted: true }], undefined, 200);
  const message: Rendered = { enrollmentId: E, cadenceId: C, step: 1, text: "Thanks for connecting, Ada." };
  await finish(log, [{ kind: "message", ok: true, enrollmentId: E }], [{ event: "sent", id: E, chatId: "ch1" }], message, 300);
  await finish(log, [], [{ event: "replied", id: E }], undefined, 400);
  await finish(log, [], [{ event: "replied", id: E }], undefined, 401);
}

test("worker events become one observation each on the contact, and a retried event adds none", async () => {
  const { rows, log } = memoryLog();
  await cadenceRun(log);
  // A pending invite found on lookup and an already-connected contact were not this sender's doing.
  await finish(log, [{ kind: "lookup", ok: true, enrollmentId: E }], [{ event: "invited", id: E, providerId: "p1" }], { enrollmentId: E, cadenceId: C, step: 0, text: "" }, 500);
  await finish(log, [], [{ event: "connected", id: E, accepted: false }], undefined, 501);
  assert.deepEqual(rows.map(({ contactId, observedAt, body }) => ({ contactId, observedAt, body })), [
    { contactId: "con_ada", observedAt: 100, body: { type: "linkedin", key: "linkedin:enr_1:invite_sent:0", event: { kind: "invite_sent", cadenceId: "cad_1", step: 0, note: "Hi Ada, saw your talk." } } },
    { contactId: "con_ada", observedAt: 200, body: { type: "linkedin", key: "linkedin:enr_1:invite_accepted", event: { kind: "invite_accepted", cadenceId: "cad_1" } } },
    { contactId: "con_ada", observedAt: 300, body: { type: "linkedin", key: "linkedin:enr_1:message_sent:1", event: { kind: "message_sent", cadenceId: "cad_1", step: 1, body: "Thanks for connecting, Ada." } } },
    { contactId: "con_ada", observedAt: 400, body: { type: "linkedin", key: "linkedin:enr_1:reply_received", event: { kind: "reply_received", cadenceId: "cad_1" } } },
  ]);
});

test("the contact timeline merges LinkedIn events and activities newest first", async () => {
  const { rows, log } = memoryLog();
  await cadenceRun(log);
  const activities: Activity[] = [
    { kind: "call", id: "c1", at: 350, ownerId: "u1", subject: "Intro call", outcome: "connected" },
    { kind: "note", id: "n1", at: 50, ownerId: "u1", body: "Met at the conference" },
  ];
  assert.deepEqual(recordTimeline([], rows, activities), [
    { kind: "linkedin", at: 400, key: "linkedin:enr_1:reply_received", event: { kind: "reply_received", cadenceId: "cad_1" } },
    { kind: "call", id: "c1", at: 350, ownerId: "u1", subject: "Intro call", outcome: "connected" },
    { kind: "linkedin", at: 300, key: "linkedin:enr_1:message_sent:1", event: { kind: "message_sent", cadenceId: "cad_1", step: 1, body: "Thanks for connecting, Ada." } },
    { kind: "linkedin", at: 200, key: "linkedin:enr_1:invite_accepted", event: { kind: "invite_accepted", cadenceId: "cad_1" } },
    { kind: "linkedin", at: 100, key: "linkedin:enr_1:invite_sent:0", event: { kind: "invite_sent", cadenceId: "cad_1", step: 0, note: "Hi Ada, saw your talk." } },
    { kind: "note", id: "n1", at: 50, ownerId: "u1", body: "Met at the conference" },
  ]);
});

test("erasing a contact replaces every observation's body in place, keeping its key and seq, and leaves other contacts alone", async () => {
  const { rows, log } = memoryLog();
  await cadenceRun(log);
  await log.append("con_bob", { body: { type: "linkedin", key: "linkedin:enr_2:reply_received", event: { kind: "reply_received", cadenceId: C } }, observedAt: 600 });
  assert.equal(await eraseContactLog(log, "con_ada", 900, 3), 3);
  assert.equal(await eraseContactLog(log, "con_ada", 901, 3), 1);
  assert.equal(await eraseContactLog(log, "con_ada", 902, 3), 0);
  assert.deepEqual(rows.map(({ contactId, seq, body }) => ({ contactId, seq, body })), [
    { contactId: "con_ada", seq: 1, body: { type: "erased", key: "linkedin:enr_1:invite_sent:0", erasedAt: 900 } },
    { contactId: "con_ada", seq: 2, body: { type: "erased", key: "linkedin:enr_1:invite_accepted", erasedAt: 900 } },
    { contactId: "con_ada", seq: 3, body: { type: "erased", key: "linkedin:enr_1:message_sent:1", erasedAt: 900 } },
    { contactId: "con_ada", seq: 4, body: { type: "erased", key: "linkedin:enr_1:reply_received", erasedAt: 901 } },
    { contactId: "con_bob", seq: 5, body: { type: "linkedin", key: "linkedin:enr_2:reply_received", event: { kind: "reply_received", cadenceId: "cad_1" } } },
  ]);
  assert.deepEqual(recordTimeline([], rows.filter((r) => r.contactId === "con_ada"), []), []);
});
