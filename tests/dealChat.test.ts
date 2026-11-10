import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf } from "../convex/lib/access.ts";
import { verifiedState } from "../convex/lib/plays/state.ts";

const owner = { _id: "users:owner", orgId: "organizations:o", name: "Owner", role: "rep", isActive: true };
const member = { ...owner, _id: "users:member", name: "Member" };
const modules = loadConvex(["dealChats.ts"], {
  "lib.ts": (real) => ({ ...real, requireUser: async (ctx: { user: unknown }) => ctx.user }),
  "permissions.ts": (real) => ({ ...real, accessFor: async (ctx: { access: unknown }) => ctx.access }),
});
const chats = modules["dealChats.ts"];
const state = verifiedState({ summary: "Private renewal state.", stage: { label: "Proposal", reason: "Private terms." }, qualification: [], concerns: [] }, { name: "Test", lines: [] }, [], { read: 0, total: 0, omitted: 0, partial: false, inventoryLimited: false }, "Proposal", 100);

function fixture() {
  const db = memoryDb({
    users: [owner, member],
    canonEntities: [{ _id: "canonEntities:deal", orgId: owner.orgId, projectionTable: "deals", projectionId: "deals:d" }],
    deals: [{ _id: "deals:d", orgId: owner.orgId, primaryRepId: owner._id }],
  });
  const ctx = { db, user: owner, access: accessOf({ userId: owner._id, role: "rep" }) };
  const readAs = (user = member, rules?: Parameters<typeof accessOf>[0]["rules"]) => ({ ...ctx, user, access: accessOf({ userId: user._id, role: "rep", rules }) });
  return { db, ctx, readAs };
}

test("all retained-history surfaces hide a shared chat once deal visibility or read access is lost", async () => {
  const { db, ctx, readAs } = fixture();
  assert.deepEqual(Object.keys(chats).sort(), ["begin", "create", "finish", "get", "list", "remove", "share"]);
  const chatId = await chats.create.handler(ctx, { streamId: "canonEntities:deal", title: "Renewal" });
  await chats.share.handler(ctx, { chatId, userIds: [member._id] });
  await chats.begin.handler(ctx, { chatId, turnId: "first" });
  await chats.finish.handler(ctx, { chatId, turnId: "first", reply: { question: "Draft that", answer: "Private draft", sources: [] } });
  assert.equal((await chats.list.handler(readAs(), { streamId: "canonEntities:deal" })).shared.length, 1);
  assert.equal((await chats.get.handler(readAs(), { chatId })).messages.length, 2);
  const restricted = readAs(member, [{ object: "deal", visibility: "own", unowned: false }]);
  assert.equal((await chats.list.handler(restricted, { streamId: "canonEntities:deal" })).shared.length, 0);
  assert.equal(await chats.get.handler(restricted, { chatId }), null);
  const deniedOwner = readAs(owner, [{ object: "deal", read: false }]);
  for (const [surface, args] of [
    ["get", { chatId }], ["begin", { chatId, turnId: "denied" }],
    ["finish", { chatId, turnId: "first", reply: { question: "q", answer: "a", sources: [] } }],
    ["share", { chatId, userIds: [] }],
  ] as const) {
    if (surface === "get") assert.equal(await chats[surface].handler(deniedOwner, args), null);
    else await assert.rejects(chats[surface].handler(deniedOwner, args));
  }
  const narrowed = readAs(member, [{ object: "contact", fields: [{ apiName: "email", level: "hidden" }] }]);
  assert.equal(await chats.get.handler(narrowed, { chatId }), null);
  await assert.rejects(chats.begin.handler(readAs(), { chatId, turnId: "shared-write" }));
  await chats.share.handler(ctx, { chatId, userIds: [] });
  assert.equal(await chats.get.handler(readAs(), { chatId }), null);
  await db.patch("deals:d", { archivedAt: 1 });
  assert.equal(await chats.get.handler(ctx, { chatId }), null);
});

test("deleting a chat removes every message and prevents an in-flight turn from recreating it", async () => {
  const { db, ctx, readAs } = fixture();
  const chatId = await chats.create.handler(ctx, { streamId: "canonEntities:deal", title: "Draft" });
  await chats.begin.handler(ctx, { chatId, turnId: "one" });
  await chats.finish.handler(ctx, { chatId, turnId: "one", reply: { question: "Draft that for me", answer: "Hello buyer", sources: [] } });
  await chats.begin.handler(ctx, { chatId, turnId: "two" });
  await assert.rejects(chats.begin.handler(ctx, { chatId, turnId: "three" }));
  await assert.rejects(chats.remove.handler(readAs(), { chatId }));
  await chats.remove.handler(ctx, { chatId });
  assert.equal(await db.get(chatId), null);
  assert.equal(db.rows("dealChatMessages").length, 0);
  await assert.rejects(chats.finish.handler(ctx, { chatId, turnId: "two", reply: { question: "Again", answer: "Hello", sources: [] } }));
  assert.equal(db.rows("dealChatMessages").length, 0);
});

test("restricted deal chat context omits deal state and seeded records still pass Ask Canon's citation and size checks", async () => {
  const { dealChatContext } = await import("../convex/lib/ask/dealContext.ts");
  const { ask, MAX_PROMPT_CHARS } = await import("../convex/lib/ask/askLoop.ts");
  const plane = { streamId: "canonEntities:deal", deal: { name: "Renewal", stage: null, amount: null, currency: null, closeDate: null, probability: null, companyId: null, companyName: null, domain: null, ownerName: null, isClosed: false }, brief: { context: "Buyer renewal", whyNow: null, alphaHypothesis: null, alphaPitch: null, briefBy: null, windowLabel: null, windowClosesOn: null }, state, stateHidden: true, people: [], touches: [] };
  const context = dealChatContext(plane);
  let prompt = "";
  const result = await ask({ tools: [], context, call: async (p) => { prompt = p; return { action: "answer", answer: "A draft for [Renewal](/dashboard/records/deal/canonEntities%3Adeal), [secret](/dashboard/records/deal/other)", citations: [{ object: "deal", id: "canonEntities:deal" }] }; } }, [], "Draft that for me");
  assert.ok(!prompt.includes("Private renewal state"));
  assert.ok(prompt.includes('"state":null') && prompt.includes('"stateHidden":true'));
  assert.ok(prompt.includes("Buyer renewal"));
  assert.ok(prompt.length <= MAX_PROMPT_CHARS);
  assert.equal(result.sources.length, 1);
  assert.ok(!result.answer.includes("/deal/other"));
});
