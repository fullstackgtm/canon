import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { installedModule, isEnabled, manifestOf } from "../modules/packages";
import { principalAccess } from "../../permissions";
import { senderReader } from "../modules/senders";
import { normalizeSuppression } from "../suppressions/domain";
import { validAddress } from "../email/compose";
import { suppressionFor } from "../suppressions/store";
import { acceptDeliveryResult, bindPreparedRequest, inspect, reserve, sq1RequestCause, sq1RequestOutboxKey } from "../sequences/emailAuthority";
import type { Delivery } from "./adapters";
import { automatedEmailHours } from "./emailHours";
import { boundMailboxRefusal, boundMailboxRow, mailboxMetadataShape } from "./mailboxBinding";
import { assessP4MailboxCapacity, assessPreparedMailboxCapacity } from "./mailboxCapacity";
import { mailboxTransportProblem, type P4MailboxDelivery } from "./mailboxAdapter";
import { readP4EmailAttempt, recordP4EmailResult } from "./mailboxReceipts";
import type { P4EmailAttemptRef, P4MailboxMetadata, P4MailboxRefusal } from "./mailboxTypes";
import { prepareManifestEmail, revalidateManifestEmail, type ManifestPreparationInput } from "./manifestPreparation";
import { prepareOwnerPersonalEmail, prepareOwnerAutomatedEmail, revalidateOwnerEmail, readOwnerEmailSource, type OwnerEmailInput } from "./ownerEmailPreparation";
import { outboxKey, wake } from "./queue";
import { readCanonicalMailboxRecipient } from "./recipients";
import { prepareSq1Email, revalidateSq1Email, type Sq1PreparerContext } from "./sq1Preparation";

type Stop = { state: "refused"; code: string; text: string } | { state: "suppressed"; code: string; text: string };
type Waiting = { state: "queued" } | { state: "held"; notBefore: number; code: string; text: string };
type Gate = Stop | Waiting;
export type MailboxEnqueueResult = Stop | { id: Id<"outboundMessages">; state: "queued" | "held"; created: boolean } | (Stop & { id: Id<"outboundMessages">; created: boolean });
export type OwnerEmailEnqueueResult = MailboxEnqueueResult | { id: Id<"outboundMessages">; state: "awaiting_approval"; created: boolean };
export type P4MailboxJob = { channel: "mailbox"; delivery: P4MailboxDelivery; expected: P4EmailAttemptRef };
const refuse = (text = "The canonical frozen mailbox binding is unavailable."): Stop => ({ state: "refused", code: "outbound.mailbox.binding", text });
const sq1Stop = (text: string): Stop => ({ state: "refused", code: "sq1.request.refused", text });
const unclaimed = (r: Doc<"outboundMessages">) => (r.state === "held" || r.state === "queued" || r.state === "awaiting_approval" && r.mailbox?.kind === "owner.exact-email.v1") && r.claimedAt === undefined
  && (r.attempts === undefined || r.attempts === 0) && !r.mailbox?.attempt && Number.isSafeInteger(r.notBefore) && r.notBefore >= 0;

