import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { installedModule, isEnabled } from "../modules/packages";
import { hashP4RenderedEmail, hashP4Sq1EmailBinding, readVerifiedP4HistoricalSettlement, type P4VerifiedHistoricalSettlement } from "../outbound/mailboxReceipts";
import type { P4PreparedEmail, P4PreparedRequestBinding, RequestAuthorizationRef } from "../outbound/mailboxTypes";

const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), (b) => b.toString(16).padStart(2, "0")).join("");
const integer = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameRef = (a: RequestAuthorizationRef, b: RequestAuthorizationRef) => same(a, b);
export type Sq1Refused = { allowed: false; refused: { code: "sq1.request.refused"; text: string } };
const refuse = (): Sq1Refused => ({ allowed: false, refused: { code: "sq1.request.refused", text: "The canonical sequence request or its live binding is unavailable." } });
declare const checkedBrand: unique symbol;
export type Sq1CheckedRequest = { readonly [checkedBrand]: true };
export type Sq1Allow = { allowed: true; checked: Sq1CheckedRequest };
type Checked = { ctx: QueryCtx; ref: RequestAuthorizationRef; actual: P4PreparedRequestBinding };
const checkedRequests = new WeakMap<Sq1CheckedRequest, Checked>();

export const sq1RequestCause = (id: Id<"outboxRequests">) => `canon:sq1.email.v1:${id}`;
export async function sq1RequestOutboxKey(request: Doc<"outboxRequests">, p: P4PreparedEmail) {
  const bytes = new TextEncoder().encode(JSON.stringify([request.orgId, request.moduleId, sq1RequestCause(request._id), 0, `address:${p.recipient.address}`]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function frozenOf(p: P4PreparedEmail, digest: string) {
  return { digest, contactId: p.recipient.contactId, contactStreamId: p.recipient.streamId, normalizedAddress: p.recipient.address,
    senderId: p.sender.id, ownerId: p.sender.ownerId, mailboxLinkHash: p.sender.mailboxLinkHash, grantId: p.grantId,
    templateSetHash: p.template.authority.hash, variant: p.template.selection.variant, selectedTemplateHash: p.template.selectedHash,
    canonicalMergeHash: p.canonicalMergeHash, renderedHash: p.renderedHash, validUntil: p.validUntil, thread: p.thread };
}
async function matchingRow(ctx: QueryCtx, request: Doc<"outboxRequests">, ref: RequestAuthorizationRef, p: P4PreparedEmail, id: Id<"outboundMessages">) {
  const row = await ctx.db.get(id);
  if (!row || row.orgId !== request.orgId || row.module !== request.moduleId || row.cause !== sq1RequestCause(request._id)
    || row.channel !== "email" || row.kind !== "automated" || row.fromUserId !== p.preparedBy || !("address" in row.to) || row.to.address !== p.recipient.address
    || row.target !== `address:${p.recipient.address}` || row.rendered.subject !== p.delivery.subject || row.rendered.text !== p.delivery.text
    || row.idempotencyKey !== await sq1RequestOutboxKey(request, p) || row.mailbox?.kind !== "sq1.email.v1"
    || !sameRef(row.mailbox.request, ref) || !same(row.mailbox.prepared, p)) return null;
  return row;
}

export async function inspect(ctx: QueryCtx, ref: RequestAuthorizationRef, actual: P4PreparedRequestBinding): Promise<Sq1Allow | Sq1Refused> {
  if (!ref || typeof ref !== "object" || Object.keys(ref).length !== 4 || Object.keys(ref).some((k) => !["kind", "requestId", "epoch", "digest"].includes(k)) || !actual || !actual.prepared || !actual.row || !["enqueue", "claim"].includes(actual.row.phase) || !ref || ref.kind !== "sq1.email.v1" || typeof ref.requestId !== "string" || !integer(ref.epoch, 1) || !/^[a-f0-9]{64}$/.test(ref.digest)) return refuse();
  const id = ctx.db.normalizeId("outboxRequests", ref.requestId);
  const request = id ? await ctx.db.get(id) : null;
  if (!request || request.authorizationEpoch !== ref.epoch || !["preparing", "ready", "reserved", "failed"].includes(request.state)) return refuse();
  const launch = await ctx.db.get(request.launchId), enrollment = await ctx.db.get(request.enrollmentId), p = actual.prepared;
  const pkg = await installedModule(ctx, request.orgId, request.moduleId);
  if (!pkg || pkg.pending || pkg.moduleId !== "@canon/sequences" || launch?.state !== "active" || enrollment?.state !== "active"
    || !(await isEnabled(ctx, request.orgId, request.moduleId)) || launch.packageEpoch !== (pkg.epoch ?? 1)
    || launch.templateSetVersion !== 1 || launch.orgId !== request.orgId || launch.moduleId !== request.moduleId || launch.authorizationEpoch !== ref.epoch
    || enrollment.orgId !== request.orgId || enrollment.moduleId !== request.moduleId || enrollment.launchId !== launch._id
    || enrollment.currentRequestId !== request._id || enrollment.currentStep.stepKey !== request.stepKey || enrollment.currentStep.ordinal !== request.ordinal
    || enrollment.currentStep.occurrence !== request.occurrence || request.occurrence !== 0
    || p.version !== 1 || p.orgId !== request.orgId || p.moduleId !== request.moduleId || p.recipient.contactId !== enrollment.contactId
    || !launch.allowedChannels.includes("email") || !launch.approvedSenderRefs.includes(p.sender.id)
    || p.template.authority.kind !== "sq1.template-set.v1" || p.template.authority.launchId !== launch._id || p.template.authority.hash !== launch.templateSetHash
    || p.template.selection.stepKey !== request.stepKey || p.template.selection.ordinal !== request.ordinal
    || p.requestedNotBefore !== request.requestedNotBefore || !integer(p.requestedNotBefore, 0) || !integer(p.validUntil, 0)
    || p.validUntil <= Math.max(Date.now(), p.requestedNotBefore) || p.thread !== null || p.delivery.headers.inReplyTo !== null || p.delivery.headers.references.length !== 0) return refuse();

  const step = launch.approvedPlan.steps[request.ordinal], variant = step?.variants.find((v) => v.key === p.template.selection.variant);
  if (!step || step.key !== request.stepKey || step.kind !== "auto_email" || step.thread || !variant
    || variant.templateHash !== p.template.selectedHash || await hash(["canon.sq1.template.v1", "email", variant.subject, variant.body]) !== variant.templateHash) return refuse();
  const templates = launch.approvedPlan.steps.flatMap((s) => s.variants.map((v) => ({ step: { key: s.key, ordinal: s.ordinal }, variant: v.key, channel: "email", templateHash: v.templateHash })))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), "en"));
  if (!same(templates, launch.approvedTemplates) || await hash(["canon.sq1.template-set.v1", templates]) !== launch.templateSetHash
    || !templates.some((t) => t.step.key === request.stepKey && t.step.ordinal === request.ordinal && t.variant === variant.key && t.templateHash === variant.templateHash)
    || await hashP4RenderedEmail(p.delivery) !== p.renderedHash || await hashP4Sq1EmailBinding(request, p) !== ref.digest) return refuse();
  if (request.state !== "preparing" && (!("frozen" in request) || !same(request.frozen, frozenOf(p, ref.digest)))) return refuse();
  const charged = "reservedAt" in request;
  if (charged && launch.reservedRequests < 1 || !integer(launch.reservedRequests, 0) || !integer(launch.totalRequestCap, 1) || launch.reservedRequests > launch.totalRequestCap || !charged && launch.reservedRequests >= launch.totalRequestCap) return refuse();
  if (actual.row.phase === "claim") {
    if (request.state === "preparing" || !("outboundMessageId" in request) || request.outboundMessageId !== actual.row.outboundMessageId
      || !integer(actual.row.nextAttempt, 1) || Date.now() < request.requestedNotBefore) return refuse();
    const row = await matchingRow(ctx, request, ref, p, actual.row.outboundMessageId);
    if (!row || row.state !== "queued" && row.state !== "held" && row.state !== "failed"
      || actual.row.nextAttempt !== (row.attempts ?? 0) + 1 || request.state === "failed" && row.state !== "failed") return refuse();
  } else {
    if (request.state !== "preparing" && (!("outboundMessageId" in request) || request.outboundMessageId !== actual.row.outboundMessageId)) return refuse();
    if (actual.row.outboundMessageId !== null && !await matchingRow(ctx, request, ref, p, actual.row.outboundMessageId)) return refuse();
    if (charged) return refuse();
  }
  const checked = Object.freeze({}) as Sq1CheckedRequest;
  checkedRequests.set(checked, { ctx, ref: { ...ref }, actual: {
    row: { ...actual.row }, prepared: { ...p, recipient: { ...p.recipient }, sender: { ...p.sender },
      template: { ...p.template, authority: { ...p.template.authority }, selection: { ...p.template.selection } },
      delivery: { ...p.delivery, headers: { ...p.delivery.headers, references: [...p.delivery.headers.references] } },
      thread: null },
  } });
  return { allowed: true, checked };
}

