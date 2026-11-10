import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { appendObservations } from "../../observations";
import type { P4EmailAttemptRef, P4EmailOutcome, P4PreparedEmail, P4PreparedManifestEmail, RequestAuthorizationRef } from "./mailboxTypes";
import { ownerEmailFrozenValid } from "./ownerEmailPreparation";
import { boundMailboxRow } from "./mailboxBinding";

const hash = async (tuple: unknown[]) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tuple)))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");
const integer = (value: number, min: number) => Number.isSafeInteger(value) && value >= min;
const sameRequest = (a: RequestAuthorizationRef, b: RequestAuthorizationRef) => a.kind === b.kind && a.requestId === b.requestId && a.epoch === b.epoch && a.digest === b.digest;

export function hashP4RenderedEmail(delivery: P4PreparedEmail["delivery"]): Promise<string> {
  return hash(["canon.p4.email-render.v1", delivery.subject, delivery.text, delivery.html, delivery.headers.listUnsubscribe,
    delivery.headers.listUnsubscribePost, delivery.headers.inReplyTo, delivery.headers.references]);
}

export function hashP4Sq1EmailBinding(request: Doc<"outboxRequests">, p: P4PreparedEmail): Promise<string> {
  return hash(["canon.p4.sq1.email.v1", request.orgId, request.moduleId, request._id, request.launchId, request.authorizationEpoch, request.enrollmentId,
    p.recipient.contactId, p.recipient.streamId, p.recipient.address, p.sender.id, p.sender.ownerId, p.sender.mailboxLinkHash, p.grantId,
    p.template.authority.hash, p.template.selection.stepKey, p.template.selection.ordinal, p.template.selection.variant, p.template.selectedHash,
    p.canonicalMergeHash, p.renderedHash, p.requestedNotBefore, p.validUntil, p.thread === null ? null : [p.thread.predecessorRequestId, p.thread.providerId]]);
}

