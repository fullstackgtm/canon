import type { Doc } from "../../_generated/dataModel";
import type { P4MailboxMetadata, P4MailboxRefusal } from "./mailboxTypes";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof v[k] === "string" && v[k] !== "");
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function mailboxMetadataShape(v: unknown): v is P4MailboxMetadata {
  if (!object(v) || Object.keys(v).some((k) => !["kind", "prepared", "request", "attempt", "recipientMergeFields", "decision", "moduleSource"].includes(k)) || !object(v.prepared)) return false;
  if (v.recipientMergeFields !== undefined && (!Array.isArray(v.recipientMergeFields) || v.recipientMergeFields.length > 3
    || v.recipientMergeFields.some((f) => !["name", "firstName", "email"].includes(f)))) return false;
  if ("moduleSource" in v && v.kind !== "manifest.automated-email.v1") return false;
  if (v.moduleSource !== undefined && (!object(v.moduleSource)
    || Object.keys(v.moduleSource).length !== 3 || !strings(v.moduleSource, ["collection", "key"]) || !time(v.moduleSource.version) || v.moduleSource.version < 1)) return false;
  const p = v.prepared;
  if (p.version !== 1 || !strings(p, ["orgId", "moduleId", "preparedBy", "canonicalMergeHash", "renderedHash"])
    || !time(p.requestedNotBefore) || !time(p.validUntil) || p.requestedNotBefore >= p.validUntil || p.thread !== null || p.companyStreamId !== null
    || !object(p.recipient) || !strings(p.recipient, ["contactId", "streamId", "address"])
    || !object(p.sender) || !strings(p.sender, ["id", "ownerId", "address", "mailboxLinkHash"])
    || !object(p.template) || !object(p.delivery) || !strings(p.delivery, ["subject", "text", "html"]) || !object(p.delivery.headers)
    || p.delivery.headers.inReplyTo !== null || !Array.isArray(p.delivery.headers.references) || p.delivery.headers.references.length !== 0) return false;
  if (v.attempt !== undefined && (!object(v.attempt) || !strings(v.attempt, ["emailSendId"]) || !time(v.attempt.attempt)
    || v.attempt.attempt < 1 || !time(v.attempt.receiptRevision) || v.attempt.receiptRevision > 1)) return false;
  if (v.kind === "owner.exact-email.v1") {
    if ("request" in v || "recipientMergeFields" in v || "grantId" in p || p.kind !== v.kind || !strings(p, ["bindingHash"]) || !time(p.preparedAt)
      || p.template.kind !== "manifest" || !strings(p.template, ["name", "version", "hash"]) || !time(p.template.epoch) || p.template.epoch < 1 || !object(p.source)
      || !strings(p.source, ["collection", "key", "hash"]) || !time(p.source.version) || p.source.version < 1
      || !Array.isArray(p.source.fields) || p.source.fields.length > 50 || p.source.fields.some((f) => typeof f !== "string")
      || !Array.isArray(p.recipientMergeFields) || p.recipientMergeFields.length > 3 || p.recipientMergeFields.some((f) => !["name", "firstName", "email"].includes(f))) return false;
    if (v.decision !== undefined && (!object(v.decision) || Object.keys(v.decision).length !== 3 || !strings(v.decision, ["ownerId", "bindingHash"])
      || !time(v.decision.at) || v.decision.ownerId !== p.sender.ownerId || v.decision.bindingHash !== p.bindingHash || v.decision.at < p.preparedAt || v.decision.at >= p.validUntil)) return false;
    return p.purpose === "manual_action" ? p.postalAddress === null && p.unsubscribe === null && p.delivery.headers.listUnsubscribe === null && p.delivery.headers.listUnsubscribePost === null
      : p.purpose === "automated_outreach" && typeof p.postalAddress === "string" && object(p.unsubscribe) && strings(p.unsubscribe, ["token", "url"])
        && typeof p.delivery.headers.listUnsubscribe === "string" && p.delivery.headers.listUnsubscribePost === "List-Unsubscribe=One-Click";
  }
  if ("decision" in v || !strings(p, ["grantId"])) return false;
  if (v.kind === "manifest.automated-email.v1") return !("request" in v) && p.kind === v.kind && p.purpose === "automated_outreach"
    && p.template.kind === "manifest" && strings(p.template, ["name", "hash"]);
  return v.kind === "sq1.email.v1" && !("kind" in p) && object(v.request) && Object.keys(v.request).length === 4
    && v.request.kind === "sq1.email.v1" && strings(v.request, ["requestId", "digest"]) && time(v.request.epoch) && v.request.epoch >= 1
    && /^[a-f0-9]{64}$/.test(v.request.digest as string) && object(p.template.authority) && p.template.authority.kind === "sq1.template-set.v1"
    && strings(p.template.authority, ["launchId", "hash"]) && strings(p.template, ["selectedHash"]) && object(p.template.selection)
    && strings(p.template.selection, ["stepKey", "variant"]) && time(p.template.selection.ordinal);
}

export function boundMailboxRow(row: Doc<"outboundMessages">): P4MailboxMetadata | null {
  const m = row.mailbox;
  if (row.mailboxRefusal !== undefined || !mailboxMetadataShape(m) || (m.kind === "sq1.email.v1" ? row.mailboxEffectKey !== undefined : row.cause.startsWith("canon:sq1.email.v1:"))) return null;
  const p = m.prepared;
  return row.channel === "email" && row.kind === (m.kind === "owner.exact-email.v1" && m.prepared.purpose === "manual_action" ? "personal" : "automated") && row.orgId === p.orgId && row.module === p.moduleId
    && row.fromUserId === p.preparedBy && "address" in row.to && row.to.address === p.recipient.address && row.target === `address:${p.recipient.address}`
    && row.rendered.subject === p.delivery.subject && row.rendered.text === p.delivery.text ? m : null;
}

export function boundMailboxRefusal(row: Doc<"outboundMessages">): P4MailboxRefusal | null {
  const h = row.mailboxRefusal;
  if (!object(h) || !object(h.recipient) || !strings(h.recipient, ["contactId", "streamId", "address"])
    || !object(h.sender) || !strings(h.sender, ["id", "ownerId", "address"])) return null;
  if (h.kind === "manifest.refusal.v1" && h.moduleSource !== undefined && (!object(h.moduleSource) || Object.keys(h.moduleSource).length !== 3
    || !strings(h.moduleSource, ["collection", "key"]) || !time(h.moduleSource.version) || h.moduleSource.version < 1)) return null;
  const owner = h.kind === "owner.refusal.v1" && ["manual_action", "automated_outreach"].includes(h.purpose as string)
    && object(h.source) && strings(h.source, ["collection", "key"]) && time(h.source.version) && h.source.version >= 1;
  return (h.kind === "manifest.refusal.v1" || owner) && !row.mailbox && !!row.mailboxEffectKey && !row.cause.startsWith("canon:sq1.email.v1:")
    && row.channel === "email" && row.kind === (owner && h.purpose === "manual_action" ? "personal" : "automated") && !!row.fromUserId && (row.state === "refused" || row.state === "suppressed")
    && row.claimedAt === undefined && (row.attempts === undefined || row.attempts === 0) && row.rendered.subject === undefined && row.rendered.text === ""
    && "address" in row.to && row.to.address === h.recipient.address && row.target === `address:${h.recipient.address}` ? h : null;
}

export const isMailboxRow = (row: Doc<"outboundMessages">) => row.mailbox !== undefined || row.mailboxRefusal !== undefined || row.mailboxEffectKey !== undefined || row.cause.startsWith("canon:sq1.email.v1:");
