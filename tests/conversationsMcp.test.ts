import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { canonTools } from "../src/app/mcp/_canonTools.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const state = { user: { _id: "users:owner", orgId: "organizations:o", role: "rep" }, access: accessOf({ userId: "users:owner", role: "rep" }) as Access };
const M = loadConvex(["conversationsApi.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => state.user, requireUser: async () => state.user }),
  "permissions.ts": (real) => ({ ...real, accessFor: async () => state.access }),
  "records.ts": (real) => ({ ...real, callerClient: () => ({}) }),
})["conversationsApi.ts"];

type Rows = Record<string, Array<Record<string, unknown>>>;
function setup(extra: Rows = {}) {
  const base: Rows = {
    linkedinAccounts: [{ _id: "linkedinAccounts:a", orgId: "organizations:o", userId: "users:owner", status: "ok", ingest: true }],
    conversations: [
      { _id: "conversations:grace", orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", accountRef: "linkedinAccounts:a", externalThreadId: "chat-1", counterpart: { name: "Grace" }, contactIds: ["contact-grace"], lastMessageAt: 2, extractedAt: 3 },
      { _id: "conversations:stranger", orgId: "organizations:o", ownerUserId: "users:owner", channel: "linkedin", accountRef: "linkedinAccounts:a", externalThreadId: "chat-2", counterpart: { name: "Stranger" }, contactIds: [], lastMessageAt: 1 },
    ],
    conversationMessages: [
      { _id: "conversationMessages:1", orgId: "organizations:o", conversationId: "conversations:grace", externalMessageId: "m1", direction: "in", at: 1, from: "grace", text: "text of m1" },
      { _id: "conversationMessages:2", orgId: "organizations:o", conversationId: "conversations:grace", externalMessageId: "m2", direction: "out", at: 2, from: "me", text: "text of m2" },
      { _id: "conversationMessages:3", orgId: "organizations:o", conversationId: "conversations:stranger", externalMessageId: "m3", direction: "in", at: 1, from: "x", text: "text of m3" },
    ],
    conversationContacts: [{ _id: "conversationContacts:grace", orgId: "organizations:o", contactId: "contact-grace", conversationId: "conversations:grace" }],
  };
  for (const [table, rows] of Object.entries(extra)) base[table] = [...(base[table] ?? []), ...rows];
  const db = memoryDb(base);
  const queryCtx = { db, auth: { getUserIdentity: async () => null } };
  const actionCtx = {
    runQuery: async (ref: unknown, args: Record<string, unknown>) => {
      if (String(ref) === "internal.records.callerContext") return { orgId: state.user.orgId, userId: state.user._id, access: state.access };
      return M[String(ref).split(".").pop()!].handler(queryCtx, args);
    },
  };
  // The MCP tool's Convex client: each public function runs its handler, an action with an action's context.
  const answer = async (ref: unknown, args: Record<string, unknown>) => {
    const fn = getFunctionName(ref as never).split(":")[1];
    return M[fn].handler(fn === "list" || fn === "thread" ? actionCtx : queryCtx, args);
  };
  const tool = canonTools.find((t) => t.name === "canon_conversations")!;
  // Results come from the loaded modules' realm: compare them as plain values.
  const run = async (action: string, args: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(await tool.run({ query: answer, mutation: answer, action: answer } as never, { action, args }) ?? null));
  return { db, run };
}

const as = (userId: string, rules?: Parameters<typeof accessOf>[0]["rules"]) => {
  state.user = { _id: userId, orgId: "organizations:o", role: "rep" };
  state.access = accessOf({ userId, role: "rep", rules });
};
const texts = (value: unknown) => JSON.stringify(value).match(/text of m\d/g) ?? [];

test("canon_conversations shows what the app shows: own threads, teammates' through a seen contact, text only where readable", async () => {
  const s = setup();

  as("users:owner");
  const own = await s.run("list");
  assert.deepEqual(own.conversations.map((c: { conversationId: string }) => c.conversationId), ["conversations:grace", "conversations:stranger"]);
  assert.equal(own.conversations[0].lastMessage.text, "text of m2");
  assert.equal(own.conversations[0].extraction.status, "read");
  assert.deepEqual(texts((await s.run("thread", { conversationId: "conversations:grace" })).messages), ["text of m1", "text of m2"]);

  // A teammate whose role reads the owner's activity: nothing of their own, the contact's thread with its text, and
  // never the thread matched to no one.
  as("users:mate");
  assert.deepEqual((await s.run("list")).conversations, []);
  const viaContact = await s.run("list", { contactIds: ["contact-grace"] });
  assert.deepEqual(viaContact.conversations.map((c: { conversationId: string }) => c.conversationId), ["conversations:grace"]);
  assert.deepEqual(texts((await s.run("thread", { conversationId: "conversations:grace" })).messages), ["text of m1", "text of m2"]);
  await assert.rejects(s.run("thread", { conversationId: "conversations:stranger" }), /not found/);

  // A teammate whose role reads only their own activity: that the conversation happened, never its text.
  as("users:mate", [{ object: "note", visibility: "own" }]);
  const hidden = await s.run("thread", { conversationId: "conversations:grace" });
  assert.deepEqual([hidden.messages.length, texts(hidden).length, hidden.messages[0].hidden], [2, 0, true]);
  assert.equal(texts(await s.run("list", { contactIds: ["contact-grace"] })).length, 0);

  // Stopping intake is the account owner's alone, and is logged.
  await assert.rejects(s.run("stop_intake", { accountId: "linkedinAccounts:a" }), /not found/);
  as("users:owner");
  await s.run("stop_intake", { accountId: "linkedinAccounts:a" });
  assert.equal(s.db.rows("linkedinAccounts")[0].ingest, false);
  assert.equal(s.db.rows("operationAuditLog")[0].operation, "conversation_intake.stop");
});

test("canon_conversations covers Gmail intake and shows a message's text from the caller's own inbox copy", async () => {
  const s = setup({
    emailAccounts: [
      { _id: "emailAccounts:owner", orgId: "organizations:o", userId: "users:owner", address: "owner@team.com", status: "ok", ingest: true },
      { _id: "emailAccounts:cc", orgId: "organizations:o", userId: "users:cc", address: "cc@team.com", status: "ok", ingest: true },
    ],
    conversations: [{ _id: "conversations:cc", orgId: "organizations:o", ownerUserId: "users:cc", channel: "email", accountRef: "emailAccounts:cc", externalThreadId: "t-1", counterpart: { name: "Grace" }, contactIds: ["contact-grace"], lastMessageAt: 1 }],
    conversationContacts: [{ _id: "conversationContacts:cc", orgId: "organizations:o", contactId: "contact-grace", conversationId: "conversations:cc" }],
    conversationMessages: [{ _id: "conversationMessages:4", orgId: "organizations:o", conversationId: "conversations:cc", externalMessageId: "m1", direction: "in", at: 1, from: "grace", text: "text of m1" }],
  });

  // Someone whose role reads only their own activity, who received m1 too: its text from their copy, never m2's.
  as("users:cc", [{ object: "note", visibility: "own" }]);
  const thread = await s.run("thread", { conversationId: "conversations:grace" });
  assert.deepEqual(texts(thread.messages), ["text of m1"]);
  assert.deepEqual([thread.messages[1].hidden, thread.messages[1].ownerUserId], [true, "users:owner"]);
  const viaContact = await s.run("list", { contactIds: ["contact-grace"] });
  assert.deepEqual(viaContact.conversations.map((c: { conversationId: string }) => c.conversationId).sort(), ["conversations:cc", "conversations:grace"]);

  as("users:owner");
  const status = await s.run("intake_status");
  assert.deepEqual(status.accounts.map((a: { accountId: string; channel: string; on: boolean; hasRead: boolean }) => [a.accountId, a.channel, a.on, a.hasRead]), [
    ["linkedinAccounts:a", "linkedin", true, true],
    ["emailAccounts:owner", "email", true, false],
  ]);
  // A Gmail account is stopped like a LinkedIn one, and only by its owner.
  await assert.rejects(s.run("stop_intake", { accountId: "emailAccounts:cc" }), /not found/);
  await s.run("stop_intake", { accountId: "emailAccounts:owner" });
  assert.deepEqual(s.db.rows("emailAccounts").map((r) => r.ingest), [false, true]);
  assert.equal((s.db.rows("operationAuditLog")[0].details as { channel: string }).channel, "email");
});
