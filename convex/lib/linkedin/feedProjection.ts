import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { memberLink, putFeedItem } from "../connectors/feeds";
import { linkedin, LINKEDIN_SENDERS, LINKEDIN_TOUCHES } from "../connectors/linkedin";
import { senderCapacity } from "./sender";

type SenderCapacity = Awaited<ReturnType<typeof senderCapacity>>;
type SenderFields = keyof typeof linkedin.feeds[typeof LINKEDIN_SENDERS]["fields"];
type TouchFields = keyof typeof linkedin.feeds[typeof LINKEDIN_TOUCHES]["fields"];
type LegacyTouch = Record<TouchFields, unknown> & { source: "legacy_cadence"; repliedAt: null };

export function senderData(account: Doc<"linkedinAccounts">, today: SenderCapacity, now: number) {
  return {
    profileName: account.profileName ?? null,
    status: account.status,
    statusReason: account.statusReason ?? null,
    tier: account.tier,
    timezone: account.timezone,
    window: { days: account.window.days, startMinute: account.window.startMinute, endMinute: account.window.endMinute },
    limits: today.limits,
    usage: today.usage,
    pendingInvites: today.pending,
    acceptance: today.acceptance,
    health: today.health,
    hold: (account.holdUntil ?? 0) > now ? { until: account.holdUntil!, reason: account.holdReason ?? null } : null,
    inviteHold: (account.inviteHoldUntil ?? 0) > now ? { until: account.inviteHoldUntil!, reason: account.holdReason ?? null } : null,
    rampStep: account.rampStep,
    connectedAt: account.connectedAt,
  } satisfies Record<SenderFields, unknown>;
}

export function legacyTouchData(enrollment: Doc<"linkedinEnrollments">, cadence: Doc<"linkedinCadences">) {
  return {
    source: "legacy_cadence",
    contact: { id: enrollment.contactId, name: enrollment.contactName },
    sender: enrollment.senderAccountId,
    requester: { kind: "legacy_cadence", key: cadence._id, label: cadence.name, status: cadence.status },
    state: enrollment.state,
    stepIndex: enrollment.stepIndex,
    nextAt: enrollment.nextAt,
    reason: enrollment.reason ?? null,
    enrolledAt: enrollment.enrolledAt,
    invitedAt: enrollment.invitedAt ?? null,
    connectedAt: enrollment.connectedAt ?? null,
    acceptedAt: enrollment.acceptedAt ?? null,
    lastSentAt: enrollment.lastSentAt ?? null,
    repliedAt: null,
  } satisfies LegacyTouch;
}

export async function publishSender(ctx: MutationCtx, accountId: Id<"linkedinAccounts">, now = Date.now()) {
  const account = await ctx.db.get(accountId);
  if (!account) return;
  const link = await memberLink(ctx, account.orgId, linkedin.id, account.userId);
  if (link.status === "revoked") return;
  const existing = await ctx.db.query("feedItems").withIndex("by_orgId_and_feed_and_itemId", (q) => q.eq("orgId", account.orgId).eq("feed", LINKEDIN_SENDERS).eq("itemId", account._id)).unique();
  const result = await putFeedItem(ctx, link, LINKEDIN_SENDERS, {
    id: account._id,
    data: senderData(account, await senderCapacity(ctx, account, now), now),
  });
  if (!existing && result.status === "written") await ctx.scheduler.runAfter(0, internal.linkedinFeeds.backfillSender, { accountId: account._id });
}

export async function publishEnrollment(ctx: MutationCtx, enrollmentId: Id<"linkedinEnrollments">) {
  const enrollment = await ctx.db.get(enrollmentId);
  if (!enrollment) return;
  const [account, cadence] = await Promise.all([ctx.db.get(enrollment.senderAccountId), ctx.db.get(enrollment.cadenceId)]);
  if (!account || !cadence || account.orgId !== enrollment.orgId || cadence.orgId !== enrollment.orgId || cadence.senderAccountId !== account._id) return;
  const link = await memberLink(ctx, account.orgId, linkedin.id, account.userId);
  await putFeedItem(ctx, link, LINKEDIN_TOUCHES, {
    id: `legacy:${enrollment._id}`,
    data: legacyTouchData(enrollment, cadence),
  });
}
