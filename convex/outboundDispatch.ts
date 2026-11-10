/**
 * The outbox's dispatcher (docs/modules.md, "Outbound"). A per-minute tick and a wake after each write that queues a
 * row run `dispatch`: it claims due rows in a mutation, which runs the send gate again on each, then sends each claimed
 * row in this action through its channel's adapter (lib/outbound/adapters.ts) and settles it. Mutations serialize, so
 * a row is claimed once however many dispatchers run.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { installedModule, isEnabled, manifestOf } from "./lib/modules/packages";
import { sendPostmark, sendSlack, sendWebhook, type Delivery } from "./lib/outbound/adapters";
import { judge, type Draft } from "./lib/outbound/gate";
import { digestAt, gateReads, noticeMode, wake } from "./lib/outbound/queue";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { isMailboxRow } from "./lib/outbound/mailboxBinding";
import { claimMailboxEmail, settleMailboxEmail, type P4MailboxJob } from "./lib/outbound/mailboxQueue";
import { sendMailboxEmail } from "./lib/outbound/mailboxAdapter";
import { readP4EmailAttempt } from "./lib/outbound/mailboxReceipts";
import { p4EmailAttemptRef } from "./lib/outbound/mailboxTypes";
import { queuedByAutomation } from "./lib/automationOutbound";
import { activeRoleIn } from "./lib/membership";

/** Rows claimed per mutation, and claim rounds per dispatch before it hands on to a fresh one. */
const CLAIM_BATCH = 10;
const ROUNDS = 5;
/** Email and webhooks are tried 5 times: the waits after attempts 1 to 4. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** A row still sending this long after its claim died with its action. */
const LEASE_MS = 120_000;
/** A hold this close is woken for; a later one waits for the tick. */
const WAKE_WITHIN_MS = 60_000;

type Job =
  | P4MailboxJob
  | { ids: Id<"outboundMessages">[]; channel: "slack"; url: string; text: string }
  | { ids: Id<"outboundMessages">[]; channel: "webhook"; url: string; secret: string; id: string; body: string }
  | { ids: Id<"outboundMessages">[]; channel: "email"; to: string; subject: string; text: string };

/** The draft the gate judges a stored row by: its module as it is installed now, and whether a person approved it. */
async function draftOf(ctx: MutationCtx, row: Doc<"outboundMessages">): Promise<Draft | string> {
  let sender: Draft["module"] = null;
  if (row.module !== undefined) {
    const pkg = await installedModule(ctx, row.orgId, row.module);
    if (!pkg || !(await isEnabled(ctx, row.orgId, pkg.moduleId))) return "The module is off or uninstalled.";
    const m = manifestOf(pkg);
    sender = { id: pkg.moduleId, title: m.title, outbound: m.outbound };
  }
  if (queuedByAutomation(row)) {
    const as = row.fromUserId ? await ctx.db.get(row.fromUserId) : null;
    if (!(as && (await activeRoleIn(ctx, as, row.orgId)))) return "The admin this rule acts as is no longer a member";
  }
  const name = "slack" in row.to ? row.to.slack : "event" in row.to ? row.to.event : undefined;
  return {
    module: sender, channel: row.channel, kind: row.kind, from: "workspace", target: row.target, ...(name ? { name } : {}),
    rendered: { ok: true, rendered: row.rendered }, approval: row.approval, approved: row.decidedBy !== undefined,
    member: "member" in row.to ? row.to.member : undefined, digestAt: row.digest ? digestAt(row.at) : undefined, sendNow: row.sendNow,
  };
}

