/**
 * Org-owned agents (docs/org-agents.md, phase 1: identity). An agent has one
 * accountable owner; whether it may act is derived from that owner at act
 * time (lib/agents/standing.ts). `actingAgent` is the only way to obtain an
 * ActingAgent, the proof the write gate needs to attribute proposals to an
 * agent. When it finds the owner no longer eligible it latches a pause, so the
 * agent stays stopped until an admin reassigns or resumes it.
 *
 * Today every agent is an AI field's (researchAgents) runner. Fields created
 * before this link to their agent lazily (ensureFieldAgent); until then reads
 * show them as a virtual agent owned by the field's creator.
 */
import { roleBasesOf } from "./permissions";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import {
  PAUSE_REASONS, isOwnerCaused, ownerRuleOf, standingMessage, standingOf,
  type OwnerFacts, type PauseReason, type Role, type Standing,
} from "./lib/agents/standing";
import type { ActingAgent } from "./lib/agents/attribution";

type ReadCtx = { db: QueryCtx["db"] };

export async function ownerFactsOf(ctx: ReadCtx, orgId: Id<"organizations">, userId: Id<"users">, bases?: Readonly<Record<string, string>>): Promise<OwnerFacts & { user: Doc<"users"> | null }> {
  const user = await ctx.db.get(userId);
  const membership = user
    ? await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", userId).eq("orgId", orgId)).first()
    : null;
  return { orgId, user, membership, bases: bases ?? await roleBasesOf(ctx as QueryCtx, orgId) };
}

export async function standing(ctx: ReadCtx, agent: Doc<"agents">): Promise<Standing> {
  return standingOf(agent, await ownerFactsOf(ctx, agent.orgId, agent.ownerUserId));
}

async function audit(ctx: MutationCtx, agent: Doc<"agents">, userId: Id<"users"> | undefined, operation: string, details: Record<string, unknown>) {
  await ctx.db.insert("operationAuditLog", {
    orgId: agent.orgId, ...(userId ? { userId } : {}), agentId: agent._id,
    verb: "do", operation, status: "applied", details, createdAt: Date.now(),
  });
}

export type ActingResult = { ok: true; agent: ActingAgent } | { ok: false; message: string };

/**
 * The only minter of ActingAgent. Call it in the mutation that writes, and
 * don't throw after a refusal: the latch is part of this transaction.
 */
export async function actingAgent(ctx: MutationCtx, agentId: Id<"agents">): Promise<ActingResult> {
  const agent = await ctx.db.get(agentId);
  if (!agent) return { ok: false, message: standingMessage({ status: "archived" })! };
  const s = await standing(ctx, agent);
  if (s.status === "active") return { ok: true, agent: agent as ActingAgent };
  if (s.status === "paused" && !agent.pause) {
    await ctx.db.patch(agent._id, { pause: { reason: s.reason, at: Date.now() }, updatedAt: Date.now() });
    await audit(ctx, agent, undefined, "agent.pause", { reason: s.reason });
  }
  return { ok: false, message: standingMessage(s)! };
}

/** The field's agent, created and linked on first use. Idempotent; concurrent callers serialize on the field row. */
export async function ensureFieldAgent(ctx: MutationCtx, field: Doc<"researchAgents">): Promise<Id<"agents">> {
  if (field.agentId) return field.agentId;
  const ledgerKey = `research:${field.slug}`;
  const taken = await ctx.db.query("agents")
    .withIndex("by_orgId_and_ledgerKey", (q) => q.eq("orgId", field.orgId).eq("ledgerKey", ledgerKey)).first();
  // A ledger key is a sourceRef namespace; sharing one would merge two agents' dedupe history.
  if (taken) throw new ConvexError(`Agent ledger key ${ledgerKey} is already taken`);
  const now = Date.now();
  const agentId = await ctx.db.insert("agents", {
    orgId: field.orgId, slug: field.slug, label: field.label, kind: "hosted", ownerUserId: field.createdBy,
    ledgerKey, createdBy: field.createdBy, createdAt: now, updatedAt: now,
  });
  await ctx.db.patch(field._id, { agentId });
  return agentId;
}

/** How a client names an agent. `fieldSlug` covers a field not linked yet; it goes away when researchAgents.agentId is required. */
export const agentRefValidator = v.union(v.object({ agentId: v.id("agents") }), v.object({ fieldSlug: v.string() }));
export type AgentRef = typeof agentRefValidator.type;

export type AgentView = {
  ref: AgentRef;
  owner: { id: Id<"users">; name: string } | null;
  status: Standing["status"];
  reason: PauseReason | null;
  message: string | null;
  /** Whether the owner could own it now: an admin may resume an owner-caused pause only then. */
  ownerEligible: boolean;
  /** The viewer is its owner or an admin: may pause, and resume a pause a person set. */
  canManage: boolean;
  /** The viewer is an admin: may reassign it. */
  canReassign: boolean;
};

