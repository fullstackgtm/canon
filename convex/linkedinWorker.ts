/**
 * The LinkedIn sender (docs/linkedin-cadences.md, "Work"). Every few minutes
 * `tick` starts a run chain for each connected account that is inside its
 * sending window and has something due. A chain takes one action at a time:
 * `claim` checks the account's caps and picks the work in a transaction,
 * `runSender` makes the Unipile calls, `finish` records what happened and
 * schedules the next action after a random 45-180 s gap. One chain per
 * account holds `leaseUntil`; a chain with nothing left to do ends.
 *
 * Every limit comes from convex/lib/linkedin/limits.ts. Nothing here sends
 * outside the window, above a cap, or while LinkedIn is pushing back.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { suppressionFor } from "./lib/suppressions/store";
import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { unipileEnv } from "./linkedinActions";
import {
  inWindow, nextGapMs, nextInviteSlot, remaining, windowBounds,
} from "./lib/linkedin/limits";
import { afterConnected, afterMessage, chooseWork, render, withdrawDue, type Step } from "./lib/linkedin/cadence";
import { settleRetry } from "./lib/linkedin/outcomes";
import { ACTIVITY_LOOKUPS, activeWithinDaysOf, dormantReason, freshCheck, isDormant } from "./lib/linkedin/activity";
import { performInvite, performMessage, performSync, type EnrollmentRef, type Job, type Result } from "./lib/linkedin/perform";
import { createUnipileClient } from "./lib/linkedin/unipile";
import { logLinkedinEvent, type Rendered } from "./lib/signals/contactLog";
import { contactLog } from "./observations";
import { senderCapacity } from "./lib/linkedin/sender";
import { publishEnrollment, publishSender } from "./lib/linkedin/feedProjection";

const LEASE_MS = 10 * 60_000;
/** A claimed contact is not picked again for this long, in case the action dies mid-call. */
const CLAIM_MS = 15 * 60_000;
const SYNC_EVERY_MS = 4 * 3_600_000;
const SYNC_INVITED_MAX = 500;
const WITHDRAW_PER_SYNC = 5;
const DUE_SCAN = 50;
const PAUSED_RECHECK_MS = 3_600_000;
const ACCOUNTS_MAX = 500;
const WITHDRAW_AFTER_MS = 21 * 86_400_000;

// ───────────────────────────── Usage and caps ─────────────────────────────

const dueQuery = (ctx: QueryCtx, accountId: Id<"linkedinAccounts">, state: "queued" | "invited" | "connected", now: number) =>
  ctx.db.query("linkedinEnrollments").withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", accountId).eq("state", state).lte("nextAt", now));

function canRun(account: Doc<"linkedinAccounts">, now: number) {
  return account.status === "ok" && (account.holdUntil ?? 0) <= now && inWindow(now, account.window, account.timezone);
}

async function syncDue(ctx: QueryCtx, account: Doc<"linkedinAccounts">, now: number) {
  const overdue = await dueQuery(ctx, account._id, "invited", now).first();
  if (overdue) return true;
  if (account.lastSyncAt && now - account.lastSyncAt < SYNC_EVERY_MS) return false;
  return Boolean(await ctx.db.query("linkedinEnrollments").withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", account._id).eq("state", "invited")).first());
}

// ───────────────────────────── Tick ─────────────────────────────

/** Start a run chain for every sender with something due and no chain running. */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!integrationEnabled("unipile")) return null;
    const now = Date.now();
    const accounts = await ctx.db.query("linkedinAccounts").withIndex("by_status", (q) => q.eq("status", "ok")).take(ACCOUNTS_MAX);
    for (const account of accounts) {
      if ((account.leaseUntil ?? 0) > now || !canRun(account, now)) continue;
      const due =
        (await dueQuery(ctx, account._id, "connected", now).first()) ||
        ((account.inviteHoldUntil ?? 0) <= now && (account.nextInviteAt ?? 0) <= now && (await dueQuery(ctx, account._id, "queued", now).first())) ||
        (await syncDue(ctx, account, now));
      if (!due) continue;
      await ctx.db.patch(account._id, { leaseUntil: now + LEASE_MS });
      // Spread chain starts so senders don't all act on the cron's minute.
      await ctx.scheduler.runAfter(Math.floor(Math.random() * 120_000), internal.linkedinWorker.runSender, { accountId: account._id });
    }
  },
});

