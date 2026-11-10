/**
 * Event agents (docs/org-agents.md, phases 2-3; GT7a). An event agent is an
 * org-owned agent that answers a set of AI fields about one account when an
 * event arrives on its webhook. Each event becomes a turn: admitted (it runs)
 * or recorded as skipped with the reason.
 *
 * The webhook route (lib/agents/webhookRoute.ts) verifies the HMAC signature
 * before `receive` is called; a deal entering a stage arrives as `crmEvent`
 * (lib/agents/crmEvents.ts). One turn runs at a time per agent: later events
 * queue behind it. The research runs in agentTurnActions.ts (Node); then the
 * agent's route may add the event's contact to an audience (`routeTurn`).
 */
import { sealedV } from "./lib/sealed";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap, requireUser } from "./lib";
import { actingAgent } from "./agents";
import { agentReader, agentWebhookUrl } from "./lib/agentReads";
import { submitProposalBatch } from "./canonGate";
import { approveUnderGrant, liveGrants } from "./agentGrants";
import { grantFor } from "./lib/agents/grants";
import { agentSlug, attributeFor, type AgentSpec } from "./lib/research/agentLoop";
import { encryptForStorage } from "./lib/tokenHelpers";
import {
  DAY_MS, DEFAULT_BUDGET, MAX_TURN_SECONDS, MAX_TURNS_PER_DAY, PAYLOAD_KEPT, admission, bareDomain, subjectOf, type Subject,
} from "./lib/agents/webhook";
import { RULE_VALUE_MAX, STAGE_MAX, settleOutcome, stageMatches } from "./lib/agents/routing";
import { notifyTurn } from "./agentSlack";
import { canSee } from "./audiences";
import { accessFor, dealVisible, principalAccess } from "./permissions";
import { agentPrincipals, hiddenFields } from "./lib/access";
import { withEventDefinition, writeEventDefinition } from "./lib/agents/definitions";

const MAX_FIELDS = 10;
const ZERO_SPEND = { modelCalls: 0, tokens: 0, pagesRead: 0, ms: 0 };
/** A running turn not finished by then has died (a turn's action is capped well below it); it stops blocking the queue. */
const STALE_MS = (MAX_TURN_SECONDS + 120) * 1000;
const ruleValidator = v.object({ fieldSlug: v.string(), op: v.union(v.literal("equals"), v.literal("contains")), value: v.string() });

const subjectValidator = v.object({ domain: v.optional(v.string()), email: v.optional(v.string()) });
const valueValidator = v.union(v.string(), v.number(), v.boolean());
const outputValidator = v.object({
  fieldSlug: v.string(), label: v.string(), status: v.string(),
  value: v.optional(valueValidator), factId: v.optional(v.id("facts")), reason: v.optional(v.string()),
});

const canManage = (user: Doc<"users">, agent: Doc<"agents">) => can(user, "agents.manageAll") || user._id === agent.ownerUserId;

/** A live event agent in the caller's org, or a not-found error (another org's agent looks the same as none). */
async function eventAgent(ctx: QueryCtx | MutationCtx, user: Doc<"users">, agentId: Id<"agents">): Promise<Doc<"agents">> {
  const principal = await ctx.db.get(agentId);
  const agent = principal?.orgId === user.orgId ? await withEventDefinition(ctx, principal) : null;
  if (!agent || agent.orgId !== user.orgId || !agent.fieldSlugs || agent.archivedAt !== undefined) throw new ConvexError("Agent not found");
  return agent;
}

// ───────────────────────────── Reads ─────────────────────────────

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const reader = user ? await agentReader(ctx, user.orgId, await accessFor(ctx, user), "legacy") : null;
    if (!reader) return { agents: [], canCreate: false };
    const agents = (await reader.event({ all: true }, 300)).map(({ createdAt: _createdAt, ...agent }) => agent);
    return { agents, canCreate: reader.canCreate };
  },
});

/** An agent's latest 25 turns, newest first, with current visibility and fact status. */
export const turns = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const reader = user ? await agentReader(ctx, user.orgId, await accessFor(ctx, user), "legacy") : null;
    return reader ? reader.turns(args.agentId) : [];
  },
});