export async function fieldAgentView(ctx: ReadCtx, viewer: Doc<"users">, field: Doc<"researchAgents">): Promise<AgentView> {
  const agent = field.agentId ? await ctx.db.get(field.agentId) : null;
  return viewOf(ctx, viewer, field.orgId, agent, agent?.ownerUserId ?? field.createdBy, agent ? { agentId: agent._id } : { fieldSlug: field.slug });
}

export function agentView(ctx: ReadCtx, viewer: Doc<"users">, agent: Doc<"agents">): Promise<AgentView> {
  return viewOf(ctx, viewer, agent.orgId, agent, agent.ownerUserId, { agentId: agent._id });
}

async function viewOf(ctx: ReadCtx, viewer: Doc<"users">, orgId: Id<"organizations">, agent: Doc<"agents"> | null, ownerId: Id<"users">, ref: AgentRef): Promise<AgentView> {
  return {
    ref,
    ...await agentStandingView(ctx, orgId, agent, ownerId),
    canManage: can(viewer, "agents.manageAll") || viewer._id === ownerId,
    canReassign: can(viewer, "agents.manageAll"),
  };
}

export async function agentStandingView(ctx: ReadCtx, orgId: Id<"organizations">, agent: Doc<"agents"> | null, ownerId: Id<"users">, bases?: Readonly<Record<string, string>>) {
  const facts = await ownerFactsOf(ctx, orgId, ownerId, bases);
  const s = standingOf(agent ?? {}, facts);
  return {
    owner: facts.user ? { id: ownerId, name: facts.user.name } : null,
    status: s.status,
    reason: s.status === "paused" ? s.reason : null,
    message: standingMessage(s),
    ownerEligible: ownerRuleOf(facts).ok,
  };
}

export type ActorView =
  | { kind: "agent"; agentId: Id<"agents">; label: string; ownerName: string | null; legacy: boolean }
  | { kind: "user"; userId: Id<"users">; name: string; via: string | null }
  | { kind: "integration"; id: string }
  | { kind: "legacy"; label: string };
export type ActorCache = Map<string, Promise<ActorView>>;

/**
 * A fact's actor for people to read. A pre-agent actor string such as
 * `research:<slug>` resolves to the agent with that ledger key (legacy: true);
 * any other unverified string shows as a plain label.
 */
export function describeActor(ctx: ReadCtx, fact: Pick<Doc<"facts">, "orgId" | "actor" | "patchPlanId">, cache: ActorCache): Promise<ActorView> {
  const key = `${fact.actor.kind}:${fact.actor.id}:${fact.actor.kind === "user" ? (fact.patchPlanId ?? "") : ""}`;
  let view = cache.get(key);
  if (!view) cache.set(key, (view = resolveActor(ctx, fact)));
  return view;
}

async function resolveActor(ctx: ReadCtx, fact: Pick<Doc<"facts">, "orgId" | "actor" | "patchPlanId">): Promise<ActorView> {
  const { kind, id } = fact.actor;
  switch (kind) {
    case "integration":
      return { kind, id };
    case "agent": {
      const agentId = ctx.db.normalizeId("agents", id);
      const byId = agentId ? await ctx.db.get(agentId) : null;
      const agent = byId?.orgId === fact.orgId
        ? byId
        : await ctx.db.query("agents").withIndex("by_orgId_and_ledgerKey", (q) => q.eq("orgId", fact.orgId).eq("ledgerKey", id)).first();
      if (!agent) return { kind: "legacy", label: id };
      const owner = await ctx.db.get(agent.ownerUserId);
      return { kind, agentId: agent._id, label: agent.label, ownerName: owner?.name ?? null, legacy: agent !== byId };
    }
    case "user": {
      const userId = ctx.db.normalizeId("users", id);
      const user = userId ? await ctx.db.get(userId) : null;
      if (!user) return { kind: "legacy", label: id };
      const plan = fact.patchPlanId ? await ctx.db.get(fact.patchPlanId) : null;
      const via: unknown = plan?.args?.agentId;
      return { kind, userId: user._id, name: user.name, via: typeof via === "string" ? via : null };
    }
  }
}

async function resolveRef(ctx: MutationCtx, user: Doc<"users">, ref: AgentRef): Promise<Doc<"agents">> {
  let agentId: Id<"agents">;
  if ("agentId" in ref) agentId = ref.agentId;
  else {
    const field = await ctx.db.query("researchAgents")
      .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId).eq("slug", ref.fieldSlug)).unique();
    if (!field) throw new ConvexError("Agent not found");
    agentId = await ensureFieldAgent(ctx, field);
  }
  const agent = await ctx.db.get(agentId);
  if (!agent || agent.orgId !== user.orgId) throw new ConvexError("Agent not found");
  if (agent.archivedAt !== undefined) throw new ConvexError("This agent is archived");
  return agent;
}

/** Admin: make another member accountable for an agent. Also clears a pause its previous owner caused. */
export const setAgentOwnerArgs = v.object({ agent: agentRefValidator, ownerUserId: v.id("users") });

