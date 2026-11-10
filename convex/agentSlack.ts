/**
 * Slack for agent turns. The org's incoming-webhook URL is stored like
 * Instantly's key: encrypted on its `integrations` row, read only by the
 * functions here, never returned to a client or written to a log or error.
 * Delivery is best effort: a turn never waits for it and never fails because of
 * it; the outcome (sent, or failed with the HTTP status) is recorded on the turn.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";
import { appUrl } from "./lib/operatorConfig";
import { postToSlack, shouldNotify, slackMessage, webhookUrlProblem, type SlackDelivery } from "./lib/agents/slack";
import { withEventDefinition } from "./lib/agents/definitions";
import { standing } from "./agents";
import { PAUSE_REASONS, isOwnerCaused } from "./lib/agents/standing";

/** A local stack (its own site URL is loopback) may point the webhook at a local receiver; a deployment may not. */
const allowLoopback = () => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(process.env.CONVEX_SITE_URL ?? "");

const slackRow = (ctx: QueryCtx, orgId: Id<"organizations">) =>
  ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "slack")).first();

/** Whether Slack is connected: never the URL. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const row = user && (await slackRow(ctx, user.orgId));
    return { connected: Boolean(row?.isActive), connectedAt: row?.connectedAt ?? null };
  },
});

export const storeUrl = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), url: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptForStorage(args.url);
    const existing = await slackRow(ctx, args.orgId);
    if (existing) {
      await ctx.db.patch(existing._id, { accessToken: encrypted, isActive: true, connectedBy: args.userId, connectedAt: now, updatedAt: now });
      return;
    }
    await ctx.db.insert("integrations", {
      orgId: args.orgId, provider: "slack", accessToken: encrypted, refreshToken: await encryptForStorage(""),
      isActive: true, connectedBy: args.userId, connectedAt: now, createdAt: now, updatedAt: now,
    });
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const row = await slackRow(ctx, user.orgId);
    if (row) await ctx.db.patch(row._id, { isActive: false, accessToken: await encryptForStorage(""), updatedAt: Date.now() });
  },
});

/** The encrypted URL, for the functions here only. */
export const urlCipher = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const row = await slackRow(ctx, args.orgId);
    return row && row.isActive ? row.accessToken : null;
  },
});

async function manager(ctx: ActionCtx) {
  const caller = await ctx.runQuery(internal.audiences.caller, {});
  if (!caller) throw new ConvexError("Not authenticated");
  if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return caller;
}

/** Connect Slack: the URL is checked for shape (nothing is sent), then stored encrypted. */
export const connect = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await manager(ctx);
    const url = args.url.trim();
    const problem = webhookUrlProblem(url, allowLoopback());
    if (problem) throw new ConvexError(problem);
    await ctx.runMutation(internal.agentSlack.storeUrl, { orgId: caller.orgId, userId: caller.userId, url });
    return { ok: true };
  },
});

/** Post a test message to the connected webhook. */
export const sendTest = action({
  args: {},
  handler: async (ctx): Promise<SlackDelivery> => {
    const caller = await manager(ctx);
    const cipher: string | null = await ctx.runQuery(internal.agentSlack.urlCipher, { orgId: caller.orgId });
    if (!cipher) throw new ConvexError("Slack is not connected. Add a webhook URL first.");
    return postToSlack(await decryptFromStorage(cipher), "Canon test message: this channel will get agent turn notifications.");
  },
});

/**
 * The agent with its Slack settings when it may post: it opted in and may act now. A paused or archived agent posts
 * nothing, whatever paused it, with one exception: `pauseAt` names the system pause it stands under now, and this is
 * that pause's one notice. Turns (notification) and the pause notice (preparePause) both ask here.
 */
async function slackAgent(ctx: MutationCtx, principal: Doc<"agents">, pauseAt?: number) {
  const agent = await withEventDefinition(ctx, principal);
  if (!agent.slack) return null;
  const p = principal.pause;
  const notice = pauseAt !== undefined && principal.archivedAt === undefined && p?.at === pauseAt && !p.by && isOwnerCaused(p.reason);
  if (!notice && (await standing(ctx, principal)).status !== "active") return null;
  return agent;
}

/**
 * The turn and its agent when the turn is worth a message: the agent opted in for this kind of turn and may act now.
 * Its skipped turns stay in its history. notifyTurn (queue a send) and prepare (send it) both ask here.
 */