// ───────────────────────────── Claim ─────────────────────────────

/** This org's stored activity check for the person, if still fresh. */
async function storedActivity(ctx: QueryCtx, orgId: Id<"organizations">, e: Doc<"linkedinEnrollments">, now: number) {
  const row = e.providerId
    ? await ctx.db.query("linkedinActivity").withIndex("by_orgId_and_providerId", (q) => q.eq("orgId", orgId).eq("providerId", e.providerId!)).first()
    : await ctx.db.query("linkedinActivity").withIndex("by_orgId_and_publicIdentifier", (q) => q.eq("orgId", orgId).eq("publicIdentifier", e.publicIdentifier.toLowerCase())).first();
  return freshCheck(row, now);
}

/** A claimed job; a send carries what it renders, for the contact's log. */
type Claimed = (Extract<Job, { kind: "invite" | "message" }> & { rendered: Rendered }) | Extract<Job, { kind: "sync" | "skip" }>;

const refOf = (e: Doc<"linkedinEnrollments">): EnrollmentRef => ({ id: e._id, providerId: e.providerId ?? null, publicIdentifier: e.publicIdentifier, invitationId: e.invitationId ?? null });

async function release(ctx: MutationCtx, account: Doc<"linkedinAccounts"> | null) {
  if (account?.leaseUntil) await ctx.db.patch(account._id, { leaseUntil: undefined });
  return null;
}

