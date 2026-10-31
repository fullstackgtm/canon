import assert from "node:assert/strict";
import test from "node:test";
import { createGranolaClient, externalParticipants, GranolaError, GranolaWindowTooLargeError, GRANOLA_NOTES_PER_POLL, meetingOf, pickDeal, type CandidateDeal } from "../convex/lib/calls/granola.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const KEY = "grn_test_key";

const note = (over: Record<string, unknown> = {}) => ({
  id: "not_a", title: "Acme sync", owner: { name: "Riley Rep", email: "riley@canon.example" },
  created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T10:00:00Z",
  web_url: "https://meetings.example.org/d/a",
  calendar_event: { invitees: [{ email: "sam@acme.example" }, { email: "riley@canon.example" }, { email: "pat@gmail.com" }], scheduled_start_time: "2026-10-01T08:55:00Z" },
  attendees: [{ name: "Sam Lee", email: "Sam@Acme.example" }],
  summary_markdown: "Budget approved.",
  transcript: [
    { speaker: { source: "microphone" }, text: "Where is budget?", start_time: "2026-10-01T09:00:00Z", end_time: "2026-10-01T09:00:10Z" },
    { speaker: { source: "speaker", name: "Sam Lee" }, text: "Approved.", start_time: "2026-10-01T09:00:20Z", end_time: "2026-10-01T09:30:00Z" },
  ],
  ...over,
});

test("a note reads as a meeting: owner left out, people merged by email, owner's side named", () => {
  const m = meetingOf(note())!;
  assert.deepEqual(m.attendees.map((p) => [p.email, p.name]), [["sam@acme.example", "Sam Lee"], ["pat@gmail.com", null]]);
  assert.equal(m.transcriptText, "Riley Rep: Where is budget?\nSam Lee: Approved.");
  assert.equal(m.startAt, Date.parse("2026-10-01T09:00:00Z"));
  assert.equal(m.durationSeconds, 1800);
  assert.equal(m.summary, "Budget approved.");
  // The owner's microphone is the rep's side; times are seconds from the first line.
  assert.deepEqual(m.segments, [{ side: "rep", startSeconds: 0, endSeconds: 10 }, { side: "customer", startSeconds: 20, endSeconds: 1800 }]);
});

test("an import keeps each line's side and times on its segments, and the name guess when the lines don't line up", async () => {
  const callIntelligence = loadConvex(["callIntelligence.ts"])["callIntelligence.ts"]!;
  const db = memoryDb({});
  const segments = [{ side: "rep", startSeconds: 0, endSeconds: 10 }, { side: "customer", startSeconds: 20, endSeconds: null }];
  const args = { orgId: "org", provider: "granola", title: "Acme sync", transcriptText: "Riley Rep: Where is budget?\nSam Lee: Approved." };
  const { callId } = await callIntelligence.importProviderTranscript!.handler({ db }, { ...args, externalCallId: "granola:a", segments });
  const stored = db.rows("callTranscriptSegments").filter((r) => r.callId === callId);
  assert.deepEqual(stored.map((r) => [r.speakerRole, r.startSeconds, r.endSeconds]), [["rep", 0, 10], ["customer", 20, undefined]]);
  const { callId: other } = await callIntelligence.importProviderTranscript!.handler({ db }, { ...args, externalCallId: "granola:b", segments: segments.slice(0, 1) });
  assert.ok(db.rows("callTranscriptSegments").filter((r) => r.callId === other).every((r) => r.startSeconds === undefined));
});

