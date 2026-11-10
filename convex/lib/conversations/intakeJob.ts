/**
 * The background tray's job for an account's 90-day read (docs/conversation-intake.md): shown to the account's owner
 * only, started when they turn reading on, moved on by every backfill step (conversations.backfillAdvance) and
 * finished when the read is done. A read that began before these jobs existed gets one at its next step. Later
 * passes (the daily reconcile) have none: they take seconds and are not news.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { jobEntry } from "../runs";

export type IntakeFound = { channel: "linkedin"; row: Doc<"linkedinAccounts"> } | { channel: "email"; row: Doc<"emailAccounts"> };
/** What one backfill step read: conversations (LinkedIn chats) or emails stored, and the oldest activity it reached. */
export type StepRead = { read?: number; reachedAt?: number };

/** A job waits out its step's gap (or a pause) plus this long before the tray calls it stalled. */
const STALL_GRACE_MS = 15 * 60_000;

export const intakeHref = (channel: IntakeFound["channel"]) => `/dashboard/integrations/${channel === "email" ? "gmail" : "linkedin"}`;
const titleOf = (found: IntakeFound) => `Reading ${found.channel === "email" ? found.row.address : "LinkedIn messages"}: last 90 days`;
const noun = (channel: IntakeFound["channel"], n: number) => (channel === "email" ? (n === 1 ? "email" : "emails") : n === 1 ? "conversation" : "conversations");
/** A day as the tray shows it (Sep 22); the server knows no reader's time zone, so UTC. */
export const dayOf = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Read 97 emails, back to Sep 22"; a job started part-way through a read counts what it saw ("97 more"). */
export function progressOf(channel: IntakeFound["channel"], counters: Record<string, number> | undefined): string {
  const read = counters?.read ?? 0;
  const reached = counters?.reachedAt;
  if (!read && reached === undefined) return "Starting…";
  return `Read ${read.toLocaleString("en-US")}${counters?.late ? " more" : ""} ${noun(channel, read)}${reached === undefined ? "" : `, back to ${dayOf(reached)}`}`;
}

async function patchJobId(ctx: MutationCtx, found: IntakeFound, jobId: Doc<"backgroundJobs">["_id"] | undefined) {
  if (found.channel === "linkedin") await ctx.db.patch(found.row._id, { ingestJobId: jobId });
  else await ctx.db.patch(found.row._id, { ingestJobId: jobId });
}

/** The account's job, read afresh: a step may have just started one. */
async function jobOf(ctx: MutationCtx, found: IntakeFound) {
  const row = await ctx.db.get(found.row._id);
  const job = row?.ingestJobId ? await ctx.db.get(row.ingestJobId) : null;
  return job && job.orgId === found.row.orgId ? job : null;
}

/** Reading was turned on: a fresh job (the one before it, if still open, is closed as replaced). */
export async function startIntakeJob(ctx: MutationCtx, found: IntakeFound, now: number) {
  const before = await jobOf(ctx, found);
  if (before && (before.status === "processing" || before.status === "pending")) {
    await ctx.db.patch(before._id, { status: "completed", detail: `Started again. ${before.detail ?? ""}`.trim(), updatedAt: now, completedAt: now });
  }
  const jobId = await ctx.db.insert("backgroundJobs", {
    orgId: found.row.orgId, userId: found.row.userId, kind: "conversation_intake", title: titleOf(found), detail: "Starting…",
    href: intakeHref(found.channel), phases: [], status: "processing", startedAt: now, updatedAt: now, counters: { read: 0, waitingUntil: now + STALL_GRACE_MS },
  });
  await patchJobId(ctx, found, jobId);
}

/**
 * A backfill step finished: add what it read and note the wait until the next one. A read still in its 90-day
 * backfill without a job (it began before jobs existed) gets one now; one that stopped and is resumed opens again.
 * `pausedMs` is a pause (LinkedIn's pushback, Unipile down) rather than the usual gap.
 */