/** Pick the sender's next action within today's budget, and claim it. Null ends the chain. */
export const claim = internalMutation({
  args: { accountId: v.id("linkedinAccounts") },
  handler: async (ctx, args): Promise<Claimed | null> => {
    const now = Date.now();
    const account = await ctx.db.get(args.accountId);
    if (!account || !canRun(account, now)) return release(ctx, account);
    const { usage, limits } = await senderCapacity(ctx, account, now);
    const budget = {
      invites: (account.inviteHoldUntil ?? 0) > now ? 0 : remaining(limits, usage, "invite"),
      messages: remaining(limits, usage, "message"),
      lookups: remaining(limits, usage, "lookup"),
    };
    const cadences = new Map<Id<"linkedinCadences">, Doc<"linkedinCadences"> | null>();
    const cadenceOf = async (id: Id<"linkedinCadences">) => {
      if (!cadences.has(id)) cadences.set(id, await ctx.db.get(id));
      return cadences.get(id) ?? null;
    };
    const firstLive = async (state: "queued" | "connected") => {
      for (const e of await dueQuery(ctx, account._id, state, now).take(DUE_SCAN)) {
        if (e.orgId !== account.orgId) continue;
        const suppressed = (await suppressionFor(ctx, account.orgId, { linkedinUrl: e.linkedinUrl }, "automated_outreach")).linkedin;
        if (suppressed.blocked) {
          await ctx.db.patch(e._id, { state: "stopped", reason: suppressed.text!, updatedAt: now });
          await publishEnrollment(ctx, e._id);
          continue;
        }
        const cadence = await cadenceOf(e.cadenceId);
        if (cadence?.orgId === account.orgId && cadence.status === "active") return e;
        // A paused cadence's people step aside for an hour, so they never block other cadences' due work.
        await ctx.db.patch(e._id, { nextAt: now + PAUSED_RECHECK_MS });
        await publishEnrollment(ctx, e._id);
      }
      return null;
    };
    // Invites are spread over the window: the first of the day lands at a random point of its share.
    const { start: windowStart, end: windowEnd } = windowBounds(now, account.window, account.timezone);
    let inviteAt = account.nextInviteAt;
    if (budget.invites > 0 && (inviteAt === undefined || inviteAt < windowStart)) {
      inviteAt = nextInviteSlot(Math.max(now, windowStart), windowEnd, budget.invites, Math.random());
      await ctx.db.patch(account._id, { nextInviteAt: inviteAt });
    }
    const message = budget.messages > 0 ? await firstLive("connected") : null;
    let invite = !message && budget.invites > 0 && budget.lookups > 0 && (inviteAt ?? 0) <= now ? await firstLive("queued") : null;
    // Recent activity: a fresh stored check decides now; otherwise the invite job checks, if today's lookups cover it.
    let activeWithinDays: number | null = null;
    if (invite) {
      const within = activeWithinDaysOf((await cadenceOf(invite.cadenceId))?.activeWithinDays);
      const stored = within === null ? null : await storedActivity(ctx, account.orgId, invite, now);
      if (within !== null && stored && isDormant(stored.lastActiveAt ?? null, now, within)) {
        await ctx.db.patch(invite._id, { state: "stopped", reason: dormantReason(stored.lastActiveAt ?? null, within), updatedAt: now });
        await publishEnrollment(ctx, invite._id);
        await ctx.db.patch(account._id, { leaseUntil: now + LEASE_MS });
        return { kind: "skip" };
      }
      if (within !== null && !stored) {
        if (budget.lookups >= ACTIVITY_LOOKUPS + (invite.providerId ? 0 : 1)) activeWithinDays = within;
        else invite = null;
      }
    }
    const work = chooseWork({ messageDue: Boolean(message), inviteDue: Boolean(invite), syncDue: await syncDue(ctx, account, now), budget });
    if (!work) return release(ctx, account);
    await ctx.db.patch(account._id, { leaseUntil: now + LEASE_MS, ...(work === "sync" ? { lastSyncAt: now } : {}) });

    if (work === "sync") {
      const invited = await ctx.db.query("linkedinEnrollments").withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", account._id).eq("state", "invited")).take(SYNC_INVITED_MAX);
      const overdue = invited.filter((e) => e.nextAt <= now).slice(0, WITHDRAW_PER_SYNC);
      // Push the overdue ones back so a failed sync doesn't spin on them.
      for (const e of overdue) {
        await ctx.db.patch(e._id, { nextAt: now + CLAIM_MS });
        await publishEnrollment(ctx, e._id);
      }
      return { kind: "sync", unipileAccountId: account.unipileAccountId, invited: invited.map(refOf), overdue: overdue.map(refOf), lookups: budget.lookups };
    }

    const e = (work === "message" ? message : invite)!;
    const steps = (await cadenceOf(e.cadenceId))!.steps as Step[];
    const step = steps[work === "invite" ? 0 : e.stepIndex];
    if (work === "message" && step?.kind !== "message") {
      // The cadence was shortened past this contact: nothing left to send.
      await ctx.db.patch(e._id, { state: "done", updatedAt: now });
      await publishEnrollment(ctx, e._id);
      return { kind: "skip" };
    }
    const out = render(step.kind === "invite" ? step.note ?? "" : step.body, e.vars);
    if ("missing" in out) {
      await ctx.db.patch(e._id, { state: "failed", reason: `No value for {{${out.missing[0]}}}`, updatedAt: now });
      await publishEnrollment(ctx, e._id);
      return { kind: "skip" };
    }
    await ctx.db.patch(e._id, { nextAt: now + CLAIM_MS });
    await publishEnrollment(ctx, e._id);
    // The exact text sent, kept with the step it came from: the cadence can be edited before finish runs.
    const rendered: Rendered = { enrollmentId: e._id, cadenceId: e.cadenceId, step: work === "invite" ? 0 : e.stepIndex, text: out.text };
    if (work === "invite") return { kind: "invite", unipileAccountId: account.unipileAccountId, enrollment: refOf(e), note: out.text || null, activeWithinDays, rendered };
    return {
      kind: "message",
      unipileAccountId: account.unipileAccountId,
      enrollment: { ...refOf(e), chatId: e.chatId ?? null, since: e.invitedAt ?? e.enrolledAt },
      text: out.text,
      rendered,
    };
  },
});

