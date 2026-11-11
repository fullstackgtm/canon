import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import type { Access } from "../convex/lib/access.ts";
import type { ContactRow } from "../convex/lib/recordContract.ts";
import type { OutboundContact } from "../convex/lib/outbound/audience.ts";
import { previewPush, pushTo, type MemberRow, type PushPorts } from "../convex/lib/outbound/push.ts";
import { SEQUENCERS } from "../convex/lib/outbound/sequencers.ts";

const NOW = Date.parse("2026-10-20T18:00:00Z");
const members = [
  { _id: "admin", orgId: "org", role: "admin", name: "Ada", email: "ada@canon.test", isActive: true },
  { _id: "rep", orgId: "org", role: "rep", name: "Ria", email: "ria@canon.test", isActive: true },
  { _id: "manager", orgId: "org", role: "manager", name: "Bo", email: "bo@canon.test", isActive: true },
  { _id: "other", orgId: "elsewhere", role: "admin", name: "Other", email: "other@canon.test", isActive: true },
];
let user: typeof members[number] | null = null;
let agentClient: string | null = null;
let recordClient = createFakeRecordClient({ store: createMemoryRecordStore() });
const loaded = loadConvex(["suppressions.ts", "dialer.ts", "emailAccounts.ts", "emailActions.ts", "linkedinWorker.ts", "outbound.ts", "outboundDispatch.ts", "modules.ts", "records.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => user, requireUser: async () => { if (!user) throw new Error("Not authenticated"); return user; }, agentClientOf: async () => agentClient }),
  "records.ts": (real) => ({ ...real, clientFor: () => recordClient, callerClient: (_ctx: unknown, caller: { access: Access }) => scopedRecordClient(recordClient, [caller.access], async () => null) }),
  "linkedinActions.ts": (real) => ({ ...real, convexSiteUrl: () => "http://127.0.0.1:1" }),
  "lib/providers/linkedin.ts": (real) => ({ ...real, unipileEnv: () => null, linkedinClient: () => ({ client: null, reason: "LinkedIn is off in tests." }) }),
  "objects.ts": (real) => ({ ...real, saveAsCaller: async () => ({ status: "unchanged" }) }),
  "lib/outbound/adapters.ts": (real) => ({ ...real, providerReady: () => true }),
  // Compute and activity logging are stand-ins. Public authorization, planning, scoped reads and suppression decisions are real.
  "lib/recipeRuntime.ts": (real) => ({ ...real, runModuleCall: async (_ctx: unknown, _bundle: unknown, input: { reads: unknown }) => ({ ok: true, value: { value: input.reads } }) }),
}, { Date: class extends Date { static now() { return NOW; } } });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function harness(tables: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = memoryDb({ organizations: [{ _id: "org", defaultCurrency: "USD" }, { _id: "elsewhere", defaultCurrency: "USD" }], users: members, ...tables });
  user = members[0];
  agentClient = null;
  const scheduler = { runAfter: async () => {} };
  const ctx = () => ({ db, scheduler, auth: { getUserIdentity: async () => null } });
  const readonly = new Proxy(db, { get: (target, key) => ["insert", "patch", "replace", "delete"].includes(String(key)) ? undefined : Reflect.get(target, key) });
  const queryCtx = () => ({ ...ctx(), db: readonly });
  const invoke = (ref: unknown, args: unknown, query = false): Promise<any> => {
    const parts = String(ref).split(".");
    const name = parts.pop()!;
    const file = `${parts.pop()}.ts`;
    return loaded[file][name].handler(query ? queryCtx() : ctx(), args);
  };
  const action = { scheduler, runQuery: (ref: unknown, args: unknown) => invoke(ref, args, true), runMutation: (ref: unknown, args: unknown) => invoke(ref, args) };
  const call = (file: string, name: string, args: Record<string, unknown> = {}) => loaded[`${file}.ts`][name].handler(
    file === "emailActions" || file === "modules" && ["records", "call"].includes(name) ? action : ctx(), args,
  );
  const add = (kind: string, value: string, source = "manual") => call("suppressions", "add", { kind, value, source, reason: "Private admin note" });
  const check = (identifiers: Record<string, string>, purpose = "manual_action", orgId = "org") => call("suppressions", "checkIdentifiers", { orgId, identifiers: [identifiers], purpose }).then((rows) => rows[0]);
  return { db, call, add, check, agent: () => { agentClient = "test-agent"; }, as: (id: string | null) => { user = members.find((m) => m._id === id) ?? null; agentClient = null; } };
}

