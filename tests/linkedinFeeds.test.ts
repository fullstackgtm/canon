import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

let now = Date.parse("2026-10-20T16:00:00Z");
class Clock extends Date { static now() { return now; } }
const M = loadConvex(["linkedin.ts", "linkedinWorker.ts", "linkedinCadences.ts", "linkedinFeeds.ts"], {
  "lib.ts": (real) => ({
    ...real,
    requireUser: async (ctx: { db: ReturnType<typeof memoryDb> }) => ctx.db.get("users:sender"),
  }),
}, { Date: Clock });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const steps = [{ kind: "invite", note: "private-note" }, { kind: "message", body: "private-message", delayDays: 1 }, { kind: "message", body: "private-followup", delayDays: 1 }];

function setup() {
  now = Date.parse("2026-10-20T16:00:00Z");
  const db = memoryDb({
    users: [{ _id: "users:sender", orgId: "organizations:org", role: "member" }],
    linkedinAccounts: [{
      _id: "linkedinAccounts:sender", orgId: "organizations:org", userId: "users:sender",
      unipileAccountId: "private-unipile", profileName: "Ada", publicIdentifier: "private-profile",
      tier: "premium", status: "ok", timezone: "UTC", window: { days: [1, 2, 3, 4, 5], startMinute: 510, endMinute: 1080 },
      overrides: {}, rampStep: 0, rampAdvancedAt: now, riskAcceptedAt: now, riskTextVersion: "private-risk",
      connectedAt: now - 1000, updatedAt: now,
    }],
    linkedinCadences: [{
      _id: "linkedinCadences:cadence", orgId: "organizations:org", senderAccountId: "linkedinAccounts:sender",
      name: "CFO outreach", status: "active", steps, createdBy: "users:sender", createdAt: now, updatedAt: now,
    }],
  });
  const scheduled: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const ctx = { db, scheduler: { runAfter: async (_delay: number, ref: unknown, args: Record<string, unknown>) => { scheduled.push({ ref: String(ref), args }); } } };
  const call = (file: string, fn: string, args: Record<string, unknown> = {}) => M[`${file}.ts`][fn].handler(ctx, args);
  const drain = async () => {
    for (let i = 0; i < scheduled.length; i++) {
      const job = scheduled[i];
      if (job.ref.startsWith("internal.linkedinFeeds.")) await call("linkedinFeeds", job.ref.split(".").at(-1)!, job.args);
    }
    scheduled.length = 0;
  };
  const enroll = async (id = "contact-real") => {
    await call("linkedinCadences", "insertEnrollments", {
      cadenceId: "linkedinCadences:cadence", userId: "users:sender", at: now - 1000,
      candidates: [{ contactId: id, contactName: "Grace", linkedinUrl: "private-url", publicIdentifier: `private-${id}`, vars: { firstName: "private-var" } }],
    });
    return db.rows("linkedinEnrollments").at(-1)!._id;
  };
  const item = (feed: string) => plain(db.rows("feedItems").find((row) => row.feed === `linkedin.${feed}`)!);
  const finish = (events: Record<string, unknown>[], sends: Record<string, unknown>[] = []) => call("linkedinWorker", "finish", { accountId: "linkedinAccounts:sender", events, sends, effect: null });
  return { db, call, drain, enroll, item, finish };
}