async function gate(ctx: QueryCtx, m: P4MailboxMetadata, row: Doc<"outboundMessages"> | null): Promise<Gate> {
  if (!mailboxMetadataShape(m) || row && (!boundMailboxRow(row) || !unclaimed(row))) return refuse();
  const p = m.prepared, now = Date.now();
  if (!ctx.db.normalizeId("organizations", p.orgId) || !ctx.db.normalizeId("users", p.preparedBy) || !ctx.db.normalizeId("users", p.sender.ownerId)
    || !ctx.db.normalizeId("emailAccounts", p.sender.id) || (m.kind !== "owner.exact-email.v1" && !ctx.db.normalizeId("mailboxSendGrants", m.prepared.grantId)) || !ctx.db.normalizeId("canonEntities", p.recipient.streamId)
    || m.kind === "sq1.email.v1" && (!ctx.db.normalizeId("outboxRequests", m.request.requestId) || !ctx.db.normalizeId("sequenceLaunches", m.prepared.template.authority.launchId))) return refuse();
  if (!Number.isSafeInteger(now) || now < 0 || p.validUntil <= now) return refuse("The frozen email has expired.");
  const pkg = await installedModule(ctx, p.orgId, p.moduleId), declaration = pkg ? manifestOf(pkg).outbound?.email : null;
  if (!pkg || pkg.pending || !(await isEnabled(ctx, p.orgId, p.moduleId)) || !declaration?.from.includes("member_mailbox") || !declaration.kinds.includes(m.kind === "owner.exact-email.v1" && m.prepared.purpose === "manual_action" ? "personal" : "automated")
    || !(await ctx.db.query("outboundChannels").withIndex("by_orgId_and_moduleId_and_channel", (q) => q.eq("orgId", p.orgId).eq("moduleId", p.moduleId).eq("channel", "email")).first())) {
    return refuse("The installed enabled module must declare this mailbox email kind and its email channel must be on.");
  }
  const personal = m.kind === "owner.exact-email.v1" && m.prepared.purpose === "manual_action";
  if ((await suppressionFor(ctx, p.orgId, { email: p.recipient.address }, personal ? "manual_action" : "automated_outreach")).email.blocked) {
    return { state: "suppressed", code: "outbound.mailbox.suppressed", text: "The recipient is suppressed for this email's purpose." };
  }
  if (m.kind === "manifest.automated-email.v1" && m.moduleSource) {
    for (const principal of [p.preparedBy, p.sender.ownerId]) if (!(await readOwnerEmailSource(ctx, p.orgId, p.moduleId, principal, m.moduleSource))) return refuse("The module email's saved source changed or is no longer visible.");
  }
  const live = m.kind === "owner.exact-email.v1" ? await revalidateOwnerEmail(ctx, m.prepared)
    : m.kind === "manifest.automated-email.v1" ? await revalidateManifestEmail(ctx, m.prepared)
    : await revalidateSq1Email(ctx, m.request.requestId, { orgId: p.orgId, preparedBy: p.preparedBy }, m.prepared);
  if (live.state === "refused") return live;
  const account = await ctx.db.get(p.sender.id);
  if (!account) return refuse();
  const problem = mailboxTransportProblem(account);
  if (problem) return { state: "refused", code: "outbound.mailbox.transport", text: problem };
  const capacity = row ? await assessP4MailboxCapacity(ctx, row._id) : await assessPreparedMailboxCapacity(ctx, m);
  if (capacity.state === "refused") return capacity;

  const hours = automatedEmailHours({ now, purpose: personal ? "manual" : "automated", workspaceTimezone: (await ctx.db.get(p.orgId))?.timezone });
  if (hours.state === "refused") return hours;
  let hold = { state: "held" as const, notBefore: p.requestedNotBefore, code: "outbound.mailbox.requested_time", text: "Waits for its immutable requested time." };
  for (const value of [capacity, hours]) if (value.state === "held" && value.notBefore > hold.notBefore) hold = value;
  return hold.notBefore > now ? hold : { state: "queued" };
}

async function insert(ctx: MutationCtx, m: P4MailboxMetadata, cause: string, verdict: Gate, idempotencyKey: string, about?: string, mailboxEffectKey?: string) {
  const p = m.prepared;
  const id = await ctx.db.insert("outboundMessages", { orgId: p.orgId, module: p.moduleId, cause, ...(about ? { about } : {}),
    channel: "email", kind: m.kind === "owner.exact-email.v1" && m.prepared.purpose === "manual_action" ? "personal" : "automated", fromUserId: p.preparedBy, to: { address: p.recipient.address }, target: `address:${p.recipient.address}`,
    rendered: { subject: p.delivery.subject, text: p.delivery.text }, mailbox: m, state: verdict.state,
    ...("text" in verdict ? { reason: verdict.text } : {}), notBefore: verdict.state === "held" ? verdict.notBefore : Math.max(Date.now(), p.requestedNotBefore),
    idempotencyKey, ...(mailboxEffectKey ? { mailboxEffectKey } : {}), at: Date.now() });
  return id;
}