test("a meeting imported before times were kept gets them in place, once, and only while its transcript is unchanged", async () => {
  const { "callIntelligence.ts": callIntelligence, "granola.ts": granola } = loadConvex(["callIntelligence.ts", "granola.ts"]);
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
  const db = memoryDb({ integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: true, syncConfig: { granolaWindow: 2 } }] });
  const transcriptText = "Riley Rep: Where is budget?\nSam Lee: Approved.";
  const imported = async (externalCallId: string) => (await callIntelligence!.importProviderTranscript!.handler({ db }, { orgId: "org", provider: "granola", externalCallId, title: "Old", transcriptText, sourceMetadata: { noteId: externalCallId } })).callId;
  const [same, edited] = [await imported("a"), await imported("b")];
  const ids = db.rows("callTranscriptSegments").filter((r) => r.callId === same).map((r) => r._id);
  const segments = [{ side: "rep", startSeconds: 0, endSeconds: 10 }, { side: "customer", startSeconds: 20, endSeconds: 1800 }];
  const targets = await granola!.timingTargets!.handler({ db }, { orgId: "org", limit: 10 });
  assert.deepEqual(plain(targets.map((t: { noteId: string }) => t.noteId).sort()), ["a", "b"]);

  const keep = (callId: string, text: string) => callIntelligence!.keepTimings!.handler({ db }, { orgId: "org", callId, granolaWindow: 2, transcriptText: text, segments });
  assert.deepEqual(plain(await keep(same, transcriptText)), { kept: true });
  const after = db.rows("callTranscriptSegments").filter((r) => r.callId === same);
  assert.deepEqual(after.map((r) => [r._id, r.speakerRole, r.startSeconds]), [[ids[0], "rep", 0], [ids[1], "customer", 20]]);
  assert.deepEqual(plain(await keep(edited, `${transcriptText} Edited.`)), { kept: false });
  assert.ok(db.rows("callTranscriptSegments").filter((r) => r.callId === edited).every((r) => r.startSeconds === undefined));
  assert.deepEqual(plain(await granola!.timingTargets!.handler({ db }, { orgId: "org", limit: 10 })), []);
  // A poll that began under an older window (before a disconnect or a folder switch) writes nothing.
  await assert.rejects(callIntelligence!.keepTimings!.handler({ db }, { orgId: "org", callId: same, granolaWindow: 1, transcriptText, segments }));
});

test("changed notes: every page, oldest change first, deleted ones dropped; a refused key is an error without the body", async () => {
  const urls: URL[] = [];
  const pages: Record<string, unknown> = {
    "": { notes: [{ id: "n2", updated_at: "2026-10-02T00:00:00Z" }, { id: "gone", updated_at: "2026-10-01T00:00:00Z", deleted_at: "2026-10-03T00:00:00Z" }], hasMore: true, cursor: "c2" },
    c2: { notes: [{ id: "n1", updated_at: "2026-10-01T00:00:00Z" }], hasMore: false, cursor: null },
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    const u = new URL(url);
    urls.push(u);
    if (u.pathname === "/v1/notes") return new Response(JSON.stringify(pages[u.searchParams.get("cursor") ?? ""]), { status: 200 });
    if (u.searchParams.get("include")) return new Response("too large", { status: 413 });
    return new Response(JSON.stringify(note({ transcript: undefined })), { status: 200 });
  }) as typeof fetch;
  const client = createGranolaClient({ apiKey: KEY, fetchImpl });
  assert.deepEqual((await client.changedNotes("2026-09-01T00:00:00Z")).map((r) => r.id), ["n1", "n2"]);
  assert.equal(urls[0]!.searchParams.get("updated_after"), "2026-09-01T00:00:00Z");
  // Too large to send with its transcript: the note still comes, with its summary.
  assert.equal((await client.meeting("not_a"))!.summary, "Budget approved.");

  const refused = createGranolaClient({ apiKey: KEY, fetchImpl: (async () => new Response("secret detail", { status: 401 })) as typeof fetch });
  await assert.rejects(refused.changedNotes("2026-09-01T00:00:00Z"), (e: unknown) => e instanceof GranolaError && e.status === 401 && !e.message.includes("secret"));
});

test("external participants: the workspace's own domains are internal; free mail is a person but no company", () => {
  const m = meetingOf(note())!;
  const out = externalParticipants({ ...m, attendees: [...m.attendees, { name: "Morgan", email: "morgan@canon.example" }] }, ["morgan@canon.example"]);
  assert.deepEqual(out.people.map((p) => p.email), ["sam@acme.example", "pat@gmail.com"]);
  assert.deepEqual(out.domains, ["acme.example"]);
});