test("independent causes, exact normalized keys, purpose and tenant boundaries survive add/lift", async () => {
  const h = harness();
  const manual = await h.add("email", " Sam@Example.Test ");
  const unsubscribe = await h.add("email", "sam@example.test", "unsubscribe");
  await h.add("domain", "example.test", "bounce");
  await h.add("phone", "(415) 555-0123", "dnc");
  await h.add("linkedin", "https://uk.linkedin.com/in/Sam-Rivera/?trk=x");
  assert.equal(h.db.rows("suppressions").length, 5);
  assert.equal(await h.add("email", "SAM@EXAMPLE.TEST"), manual, "same cause is idempotent");
  const verdict = await h.check({ email: "sam@example.test", phone: "+14155550123", linkedinUrl: "linkedin.com/in/sam-rivera" });
  assert.deepEqual(plain(verdict.email.reasons.map((r: { code: string }) => r.code)).sort(), ["suppression.bounce", "suppression.manual"]);
  assert.equal(verdict.voice.code, "suppression.dnc");
  assert.equal(verdict.linkedin.blocked, true);
  assert.equal((await h.check({ email: "sam@sub.example.test" })).email.blocked, false, "a domain rule is exact, not a suffix match");
  assert.doesNotMatch(JSON.stringify(verdict), /Private admin|sam@example|14155550123/);
  await h.call("suppressions", "lift", { id: manual });
  assert.equal((await h.check({ email: "sam@example.test" })).email.code, "suppression.bounce");
  const bounce = h.db.rows("suppressions").find((r) => r.source === "bounce")!;
  await h.call("suppressions", "lift", { id: bounce._id });
  assert.equal((await h.check({ email: "sam@example.test" })).email.blocked, false);
  assert.equal((await h.check({ email: "sam@example.test" }, "automated_outreach")).email.code, "suppression.unsubscribe");
  assert.equal((await h.check({ email: "sam@example.test" }, "system_notice")).email.blocked, false);
  await h.call("suppressions", "lift", { id: unsubscribe });
  assert.equal(h.db.rows("suppressionEvents").length, 8, "adds and lifts are logged; a repeated add is not a second event");
  await assert.rejects(h.add("domain", "https://example.test/path"));
  assert.equal((await h.check({ phone: "+14155550123" }, "manual_action", "elsewhere")).voice.blocked, false);
  h.as("rep");
  await assert.rejects(h.add("email", "new@example.test"));
  await assert.rejects(h.call("suppressions", "list", { paginationOpts: { cursor: null, numItems: 20 } }));
  await assert.rejects(h.call("suppressions", "lift", { id: manual }));
  h.as("manager");
  await assert.rejects(h.add("email", "new@example.test"));
  await assert.rejects(h.call("suppressions", "lift", { id: manual }));
  h.as("other");
  await assert.rejects(h.call("suppressions", "lift", { id: manual }));
  assert.equal((await h.call("suppressions", "list", { paginationOpts: { cursor: null, numItems: 20 } })).page.length, 0);
  h.as("admin");
  await h.db.insert("accessPreviews", { userId: "admin", orgId: "org", asUserId: "rep", expiresAt: NOW + 1000 });
  await assert.rejects(h.add("email", "new@example.test"));
  await assert.rejects(h.call("suppressions", "list", { paginationOpts: { cursor: null, numItems: 20 } }));
  h.as(null);
  await assert.rejects(h.add("email", "new@example.test"));
});

