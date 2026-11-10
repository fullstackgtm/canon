import { v, type Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
export type { P4SenderRef, P4GrantRef } from "./mailboxGrants";

export const requestAuthorizationRef = v.object({
  kind: v.literal("sq1.email.v1"), requestId: v.id("outboxRequests"), epoch: v.number(), digest: v.string(),
});
export type RequestAuthorizationRef = Infer<typeof requestAuthorizationRef>;
const recipient = v.object({ contactId: v.string(), streamId: v.id("canonEntities"), address: v.string() });
const recipientMergeFields = v.optional(v.array(v.union(v.literal("name"), v.literal("firstName"), v.literal("email"))));

const moduleSource = v.object({ collection: v.string(), key: v.string(), version: v.number() });
const refusalIdentity = { recipient, sender: v.object({ id: v.id("emailAccounts"), ownerId: v.id("users"), address: v.string() }) };
export const mailboxRefusal = v.union(
  v.object({ kind: v.literal("manifest.refusal.v1"), ...refusalIdentity, moduleSource: v.optional(moduleSource) }),
  v.object({ kind: v.literal("owner.refusal.v1"), ...refusalIdentity, purpose: v.union(v.literal("manual_action"), v.literal("automated_outreach")),
    source: v.object({ collection: v.string(), key: v.string(), version: v.number() }) }),
);
export type P4MailboxRefusal = Infer<typeof mailboxRefusal>;
const senderFields = { id: v.id("emailAccounts"), ownerId: v.id("users"), address: v.string(), mailboxLinkHash: v.string() };
const commonPrepared = {
  version: v.literal(1), orgId: v.id("organizations"), moduleId: v.string(), preparedBy: v.id("users"),
  recipient, grantId: v.id("mailboxSendGrants"), canonicalMergeHash: v.string(), renderedHash: v.string(),
  requestedNotBefore: v.number(), validUntil: v.number(),
};
const deliveryFields = { subject: v.string(), text: v.string(), html: v.string() };
export const preparedSq1Email = v.object({
  ...commonPrepared, companyStreamId: v.union(v.id("canonEntities"), v.null()), sender: v.object(senderFields),
  template: v.object({
    authority: v.object({ kind: v.literal("sq1.template-set.v1"), launchId: v.id("sequenceLaunches"), hash: v.string() }),
    selectedHash: v.string(), selection: v.object({ stepKey: v.string(), ordinal: v.number(), variant: v.string() }),
  }),
  delivery: v.object({ ...deliveryFields, headers: v.object({
    listUnsubscribe: v.union(v.string(), v.null()), listUnsubscribePost: v.union(v.literal("List-Unsubscribe=One-Click"), v.null()),
    inReplyTo: v.union(v.string(), v.null()), references: v.array(v.string()),
  }) }),
  thread: v.union(v.null(), v.object({ predecessorRequestId: v.id("outboxRequests"), providerId: v.string() })),
});
export type P4PreparedEmail = Infer<typeof preparedSq1Email>;
export type P4PreparedRequestBinding = {
  prepared: P4PreparedEmail;
  row: { phase: "enqueue"; outboundMessageId: Id<"outboundMessages"> | null }
    | { phase: "claim"; outboundMessageId: Id<"outboundMessages">; nextAttempt: number };
};

export const preparedManifestEmail = v.object({
  ...commonPrepared, kind: v.literal("manifest.automated-email.v1"), purpose: v.literal("automated_outreach"),
  preparedAt: v.number(), sender: v.object({ ...senderFields, name: v.string() }),
  template: v.object({ kind: v.literal("manifest"), name: v.string(), hash: v.string() }),
  companyStreamId: v.null(), postalAddress: v.string(), unsubscribe: v.object({ token: v.string(), url: v.string() }),
  delivery: v.object({ ...deliveryFields, headers: v.object({
    listUnsubscribe: v.string(), listUnsubscribePost: v.literal("List-Unsubscribe=One-Click"), inReplyTo: v.null(), references: v.array(v.string()),
  }) }),
  bindingHash: v.string(), thread: v.null(),
});
export type P4PreparedManifestEmail = Infer<typeof preparedManifestEmail>;

const ownerCommon = {
  version: v.literal(1), kind: v.literal("owner.exact-email.v1"), orgId: v.id("organizations"), moduleId: v.string(), preparedBy: v.id("users"),
  preparedAt: v.number(), recipient, sender: v.object({ ...senderFields, name: v.string() }), companyStreamId: v.null(),
  template: v.object({ kind: v.literal("manifest"), name: v.string(), version: v.string(), epoch: v.number(), hash: v.string() }),
  source: v.object({ collection: v.string(), key: v.string(), version: v.number(), hash: v.string(), fields: v.array(v.string()) }),
  recipientMergeFields: v.array(v.union(v.literal("name"), v.literal("firstName"), v.literal("email"))),
  canonicalMergeHash: v.string(), renderedHash: v.string(), bindingHash: v.string(), requestedNotBefore: v.number(), validUntil: v.number(), thread: v.null(),
};
export const preparedOwnerEmail = v.union(
  v.object({ ...ownerCommon, purpose: v.literal("manual_action"), postalAddress: v.null(), unsubscribe: v.null(),
    delivery: v.object({ ...deliveryFields, headers: v.object({ listUnsubscribe: v.null(), listUnsubscribePost: v.null(), inReplyTo: v.null(), references: v.array(v.string()) }) }) }),
  v.object({ ...ownerCommon, purpose: v.literal("automated_outreach"), postalAddress: v.string(), unsubscribe: v.object({ token: v.string(), url: v.string() }),
    delivery: v.object({ ...deliveryFields, headers: v.object({ listUnsubscribe: v.string(), listUnsubscribePost: v.literal("List-Unsubscribe=One-Click"), inReplyTo: v.null(), references: v.array(v.string()) }) }) }),
);
export type P4PreparedOwnerEmail = Infer<typeof preparedOwnerEmail>;
export const ownerEmailDecision = v.object({ ownerId: v.id("users"), at: v.number(), bindingHash: v.string() });

const attemptReceipt = v.object({ emailSendId: v.id("emailSends"), attempt: v.number(), receiptRevision: v.number() });

export const mailboxMetadata = v.union(
  v.object({ kind: v.literal("owner.exact-email.v1"), prepared: preparedOwnerEmail, decision: v.optional(ownerEmailDecision), attempt: v.optional(attemptReceipt) }),
  v.object({ kind: v.literal("sq1.email.v1"), prepared: preparedSq1Email, request: requestAuthorizationRef, attempt: v.optional(attemptReceipt), recipientMergeFields }),
  v.object({ kind: v.literal("manifest.automated-email.v1"), prepared: preparedManifestEmail, attempt: v.optional(attemptReceipt), recipientMergeFields,
    moduleSource: v.optional(moduleSource) }),
);
export type P4MailboxMetadata = Infer<typeof mailboxMetadata>;
const attemptFields = { outboundMessageId: v.id("outboundMessages"), moduleId: v.string(), attempt: v.number(), renderedHash: v.string() };
export const emailSendOutboxAttempt = v.union(
  v.object({ ...attemptFields, kind: v.literal("owner.exact-email.v1") }),
  v.object({ ...attemptFields, kind: v.literal("sq1.email.v1"), request: requestAuthorizationRef }),
  v.object({ ...attemptFields, kind: v.literal("manifest.automated-email.v1") }),
);
const receiptFields = { ...attemptFields, orgId: v.id("organizations"), emailSendId: v.id("emailSends"), receiptRevision: v.number() };
export const p4EmailAttemptRef = v.union(
  v.object({ ...receiptFields, kind: v.literal("owner.exact-email.v1") }),
  v.object({ ...receiptFields, kind: v.literal("sq1.email.v1"), request: requestAuthorizationRef }),
  v.object({ ...receiptFields, kind: v.literal("manifest.automated-email.v1") }),
);
export type P4EmailAttemptRef = Infer<typeof p4EmailAttemptRef>;
export type P4EmailOutcome = { state: "sent"; providerId: string } | { state: "failed" | "unknown"; error: string };
