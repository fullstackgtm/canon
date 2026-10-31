import assert from "node:assert/strict";
import { test } from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { P4PreparedManifestEmail } from "../convex/lib/outbound/mailboxTypes.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const NOW = 1_800_000_000_000, DAY = 86_400_000, WEEK = 7 * DAY;
const ORG = "org" as Id<"organizations">, MAIL = "mail" as Id<"emailAccounts">, OUT = "out" as Id<"outboundMessages">;
let now = NOW;
const configuration = { env: {} as Record<string, string> };
const graph = loadConvex(["lib/outbound/mailboxCapacity.ts", "lib/outbound/mailboxGrants.ts", "emailAccounts.ts"], {}, {
  process: configuration, Date: class extends Date { static now() { return now; } },
});
const capacity = graph["lib/outbound/mailboxCapacity.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxCapacity.ts");
const grants = graph["lib/outbound/mailboxGrants.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxGrants.ts");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function world(maxPerDay = 100) {
  now = NOW; configuration.env = { TOKEN_ENCRYPTION_KEY: "capacity-fixture-only" };
  const ownerId = "owner" as Id<"users">, hash = "a".repeat(64);
  const prepared: P4PreparedManifestEmail = {
    version: 1, kind: "manifest.automated-email.v1", purpose: "automated_outreach", orgId: ORG, moduleId: "fixture", preparedBy: ownerId, preparedAt: NOW,
    recipient: { contactId: "con_person", streamId: "stream" as Id<"canonEntities">, address: "person@example.test" },
    sender: { id: MAIL, ownerId, name: "Owner", address: "owner@example.test", mailboxLinkHash: hash }, grantId: "grant" as Id<"mailboxSendGrants">,
    template: { kind: "manifest", name: "hello", hash }, companyStreamId: null, canonicalMergeHash: hash, postalAddress: "123 Main St", unsubscribe: { token: "frozen", url: "https://fixture.test" },
    delivery: { subject: "Hello", text: "Frozen text", html: "<p>Frozen text</p>", headers: { listUnsubscribe: "<https://fixture.test>", listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [] } },
    renderedHash: hash, bindingHash: hash, requestedNotBefore: NOW, validUntil: NOW + DAY, thread: null,
  };
  const message = (id: string, at?: number, change: { module?: string; address?: string; sender?: string; grant?: string; state?: string; org?: string } = {}) => {
    const p = plain(prepared);
    if (change.module) p.moduleId = change.module;
    if (change.address) p.recipient.address = change.address;
    if (change.sender) p.sender.id = change.sender as Id<"emailAccounts">;
    if (change.grant) p.grantId = change.grant as Id<"mailboxSendGrants">;
    if (change.org) p.orgId = change.org as Id<"organizations">;
    return { _id: id, orgId: p.orgId, module: p.moduleId, fromUserId: ownerId, cause: "fixture", channel: "email", kind: "automated", to: { address: p.recipient.address },
      target: `address:${p.recipient.address}`, rendered: { subject: p.delivery.subject, text: p.delivery.text }, mailbox: { kind: "manifest.automated-email.v1", prepared: p },
      state: change.state ?? "sent", ...(at === undefined ? {} : { claimedAt: at }), notBefore: NOW, idempotencyKey: id, at: NOW };
  };
  const db = memoryDb({
    organizations: [{ _id: ORG, clerkOrgId: "clerk-org" }], users: [{ _id: ownerId, orgId: ORG, clerkUserId: "session:owner", role: "rep", isActive: true }],
    orgMemberships: [{ _id: "membership", orgId: ORG, userId: ownerId, role: "rep", isActive: true }],
    emailAccounts: [{ _id: MAIL, orgId: ORG, userId: ownerId, address: "owner@example.test", provider: "google", unipileAccountId: "private-link", status: "ok", connectedAt: NOW - DAY }],
    mailboxSendGrants: [{ _id: prepared.grantId, version: 1, orgId: ORG, moduleId: prepared.moduleId, ownerId, senderId: MAIL, mailboxLinkHash: hash,
      template: prepared.template, maxPerDay, createdAt: NOW - DAY, expiresAt: NOW + DAY, signature: "" }],
    outboundMessages: [message(OUT, undefined, { state: "queued" })],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner", tokenIdentifier: "session:owner", issuer: "https://clerk.test", org_id: "clerk-org" }) } };
  const sign = async (max = maxPerDay) => {
    await db.patch(prepared.grantId, { maxPerDay: max });
    const row = (await db.get(prepared.grantId))!;
    await db.patch(prepared.grantId, { signature: await grants.signMailboxGrant(grants.mailboxGrantTerms(row as never), (await grants.mailboxGrantKey())!) });
  };
  await sign();
  const email = (id: string, state: string, at = NOW - 1000) => db.insert("emailSends", { _id: id, orgId: ORG, accountId: MAIL, userId: ownerId,
    contactId: "con_other", to: "other@example.test", subject: "Legacy", state, at });
  return { db, ctx, prepared, message, email, sign,
    read: () => capacity.readMailboxDailyCapacity(ctx as never, MAIL, now), assess: () => capacity.assessP4MailboxCapacity(ctx as never, OUT),
    mine: () => graph["emailAccounts.ts"].mine.handler(ctx, {}),
    direct: () => graph["emailAccounts.ts"].claimSend.handler(ctx, { userId: ownerId, orgId: ORG, accountId: MAIL, contactId: "con_direct", to: "direct@example.test", subject: "Direct" }) };
}
function held(value: Awaited<ReturnType<typeof capacity.assessP4MailboxCapacity>>, code: string, at: number) {
  assert.equal(value.state, "held");
  if (value.state !== "held") throw new Error("Expected capacity hold");
  assert.equal(value.code, code); assert.equal(value.notBefore, at);
  return value.counts;
}

test("direct claims and P4 share the same last mailbox slot in either ordering", async () => {
  const h = await world();
  for (let i = 0; i < 99; i++) await h.email(`legacy-${i}`, "sent");
  const before = h.db.checkpoint();
  assert.equal((await h.assess()).state, "available");
  assert.deepEqual(h.db.checkpoint(), before);
  await h.direct();
  assert.equal((await h.mine()).accounts[0].sentLastDay, 100);
  held(await h.assess(), "outbound.capacity.mailbox", NOW - 1000 + DAY + 1);
  await assert.rejects(h.direct());
  h.db.rollback(before);
  await h.email("p4-attempt", "sending", NOW);
  await h.db.patch("p4-attempt", { outboxAttempt: { kind: "manifest.automated-email.v1", outboundMessageId: OUT, moduleId: "fixture", attempt: 1, renderedHash: h.prepared.renderedHash }, receiptRevision: 0 });
  await assert.rejects(h.direct());
  held(await h.assess(), "outbound.capacity.mailbox", NOW - 1000 + DAY + 1);
});

test("legacy known failures are excluded while sending, sent and unknown reserve mailbox capacity", async () => {
  const h = await world();
  for (const state of ["sending", "sent", "unknown", "failed"]) await h.email(state, state);
  assert.equal((await h.read()).count, 3);
  assert.equal((await h.mine()).accounts[0].sentLastDay, 3);
  assert.equal((await h.assess()).state, "available");
});

test("recipient capacity follows the shared normalized address across modules and mailboxes", async () => {
  const h = await world();
  for (let i = 0; i < 3; i++) await h.db.insert("outboundMessages", h.message(`other-${i}`, NOW - DAY + i, { module: `other-${i}`, sender: `mail-${i}`, grant: `grant-${i}`, state: ["sent", "failed", "unknown"][i] }));
  for (const kind of ["notice", "personal"]) await h.db.insert("outboundMessages", { ...h.message(kind, NOW), kind });
  await h.db.insert("outboundMessages", h.message("foreign", NOW, { org: "foreign" }));
  const before = h.db.checkpoint();
  assert.equal(held(await h.assess(), "outbound.capacity.recipient", NOW - DAY + WEEK + 1).recipient, 3);
  assert.deepEqual(h.db.checkpoint(), before);
  await h.db.delete("other-0");
  const result = await h.assess();
  assert.equal(result.state, "available");
  if (result.state === "available") assert.equal(result.counts.recipient, 2);
});

test("a lower signed grant cap retains failed claims and never excludes this row's previous claim", async () => {
  const h = await world(2);
  await h.db.insert("outboundMessages", h.message("first", NOW - 2000, { address: "first@example.test", state: "failed" }));
  await h.db.insert("outboundMessages", h.message("second", NOW - 1000, { address: "second@example.test", state: "unknown" }));
  await h.db.insert("outboundMessages", h.message("other-grant", NOW, { address: "third@example.test", grant: "other-grant" }));
  assert.equal(held(await h.assess(), "outbound.capacity.grant", NOW - 2000 + DAY + 1).grant, 2);
  await h.db.patch("grant", { maxPerDay: 100 });
  assert.equal((await h.assess()).state, "refused");
  await h.sign(2);
  await h.db.patch(OUT, { claimedAt: NOW, state: "failed" });
  assert.equal(held(await h.assess(), "outbound.capacity.grant", NOW - 1000 + DAY + 1).grant, 3);
});

test("recipient policy defaults to three and rereads valid restored caps within one through three", async () => {
  const h = await world();
  await h.db.insert("outboundMessages", h.message("one", NOW - 2000));
  await h.db.insert("outboundMessages", h.message("two", NOW - 1000));
  assert.equal((await h.assess()).state, "available");
  for (const cap of [1, 2, 3]) {
    await h.db.patch(ORG, { outboundEmailPolicy: { postalAddress: "123 Main St", recipientWeeklyCap: cap, updatedAt: NOW, updatedBy: "owner" } });
    const value = await h.assess();
    if (cap === 3) assert.equal(value.state, "available");
    else held(value, "outbound.capacity.recipient", NOW - (cap === 1 ? 1000 : 2000) + WEEK + 1);
  }
  for (const cap of [0, 4, 1.5, NaN]) {
    await h.db.patch(ORG, { outboundEmailPolicy: { recipientWeeklyCap: cap } });
    assert.equal((await h.assess()).state, "refused");
  }
});

test("module capacity counts all claimed channels and releases exactly when enough inclusive window rows expire", async () => {
  const h = await world();
  for (let i = 0; i < 501; i++) await h.db.insert("outboundMessages", { ...h.message(`claim-${i}`, NOW - DAY + 1000 + i), channel: i % 2 ? "slack" : "webhook", mailbox: undefined });
  const deadline = NOW + 1002;
  assert.equal(held(await h.assess(), "outbound.capacity.module", deadline).module, 501);
  now = deadline - 1;
  held(await h.assess(), "outbound.capacity.module", deadline);
  now = deadline;
  assert.equal((await h.assess()).state, "available");
  for (let i = 0; i < 101; i++) await h.email(`mailbox-${i}`, "sent", NOW - 5000 + i);
  assert.equal((await h.read()).notBefore, NOW - 4999 + DAY + 1);
  now = NOW - 4999 + DAY + 1;
  assert.equal((await h.read()).count, 99);
});

test("exhausted scan budgets hold through the entire uncertain window and combine deadlines by maximum", async () => {
  const h = await world();
  for (let i = 0; i < 1000; i++) await h.email(`failed-${i}`, "failed");
  assert.equal((await h.read()).count, 100);
  assert.equal((await h.read()).scanExhausted, true);
  await assert.rejects(h.direct());
  held(await h.assess(), "outbound.capacity.scan_exhausted", NOW + DAY + 1);
  for (let i = 0; i < 1000; i++) await h.db.insert("outboundMessages", { ...h.message(`notice-${i}`, NOW - 1000), kind: "notice", mailbox: undefined });
  const before = h.db.checkpoint();
  held(await h.assess(), "outbound.capacity.scan_exhausted", NOW + WEEK + 1);
  assert.deepEqual(h.db.checkpoint(), before);
});

test("malformed bindings, unsigned caps and unsafe clocks refuse without writes", async () => {
  const h = await world(), baseline = h.db.checkpoint();
  for (const change of [
    () => h.db.patch(OUT, { target: "address:other@example.test" }),
    () => h.db.patch(OUT, { module: "other-module" }),
    () => h.db.patch(MAIL, { orgId: "foreign" }),
    () => h.db.patch("grant", { maxPerDay: 0 }),
    () => h.db.patch("grant", { maxPerDay: 101 }),
    () => h.db.patch("grant", { signature: "b".repeat(64) }),
    () => h.db.patch(OUT, { mailbox: { kind: "sq1.email.v1", prepared: h.prepared } }),
    () => h.db.insert("outboundMessages", h.message("wrong-sender", NOW, { sender: "another-mailbox", address: "other@example.test" })),
    () => h.db.patch(OUT, { claimedAt: NOW + 1 }),
  ]) {
    h.db.rollback(baseline); await change();
    const before = h.db.checkpoint();
    assert.equal((await h.assess()).state, "refused");
    assert.deepEqual(h.db.checkpoint(), before);
  }
  h.db.rollback(baseline); delete configuration.env.TOKEN_ENCRYPTION_KEY;
  assert.equal((await h.assess()).state, "refused");
  now = NaN;
  assert.equal((await h.assess()).state, "refused");
  assert.equal((await h.read()).count, 100);
});
