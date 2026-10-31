import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingPolicy, policyOf } from "../convex/lib/recordingPolicy.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const ADMIN = { _id: "users:admin", orgId: "organizations:acme", role: "admin", name: "Ada", email: "ada@acme.com", isActive: true };
let role = "admin";
let agent: string | null = null;
const modules = loadConvex(["lib/recordingPolicy.ts", "recordingPolicy.ts", "dialer.ts", "lib/modules/canonReads.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => ({ ...ADMIN, role }), requireUser: async () => ({ ...ADMIN, role }), agentClientOf: async () => agent }),
});
const policy = modules["lib/recordingPolicy.ts"] as unknown as { policyOf: typeof policyOf };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("policyOf resolves workspace defaults and EU explicit consent", () => {
  assert.deepEqual(plain(policy.policyOf(null, { name: "Acme", domain: "ACME.com" })), {
    consent: "notice",
    noticeText: "This meeting is being recorded by Canon for the host's workspace. Tell the host if you do not consent to recording.",
    internalRecording: false, internalDomains: ["acme.com"], neverRecordDomains: [], neverRecordEmails: [], retentionDays: 365, region: "us", callRecording: true,
  });
  assert.deepEqual(plain(policy.policyOf({ region: "eu" }, null)), {
    consent: "explicit",
    noticeText: "This meeting is being recorded by Canon for the host's workspace. Tell the host if you do not consent to recording.",
    internalRecording: false, internalDomains: [], neverRecordDomains: [], neverRecordEmails: [], retentionDays: 365, region: "eu", callRecording: true,
  });
  assert.equal(policy.policyOf(null, { region: "eu" }).consent, "explicit");
  assert.deepEqual(plain(policy.policyOf(null, { domain: " " }).internalDomains), []);
});

test("dialer handlers prefer the policy, fall back to dialer settings, and preserve audited admin changes through migration", async () => {
  role = "admin";
  const db = memoryDb({ organizations: [{ _id: ADMIN.orgId, name: "Acme" }], users: [ADMIN] });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const numberId = await db.insert("dialerNumbers", { orgId: ADMIN.orgId, number: "+442079460958", heldBySessionId: "dialerSessions:active" });
  const sessionId = await db.insert("dialerSessions", {
    _id: "dialerSessions:active", orgId: ADMIN.orgId, userId: ADMIN._id, numberId,
    status: "ready", agentLegId: "agent-leg", expiresAt: Date.now() + 3_600_000, startedAt: 1,
  });
  const dialer = modules["dialer.ts"];
  const settings = modules["recordingPolicy.ts"];
  assert.equal((await dialer.overview.handler(ctx, {})).record, true);
  const legacyId = await db.insert("dialerSettings", { orgId: ADMIN.orgId, record: false, updatedBy: ADMIN._id, updatedAt: 100 });
  assert.equal((await dialer.overview.handler(ctx, {})).record, false);
  const legacyCall = await dialer.claimCall.handler(ctx, { userId: ADMIN._id, orgId: ADMIN.orgId, contactId: "contact:one", contactName: "Jo", to: "+442079460958" });
  assert.equal((await db.get(legacyCall.callId))?.record, false);
  await db.patch(sessionId, { currentCallId: undefined });
  const values: RecordingPolicy = {
    consent: "explicit", noticeText: "Acme records this meeting. Please confirm consent.", internalRecording: true,
    internalDomains: ["ACME.com"], neverRecordDomains: ["lawfirm.com"], neverRecordEmails: ["Counsel@Lawfirm.com"],
    retentionDays: 90, region: "eu", callRecording: true,
  };
  agent = "fixture-agent";
  for (const [handler, args] of [[settings.save, values], [dialer.saveSettings, { record: true }]] as const) {
    await assert.rejects(handler.handler(ctx, args));
  }
  agent = null;
  await settings.save.handler(ctx, values);
  assert.deepEqual(plain(await settings.get.handler(ctx, {})), { ...values, internalDomains: ["acme.com"], neverRecordEmails: ["counsel@lawfirm.com"] });
  assert.equal((await db.get(legacyId))?.record, true);
  await db.patch(legacyId, { record: false });
  assert.equal((await dialer.overview.handler(ctx, {})).record, true);
  const policyCall = await dialer.claimCall.handler(ctx, { userId: ADMIN._id, orgId: ADMIN.orgId, contactId: "contact:two", contactName: "Ana", to: "+442079460958" });
  assert.equal((await db.get(policyCall.callId))?.record, true);
  await dialer.saveSettings.handler(ctx, { record: false });
  assert.equal((await settings.get.handler(ctx, {})).callRecording, false);
  assert.equal(db.rows("operationAuditLog").length, 2);

  const reads = modules["lib/modules/canonReads.ts"] as unknown as { canonRead: (...args: unknown[]) => Promise<unknown> };
  assert.deepEqual(plain(await reads.canonRead(ctx, ADMIN.orgId, {}, { reads: { recording: ["consent", "internalRecording", "internalDomains", "retentionDays", "region", "neverRecordEmails", "neverRecordDomains"] } }, "recording.policy", {}, 1)), [
    { id: "organizations:acme", createdAt: 0, consent: "explicit", internalRecording: true, internalDomains: ["acme.com"], retentionDays: 90, region: "eu" },
  ]);

  for (const invalid of [{ noticeText: " " }, { retentionDays: 6 }, { retentionDays: 3651 }, { retentionDays: 7.5 }, { neverRecordDomains: ["https://lawfirm.com"] }, { neverRecordEmails: ["not-an-email"] }]) {
    await assert.rejects(settings.save.handler(ctx, { ...values, ...invalid }));
  }
  role = "manager";
  assert.equal(await settings.get.handler(ctx, {}), null);
  await assert.rejects(settings.save.handler(ctx, values), /Your role can't do this/);
  await assert.rejects(dialer.saveSettings.handler(ctx, { record: true }), /Your role can't do this/);
  role = "admin";
  await db.insert("organizations", { _id: "organizations:other", name: "Other" });
  await db.insert("dialerSettings", { orgId: "organizations:other", record: false, updatedBy: ADMIN._id, updatedAt: 200 });
  assert.deepEqual(plain(await settings.backfillDialerSettings.handler(ctx, {})), { created: 1, done: true });
  assert.deepEqual(plain(await settings.backfillDialerSettings.handler(ctx, {})), { created: 0, done: true });
  assert.equal(db.rows("recordingPolicy").length, 2);
  assert.equal(db.rows("recordingPolicy").find((row) => row.orgId === "organizations:other")?.callRecording, false);
  assert.equal((await settings.get.handler(ctx, {})).retentionDays, 90);
});
