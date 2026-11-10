import assert from "node:assert/strict";
import { test } from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import type { P4EmailAttemptRef, P4PreparedEmail } from "../convex/lib/outbound/mailboxTypes.ts";
import type { P4VerifiedHistoricalSettlement } from "../convex/lib/outbound/mailboxReceipts.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const graph = loadConvex(["lib/outbound/mailboxReceipts.ts", "emailAccounts.ts"]);
const receipts = graph["lib/outbound/mailboxReceipts.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxReceipts.ts");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const H = "a".repeat(64);
async function world() {
  const prepared: P4PreparedEmail = {
    version: 1, orgId: "org" as Id<"organizations">, moduleId: "test-sequence", preparedBy: "preparer" as Id<"users">,
    recipient: { contactId: "con_person", streamId: "stream" as Id<"canonEntities">, address: "person@example.test" }, companyStreamId: null,
    canonicalMergeHash: H, sender: { id: "mail" as Id<"emailAccounts">, ownerId: "owner" as Id<"users">, address: "owner@example.test", mailboxLinkHash: H }, grantId: "grant" as Id<"mailboxSendGrants">,
    template: { authority: { kind: "sq1.template-set.v1", launchId: "launch" as Id<"sequenceLaunches">, hash: H }, selectedHash: H,
      selection: { stepKey: "hello", ordinal: 0, variant: "a" } },
    delivery: { subject: "Hello", text: "Exact frozen body and footer", html: "<p>Exact frozen body and footer</p>", headers: {
      listUnsubscribe: "<https://fixture.test/outbound/unsubscribe?token=frozen>", listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [],
    } }, renderedHash: "", requestedNotBefore: 100, validUntil: 200, thread: null,
  };
  prepared.renderedHash = await receipts.hashP4RenderedEmail(prepared.delivery);

  const db = memoryDb({
    outboundMessages: [{ _id: "out", orgId: "org", module: prepared.moduleId, cause: "sq1.email.v1", channel: "email", kind: "automated",
      fromUserId: "preparer", to: { address: prepared.recipient.address }, target: "address:person@example.test", rendered: { subject: prepared.delivery.subject, text: prepared.delivery.text },
      state: "sending", attempts: 1, notBefore: 100, idempotencyKey: "fixture", at: 100 }],
    emailSends: [{ _id: "send", orgId: "org", accountId: "mail", userId: "owner", contactId: "con_person", to: prepared.recipient.address,
      subject: prepared.delivery.subject, state: "sending", receiptRevision: 0, at: 100 }],
    outboxRequests: [{ _id: "request", orgId: "org", moduleId: prepared.moduleId, launchId: "launch", enrollmentId: "enrollment",
      stepKey: "hello", ordinal: 0, occurrence: 0, authorizationEpoch: 1, revision: 3, requestedNotBefore: 100, state: "reserved", reservedAt: 100, outboundMessageId: "out" }],
  });
  const requestRow = await db.get("request");
  const digest = await receipts.hashP4Sq1EmailBinding(requestRow as never, prepared);
  const request = { kind: "sq1.email.v1" as const, requestId: "request", epoch: 1, digest };
  await db.patch("request", { frozen: { digest, contactId: "con_person", contactStreamId: "stream", normalizedAddress: prepared.recipient.address,
    senderId: "mail", ownerId: "owner", mailboxLinkHash: H, grantId: "grant", templateSetHash: H, variant: "a", selectedTemplateHash: H,
    canonicalMergeHash: H, renderedHash: prepared.renderedHash, validUntil: 200, thread: null } });
  await db.patch("out", { mailbox: { kind: "sq1.email.v1", request, prepared, attempt: { emailSendId: "send", attempt: 1, receiptRevision: 0 } } });
  const attempt = { kind: "sq1.email.v1", request, outboundMessageId: "out", moduleId: prepared.moduleId, attempt: 1, renderedHash: prepared.renderedHash };
  await db.patch("send", { outboxAttempt: attempt });
  const expected = { ...attempt, orgId: "org", emailSendId: "send", receiptRevision: 0 } as Extract<P4EmailAttemptRef, { kind: "sq1.email.v1" }>;
  const ctx = { db };
  const record = (result: Parameters<typeof receipts.recordP4EmailResult>[2], input: P4EmailAttemptRef = expected) => receipts.recordP4EmailResult(ctx as never, input, result);
  const verify = () => receipts.verifyP4HistoricalSettlement(ctx as never, expected);
  const read = (evidence: P4VerifiedHistoricalSettlement) => receipts.readVerifiedP4HistoricalSettlement(ctx as never, evidence);
  return { db, ctx, expected, prepared, record, verify, read };
}
function evidence(value: Awaited<ReturnType<typeof receipts.recordP4EmailResult>>) {
  assert.equal(value.state, "recorded");
  if (value.state !== "recorded" || !value.settlement) throw new Error("Expected actual historical receipt");
  return value.settlement;
}

test("legacy direct Gmail result handling retains rows without mailbox metadata", async () => {
  const db = memoryDb({ emailSends: [{ _id: "direct", orgId: "org", accountId: "mail", userId: "owner", contactId: "con_person",
    to: "person@example.test", subject: "Direct", state: "sending", at: 100 }] });
  const ctx = { db };
  await graph["emailAccounts.ts"].finishSend.handler(ctx, { sendId: "direct", ok: false, error: "Legacy failure", body: "Direct body" });
  assert.equal((await db.get("direct"))?.state, "failed");
  assert.equal(await receipts.verifyP4HistoricalSettlement(ctx as never, { outboundMessageId: "absent", emailSendId: "direct" } as never), null);
  assert.equal((await db.get("direct"))?.outboxAttempt, undefined);
});