export async function advanceIntakeJob(ctx: MutationCtx, found: IntakeFound, now: number, step: StepRead, waitMs: number, pausedMs?: number) {
  if (found.row.ingestBackfilledAt !== undefined) return;
  let job = await jobOf(ctx, found);
  if (!job) {
    const jobId = await ctx.db.insert("backgroundJobs", {
      orgId: found.row.orgId, userId: found.row.userId, kind: "conversation_intake", title: titleOf(found),
      href: intakeHref(found.channel), phases: [], status: "processing", startedAt: now, updatedAt: now, counters: { read: 0, late: 1 },
    });
    await patchJobId(ctx, found, jobId);
    job = (await ctx.db.get(jobId))!;
  }
  const c = { ...job.counters };
  c.read = (c.read ?? 0) + (step.read ?? 0);
  if (step.reachedAt !== undefined && step.reachedAt >= (found.row.ingestSince ?? 0)) c.reachedAt = Math.min(c.reachedAt ?? step.reachedAt, step.reachedAt);
  c.waitingUntil = now + waitMs + STALL_GRACE_MS;
  const progress = progressOf(found.channel, c);
  await ctx.db.patch(job._id, {
    status: "processing", error: undefined, completedAt: undefined, counters: c, updatedAt: now,
    detail: pausedMs === undefined ? progress : `Paused for ${Math.max(1, Math.round(pausedMs / 60_000))} min, then reads on. ${progress}`,
  });
}

/** The read is over: done, turned off, or stopped with the reason why (and whether the daily pass resumes it). */
export async function finishIntakeJob(ctx: MutationCtx, found: IntakeFound, now: number, outcome: { done: true } | { off: true } | { error: string; resumes: boolean }) {
  const job = await jobOf(ctx, found);
  if (!job || job.status === "completed" || job.status === "failed") return;
  const progress = progressOf(found.channel, job.counters);
  const soFar = progress === "Starting…" ? "" : ` ${progress}.`;
  const close = { updatedAt: now, completedAt: now };
  if ("done" in outcome) {
    await ctx.db.patch(job._id, { status: "completed", detail: `Done.${soFar || " Nothing to read."} New messages are read as they arrive.`, ...close });
  } else if ("off" in outcome) {
    await ctx.db.patch(job._id, { status: "completed", detail: `Stopped: reading was turned off.${soFar}`, ...close });
  } else {
    await ctx.db.patch(job._id, { status: "failed", error: outcome.error, detail: `${outcome.error}${outcome.resumes ? " The daily pass reads on from here." : ""}${soFar}`, ...close });
  }
}

/** Conversations the settings panel counts exactly; past it, it says "200+". */
const COUNT_MAX = 200;

/**
 * What the "Read my messages" panel shows for one account: the switch and consent, the 90-day read's progress (its
 * tray job, stalled or stopped as the tray shows it), and how many conversations are kept.
 */
export async function intakeView(ctx: QueryCtx, row: Doc<"linkedinAccounts"> | Doc<"emailAccounts">) {
  const kept = await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", row._id)).take(COUNT_MAX + 1);
  const job = row.ingest && row.ingestBackfilledAt === undefined && row.ingestJobId ? await ctx.db.get(row.ingestJobId) : null;
  const entry = job && job.orgId === row.orgId ? jobEntry(job, Date.now()) : null;
  return {
    on: row.ingest === true,
    consentAt: row.ingestConsentAt ?? null,
    backfilledAt: row.ingestBackfilledAt ?? null,
    syncedAt: row.ingestSyncedAt ?? null,
    hasRead: kept.length > 0,
    conversations: Math.min(kept.length, COUNT_MAX),
    conversationsMore: kept.length > COUNT_MAX,
    progress: entry ? { failed: entry.status === "failed", detail: entry.detail ?? null } : null,
  };
}