export type ManifestEffect = { cause: string; index: number; about?: string; source?: OwnerEmailInput["source"] };
const historyVerdict = (state: "refused" | "suppressed"): Stop => state === "suppressed"
  ? { state, code: "outbound.mailbox.suppressed", text: "Mailbox email was suppressed. This history cannot be sent." }
  : { state, code: "outbound.mailbox.refused", text: "Mailbox preparation was refused. This history cannot be sent." };
async function effectKey(input: Pick<ManifestPreparationInput, "orgId" | "moduleId">, effect: ManifestEffect, contactId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(["canon.outbound.manifest-effect.v1", input.orgId, input.moduleId, effect.cause, effect.index, contactId]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function manifestIdentity(ctx: QueryCtx, input: Pick<ManifestPreparationInput, "orgId" | "moduleId" | "senderId" | "contactId" | "preparedBy">): Promise<Extract<P4MailboxRefusal, { kind: "manifest.refusal.v1" }> | null> {
  if (!ctx.db.normalizeId("emailAccounts", input.senderId)) return null;
  const account = await ctx.db.get(input.senderId);
  if (!account || account.orgId !== input.orgId) return null;
  const recipient = await readCanonicalMailboxRecipient(ctx, { orgId: input.orgId, contactId: input.contactId, principalIds: [input.preparedBy, account.userId], mergeFields: [] });
  if (!recipient.allowed) return null;
  const access = await principalAccess(ctx, input.orgId, [input.preparedBy]);
  const sender = access ? await senderReader(ctx, input.orgId, access[0]).byId(input.senderId) : null;
  const address = sender ? normalizeSuppression("email", sender.address) : null;
  if (!sender || !address || !validAddress(address) || sender.ownerId !== account.userId) return null;
  return { kind: "manifest.refusal.v1", recipient: { contactId: recipient.binding.contactId, streamId: recipient.binding.streamId, address: recipient.binding.address },
    sender: { id: sender.id, ownerId: sender.ownerId, address } };
}

async function existingEffect(ctx: QueryCtx, input: Pick<ManifestPreparationInput, "orgId" | "moduleId">, effect: ManifestEffect, logicalKey: string, contactId: string) {
  const indexed = await ctx.db.query("outboundMessages").withIndex("by_mailboxEffectKey", (q) => q.eq("mailboxEffectKey", logicalKey)).take(2);
  if (indexed.length > 1) return refuse();
  if (indexed.length) return indexed[0];
  const legacy = await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_cause", (q) => q.eq("orgId", input.orgId).eq("module", input.moduleId).eq("cause", effect.cause)).take(1001);
  if (legacy.length === 1001) return refuse("The logical mailbox effect cannot be proven within its lookup bound.");
  let found: Doc<"outboundMessages"> | null = null;
  for (const row of legacy) {
    if (!row.mailbox && !row.mailboxRefusal && row.mailboxEffectKey === undefined) continue;
    const key = await outboxKey({ orgId: input.orgId, module: { id: input.moduleId, title: "", outbound: undefined }, cause: effect.cause, index: effect.index, target: row.target });
    if (key !== row.idempotencyKey) continue;
    const recipient = boundMailboxRow(row)?.prepared.recipient ?? boundMailboxRefusal(row)?.recipient;
    if (!recipient) return refuse();
    if (recipient.contactId !== contactId) continue;
    if (found || row.mailboxEffectKey !== undefined && row.mailboxEffectKey !== logicalKey) return refuse();
    found = row;
  }
  return found;
}

export async function mailboxEffectNotBefore(ctx: QueryCtx, input: Pick<ManifestPreparationInput, "orgId" | "moduleId" | "contactId">, effect: ManifestEffect): Promise<number | null> {
  const logicalKey = await effectKey(input, effect, input.contactId), prior = await existingEffect(ctx, input, effect, logicalKey, input.contactId);
  if (!prior || !("_id" in prior)) return null;
  return boundMailboxRow(prior)?.prepared.requestedNotBefore ?? null;
}

export async function enqueueManifestEmail(ctx: MutationCtx, input: ManifestPreparationInput, effect: ManifestEffect): Promise<MailboxEnqueueResult> {
  if (!effect.cause || effect.cause.startsWith("canon:sq1.email.v1:") || !Number.isSafeInteger(effect.index) || effect.index < 0) return refuse();
  const identity = await manifestIdentity(ctx, input);
  if (!identity) return refuse();
  const logicalKey = await effectKey(input, effect, identity.recipient.contactId);
  const logical = await existingEffect(ctx, input, effect, logicalKey, identity.recipient.contactId);
  if (logical && !("_id" in logical)) return logical;
  const key = await outboxKey({ orgId: input.orgId, module: { id: input.moduleId, title: "", outbound: undefined }, cause: effect.cause, index: effect.index, target: `address:${identity.recipient.address}` });
  const hit = logical ?? await ctx.db.query("outboundMessages").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key)).first();
  if (hit) {
    const m = boundMailboxRow(hit), history = boundMailboxRefusal(hit), prior = m?.prepared ?? history;
    if (!prior || history && history.kind !== "manifest.refusal.v1" || m && m.kind !== "manifest.automated-email.v1" || hit.orgId !== input.orgId || hit.module !== input.moduleId || hit.cause !== effect.cause
      || hit.idempotencyKey !== key || hit.fromUserId !== input.preparedBy || hit.mailboxEffectKey !== undefined && hit.mailboxEffectKey !== logicalKey
      || prior.recipient.contactId !== identity.recipient.contactId || prior.recipient.streamId !== identity.recipient.streamId || prior.recipient.address !== identity.recipient.address
      || prior.sender.id !== identity.sender.id || prior.sender.ownerId !== identity.sender.ownerId || prior.sender.address !== identity.sender.address) return refuse();
    const source = m?.kind === "manifest.automated-email.v1" ? m.moduleSource : history?.kind === "manifest.refusal.v1" ? history.moduleSource : undefined;
    if (source?.collection !== effect.source?.collection || source?.key !== effect.source?.key || source?.version !== effect.source?.version) return refuse();
    if ((history || m) && (hit.state === "refused" || hit.state === "suppressed")) return { ...historyVerdict(hit.state), id: hit._id, created: false };
    if (!m || m.kind !== "manifest.automated-email.v1" || (hit.state !== "queued" && hit.state !== "held")
      || m.prepared.grantId !== input.grantId || m.prepared.requestedNotBefore !== input.requestedNotBefore) return refuse();
    const verdict = await gate(ctx, m, hit);
    return verdict.state === "refused" || verdict.state === "suppressed" ? verdict : { id: hit._id, state: hit.state, created: false };
  }
  const preparation = await prepareManifestEmail(ctx, input);
  if (preparation.state === "refused") {
    const verdict = historyVerdict(preparation.code === "outbound.preparation.suppressed" ? "suppressed" : "refused");

    const id = await ctx.db.insert("outboundMessages", { orgId: input.orgId, module: input.moduleId, cause: effect.cause, ...(effect.about ? { about: effect.about } : {}),
      channel: "email", kind: "automated", fromUserId: input.preparedBy, to: { address: identity.recipient.address }, target: `address:${identity.recipient.address}`,
      rendered: { text: "" }, mailboxRefusal: { ...identity, ...(effect.source ? { moduleSource: effect.source } : {}) }, mailboxEffectKey: logicalKey, state: verdict.state, reason: verdict.text, notBefore: Date.now(), at: Date.now(), idempotencyKey: key });
    return { ...verdict, id, created: true };
  }
  const m: P4MailboxMetadata = { kind: "manifest.automated-email.v1", prepared: preparation.prepared, recipientMergeFields: preparation.recipientMergeFields, ...(effect.source ? { moduleSource: effect.source } : {}) }, verdict = await gate(ctx, m, null);
  const history = verdict.state === "refused" || verdict.state === "suppressed" ? historyVerdict(verdict.state) : verdict;
  const id = await insert(ctx, m, effect.cause, history, key, effect.about, logicalKey);
  if (verdict.state === "queued") await wake(ctx);
  return history.state === "queued" || history.state === "held" ? { id, state: history.state, created: true } : { ...history, id, created: true };
}