/** What the action sends for a claimed row: the channel's URL and secret still encrypted, an email's address read now. */
async function jobOf(ctx: MutationCtx, row: Doc<"outboundMessages">, ids: Id<"outboundMessages">[], digest: Doc<"outboundMessages">[]): Promise<Job | string> {
  if ("slack" in row.to) {
    const name = row.to.slack;
    const t = await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", row.orgId).eq("channel", "slack").eq("name", name)).first();
    return t ? { ids, channel: "slack", url: t.url, text: row.rendered.text } : `No Slack channel is mapped to ${name}.`;
  }
  if ("event" in row.to) {
    const t = row.to.endpoint ? await ctx.db.get(row.to.endpoint) : null;
    if (!t || t.orgId !== row.orgId || !t.secret) return "The webhook endpoint was removed.";
    let data: unknown;
    try { data = JSON.parse(row.rendered.text || "{}"); }
    catch { return "The webhook body isn't JSON."; }
    const body = JSON.stringify({ id: row._id, event: row.to.event, module: row.module ?? null, at: row.at, data });
    return { ids, channel: "webhook", url: t.url, secret: t.secret, id: row._id, body };
  }
  const address = "address" in row.to ? row.to.address : (await ctx.db.get(row.to.member))?.email;
  if (!address) return "The member has no email address.";
  if (!digest.length) return { ids, channel: "email", to: address, subject: row.rendered.subject ?? "A notice from Canon", text: row.rendered.text };
  const text = digest.map((r) => `${r.rendered.subject ?? ""}\n${r.rendered.text}`.trim()).join("\n\n---\n\n");
  return { ids, channel: "email", to: address, subject: `Your Canon digest: ${digest.length} ${digest.length === 1 ? "notice" : "notices"}`, text };
}

/** Claim due rows: each judged again, then `sending` (a digest's rows together, as one email). */
export const claim = internalMutation({
  args: {},
  handler: async (ctx): Promise<Job[]> => {
    const now = Date.now();
    const due = [
      ...(await ctx.db.query("outboundMessages").withIndex("by_state_and_notBefore", (q) => q.eq("state", "queued").lte("notBefore", now)).take(CLAIM_BATCH)),
      ...(await ctx.db.query("outboundMessages").withIndex("by_state_and_notBefore", (q) => q.eq("state", "held").lte("notBefore", now)).take(CLAIM_BATCH)),
    ];
    const jobs: Job[] = [];
    let nextHold = Infinity;
    for (const stale of due) {
      const row = await ctx.db.get(stale._id);
      if (!row || (row.state !== "queued" && row.state !== "held") || row.notBefore > now) continue;
      if (isMailboxRow(row)) {
        const verdict = await claimMailboxEmail(ctx, row);
        if (verdict.state === "claimed") jobs.push(verdict.job);
        else if (verdict.state !== "reserve_refused" && verdict.state !== "queued") {
          await ctx.db.patch(row._id, { state: verdict.state, reason: verdict.text, ...(verdict.state === "held" ? { notBefore: verdict.notBefore } : {}) });
          if (verdict.state === "held") nextHold = Math.min(nextHold, verdict.notBefore);
        }
        continue;
      }
      const member = "member" in row.to ? row.to.member : undefined;
      const digest = Boolean(row.digest && !row.sendNow && row.module && member && await noticeMode(ctx, row.orgId, member, row.module) === "digest");
      const candidates = digest
        ? (await ctx.db.query("outboundMessages").withIndex("by_digest", (q) => q.eq("digest", row.digest!)).take(100)).filter((r) =>
          !isMailboxRow(r) && r.orgId === row.orgId && r.channel === "email" && "member" in r.to && r.to.member === member && r.target === row.target &&
          (r.state === "held" || r.state === "queued") && r.notBefore <= now)
        : [row];
      if (!candidates.some((r) => r._id === row._id)) candidates.push(row);
      const claimed: Doc<"outboundMessages">[] = [];
      for (const candidate of candidates) {
        const draft = await draftOf(ctx, candidate);
        const verdict = typeof draft === "string" ? { state: "refused" as const, reason: draft } : await judge(draft, gateReads(ctx, candidate.orgId), now);
        if (verdict.state !== "queued") {
          await ctx.db.patch(candidate._id, { state: verdict.state, reason: verdict.reason, ...(verdict.state === "held" ? { notBefore: verdict.notBefore } : {}) });
          if (verdict.state === "held") nextHold = Math.min(nextHold, verdict.notBefore);
          continue;
        }
        if (digest && (candidate.sendNow || !candidate.module || await noticeMode(ctx, candidate.orgId, member!, candidate.module) !== "digest")) continue;
        // Reserve this row before judging its siblings, so they see its claim in their rate limits.
        await ctx.db.patch(candidate._id, { state: "sending", claimedAt: now, notBefore: now, attempts: (candidate.attempts ?? 0) + 1 });
        claimed.push(candidate);
      }
      if (!claimed.length) continue;
      const job = await jobOf(ctx, claimed[0], claimed.map((r) => r._id), digest ? claimed : []);
      if (typeof job === "string") {
        for (const r of claimed) await ctx.db.patch(r._id, { state: "failed", error: job });
      } else jobs.push(job);
    }
    if (nextHold - now <= WAKE_WITHIN_MS) await wake(ctx, Math.max(0, nextHold - now));
    return jobs;
  },
});

