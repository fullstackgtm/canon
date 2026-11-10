import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { teamOf } from "../convex/lib/calls/suggestions.ts";
import { intakeMailOf, mailEventOf, mailVerdict } from "../convex/lib/conversations/email.ts";
import { contactBySlug } from "../convex/lib/conversations/intake.ts";
import { readableTexts, readableThread } from "../convex/lib/conversations/store.ts";
import { conversationRows, type ConversationSummary } from "../convex/lib/conversations/view.ts";
import { linkedinMessageOf } from "../convex/lib/linkedin/inbound.ts";
import { createUnipileClient } from "../convex/lib/linkedin/unipile.ts";
import { linkedinEventOf } from "../convex/lib/signals/contactLog.ts";
import { recordTimeline } from "../convex/lib/timeline.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const M = loadConvex(["conversations.ts", "emailAccounts.ts"]);
/** The same modules with the signed-in member taken from `ctx.user`. */
const signedIn = loadConvex(["conversations.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async (ctx: { user: unknown }) => ctx.user, getCurrentUser: async (ctx: { user: unknown }) => ctx.user }) });
const { isFillJob, jobEntry, jobShownTo } = loadConvex(["lib/runs.ts"])["lib/runs.ts"] as unknown as {
  isFillJob: (job: unknown) => boolean; jobEntry: (job: unknown, now: number) => { status: string }; jobShownTo: (job: unknown, userId: string) => boolean;
};
/** Rows from the loaded modules' realm, as plain values. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("the webhook parser keeps 1:1 messages either way and drops group chats and spam", () => {
  const base = {
    event: "message_received", account_type: "LINKEDIN", account_id: "acc", chat_id: "chat", message_id: "m1", message: "Can we talk Tuesday?",
    timestamp: "2026-10-20T10:00:00Z", account_info: { user_id: "me" },
    sender: { attendee_provider_id: "them", attendee_name: "Grace", attendee_profile_url: "https://www.linkedin.com/in/grace-h" },
    attendees: [{ attendee_provider_id: "them", attendee_name: "Grace" }],
  };
  assert.deepEqual(linkedinMessageOf(base), {
    accountId: "acc", chatId: "chat", messageId: "m1", direction: "in", at: Date.parse("2026-10-20T10:00:00Z"), from: "them",
    text: "Can we talk Tuesday?", counterpart: { providerId: "them", name: "Grace", profileUrl: "https://www.linkedin.com/in/grace-h" },
  });
  const sent = linkedinMessageOf({ ...base, is_sender: true, sender: { attendee_provider_id: "me" } });
  assert.deepEqual([sent?.direction, sent?.counterpart.providerId], ["out", "them"]);
  assert.equal(linkedinMessageOf({ ...base, attendees: [...base.attendees, { attendee_provider_id: "third" }] }), null);
  assert.equal(linkedinMessageOf({ ...base, folder: ["INBOX_LINKEDIN_SPAM"] }), null);
});

function setup(ingest = true) {
  const now = Date.now();
  const db = memoryDb({
    linkedinAccounts: [
      { _id: "linkedinAccounts:a", orgId: "organizations:o", userId: "users:owner", unipileAccountId: "u-a", status: "ok", publicIdentifier: "ada-rep", ingest },
      { _id: "linkedinAccounts:b", orgId: "organizations:o", userId: "users:mate", unipileAccountId: "u-b", status: "ok", publicIdentifier: "bob-rep" },
    ],
    linkedinEnrollments: [{ _id: "linkedinEnrollments:e", orgId: "organizations:o", senderAccountId: "linkedinAccounts:a", providerId: "them", contactId: "contact-grace" }],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const call = (fn: string, args: Record<string, unknown>) => M["conversations.ts"][fn].handler(ctx, args);
  const msg = (id: string, direction = "in") => ({ messageId: id, direction, at: now - 1000, from: direction === "in" ? "them" : "me", text: `text of ${id}` });
  const store = (messages: ReturnType<typeof msg>[], extra: Record<string, unknown> = {}) =>
    call("storeLinkedin", { accountId: "linkedinAccounts:a", chatId: "chat", counterpart: { providerId: "them", name: "Grace", profileUrl: "https://linkedin.com/in/grace-h" }, messages, ...extra });
  const keys = () => db.rows("observations").map((o) => (o.body as { key: string }).key);
  return { db, ctx, call, msg, store, keys };
}

test("intake matches, stores once, logs the timeline without text, and keeps nothing for an account that did not opt in", async () => {
  const s = setup();
  assert.equal(await s.call("contactForProviderId", { accountId: "linkedinAccounts:a", providerId: "them" }), "contact-grace");
  assert.equal(contactBySlug("Grace-H", [{ id: "c1", values: { linkedinUrl: "https://www.linkedin.com/in/grace-h/" } }, { id: "c2", values: { linkedinUrl: "linkedin.com/in/grace-hopper" } }]), "c1");

  // Unmatched: stored with who they are, nothing on any timeline.
  assert.equal(await s.store([s.msg("m1")]), 1);
  assert.deepEqual(plain(s.db.rows("conversations").map((c) => [c.contactIds, (c.counterpart as { name: string }).name])), [[[], "Grace"]]);
  assert.deepEqual(s.keys(), []);

  // Matched later: earlier messages attach; a repeat is stored once; a cadence reply already logged is not logged twice.
  await s.db.insert("observations", { orgId: "organizations:o", subject: { object: "contact", contactId: "contact-grace" }, body: { type: "linkedin", key: "linkedin:reply:m3", event: { kind: "reply_received" } } });
  assert.equal(await s.store([s.msg("m1"), s.msg("m2", "out"), s.msg("m3")], { contactId: "contact-grace" }), 2);
  assert.deepEqual(s.keys().sort(), ["linkedin:msg:m1", "linkedin:msg:m2", "linkedin:reply:m3"]);
  assert.equal(s.db.rows("conversationMessages").length, 3);
  assert.doesNotMatch(JSON.stringify(s.db.rows("observations")), /text of/);
  assert.ok((s.db.rows("conversations")[0].extractDueAt as number) > Date.now() - 1000);

  // A chat with a teammate's account, and any chat on an account that did not opt in, keep nothing.
  assert.equal(await s.store([s.msg("m9")], { chatId: "team", counterpart: { providerId: "bob", profileUrl: "https://linkedin.com/in/bob-rep" } }), 0);
  const off = setup(false);
  assert.equal(await off.store([off.msg("m1")]), 0);
  assert.deepEqual([off.db.rows("conversations").length, off.db.rows("conversationMessages").length], [0, 0]);
});

test("message text is shown to its owner and to roles that read their activity, metadata only to the rest", async () => {
  const s = setup();
  await s.store([s.msg("m1")], { contactId: "contact-grace" });
  const read = async (access: ReturnType<typeof accessOf>) => plain(await readableTexts(s.ctx as never, access, "organizations:o" as never, ["linkedin:msg:m1", "linkedin:msg:unknown"]));
  const ownOnly = [{ object: "note", visibility: "own" as const }];
  assert.deepEqual(await read(accessOf({ userId: "users:owner", role: "rep", rules: ownOnly })), { "linkedin:msg:m1": { text: "text of m1" } });
  assert.deepEqual(await read(accessOf({ userId: "users:mate", role: "rep" })), { "linkedin:msg:m1": { text: "text of m1" } });
  assert.deepEqual(await read(accessOf({ userId: "users:mate", role: "rep", rules: ownOnly })), { "linkedin:msg:m1": { hidden: true, ownerUserId: "users:owner" } });
});

test("a record's conversations merge threads, calls and meetings newest first, and a thread hides text from those who may not read it", async () => {
  const thread = (id: string, lastMessageAt: number): ConversationSummary => ({ id, channel: "linkedin", lastMessageAt, contactId: "c", counterpart: "Grace", ownerUserId: "users:owner", proposals: 0, suggestions: 0 });
  const rows = conversationRows([thread("t1", 30), thread("t2", 10), thread("t1", 30)], [
    { id: "m1", kind: "meeting", at: 20, title: "Kickoff", startAt: 20, ownerId: null },
    { id: "n1", kind: "note", at: 40, body: "not a conversation", ownerId: null },
  ], 10);
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.id}`), ["conversation:t1", "meeting:m1", "conversation:t2"]);
  assert.equal(conversationRows([thread("t1", 30), thread("t2", 10)], [], 1).length, 1);

  const s = setup();
  await s.store([s.msg("m1"), s.msg("m2", "out")], { contactId: "contact-grace" });
  await s.store([s.msg("m3")], { contactId: "contact-grace" });
  // The record page finds the conversation through one link per contact, written once.
  assert.deepEqual(plain(s.db.rows("conversationContacts").map((r) => r.contactId)), ["contact-grace"]);
  const c = s.db.rows("conversations")[0] as never;
  const read = async (access: ReturnType<typeof accessOf>) => plain(await readableThread(s.ctx as never, access, c, 1));
  const ownOnly = [{ object: "note", visibility: "own" as const }];
  const mine = await read(accessOf({ userId: "users:owner", role: "rep", rules: ownOnly }));
  assert.deepEqual([mine.more, mine.messages.map((m: { text: string }) => m.text)], [true, ["text of m3"]]);
  const theirs = await read(accessOf({ userId: "users:mate", role: "rep", rules: ownOnly }));
  assert.deepEqual([theirs.messages[0].hidden, "text" in theirs.messages[0]], [true, false]);
});

test("an email is kept with its reply text when it is with someone outside the team, and not when it is internal, automated or bulk", () => {
  const team = teamOf(["ada@acme.com", "bob@acme.com"], []);
  const raw = {
    id: "e1", message_id: "<m1@hopper.io>", thread_id: "t1", date: "2026-10-20T10:00:00Z", role: "inbox", subject: "Pricing",
    from_attendee: { identifier: "Grace@Hopper.io", display_name: "Grace" }, to_attendees: [{ identifier: "ada@acme.com" }],
    body_plain: "Tuesday works.\n\nOn Mon, Ada wrote:\n> hi", headers: [{ name: "Received", value: "x" }],
  };
  const mail = intakeMailOf(raw, "ada@acme.com")!;
  assert.deepEqual([mail.direction, mail.from.email, mail.messageId, mail.threadId, mail.text], ["in", "grace@hopper.io", "<m1@hopper.io>", "t1", "Tuesday works."]);
  assert.deepEqual(mailVerdict(mail, "ada@acme.com", team), {
    keep: true, counterpart: { email: "grace@hopper.io", name: "Grace", domain: "hopper.io" }, participants: [{ email: "grace@hopper.io", name: "Grace" }],
  });
  const verdict = (extra: Record<string, unknown>) => mailVerdict(intakeMailOf({ ...raw, ...extra }, "ada@acme.com")!, "ada@acme.com", team);
  const sent = { role: "sent", from_attendee: { identifier: "ada@acme.com" } };
  assert.deepEqual(verdict({ ...sent, to_attendees: [{ identifier: "bob@acme.com" }] }), { keep: false, reason: "team" });
  assert.equal(verdict({ ...sent, to_attendees: [{ identifier: "grace@gmail.com" }] }).keep, true);
  assert.deepEqual(verdict({ headers: [{ name: "List-Unsubscribe", value: "<mailto:u@hopper.io>" }] }), { keep: false, reason: "automated" });
  assert.deepEqual(verdict({ from_attendee: { identifier: "no-reply@hopper.io" } }), { keep: false, reason: "automated" });
  assert.deepEqual(verdict({ ...sent, to_attendees: Array.from({ length: 11 }, (_, i) => ({ identifier: `p${i}@hopper.io` })) }), { keep: false, reason: "bulk" });
  assert.equal(intakeMailOf({ ...raw, role: "drafts" }, "ada@acme.com"), null);
  assert.deepEqual(mailEventOf({ event: "mail_sent", account_id: "acc", email_id: "e1" }), { accountId: "acc", emailId: "e1" });
});

test("email intake logs each email once without text, and leaves Canon's sends and live replies to their own lines", async () => {
  const db = memoryDb({
    emailAccounts: [
      { _id: "emailAccounts:g", orgId: "organizations:o", userId: "users:owner", unipileAccountId: "u-g", address: "ada@acme.com", status: "ok", ingest: true },
      { _id: "emailAccounts:off", orgId: "organizations:o", userId: "users:owner", unipileAccountId: "u-off", address: "ada2@acme.com", status: "ok" },
    ],
    observations: [{ orgId: "organizations:o", subject: { object: "contact", contactId: "contact-grace" }, body: { type: "email", key: "email:received:m2", event: { kind: "received" } } }],
  });
  const scheduled: string[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, fn: unknown) => { scheduled.push(String(fn)); } } };
  const mail = (id: string, direction: "in" | "out", extra: Record<string, unknown> = {}) =>
    ({ messageId: id, direction, at: Date.now() - 1000, from: direction === "in" ? "grace@hopper.io" : "ada@acme.com", to: "grace@hopper.io", subject: "Pricing", text: `text of ${id}`, viaCanon: false, ...extra });
  const store = (messages: unknown[], extra: Record<string, unknown> = {}) => M["conversations.ts"].storeEmail.handler(ctx, {
    accountId: "emailAccounts:g", threadId: "t1", subject: "Pricing", counterpart: { email: "grace@hopper.io", domain: "hopper.io" },
    participants: [{ email: "grace@hopper.io" }], contacts: [{ email: "grace@hopper.io", contactId: "contact-grace" }], live: false, messages, ...extra,
  });
  const keys = () => db.rows("observations").map((o) => (o.body as { key: string }).key).sort();

  // A received email the reply path logged, and one Canon sent, get no second line.
  assert.equal(await store([mail("m1", "out"), mail("m2", "in"), mail("m3", "out", { viaCanon: true })]), 3);
  assert.deepEqual(keys(), ["email:msg:m1", "email:received:m2"]);
  // A webhook's received email is the reply path's to log; a reply without Unipile's thread joins its parent's.
  assert.equal(await store([mail("m4", "in")], { live: true }), 1);
  assert.equal(await store([mail("m5", "in", { inReplyTo: "m1" })], { threadId: null }), 1);
  assert.deepEqual(keys(), ["email:msg:m1", "email:msg:m5", "email:received:m2"]);
  assert.deepEqual(plain(db.rows("conversations").map((c) => [c.channel, c.externalThreadId, c.contactIds, c.subject])), [["email", "t1", ["contact-grace"], "Pricing"]]);
  assert.doesNotMatch(JSON.stringify(db.rows("observations")), /text of/);
  const owner = accessOf({ userId: "users:owner", role: "rep", rules: [{ object: "note", visibility: "own" as const }] });
  assert.deepEqual(plain(await readableTexts(ctx as never, owner, "organizations:o" as never, ["email:received:m2", "email:sent-elsewhere"])), { "email:received:m2": { text: "text of m2" } });
  assert.equal(await store([mail("m9", "in")], { accountId: "emailAccounts:off" }), 0);

  // The reply path keeps no text, and skips an email intake already logged while its reply still wakes the plays.
  const log = (messageId: string) => M["emailAccounts.ts"].logReceived.handler(ctx, {
    orgId: "organizations:o", userId: "users:owner", contactId: "contact-grace", from: "grace@hopper.io", to: "ada@acme.com", subject: "Re: Pricing",
    messageId, at: Date.now(), body: "secret reply", reply: "reply", class: "interested",
  });
  await log("m6");
  await log("m5");
  assert.deepEqual(keys(), ["email:msg:m1", "email:msg:m5", "email:received:m2", "email:received:m6", "gmail:m6"]);
  assert.doesNotMatch(JSON.stringify(db.rows("observations")), /secret/);
  assert.equal(scheduled.filter((f) => f === "internal.dealPlayKeeper.onReply").length, 2);
});

test("two teammates' inboxes keep their own copy of one email, and a live email logs every contact but the sender's", async () => {
  const db = memoryDb({
    emailAccounts: [
      { _id: "emailAccounts:ada", orgId: "organizations:o", userId: "users:ada", unipileAccountId: "u-a", address: "ada@acme.com", status: "ok", ingest: true },
      { _id: "emailAccounts:bob", orgId: "organizations:o", userId: "users:bob", unipileAccountId: "u-b", address: "bob@acme.com", status: "ok", ingest: true },
    ],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  const store = (accountId: string, live: boolean, from: string, contacts: Array<{ email: string; contactId: string }>) => M["conversations.ts"].storeEmail.handler(ctx, {
    accountId, threadId: null, subject: "Pricing", counterpart: { email: from }, participants: [], contacts, live,
    messages: [{ messageId: "m1", direction: "in", at: Date.now() - 1000, from, to: "ada@acme.com, bob@acme.com, grace@hopper.io", subject: "Pricing", text: "text of m1", viaCanon: false }],
  });
  const grace = { email: "grace@hopper.io", contactId: "contact-grace" };

  // From someone unmatched, live: the reply path logs no one, so the matched recipient gets the line from intake.
  assert.equal(await store("emailAccounts:ada", true, "stranger@hopper.io", [grace]), 1);
  assert.equal(await store("emailAccounts:bob", true, "stranger@hopper.io", [grace]), 1);
  assert.equal(await store("emailAccounts:bob", true, "stranger@hopper.io", [grace]), 0);
  assert.deepEqual(db.rows("observations").map((o) => (o.body as { key: string }).key), ["email:msg:m1"]);

  const own = (userId: string) => accessOf({ userId, role: "rep", rules: [{ object: "note", visibility: "own" as const }] });
  const read = async (userId: string) => plain(await readableTexts(ctx as never, own(userId), "organizations:o" as never, ["email:msg:m1"]));
  assert.deepEqual([await read("users:ada"), await read("users:bob")], [{ "email:msg:m1": { text: "text of m1" } }, { "email:msg:m1": { text: "text of m1" } }]);
  await M["conversations.ts"].eraseRead.handler(ctx, { accountRef: "emailAccounts:ada" });
  assert.deepEqual([await read("users:ada"), await read("users:bob")], [{ "email:msg:m1": { hidden: true, ownerUserId: "users:bob" } }, { "email:msg:m1": { text: "text of m1" } }]);
});

test("an unlinked account's reads can still be deleted, and a long chat's backfill resumes inside it (issue #920)", async () => {
  const since = Date.now() - 90 * 86_400_000;
  const db = memoryDb({
    linkedinAccounts: [
      { _id: "linkedinAccounts:gone", orgId: "organizations:o", userId: "users:owner", status: "disconnected", profileName: "Ada", ingest: true },
      { _id: "linkedinAccounts:a", orgId: "organizations:o", userId: "users:owner", status: "ok", ingest: true, ingestSince: since },
    ],
    conversations: [{ _id: "conversations:c", orgId: "organizations:o", accountRef: "linkedinAccounts:gone", channel: "linkedin", externalThreadId: "chat", contactIds: [] }],
  });
  const scheduled: string[] = [];
  const ctx = { db, user: { _id: "users:owner", orgId: "organizations:o", role: "rep" }, scheduler: { runAfter: async (_ms: number, fn: unknown) => { scheduled.push(String(fn)); } } };
  const call = (fn: string, args: Record<string, unknown>) => signedIn["conversations.ts"][fn].handler(ctx, args);
  assert.deepEqual(plain(await call("unlinkedReads", { channel: "linkedin" })), [{ _id: "linkedinAccounts:gone", label: "Ada", on: true }]);
  await assert.rejects(call("setIntake", { accountId: "linkedinAccounts:gone", on: true, textVersion: "2026-10-24" }));
  await call("deleteRead", { accountId: "linkedinAccounts:gone" });
  assert.equal((await db.get("linkedinAccounts:gone"))?.ingest, false);
  assert.deepEqual(scheduled, ["internal.conversations.eraseRead"]);

  // A chat with more messages than a step reads keeps its place; the pass ends only after every chat is read.
  const advance = (args: Record<string, unknown>) => call("backfillAdvance", { accountId: "linkedinAccounts:a", since, ...args });
  const resume = { next: 2, chat: { id: "chat", providerId: "them", cursor: "msgs-p4" } };
  await advance({ cursor: "chats-p1", resume });
  let row = await db.get("linkedinAccounts:a");
  assert.deepEqual(plain([row?.ingestBackfillCursor, row?.ingestBackfillResume, row?.ingestBackfilledAt ?? null]), ["chats-p1", resume, null]);
  await advance({ cursor: "chats-p2" });
  await advance({ cursor: null });
  row = await db.get("linkedinAccounts:a");
  assert.deepEqual([row?.ingestBackfillCursor, row?.ingestBackfillResume, typeof row?.ingestBackfilledAt], [undefined, undefined, "number"]);

  const urls: string[] = [];
  const client = createUnipileClient({ apiKey: "k", dsn: "api.test:1", fetchImpl: (async (url: string) => {
    urls.push(url);
    return Response.json({ items: [{ id: "m1", sender_id: "them", text: "hi", timestamp: "2026-10-20T10:00:00Z" }], cursor: "msgs-p5" });
  }) as typeof fetch });
  const read = await client.chatMessages("chat", since, 1, "msgs-p4");
  assert.deepEqual([read.messages.length, read.cursor, urls[0].includes("cursor=msgs-p4")], [1, "msgs-p5", true]);
});

test("an inbox's 90-day read is a tray job its owner alone sees, also when it began before jobs existed", async () => {
  const since = Date.UTC(2026, 6, 27);
  const db = memoryDb({
    emailAccounts: [{ _id: "emailAccounts:a", orgId: "organizations:o", userId: "users:owner", status: "ok", address: "ada@acme.test", ingest: true, ingestSince: since }],
  });
  const ctx = { db, user: { _id: "users:owner", orgId: "organizations:o", role: "rep" }, scheduler: { runAfter: async () => {} } };
  const call = (fn: string, args: Record<string, unknown>) => signedIn["conversations.ts"][fn].handler(ctx, args);
  const job = async () => (await db.rows("backgroundJobs"))[db.rows("backgroundJobs").length - 1];

  // Mid-backfill with no job: the next step makes one, counting what it read from then on.
  await call("backfillAdvance", { accountId: "emailAccounts:a", since, cursor: "p2", read: 97, reachedAt: Date.UTC(2026, 8, 22) });
  let j = await job();
  assert.deepEqual(plain([j.kind, j.userId, j.status, j.detail, j.href]), ["conversation_intake", "users:owner", "processing", "Read 97 more emails, back to Sep 22", "/dashboard/integrations/gmail"]);
  assert.deepEqual([jobShownTo(j, "users:owner"), jobShownTo(j, "users:mate"), isFillJob(j)], [true, false, false]);
  // The gap to the next step is not a stall.
  assert.equal(jobEntry(j, Date.now() + 11 * 60_000).status, "processing");

  await call("backfillAdvance", { accountId: "emailAccounts:a", since, cursor: null, read: 3 });
  j = await job();
  assert.deepEqual(plain([j.status, typeof (await db.get("emailAccounts:a"))?.ingestBackfilledAt]), ["completed", "number"]);
  // A later pass (the daily reconcile) makes no job.
  await call("backfillAdvance", { accountId: "emailAccounts:a", since, cursor: null, read: 1 });
  assert.equal(db.rows("backgroundJobs").length, 1);

  // Turning reading off and on starts a fresh job; turning it off closes it; a step that fails says why.
  await call("setIntake", { accountId: "emailAccounts:a", on: true, textVersion: "2026-10-24-email" });
  assert.deepEqual(plain([db.rows("backgroundJobs").length, (await job()).status]), [2, "processing"]);
  await call("backfillAdvance", { accountId: "emailAccounts:a", since: (await db.get("emailAccounts:a"))?.ingestSince, cursor: null, stop: true, error: "Reading this inbox stopped: Unipile said no." });
  assert.deepEqual(plain([(await job()).status, (await job()).error]), ["failed", "Reading this inbox stopped: Unipile said no."]);
  await call("setIntake", { accountId: "emailAccounts:a", on: false });
  assert.equal((await job()).status, "failed");
});

test("a cadence's message echoed back by intake shows once on the timeline", () => {
  const e = { _id: "linkedinEnrollments:e", cadenceId: "linkedinCadences:c", contactId: "contact-grace" } as never;
  const sent = linkedinEventOf({ event: "sent", id: "linkedinEnrollments:e" as never, messageId: "lm1" }, e, [], { enrollmentId: "linkedinEnrollments:e" as never, cadenceId: "linkedinCadences:c" as never, step: 1, text: "Hi Grace" });
  assert.equal(sent?.event.kind === "message_sent" && sent.event.messageId, "lm1");
  const log = [
    { seq: 1, observedAt: 1, body: { type: "linkedin" as const, ...sent! } },
    { seq: 2, observedAt: 2, occurredAt: 2, body: { type: "linkedin" as const, key: "linkedin:msg:lm1", event: { kind: "message" as const, direction: "out" as const } } },
    { seq: 3, observedAt: 3, occurredAt: 3, body: { type: "linkedin" as const, key: "linkedin:msg:lm2", event: { kind: "message" as const, direction: "out" as const } } },
  ];
  assert.deepEqual(recordTimeline([], log, []).map((i) => (i.kind === "linkedin" ? i.key : i.kind)), ["linkedin:msg:lm2", sent!.key]);
});

test("conversationMessages is read only where the permission check lives", () => {
  const root = join(import.meta.dirname, "../convex");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return f === "_generated" ? [] : statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const readers = files(root).filter((f) => readFileSync(f, "utf8").includes("\"conversationMessages\"")).map((f) => relative(root, f)).sort();
  // conversations.ts writes and erases messages but never returns their text, devSeed.ts writes local fixtures;
  // moduleMe.ts counts the caller's own messages for Pull and never returns their text; store.ts is the one read that does.
  assert.deepEqual(readers, ["conversations.ts", "devSeed.ts", "lib/conversations/store.ts", "moduleMe.ts"]);
});