async function enqueueOwnerEmail(ctx: MutationCtx, input: OwnerEmailInput, effect: ManifestEffect, personal: boolean): Promise<OwnerEmailEnqueueResult> {
  if (!effect.cause || effect.cause.startsWith("canon:sq1.email.v1:") || !Number.isSafeInteger(effect.index) || effect.index < 0
    || !input.source || !input.source.collection || !input.source.key || !Number.isSafeInteger(input.source.version) || input.source.version < 1) return refuse();
  const identity = await manifestIdentity(ctx, input);
  if (!identity) return refuse();
  const logicalKey = await effectKey(input, effect, identity.recipient.contactId), logical = await existingEffect(ctx, input, effect, logicalKey, identity.recipient.contactId);
  if (logical && !("_id" in logical)) return logical;
  const key = await outboxKey({ orgId: input.orgId, module: { id: input.moduleId, title: "", outbound: undefined }, cause: effect.cause, index: effect.index, target: `address:${identity.recipient.address}` });
  const hit = logical ?? await ctx.db.query("outboundMessages").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key)).first();
  const purpose = personal ? "manual_action" : "automated_outreach";
  if (hit) {
    const m = boundMailboxRow(hit), history = boundMailboxRefusal(hit), prior = m?.prepared ?? history;
    if (!prior || hit.orgId !== input.orgId || hit.module !== input.moduleId || hit.cause !== effect.cause || hit.idempotencyKey !== key
      || hit.fromUserId !== input.preparedBy || hit.mailboxEffectKey !== logicalKey || prior.recipient.contactId !== identity.recipient.contactId
      || prior.recipient.streamId !== identity.recipient.streamId || prior.recipient.address !== identity.recipient.address || prior.sender.id !== identity.sender.id
      || prior.sender.ownerId !== identity.sender.ownerId || prior.sender.address !== identity.sender.address) return refuse();
    if (history?.kind === "owner.refusal.v1" && history.purpose === purpose && history.source.collection === input.source.collection && history.source.key === input.source.key && history.source.version === input.source.version) return { ...historyVerdict(hit.state === "suppressed" ? "suppressed" : "refused"), id: hit._id, created: false };
    if (!m || m.kind !== "owner.exact-email.v1" || m.prepared.purpose !== purpose || m.prepared.template.name !== input.template
      || m.prepared.source.collection !== input.source.collection || m.prepared.source.key !== input.source.key || m.prepared.source.version !== input.source.version
      || m.prepared.requestedNotBefore !== input.requestedNotBefore) return refuse();
    if (["refused", "suppressed"].includes(hit.state)) return { ...historyVerdict(hit.state === "suppressed" ? "suppressed" : "refused"), id: hit._id, created: false };
    if (!["awaiting_approval", "queued", "held"].includes(hit.state)) return refuse();
    const verdict = await gate(ctx, m, hit);
    return verdict.state === "refused" || verdict.state === "suppressed" ? verdict : { id: hit._id, state: hit.state as "awaiting_approval" | "queued" | "held", created: false };
  }
  const result = await (personal ? prepareOwnerPersonalEmail(ctx, input) : prepareOwnerAutomatedEmail(ctx, input));
  if (result.state === "refused") {
    const state = result.code.endsWith(".suppressed") ? "suppressed" : "refused", verdict = historyVerdict(state);
    const id = await ctx.db.insert("outboundMessages", { orgId: input.orgId, module: input.moduleId, cause: effect.cause, ...(effect.about ? { about: effect.about } : {}),
      channel: "email", kind: personal ? "personal" : "automated", fromUserId: input.preparedBy, to: { address: identity.recipient.address }, target: `address:${identity.recipient.address}`,
      rendered: { text: "" }, mailboxRefusal: { ...identity, kind: "owner.refusal.v1", purpose, source: input.source }, mailboxEffectKey: logicalKey,
      state, reason: "Exact owner email preparation was refused or suppressed. This history cannot be sent.", notBefore: Date.now(), at: Date.now(), idempotencyKey: key });
    return { ...verdict, id, created: true };
  }
  const m: P4MailboxMetadata = { kind: "owner.exact-email.v1", prepared: result.prepared };
  const verdict = await gate(ctx, m, null), id = await insert(ctx, m, effect.cause, verdict, key, effect.about, logicalKey);
  if (verdict.state === "refused" || verdict.state === "suppressed") return { ...verdict, id, created: true };
  await ctx.db.patch(id, { state: "awaiting_approval", reason: "Only the mailbox owner may approve this exact email." });
  return { id, state: "awaiting_approval", created: true };
}
export const enqueueOwnerPersonalEmail = (ctx: MutationCtx, input: OwnerEmailInput, effect: ManifestEffect) => enqueueOwnerEmail(ctx, input, effect, true);
export const enqueueOwnerAutomatedEmail = (ctx: MutationCtx, input: OwnerEmailInput, effect: ManifestEffect) => enqueueOwnerEmail(ctx, input, effect, false);

