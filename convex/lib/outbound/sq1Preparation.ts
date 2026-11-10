import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { principalAccess } from "../../permissions";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";
import { arm } from "../../../modules/examples/sequences/engine.ts";
import { BODY_MAX, SUBJECT_MAX, validAddress } from "../email/compose";
import { senderReader } from "../modules/senders";
import { suppressionFor } from "../suppressions/store";
import { policyForAutomatedEmail } from "./emailPolicy";
import { emailHeaderSafe, renderCompliantEmail, siteOrigin } from "./emailRendering";
import { inspectMailboxGrant } from "./mailboxGrants";
import { hashP4RenderedEmail, hashP4Sq1EmailBinding } from "./mailboxReceipts";
import type { P4PreparedEmail, RequestAuthorizationRef } from "./mailboxTypes";
import type { RecipientMergeField } from "./recipients";
import { readSq1TemplateSet, sq1CanonicalHash, sq1MergeFields } from "./sq1Templates";
import { sequenceRecipientValues } from "../sequences/recipientValues";
import { renderVariables } from "../sequences/variables";
import { mintUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe";

export type Sq1PreparerContext = Readonly<{ orgId: Id<"organizations">; preparedBy: Id<"users"> }>;
type Refused = { state: "refused"; code: "outbound.sq1_preparation.unavailable" | "outbound.sq1_preparation.drift" | "outbound.sq1_preparation.suppressed"; text: string };
export type Sq1PreparationResult = { state: "prepared"; prepared: P4PreparedEmail; request: RequestAuthorizationRef; recipientMergeFields: RecipientMergeField[] } | Refused;
export type Sq1RevalidationResult = { state: "valid" } | Refused;
const refuse = (text: string, drift = false): Refused => ({ state: "refused", code: drift ? "outbound.sq1_preparation.drift" : "outbound.sq1_preparation.unavailable", text });
const time = (n: number) => Number.isSafeInteger(n) && n >= 0;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

async function liveSq1(ctx: QueryCtx, requestId: Id<"outboxRequests">, actor: Sq1PreparerContext, initial: boolean) {
  if (!actor || Object.keys(actor).length !== 2 || !actor.orgId || !actor.preparedBy || Object.keys(actor).some((k) => !["orgId", "preparedBy"].includes(k))) return refuse("A trusted causal preparer is required.");
  const id = ctx.db.normalizeId("outboxRequests", requestId), request = id ? await ctx.db.get(id) : null;
  if (!request || request.orgId !== actor.orgId || (initial ? request.state !== "preparing" : !["preparing", "ready", "reserved", "failed"].includes(request.state))
    || request.occurrence !== 0 || !time(request.requestedNotBefore) || !Number.isSafeInteger(request.authorizationEpoch) || request.authorizationEpoch < 1
    || !Number.isSafeInteger(request.ordinal) || request.ordinal < 0 || !request.stepKey) return refuse("The canonical sequence request is unavailable.");
  const enrollment = await ctx.db.get(request.enrollmentId);
  if (!enrollment || enrollment.orgId !== request.orgId || enrollment.moduleId !== request.moduleId || enrollment.launchId !== request.launchId
    || enrollment.state !== "active" || enrollment.currentRequestId !== request._id || enrollment.currentStep.stepKey !== request.stepKey
    || enrollment.currentStep.ordinal !== request.ordinal || enrollment.currentStep.occurrence !== request.occurrence) return refuse("The canonical enrollment changed.");
  const set = await readSq1TemplateSet(ctx, request.orgId, request.launchId, [actor.preparedBy, enrollment.assignedRep]);
  if (!set || set.launch.moduleId !== request.moduleId || set.launch.authorizationEpoch !== request.authorizationEpoch) return refuse("The visible canonical launch or approved set changed.");
  const step = set.launch.approvedPlan.steps[request.ordinal];
  if (!step || step.key !== request.stepKey || step.kind !== "auto_email" || step.thread) return refuse("Only unthreaded canonical automated email is supported.");
  const selected = arm(enrollment.contactId, request.ordinal, step.variants.map((v) => ({ ...v, id: v.key })));
  const variant = selected ? step.variants.find((v) => v.key === selected.id) : null;
  if (!variant) return refuse("The approved step has no canonical selected variant.");
  const fields = sq1MergeFields(variant);
  if (!fields) return refuse("A required merge field has no proven canonical relationship or value.");
  const accesses = await principalAccess(ctx, request.orgId, [actor.preparedBy]);
  if (!accesses) return refuse("The causal preparer is unavailable.");
  const reader = senderReader(ctx, request.orgId, accesses[0]), senders = [];
  for (const senderId of set.launch.approvedSenderRefs) {
    const sender = await reader.byId(senderId);
    if (sender && sender.ownerId === enrollment.assignedRep && sender.status === "ok") senders.push(sender);
  }
  if (senders.length !== 1) return refuse("The assigned rep needs one unambiguous approved visible mailbox.");
  const sender = senders[0], candidates = await ctx.db.query("mailboxSendGrants").withIndex("by_orgId_and_ownerId_and_moduleId", (q) =>
    q.eq("orgId", request.orgId).eq("ownerId", sender.ownerId).eq("moduleId", request.moduleId)).take(101);
  if (candidates.length === 101) return refuse("Mailbox consent cannot be resolved within its safety bound.");
  const applicable = candidates.filter((grant) => grant.senderId === sender.id && grant.template.kind === "sq1.template-set.v1"
    && grant.template.launchId === set.launch._id && grant.template.hash === set.launch.templateSetHash && grant.revokedAt === undefined && grant.expiresAt > Date.now());
  if (applicable.length !== 1) return refuse("One live owner-signed grant for this exact launch set is required.");
  const grant = applicable[0];
  if ((await inspectMailboxGrant(ctx, grant, Date.now())).state !== "live") return refuse("The owner grant or linked mailbox is no longer live.");
  const recipientFields = fields.filter((field) => field.startsWith("to.")).map((field) => field.slice(3) as RecipientMergeField);
  let recipient: Awaited<ReturnType<typeof sequenceRecipientValues>>;
  try { recipient = await sequenceRecipientValues(ctx, request.orgId, set.launch.moduleSequenceKey, enrollment.contactId, [actor.preparedBy, sender.ownerId], fields); }
  catch { return refuse("A required canonical recipient variable is unavailable."); }
  const address = sender.address.trim().toLowerCase(), recipientAddress = recipient.values["to.email"];
  if (recipient.emailStatus !== "valid" || !validAddress(address) || !emailHeaderSafe(sender.address, 254) || !validAddress(recipientAddress) || !emailHeaderSafe(recipientAddress, 254)) return refuse("Canonical email must have status valid and be header safe.");
  const rendered = renderVariables(variant, { ...recipient.values, "sender.name": sender.name, "sender.address": address }, recipient.emailStatus);
  if (rendered.problems.length) return refuse("A required canonical merge value failed the variable check.");
  const values = rendered.values;
  for (const field of fields) if (!values[field] || values[field].includes("\0") || field === "sender.name" && !emailHeaderSafe(values[field], 200)) return refuse("A selected canonical merge value is unavailable.");
  const subject = rendered.subject, body = rendered.body.replace(/\r\n?/g, "\n");
  if (body.length > BODY_MAX || !emailHeaderSafe(subject, SUBJECT_MAX)) return refuse("The selected canonical email exceeds safe rendering bounds.");
  const policy = policyForAutomatedEmail(await ctx.db.get(request.orgId)), origin = siteOrigin();
  if (policy.state === "refused" || !origin) return refuse("Workspace postal policy and a trusted unsubscribe origin are required.");
  if ((await suppressionFor(ctx, request.orgId, { email: recipientAddress }, "automated_outreach")).email.blocked) return {
    state: "refused" as const, code: "outbound.sq1_preparation.suppressed" as const, text: "The recipient is suppressed for automated outreach." };
  const canonicalMergeHash = await sq1CanonicalHash(["canon.p4.sq1.merge.v1", enrollment.contactId, recipient.streamId, recipientAddress, null, fields.map((field) => [field, values[field]])]);
  return { state: "live" as const, request, set, grant, variant, subject, body, postalAddress: policy.policy.postalAddress, origin, canonicalMergeHash, recipientMergeFields: recipientFields,
    recipient: { contactId: enrollment.contactId, streamId: recipient.streamId, address: recipientAddress },
    sender: { id: sender.id, ownerId: sender.ownerId, address, mailboxLinkHash: grant.mailboxLinkHash } };
}

export async function prepareSq1Email(ctx: QueryCtx, requestId: Id<"outboxRequests">, actor: Sq1PreparerContext): Promise<Sq1PreparationResult> {
  const now = Date.now();
  if (!time(now)) return refuse("The server preparation clock is unavailable.");
  const live = await liveSq1(ctx, requestId, actor, true);
  if (live.state === "refused") return live;
  const validUntil = live.grant.expiresAt;
  if (live.request.requestedNotBefore >= validUntil) return refuse("The immutable requested time exceeds consent expiry.");
  const minted = await mintUnsubscribeToken({ orgId: live.request.orgId, address: live.recipient.address, expiresAt: validUntil });
  if (!minted.ok) return refuse("Frozen unsubscribe material cannot be signed on this deployment.");
  const url = `${live.origin}/outbound/unsubscribe?token=${encodeURIComponent(minted.token)}`;
  const delivery = renderCompliantEmail({ address: live.recipient.address, subject: live.subject, body: live.body, postalAddress: live.postalAddress, url });
  if (!delivery) return refuse("The exact frozen delivery exceeds safe email bounds.");
  const prepared: P4PreparedEmail = { version: 1, orgId: live.request.orgId, moduleId: live.request.moduleId, preparedBy: actor.preparedBy,
    recipient: live.recipient, companyStreamId: null, canonicalMergeHash: live.canonicalMergeHash, sender: live.sender, grantId: live.grant._id,
    template: { authority: { kind: "sq1.template-set.v1", launchId: live.set.launch._id, hash: live.set.launch.templateSetHash }, selectedHash: live.variant.templateHash,
      selection: { stepKey: live.request.stepKey, ordinal: live.request.ordinal, variant: live.variant.key } },
    delivery, renderedHash: await hashP4RenderedEmail(delivery), requestedNotBefore: live.request.requestedNotBefore, validUntil, thread: null };
  return { state: "prepared", prepared, recipientMergeFields: live.recipientMergeFields,
    request: { kind: "sq1.email.v1", requestId: live.request._id, epoch: live.request.authorizationEpoch, digest: await hashP4Sq1EmailBinding(live.request, prepared) } };
}

export async function revalidateSq1Email(ctx: QueryCtx, requestId: Id<"outboxRequests">, actor: Sq1PreparerContext, frozen: P4PreparedEmail): Promise<Sq1RevalidationResult> {
  const now = Date.now();
  if (!actor || !frozen?.delivery?.headers || !Array.isArray(frozen.delivery.headers.references)) return refuse("A complete frozen email and trusted causal preparer are required.");
  if (!time(now) || !time(frozen.validUntil) || frozen.validUntil <= now || frozen.thread !== null || frozen.companyStreamId !== null
    || frozen.preparedBy !== actor.preparedBy || frozen.orgId !== actor.orgId || frozen.delivery.headers.inReplyTo !== null || frozen.delivery.headers.references.length !== 0) return refuse("The immutable frozen email is expired or unsupported.");
  const live = await liveSq1(ctx, requestId, actor, false);
  if (live.state === "refused") return live;
  if (frozen.version !== 1 || frozen.moduleId !== live.request.moduleId || frozen.requestedNotBefore !== live.request.requestedNotBefore || frozen.validUntil > live.grant.expiresAt
    || frozen.grantId !== live.grant._id || !same(frozen.recipient, live.recipient) || !same(frozen.sender, live.sender) || frozen.canonicalMergeHash !== live.canonicalMergeHash
    || !same(frozen.template, { authority: { kind: "sq1.template-set.v1", launchId: live.set.launch._id, hash: live.set.launch.templateSetHash }, selectedHash: live.variant.templateHash,
      selection: { stepKey: live.request.stepKey, ordinal: live.request.ordinal, variant: live.variant.key } }) || await hashP4RenderedEmail(frozen.delivery) !== frozen.renderedHash) return refuse("The live canonical binding changed. Prepare a fresh email.", true);
  const header = frozen.delivery.headers.listUnsubscribe;
  if (!header?.startsWith("<") || !header.endsWith(">") || frozen.delivery.headers.listUnsubscribePost !== "List-Unsubscribe=One-Click") return refuse("Frozen RFC8058 material is missing.");
  let token: string | null = null;
  try { token = new URL(header.slice(1, -1)).searchParams.get("token"); } catch { return refuse("The frozen unsubscribe URL is invalid."); }
  const verified = token ? await verifyUnsubscribeToken(token) : null;
  if (!token || !verified || verified.terms.orgId !== frozen.orgId || verified.terms.address !== frozen.recipient.address || verified.terms.expiresAt !== frozen.validUntil
    || verified.terms.issuedAt < live.grant.createdAt) return refuse("The frozen unsubscribe token is no longer valid.");
  const url = `${live.origin}/outbound/unsubscribe?token=${encodeURIComponent(token)}`;

  const expected = renderCompliantEmail({ address: live.recipient.address, subject: live.subject, body: live.body, postalAddress: live.postalAddress, url });
  if (!expected || !same(expected, frozen.delivery)) return refuse("Frozen text, compliance footer or deployment origin changed.", true);
  if (live.request.state !== "preparing" && (!("frozen" in live.request) || !live.request.frozen
    || live.request.frozen.digest !== await hashP4Sq1EmailBinding(live.request, frozen))) return refuse("The canonical request digest changed.", true);
  return { state: "valid" };
}
