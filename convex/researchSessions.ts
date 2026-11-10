import { applyStartingPlan } from "./moduleDefaults";
import { mayDecide, requireDecider } from "./recipes";
import { rateLimitHit } from "./lib/rateLimit.ts";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { Icp } from "../engine/src/icp.ts";
import { marketSegmentsValidator } from "./lib/segments/validator";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import {
  claimRedirect,
  decideClaim,
  icpToWeights,
  newToken,
  normalizeDomain,
  RATE_LIMITS,
  SESSION_CACHE_MS,
} from "./lib/researchPipeline";
import { defaultModel } from "../recipes/index.ts";
import { buildStartingPlan, companyFindingValidator, teamShapeValidator, crmValue, sellersValue, evidenceValidator, type OnboardingAnswers } from "./lib/startingPlan";

import { briefValidator } from "./lib/onboardingBrief";
import { researchAvailable, waitlistInput } from "./lib/researchAccess";

const EXAMPLE_DOMAINS = ["linear.app", "notion.so", "hubspot.com"];
const feedbackStep = v.union(v.literal("offer"), v.literal("buyers"), v.literal("market"), v.literal("team"), v.literal("plan"));

const statusValidator = v.union(
  v.literal("deriving"),
  v.literal("building_tam"),
  v.literal("sampling_contacts"),
  v.literal("ready"),
  v.literal("failed"),
);