export async function approveOwnerEmail(ctx: MutationCtx, row: Doc<"outboundMessages">, ownerId: Id<"users">, expectedBindingHash: string) {
  const m = boundMailboxRow(row);
  if (!m || m.kind !== "owner.exact-email.v1" || m.prepared.sender.ownerId !== ownerId || m.prepared.bindingHash !== expectedBindingHash
    || !unclaimed(row) || !["awaiting_approval", "queued", "held"].includes(row.state)) return refuse();
  if (row.state !== "awaiting_approval" && !m.decision) return refuse();
  const verdict = await gate(ctx, m, row);
  if (verdict.state === "refused" || verdict.state === "suppressed") return verdict;
  if (m.decision) return { state: row.state };
  await ctx.db.patch(row._id, { mailbox: { ...m, decision: { ownerId, at: Date.now(), bindingHash: expectedBindingHash } }, state: verdict.state,
    reason: verdict.state === "held" ? verdict.text : undefined, notBefore: verdict.state === "held" ? verdict.notBefore : Math.max(Date.now(), m.prepared.requestedNotBefore), decidedBy: ownerId });
  if (verdict.state === "queued") await wake(ctx);
  return verdict;
}

export async function enqueueSq1Email(ctx: MutationCtx, requestId: Id<"outboxRequests">, actor: Sq1PreparerContext): Promise<MailboxEnqueueResult> {
  const request = await ctx.db.get(requestId);
  if (!request || request.orgId !== actor.orgId) return refuse();
  if ("outboundMessageId" in request && request.outboundMessageId) {
    const hit = await ctx.db.get(request.outboundMessageId), m = hit ? boundMailboxRow(hit) : null;
    if (!hit || (hit.state !== "queued" && hit.state !== "held") || !m || m.kind !== "sq1.email.v1" || m.request.requestId !== requestId || m.prepared.preparedBy !== actor.preparedBy) return refuse();
    const verdict = await gate(ctx, m, hit);
    if (verdict.state === "refused" || verdict.state === "suppressed") return verdict;
    const checked = await inspect(ctx, m.request, { prepared: m.prepared, row: { phase: "enqueue", outboundMessageId: hit._id } });
    if (!checked.allowed) return sq1Stop(checked.refused.text);
    return { id: hit._id, state: hit.state, created: false };
  }
  const preparation = await prepareSq1Email(ctx, requestId, actor);
  if (preparation.state === "refused") return preparation.code === "outbound.sq1_preparation.suppressed" ? { ...preparation, state: "suppressed" } : preparation;
  const m: P4MailboxMetadata = { kind: "sq1.email.v1", prepared: preparation.prepared, request: preparation.request, recipientMergeFields: preparation.recipientMergeFields };
  const verdict = await gate(ctx, m, null);
  if (verdict.state === "refused" || verdict.state === "suppressed") return verdict;
  const checked = await inspect(ctx, m.request, { prepared: m.prepared, row: { phase: "enqueue", outboundMessageId: null } });
  if (!checked.allowed) return sq1Stop(checked.refused.text);
  const key = await sq1RequestOutboxKey(request, m.prepared);
  if (await ctx.db.query("outboundMessages").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key)).first()) return refuse("The request already has an unmatched frozen row.");
  const id = await insert(ctx, m, sq1RequestCause(requestId), verdict, key);
  await bindPreparedRequest(ctx, checked.checked, id);
  if (verdict.state === "queued") await wake(ctx);
  return { id, state: verdict.state, created: true };
}