test("real enrollment and worker changes publish one redacted legacy person with separate acceptance evidence", async () => {
  const s = setup();
  const id = await s.enroll();
  await s.finish([{ event: "invited", id, providerId: "private-provider", invitationId: "private-invitation" }], [{ kind: "invite", ok: true, enrollmentId: id }]);
  assert.equal(s.item("senders").data.pendingInvites, 1);
  assert.equal(s.item("senders").data.usage.invitesToday, 1);
  now += 60_000;
  await s.finish([{ event: "connected", id, accepted: true }]);
  assert.deepEqual([s.item("touches").data.connectedAt, s.item("touches").data.acceptedAt], [now, null]);
  await s.finish([{ event: "sent", id, chatId: "private-chat" }], [{ kind: "message", ok: true, enrollmentId: id }]);
  assert.equal(await s.call("linkedinWorker", "inboundReply", { unipileAccountId: "private-unipile", senderProviderId: "private-provider", chatId: "private-chat", messageId: "private-reply", at: now - 100 }), true);
  assert.deepEqual(s.item("touches").data, {
    source: "legacy_cadence", contact: { id: "contact-real", name: "Grace" }, sender: "linkedinAccounts:sender",
    requester: { kind: "legacy_cadence", key: "linkedinCadences:cadence", label: "CFO outreach", status: "active" },
    state: "replied", stepIndex: 2, nextAt: now + 86_400_000, reason: null, enrolledAt: Date.parse("2026-10-20T15:59:59Z"),
    invitedAt: Date.parse("2026-10-20T16:00:00Z"), connectedAt: now, acceptedAt: null, lastSentAt: now, repliedAt: null,
  });
  assert.equal(s.item("touches").itemId, `legacy:${id}`);
  assert.equal(s.db.rows("feedItems").filter((row) => row.feed === "linkedin.touches").length, 1);
  assert.doesNotMatch(JSON.stringify([s.db.rows("feedItems"), s.db.rows("feedLog")]), /private-/);
  assert.deepEqual(plain(s.db.rows("connectorLinks").map((row) => [row.connector, row.userId, row.orgId])), [["linkedin", "users:sender", "organizations:org"]]);
});

test("stop, rename, pause and archive update existing projections including inactive historical rows", async () => {
  const s = setup();
  const id = await s.enroll();
  const invitedAt = now;
  await s.finish([{ event: "invited", id, providerId: "private-provider" }]);
  now += 60_000;
  await s.finish([{ event: "connected", id, accepted: true, acceptedAt: invitedAt + 1000 }]);
  await s.call("linkedinCadences", "stopEnrollment", { enrollmentId: id });
  await s.finish([{ event: "sent", id, chatId: "private-late-chat" }], [{ kind: "message", ok: true, enrollmentId: id }]);
  assert.deepEqual([s.item("touches").data.state, s.item("touches").data.acceptedAt], ["stopped", invitedAt + 1000]);
  await s.call("linkedinCadences", "update", { cadenceId: "linkedinCadences:cadence", name: "Renamed", steps });
  await s.call("linkedinCadences", "setStatus", { cadenceId: "linkedinCadences:cadence", status: "paused" });
  await s.drain();
  assert.deepEqual(s.item("touches").data.requester, { kind: "legacy_cadence", key: "linkedinCadences:cadence", label: "Renamed", status: "paused" });
  const second = await s.enroll("another-contact");
  await s.call("linkedinCadences", "setStatus", { cadenceId: "linkedinCadences:cadence", status: "archived" });
  await s.call("linkedinCadences", "stopAll", { cadenceId: "linkedinCadences:cadence", reason: "Cadence archived" });
  await s.drain();
  const touches = plain(s.db.rows("feedItems").filter((row) => row.feed === "linkedin.touches"));
  assert.deepEqual(touches.map((row: { data: { state: string; requester: { status: string } } }) => [row.data.state, row.data.requester.status]), [["stopped", "archived"], ["stopped", "archived"]]);
  assert.equal(touches[1].itemId, `legacy:${second}`);
});

