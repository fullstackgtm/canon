import assert from "node:assert/strict";
import { test } from "node:test";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { P4PreparedEmail, RequestAuthorizationRef, P4EmailAttemptRef } from "../convex/lib/outbound/mailboxTypes";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { canonicalJson } from "../modules/kernel/integrity.ts";

const graph = loadConvex(["lib/sequences/emailAuthority.ts", "lib/outbound/mailboxReceipts.ts"]);
const port = graph["lib/sequences/emailAuthority.ts"] as unknown as typeof import("../convex/lib/sequences/emailAuthority");
const receipts = graph["lib/outbound/mailboxReceipts.ts"] as unknown as typeof import("../convex/lib/outbound/mailboxReceipts");
const id = <T extends TableNames>(s: string) => s as Id<T>;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), (b) => b.toString(16).padStart(2, "0")).join("");
async function world() {
  const templateHash = await hash(["canon.sq1.template.v1", "email", "Hello", "Frozen text"]);
  const templates = [{ step: { key: "hello", ordinal: 0 }, variant: "A", channel: "email", templateHash }];
  const setHash = await hash(["canon.sq1.template-set.v1", templates]);
  const p: P4PreparedEmail = {
    version: 1, orgId: id<"organizations">("org"), moduleId: "@canon/sequences", preparedBy: id<"users">("rep"),
    recipient: { contactId: "con_person", streamId: id<"canonEntities">("stream"), address: "person@example.test" }, companyStreamId: null,
    sender: { id: id<"emailAccounts">("mail"), ownerId: id<"users">("owner"), address: "owner@example.test", mailboxLinkHash: "a".repeat(64) },
    grantId: id<"mailboxSendGrants">("grant"), canonicalMergeHash: "b".repeat(64), renderedHash: "",
    template: { authority: { kind: "sq1.template-set.v1", launchId: id<"sequenceLaunches">("launch"), hash: setHash }, selectedHash: templateHash, selection: { stepKey: "hello", ordinal: 0, variant: "A" } },
    delivery: { subject: "Hello", text: "Frozen text and compliant footer", html: "<p>Frozen text and compliant footer</p>", headers: { listUnsubscribe: "<https://fixture.test/unsubscribe>", listUnsubscribePost: "List-Unsubscribe=One-Click", inReplyTo: null, references: [] } },
    requestedNotBefore: Date.now() - 1000, validUntil: Date.now() + 60_000, thread: null,
  };
  p.renderedHash = await receipts.hashP4RenderedEmail(p.delivery);
  const db = memoryDb({
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: p.moduleId, status: "installed", epoch: 1 }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: p.moduleId, contributionKey: "nav", enabled: true }],
    sequenceLaunches: [{ _id: "launch", orgId: "org", moduleId: p.moduleId, state: "active", authorizationEpoch: 1, packageEpoch: 1, revision: 1,
      approvedBy: "rep", templateSetVersion: 1, approvedSenderRefs: ["mail"], allowedChannels: ["email"], reservedRequests: 0, totalRequestCap: 1,
      approvedTemplates: templates, templateSetHash: setHash, approvedPlan: { steps: [{ key: "hello", ordinal: 0, occurrence: 0, kind: "auto_email", thread: false, variants: [{ key: "A", weight: 100, subject: "Hello", body: "Frozen text", templateHash }] }] } }],
    sequenceEnrollments: [{ _id: "enrollment", orgId: "org", moduleId: p.moduleId, launchId: "launch", state: "active", currentRequestId: "request", contactId: "con_person", revision: 1, currentStep: { stepKey: "hello", ordinal: 0, occurrence: 0 } }],
    outboxRequests: [{ _id: "request", orgId: "org", moduleId: p.moduleId, launchId: "launch", enrollmentId: "enrollment", stepKey: "hello", ordinal: 0, occurrence: 0, authorizationEpoch: 1, revision: 1, state: "preparing", requestedNotBefore: p.requestedNotBefore }],
  });
  const ctx = { db } as unknown as MutationCtx;
  const request = (await db.get("request")) as unknown as Doc<"outboxRequests">;
  const ref: RequestAuthorizationRef = { kind: "sq1.email.v1", requestId: id<"outboxRequests">("request"), epoch: 1, digest: await receipts.hashP4Sq1EmailBinding(request, p) };
  const inspect = (phase: "enqueue" | "claim" = "enqueue") => port.inspect(ctx, ref, { prepared: p, row: phase === "enqueue" ? { phase, outboundMessageId: null } : { phase, outboundMessageId: id<"outboundMessages">("out"), nextAttempt: 1 } });
  const putRow = async (rowId = "out") => db.insert("outboundMessages", { _id: rowId, orgId: "org", module: p.moduleId, cause: port.sq1RequestCause(request._id), channel: "email", kind: "automated", fromUserId: "rep", to: { address: p.recipient.address }, target: `address:${p.recipient.address}`, rendered: { subject: p.delivery.subject, text: p.delivery.text }, idempotencyKey: await port.sq1RequestOutboxKey(request, p), notBefore: p.requestedNotBefore, state: "held", attempts: 0, mailbox: { kind: "sq1.email.v1", prepared: p, request: ref } });
  const ready = async () => {
    const allowed = await inspect(); assert.ok(allowed.allowed); if (!allowed.allowed) throw new Error("preflight");
    await putRow(); await port.bindPreparedRequest(ctx, allowed.checked, id<"outboundMessages">("out"));
  };
  const reserve = async () => { const v = await inspect("claim"); assert.ok(v.allowed); if (!v.allowed) throw new Error("claim"); return port.reserve(ctx, v.checked, id<"outboundMessages">("out")); };
  const dispatched = async () => {
    await ready(); await reserve();
    await db.patch("out", { state: "sending", attempts: 1, mailbox: { kind: "sq1.email.v1", prepared: p, request: ref, attempt: { emailSendId: "send", attempt: 1, receiptRevision: 0 } } });
    const outboxAttempt = { kind: "sq1.email.v1" as const, outboundMessageId: id<"outboundMessages">("out"), moduleId: p.moduleId, attempt: 1, renderedHash: p.renderedHash, request: ref };
    await db.insert("emailSends", { _id: "send", orgId: "org", userId: "owner", accountId: "mail", contactId: p.recipient.contactId, to: p.recipient.address, subject: p.delivery.subject, state: "sending", receiptRevision: 0, outboxAttempt });
    return { ...outboxAttempt, orgId: p.orgId, emailSendId: id<"emailSends">("send"), receiptRevision: 0 } satisfies P4EmailAttemptRef;
  };
  return { db, ctx, p, ref, inspect, putRow, ready, reserve, dispatched };
}

