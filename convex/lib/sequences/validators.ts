import { v } from "convex/values";

export const sq1Projection = v.object({
  collection: v.string(), key: v.string(),
  fields: v.record(v.string(), v.any()),
  absent: v.array(v.string()), ownerUserId: v.optional(v.id("users")),
  parentKey: v.optional(v.string()), gen: v.optional(v.number()),
  gens: v.optional(v.record(v.string(), v.number())),
});

export const sq1Step = v.object({
  key: v.string(), ordinal: v.number(), occurrence: v.literal(0),
  kind: v.union(v.literal("auto_email"), v.literal("manual_email"), v.literal("call"), v.literal("task"), v.literal("linkedin_task")),
  delayDays: v.number(), thread: v.boolean(),
  variants: v.array(v.object({ key: v.string(), weight: v.number(), subject: v.string(), body: v.string(), templateHash: v.string() })),
});

export const sequenceLaunchFields = {
  orgId: v.id("organizations"), moduleId: v.string(), moduleSequenceKey: v.string(),
  revision: v.number(), authorizationEpoch: v.number(),
  state: v.union(v.literal("active"), v.literal("paused"), v.literal("archived"), v.literal("finished")),
  approvedBy: v.id("users"), approvedAt: v.number(), packageEpoch: v.number(),
  projection: sq1Projection, sources: v.array(sq1Projection),
  approvedPlan: v.object({
    steps: v.array(sq1Step), settings: v.record(v.string(), v.any()),
    schedule: v.object({ days: v.array(v.number()), start: v.string(), end: v.string(), timeZone: v.string(), holidays: v.array(v.string()) }),
  }),
  planDigest: v.string(), templateSetVersion: v.literal(1),
  approvedTemplates: v.array(v.object({ step: v.object({ key: v.string(), ordinal: v.number() }), variant: v.string(), channel: v.literal("email"), templateHash: v.string() })),
  templateSetHash: v.string(), approvedSenderRefs: v.array(v.id("emailAccounts")),
  allowedChannels: v.array(v.literal("email")), totalRequestCap: v.number(), reservedRequests: v.number(),
};

export const sequenceEnrollmentFields = {
  orgId: v.id("organizations"), moduleId: v.string(), launchId: v.id("sequenceLaunches"),
  moduleEnrollmentKey: v.string(), identityKey: v.string(), contactId: v.string(), assignedRep: v.id("users"),
  revision: v.number(), state: v.union(v.literal("pending"), v.literal("active"), v.literal("paused"), v.literal("finished")),
  currentStep: v.object({ stepKey: v.string(), ordinal: v.number(), occurrence: v.literal(0) }),
  currentRequestId: v.optional(v.id("outboxRequests")), projection: sq1Projection,
  finishReason: v.optional(v.string()), finishedAt: v.optional(v.number()),
};

const requestIdentity = {
  orgId: v.id("organizations"), moduleId: v.string(), launchId: v.id("sequenceLaunches"), enrollmentId: v.id("sequenceEnrollments"),
  stepKey: v.string(), ordinal: v.number(), occurrence: v.literal(0), authorizationEpoch: v.number(), revision: v.number(),
  projection: v.optional(sq1Projection), requestedNotBefore: v.number(),
};

const frozenRequest = v.object({
  digest: v.string(), contactId: v.string(), contactStreamId: v.id("canonEntities"), normalizedAddress: v.string(),
  senderId: v.id("emailAccounts"), ownerId: v.id("users"), mailboxLinkHash: v.string(), grantId: v.id("mailboxSendGrants"),
  templateSetHash: v.string(), variant: v.string(), selectedTemplateHash: v.string(), canonicalMergeHash: v.string(),
  renderedHash: v.string(), validUntil: v.number(),
  thread: v.union(v.null(), v.object({ predecessorRequestId: v.id("outboxRequests"), providerId: v.string() })),
});

export const outboxRequest = v.union(
  v.object({ ...requestIdentity, state: v.literal("preparing") }),
  v.object({ ...requestIdentity, state: v.union(v.literal("withdrawn"), v.literal("invalidated")), frozen: v.optional(frozenRequest), outboundMessageId: v.optional(v.id("outboundMessages")) }),
  v.object({ ...requestIdentity, state: v.literal("ready"), frozen: frozenRequest, outboundMessageId: v.id("outboundMessages") }),
  v.object({
    ...requestIdentity, state: v.union(v.literal("reserved"), v.literal("sent"), v.literal("failed"), v.literal("unknown")),
    frozen: frozenRequest, outboundMessageId: v.id("outboundMessages"), reservedAt: v.number(),
    result: v.optional(v.object({ emailSendId: v.id("emailSends"), attempt: v.number(), receiptRevision: v.number(), recordedAt: v.number() })),
  }),
);