test("legacy DNC pages preserve provenance, never overwrite lifts, and leave the legacy table read-only", async () => {
  const legacy = Array.from({ length: 105 }, (_, i) => ({ _id: `legacy${i}`, orgId: "org", number: `+1415555${String(i).padStart(4, "0")}`, reason: "Asked on call", contactId: `contact${i}`, addedBy: "rep", addedAt: 7 }));
  const h = harness({ dialerDoNotCall: [...legacy, { ...legacy[0], _id: "foreign", orgId: "elsewhere" }] });
  const before = plain(h.db.rows("dialerDoNotCall"));
  assert.equal((await h.call("dialer", "numberStatus", { phone: legacy[0].number })).doNotCall, true);
  const first = await h.call("suppressions", "list", { paginationOpts: { cursor: null, numItems: 20 } });
  const legacyPage = await h.call("suppressions", "list", { paginationOpts: { cursor: first.continueCursor, numItems: 20 } });
  assert.equal(legacyPage.page[0].source, "dnc");
  await h.call("suppressions", "lift", { id: "legacy0" });
  await h.call("dialer", "removeDoNotCall", { id: "legacy0" });
  assert.equal((await h.call("dialer", "numberStatus", { phone: legacy[0].number })).doNotCall, false);
  let page = await h.call("suppressions", "migrateDncPage", { orgId: "org" });
  assert.deepEqual(plain(page), { complete: false, migrated: 100 });
  const list = await h.call("dialer", "doNotCallList");
  assert.deepEqual(Object.keys(list[0]).sort(), ["_id", "addedAt", "number", "reason"]);
  const canonical = h.db.rows("suppressions").find((r) => r.value === legacy[1].number)!;
  assert.deepEqual([canonical.addedBy, canonical.addedAt, canonical.contactId, canonical.reason], ["rep", 7, "contact1", "Asked on call"]);
  await h.call("dialer", "removeDoNotCall", { id: canonical._id });
  page = await h.call("suppressions", "migrateDncPage", { orgId: "org" });
  assert.deepEqual(plain(page), { complete: true, migrated: 105 });
  assert.deepEqual(plain(await h.call("suppressions", "migrateDncPage", { orgId: "org" })), plain(page));
  assert.equal(h.db.rows("suppressions").length, 105);
  assert.equal(h.db.rows("suppressions").some((r) => r.orgId === "elsewhere"), false);
  assert.equal((await h.call("dialer", "numberStatus", { phone: legacy[0].number })).doNotCall, false);
  assert.equal((await h.call("dialer", "doNotCallList")).some((r: { number: string }) => r.number === legacy[1].number), false);
  const manual = await h.add("phone", legacy[0].number);
  assert.equal((await h.call("dialer", "numberStatus", { phone: legacy[0].number })).doNotCall, true, "lifting DNC does not lift another cause");
  await assert.rejects(h.call("dialer", "removeDoNotCall", { id: manual }));
  await h.call("suppressions", "lift", { id: manual });
  h.as("manager");
  await assert.rejects(h.call("dialer", "removeDoNotCall", { id: "legacy0" }));
  h.as("rep");
  await h.call("dialer", "addDoNotCall", { number: legacy[0].number });
  await assert.rejects(h.call("dialer", "removeDoNotCall", { id: "legacy0" }));
  assert.deepEqual(plain(h.db.rows("dialerDoNotCall")), before);
});

test("a rep logging DNC keeps contact provenance in the same outcome mutation", async () => {
  const h = harness({ dialerCalls: [{ _id: "finished", orgId: "org", userId: "rep", contactId: "sam", contactName: "Sam", to: "+14155550123", state: "ended", startedAt: NOW - 1000, endedAt: NOW, activityStreamId: "fake-activity" }] });
  h.as("rep");
  await h.call("dialer", "setOutcome", { callId: "finished", outcome: "connected", doNotCall: true });
  const rule = h.db.rows("suppressions")[0];
  assert.deepEqual([rule.orgId, rule.kind, rule.value, rule.source, rule.addedBy, rule.addedAt, rule.contactId], ["org", "phone", "+14155550123", "dnc", "rep", NOW, "sam"]);
  assert.equal((await h.db.get("finished"))!.confirmed, true);
  assert.equal(h.db.rows("dialerDoNotCall").length, 0);
  assert.equal((await h.call("dialer", "numberStatus", { phone: "+14155550123" })).doNotCall, true);
});

