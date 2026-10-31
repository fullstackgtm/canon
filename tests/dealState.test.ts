import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { buyerCallTexts, completeness, mergeConcerns, redactState, stateForReader, summarizeState, summaryForReader, selectStateSources, stateInputHash, stateRunOf, verifiedState, type Concern, type StateSource } from "../convex/lib/plays/state.ts";
import { teamOf } from "../convex/lib/calls/suggestions.ts";
import { accessOf } from "../convex/lib/access.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const handlers = loadConvex(["dealState.ts", "dealPlays.ts"], {
  "permissions.ts": (real) => ({ ...real, accessFor: async (ctx: { access: unknown }) => ctx.access, dealVisible: () => true }),
  "dealCommittee.ts": (real) => ({ ...real, dealOfStream: async (ctx: { db: ReturnType<typeof memoryDb> }) => ctx.db.get("deals:d") }),
  "records.ts": (real) => ({ ...real, requireCaller: async (ctx: { caller: unknown }) => ctx.caller,
    callerClient: (ctx: { deals: unknown[] }) => ({ listObjects: async () => ({ rows: ctx.deals }) }),
  }),
  "lib/recipes.ts": (real) => ({ ...real, requirePlays: async () => null }),
});
const handler = handlers["dealState.ts"];

const framework = { name: "Test", lines: [
  { key: "budget", group: "Budget", label: "Budget" },
  { key: "buyer", group: "Authority", label: "Economic buyer" },
  { key: "problem", group: "Need", label: "Problem" },
] };
const source: StateSource = { kind: "email", id: "thread", text: 'Buyer: We have “budget” approved.\nRep: Finance will sign.', buyerTexts: ['Buyer: We have “budget” approved.'], at: 100, activity: true };
const coverage = { read: 1, total: 1, omitted: 0, partial: false, inventoryLimited: false };

test("qualification keeps only quotes in the read source and requires buyer-side support to establish a line", () => {
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Proposal", reason: "Terms discussed." },
    qualification: [
      { key: "budget", status: "established", text: "Budget approved.", sources: [{ kind: "email", id: "thread", quote: 'We have "budget"   approved.' }] },
      { key: "buyer", status: "established", text: "Finance signs.", sources: [{ kind: "email", id: "thread", quote: "Finance will sign." }] },
      { key: "problem", status: "established", text: "Urgent problem.", sources: [{ kind: "email", id: "thread", quote: "Losing a million a week." }, { kind: "call", id: "unread", quote: "We have “budget” approved." }] },
    ], concerns: [{ key: "invented", kind: "risk", title: "Unfounded", text: "No source.", raisedBy: "Buyer", sources: [{ kind: "email", id: "thread", quote: "Made up" }] }],
  }, framework, [source], coverage, "Evaluation", 200);
  assert.deepEqual(state.qualification.map((q) => [q.status, q.sources.map((s) => s.support)]), [["established", ["buyer"]], ["partial", ["our_side"]], ["partial", []]]);
  assert.equal(state.stage.mismatch, true);
  const won = verifiedState({ summary: "Won.", stage: { label: "Closed won", reason: "Signed." }, qualification: [], concerns: [] }, framework, [], coverage, "closed_won", 200);
  assert.equal(won.stage.mismatch, false);
  assert.deepEqual(state.concerns, []);
});

test("an email quote shows only to readers of its inbox owner's text", () => {
  const owned = { ...source, ownerUserId: "owner" };
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Proposal", reason: "Terms." },
    qualification: [{ key: "budget", status: "established", text: "Budget approved.", sources: [{ kind: "email", id: "thread", quote: "We have budget approved." }] }], concerns: [],
  }, framework, [{ ...owned, text: "Buyer: We have budget approved.", buyerTexts: ["Buyer: We have budget approved."] }], coverage, "Proposal", 200);
  const quote = (s: typeof state) => s.qualification[0].sources[0].quote;
  assert.equal(quote(redactState(state, (o) => o === "owner")), "We have budget approved.");
  assert.equal(quote(redactState(state, () => false)), "");
  assert.equal(redactState(state, () => false).qualification[0].status, "established");
});

test("a reader whose role narrows access never gets the state", () => {
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Proposal", reason: "Terms." }, qualification: [], concerns: [] }, framework, [], coverage, "Proposal", 200);
  const all = () => true;
  assert.deepEqual(stateForReader(state, { restricted: true, mayRead: all }), { state: null, stateHidden: true });
  assert.equal(stateForReader(state, { restricted: false, mayRead: all }).state?.summary, "A renewal.");
  const summary = summarizeState(state);
  assert.deepEqual(summaryForReader(summary, true), { stateSummary: null, stateHidden: true });
  assert.deepEqual(summaryForReader(summary, false), { stateSummary: summary, stateHidden: false });
  assert.deepEqual(summaryForReader(null, false), { stateSummary: null, stateHidden: false });
});