type PairIds = { outboundMessageId: Id<"outboundMessages">; emailSendId: Id<"emailSends"> };
async function readPair(ctx: QueryCtx, ids: PairIds) {
  const row = await ctx.db.get(ids.outboundMessageId), send = await ctx.db.get(ids.emailSendId);
  const mailbox = row ? boundMailboxRow(row) : null, binding = send?.outboxAttempt;
  if (!row || !send || !mailbox?.attempt || !binding) return null;
  const p = mailbox.prepared, attempt = mailbox.attempt;
  if (!integer(p.requestedNotBefore, 0) || !integer(p.validUntil, 0) || p.requestedNotBefore >= p.validUntil
    || row.channel !== "email" || !("address" in row.to) || row.to.address !== p.recipient.address
    || row.orgId !== p.orgId || row.module !== p.moduleId || row.fromUserId !== p.preparedBy
    || row.rendered.subject !== p.delivery.subject || row.rendered.text !== p.delivery.text
    || send.orgId !== row.orgId || send.accountId !== p.sender.id || send.userId !== p.sender.ownerId
    || send.contactId !== p.recipient.contactId || send.to !== p.recipient.address || send.subject !== p.delivery.subject
    || binding.kind !== mailbox.kind || binding.moduleId !== p.moduleId || binding.outboundMessageId !== row._id
    || binding.renderedHash !== p.renderedHash || attempt.emailSendId !== send._id || binding.attempt !== attempt.attempt
    || row.attempts !== attempt.attempt || !integer(attempt.attempt, 1) || attempt.receiptRevision !== send.receiptRevision) return null;
  const revision = attempt.receiptRevision;
  if (!integer(revision, 0) || revision > 1 || (revision === 0 ? row.state !== "sending" || send.state !== "sending"
    : !["sent", "failed", "unknown"].includes(row.state) || row.state !== send.state)) return null;
  if (row.providerId !== send.providerId || row.error !== send.error) return null;
  if (mailbox.kind === "sq1.email.v1") {
    if (binding.kind !== "sq1.email.v1" || !sameRequest(mailbox.request, binding.request) || !integer(mailbox.request.epoch, 1)) return null;
    const request = await ctx.db.get(mailbox.request.requestId), prepared = mailbox.prepared;
    if (!request || !("frozen" in request) || !request.frozen || !("reservedAt" in request)
      || request.orgId !== row.orgId || request.moduleId !== row.module || request.outboundMessageId !== row._id
      || request.authorizationEpoch !== mailbox.request.epoch || request.launchId !== prepared.template.authority.launchId
      || !integer(request.ordinal, 0) || request.stepKey !== prepared.template.selection.stepKey || request.ordinal !== prepared.template.selection.ordinal
      || request.requestedNotBefore !== prepared.requestedNotBefore
      || (request.state !== "reserved" && request.state !== row.state)) return null;
    const frozen = request.frozen;
    if (frozen.digest !== mailbox.request.digest || await hashP4Sq1EmailBinding(request, prepared) !== frozen.digest
      || frozen.contactId !== prepared.recipient.contactId || frozen.contactStreamId !== prepared.recipient.streamId || frozen.normalizedAddress !== prepared.recipient.address
      || frozen.senderId !== prepared.sender.id || frozen.ownerId !== prepared.sender.ownerId || frozen.mailboxLinkHash !== prepared.sender.mailboxLinkHash || frozen.grantId !== prepared.grantId
      || frozen.templateSetHash !== prepared.template.authority.hash || frozen.variant !== prepared.template.selection.variant || frozen.selectedTemplateHash !== prepared.template.selectedHash
      || frozen.canonicalMergeHash !== prepared.canonicalMergeHash || frozen.renderedHash !== prepared.renderedHash || frozen.validUntil !== prepared.validUntil
      || (frozen.thread === null ? prepared.thread !== null : prepared.thread === null
        || frozen.thread.predecessorRequestId !== prepared.thread.predecessorRequestId || frozen.thread.providerId !== prepared.thread.providerId)
      || await hashP4RenderedEmail(prepared.delivery) !== prepared.renderedHash) return null;
    if (request.result && (revision !== 1 || request.result.emailSendId !== send._id || request.result.attempt !== attempt.attempt
      || request.result.receiptRevision !== revision)) return null;
  } else if (mailbox.kind === "owner.exact-email.v1") {
    if (binding.kind !== mailbox.kind || "request" in mailbox || "request" in binding || !mailbox.decision
      || mailbox.decision.bindingHash !== mailbox.prepared.bindingHash || mailbox.decision.ownerId !== p.sender.ownerId
      || !(await ownerEmailFrozenValid(mailbox.prepared))) return null;
  } else {

    if (binding.kind !== "manifest.automated-email.v1" || "request" in mailbox || "request" in binding) return null;
    const d: P4PreparedManifestEmail["delivery"] = mailbox.prepared.delivery;
    if (d.headers.references.length !== 0 || await hash(["canon.outbound.manifest-render.v1", d.subject, d.text, d.html, d.headers.listUnsubscribe,
      d.headers.listUnsubscribePost, d.headers.inReplyTo, d.headers.references]) !== p.renderedHash) return null;
  }
  return { row, send, mailbox, attempt };
}

export async function readP4EmailAttempt(ctx: QueryCtx, outboundMessageId: Id<"outboundMessages">): Promise<P4EmailAttemptRef | null> {
  const row = await ctx.db.get(outboundMessageId), mailbox = row ? boundMailboxRow(row) : null;
  if (!row || !mailbox?.attempt || mailbox.attempt.receiptRevision !== 0 || !ctx.db.normalizeId("emailSends", mailbox.attempt.emailSendId)) return null;
  const pair = await readPair(ctx, { outboundMessageId, emailSendId: mailbox.attempt.emailSendId });
  if (!pair?.send.outboxAttempt) return null;
  return { ...pair.send.outboxAttempt, orgId: row.orgId, emailSendId: pair.send._id, receiptRevision: 0 };
}

declare const historicalBrand: unique symbol;
export type P4VerifiedHistoricalSettlement = {
  version: 1; request: RequestAuthorizationRef; outboundMessageId: Id<"outboundMessages">;
  emailSendId: Id<"emailSends">; attempt: number; receiptRevision: number;
  readonly [historicalBrand]: true;
};
const verified = new WeakMap<object, { ctx: QueryCtx; ids: PairIds; snapshot: string }>();
type Pair = NonNullable<Awaited<ReturnType<typeof readPair>>>;
function outcomeOf(pair: Pair): P4EmailOutcome | null {
  if (pair.attempt.receiptRevision !== 1) return null;
  const send = pair.send;
  if (send.state === "sent") return send.providerId ? { state: "sent", providerId: send.providerId } : null;
  if (send.state === "failed" || send.state === "unknown") return send.error ? { state: send.state, error: send.error } : null;
  return null;
}
function evidenceFor(ctx: QueryCtx, pair: Pair): P4VerifiedHistoricalSettlement | null {
  if (pair.mailbox.kind !== "sq1.email.v1" || !outcomeOf(pair)) return null;
  const evidence = Object.freeze({ version: 1 as const, request: Object.freeze({ ...pair.mailbox.request }), outboundMessageId: pair.row._id,
    emailSendId: pair.send._id, attempt: pair.attempt.attempt, receiptRevision: pair.attempt.receiptRevision });
  verified.set(evidence, { ctx, ids: { outboundMessageId: pair.row._id, emailSendId: pair.send._id }, snapshot: JSON.stringify(evidence) });

  return evidence as P4VerifiedHistoricalSettlement;
}