async function consume(ctx: MutationCtx, key: string, rule: { limit: number; windowMs: number }, now: number) {
  const existing = await ctx.db
    .query("researchRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const { allowed, next } = rateLimitHit(existing ? { windowStart: existing.windowStart, count: existing.count } : null, now, rule);
  if (!allowed) return false;
  if (existing) await ctx.db.patch(existing._id, next);
  else await ctx.db.insert("researchRateLimits", { key, ...next });
  return true;
}

/**
 * Start (or reuse) an anonymous research session for a domain.
 *
 * Abuse controls (no Turnstile by decision): a honeypot field that real
 * browsers leave empty, a per-ipHash limit, a per-domain limit and a global
 * limit on NEW pipeline runs, and a 7-day cache by normalized domain (a cache
 * hit copies the finished results into a fresh token and costs nothing).
 * `ipHash` is computed server-side by /api/lead-magnet/start; direct callers
 * can omit or spoof it, which is why the domain + global caps exist.
 */
export const start = mutation({
  args: {
    domain: v.string(),
    ipHash: v.optional(v.string()),
    website: v.optional(v.string()), // honeypot
    example: v.optional(v.boolean()),
  },
  returns: v.object({ token: v.string(), cached: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.website && args.website.trim()) throw new ConvexError("Request rejected.");
    let domain: string;
    try {
      domain = normalizeDomain(args.domain);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid domain.");
    }
    const now = Date.now();
    if (args.ipHash && !(await consume(ctx, `ip:${args.ipHash.slice(0, 64)}`, RATE_LIMITS.ip, now))) {
      throw new ConvexError("Too many research requests from your network. Try again in an hour.");
    }
    const token = newToken(crypto.getRandomValues(new Uint8Array(16)));

    const recent = await ctx.db
      .query("researchSessions")
      .withIndex("by_domain", (q) => q.eq("domain", domain).gte("createdAt", now - SESSION_CACHE_MS))
      .order("desc")
      .take(10);
    // Sessions from before research stopped on failure may carry a heuristic ICP; never reuse one.
    const reusable = recent.filter((s) => s.status === "ready" && s.icpSource !== "heuristic");
    const cached = reusable.find((s) => !s.cachedFromToken) ?? reusable[0];
    if (args.example && (!EXAMPLE_DOMAINS.includes(domain) || !cached)) throw new ConvexError("This example is no longer cached. Try your own website.");
    if (cached) {
      const sessionId = await ctx.db.insert("researchSessions", {
        token,
        domain,
        status: "ready",
        icp: cached.icp,
        icpSource: cached.icpSource,
        icpNote: cached.icpNote,
        filter: cached.filter,
        tamTotal: cached.tamTotal,
        segments: cached.segments,
        preview: cached.preview,
        tam: cached.tam,
        marketSegments: cached.marketSegments,
        companyFinding: cached.companyFinding,
        teamShape: cached.teamShape,
        completedCards: cached.completedCards,
        brief: cached.brief,
        briefStatus: cached.briefStatus,
        ...(cached.briefStatus === "pending" ? { briefSourceId: cached.briefSourceId ?? cached._id } : {}),
        startingPlan: buildStartingPlan({ team: cached.teamShape, company: cached.companyFinding, segmentId: cached.segments?.[0]?.id }),
        events: [{ at: now, kind: "cached", text: `Loaded recent research for ${domain}.` }, ...(cached.events ?? []).filter((event) => event.kind !== "cached")].slice(0, 48),
        ipHash: args.ipHash,
        cachedFromToken: cached.token,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.recordActions.prepareSession, { sessionId });
      if (!cached.briefStatus) await ctx.scheduler.runAfter(0, internal.researchSessionActions.buildBrief, { sessionId });
      return { token, cached: true };
    }

    if (!(await consume(ctx, `domain:${domain}`, RATE_LIMITS.domain, now))) {
      throw new ConvexError(`Research for ${domain} is already running. Try again shortly.`);
    }
    if (!(await consume(ctx, "global", RATE_LIMITS.global, now))) {
      throw new ConvexError("Research is at capacity right now. Try again later.");
    }
    const sessionId = await ctx.db.insert("researchSessions", {
      token,
      domain,
      status: "deriving",
      events: [{ at: now, kind: "reading", text: `Reading ${domain}` }],
      ipHash: args.ipHash,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.researchSessionActions.run, { sessionId });
    return { token, cached: false };
  },
});

function fitWeightsOf(icp: unknown) {
  if (!icp) return null;
  try {
    return icpToWeights(icp as Icp, defaultModel("scoring.fit"));
  } catch {
    return null;
  }
}

function publicView(session: Doc<"researchSessions">) {
  return {
    token: session.token,
    status: session.status,
    domain: session.domain,
    companyFinding: session.companyFinding ?? null,
    brief: session.brief ?? null,
    briefStatus: session.briefStatus ?? null,
    waitlisted: Boolean(session.waitlistedAt),
    invited: Boolean(session.invitedEmail),
    companySummaryEdit: session.companySummaryEdit ?? null,
    teamShape: session.teamShape ?? null,
    onboardingAnswers: session.onboardingAnswers ?? {},
    startingPlan: session.startingPlan ?? null,
    planConfirmedAt: session.planConfirmedAt ?? null,
    events: session.events ?? [],
    icp: session.icp ?? null,
    // The weights the record service scores with (icpToWeights), for explaining a fit; not stored.
    fitWeights: fitWeightsOf(session.icp),
    icpSource: session.icpSource ?? null,
    icpNote: session.icpNote ?? null,
    tamTotal: session.tamTotal ?? null,
    // The TAM provider stopped at its per-search cap, so tamTotal is a floor.
    tamSaturated: Boolean((session.filter as { saturated?: boolean } | undefined)?.saturated),
    tamSource: (session.filter as { source?: string } | undefined)?.source ?? "pdl",
    segments: session.segments ?? null,
    preview: session.preview ?? null,
    marketSegments: session.marketSegments ?? null,
    error: session.error ?? null,
    claimed: Boolean(session.claimedByOrgId),
    completedCards: session.completedCards ?? [],
    feedback: session.feedback ?? [],
    importStatus: session.importStatus ?? null,
    cached: Boolean(session.cachedFromToken),
    createdAt: session.createdAt,
  };
}

async function resolvedPublicView(ctx: QueryCtx, session: Doc<"researchSessions">) {
  if (!session.briefSourceId) return publicView(session);
  const source = await ctx.db.get(session.briefSourceId);
  return publicView({ ...session, brief: source?.brief, briefStatus: source?.briefStatus ?? "unavailable" });
}

export const examples = query({
  args: {},
  handler: async (ctx) => {
    const examples: { domain: string; name: string }[] = [];
    for (const domain of EXAMPLE_DOMAINS) {
      const recent = await ctx.db.query("researchSessions").withIndex("by_domain", (q) => q.eq("domain", domain).gte("createdAt", Date.now() - SESSION_CACHE_MS)).order("desc").take(10);
      const session = recent.find((row) => row.status === "ready" && row.icpSource !== "heuristic");
      if (session) examples.push({ domain, name: session.companyFinding?.name ?? domain });
    }
    return examples;
  },
});

export const recordFeedback = mutation({
  args: { token: v.string(), step: feedbackStep, vote: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("researchSessions").withIndex("by_token", (q) => q.eq("token", args.token)).first();
    if (!session || !researchAvailable(session)) throw new ConvexError("This research session has expired.");
    if (session.claimedByOrgId) {
      const user = await getCurrentUser(ctx);
      if (!user || user.orgId !== session.claimedByOrgId || await agentClientOf(ctx)) throw new ConvexError("This session belongs to another workspace.");
    }
    const feedback = (session.feedback ?? []).filter((entry) => entry.step !== args.step);
    feedback.push({ step: args.step, vote: args.vote, at: Date.now() });
    await ctx.db.patch(session._id, { feedback });
    return null;
  },
});

export const get = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    return session && researchAvailable(session) ? resolvedPublicView(ctx, session) : null;
  },
});