test("actual Gmail, Dialer and outbox claim transactions refuse current canonical rules", async () => {
  const h = harness({
    emailAccounts: [{ _id: "mail", orgId: "org", userId: "rep", status: "ok", address: "ria@canon.test", unipileAccountId: "local-mail" }],
    dialerSessions: [{ _id: "session", orgId: "org", userId: "rep", status: "ready", numberId: "number", from: "+14155559999", agentLegId: "agent", startedAt: NOW, expiresAt: NOW + 60_000 }],
    dialerNumbers: [{ _id: "number", orgId: "org", heldBySessionId: "session" }],
    dialerProfiles: [{ _id: "profile", orgId: "org", userId: "rep", parallelLines: 2 }],
  });
  const emailRule = await h.add("domain", "blocked.test");
  await h.add("phone", "+14155550123", "bounce");
  const store = createMemoryRecordStore();
  await store.putContacts("org", [{ id: "sam", fullName: "Sam", email: "sam@blocked.test", phone: "+14155550123", status: "active", updatedAt: 1, ownerId: "rep" } as ContactRow]);
  recordClient = createFakeRecordClient({ store });
  h.as("rep");
  await assert.rejects(h.call("emailActions", "sendToContact", { accountId: "mail", contactId: "sam", subject: "Hello", body: "Fake body" }));
  assert.equal(h.db.rows("emailSends").length, 0);
  assert.equal((await h.call("dialer", "numberStatus", { phone: "+14155550123" })).doNotCall, true);
  await assert.rejects(h.call("dialer", "claimCall", { orgId: "org", userId: "rep", contactId: "sam", contactName: "Sam", to: "+14155550123" }));
  const race = await h.call("dialer", "claimRace", { orgId: "org", userId: "rep", entries: [
    { contactId: "different-contact-same-phone", contactName: "Sam", to: "+14155550123" },
    { contactId: "healthy", contactName: "Healthy", to: "+14155550124" },
  ] });
  assert.equal(race.calls.length, 1);
  assert.deepEqual(plain(h.db.rows("dialerCalls").map((r) => r.contactId)), ["healthy"]);
  const queue = (cause: string) => h.call("outbound", "sendWorkspaceEmail", { orgId: "org", to: { address: "sam@blocked.test" }, subject: "Notice", body: "Fake body", cause });
  await queue("blocked-at-queue");
  assert.equal(h.db.rows("outboundMessages")[0].state, "suppressed");
  h.as("admin");
  await h.call("suppressions", "lift", { id: emailRule });
  await h.add("email", "sam@blocked.test", "unsubscribe");
  await queue("notice-is-not-outreach");
  assert.equal(h.db.rows("outboundMessages")[1].state, "queued");
  await h.add("email", "sam@blocked.test", "bounce");
  const jobs = await h.call("outboundDispatch", "claim");
  assert.equal(jobs.length, 0);
  assert.equal(h.db.rows("outboundMessages")[1].state, "suppressed", "a rule added after queueing is checked at claim");
});