export async function setAgentOwner(ctx: MutationCtx, args: typeof setAgentOwnerArgs.type) {
  const user = await requireUser(ctx);
  if (!can(user, "agents.manageAll")) throw new ConvexError(refusal("agents.manageAll"));
  const agent = await resolveRef(ctx, user, args.agent);
  const rule = ownerRuleOf(await ownerFactsOf(ctx, agent.orgId, args.ownerUserId));
  if (!rule.ok) throw new ConvexError(PAUSE_REASONS[rule.reason].refusal!);
  const ownerPause = agent.pause && isOwnerCaused(agent.pause.reason) ? agent.pause.reason : null;
  if (agent.ownerUserId === args.ownerUserId && !ownerPause) return null;
  await ctx.db.patch(agent._id, { ownerUserId: args.ownerUserId, updatedAt: Date.now(), ...(ownerPause ? { pause: undefined } : {}) });
  await audit(ctx, agent, user._id, "agent.set_owner", { from: agent.ownerUserId, to: args.ownerUserId, ...(ownerPause ? { cleared: ownerPause } : {}) });
  return null;
}

export const setOwner = mutation({
  args: setAgentOwnerArgs,
  handler: setAgentOwner,
});

/**
 * Owner or admin: pause or resume. Idempotent. A pause the owner caused can
 * only be cleared by an admin, and only while the owner is eligible again;
 * otherwise reassign it with setOwner.
 */
export const setAgentPausedArgs = v.object({ agent: agentRefValidator, paused: v.boolean() });

export async function setAgentPaused(ctx: MutationCtx, args: typeof setAgentPausedArgs.type) {
  const user = await requireUser(ctx);
  const agent = await resolveRef(ctx, user, args.agent);
  const isAdmin = can(user, "agents.manageAll");
  if (!isAdmin && user._id !== agent.ownerUserId) throw new ConvexError("Only the agent's owner or an admin can pause or resume it");
  if (args.paused) {
    if (agent.pause) return null;
    await ctx.db.patch(agent._id, { pause: { reason: "paused_by_user", at: Date.now(), by: user._id }, updatedAt: Date.now() });
    await audit(ctx, agent, user._id, "agent.pause", { reason: "paused_by_user" });
    return null;
  }
  if (!agent.pause) return null;
  if (isOwnerCaused(agent.pause.reason)) {
    if (!isAdmin) throw new ConvexError("Only an admin can resume an agent paused because of its owner");
    const rule = ownerRuleOf(await ownerFactsOf(ctx, agent.orgId, agent.ownerUserId));
    if (!rule.ok) throw new ConvexError(`Reassign it first. ${PAUSE_REASONS[rule.reason].refusal}`);
  }
  await ctx.db.patch(agent._id, { pause: undefined, updatedAt: Date.now() });
  await audit(ctx, agent, user._id, "agent.resume", { cleared: agent.pause.reason });
  return null;
}

export const setPaused = mutation({
  args: setAgentPausedArgs,
  handler: setAgentPaused,
});

/** Admin: the members who could own an agent now, for the reassign picker. */
export async function agentOwnerCandidates(ctx: QueryCtx, user: Doc<"users">) {
  if (!can(user, "agents.manageAll")) return [];
  const memberships = await ctx.db.query("orgMemberships").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
  const users = new Map<Id<"users">, Doc<"users">>();
  for (const u of await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500)) users.set(u._id, u);
  for (const m of memberships) {
    if (users.has(m.userId)) continue;
    const u = await ctx.db.get(m.userId);
    if (u) users.set(u._id, u);
  }
  const bases = await roleBasesOf(ctx, user.orgId);
  const out: Array<{ id: Id<"users">; name: string; email: string; role: Role }> = [];
  for (const u of users.values()) {
    if (u.isHidden) continue;
    const rule = ownerRuleOf({ orgId: user.orgId, user: u, membership: memberships.find((m) => m.userId === u._id) ?? null, bases });
    if (rule.ok) out.push({ id: u._id, name: u.name, email: u.email, role: rule.role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const ownerCandidates = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? agentOwnerCandidates(ctx, user) : [];
  },
});

/**
 * For a human to run on each deployment before researchAgents.agentId is made
 * required: link every field to its agent, a page at a time. Idempotent.
 */
export const backfillFieldAgents = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("researchAgents").paginate({ numItems: 100, cursor: args.cursor });
    let linked = 0;
    for (const field of page.page) {
      if (field.agentId) continue;
      await ensureFieldAgent(ctx, field);
      linked++;
    }
    return { linked, isDone: page.isDone, cursor: page.continueCursor };
  },
});

/** Must read 0 on a deployment before the narrowing change ships there. */
export const unlinkedFieldCount = internalQuery({
  args: { orgId: v.optional(v.id("organizations")) },
  handler: async (ctx, args) => {
    const fields = args.orgId
      ? ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", args.orgId!))
      : ctx.db.query("researchAgents");
    let unlinked = 0;
    for await (const field of fields) if (!field.agentId) unlinked++;
    return unlinked;
  },
});