export async function claimMailboxEmail(ctx: MutationCtx, row: Doc<"outboundMessages">): Promise<Stop | Waiting | { state: "reserve_refused" } | { state: "claimed"; job: P4MailboxJob }> {
  const m = boundMailboxRow(row);
  if (!m || !["queued", "held"].includes(row.state) || m.kind === "owner.exact-email.v1" && (!m.decision || m.decision.ownerId !== m.prepared.sender.ownerId || m.decision.bindingHash !== m.prepared.bindingHash)
    || m.kind !== "sq1.email.v1" && row.cause.startsWith("canon:sq1.email.v1:")) return refuse();
  const verdict = await gate(ctx, m, row);
  if (verdict.state !== "queued") return verdict;
  const account = await ctx.db.get(m.prepared.sender.id);
  if (!account) return refuse();
  const attempt = (row.attempts ?? 0) + 1, p = m.prepared;
  if (m.kind === "sq1.email.v1") {
    const checked = await inspect(ctx, m.request, { prepared: m.prepared, row: { phase: "claim", outboundMessageId: row._id, nextAttempt: attempt } });
    if (!checked.allowed) return sq1Stop(checked.refused.text);
    const reserved = await reserve(ctx, checked.checked, row._id);
    if ("allowed" in reserved) return { state: "reserve_refused" };
  }
  const binding = { outboundMessageId: row._id, moduleId: p.moduleId, attempt, renderedHash: p.renderedHash };
  const outboxAttempt = m.kind === "sq1.email.v1" ? { ...binding, kind: m.kind, request: m.request } : { ...binding, kind: m.kind };
  const now = Date.now();
  const emailSendId = await ctx.db.insert("emailSends", { orgId: p.orgId, accountId: p.sender.id, userId: p.sender.ownerId,
    contactId: p.recipient.contactId, to: p.recipient.address, subject: p.delivery.subject, state: "sending", at: now, outboxAttempt, receiptRevision: 0 });
  await ctx.db.patch(row._id, { state: "sending", claimedAt: now, notBefore: now, attempts: attempt, error: undefined, providerId: undefined, reason: undefined,
    mailbox: { ...m, attempt: { emailSendId, attempt, receiptRevision: 0 } } });
  const expected = await readP4EmailAttempt(ctx, row._id);
  if (!expected) throw new Error("Mailbox claim did not persist its exact attempt pair");
  return { state: "claimed", job: { channel: "mailbox", expected, delivery: { prepared: p, emailSendId,
    account: { _id: account._id, orgId: account.orgId, userId: account.userId, address: account.address, status: account.status, unipileAccountId: account.unipileAccountId } } } };
}

export async function settleMailboxEmail(ctx: MutationCtx, expected: P4EmailAttemptRef, result: Delivery) {
  const recorded = await recordP4EmailResult(ctx, expected, result.ok ? { state: "sent", providerId: result.providerId }
    : { state: result.unknown ? "unknown" : "failed", error: result.error });
  if (recorded.state !== "refused" && recorded.settlement) {
    const accepted = await acceptDeliveryResult(ctx, recorded.settlement);
    if ("allowed" in accepted) throw new Error("The durable mailbox result lost its canonical SQ1 historical pair");
  }
  return { state: recorded.state };
}