test("read-only canonical preflight and frozen enqueue bind one pair without consuming allowance", async () => {
  const h = await world(), before = h.db.checkpoint(), allowed = await h.inspect();
  assert.ok(allowed.allowed); assert.deepEqual(h.db.checkpoint(), before);
  if (!allowed.allowed) return;
  assert.equal("allowed" in await port.reserve(h.ctx, allowed.checked, id<"outboundMessages">("out")), true, "enqueue check is not a final claim");
  await h.putRow();
  await port.bindPreparedRequest(h.ctx, allowed.checked, id<"outboundMessages">("out"));
  assert.equal((await h.db.get("request"))?.state, "ready");
  assert.equal((await h.db.get("launch"))?.reservedRequests, 0);
  const hit = await port.inspect(h.ctx, h.ref, { prepared: h.p, row: { phase: "enqueue", outboundMessageId: id<"outboundMessages">("out") } });
  assert.ok(hit.allowed);
  await h.db.patch("out", { rendered: { subject: "Tampered idempotency hit", text: h.p.delivery.text } });
  assert.equal((await port.inspect(h.ctx, h.ref, { prepared: h.p, row: { phase: "enqueue", outboundMessageId: id<"outboundMessages">("out") } })).allowed, false);
});

test("fresh final-claim checks reserve once per exact pair and refuse stale or cross-context authority", async () => {
  const h = await world(); await h.ready();
  const allow = await h.inspect("claim"); assert.ok(allow.allowed); if (!allow.allowed) return;
  const before = h.db.checkpoint();
  assert.ok("allowed" in await port.reserve({ db: h.db } as unknown as MutationCtx, allow.checked, id<"outboundMessages">("out")));
  assert.deepEqual(h.db.checkpoint(), before);
  assert.deepEqual(plain(await port.reserve(h.ctx, allow.checked, id<"outboundMessages">("out"))), { firstReservation: true });
  const charged = h.db.checkpoint();
  assert.deepEqual(plain(await h.reserve()), { firstReservation: false });
  assert.deepEqual(h.db.checkpoint(), charged);
  assert.equal((await h.db.get("launch"))?.reservedRequests, 1);
  await h.db.patch("launch", { state: "paused", authorizationEpoch: 2 });
  const paused = h.db.checkpoint();
  assert.ok("allowed" in await port.reserve(h.ctx, allow.checked, id<"outboundMessages">("out")));
  assert.deepEqual(h.db.checkpoint(), paused);
});