/** The caller org's most recent claimed session (drives the import banner). */
export const forMyOrg = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId))
      .order("desc")
      .first();
    if (!session) return null;
    return {
      ...await resolvedPublicView(ctx, session),
      importedAccounts: session.importedAccounts ?? null,
      importError: session.importError ?? null,
      contactsSampled: session.contactsSampled ?? null,
      contactsNote: session.contactsNote ?? null,
    };
  },
});

/**
 * Claim an anonymous session into the caller's org and copy its TAM into the
 * workspace. Idempotent for the same org (no second import); rejected when a
 * different org already claimed it.
 */
export const claimAccess = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    const identity = await ctx.auth.getUserIdentity();
    return Boolean(
      session &&
        researchAvailable(session) &&
        session.invitedEmail &&
        identity?.emailVerified &&
        identity.email?.toLowerCase() === session.invitedEmail,
    );
  },
});

export const claim = mutation({
  args: { token: v.string() },
  returns: v.object({ orgId: v.id("organizations"), redirect: v.string(), alreadyClaimed: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return claimForUser(ctx, user, args.token);
  },
});

export async function claimForUser(ctx: MutationCtx, user: Doc<"users">, token: string) {
  const session = await ctx.db
    .query("researchSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();
  if (!session || (!session.claimedByOrgId && !researchAvailable(session))) throw new ConvexError("Research session not found or expired.");
  let decision;
  try {
    decision = decideClaim({ status: session.status, claimedByOrgId: session.claimedByOrgId }, user.orgId);
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "Claim rejected.");
  }
  const plan = session.startingPlan ?? buildStartingPlan({ team: session.teamShape, answers: session.onboardingAnswers, company: session.companyFinding, segmentId: session.segments?.[0]?.id });
  const redirect = plan.landing || claimRedirect(session.segments);
  if (decision.kind === "already_claimed_by_you") return { orgId: user.orgId, redirect, alreadyClaimed: true };

  const identity = await ctx.auth.getUserIdentity();
  if (!session.invitedEmail || !identity?.emailVerified || identity.email?.toLowerCase() !== session.invitedEmail || await agentClientOf(ctx)) {
    throw new ConvexError("This research is saved for the waitlist. An invitation for your verified email is required.");
  }
  const now = Date.now();
  const org = await ctx.db.get(user.orgId);
  if (org && org.createdAt >= session.createdAt && !org.startingPlan && mayDecide({ user, agent: await agentClientOf(ctx) })) {
    await requireDecider(ctx);
    await ctx.db.patch(org._id, { startingPlan: plan });
    await applyStartingPlan(ctx, user);
  }
  if (org && org.createdAt >= session.createdAt && !org.signupInvestigation) {
    await ctx.db.patch(org._id, { signupInvestigation: { state: "pending", sessionId: session._id } });
  }
  await ctx.db.patch(session._id, {
    claimedByOrgId: user.orgId,
    claimedByUserId: user._id,
    claimedAt: now,
    importStatus: "pending",
    ...(session.createdAt + SESSION_CACHE_MS <= now ? { preparationStatus: undefined, preparationKey: `${session._id}-claim`, preparationExpiresAt: now + SESSION_CACHE_MS } : {}),
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.recordActions.importSession, { sessionId: session._id });
  return { orgId: user.orgId, redirect, alreadyClaimed: false };
}

export const updateOnboarding = mutation({
  args: { token: v.string(), summary: v.optional(v.string()), crm: v.optional(crmValue), sellers: v.optional(sellersValue), confirm: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("researchSessions").withIndex("by_token", (q) => q.eq("token", args.token)).first();
    if (!session || !researchAvailable(session) || session.claimedByOrgId || session.status === "failed") throw new ConvexError("This session can no longer be edited.");
    if (args.summary !== undefined && (!args.summary.trim() || args.summary.length > 600)) throw new ConvexError("Use a description of 1 to 600 characters.");
    if (args.confirm && session.status !== "ready") throw new ConvexError("Wait for research to finish before confirming.");
    const answers: OnboardingAnswers = { ...session.onboardingAnswers, ...(args.crm ? { crm: args.crm } : {}), ...(args.sellers ? { sellers: args.sellers } : {}) };
    const startingPlan = buildStartingPlan({ team: session.teamShape, answers, company: session.companyFinding, segmentId: session.segments?.[0]?.id });
    await ctx.db.patch(session._id, {
      onboardingAnswers: answers, startingPlan,
      ...(args.summary !== undefined ? { companySummaryEdit: args.summary.trim() } : {}),
      planConfirmedAt: args.confirm ? Date.now() : undefined, updatedAt: Date.now(),
    });
    return null;
  },
});

export const joinWaitlist = mutation({
  args: {
    token: v.string(),
    email: v.string(),
    role: v.optional(v.string()),
    teamSize: v.optional(v.string()),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.website?.trim()) throw new ConvexError("Request rejected.");
    const parsed = waitlistInput.safeParse({
      email: args.email.trim(),
      role: args.role,
      teamSize: args.teamSize,
    });
    if (!parsed.success)
      throw new ConvexError(
        "Enter a valid work email and keep optional details under their limits.",
      );
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!session || !researchAvailable(session) || session.claimedByOrgId)
      throw new ConvexError("This research session is no longer available.");
    const now = Date.now();
    if (
      !(await consume(
        ctx,
        `waitlist:session:${session._id}`,
        { limit: 3, windowMs: 3600000 },
        now,
      )) ||
      !(await consume(
        ctx,
        `waitlist:domain:${session.domain}`,
        { limit: 20, windowMs: 3600000 },
        now,
      )) ||
      !(await consume(
        ctx,
        "waitlist:global",
        { limit: 500, windowMs: 86400000 },
        now,
      ))
    ) {
      throw new ConvexError("Too many waitlist requests. Try again later.");
    }
    const existing = await ctx.db
      .query("researchWaitlist")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
      .first();
    const entry = { ...parsed.data, updatedAt: now };
    if (existing) await ctx.db.patch(existing._id, entry);
    else {
      await ctx.db.insert("researchWaitlist", {
        sessionId: session._id,
        ...entry,
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.waitlistSlack.notify, {
        email: parsed.data.email,
        domain: session.domain,
        ...(parsed.data.role ? { role: parsed.data.role } : {}),
        ...(parsed.data.teamSize ? { teamSize: parsed.data.teamSize } : {}),
      });
    }
    await ctx.db.patch(session._id, {
      waitlistedAt: session.waitlistedAt ?? now,
    });
    return { saved: true };
  },
});

export const inviteWaitlister = internalMutation({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, { sessionId }) => {
    const lead = await ctx.db
      .query("researchWaitlist")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .first();
    if (!lead) throw new ConvexError("No waitlist entry for this session.");
    await ctx.db.patch(sessionId, { invitedEmail: lead.email });
    return null;
  },
});