export async function bindPreparedRequest(ctx: MutationCtx, checked: Sq1CheckedRequest, outboundMessageId: Id<"outboundMessages">): Promise<{ bound: true }> {
  const known = checkedRequests.get(checked);
  if (!known || known.ctx !== ctx || known.actual.row.phase !== "enqueue" || known.actual.row.outboundMessageId !== null && known.actual.row.outboundMessageId !== outboundMessageId) throw new Error("SQ1 enqueue composition lost its same-transaction preflight");
  const verdict = await inspect(ctx, known.ref, { prepared: known.actual.prepared, row: { phase: "enqueue", outboundMessageId } });
  if (!verdict.allowed) throw new Error("SQ1 enqueue binding changed after preflight");
  const request = await ctx.db.get(known.ref.requestId);
  const row = request ? await matchingRow(ctx, request, known.ref, known.actual.prepared, outboundMessageId) : null;
  if (!request || !row || row.state !== "held" && row.state !== "queued") throw new Error("SQ1 enqueue did not persist a matching frozen P4 row");
  if (request.state === "ready") return { bound: true };
  if (request.state !== "preparing") throw new Error("SQ1 enqueue request changed after preflight");
  const { _id, _creationTime, ...data } = request; void _creationTime;
  await ctx.db.replace(_id, { ...data, revision: request.revision + 1, state: "ready", frozen: frozenOf(known.actual.prepared, known.ref.digest), outboundMessageId });
  return { bound: true };
}