test("account changes and paginated refresh keep disconnected senders and expired usage accurate without duplicate logs", async () => {
  const s = setup();
  const id = await s.enroll();
  await s.finish([{ event: "invited", id, providerId: "private-provider" }], [{ kind: "invite", ok: true, enrollmentId: id }]);
  await s.call("linkedin", "applyStatus", { unipileAccountId: "private-unipile", message: "CREDENTIALS" });
  assert.equal(s.item("senders").data.status, "credentials");
  await s.call("linkedin", "connected", {
    userId: "users:sender", orgId: "organizations:org", riskAcceptedAt: now, riskTextVersion: "private-risk",
    timezone: "UTC", unipileAccountId: "private-unipile", status: "OK", profileName: "Ada reconnected", publicIdentifier: "private-profile", tier: "premium",
  });
  assert.deepEqual([s.item("senders").data.status, s.item("senders").data.profileName], ["ok", "Ada reconnected"]);
  await s.call("linkedin", "updateSettings", {
    accountId: "linkedinAccounts:sender", timezone: "UTC", window: { days: [1, 2], startMinute: 600, endMinute: 1000 },
    overrides: { invitesPerDay: 0 }, salesNavHighVolume: false,
  });
  assert.deepEqual([s.item("senders").data.window.days, s.item("senders").data.limits.invitesPerDay], [[1, 2], 0]);
  await s.call("linkedinWorker", "finish", { accountId: "linkedinAccounts:sender", events: [], sends: [], effect: { holdMs: 60_000, reason: "Wait for LinkedIn" } });
  assert.deepEqual(s.item("senders").data.hold, { until: now + 60_000, reason: "Wait for LinkedIn" });
  await s.call("linkedin", "disconnect", { accountId: "linkedinAccounts:sender" });
  assert.equal(s.item("senders").data.status, "disconnected");
  const original = (await s.db.get("linkedinAccounts:sender"))!;
  await s.db.insert("linkedinAccounts", { ...original, _id: "linkedinAccounts:another", userId: "users:another", profileName: "Another sender" });
  now += 8 * 86_400_000;
  await s.call("linkedinFeeds", "refreshSenders");
  await s.drain();
  assert.deepEqual(s.item("senders").data.usage, { invitesToday: 0, invitesWeek: 0, messagesToday: 0, lookupsToday: 0 });
  assert.equal(s.item("senders").data.hold, null);
  assert.equal(s.db.rows("feedItems").filter((row) => row.feed === "linkedin.senders").length, 2);
  const count = s.db.rows("feedLog").length;
  await s.call("linkedinFeeds", "refreshSenders");
  await s.drain();
  assert.equal(s.db.rows("feedLog").length, count);
});

test("suppression during claim publishes the stopped enrollment and its reason", async () => {
  const s = setup();
  const id = await s.enroll();
  const linkedinUrl = "https://www.linkedin.com/in/grace";
  await s.db.patch(id, { state: "connected", stepIndex: 1, nextAt: now, linkedinUrl });
  await s.db.insert("suppressions", {
    orgId: "organizations:org", kind: "linkedin", value: linkedinUrl,
    source: "manual", state: "active", addedBy: "users:sender", addedAt: now, updatedAt: now,
  });
  assert.equal(await s.call("linkedinWorker", "claim", { accountId: "linkedinAccounts:sender" }), null);
  const stopped = (await s.db.get(id))!;
  assert.equal(stopped.state, "stopped");
  assert.equal(typeof stopped.reason, "string");
  assert.deepEqual([s.item("touches").data.state, s.item("touches").data.reason], ["stopped", stopped.reason]);
});

test("first sender publication backfills existing enrollments and converges with live hooks", async () => {
  const s = setup();
  for (let i = 0; i < 51; i++) await s.enroll(`person-${i}`);
  await s.drain();
  for (const row of s.db.rows("feedItems")) await s.db.delete(row._id);
  await s.call("linkedinFeeds", "refreshSenders");
  await s.drain();
  assert.equal(s.db.rows("feedItems").filter((row) => row.feed === "linkedin.touches").length, 51);
  const count = s.db.rows("feedLog").length;
  await s.call("linkedinFeeds", "backfillSender", { accountId: "linkedinAccounts:sender" });
  await s.drain();
  assert.equal(s.db.rows("feedLog").length, count);
});