test("module calls retain campaign caps and attribution while leaving legacy queue items untouched", async () => {
  const h = harness({
    audiences: [{ _id: "audience", orgId: "org", name: "Campaign" }],
    dialerSessions: [{ _id: "session", orgId: "org", userId: "rep", status: "ready", numberId: "number", from: "+14155559999", agentLegId: "agent", startedAt: NOW, expiresAt: NOW + 60_000 }],
    dialerNumbers: [{ _id: "number", orgId: "org", heldBySessionId: "session" }],
    dialerProfiles: [{ _id: "profile", orgId: "org", userId: "rep", parallelLines: 3 }],
    dialerCalls: Array.from({ length: 20 }, (_, i) => ({ _id: `old${i}`, orgId: "org", userId: "admin", audienceId: "audience", contactId: `old-person${i}`, state: "ended", startedAt: NOW - 1000, answeredAt: NOW - 500, abandoned: i === 0 })),
    dialerQueueItems: [{ _id: "legacy", sessionId: "session", contactId: "sam", status: "pending" }],
  });
  h.as("rep");
  const before = plain(h.db.rows("dialerQueueItems"));
  const campaign = { audienceId: "audience", name: "Cached campaign title" };
  const candidates = [{ contactId: "sam", phone: "+442079460013" }, { contactId: "bo", phone: "+442079460014" }];
  const pick = await h.call("dialer", "nextOfList", { campaign, candidates });
  assert.deepEqual(plain(pick), { lines: 1, contactIds: ["sam"], held: 0 });
  assert.equal((await h.db.get("session"))!.queueAudienceId, undefined, "preview does not mutate the session");
  const claim = await h.call("dialer", "claimCall", { orgId: "org", userId: "rep", contactId: "sam", contactName: "Sam", to: "+442079460013", campaign });
  assert.equal((await h.db.get(claim.callId))!.audienceId, "audience");
  assert.deepEqual(plain((await h.call("dialer", "profile")).campaign), { name: "Campaign", calls: 1, reached: 20 });
  await h.call("dialer", "dialFailed", { sessionId: "session", callId: claim.callId, error: "Simulated failure" });
  const tasks = await h.call("dialer", "nextOfList", { candidates: [candidates[1], { contactId: "cy", phone: "+442079460015" }], since: NOW + 1 });
  assert.deepEqual(plain(tasks), { lines: 3, contactIds: ["bo", "cy"], held: 0 }, "non-audience preview ignores the previous audience cap");
  const race = await h.call("dialer", "claimRace", { orgId: "org", userId: "rep", entries: [{ contactId: "bo", contactName: "Bo", to: "+442079460014" }] });
  assert.equal((await h.db.get(race.calls[0].callId))!.audienceId, undefined);
  await h.call("dialer", "hangupCall");
  assert.equal((await h.db.get(race.calls[0].callId))!.state, "failed");
  const session = (await h.db.get("session"))!;
  assert.deepEqual([session.queueAudienceId, session.queueName, session.race ?? null], [undefined, undefined, null]);
  const back = await h.call("dialer", "nextOfList", { campaign, candidates, since: NOW + 1 });
  assert.deepEqual(plain(back), { lines: 1, contactIds: ["sam"], held: 0 });
  const audienceRace = await h.call("dialer", "claimRace", { orgId: "org", userId: "rep", campaign, since: NOW + 1, entries: [{ contactId: "sam", contactName: "Sam", to: "+442079460013" }] });
  assert.equal((await h.db.get(audienceRace.calls[0].callId))!.audienceId, "audience");
  assert.equal((await h.db.get("session"))!.queueAudienceId, "audience");
  assert.deepEqual(plain(h.db.rows("dialerQueueItems")), before);
  assert.ok(h.db.rows("dialerCalls").every((c) => c.queueItemId === undefined));
});