test("pipeline summary counts qualification, picks the newest open concerns and bounds the main issue", () => {
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Proposal", reason: "Terms." }, qualification: [], concerns: [] }, framework, [], coverage, "Discovery", 200);
  const concern: Concern = { key: "risk", kind: "risk", title: "Approval", text: `Approval\n${"x".repeat(220)}`, raisedBy: "Buyer", sources: [], count: 1, firstObservedAt: 1, lastObservedAt: 20, dismissed: false, resolved: false };
  state.qualification[0].status = "established";
  state.concerns = [
    { ...concern, key: "resolved", title: "Resolved", resolved: true, lastObservedAt: 40 },
    { ...concern, key: "dismissed", title: "Dismissed", dismissed: true, lastObservedAt: 30 },
    { ...concern, key: "older", title: "Older", lastObservedAt: 10 },
    concern,
    { ...concern, key: "price", kind: "objection", title: "Price", text: "Price is too high." },
  ];
  assert.deepEqual(summarizeState(state), {
    completeness: { established: 1, total: 3 }, stage: { label: "Proposal", mismatch: true },
    topObjection: "Price", topRisk: "Approval", mainIssue: `Approval ${"x".repeat(190)}`, generatedAt: 200,
  });
  assert.deepEqual(summarizeState({ ...state, concerns: [] }), {
    completeness: { established: 1, total: 3 }, stage: { label: "Proposal", mismatch: true },
    topObjection: null, topRisk: null, mainIssue: "A renewal.", generatedAt: 200,
  });
});

test("the page and MCP list share bounded summary reads and blank restricted readers", async () => {
  const plays = handlers["dealPlays.ts"];
  const state = verifiedState({ summary: "Private deal summary.", stage: { label: "Proposal", reason: "Terms." }, qualification: [], concerns: [] }, framework, [], coverage, "Discovery", 200);
  const summary = summarizeState(state);
  const db = memoryDb({
    dealPlays: Array.from({ length: 11 }, (_, i) => ({ _id: `plays:${i}`, orgId: "organizations:o", streamId: `deal:${i}`, dealId: `deals:${i}`, state,
      ...(i === 0 ? {} : { stateSummary: summary }), keeper: { health: "at_risk", lastTouch: { at: 100, channel: "email" } },
    })),
    deals: Array.from({ length: 11 }, (_, i) => ({ _id: `deals:${i}`, primaryRepId: "users:reader" })),
    users: [{ _id: "users:reader", name: "Owner" }],
  });
  const caller = { orgId: "organizations:o", userId: "users:reader", access: accessOf({ userId: "users:reader", role: "rep" }) };
  const deals = Array.from({ length: 10 }, (_, i) => ({ id: `deal:${i}`, title: `Deal ${i}`, values: { ownerId: "users:reader", stage: "Proposal", closeDate: "2026-11-01" } }));
  let queries = 0;
  const ctx = { db, caller, deals, runQuery: async (_ref: unknown, args: unknown) => {
    queries++;
    const page = await plays.orgPlays.handler({ db }, args);
    assert.ok(page.rows.length <= 10);
    assert.ok(page.rows.every((row: object) => !("state" in row)));
    return page;
  } };
  const rows = await plays.list.handler(ctx, {});
  assert.equal(queries, 2);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].stateSummary, null);
  assert.equal(rows[0].stateHidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[1].stateSummary)), { ...summary, stage: { label: "Proposal", mismatch: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(rows[1].lastTouch)), { at: 100, channel: "email" });
  for (const access of [
    accessOf({ userId: "users:reader", role: "rep", rules: [{ object: "deal", fields: [{ apiName: "amount", level: "readOnly" }] }] }),
    accessOf({ userId: "users:reader", role: "rep", preview: { adminId: "admin", asUserId: "users:reader", asName: "Owner" } }),
  ]) {
    caller.access = access;
    const restricted = await plays.list.handler(ctx, {});
    assert.ok(restricted.every((row: { stateSummary: unknown; stateHidden: boolean; lastTouch: unknown }) => row.stateSummary === null && row.stateHidden && row.lastTouch === null));
  }
});