async function notification(ctx: MutationCtx, turnId: Id<"agentTurns">) {
  const turn = await ctx.db.get(turnId);
  const principal = turn && (await ctx.db.get(turn.agentId));
  if (!turn || turn.slack || !principal || principal.orgId !== turn.orgId) return null;
  const agent = await slackAgent(ctx, principal);
  if (!agent?.slack || !shouldNotify(agent.slack.mode, { status: turn.status, routing: turn.routing, hasRoute: Boolean(agent.route) })) return null;
  return { turn, agent };
}

/**
 * After a turn reaches an end state (and, for a routed turn, after its routing
 * is recorded): queue a message if it is worth one (notification).
 */
export async function notifyTurn(ctx: MutationCtx, turnId: Id<"agentTurns">): Promise<void> {
  if (await notification(ctx, turnId)) await ctx.scheduler.runAfter(0, internal.agentSlack.send, { turnId });
}

/** Claim the turn's one notification and build its message. Null when there is nothing to send. */
export const prepare = internalMutation({
  args: { turnId: v.id("agentTurns") },
  handler: async (ctx, args): Promise<{ cipher: string; text: string } | null> => {
    const found = await notification(ctx, args.turnId);
    if (!found) return null;
    const { turn, agent } = found;
    const row = await slackRow(ctx, turn.orgId);
    const cipher = row && row.isActive ? row.accessToken : null;
    if (!cipher) {
      await ctx.db.patch(turn._id, { slack: { status: "failed", error: "Slack is not connected", at: Date.now() } });
      return null;
    }
    const audience = turn.routing?.audienceId ? await ctx.db.get(turn.routing.audienceId) : null;
    const origin = appUrl();
    await ctx.db.patch(turn._id, { slack: { status: "sending", at: Date.now() } });
    return {
      cipher,
      text: slackMessage({
        // The account only as the turn found it through its owner's reads (CP14). A webhook's domain is the sender's;
        // a deal event's is the deal's account, which a turn kept before CP14 even when its owner could not see it.
        agentLabel: agent.label, trigger: turn.trigger, status: turn.status, account: turn.account,
        subjectDomain: turn.trigger === "crm_event" ? undefined : turn.subject.domain,
        skipMessage: turn.skip?.message, error: turn.error, outputs: turn.outputs, routing: turn.routing,
        audienceName: audience && audience.orgId === turn.orgId ? audience.name : null,
        link: origin ? `${origin}/dashboard/agents#turn-${turn._id}` : null,
      }),
    };
  },
});

export const record = internalMutation({
  args: { turnId: v.id("agentTurns"), ok: v.boolean(), httpStatus: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.turnId, {
      slack: { status: args.ok ? "sent" : "failed", at: Date.now(), ...(args.httpStatus ? { httpStatus: args.httpStatus } : {}), ...(args.error ? { error: args.error } : {}) },
    });
  },
});

export const send = internalAction({
  args: { turnId: v.id("agentTurns") },
  handler: async (ctx, args): Promise<null> => {
    const job: { cipher: string; text: string } | null = await ctx.runMutation(internal.agentSlack.prepare, args);
    if (!job) return null;
    let result: SlackDelivery;
    try {
      result = await postToSlack(await decryptFromStorage(job.cipher), job.text);
    } catch {
      result = { ok: false, error: "could not read the stored URL" };
    }
    await ctx.runMutation(internal.agentSlack.record, { turnId: args.turnId, ...result });
    return null;
  },
});

/**
 * The one message for a pause the system latched (agents.ts actingAgent), whatever the agent's Slack mode: which
 * agent stopped and why, never who its owner is, since the channel's readers may not see them. Null once the pause
 * it names has ended or Slack is off.
 */
export const preparePause = internalMutation({
  args: { agentId: v.id("agents"), at: v.number() },
  handler: async (ctx, args): Promise<{ cipher: string; text: string } | null> => {
    const principal = await ctx.db.get(args.agentId);
    const agent = principal && (await slackAgent(ctx, principal, args.at));
    const row = agent && (await slackRow(ctx, agent.orgId));
    if (!agent?.pause || !row?.isActive) return null;
    const origin = appUrl();
    const why = PAUSE_REASONS[agent.pause.reason].message.replace(/^Paused: /, "");
    const text = `Canon paused the agent ${agent.label}: ${why}. It does nothing until an admin reassigns or resumes it.${origin ? ` ${origin}/dashboard/agents` : ""}`;
    return { cipher: row.accessToken, text };
  },
});

export const sendPause = internalAction({
  args: { agentId: v.id("agents"), at: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const job: { cipher: string; text: string } | null = await ctx.runMutation(internal.agentSlack.preparePause, args);
    if (!job) return null;
    try {
      await postToSlack(await decryptFromStorage(job.cipher), job.text);
    } catch {
      return null;
    }
    return null;
  },
});
