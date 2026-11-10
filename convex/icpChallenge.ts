import { assertLegacyIcpsWritable } from "./lib/modules/interfaceOwnership";
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import { startPopulation } from "./populateActions";
import { proposalQuickEnrich } from "./lib/tam/challengeIcp";
import type { ChallengeContext } from "../modules/kernel/icpChallenge";
import type { Icp } from "../engine/src/icp.ts";
import type { Doc } from "./_generated/dataModel";

/**
 * Challenge my ICP: the run row and its reads/writes. The work (LLM proposals,
 * page reads, size estimates) is the Node action in icpChallengeActions.ts.
 * Accepting a market populates it through the normal population job, which
 * only spends treg free routes (convex/populateActions.ts).
 */

const DEALS_PER_SIDE = 15;
/** A run with no update for this long is treated as dead, so a new one may start. */
const STALL_MS = 10 * 60_000;
/** Earlier runs whose accepted/dismissed markets are not proposed again. */
const HISTORY_RUNS = 10;

export const latest = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const run = await ctx.db
      .query("icpChallengeRuns")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .first();
    if (!run) return null;
    return {
      id: run._id,
      status: run.status,
      proposals: run.proposals.map((p, index) => ({ ...p, index })),
      model: run.model ?? null,
      error: run.error ?? null,
      createdAt: run.createdAt,
      // The dialog offers a retry once a proposing run has been quiet this long (start allows it too).
      updatedAt: run.updatedAt,
      stallMs: STALL_MS,
    };
  },
});

export const start = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    await assertLegacyIcpsWritable(ctx, user.orgId);
    const last = await ctx.db
      .query("icpChallengeRuns")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .first();
    if (last?.status === "proposing" && Date.now() - last.updatedAt < STALL_MS) throw new ConvexError("A challenge is already running.");
    const now = Date.now();
    const runId = await ctx.db.insert("icpChallengeRuns", {
      orgId: user.orgId, status: "proposing", proposals: [], createdBy: user._id, createdAt: now, updatedAt: now,
    });
    // The user's id rides along: their ChatGPT plan pays for the proposals.
    await ctx.scheduler.runAfter(0, internal.icpChallengeActions.run, { runId, userId: user._id });
    return { runId };
  },
});

/** Accept a market: it is populated from free treg routes as one tray job. */
export const accept = mutation({
  args: { runId: v.id("icpChallengeRuns"), index: v.number() },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await assertLegacyIcpsWritable(ctx, user.orgId);
    const run = await ctx.db.get(args.runId);
    const p = run?.orgId === user.orgId ? run.proposals[args.index] : undefined;
    if (!run || !p) throw new ConvexError("Unknown market");
    if (p.state !== "open") throw new ConvexError(p.state === "accepted" ? "Already accepted." : "This market was dismissed.");
    const session = await ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId)).order("desc").first();
    if (!session) throw new ConvexError("Set up your market first: there is no researched workspace to populate from.");
    await ctx.db.patch(run._id, { proposals: setState(run, args.index, { state: "accepted" }), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.icpChallenge.populate, { runId: run._id, index: args.index, sessionId: session._id });
    return null;
  },
});

/** Dismiss a market with an optional reason; it is not proposed again. */
export const dismiss = mutation({
  args: { runId: v.id("icpChallengeRuns"), index: v.number(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await assertLegacyIcpsWritable(ctx, user.orgId);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId || !run.proposals[args.index]) throw new ConvexError("Unknown market");
    if (run.proposals[args.index].state !== "open") throw new ConvexError("Already decided.");
    const reason = args.reason?.trim().slice(0, 200);
    await ctx.db.patch(run._id, { proposals: setState(run, args.index, { state: "dismissed", ...(reason ? { dismissReason: reason } : {}) }), updatedAt: Date.now() });
    return null;
  },
});

function setState(run: Doc<"icpChallengeRuns">, index: number, patch: { state: "open" | "accepted" | "dismissed"; dismissReason?: string }) {
  return run.proposals.map((p, i) => (i === index ? { ...p, ...patch } : p));
}

// ───────────────────────────── Internal ─────────────────────────────