test("final dial claims reject invalid campaigns and stale parallel limits before any call or campaign change", async () => {
  const h = harness({
    audiences: [{ _id: "ours", orgId: "org", name: "Ours", shared: false, createdBy: "rep" }, { _id: "foreign", orgId: "elsewhere", name: "Foreign" }, { _id: "private", orgId: "org", name: "Private", shared: false, createdBy: "admin" }],
    dialerSessions: [{ _id: "session", orgId: "org", userId: "rep", status: "ready", numberId: "number", from: "+14155559999", agentLegId: "agent", startedAt: NOW, expiresAt: NOW + 60_000, queueAudienceId: "ours", queueName: "Ours" }],
    dialerNumbers: [{ _id: "number", orgId: "org", heldBySessionId: "session" }],
    dialerProfiles: [{ _id: "profile", orgId: "org", userId: "rep", parallelLines: 3 }],
  });
  h.as("rep");
  const ids = { userId: "rep", orgId: "org" };
  const entries = [{ contactId: "a", contactName: "Ada", to: "+442079460013" }, { contactId: "b", contactName: "Bo", to: "+442079460014" }];
  const candidates = entries.map((e) => ({ contactId: e.contactId, phone: e.to }));
  for (const audienceId of ["missing", "foreign", "private"]) {
    const campaign = { audienceId, name: "Not trusted" };
    await assert.rejects(h.call("dialer", "nextOfList", { candidates, campaign }));
    await assert.rejects(h.call("dialer", "claimCall", { ...ids, ...entries[0], campaign }));
    await assert.rejects(h.call("dialer", "claimRace", { ...ids, entries, campaign }));
  }
  assert.equal(h.db.rows("dialerCalls").length, 0);
  assert.deepEqual([(await h.db.get("session"))!.queueAudienceId, (await h.db.get("session"))!.queueName], ["ours", "Ours"]);
  assert.equal((await h.call("dialer", "nextOfList", { candidates })).contactIds.length, 2);
  await h.db.patch("profile", { parallelLines: 1 });
  await assert.rejects(h.call("dialer", "claimRace", { ...ids, entries }));
  await h.db.patch("profile", { parallelLines: 3 });
  const campaign = { audienceId: "ours", name: "Ours" };
  assert.equal((await h.call("dialer", "nextOfList", { candidates, campaign })).contactIds.length, 2);
  const history = Array.from({ length: 20 }, (_, i) => ({ orgId: "org", userId: "admin", audienceId: "ours", contactId: `old${i}`, state: "ended", startedAt: NOW - 1000, answeredAt: NOW - 500, abandoned: i === 0 }));
  for (const call of history) await h.db.insert("dialerCalls", call);
  await assert.rejects(h.call("dialer", "claimRace", { ...ids, entries, campaign }));
  for (const row of h.db.rows("dialerCalls")) await h.db.patch(row._id, { userId: "rep" });
  await assert.rejects(h.call("dialer", "claimRace", { ...ids, entries }));
  assert.equal(h.db.rows("dialerCalls").length, 20);
  assert.equal((await h.db.get("session"))!.queueAudienceId, "ours");
  const single = await h.call("dialer", "claimCall", { ...ids, ...entries[0] });
  assert.equal((await h.db.get(single.callId))!.audienceId, undefined, "a paused parallel cap still permits one non-audience call");
  assert.equal((await h.db.get("session"))!.queueAudienceId, undefined);
  await h.call("dialer", "dialFailed", { sessionId: "session", callId: single.callId, error: "Simulated failure" });
  await h.db.insert("orgRoles", { orgId: "org", key: "campaign-manager", capabilities: ["audiences.manageAll"] });
  await h.db.patch("rep", { role: "campaign-manager" });
  const allowed = await h.call("dialer", "claimCall", { ...ids, ...entries[0], campaign: { audienceId: "private", name: "Cached" } });
  assert.equal((await h.db.get(allowed.callId))!.audienceId, "private");
});

test("Gmail and voice derive agent purpose on the server; a preview cannot weaken the actual send", async () => {
  const h = harness({ emailAccounts: [{ _id: "mail", orgId: "org", userId: "rep", status: "ok", address: "ria@canon.test", unipileAccountId: "local-mail" }] });
  await h.add("email", "sam@example.test", "reply");
  await h.add("phone", "+14155550123", "unsubscribe");
  h.as("rep");
  const claim = { orgId: "org", userId: "rep", accountId: "mail", contactId: "sam", to: "sam@example.test", subject: "Hello" };
  await h.call("emailAccounts", "claimSend", claim);
  assert.equal((await h.call("dialer", "numberStatus", { phone: "+14155550123" })).doNotCall, false);
  h.agent();
  assert.equal((await h.check({ email: "sam@example.test" }, "manual_action")).email.blocked, false, "preview is not send authority");
  await assert.rejects(h.call("emailAccounts", "claimSend", claim));
  assert.equal((await h.call("dialer", "numberStatus", { phone: "+14155550123" })).doNotCall, true);
  assert.equal(h.db.rows("emailSends").length, 1);
});

