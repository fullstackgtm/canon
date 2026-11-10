import assert from "node:assert/strict";
import test from "node:test";
import { CONVERSATION_TEXT_MAX, groundedFacts, groundedSuggestionRead, threadText, type ConversationFactsContext } from "../convex/lib/conversations/facts.ts";
import { CONTEXT_MESSAGES, conversationSuggestions, messagesToRead, personKey, unknownCounterpart, type StoredMessage } from "../convex/lib/conversations/extract.ts";
import { accessOf } from "../convex/lib/access.ts";
import { defaultModel } from "../recipes/index.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const configuration = { env: {} as Record<string, string> };
const M = loadConvex(["conversationExtract.ts"], {}, { process: configuration });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const msg = (i: number, stored = i, text = `message ${i}`): StoredMessage => ({ at: Date.UTC(2026, 9, 20) + i * 60_000, from: i % 2 ? "Grace" : "Ada", direction: i % 2 ? "them" : "us", text, stored });

test("a pass reads every message first, then only those stored since with a few before them, newest kept over the cap", () => {
  const thread = Array.from({ length: 30 }, (_, i) => msg(i));
  assert.equal(messagesToRead(thread, undefined).length, 30);
  // Two new messages: read with the CONTEXT_MESSAGES before them.
  assert.deepEqual(messagesToRead(thread, 27).map((m) => m.text), thread.slice(28 - CONTEXT_MESSAGES).map((m) => m.text));
  assert.deepEqual(messagesToRead(thread, 29), []);
  // A backfilled old message stored late is new too, and is read with what came after it.
  assert.equal(messagesToRead([...thread.slice(1), msg(0, 99)], 29).length, 30);
  const long = [msg(0, 0, "a".repeat(40_000)), msg(1, 1, "b".repeat(40_000))];
  const read = messagesToRead(long, undefined);
  assert.deepEqual(read.map((m) => m.text[0]), ["b"]);
  assert.ok(threadText(read).length <= CONVERSATION_TEXT_MAX);
});

function setup(o: { ingest?: boolean; status?: string; due?: number; extractedAt?: number } = {}, env: Record<string, string> = {}) {
  configuration.env = env;
  const now = Date.now();
  const db = memoryDb({
    users: [{ _id: "users:owner", orgId: "organizations:o", isActive: true, name: "Ada", email: "ada@us.example" }],
    linkedinAccounts: [{ _id: "linkedinAccounts:a", orgId: "organizations:o", userId: "users:owner", status: o.status ?? "ok", ingest: o.ingest ?? true }],
    conversations: [
      { _id: "conversations:due", orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", accountRef: "linkedinAccounts:a", externalThreadId: "chat",
        counterpart: { providerId: "p", name: "Grace" }, contactIds: [], lastMessageAt: now - 11 * 60_000, extractDueAt: o.due ?? now - 60_000,
        ...(o.extractedAt !== undefined ? { extractedAt: o.extractedAt } : {}) },
      // Still inside its quiet period, and one never due.
      { _id: "conversations:quiet", orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", accountRef: "linkedinAccounts:a", externalThreadId: "c2",
        counterpart: {}, contactIds: [], lastMessageAt: now, extractDueAt: now + 9 * 60_000 },
      { _id: "conversations:idle", orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", accountRef: "linkedinAccounts:a", externalThreadId: "c3",
        counterpart: {}, contactIds: [], lastMessageAt: now },
    ],
    conversationMessages: [{ _id: "conversationMessages:m1", orgId: "organizations:o", conversationId: "conversations:due", externalMessageId: "m1", direction: "in", at: now - 11 * 60_000, from: "p", text: "Hi" }],
  });
  const started: unknown[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: unknown) => void started.push(args) } };
  const call = (fn: string, args: Record<string, unknown> = {}) => M["conversationExtract.ts"][fn].handler(ctx, args);
  const row = (id: string) => db.rows("conversations").find((c) => c._id === id)!;
  return { db, call, started, row };
}

test("only conversations quiet past their due time start, once each, and a pass clears its own due time only", async () => {
  const s = setup({}, { TOKEN_ENCRYPTION_KEY: "test-encryption-key" });
  assert.equal(await s.call("startDue"), 1);
  const [{ lease }] = plain(s.started);
  assert.deepEqual(plain(s.started), [{ conversationId: "conversations:due", lease }]);
  assert.equal(s.row("conversations:due").extractDueAt, lease);
  // Claimed: the next tick does not start it again.
  assert.equal(await s.call("startDue"), 0);

  // A new message during the pass set a later due time: the pass keeps it, and moves the read mark.
  s.row("conversations:due").extractDueAt = lease + 1;
  await s.call("finish", { conversationId: "conversations:due", lease, readAt: 42 });
  assert.deepEqual([s.row("conversations:due").extractDueAt, s.row("conversations:due").extractedAt], [lease + 1, 42]);
  await s.call("finish", { conversationId: "conversations:due", lease: lease + 1, skipped: "no ChatGPT plan connected" });
  assert.deepEqual([s.row("conversations:due").extractDueAt, s.row("conversations:due").extractedAt, s.row("conversations:due").extractSkipped], [undefined, 42, "no ChatGPT plan connected"]);
});