// ───────────────────────────── Run ─────────────────────────────

export const runSender = internalAction({
  args: { accountId: v.id("linkedinAccounts") },
  handler: async (ctx, args) => {
    const job: Claimed | null = await ctx.runMutation(internal.linkedinWorker.claim, { accountId: args.accountId });
    if (!job) return;
    const env = unipileEnv();
    let result: Result = { sends: [], events: [], effect: null };
    if (job.kind !== "skip") {
      if (!env) {
        await ctx.runMutation(internal.linkedinWorker.finish, { accountId: args.accountId, sends: [], events: [], effect: { holdMs: 3_600_000, reason: "LinkedIn isn't set up on this deployment." } });
        return;
      }
      const client = createUnipileClient(env);
      result = job.kind === "invite" ? await performInvite(client, job) : job.kind === "message" ? await performMessage(client, job) : await performSync(client, job);
    }
    const rendered = job.kind === "invite" || job.kind === "message" ? job.rendered : undefined;
    await ctx.runMutation(internal.linkedinWorker.finish, { accountId: args.accountId, ...result, ...(rendered ? { rendered } : {}) });
  },
});

// ───────────────────────────── Finish ─────────────────────────────

const eventValidator = v.union(
  v.object({ event: v.literal("invited"), id: v.id("linkedinEnrollments"), providerId: v.string(), invitationId: v.optional(v.string()) }),
  v.object({ event: v.literal("connected"), id: v.id("linkedinEnrollments"), providerId: v.optional(v.string()), accepted: v.boolean(), acceptedAt: v.optional(v.number()) }),
  v.object({ event: v.literal("sent"), id: v.id("linkedinEnrollments"), chatId: v.optional(v.string()), messageId: v.optional(v.string()) }),
  v.object({ event: v.literal("replied"), id: v.id("linkedinEnrollments") }),
  v.object({ event: v.literal("withdrawn"), id: v.id("linkedinEnrollments") }),
  v.object({ event: v.literal("retry"), id: v.id("linkedinEnrollments"), reason: v.string() }),
  v.object({ event: v.literal("fail"), id: v.id("linkedinEnrollments"), reason: v.string() }),
  v.object({ event: v.literal("activity"), id: v.id("linkedinEnrollments"), providerId: v.string(), lastActiveAt: v.union(v.number(), v.null()) }),
  v.object({ event: v.literal("dormant"), id: v.id("linkedinEnrollments"), reason: v.string() }),
);