test("the meeting's deal: open only, most of its people, then its company, then most recent", () => {
  const d = (streamId: string, over: Partial<CandidateDeal>): CandidateDeal => ({ streamId, dealId: streamId, isClosed: false, updatedAt: 0, matchedContacts: 0, companyMatch: false, ...over });
  assert.equal(pickDeal([d("won", { isClosed: true, matchedContacts: 3 }), d("company", { companyMatch: true, updatedAt: 9 }), d("people", { matchedContacts: 1 })])!.streamId, "people");
  assert.equal(pickDeal([d("old", { companyMatch: true, updatedAt: 1 }), d("new", { companyMatch: true, updatedAt: 2 })])!.streamId, "new");
  assert.equal(pickDeal([d("closed", { isClosed: true, companyMatch: true })]), null);
});

test("a re-imported call keeps the meeting it was logged as, so an edited note updates that meeting", async () => {
  const callIntelligence = loadConvex(["callIntelligence.ts"])["callIntelligence.ts"];
  const db = memoryDb({});
  const args = { orgId: "org", provider: "granola", externalCallId: "granola:not_a", title: "Acme sync", transcriptText: "Riley: hi\nSam: hello", sourceMetadata: { noteId: "not_a" } };
  const { callId } = await callIntelligence!.importProviderTranscript!.handler({ db }, args);
  await db.patch(callId, { sourceMetadata: { noteId: "not_a", meetingStreamId: "meeting_1" } });
  await callIntelligence!.importProviderTranscript!.handler({ db }, { ...args, sourceMetadata: { noteId: "not_a", summary: "v2" } });
  assert.deepEqual(JSON.parse(JSON.stringify((await db.get(callId))!.sourceMetadata)), { noteId: "not_a", meetingStreamId: "meeting_1", summary: "v2" });
});

test("a note that fails to import holds the cursor for the next poll, and is passed over after three polls", async () => {
  // Inside the sync's 14-day lookback whatever day the test runs.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const [goodAt, badAt] = [daysAgo(3), daysAgo(2)];
  const refs = [{ id: "good", updatedAt: goodAt }, { id: "bad", updatedAt: badAt }];
  const actions = loadConvex(["granolaActions.ts"], {
    "lib/calls/granola.ts": (real) => ({
      ...real,
      createGranolaClient: () => ({ changedNotes: async (after: string) => refs.filter((r) => r.updatedAt > after), meeting: async (id: string) => meetingOf(note({ id })) }),
    }),
    "lib/tokenHelpers.ts": (real) => ({ ...real, decryptFromStorage: async () => KEY }),
  })["granolaActions.ts"]!;
  const config: Record<string, unknown> = {};
  const granola = loadConvex(["granola.ts"])["granola.ts"]!;
  const integration = { _id: "integ", orgId: "org", provider: "granola", isActive: true, accessToken: "enc", syncConfig: config };
  const db = memoryDb({ integrations: [integration] });
  let imported = 0;
  const cursor = async () => ((await db.get("integ"))!.syncConfig as Record<string, unknown>).granolaCursor ?? null;
  const ctx = {
    runQuery: async (ref: unknown) => {
      if (String(ref) === "internal.granola.syncState") return { apiKey: "enc", baseUrl: null, cursor: await cursor(), window: 0, lookbackDays: 14, connectedBy: null, members: [] };
      if (String(ref) === "internal.granola.timingTargets") return [];
      return String(ref) === "internal.granola.stillCurrent" ? true : null;
    },
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      const name = String(ref);
      if (name === "internal.callIntelligence.importProviderTranscript") {
        if (String(args.externalCallId).endsWith("bad")) throw new Error("boom");
        imported++;
        return { callId: "call" };
      }
      if (name === "internal.callIntelligence.analyzeImportedCall") return { insights: 0 };
      if (name === "internal.granola.saveCursor") return granola.saveCursor!.handler({ db }, args);
      if (name === "internal.granola.noteFailed") return granola.noteFailed!.handler({ db }, args);
      return "run";
    },
  };
  await actions.syncOrg!.handler(ctx, { orgId: "org", trigger: "scheduled" });
  assert.equal(await cursor(), goodAt, "stopped before the bad note");
  await actions.syncOrg!.handler(ctx, { orgId: "org", trigger: "scheduled" });
  assert.equal(await cursor(), goodAt);
  await actions.syncOrg!.handler(ctx, { orgId: "org", trigger: "scheduled" });
  assert.equal(await cursor(), badAt, "third failure: passed over");
  assert.equal(imported, 1);
});