test("a pass reads nothing when intake is off, the account is gone, or nothing is new", async () => {
  const read = async (o: Parameters<typeof setup>[0]) => plain(await setup(o).call("context", { conversationId: "conversations:due" }));
  assert.deepEqual(await read({ ingest: false }), { skip: "intake is off" });
  assert.deepEqual(await read({ status: "disconnected" }), { skip: "account is gone" });
  // The message was stored before the last pass read.
  assert.deepEqual(await read({ extractedAt: 1e12 }), { skip: "nothing new to read" });
});

test("a LinkedIn thread grounds titles by profile and suggests an unknown counterpart, never a record", () => {
  const day = Date.UTC(2026, 9, 20);
  const unknown = unknownCounterpart("linkedin", { name: "Grace Hopper", profileUrl: "https://www.linkedin.com/in/Grace-H/" })!;
  const known = personKey({ linkedinUrl: "linkedin.com/in/sam-lee" })!;
  const context: ConversationFactsContext = {
    source: { kind: "linkedin", id: "conversations:due" }, title: "Grace Hopper", day: "2026-10-20", summary: null,
    text: threadText([
      { at: day, from: "Ada", direction: "us", text: "Congrats on the new role!" },
      { at: day + 60_000, from: "Grace Hopper", direction: "them", text: "Thanks! I'm Head of RevOps at Acme now, and Sam just became our CFO." },
    ]),
    deal: null, people: [{ email: known, name: "Sam Lee", title: "VP Finance" }],
    newPeople: [{ email: unknown.key, name: unknown.name }], askOpportunity: true,
  };
  const raw = {
    titles: [
      { email: unknown.key, value: "Head of RevOps", evidence: "I'm Head of RevOps at Acme now" },
      { email: known, value: "CFO", evidence: "Sam just became our CFO." },
    ],
    opportunity: { name: "Acme RevOps", amountDollars: null, closeDate: null, nextStep: null, evidence: "We should talk budgets next quarter." },
  };
  assert.deepEqual(groundedFacts(raw, context).map((f) => [f.attribute, f.value, f.entityType === "contact" ? f.email : null]), [["title", "CFO", known]]);
  const planned = conversationSuggestions({
    conversationId: "conversations:due", channel: "linkedin", unknown, email: null, domainKnown: false, hasDeal: false,
    read: groundedSuggestionRead(raw, context),
  });
  // The opportunity is not quoted from the thread: no deal.
  assert.deepEqual(planned, [{
    kind: "contact", key: "linkedin:grace-h", evidence: "I'm Head of RevOps at Acme now",
    values: { name: "Grace Hopper", linkedinUrl: "https://www.linkedin.com/in/grace-h", title: "Head of RevOps" },
  }]);
});

test("an email counterpart not in the CRM suggests them and their company; a known one suggests nothing", () => {
  const read = { companyNames: { "acme.example": "Acme" }, titles: {}, opportunity: null };
  const unknown = unknownCounterpart("email", { name: "Sam Lee", email: "Sam@Acme.example" });
  const base = { conversationId: "conversations:e", channel: "email" as const, email: "sam@acme.example", domainKnown: false, hasDeal: true, read };
  assert.deepEqual(conversationSuggestions({ ...base, unknown }).map((s) => [s.kind, s.key]), [["account", "acme.example"], ["contact", "sam@acme.example"]]);
  assert.deepEqual(conversationSuggestions({ ...base, unknown: null, domainKnown: true }), []);
});