export async function reserve(ctx: MutationCtx, checked: Sq1CheckedRequest, outboundMessageId: Id<"outboundMessages">): Promise<{ firstReservation: boolean } | Sq1Refused> {
  const known = checkedRequests.get(checked);
  if (!known || known.ctx !== ctx || known.actual.row.phase !== "claim" || known.actual.row.outboundMessageId !== outboundMessageId) return refuse();
  const verdict = await inspect(ctx, known.ref, known.actual);
  if (!verdict.allowed) return verdict;
  const request = await ctx.db.get(known.ref.requestId);
  if (!request || request.state !== "ready" && request.state !== "reserved" && request.state !== "failed" || request.outboundMessageId !== outboundMessageId) return refuse();
  const launch = await ctx.db.get(request.launchId);
  if (!launch) return refuse();
  const firstReservation = !("reservedAt" in request);
  if (request.state === "reserved") return { firstReservation: false };
  const { _id, _creationTime, ...data } = request; void _creationTime;
  await ctx.db.replace(_id, { ...data, state: "reserved", revision: request.revision + 1, reservedAt: "reservedAt" in request ? request.reservedAt : Date.now(), result: undefined });
  if (firstReservation) await ctx.db.patch(launch._id, { reservedRequests: launch.reservedRequests + 1, revision: launch.revision + 1 });
  return { firstReservation };
}

export async function acceptDeliveryResult(ctx: MutationCtx, evidence: P4VerifiedHistoricalSettlement): Promise<{ state: "recorded" | "duplicate" } | Sq1Refused> {
  const verified = await readVerifiedP4HistoricalSettlement(ctx, evidence);
  if (!verified) return refuse();
  const request = await ctx.db.get(verified.evidence.request.requestId);
  if (!request || !("reservedAt" in request) || request.outboundMessageId !== verified.evidence.outboundMessageId || !request.frozen
    || request.authorizationEpoch !== verified.evidence.request.epoch || request.frozen.digest !== verified.evidence.request.digest) return refuse();
  const result = { emailSendId: verified.evidence.emailSendId, attempt: verified.evidence.attempt, receiptRevision: verified.evidence.receiptRevision };
  if (request.result) return same({ ...request.result, recordedAt: 0 }, { ...result, recordedAt: 0 }) && request.state === verified.outcome.state ? { state: "duplicate" } : refuse();
  if (request.state !== "reserved") return refuse();
  await ctx.db.patch(request._id, { state: verified.outcome.state, revision: request.revision + 1, result: { ...result, recordedAt: Date.now() } });
  return { state: "recorded" };
}