export const reserveBrief = internalMutation({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.status !== "ready" || session.briefStatus)
      return false;
    await ctx.db.patch(sessionId, { briefStatus: "pending" });
    return true;
  },
});

export const saveBrief = internalMutation({
  args: {
    sessionId: v.id("researchSessions"),
    brief: v.optional(briefValidator),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("unavailable"),
    ),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.briefStatus === "ready") return null;
    await ctx.db.patch(args.sessionId, {
      briefStatus: args.status,
      ...(args.brief ? { brief: args.brief } : {}),
    });
    return null;
  },
});

// ───────────────────────────── Internal ─────────────────────────────

export const getInternal = internalQuery({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, args) => ctx.db.get(args.sessionId),
});

export const patchFromPipeline = internalMutation({
  args: {
    sessionId: v.id("researchSessions"),
    status: v.optional(statusValidator),
    companyFinding: v.optional(companyFindingValidator),
    teamShape: v.optional(teamShapeValidator),
    event: v.optional(v.object({ kind: v.string(), text: v.string(), evidence: v.optional(v.array(evidenceValidator)) })),
    icp: v.optional(v.any()),
    icpSource: v.optional(v.union(v.literal("llm"), v.literal("heuristic"))),
    icpNote: v.optional(v.string()),
    filter: v.optional(v.any()),
    tamTotal: v.optional(v.number()),
    segments: v.optional(v.array(v.object({ id: v.string(), name: v.string(), count: v.number() }))),
    preview: v.optional(v.array(v.any())),
    tam: v.optional(v.array(v.any())),
    marketSegments: v.optional(marketSegmentsValidator),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { sessionId, event, ...patch } = args;
    const session = await ctx.db.get(sessionId);
    if (!session) return { claimed: false };
    if (session.status === "ready" || session.status === "failed") return { claimed: false };
    const now = Date.now();
    const events = session.events ?? [];
    const prepareTam = patch.tam !== undefined && session.tam === undefined;
    const next = { ...session, ...patch };
    const complete = [
      ...(next.companyFinding || next.icp ? ["offer"] : []),
      ...(next.icp ? ["buyers"] : []),
      ...(next.tam ? ["market"] : []),
      ...(next.teamShape || event?.kind === "team" ? ["team"] : []),
      ...(next.status === "ready" ? ["plan"] : []),
    ];
    const completedCards = [...(session.completedCards ?? [])];
    for (const id of complete) if (!completedCards.includes(id)) completedCards.push(id);
    const startingPlan = next.icp ? buildStartingPlan({ team: next.teamShape, answers: next.onboardingAnswers, company: next.companyFinding, segmentId: next.segments?.[0]?.id }) : undefined;
    await ctx.db.patch(sessionId, {
      ...patch, completedCards, ...(startingPlan ? { startingPlan } : {}),
      ...(event && events.length < 48 ? { events: [...events, { at: now, kind: event.kind.slice(0, 40), text: event.text.slice(0, 500), ...(event.evidence ? { evidence: event.evidence.slice(0, 6) } : {}) }] } : {}),
      updatedAt: now,
    });
    if (prepareTam) {
      await ctx.scheduler.runAfter(0, internal.recordActions.prepareSession, { sessionId });
    }
    if (patch.status === "ready") await ctx.scheduler.runAfter(0, internal.researchSessionActions.buildBrief, { sessionId });
    if (patch.status === "ready" && session.claimedByOrgId && session.importStatus === "pending") {
      await ctx.scheduler.runAfter(0, internal.recordActions.importSession, { sessionId });
    }
    return { claimed: Boolean(session.claimedByOrgId) && session.importStatus === "pending" };
  },
});