const deliveryResult = v.union(
  v.object({ ok: v.literal(true), providerId: v.string() }),
  v.object({ ok: v.literal(false), error: v.string(), retry: v.boolean(), unknown: v.optional(v.literal(true)) }),
);

/** Settle what an action sent: sent, unknown (never sent again), or queued again after a backoff, else failed. */
export const settle = internalMutation({
  args: { ids: v.array(v.id("outboundMessages")), result: deliveryResult },
  handler: async (ctx, { ids, result }) => {
    const now = Date.now();
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row || row.state !== "sending" || isMailboxRow(row)) continue;
      if (result.ok) { await ctx.db.patch(id, { state: "sent", providerId: result.providerId, error: undefined }); continue; }
      if (result.unknown) { await ctx.db.patch(id, { state: "unknown", error: result.error }); continue; }
      const attempts = row.attempts ?? 1;
      const wait = result.retry && row.channel !== "slack" && attempts < MAX_ATTEMPTS ? BACKOFF_MS[attempts - 1] : null;
      await ctx.db.patch(id, wait === null ? { state: "failed", error: result.error } : { state: "queued", notBefore: now + wait, error: result.error });
      if (wait !== null) await wake(ctx, wait);
    }
    return null;
  },
});

export const settleMailbox = internalMutation({
  args: { expected: p4EmailAttemptRef, result: deliveryResult },
  handler: async (ctx, { expected, result }): Promise<{ state: "recorded" | "duplicate" | "refused" }> => settleMailboxEmail(ctx, expected, result),
});

async function deliver(job: Job): Promise<Delivery> {
  try {
    if (job.channel === "mailbox") return await sendMailboxEmail(job.delivery);
    if (job.channel === "slack") return await sendSlack(await decryptFromStorage(job.url), job.text);
    if (job.channel === "webhook") return await sendWebhook({ url: await decryptFromStorage(job.url), secret: await decryptFromStorage(job.secret), id: job.id, body: job.body });
    return await sendPostmark({ to: job.to, subject: job.subject, text: job.text });
  } catch {
    return { ok: false, error: "Sending failed.", retry: job.channel === "webhook", ...(job.channel !== "webhook" ? { unknown: true as const } : {}) };
  }
}

/** Claim and send until nothing is due, then stop; a long queue hands on to a fresh run. */
export const dispatch = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    for (let round = 0; round < ROUNDS; round++) {
      const jobs: Job[] = await ctx.runMutation(internal.outboundDispatch.claim, {});
      if (!jobs.length) return null;
      for (const job of jobs) {
        const result = await deliver(job);
        if (job.channel === "mailbox") await ctx.runMutation(internal.outboundDispatch.settleMailbox, { expected: job.expected, result });
        else await ctx.runMutation(internal.outboundDispatch.settle, { ids: job.ids, result });
      }
    }
    await ctx.scheduler.runAfter(0, internal.outboundDispatch.dispatch, {});
    return null;
  },
});

/**
 * Every minute: a row still sending past its lease died with its action (a webhook, which the receiver dedupes, is
 * queued again; anything else may have gone and is unknown), and a dispatch runs when anything is due.
 */
export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const row of await ctx.db.query("outboundMessages").withIndex("by_state_and_notBefore", (q) => q.eq("state", "sending").lt("notBefore", now - LEASE_MS)).take(50)) {
      if (isMailboxRow(row)) {
        const expected = await readP4EmailAttempt(ctx, row._id);
        if (expected) await settleMailboxEmail(ctx, expected, { ok: false, retry: false, unknown: true, error: "Its send didn't finish, so it may have gone." });
        continue;
      }
      await ctx.db.patch(row._id, row.channel === "webhook" && (row.attempts ?? 1) < MAX_ATTEMPTS ? { state: "queued", notBefore: now } : { state: "unknown", error: "Its send didn't finish, so it may have gone." });
    }
    for (const state of ["queued", "held"] as const) {
      if (await ctx.db.query("outboundMessages").withIndex("by_state_and_notBefore", (q) => q.eq("state", state).lte("notBefore", now)).first()) return void (await wake(ctx));
    }
    return null;
  },
});