test("LinkedIn claim stops suppressed work and still selects the next healthy invitation or message", async () => {
  for (const state of ["queued", "connected"]) {
    const h = harness({
      linkedinAccounts: [{ _id: "linkedin", orgId: "org", status: "ok", timezone: "UTC", window: { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }, tier: "premium", rampStep: 5, nextInviteAt: NOW, unipileAccountId: "fake-linkedin" }],
      linkedinCadences: [{ _id: "cadence", orgId: "org", status: "active", steps: [{ kind: "invite", note: "Hi" }, { kind: "message", body: "Hello", delayDays: 1 }] }],
      linkedinEnrollments: ["blocked", "healthy"].map((id) => ({ _id: id, orgId: "org", cadenceId: "cadence", senderAccountId: "linkedin", contactId: id, linkedinUrl: `https://linkedin.com/in/${id}`, publicIdentifier: id, vars: {}, state, stepIndex: state === "connected" ? 1 : 0, nextAt: NOW, enrolledAt: NOW })),
    });
    await h.add("linkedin", "https://www.linkedin.com/in/blocked/", "reply");
    const job = await h.call("linkedinWorker", "claim", { accountId: "linkedin" });
    assert.equal(job.enrollment.id, "healthy");
    assert.equal(job.kind, state === "queued" ? "invite" : "message");
    assert.equal((await h.db.get("blocked"))!.state, "stopped");
    assert.equal(h.db.rows("linkedinSends").length, 0, "refusal consumes no provider budget");
  }
});

test("push previews and every provider batch use current suppression, including EmailBison attachment", async () => {
  for (const provider of ["instantly", "smartlead", "emailbison"] as const) {
    const h = harness();
    const size = SEQUENCERS[provider].batchSize;
    const contacts: OutboundContact[] = Array.from({ length: size + 1 }, (_, i) => ({ id: `p${i}`, fullName: `Pat ${i}`, email: `p${i}@example.test`, company: "Example", title: null, phone: null, linkedinUrl: null, custom: {} }));
    const rows: MemberRow[] = [];
    const ports: PushPorts = {
      sentEmails: async () => new Set(), record: async (_target, added) => { rows.push(...added); },
      suppressed: async (batch) => {
        const blocked = new Map<string, string>();
        for (const c of batch) { const result = await h.check({ email: c.email! }, "automated_outreach"); if (result.email.blocked) blocked.set(c.id, result.email.text); }
        return blocked;
      },
    };
    await h.add("email", "p0@example.test", "unsubscribe");
    const preview = await previewPush(provider, contacts, "7", ports);
    assert.equal(preview.toSend, size);
    assert.equal(preview.skippedSuppressed, 1);
    const transmitted: string[] = [];
    const attached: number[] = [];
    const fetchImpl = (async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.lead_ids) { attached.push(...body.lead_ids); return Response.json({}); }
      const leads = body.leads ?? body.lead_list;
      transmitted.push(...leads.map((l: { email: string }) => l.email));
      // A rule appears after the first request, before the next batch or EmailBison attachment.
      await h.add("email", `p${size}@example.test`);
      if (provider === "emailbison") {
        await h.add("email", "p1@example.test");
        return Response.json({ data: leads.map((l: { email: string }, i: number) => ({ id: i + 1, email: l.email })) });
      }
      return Response.json(provider === "instantly" ? { leads_uploaded: leads.length, created_leads: leads } : { added_count: leads.length });
    }) as typeof fetch;
    const client = SEQUENCERS[provider].create({ apiKey: "fake-key", instanceUrl: "https://fake.example.test", fetchImpl });
    const result = await pushTo({ provider, contacts, campaignId: "7", client, ports });
    assert.equal(transmitted.includes("p0@example.test"), false);
    assert.equal(transmitted.includes(`p${size}@example.test`), false, "the later batch rechecks");
    assert.equal(result.skippedSuppressed, provider === "emailbison" ? 3 : 2);
    assert.equal(result.sent, size + 1 - result.skippedSuppressed);
    assert.ok(rows.find((r) => r.contactId === `p${size}` && r.outcome === "skipped" && r.reason));
    if (provider === "emailbison") assert.equal(attached.includes(1), false, "a newly suppressed lead isn't attached");
  }
});