test("a counterpart found only at extraction is read with the open deal they are on, and matches the conversation from now on", async () => {
  const calls: Array<[string, Record<string, any>]> = [];
  let prompt = "";
  const grace = { id: "con_grace", accountId: "acc_acme", fullName: "Grace Hopper", linkedinUrl: "https://www.linkedin.com/in/grace-h", status: "active", updatedAt: 0 };
  const mod = loadConvex(["conversationExtractActions.ts"], {
    "lib/llmResolver.ts": (real) => ({ ...real, resolveLlm: async () => ({ provider: "openai", model: "m" }) }),
    "records.ts": (real) => ({
      ...real,
      principalClient: () => ({ getContact: async (_o: string, id: string) => (id === grace.id ? grace : null) }),
      clientFor: () => ({ listRegister: async () => ({ rows: [{ id: grace.id, values: { linkedinUrl: grace.linkedinUrl } }] }) }),
    }),
    "../engine/src/llm.ts": (real) => ({
      ...real,
      forcedToolCall: async (p: string) => {
        prompt = p;
        return { nextStep: { value: "Pilot review Friday", evidence: "put the pilot review on the calendar for Friday" }, closeDate: null, titles: [], opportunity: { name: "Acme pilot", amountDollars: null, closeDate: null, nextStep: null, evidence: "Let's put the pilot review" } };
      },
    }),
  })["conversationExtractActions.ts"]!;
  const context = {
    orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", owner: { name: "Ada", email: null }, access: null,
    counterpart: { name: "Grace Hopper", publicIdentifier: "grace-h" }, contactIds: [], title: "Grace Hopper", day: "2026-10-20",
    messages: [{ at: Date.UTC(2026, 9, 20), from: "Grace Hopper", direction: "them", text: "Let's put the pilot review on the calendar for Friday." }],
    readAt: 42, firstPass: true, deal: null, define: defaultModel("calls.model").define,
  };
  const ctx = {
    runQuery: async (ref: unknown, args: Record<string, any>) => {
      calls.push([String(ref), args]);
      return String(ref).endsWith(".context") ? context : { deal: { id: "deals:d", name: "Acme", stage: "discovery", nextStep: null, closeDate: null }, customer: false };
    },
    runMutation: async (ref: unknown, args: Record<string, any>) => (calls.push([String(ref), args]), { proposed: 1, patchPlanId: "patchPlans:p" }),
  };
  assert.deepEqual(plain(await mod.extract!.handler(ctx, { conversationId: "conversations:due", lease: 1 })), { proposed: 1, suggested: 0 });
  const of = (name: string) => calls.find(([ref]) => ref === `internal.${name}`)?.[1];
  assert.deepEqual(plain(of("conversationExtract.dealOf")), { conversationId: "conversations:due", contactIds: ["con_grace"], companies: [{ id: "acc_acme" }] });
  // The prompt asks for the deal's updates, not a new opportunity, and no deal is suggested.
  assert.match(prompt, /about the deal "Acme"/);
  assert.equal(of("callSuggestions.record"), undefined);
  assert.deepEqual(plain(of("callFacts.submitConversation")).facts.map((f: { attribute: string }) => f.attribute), ["nextStep"]);
  assert.equal(of("callFacts.submitConversation")!.dealId, "deals:d");
  assert.deepEqual(plain(of("conversationExtract.finish")), { conversationId: "conversations:due", lease: 1, readAt: 42, patchPlanId: "patchPlans:p", contactId: "con_grace" });

  // `finish` matches the conversation and brings its messages so far onto the contact's timeline, once.
  const s = setup();
  await s.call("finish", { conversationId: "conversations:due", lease: 0, readAt: 42, contactId: "con_grace" });
  await s.call("finish", { conversationId: "conversations:due", lease: 0, readAt: 43, contactId: "con_other" });
  assert.deepEqual(plain(s.row("conversations:due").contactIds), ["con_grace"]);
  assert.deepEqual(s.db.rows("observations").map((o) => (o.subject as { contactId: string }).contactId), ["con_grace"]);
});

test("adding a conversation's deal puts its counterpart and their company on it, as a meeting's people are", async () => {
  const access = accessOf({ userId: "u", role: "admin" });
  const mod = loadConvex(["callSuggestions.ts"], {
    "records.ts": (real) => ({
      ...real,
      requireCaller: async () => ({ orgId: "org", userId: "u", role: "admin", access }),
      clientFor: () => ({ mode: "fake", listRegister: async () => ({ rows: [] }) }),
      // The caller sees Grace and her company, not the hidden contact.
      callerClient: () => ({
        get: async (_o: string, id: string) => (id === "acc_acme" ? { id } : null),
        getContact: async (_o: string, id: string) => (id === "con_grace" ? { id, accountId: "acc_acme" } : null),
      }),
    }),
  })["callSuggestions.ts"]!;
  const deal = { _id: "s1", orgId: "org", userId: "u", conversationId: "conversations:c", kind: "deal", key: "conversation:conversations:c", status: "pending", values: { name: "Acme pilot" } };
  let finished: Record<string, any> | null = null;
  const ctx = {
    runQuery: async (ref: unknown) => String(ref) === "internal.callSuggestions.pendingOf" ? [deal]
      : String(ref) === "internal.callSuggestions.conversationContext" ? { contactIds: ["con_grace", "con_hidden"], day: "2026-10-20", defaultCloseDays: 30 } : null,
    runMutation: async (_ref: unknown, args: Record<string, any>) => ((finished = args), { dealStreamId: "stream_d" }),
  };
  await mod.create!.handler(ctx, { ids: ["s1"] });
  assert.deepEqual(plain(finished!.deal), { id: "s1", name: "Acme pilot", closeDate: "2026-11-19", companyId: "acc_acme", contactIds: ["con_grace"] });
});