/** Record the calls, move the contacts on, apply LinkedIn's pushback to the account, and schedule the next action. */
export const finish = internalMutation({
  args: {
    accountId: v.id("linkedinAccounts"),
    sends: v.array(v.object({
      kind: v.union(v.literal("lookup"), v.literal("invite"), v.literal("message"), v.literal("withdraw"), v.literal("sync")),
      ok: v.boolean(), error: v.optional(v.string()), enrollmentId: v.optional(v.id("linkedinEnrollments")),
    })),
    events: v.array(eventValidator),
    effect: v.union(v.null(), v.object({
      holdMs: v.optional(v.number()), inviteHoldMs: v.optional(v.number()),
      status: v.optional(v.union(v.literal("credentials"), v.literal("paused"))), reason: v.string(),
    })),
    rendered: v.optional(v.object({ enrollmentId: v.id("linkedinEnrollments"), cadenceId: v.id("linkedinCadences"), step: v.number(), text: v.string() })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const account = await ctx.db.get(args.accountId);
    if (!account) return;
    for (const s of args.sends) await ctx.db.insert("linkedinSends", { orgId: account.orgId, accountId: account._id, ...s, at: now });

    const inviteHoldUntil = args.effect?.inviteHoldMs ? now + args.effect.inviteHoldMs : undefined;
    const log = contactLog(ctx, account.orgId);
    const touched = new Set<Id<"linkedinEnrollments">>();
    for (const ev of args.events) {
      const e = await ctx.db.get(ev.id);
      if (!e || e.senderAccountId !== account._id) continue;
      touched.add(e._id);
      // What happened on LinkedIn is logged even when the enrollment was stopped while the call was in flight.
      await logLinkedinEvent(log, ev, e, args.sends, args.rendered, now);
      if (ev.event === "activity") {
        await saveActivity(ctx, account.orgId, ev.providerId, e.publicIdentifier, ev.lastActiveAt, now);
        continue;
      }
      // Stopped by hand (or archived) while the call was in flight: leave it stopped.
      if (!["queued", "invited", "connected"].includes(e.state)) continue;
      const cadence = await ctx.db.get(e.cadenceId);
      const steps = (cadence?.steps ?? []) as Step[];
      const base = { updatedAt: now, reason: undefined, attempts: undefined };
      switch (ev.event) {
        case "invited":
          await ctx.db.patch(e._id, { ...base, state: "invited", stepIndex: 1, providerId: ev.providerId || e.providerId, invitationId: ev.invitationId, invitedAt: now, nextAt: now + WITHDRAW_AFTER_MS });
          break;
        case "connected": {
          const next = afterConnected(steps, e.stepIndex, now);
          // LinkedIn's connection time, when it is plausible: after the invite and not in the future.
          const acceptedAt = ev.acceptedAt && e.invitedAt && ev.acceptedAt >= e.invitedAt && ev.acceptedAt <= now ? ev.acceptedAt : undefined;
          await ctx.db.patch(e._id, { ...base, ...next, ...(ev.providerId ? { providerId: ev.providerId } : {}), connectedAt: now, ...(acceptedAt ? { acceptedAt } : {}) });
          if (ev.accepted) await ctx.db.insert("linkedinSends", { orgId: account.orgId, accountId: account._id, enrollmentId: e._id, kind: "accepted", ok: true, at: now });
          break;
        }
        case "sent": {
          const next = afterMessage(steps, e.stepIndex, now);
          await ctx.db.patch(e._id, { ...base, ...next, lastSentAt: now, ...(ev.chatId ? { chatId: ev.chatId } : {}) });
          break;
        }
        case "replied":
          await ctx.db.patch(e._id, { ...base, state: "replied" });
          break;
        case "withdrawn":
          await ctx.db.patch(e._id, { ...base, state: "withdrawn", reason: "Not accepted in 21 days; invite withdrawn" });
          break;
        case "retry": {
          const r = settleRetry(e.attempts ?? 0, ev.reason, now, inviteHoldUntil);
          await ctx.db.patch(e._id, r.state === "failed" ? { state: "failed", reason: r.reason, updatedAt: now } : { attempts: r.attempts, nextAt: r.nextAt, reason: r.reason, updatedAt: now });
          break;
        }
        case "fail":
          await ctx.db.patch(e._id, { ...base, state: "failed", reason: ev.reason });
          break;
        case "dormant":
          await ctx.db.patch(e._id, { ...base, state: "stopped", reason: ev.reason, ...(e.providerId ? {} : { providerId: providerIdOf(args.events, e._id) }) });
          break;
      }
    }

    const effect = args.effect;
    const patch: Partial<Doc<"linkedinAccounts">> = { updatedAt: now };
    // Only an invite actually attempted uses up a slot; a skipped one (already connected, lookup failed) leaves it free.
    if (args.sends.some((s) => s.kind === "invite")) {
      const { usage, limits } = await senderCapacity(ctx, account, now);
      patch.nextInviteAt = nextInviteSlot(now, windowBounds(now, account.window, account.timezone).end, remaining(limits, usage, "invite"), Math.random());
    }
    if (effect?.status) Object.assign(patch, { status: effect.status, statusReason: effect.reason });
    if (effect?.holdMs) Object.assign(patch, { holdUntil: now + effect.holdMs, holdReason: effect.reason });
    if (inviteHoldUntil) Object.assign(patch, { inviteHoldUntil, holdReason: effect!.reason });
    const stillOk = (patch.status ?? account.status) === "ok" && !(effect?.holdMs);
    if (stillOk) {
      const gap = nextGapMs(Math.random());
      patch.leaseUntil = now + gap + LEASE_MS;
      await ctx.scheduler.runAfter(gap, internal.linkedinWorker.runSender, { accountId: account._id });
    } else {
      patch.leaseUntil = undefined;
    }
    await ctx.db.patch(account._id, patch);
    for (const id of touched) await publishEnrollment(ctx, id);
    await publishSender(ctx, account._id, now);
  },
});

/** One stored check per org and person: the newest replaces the last. */
async function saveActivity(ctx: MutationCtx, orgId: Id<"organizations">, providerId: string, publicIdentifier: string, lastActiveAt: number | null, now: number) {
  const row = { orgId, providerId, publicIdentifier: publicIdentifier.toLowerCase(), lastActiveAt: lastActiveAt ?? undefined, checkedAt: now };
  const existing = await ctx.db.query("linkedinActivity").withIndex("by_orgId_and_providerId", (q) => q.eq("orgId", orgId).eq("providerId", providerId)).first();
  if (existing) await ctx.db.replace(existing._id, row);
  else await ctx.db.insert("linkedinActivity", row);
}

const providerIdOf = (events: readonly { event: string; id: string; providerId?: string }[], id: string) =>
  events.find((ev) => ev.id === id && ev.event === "activity")?.providerId;

/**
 * A LinkedIn reply from Unipile's messaging webhook (lib/linkedin/inbound.ts, DP4): the sender's enrollment with that
 * person is marked replied at once, and the reply logged on the contact, instead of waiting for their next step.
 */
export const inboundReply = internalMutation({
  args: { unipileAccountId: v.string(), senderProviderId: v.string(), chatId: v.string(), messageId: v.string(), at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const account = await ctx.db.query("linkedinAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    if (!account) return false;
    const enrollments = await ctx.db.query("linkedinEnrollments")
      .withIndex("by_senderAccountId_and_providerId", (q) => q.eq("senderAccountId", account._id).eq("providerId", args.senderProviderId))
      .take(10);
    // The newest enrollment with them; an active one ends here.
    const e = enrollments.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!e) return false;
    const now = Date.now();
    // Every reply is logged, once per LinkedIn message: a second reply after our follow-up moves the thread again.
    const log = contactLog(ctx, account.orgId);
    const key = `linkedin:reply:${args.messageId}`;
    if (await log.has(e.contactId, key)) return true;
    const at = args.at && args.at <= now ? args.at : now;
    await log.append(e.contactId, { body: { type: "linkedin", key, event: { kind: "reply_received", cadenceId: e.cadenceId } }, observedAt: now, occurredAt: at });
    await ctx.scheduler.runAfter(0, internal.dealPlayKeeper.onReply, { orgId: account.orgId, contactId: e.contactId });
    if (["queued", "invited", "connected"].includes(e.state)) {
      await ctx.db.patch(e._id, { state: "replied", updatedAt: now, reason: undefined, attempts: undefined, ...(e.chatId ? {} : { chatId: args.chatId }) });
    }
    await publishEnrollment(ctx, e._id);
    await publishSender(ctx, account._id, now);
    return true;
  },
});