/** Population for one accepted market: the free QuickEnrich search for its industries, size and countries. */
export const populate = internalAction({
  args: { runId: v.id("icpChallengeRuns"), index: v.number(), sessionId: v.id("researchSessions") },
  handler: async (ctx, args) => {
    try {
      const run = await ctx.runQuery(internal.icpChallenge.getRun, { runId: args.runId });
      const p = run?.proposals[args.index];
      const session = await ctx.runQuery(internal.researchSessions.getInternal, { sessionId: args.sessionId });
      if (!run || !p || !session?.claimedByOrgId) return null;
      await startPopulation(ctx, args.sessionId, session.claimedByOrgId, [{ kind: "people", source: "quickenrich", query: proposalQuickEnrich(p, session.icp as Icp | undefined) }], {
        title: `Populate ${p.name}`,
        detail: `Searching ${p.industries.join(", ")}…`,
      });
    } catch (error) {
      console.error(`icp challenge: could not start populating: ${error instanceof Error ? error.message : error}`);
      await ctx.runMutation(internal.icpChallenge.update, { runId: args.runId, reopen: args.index });
    }
    return null;
  },
});

export const getRun = internalQuery({
  args: { runId: v.id("icpChallengeRuns") },
  handler: async (ctx, args) => { const run = await ctx.db.get(args.runId); if (run) await assertLegacyIcpsWritable(ctx, run.orgId); return run; },
});

/** What the LLM reads: current ICP, what is sold, won/lost deals and markets already decided. */
export const context = internalQuery({
  args: { runId: v.id("icpChallengeRuns") },
  handler: async (ctx, args): Promise<Omit<ChallengeContext, "bestAccounts">> => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("run not found");
    const orgId = run.orgId;
    await assertLegacyIcpsWritable(ctx, orgId);
    const session = await ctx.db.query("researchSessions").withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", orgId)).order("desc").first();
    const ms = session?.marketSegments;
    const deals = await ctx.db.query("deals").withIndex("by_orgId_closeDate", (q) => q.eq("orgId", orgId)).order("desc").take(300);
    const shaped = async (won: boolean) => {
      const out = [];
      for (const d of deals.filter((x) => x.isClosed && x.isWon === won && x.archivedAt === undefined).slice(0, DEALS_PER_SIDE)) {
        const a = d.accountId ? await ctx.db.get(d.accountId) : null;
        out.push({
          name: d.name,
          ...(won && d.amount !== undefined ? { amount: d.amount } : {}),
          ...(a ? { account: a.name } : {}),
          ...(a?.industry ? { industry: a.industry } : {}),
          ...(a?.employeeCount !== undefined ? { employees: a.employeeCount } : {}),
        });
      }
      return out;
    };
    const history = await ctx.db.query("icpChallengeRuns").withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", orgId)).order("desc").take(HISTORY_RUNS);
    const decided = history.flatMap((r) => r.proposals.filter((p) => p.state !== "open").map((p) => ({ name: p.name, industries: p.industries, state: p.state, reason: p.dismissReason })));
    return {
      ...(session ? { vendorDomain: session.domain } : {}),
      ...(session?.icp ? { icp: session.icp } : {}),
      sells: [...(ms?.jobs ?? []), ...(ms?.buyers ?? []).map((b) => `Sold to ${b.label}: ${b.why}`)],
      wonDeals: await shaped(true),
      lostDeals: await shaped(false),
      decided,
    };
  },
});

export const update = internalMutation({
  args: {
    runId: v.id("icpChallengeRuns"),
    status: v.optional(v.union(v.literal("done"), v.literal("failed"))),
    proposals: v.optional(v.array(v.any())),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
    /** A market whose population could not start goes back to open. */
    reopen: v.optional(v.number()),
  },
  handler: async (ctx, { runId, reopen, proposals, ...patch }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    await assertLegacyIcpsWritable(ctx, run.orgId);
    await ctx.db.patch(runId, {
      ...patch,
      ...(proposals ? { proposals: proposals as Doc<"icpChallengeRuns">["proposals"] } : {}),
      ...(reopen !== undefined && run.proposals[reopen] ? { proposals: setState(run, reopen, { state: "open" }) } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});