async function moduleHarness() {
  const manifest = JSON.parse(readFileSync("tests/fixtures/modules/visit-log/module.json", "utf8"));
  manifest.reads = { people: ["name", "title", "suppression"] };
  manifest.calls = { check: { label: "Check", roles: ["rep", "admin"], agent: "allowed", writes: [], returns: "value", args: { type: "object", value: { ids: { fieldType: { type: "array", value: { type: "string" } }, optional: false } } }, reads: { status: { canon: "suppression.check", args: { ids: { arg: "ids" } } } } } };
  const h = harness({
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: manifest.id, slug: "visit-log", manifest: JSON.stringify(manifest), manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), bundleHash: "fake", bundleStorageId: "fake-storage", installedBy: "admin", installedAt: 1, status: "installed" }],
    recipeEnablements: [{ _id: "on", orgId: "org", point: "module", recipeId: manifest.id, contributionKey: "nav", enabled: true, at: 1 }],
    rolePermissions: [{ _id: "rules", orgId: "org", role: "rep", rules: [{ object: "contact", visibility: "own", unowned: false }] }],
  });
  const store = createMemoryRecordStore();
  await store.putContacts("org", [
    { id: "visible", fullName: "Visible Person", title: "CRO", email: "visible@example.test", phone: "+14155550123", linkedinUrl: "https://linkedin.com/in/visible", ownerId: "rep", status: "active", updatedAt: 1 },
    { id: "invisible", fullName: "Invisible Person", email: "invisible@example.test", ownerId: "someone-else", status: "active", updatedAt: 1 },
  ] as ContactRow[]);
  await store.putContacts("elsewhere", [{ id: "foreign", fullName: "Other org", email: "foreign@example.test", ownerId: "rep", status: "active", updatedAt: 1 } as ContactRow]);
  recordClient = createFakeRecordClient({ store });
  return h;
}

test("Canon check and people picker expose only derived statuses on visible contacts, respecting hidden identifier fields", async () => {
  const h = await moduleHarness();
  await h.add("domain", "example.test");
  await h.add("phone", "+14155550123", "dnc");
  h.as("rep");
  const args = { module: "visit-log", call: "check", args: { ids: ["visible", "invisible", "foreign", "missing"] } };
  const result = await h.call("modules", "call", args);
  const status = result.value.status;
  assert.deepEqual(plain(status.map((r: { id: string }) => r.id)), ["visible"]);
  assert.equal(status[0].email.code, "suppression.manual");
  assert.equal(status[0].voice.code, "suppression.dnc");
  assert.doesNotMatch(JSON.stringify(result), /visible@example|14155550123|Private admin/);
  let picks = await h.call("modules", "records", { module: "visit-log", to: "people", search: "Person" });
  assert.deepEqual(plain(picks), [{ id: "visible", label: "Visible Person", doNotContact: true }]);
  const granted = await h.call("modules", "records", { module: "visit-log", to: "people", ids: ["visible", "invisible"] });
  assert.deepEqual(Object.keys(granted[0]).sort(), ["createdAt", "id", "label", "name", "suppression", "title"]);
  await h.db.patch("rules", { rules: [{ object: "contact", visibility: "own", unowned: false, fields: [{ apiName: "email", level: "hidden" }, { apiName: "phone", level: "hidden" }, { apiName: "linkedinUrl", level: "hidden" }] }] });
  const hidden = (await h.call("modules", "call", args)).value.status;
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].email.blocked, false);
  assert.equal(hidden[0].voice.blocked, false);
  picks = await h.call("modules", "records", { module: "visit-log", to: "people", search: "Person" });
  assert.deepEqual(plain(picks), [], "search excludes hits whose identifiers the caller cannot read");
  picks = await h.call("modules", "records", { module: "visit-log", to: "people", search: "" });
  assert.deepEqual(plain(picks), [{ id: "visible", label: "Visible Person", doNotContact: false }], "hidden identifiers cannot reveal matching rules");
  const pkg = (await h.db.get("pkg"))!;
  const manifest = JSON.parse(String(pkg.manifest));
  manifest.reads.people = ["name", "title"];
  await h.db.patch("pkg", { manifest: JSON.stringify(manifest), manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
  await assert.rejects(h.call("modules", "call", args), /suppression/);
});