test("a longer lookback rewinds the import to read the older meetings, and a poll already running cannot undo it; a shorter one leaves it", async () => {
  const user = { _id: "u", orgId: "org", role: "admin", isActive: true };
  const granola = loadConvex(["granola.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async () => user }) })["granola.ts"]!;
  const day = 24 * 60 * 60 * 1000;
  const covered = new Date(Date.now() - 14 * day).toISOString();
  const db = memoryDb({ integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: true, accessToken: "enc", lastSyncStatus: "success",
    syncConfig: { granolaCursor: "2026-10-10T00:00:00Z", granolaCoveredFrom: covered, granolaLookbackDays: 14 } }] });
  const scheduled: string[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, ref: unknown) => void scheduled.push(String(ref)) } };
  const config = async () => (await db.get("integ"))!.syncConfig as Record<string, unknown>;

  assert.deepEqual(JSON.parse(JSON.stringify(await granola.setLookback!.handler(ctx, { days: 7 }))), { rewound: false });
  assert.equal((await config()).granolaCursor, "2026-10-10T00:00:00Z");

  assert.deepEqual(JSON.parse(JSON.stringify(await granola.setLookback!.handler(ctx, { days: 90 }))), { rewound: true });
  const after = await config();
  assert.ok(Date.parse(after.granolaCursor as string) < Date.parse(covered) - 70 * day);
  assert.equal(after.granolaCoveredFrom, after.granolaCursor);
  assert.deepEqual(scheduled, ["internal.granolaActions.syncOrg"]);
  // A poll that started before the rewind finishes a note: its cursor write is fenced off.
  await granola.saveCursor!.handler({ db }, { orgId: "org", cursor: "2026-10-11T00:00:00Z", noteId: "n", window: 0 });
  assert.equal((await config()).granolaCursor, after.granolaCursor);
  await assert.rejects(granola.setLookback!.handler(ctx, { days: 3 }), /offered lookbacks/);
});

test("a window with more changed notes than one listing reads is refused, not read in part", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ notes: [{ id: "n", updated_at: "2026-10-01T00:00:00Z" }], hasMore: true, cursor: "next" }), { status: 200 })) as typeof fetch;
  await assert.rejects(createGranolaClient({ apiKey: KEY, fetchImpl }).changedNotes("2026-01-01T00:00:00Z"), (e: unknown) => e instanceof GranolaWindowTooLargeError);
});