// ───────────────────────────── Definitions ─────────────────────────────

export const createEventAgentArgs = v.object({ label: v.string(), fieldSlugs: v.array(v.string()), turnsPerDay: v.number() });

export async function createEventAgent(ctx: MutationCtx, args: typeof createEventAgentArgs.type) {
  const user = await requireCap(ctx, "agents.run");
  const label = args.label.trim().slice(0, 80);
  if (!label) throw new ConvexError("Give the agent a name.");
  const fieldSlugs = [...new Set(args.fieldSlugs)];
  if (fieldSlugs.length < 1 || fieldSlugs.length > MAX_FIELDS) throw new ConvexError(`Pick 1 to ${MAX_FIELDS} AI fields.`);
  for (const slug of fieldSlugs) {
    const f = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId).eq("slug", slug)).unique();
    if (!f) throw new ConvexError(`Unknown AI field: ${slug}`);
    if (f.entityType !== "account") throw new ConvexError(`${f.label} is a contact field; webhook agents answer account fields.`);
  }
  const turnsPerDay = Math.floor(args.turnsPerDay);
  if (!(turnsPerDay >= 1 && turnsPerDay <= MAX_TURNS_PER_DAY)) throw new ConvexError(`Turns per day must be 1 to ${MAX_TURNS_PER_DAY}.`);
  // Agent and field slugs share one namespace: a field's agent is created later with the field's slug.
  const taken = new Set<string>();
  for (const a of await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(500)) taken.add(a.slug);
  for (const f of await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId)).take(500)) taken.add(f.slug);
  const slug = agentSlug(label, taken);
  const now = Date.now();
  const agentId = await ctx.db.insert("agents", {
    orgId: user.orgId, slug, label, kind: "hosted", ownerUserId: user._id, ledgerKey: `agent:${slug}`,
    fieldSlugs, budget: { ...DEFAULT_BUDGET, turnsPerDay }, createdBy: user._id, createdAt: now, updatedAt: now,
  });
  const principal = (await ctx.db.get(agentId))!;
  await writeEventDefinition(ctx, principal, {});
  return { agentId };
}

export const create = mutation({
  args: createEventAgentArgs,
  handler: createEventAgent,
});

/** Owner or admin: archive an event agent. Its webhook stops answering; its turns and facts stay. */
export const archiveEventAgentArgs = v.object({ agentId: v.id("agents") });

export async function archiveEventAgent(ctx: MutationCtx, args: typeof archiveEventAgentArgs.type) {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can archive it");
  await ctx.db.patch(agent._id, { archivedAt: Date.now(), updatedAt: Date.now() });
  const hook = await ctx.db.query("agentWebhooks").withIndex("by_agentId", (q) => q.eq("agentId", agent._id)).unique();
  if (hook) await ctx.db.delete(hook._id);
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, userId: user._id, agentId: agent._id, verb: "do", operation: "agent.archive", status: "applied", details: {}, createdAt: Date.now(),
  });
  return null;
}

export const archive = mutation({
  args: archiveEventAgentArgs,
  handler: archiveEventAgent,
});

/**
 * Owner or admin: route qualifying turns' contacts into an audience, or stop
 * routing (audienceId null). The rule names one of the agent's AI fields.
 */
export const setEventRoutingArgs = v.object({ agentId: v.id("agents"), audienceId: v.union(v.id("audiences"), v.null()), rule: v.union(ruleValidator, v.null()) });