test("concerns merge once per key, resolve when absent, reopen when seen and preserve dismissals", () => {
  const concern = { key: "price", kind: "objection" as const, title: "Price", text: "Too costly.", raisedBy: "Buyer", sources: [{ kind: "email" as const, id: "thread", quote: "Too costly", support: "buyer" as const }] };
  const first = mergeConcerns([], [concern, concern], 100);
  const second = mergeConcerns(first.map((c) => ({ ...c, dismissed: true })), [concern, concern], 200);
  assert.deepEqual(second.map((c) => [c.count, c.firstObservedAt, c.lastObservedAt, c.resolved, c.dismissed]), [[2, 100, 200, false, true]]);
  const resolved = mergeConcerns(second, [], 300);
  assert.deepEqual([resolved[0].resolved, resolved[0].count, resolved[0].lastObservedAt], [true, 2, 200]);
  assert.deepEqual(mergeConcerns(resolved, [concern], 400).map((c) => [c.count, c.resolved, c.dismissed]), [[3, false, true]]);
});

test("a concern whose sources a run didn't read stays open", () => {
  const concern = { key: "price", kind: "objection" as const, title: "Price", text: "Too costly.", raisedBy: "Buyer", sources: [{ kind: "email" as const, id: "thread", quote: "Too costly", support: "buyer" as const }] };
  const open = mergeConcerns([], [concern], 100);
  assert.equal(mergeConcerns(open, [], 200, new Set(["call:other"]))[0].resolved, false);
  assert.equal(mergeConcerns(open, [], 200, new Set(["email:thread"]))[0].resolved, true);
});

test("completeness counts established lines only and retains the full framework denominator", () => {
  assert.deepEqual(completeness(["established", "partial", "missing", "unknown"].map((status) => ({ status }))), { established: 1, total: 4 });
  const state = verifiedState({ summary: "No evidence.", stage: { label: "Discovery", reason: "Unknown." }, qualification: [], concerns: [] }, framework, [], { ...coverage, read: 0, total: 0 }, "Discovery", 1);
  assert.deepEqual(state.completeness, { established: 0, total: 3 });
  assert.deepEqual(completeness([]), { established: 0, total: 0 });
});

test("coverage reads newest activities first, reports omitted and truncated text, and the input hash changes with evidence", () => {
  const old = { ...source, id: "old", at: 1 };
  const selected = selectStateSources([old, source, { ...source, id: "unreadable", text: "", buyerTexts: [] }], 10);
  assert.deepEqual(selected.sources.map((s) => [s.id, s.text]), [["thread", source.text.slice(0, 10)]]);
  assert.deepEqual(selected.coverage, { read: 1, total: 3, omitted: 2, partial: true, inventoryLimited: false });
  assert.equal(stateInputHash(selected), stateInputHash(selectStateSources([old, source, { ...source, id: "unreadable", text: "", buyerTexts: [] }], 10)));
  assert.notEqual(stateInputHash(selected), stateInputHash({ ...selected, sources: [old] }));
});



test("state input reader excludes unreadable thread text before querying its messages", async () => {
  const db = memoryDb({
    users: [{ _id: "users:reader", orgId: "organizations:o", isActive: true, email: "rep@our.example" }],
    deals: [{ _id: "deals:d", orgId: "organizations:o", name: "Buyer renewal" }],
    conversations: [
      { _id: "conversations:private", orgId: "organizations:o", ownerUserId: "users:other", channel: "email" },
      { _id: "conversations:own", orgId: "organizations:o", ownerUserId: "users:reader", channel: "email" },
    ],
    conversationMessages: [
      { _id: "messages:secret", conversationId: "conversations:private", text: "Private buyer budget", from: "buyer@their.example", direction: "in" },
      { _id: "messages:own", conversationId: "conversations:own", text: "Our readable thread", from: "buyer@their.example", direction: "in", at: 10 },
    ],
  });
  const access = accessOf({ userId: "users:reader", role: "rep", rules: [{ object: "note", visibility: "own" }] });
  const reads: string[] = [];
  const ctx = { db: { ...db, query: (table: string) => { reads.push(table); return db.query(table); } }, access,
    runQuery: async () => ({ limited: false, sources: ["private", "own"].map((id) => ({ kind: "email", id: `conversations:${id}`, title: "Buyer renewal", at: 10, contactIds: [], people: [] })) }),
  };
  const result = await handler.inputs.handler(ctx, { orgId: "organizations:o", userId: "users:reader", streamId: "deal", contactIds: [], companyDomain: null });
  assert.equal(JSON.stringify(result).includes("Private buyer budget"), false);
  assert.equal(result.sources.find((s: StateSource) => s.id === "conversations:private").text, "");
  assert.equal(result.sources.find((s: StateSource) => s.id === "conversations:own").text, "buyer@their.example: Our readable thread");
  assert.equal(reads.filter((table) => table === "conversationMessages").length, 1);
});