test("a poll that reads a full page of notes schedules the next one right away", async () => {
  const refs = Array.from({ length: GRANOLA_NOTES_PER_POLL }, (_, i) => ({ id: `n${i}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  const actions = loadConvex(["granolaActions.ts"], {
    "lib/calls/granola.ts": (real) => ({ ...real, createGranolaClient: () => ({ changedNotes: async () => refs, meeting: async () => null }) }),
    "lib/tokenHelpers.ts": (real) => ({ ...real, decryptFromStorage: async () => KEY }),
  })["granolaActions.ts"]!;
  const scheduled: Array<[number, string]> = [];
  const catchingUp: boolean[] = [];
  const ctx = {
    runQuery: async (ref: unknown) => (String(ref) === "internal.granola.stillCurrent" ? true : { apiKey: "enc", baseUrl: null, cursor: null, window: 0, lookbackDays: 90, connectedBy: null, members: [] }),
    runMutation: async (ref: unknown, args: Record<string, unknown>) => {
      if (String(ref) === "internal.granola.setCatchingUp") catchingUp.push(args.catchingUp as boolean);
      return "run";
    },
    scheduler: { runAfter: async (ms: number, ref: unknown) => void scheduled.push([ms, String(ref)]) },
  };
  await actions.syncOrg!.handler(ctx, { orgId: "org", trigger: "scheduled" });
  assert.deepEqual(catchingUp, [true]);
  assert.deepEqual(scheduled, [[30_000, "internal.granolaActions.syncOrg"]]);
});

test("disconnecting deletes what Granola imported and rejects its undecided proposals; a reconnect's imports are spared", async () => {
  const deleted: string[] = [];
  const rejected: string[] = [];
  const granola = loadConvex(["granola.ts"], {
    "objects.ts": (real) => ({ ...real, saveAsCaller: async (_ctx: unknown, _u: unknown, object: string, cmd: { op: string; streamId: string }) => (deleted.push(`${object}:${cmd.op}:${cmd.streamId}`), { status: "applied" }) }),
    "lib/canon/ledger.ts": (real) => ({ ...real, decideFacts: async (_s: unknown, a: { decisions: Array<{ factId: string; status: string }> }) => (rejected.push(...a.decisions.map((d) => `${d.factId}:${d.status}`)), { decided: [] }) }),
    "canon.ts": (real) => ({ ...real, convexLedgerStore: () => ({}), mirrorDecidedFacts: async () => undefined }),
    "canonGate.ts": (real) => ({ ...real, settlePlan: async () => undefined }),
  })["granola.ts"]!;
  const seed = (active: boolean) => memoryDb({
    integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: active, syncConfig: {} }],
    users: [{ _id: "u", orgId: "org", role: "admin", isActive: true }],
    patchPlans: [{ _id: "plan", orgId: "org" }],
    facts: [{ _id: "f1", patchPlanId: "plan", status: "proposed" }, { _id: "f2", patchPlanId: "plan", status: "accepted" }],
    callRecordings: [
      { _id: "old", orgId: "org", provider: "granola", title: "Imported", sourceMetadata: { meetingStreamId: "meeting_1", callFacts: { patchPlanId: "plan" } } },
      { _id: "dialer", orgId: "org", provider: "telnyx", title: "A dialer call" },
    ],
    callTranscriptSegments: [{ _id: "seg", callId: "old" }, { _id: "seg2", callId: "dialer" }],
    callInsights: [{ _id: "ins", callId: "old" }],
    callSuggestions: [{ _id: "sug", callId: "old" }],
  });
  const ctxOf = (db: ReturnType<typeof memoryDb>) => ({ db, scheduler: { runAfter: async () => undefined } });

  // Reconnected since: only what came before the disconnect goes.
  const db = seed(true);
  const before = (await db.get("old"))!._creationTime + 1;
  await db.insert("callRecordings", { orgId: "org", provider: "granola", title: "Imported after a reconnect" });
  await granola.purgeImported!.handler(ctxOf(db), { orgId: "org", userId: "u", before });
  assert.deepEqual(db.rows("callRecordings").map((r) => r.title), ["A dialer call", "Imported after a reconnect"]);
  assert.deepEqual(db.rows("callTranscriptSegments").map((r) => r._id), ["seg2"]);
  assert.deepEqual([db.rows("callInsights").length, db.rows("callSuggestions").length], [0, 0]);
  assert.deepEqual(deleted, ["meeting:delete:meeting_1"]);
  assert.deepEqual(rejected, ["f1:rejected"]);

  // Still disconnected: what a poll running at the disconnect wrote after it goes too.
  const off = seed(false);
  const cut = (await off.get("old"))!._creationTime + 1;
  await off.insert("callRecordings", { orgId: "org", provider: "granola", title: "Written by a poll mid-note" });
  await granola.purgeImported!.handler(ctxOf(off), { orgId: "org", userId: "u", before: cut });
  assert.deepEqual(off.rows("callRecordings").map((r) => r.title), ["A dialer call"]);
});

test("choosing folders lists only them, pauses polling, deletes the old imports, then imports the window again", async () => {
  // The client reads each chosen folder and merges what they list.
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const folder = new URL(url).searchParams.get("folder_id");
    asked.push(folder ?? "all");
    const notes = folder === "fol_a" ? [{ id: "n1", updated_at: "2026-10-02T00:00:00Z" }, { id: "n2", updated_at: "2026-10-01T00:00:00Z" }] : [{ id: "n2", updated_at: "2026-10-01T00:00:00Z" }];
    return new Response(JSON.stringify({ notes, hasMore: false, cursor: null }), { status: 200 });
  }) as typeof fetch;
  const refs = await createGranolaClient({ apiKey: KEY, fetchImpl }).changedNotes("2026-09-01T00:00:00Z", 40, ["fol_a", "fol_b"]);
  assert.deepEqual([asked, refs.map((r) => r.id)], [["fol_a", "fol_b"], ["n2", "n1"]]);

  const user = { _id: "u", orgId: "org", role: "admin", isActive: true };
  const granola = loadConvex(["granola.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async () => user }) })["granola.ts"]!;
  const db = memoryDb({
    users: [user],
    integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: true, syncConfig: { granolaWindow: 3, granolaLookbackDays: 30, granolaCursor: "2026-10-10T00:00:00Z" } }],
    callRecordings: [{ _id: "old", orgId: "org", provider: "granola", title: "A standup" }],
  });
  const scheduled: Array<[string, Record<string, unknown>]> = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, ref: unknown, args: Record<string, unknown>) => void scheduled.push([String(ref), args]) } };
  const config = async () => (await db.get("integ"))!.syncConfig as Record<string, unknown>;

  assert.deepEqual(JSON.parse(JSON.stringify(await granola.setFolders!.handler(ctx, { folders: [{ id: "fol_qq", name: "QuotaQueue" }] }))), { rescoping: true });
  assert.deepEqual([(await config()).granolaRescoping, (await config()).granolaWindow], [true, 4]);
  assert.equal(await granola.stillCurrent!.handler({ db }, { orgId: "org", window: 4 }), false); // polls hold while it re-scopes
  const [purgeRef, purgeArgs] = scheduled[0]!;
  assert.equal(purgeRef, "internal.granola.purgeImported");

  await granola.purgeImported!.handler(ctx, purgeArgs);
  assert.equal(db.rows("callRecordings").length, 0);
  const after = await config();
  assert.equal(after.granolaRescoping, undefined);
  assert.ok(Date.parse(after.granolaCursor as string) < Date.now() - 20 * 86_400_000); // back to the lookback's start, weeks before today
  assert.equal(scheduled.at(-1)![0], "internal.granolaActions.syncOrg");
});

test("an import from a poll that began before a disconnect, folder switch or rewind is refused in its own write", async () => {
  const intel = loadConvex(["callIntelligence.ts"])["callIntelligence.ts"]!;
  const args = { orgId: "org", provider: "granola", externalCallId: "granola:not_a", title: "Late note", transcriptText: "Riley: hi\nSam: hello" };
  const refused = (e: unknown) => (e as { data?: { kind?: string } }).data?.kind === "granola_stale_poll";
  for (const syncConfig of [{ granolaWindow: 5 }, { granolaWindow: 4, granolaRescoping: true }]) {
    const db = memoryDb({ integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: true, syncConfig }] });
    await assert.rejects(intel.importProviderTranscript!.handler({ db }, { ...args, granolaWindow: 4 }), refused);
    assert.equal(db.rows("callRecordings").length, 0);
  }
  const live = memoryDb({ integrations: [{ _id: "integ", orgId: "org", provider: "granola", isActive: true, syncConfig: { granolaWindow: 4 } }] });
  await intel.importProviderTranscript!.handler({ db: live }, { ...args, granolaWindow: 4 });
  assert.equal(live.rows("callRecordings").length, 1);
});