export async function setEventRouting(ctx: MutationCtx, args: typeof setEventRoutingArgs.type) {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can change its routing");
  let route: Doc<"agents">["route"];
  if (args.audienceId) {
    const audience = await ctx.db.get(args.audienceId);
    if (!audience || !canSee(user, audience)) throw new ConvexError("Audience not found");
    // A turn adds contacts for the agent's owner: to their own audiences or shared ones, never another rep's private one.
    const owner = await ctx.db.get(agent.ownerUserId);
    if (!owner || !canSee(owner, audience)) throw new ConvexError("An agent can only route to its owner's audiences or shared ones.");
    let rule;
    if (args.rule) {
      const value = args.rule.value.trim();
      if (!agent.fieldSlugs?.includes(args.rule.fieldSlug)) throw new ConvexError("The rule must use one of the agent's AI fields.");
      if (!value || value.length > RULE_VALUE_MAX) throw new ConvexError(`The rule's value is 1 to ${RULE_VALUE_MAX} characters.`);
      rule = { fieldSlug: args.rule.fieldSlug, op: args.rule.op, value };
    }
    route = { audienceId: audience._id, ...(rule ? { rule } : {}) };
  }
  await writeEventDefinition(ctx, agent, { route });
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, userId: user._id, agentId: agent._id, verb: "do", operation: "agent.set_routing", status: "applied",
    details: { audienceId: route?.audienceId ?? null, rule: route?.rule ?? null }, createdAt: Date.now(),
  });
  return null;
}

export const setRouting = mutation({
  args: setEventRoutingArgs,
  handler: setEventRouting,
});

/** Owner or admin: also wake the agent when a deal enters a stage (any stage when toStage is empty), or stop (null). */
export const setEventCrmTriggerArgs = v.object({ agentId: v.id("agents"), trigger: v.union(v.object({ event: v.literal("deal.stage_changed"), toStage: v.optional(v.string()) }), v.null()) });

export async function setEventCrmTrigger(ctx: MutationCtx, args: typeof setEventCrmTriggerArgs.type) {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can change its triggers");
  const toStage = args.trigger?.toStage?.trim();
  if (toStage && toStage.length > STAGE_MAX) throw new ConvexError(`A stage name is at most ${STAGE_MAX} characters.`);
  const crmTrigger = args.trigger ? { event: args.trigger.event, ...(toStage ? { toStage } : {}) } : undefined;
  await writeEventDefinition(ctx, agent, { crmTrigger });
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, userId: user._id, agentId: agent._id, verb: "do", operation: "agent.set_crm_trigger", status: "applied",
    details: { trigger: crmTrigger ?? null }, createdAt: Date.now(),
  });
  return null;
}

export const setCrmTrigger = mutation({
  args: setEventCrmTriggerArgs,
  handler: setEventCrmTrigger,
});

/** Owner or admin: message the org's Slack when a turn ends (mode says which turns), or stop (null). Off by default. */
export const setEventSlackArgs = v.object({ agentId: v.id("agents"), mode: v.union(v.literal("all"), v.literal("qualified"), v.literal("failures"), v.null()) });

export async function setEventSlack(ctx: MutationCtx, args: typeof setEventSlackArgs.type) {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can change its Slack notifications");
  const slack = args.mode ? { mode: args.mode } : undefined;
  await writeEventDefinition(ctx, agent, { slack });
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, userId: user._id, agentId: agent._id, verb: "do", operation: "agent.set_slack", status: "applied",
    details: { mode: args.mode }, createdAt: Date.now(),
  });
  return null;
}

export const setSlack = mutation({
  args: setEventSlackArgs,
  handler: setEventSlack,
});

// ───────────────────────────── Webhook secret ─────────────────────────────

/**
 * Owner or admin: make a new signing secret, replacing any old one at once.
 * The secret is returned here only; Canon keeps it encrypted.
 */
export const rotateSecret = action({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args): Promise<{ secret: string; url: string }> => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    await ctx.runMutation(internal.agentTurns.saveSecret, { agentId: args.agentId, secret: await encryptForStorage(secret) });
    return { secret, url: agentWebhookUrl(args.agentId) };
  },
});

export const saveEventSecretArgs = v.object({ agentId: v.id("agents"), secret: sealedV });

export async function saveEventSecret(ctx: MutationCtx, args: typeof saveEventSecretArgs.type) {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can rotate its secret");
  const row = { orgId: agent.orgId, agentId: agent._id, secret: args.secret, rotatedBy: user._id, rotatedAt: Date.now() };
  const hook = await ctx.db.query("agentWebhooks").withIndex("by_agentId", (q) => q.eq("agentId", agent._id)).unique();
  if (hook) await ctx.db.replace(hook._id, row);
  else await ctx.db.insert("agentWebhooks", row);
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, userId: user._id, agentId: agent._id, verb: "do", operation: "agent.rotate_webhook_secret", status: "applied", details: {}, createdAt: Date.now(),
  });
  return null;
}