test("run completion ignores stale writers, keeps failed runs' last state and merges concurrent dismissals", async () => {
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Discovery", reason: "Early." }, qualification: [], concerns: [] }, framework, [], coverage, "Discovery", 1);
  const concern: Concern = { key: "risk", kind: "risk", title: "Risk", text: "Risk.", raisedBy: "Buyer", sources: [], count: 1, firstObservedAt: 1, lastObservedAt: 1, dismissed: true, resolved: false };
  const db = memoryDb({ dealPlays: [{ _id: "plays:p", orgId: "organizations:o", streamId: "deal", state: { ...state, concerns: [concern] }, stateRun: { status: "running", startedAt: 20, startedBy: "users:reader" } }] });
  const args = { orgId: "organizations:o", streamId: "deal", startedAt: 10, inputHash: "old", state };
  await handler.finish.handler({ db }, args);
  assert.equal(db.rows("dealPlays")[0].stateInputHash, undefined);
  await handler.finish.handler({ db }, { ...args, startedAt: 20, inputHash: "new" });
  const saved = db.rows("dealPlays")[0];
  const stalled = stateRunOf({ status: "running", startedAt: 1, startedBy: "users:reader" as Id<"users"> }, 600_001);
  assert.equal(stalled?.status, "failed");
  assert.equal(saved.stateInputHash, "new");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.stateSummary)), summarizeState(saved.state as typeof state));
  assert.equal((saved.state as typeof state).concerns[0].dismissed, true);
  await db.patch("plays:p", { stateRun: { status: "running", startedAt: 30, startedBy: "users:reader" } });
  await handler.finish.handler({ db }, { ...args, state: undefined, startedAt: 30, error: "failed" });
  assert.equal(db.rows("dealPlays")[0].stateInputHash, "new");
  assert.equal((db.rows("dealPlays")[0].state as typeof state).summary, "A renewal.");
});

test("call support requires a matched buyer or a known customer side and never guesses from an unnamed attendee", () => {
  const team = teamOf(["rep@our.example"], []);
  const segments = [
    { text: "Anonymous claim", speakerRole: "unknown" as const },
    { text: "Buyer quote", speakerRole: "unknown" as const, speaker: "Buyer" },
    { text: "Rep claim", speakerRole: "customer" as const, speaker: "Teammate" },
    { text: "Provider buyer quote", speakerRole: "customer" as const },
  ];
  assert.deepEqual(buyerCallTexts(segments.map((s) => s.text).join("\n"), segments,
    [{ email: "buyer@their.example" }, { name: "Buyer", email: "buyer@their.example" }, { name: "Teammate", email: "another@our.example" }], team), ["Buyer quote", "Provider buyer quote"]);
});

test("debounced callbacks discard superseded quiet periods and unchanged input hashes skip generation", async () => {
  const now = Date.now();
  const dueAt = now - 1;
  const db = memoryDb({
    users: [{ _id: "users:reader", orgId: "organizations:o", isActive: true, role: "admin" }],
    deals: [{ _id: "deals:d", orgId: "organizations:o", primaryRepId: "users:reader" }],
    dealPlays: [{ _id: "plays:p", orgId: "organizations:o", dealId: "deals:d", streamId: "deal", stateDueAt: dueAt, stateInputHash: "same" }],
  });
  const scheduled: Array<{ delay: number; ref: string }> = [];
  const ctx = { db, access: accessOf({ userId: "users:reader", role: "admin" }), scheduler: { runAfter: async (delay: number, ref: unknown) => { scheduled.push({ delay, ref: String(ref) }); } } };
  const args = { orgId: "organizations:o", userId: "users:reader", streamId: "deal", force: false };
  assert.equal(await handler.claim.handler(ctx, { ...args, inputHash: "same" }), null);
  await handler.runDue.handler(ctx, { ...args, dueAt: dueAt - 1 });
  assert.equal(scheduled.length, 0);
  const claimed = await handler.claim.handler(ctx, { ...args, inputHash: "changed" });
  assert.equal(typeof claimed, "number");
  assert.equal(await handler.claim.handler(ctx, { ...args, force: true, inputHash: "newer" }), null);
  await handler.runDue.handler(ctx, { ...args, dueAt });
  assert.deepEqual([...scheduled], [{ delay: 60_000, ref: "internal.dealState.runDue" }]);
  await db.patch("plays:p", { stateRun: { status: "done", startedAt: claimed, startedBy: "users:reader" } });
  await handler.runDue.handler(ctx, { ...args, dueAt });
  assert.equal(scheduled[1].ref, "internal.dealStateActions.generate");
  assert.equal(db.rows("dealPlays")[0].stateDueAt, undefined);
});