test("stale binding, set membership, step, pair and unsupported thread refuse without writes", async () => {
  const h = await world(); await h.ready(); const baseline = h.db.checkpoint();
  for (const [tableId, change] of [
    ["enabled", { enabled: false }], ["pkg", { status: "uninstalled" }], ["launch", { templateSetHash: "changed" }],
    ["launch", { approvedTemplates: [] }], ["enrollment", { currentStep: { stepKey: "next", ordinal: 1, occurrence: 0 } }],
    ["request", { outboundMessageId: "another-row" }], ["launch", { reservedRequests: 1 }],
  ] as const) {
    h.db.rollback(baseline); await h.db.patch(tableId, change); const changed = h.db.checkpoint();
    assert.equal((await h.inspect("claim")).allowed, false); assert.deepEqual(h.db.checkpoint(), changed);
  }
  h.db.rollback(baseline);
  const p = plain(h.p); p.delivery.headers.inReplyTo = "guessed-provider-id";
  assert.equal((await port.inspect(h.ctx, h.ref, { prepared: p, row: { phase: "claim", outboundMessageId: id<"outboundMessages">("out"), nextAttempt: 1 } })).allowed, false);
  for (const ref of [{ ...h.ref, epoch: 2 }, { ...h.ref, kind: "module.callback" }, { ...h.ref, requestId: "absent" }]) {
    assert.equal((await port.inspect(h.ctx, ref as RequestAuthorizationRef, { prepared: h.p, row: { phase: "enqueue", outboundMessageId: null } })).allowed, false);
  }
});

test("historical sent/unknown settlement survives uninstall and never revives or advances stale enrollment", async () => {
  for (const outcome of [{ state: "sent", providerId: "actual-opaque-provider-id" }, { state: "unknown", error: "Lease expired" }] as const) {
    const h = await world(), expected = await h.dispatched();
    await h.db.delete("pkg"); await h.db.delete("enabled");
    await h.db.patch("launch", { state: "paused", authorizationEpoch: 2 });
    await h.db.patch("enrollment", { state: "finished", currentStep: { stepKey: "other", ordinal: 1, occurrence: 0 } });
    const recorded = await receipts.recordP4EmailResult(h.ctx, expected, outcome);
    if (recorded.state === "refused" || !recorded.settlement) throw new Error("receipt");
    assert.equal(recorded.state, "recorded");
    const enrollment = await h.db.get("enrollment");
    assert.deepEqual(plain(await port.acceptDeliveryResult(h.ctx, recorded.settlement)), { state: "recorded" });
    assert.equal((await h.db.get("request"))?.state, outcome.state);
    assert.deepEqual(await h.db.get("enrollment"), enrollment);
    assert.equal((await h.db.get("launch"))?.reservedRequests, 1);
    const done = h.db.checkpoint();
    assert.deepEqual(plain(await port.acceptDeliveryResult(h.ctx, recorded.settlement)), { state: "duplicate" });
    assert.deepEqual(h.db.checkpoint(), done);
    assert.ok("allowed" in await port.acceptDeliveryResult(h.ctx, plain(recorded.settlement)));
    assert.equal((await h.inspect("claim")).allowed, false);
  }
});

test("enqueue invariant/storage failures abort the owning mutation instead of leaving a ready orphan", async () => {
  const h = await world(), before = h.db.checkpoint(), v = await h.inspect(); assert.ok(v.allowed); if (!v.allowed) return;
  await assert.rejects(async () => {
    try { await h.putRow(); await h.db.patch("out", { cause: "module:forged" }); await port.bindPreparedRequest(h.ctx, v.checked, id<"outboundMessages">("out")); }
    catch (e) { h.db.rollback(before); throw e; }
  });
  assert.deepEqual(h.db.checkpoint(), before);
});


test("failed same-pair retry retains allowance and P4 write failure rolls reservation back", async () => {
  const h = await world(), expected = await h.dispatched();
  const result = await receipts.recordP4EmailResult(h.ctx, expected, { state: "failed", error: "Provider refusal" });
  if (result.state === "refused" || !result.settlement) throw new Error("receipt");
  await port.acceptDeliveryResult(h.ctx, result.settlement);
  const actual = { prepared: h.p, row: { phase: "claim" as const, outboundMessageId: id<"outboundMessages">("out"), nextAttempt: 2 } };
  const allow = await port.inspect(h.ctx, h.ref, actual); assert.ok(allow.allowed); if (!allow.allowed) return;
  assert.deepEqual(plain(await port.reserve(h.ctx, allow.checked, actual.row.outboundMessageId)), { firstReservation: false });
  assert.equal((await h.db.get("launch"))?.reservedRequests, 1);
  assert.equal((await h.db.get("request"))?.state, "reserved");
  assert.equal(h.db.rows("emailSends").length, 1, "SQ1 cannot create provider attempts");
  const fresh = await world(); await fresh.ready(); const before = fresh.db.checkpoint(), v = await fresh.inspect("claim");
  assert.ok(v.allowed); if (!v.allowed) return;
  await assert.rejects(async () => {
    try { await port.reserve(fresh.ctx, v.checked, id<"outboundMessages">("out")); throw new Error("P4 attempt write failed"); }
    catch (e) { fresh.db.rollback(before); throw e; }
  });
  assert.deepEqual(fresh.db.checkpoint(), before);
});