export const saveSecret = internalMutation({
  args: saveEventSecretArgs,
  handler: saveEventSecret,
});

/** For the webhook route only: the stored (encrypted) secret of a live event agent. */
export const webhookSecret = internalQuery({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    const agentId = ctx.db.normalizeId("agents", args.agentId);
    const principal = agentId ? await ctx.db.get(agentId) : null;
    const agent = principal ? await withEventDefinition(ctx, principal) : null;
    if (!agent || !agent.fieldSlugs || agent.archivedAt !== undefined) return null;
    const hook = await ctx.db.query("agentWebhooks").withIndex("by_agentId", (q) => q.eq("agentId", agent._id)).unique();
    return hook ? { agentId: agent._id, secret: hook.secret } : null;
  },
});

// ───────────────────────────── Turns ─────────────────────────────

type Admitted = { turnId: Id<"agentTurns">; status: Doc<"agentTurns">["status"]; duplicate: boolean };

const turnsWith = (ctx: QueryCtx, agentId: Id<"agents">, status: "queued" | "running") =>
  ctx.db.query("agentTurns").withIndex("by_agentId_and_status_and_createdAt", (q) => q.eq("agentId", agentId).eq("status", status));

/** Start the agent's oldest queued turn. */
async function dispatchNext(ctx: MutationCtx, agentId: Id<"agents">): Promise<boolean> {
  const next = await turnsWith(ctx, agentId, "queued").first();
  if (!next) return false;
  await ctx.db.patch(next._id, { dispatchedAt: Date.now(), updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.agentTurnActions.runTurn, { turnId: next._id });
  return true;
}

/**
 * Whether the agent has a turn in flight. A running turn past STALE_MS is
 * failed; a queued turn that is waiting, or whose dispatch was lost, is
 * dispatched now, so a dead turn never blocks the queue for good.
 */
async function inFlight(ctx: MutationCtx, agentId: Id<"agents">, now: number): Promise<boolean> {
  for (const t of await turnsWith(ctx, agentId, "running").take(5)) {
    if (t.updatedAt > now - STALE_MS) return true;
    await ctx.db.patch(t._id, { status: "failed", error: "The turn stopped without finishing.", updatedAt: now });
    await notifyTurn(ctx, t._id);
  }
  const queued = await turnsWith(ctx, agentId, "queued").first();
  if (!queued) return false;
  if (queued.dispatchedAt !== undefined && queued.dispatchedAt > now - STALE_MS) return true;
  return dispatchNext(ctx, agentId);
}

/**
 * Record an event as a turn: the existing turn when its key was seen, else a
 * new one that runs or is skipped with the reason. Never throws after
 * actingAgent, so a pause it latches commits.
 */
async function admit(ctx: MutationCtx, principal: Doc<"agents">, a: {
  trigger: Doc<"agentTurns">["trigger"]; eventKey: string; payload: string; subject: Subject; triggeredBy?: Id<"users">;
  /** The subject the turn keeps, when it differs from the one admission judges (a deal event keeps none of its account). */
  keep?: Subject;
}): Promise<Admitted> {
  const agent = await withEventDefinition(ctx, principal);
  const seen = await ctx.db.query("agentTurns").withIndex("by_agentId_and_eventKey", (q) => q.eq("agentId", agent._id).eq("eventKey", a.eventKey)).first();
  if (seen) return { turnId: seen._id, status: seen.status, duplicate: true };
  const acting = await actingAgent(ctx, agent._id);
  const budget = agent.budget ?? DEFAULT_BUDGET;
  const now = Date.now();
  const today = await ctx.db.query("agentTurns")
    .withIndex("by_agentId_and_admitted_and_createdAt", (q) => q.eq("agentId", agent._id).eq("admitted", true).gt("createdAt", now - DAY_MS))
    .take(budget.turnsPerDay);
  const plan = await ctx.db.query("chatgptAuth").withIndex("by_userId", (q) => q.eq("userId", agent.ownerUserId)).unique();
  const verdict = admission({
    standingMessage: acting.ok ? null : acting.message, fieldCount: agent.fieldSlugs?.length ?? 0,
    admittedToday: today.length, turnsPerDay: budget.turnsPerDay, subject: a.subject, ownerConnected: plan?.status === "connected",
  });
  const status = verdict.run ? "queued" as const : "skipped" as const;
  const wait = verdict.run && (await inFlight(ctx, agent._id, now));
  const turnId = await ctx.db.insert("agentTurns", {
    orgId: agent.orgId, agentId: agent._id, trigger: a.trigger, eventKey: a.eventKey, status, admitted: verdict.run,
    ...(verdict.run ? {} : { skip: { reason: verdict.reason, message: verdict.message } }),
    payload: a.payload, subject: a.keep ?? a.subject, outputs: [], spend: ZERO_SPEND,
    ...(a.triggeredBy ? { triggeredBy: a.triggeredBy } : {}), ...(verdict.run && !wait ? { dispatchedAt: now } : {}), createdAt: now, updatedAt: now,
  });
  if (verdict.run && !wait) await ctx.scheduler.runAfter(0, internal.agentTurnActions.runTurn, { turnId });
  if (!verdict.run) await notifyTurn(ctx, turnId);
  return { turnId, status, duplicate: false };
}

/** A verified webhook event (lib/agents/webhookRoute.ts). Null when the agent is gone. */
export const receive = internalMutation({
  args: { agentId: v.id("agents"), eventKey: v.string(), payload: v.string(), subject: subjectValidator },
  handler: async (ctx, args): Promise<Admitted | null> => {
    const principal = await ctx.db.get(args.agentId);
    const agent = principal ? await withEventDefinition(ctx, principal) : null;
    if (!agent || !agent.fieldSlugs || agent.archivedAt !== undefined) return null;
    return admit(ctx, agent, { trigger: "webhook", eventKey: args.eventKey, payload: args.payload, subject: args.subject });
  },
});

/** A deal-stage event's key: this, the deal's id, `@`, the stream version. */
const DEAL_EVENT = "deal.stage_changed:";

/** A deal event's account domain, read when the turn runs, from its deal (the turn itself does not keep it). */
async function dealDomain(ctx: QueryCtx, turn: Doc<"agentTurns">): Promise<string | null> {
  const raw = turn.eventKey.startsWith(DEAL_EVENT) ? turn.eventKey.slice(DEAL_EVENT.length).split("@")[0] : null;
  const dealId = raw ? ctx.db.normalizeId("deals", raw) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  const account = deal?.orgId === turn.orgId && deal.accountId ? await ctx.db.get(deal.accountId) : null;
  return account?.orgId === turn.orgId && account.domain ? bareDomain(account.domain) : null;
}

/**
 * A deal entered a stage (lib/agents/crmEvents.ts): a turn for each live agent
 * listening for it, about the deal's account. Keyed by the deal and the stream
 * version of the write, so the same change never runs twice.
 */
export const crmEvent = internalMutation({
  args: { orgId: v.id("organizations"), dealId: v.id("deals"), version: v.number(), from: v.optional(v.string()), to: v.string() },
  handler: async (ctx, args) => {
    const deal = await ctx.db.get(args.dealId);
    if (!deal || deal.orgId !== args.orgId) return null;
    const account = deal.accountId ? await ctx.db.get(deal.accountId) : null;
    const company = account && account.orgId === deal.orgId ? account : null;
    const domain = company?.domain ? bareDomain(company.domain) : null;
    // The turn keeps the deal, which its owner sees, and not its account, which they may not (CP14): the run
    // finds the account through the owner's scoped client and records it only when found (dealDomain, runTurn).
    const payload = JSON.stringify({
      event: "deal.stage_changed", deal: { id: deal._id, name: deal.name, fromStage: args.from ?? null, toStage: args.to },
    }).slice(0, PAYLOAD_KEPT);
    const agents = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", args.orgId)).take(300);
    for (const principal of agents) {
      const agent = await withEventDefinition(ctx, principal);
      const t = agent.crmTrigger;
      if (!t || t.event !== "deal.stage_changed" || !agent.fieldSlugs || agent.archivedAt !== undefined || !stageMatches(t, args.to)) continue;
      // An agent hears only of deals its owner sees, and of stages they see (CP14): the turn keeps the deal's name and stage.
      const [owner] = (await principalAccess(ctx, args.orgId, [agent.ownerUserId])) ?? [];
      if (!owner || !dealVisible(owner, deal) || hiddenFields(owner, "deal").includes("stage")) continue;
      await admit(ctx, agent, { trigger: "crm_event", eventKey: `${DEAL_EVENT}${deal._id}@${args.version}`, payload, subject: domain ? { domain } : {}, keep: {} });
    }
    return null;
  },
});

/** Owner or admin: run the agent on a sample event, as if it had arrived on the webhook (no signature needed). */
export const testEventAgentArgs = v.object({ agentId: v.id("agents"), payload: v.string() });

export async function testEventAgent(ctx: MutationCtx, args: typeof testEventAgentArgs.type): Promise<Admitted> {
  const user = await requireUser(ctx);
  const agent = await eventAgent(ctx, user, args.agentId);
  if (!canManage(user, agent)) throw new ConvexError("Only the agent's owner or an admin can test it");
  let parsed: unknown;
  try { parsed = JSON.parse(args.payload); } catch { throw new ConvexError("The sample payload isn't valid JSON."); }
  return admit(ctx, agent, {
    trigger: "test", eventKey: `test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    payload: args.payload.slice(0, PAYLOAD_KEPT), subject: subjectOf(parsed), triggeredBy: user._id,
  });
}

export const testRun = mutation({
  args: testEventAgentArgs,
  handler: testEventAgent,
});

/**
 * A turn, its agent's owner and budget, the specs of the AI fields it answers
 * (deleted ones left out), and the access of its principals (CP14): its owner,
 * and for a test turn the person who ran it. Null principals: one of them is
 * no longer a member, and the turn reads nothing.
 */
export const loadTurn = internalQuery({
  args: { turnId: v.id("agentTurns") },
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    const principal = turn && await ctx.db.get(turn.agentId);
    const agent = principal ? await withEventDefinition(ctx, principal) : null;
    if (!turn || !agent) return null;
    const fields: Array<{ slug: string; label: string; spec: AgentSpec }> = [];
    for (const slug of agent.fieldSlugs ?? []) {
      const f = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", agent.orgId).eq("slug", slug)).unique();
      if (f) fields.push({ slug, label: f.label, spec: { label: f.label, kind: f.kind, question: f.question, options: f.options, answerType: f.answerType, judgment: f.judgment, entityType: f.entityType } });
    }
    const principals = await principalAccess(ctx, agent.orgId, agentPrincipals({ ownerUserId: agent.ownerUserId, startedBy: turn.triggeredBy }));
    const domain = turn.subject.domain ?? (turn.trigger === "crm_event" ? await dealDomain(ctx, turn) : null);
    return { turn, domain, ownerUserId: agent.ownerUserId, budget: agent.budget ?? DEFAULT_BUDGET, fields, route: agent.route ?? null, principals };
  },
});

export const startTurn = internalMutation({
  args: { turnId: v.id("agentTurns") },
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (turn?.status !== "queued") return false;
    // Paused or archived while the turn waited: it doesn't run, and the next one gets the same check.
    const principal = await ctx.db.get(turn.agentId);
    const agent = principal ? await withEventDefinition(ctx, principal) : null;
    if (!agent || agent.pause || agent.archivedAt !== undefined) {
      await ctx.db.patch(turn._id, { status: "skipped", skip: { reason: "paused", message: "The agent was paused or archived before this turn ran." }, updatedAt: Date.now() });
      await notifyTurn(ctx, turn._id);
      await dispatchNext(ctx, turn.agentId);
      return false;
    }
    await ctx.db.patch(turn._id, { status: "running", updatedAt: Date.now() });
    return true;
  },
});

/**
 * Record a turn's outcome and submit its answers to the write gate, only if
 * the agent may still act (checked here, in the transaction that writes).
 */
export const finishTurn = internalMutation({
  args: {
    turnId: v.id("agentTurns"),
    status: v.union(v.literal("done"), v.literal("skipped"), v.literal("failed")),
    skip: v.optional(v.object({ reason: v.string(), message: v.string() })),
    account: v.optional(v.object({ recordId: v.string(), entityId: v.id("canonEntities"), name: v.string(), domain: v.string() })),
    outputs: v.array(outputValidator),
    facts: v.array(v.object({ fieldSlug: v.string(), entityId: v.string(), value: valueValidator, evidence: v.string(), confidence: v.number() })),
    spend: v.object({ modelCalls: v.number(), tokens: v.number(), pagesRead: v.number(), ms: v.number() }),
    budgetHit: v.optional(v.union(v.literal("tokens"), v.literal("time"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (turn?.status !== "running") return null;
    let { status, skip } = args;
    let outputs: Array<(typeof args.outputs)[number] & { grantId?: Id<"agentGrants"> }> = args.outputs;
    let patchPlanId: Id<"patchPlans"> | undefined;
    if (args.facts.length) {
      const acting = await actingAgent(ctx, turn.agentId);
      if (!acting.ok) {
        status = "skipped";
        skip = { reason: "paused", message: acting.message };
        outputs = outputs.map((o) => (o.status === "answered" ? { ...o, status: "not_submitted", reason: acting.message } : o));
      } else {
        const definition = await withEventDefinition(ctx, acting.agent);
        // Answers a live standing grant covers go in their own batch, approved under it below
        // if the whole batch still fits; every other answer waits for a person, as before.
        const grants = await liveGrants(ctx, acting.agent._id, Date.now());
        const groups = new Map<Id<"agentGrants"> | null, typeof args.facts>();
        for (const f of args.facts) {
          const g = grantFor(grants, { entityType: "account", attribute: attributeFor(f.fieldSlug), value: f.value });
          const k = (g?.grantId ?? null) as Id<"agentGrants"> | null;
          groups.set(k, [...(groups.get(k) ?? []), f]);
        }
        const landed: Doc<"facts">[] = [];
        const rejected = new Map<string, string>();
        const grantOf = new Map<Id<"facts">, Id<"agentGrants">>();
        for (const [grantId, facts] of groups) {
          const res = await submitProposalBatch(ctx, {
            attribution: { kind: "agent", agent: acting.agent, triggeredBy: turn.triggeredBy ?? acting.agent.ownerUserId },
            sourceKind: "agent_run",
            title: `${definition.label}: ${args.account?.name ?? "account"}${grantId ? " (standing grant)" : ""}`,
            reason: `Event agent "${definition.label}" (${turn.trigger} turn)`,
            facts: facts.map(({ fieldSlug, ...f }) => ({ ...f, entityType: "account" as const, attribute: attributeFor(fieldSlug) })),
            // The account the turn found through its principals' scoped client (agentTurnActions.runTurn).
            admitted: args.account ? [args.account.recordId] : [],
          });
          if (!patchPlanId || !grantId) patchPlanId = res.patchPlanId;
          for (const r of res.rejected) rejected.set(facts[r.index]!.fieldSlug, r.reason);
          landed.push(...await ctx.db.query("facts").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", res.patchPlanId)).take(MAX_FIELDS * 2));
          if (!grantId || !res.proposed) continue;
          const approval = await approveUnderGrant(ctx, { agent: acting.agent, grantId, patchPlanId: res.patchPlanId, turnId: turn._id });
          if (approval.approved) for (const id of approval.factIds) grantOf.set(id, grantId);
        }
        outputs = outputs.map((o) => {
          if (o.status !== "answered") return o;
          const why = rejected.get(o.fieldSlug);
          if (why) return { ...o, status: "rejected", reason: why.replace(/_/g, " ") };
          const fact = landed.find((f) => f.attribute === attributeFor(o.fieldSlug));
          if (!fact) return { ...o, status: "unchanged", reason: "The same answer and quote were proposed before." };
          const grantId = grantOf.get(fact._id);
          return { ...o, factId: fact._id, ...(grantId ? { grantId } : {}) };
        });
      }
    }
    await ctx.db.patch(turn._id, {
      status, outputs, spend: args.spend, updatedAt: Date.now(),
      ...(skip ? { skip } : {}), ...(args.account ? { account: args.account } : {}), ...(patchPlanId ? { patchPlanId } : {}),
      ...(args.budgetHit ? { budgetHit: args.budgetHit } : {}), ...(args.error ? { error: args.error.slice(0, 500) } : {}),
    });
    // A routed turn that finished is announced by routeTurn, once its routing is known.
    const principal = await ctx.db.get(turn.agentId);
    const definition = principal ? await withEventDefinition(ctx, principal) : null;
    if (status !== "done" || !definition?.route) await notifyTurn(ctx, turn._id);
    await dispatchNext(ctx, turn.agentId);
    return { status, outputs };
  },
});

/**
 * After a finished turn: record what the agent's route did with the event's
 * contact, and add the contact to the audience when it qualified. Adding is
 * an internal list membership; nothing is sent anywhere. Re-checked here: the
 * route still names this audience, it is in the agent's org, the agent may act.
 */
export const routeTurn = internalMutation({
  args: {
    turnId: v.id("agentTurns"),
    audienceId: v.id("audiences"),
    outcome: v.union(
      v.object({ kind: v.literal("not_qualified"), message: v.string() }),
      v.object({ kind: v.literal("no_contact"), message: v.string() }),
      v.object({ kind: v.literal("error"), message: v.string() }),
      v.object({ kind: v.literal("contact"), contactId: v.string(), email: v.string(), name: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId);
    if (!turn || turn.status !== "done" || turn.routing) return null;
    const principal = await ctx.db.get(turn.agentId);
    const agent = principal ? await withEventDefinition(ctx, principal) : null;
    const audience = await ctx.db.get(args.audienceId);
    const set = async (status: string, message: string, contactId?: string) => {
      await ctx.db.patch(turn._id, { routing: { status, message: message.slice(0, 300), audienceId: args.audienceId, ...(contactId ? { contactId } : {}) }, updatedAt: Date.now() });
      await notifyTurn(ctx, turn._id); // the routing is the last thing a routed turn waits for
    };
    if (!agent || agent.route?.audienceId !== args.audienceId || !audience || audience.orgId !== turn.orgId) {
      await set("skipped", "The agent's route changed or its audience was removed during the turn.");
      return null;
    }
    // The owner's standing is derived at act time: check it in this transaction, which latches a pause it finds.
    const acting = await actingAgent(ctx, agent._id);
    if (!acting.ok) {
      await set("skipped", acting.message);
      return null;
    }
    // So is their access to the audience: another rep may have made it private since the route was saved.
    const owner = await ctx.db.get(agent.ownerUserId);
    if (!owner || !canSee(owner, audience)) {
      await set("skipped", "The audience is now another rep's private audience, so the contact was not added.");
      return null;
    }
    // The owner may have edited the rule while the turn ran: judge the stored answers by the rule in force now.
    const o = settleOutcome(agent.route.rule, turn.outputs ?? [], args.outcome);
    if (o.kind === "stale") {
      await set("skipped", "The agent's rule changed during the turn, so this contact was not routed.");
      return null;
    }
    if (o.kind !== "contact") {
      await set(o.kind, o.message);
      return null;
    }
    const existing = await ctx.db.query("audienceAdditions")
      .withIndex("by_audienceId_and_contactId", (q) => q.eq("audienceId", audience._id).eq("contactId", o.contactId))
      .first();
    if (existing) {
      await set("already_member", `${o.name} (${o.email}) was already added to ${audience.name}.`, o.contactId);
      return null;
    }
    await ctx.db.insert("audienceAdditions", {
      orgId: turn.orgId, audienceId: audience._id, contactId: o.contactId, email: o.email, agentId: agent._id, turnId: turn._id, at: Date.now(),
    });
    await set("added", `Added ${o.name} (${o.email}) to ${audience.name}.`, o.contactId);
    return null;
  },
});