test("real same-pair result writes both revisions and reloads only its durable outcome", async () => {
  const h = await world();
  assert.equal(await h.verify(), null);
  const proof = evidence(await h.record({ state: "sent", providerId: "actual-provider-result" }));
  assert.equal((await h.db.get("send"))?.receiptRevision, 1);
  const row = (await h.db.get("out"))!;
  assert.equal(row.state, "sent");
  assert.equal((row.mailbox as { attempt: { receiptRevision: number } }).attempt.receiptRevision, 1);
  assert.deepEqual(plain((await h.read(proof))?.outcome), { state: "sent", providerId: "actual-provider-result" });
  const reloaded = await h.verify();
  assert.ok(reloaded);
  assert.deepEqual(plain(reloaded), plain(proof));
  const checkpoint = h.db.checkpoint();
  assert.equal((await h.record({ state: "sent", providerId: "actual-provider-result" })).state, "duplicate");
  assert.equal((await h.record({ state: "failed", error: "Late conflicting failure" })).state, "refused");
  assert.deepEqual(h.db.checkpoint(), checkpoint);
});

test("stale attempt, request, render and tenant bindings refuse before writes", async () => {
  const h = await world(), baseline = h.db.checkpoint();
  for (const change of [
    { attempt: 2 }, { receiptRevision: 1 }, { orgId: "foreign" }, { moduleId: "other-module" }, { renderedHash: "changed" },
    { request: { ...h.expected.request, epoch: 2 } }, { request: { ...h.expected.request, requestId: "other-request" } },
    { request: { ...h.expected.request, digest: "forged" } },
  ]) {
    assert.equal((await h.record({ state: "sent", providerId: "result" }, { ...h.expected, ...change } as P4EmailAttemptRef)).state, "refused");
    assert.deepEqual(h.db.checkpoint(), baseline);
  }
  for (const change of [
    { orgId: "foreign" }, { module: "other-module" }, { attempts: 2 }, { rendered: { subject: "Altered", text: h.prepared.delivery.text } },
  ]) {
    h.db.rollback(baseline);
    await h.db.patch("out", change);
    const before = h.db.checkpoint();
    assert.equal((await h.record({ state: "sent", providerId: "result" })).state, "refused");
    assert.deepEqual(h.db.checkpoint(), before);
  }
  h.db.rollback(baseline);
  await h.db.patch("request", { outboundMessageId: "another-pair" });
  const before = h.db.checkpoint();
  assert.equal((await h.record({ state: "sent", providerId: "result" })).state, "refused");
  assert.deepEqual(h.db.checkpoint(), before);
});

test("a mutated frozen delivery cannot reuse its historical rendered hash", async () => {
  const h = await world();
  const row = (await h.db.get("out"))!;
  const mailbox = plain(row.mailbox) as { prepared: P4PreparedEmail };
  mailbox.prepared.delivery.html = "<p>Changed content</p>";
  await h.db.patch("out", { mailbox });
  const before = h.db.checkpoint();
  assert.equal((await h.record({ state: "sent", providerId: "result" })).state, "refused");
  assert.deepEqual(h.db.checkpoint(), before);
});

test("unknown is durable and never reopened by later success", async () => {
  const h = await world(), proof = evidence(await h.record({ state: "unknown", error: "Lease expired" }));
  const before = h.db.checkpoint();
  assert.equal((await h.record({ state: "sent", providerId: "late-success" })).state, "refused");
  assert.equal((await h.record({ state: "unknown", error: "Lease expired" })).state, "duplicate");
  assert.equal((await h.read(proof))?.outcome.state, "unknown");
  assert.deepEqual(h.db.checkpoint(), before);
});

test("historical evidence survives uninstall and absent live user, grant and projection", async () => {

  const h = await world(), proof = evidence(await h.record({ state: "failed", error: "Provider rejected" }));
  await h.db.patch("request", { state: "failed", result: { emailSendId: "send", attempt: 1, receiptRevision: 1, recordedAt: 300 } });
  assert.deepEqual(plain((await h.read(proof))?.outcome), { state: "failed", error: "Provider rejected" });
});

test("serialized, forged, other-context and superseded evidence cannot pass the fixed reader", async () => {
  const h = await world(), proof = evidence(await h.record({ state: "sent", providerId: "result" }));
  assert.equal(await h.read(plain(proof)), null);
  assert.equal(await h.read({ ...proof, receiptRevision: 2 }), null);
  assert.equal(await receipts.readVerifiedP4HistoricalSettlement({ db: h.db } as never, proof), null);
  await h.db.patch("send", { receiptRevision: 2 });
  assert.equal(await h.read(proof), null);
});

test("a storage exception escapes so the owning Convex transaction rolls back both writes", async () => {
  const h = await world(), before = h.db.checkpoint(), patch = h.db.patch;
  const broken = { db: { ...h.db, patch: async (id: string, value: Record<string, unknown>) => {
    if (id === "out") throw new Error("storage unavailable");
    await patch(id, value);
  } } };

  await assert.rejects(async () => {
    try { await receipts.recordP4EmailResult(broken as never, h.expected, { state: "sent", providerId: "result" }); }
    catch (error) { h.db.rollback(before); throw error; }
  }, /storage unavailable/);
  assert.deepEqual(h.db.checkpoint(), before);
  assert.equal(await h.verify(), null);
});