/** Logs research that stopped (see researchFailures in schema.ts), next to the console line Convex keeps. */
export const logFailure = internalMutation({
  args: {
    domain: v.string(),
    stage: v.string(),
    message: v.string(),
    detail: v.string(),
    sessionId: v.optional(v.id("researchSessions")),
    orgId: v.optional(v.id("organizations")),
  },
  handler: logResearchFailure,
});

export async function logResearchFailure(ctx: MutationCtx, args: { domain: string; stage: string; message: string; detail: string; sessionId?: Id<"researchSessions">; orgId?: Id<"organizations"> }) {
  console.error(`research failed: ${args.domain} at ${args.stage}: ${args.detail}`);
  await ctx.db.insert("researchFailures", { ...args, detail: args.detail.slice(0, 2000), createdAt: Date.now() });
}

export const patchPreparation = internalMutation({
  args: { sessionId: v.id("researchSessions"), status: v.union(v.literal("ready"), v.literal("failed")), total: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.preparationStatus === "ready") return;
    await ctx.db.patch(args.sessionId, { preparationStatus: args.status, preparedAccounts: args.total, preparationError: args.error });
  },
});

export const patchImport = internalMutation({
  args: {
    sessionId: v.id("researchSessions"),
    importStatus: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
    importError: v.optional(v.string()),
    importedAccounts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { sessionId, ...patch } = args;
    const session = await ctx.db.get(sessionId);
    if (!session || session.importStatus === "done") return;
    await ctx.db.patch(sessionId, {
      ...patch,
      importedAccounts: Math.max(session.importedAccounts ?? 0, patch.importedAccounts ?? 0),
      updatedAt: Date.now(),
    });
    if (patch.importStatus === "done") {
      await ctx.scheduler.runAfter(0, internal.tamInvestigations.afterImport, { sessionId });
    }
  },
});

/** Cost guard: atomically reserve the one contact sample a session may run. */
export const reserveContactSample = internalMutation({
  args: { sessionId: v.id("researchSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.contactsSampledAt) return false;
    await ctx.db.patch(args.sessionId, { contactsSampledAt: Date.now() });
    return true;
  },
});

export const recordContactSample = internalMutation({
  args: { sessionId: v.id("researchSessions"), contactsSampled: v.number(), contactsNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      contactsSampled: args.contactsSampled,
      contactsNote: args.contactsNote,
      updatedAt: Date.now(),
    });
  },
});

export type ResearchSessionId = Id<"researchSessions">;