export async function verifyP4HistoricalSettlement(ctx: QueryCtx, ids: PairIds): Promise<P4VerifiedHistoricalSettlement | null> {
  const pair = await readPair(ctx, ids);
  return pair ? evidenceFor(ctx, pair) : null;
}

export async function readVerifiedP4HistoricalSettlement(ctx: QueryCtx, evidence: P4VerifiedHistoricalSettlement): Promise<{
  outcome: P4EmailOutcome; evidence: P4VerifiedHistoricalSettlement;
} | null> {
  const known = verified.get(evidence);
  if (!known || known.ctx !== ctx || known.snapshot !== JSON.stringify(evidence)) return null;
  const pair = await readPair(ctx, known.ids), fresh = pair ? evidenceFor(ctx, pair) : null;
  if (!pair || !fresh || JSON.stringify(fresh) !== known.snapshot) return null;
  const outcome = outcomeOf(pair);
  return outcome ? { outcome, evidence: fresh } : null;
}

type Recorded = { state: "recorded" | "duplicate"; settlement: P4VerifiedHistoricalSettlement | null };
type Refused = { state: "refused"; code: "outbound.receipt.mismatch" };
const refusal = (): Refused => ({ state: "refused", code: "outbound.receipt.mismatch" });
const sameOutcome = (a: P4EmailOutcome, b: P4EmailOutcome) => a.state === b.state && (a.state === "sent"
  ? b.state === "sent" && a.providerId === b.providerId : b.state !== "sent" && a.error === b.error);

export async function recordP4EmailResult(ctx: MutationCtx, expected: P4EmailAttemptRef, result: P4EmailOutcome): Promise<Recorded | Refused> {
  const value = result.state === "sent" ? result.providerId : result.error;
  if (!["sent", "failed", "unknown"].includes(result.state) || typeof value !== "string" || !value || value.length > 2000
    || expected.receiptRevision !== 0 || !integer(expected.attempt, 1)) return refusal();
  const pair = await readPair(ctx, expected);
  if (!pair || pair.row.orgId !== expected.orgId || pair.row.module !== expected.moduleId || pair.mailbox.kind !== expected.kind
    || pair.attempt.attempt !== expected.attempt || pair.mailbox.prepared.renderedHash !== expected.renderedHash) return refusal();
  if (expected.kind === "sq1.email.v1" && (pair.mailbox.kind !== "sq1.email.v1" || !sameRequest(expected.request, pair.mailbox.request))) return refusal();
  const prior = outcomeOf(pair);
  if (prior) return sameOutcome(prior, result) ? { state: "duplicate", settlement: evidenceFor(ctx, pair) } : refusal();
  if (pair.attempt.receiptRevision !== 0) return refusal();
  const patch = result.state === "sent" ? { state: result.state, providerId: result.providerId, error: undefined }
    : { state: result.state, error: result.error, providerId: undefined };
  await ctx.db.patch(pair.send._id, { ...patch, receiptRevision: 1 });
  await ctx.db.patch(pair.row._id, { ...patch, mailbox: { ...pair.mailbox, attempt: { ...pair.attempt, receiptRevision: 1 } } });
  if (result.state === "sent") {
    const p = pair.mailbox.prepared;
    await appendObservations(ctx, p.orgId, { object: "contact", contactId: p.recipient.contactId }, { kind: "user", ref: p.sender.ownerId }, [{
      observedAt: Date.now(),
      body: { type: "email", key: `email:${pair.send._id}`,
        event: { kind: "sent", userId: p.sender.ownerId, from: p.sender.address, to: p.recipient.address, subject: p.delivery.subject, body: p.delivery.text } },
    }]);
  }
  const persisted = await readPair(ctx, expected);
  if (!persisted || !outcomeOf(persisted)) throw new Error("P4 receipt pair did not persist atomically");
  return { state: "recorded", settlement: evidenceFor(ctx, persisted) };
}
