import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import { filterValidator } from "./lib/scopeValidators";
import { insertSegment } from "./tam";
import type { SuggestionContext } from "./lib/tam/segmentSuggestions";

/**
 * Recommended AI segments: the run row and its reads/writes. The work (LLM
 * proposals, Jev measurement) is the Node action in tamSuggestActions.ts.
 */

const CALL_INSIGHT_TYPES = ["pain_point", "objection", "competitor_mention", "decision_criteria"] as const;
const INSIGHTS_PER_TYPE = 8;
const CLOSED_DEALS = 40;
/** A run with no update for this long is treated as dead, so a new one may start. */
const STALL_MS = 10 * 60_000;

export const latest = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const run = await ctx.db
      .query("tamSuggestionRuns")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .first();
    if (!run) return null;
    return {
      id: run._id,
      status: run.status,
      suggestions: run.suggestions.map((s, index) => ({ ...s, index })),
      sampleSize: run.sampleSize ?? null,
      model: run.model ?? null,
      note: run.note ?? null,
      error: run.error ?? null,
      createdAt: run.createdAt,
    };
  },
});

export const start = mutation({
  args: { filter: filterValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const last = await ctx.db
      .query("tamSuggestionRuns")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .first();
    if (last && (last.status === "proposing" || last.status === "measuring") && Date.now() - last.updatedAt < STALL_MS) {
      throw new ConvexError("Segment recommendations are already being prepared.");
    }
    const now = Date.now();
    const runId = await ctx.db.insert("tamSuggestionRuns", {
      orgId: user.orgId,
      filter: args.filter,
      status: "proposing",
      suggestions: [],
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    // The user's id rides along: their ChatGPT plan pays for the proposals.
    await ctx.scheduler.runAfter(0, internal.tamSuggestActions.run, { runId, userId: user._id });
    return { runId };
  },
});

/** Accept one recommendation: it becomes a normal AI segment. */
export const add = mutation({
  args: { runId: v.id("tamSuggestionRuns"), index: v.number() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId) throw new ConvexError("Unknown recommendation");
    const s = run.suggestions[args.index];
    if (!s) throw new ConvexError("Unknown recommendation");
    if (s.added) throw new ConvexError("Already added.");
    const { key } = await insertSegment(ctx, user, { label: s.label, criterion: s.criterion, kind: s.kind, options: s.options });
    const suggestions = run.suggestions.map((x, i) => (i === args.index ? { ...x, added: true } : x));
    await ctx.db.patch(run._id, { suggestions, updatedAt: Date.now() });
    return { key };
  },
});

// ───────────────────────────── Internal ─────────────────────────────

export const getRun = internalQuery({
  args: { runId: v.id("tamSuggestionRuns") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

/** What the LLM reads: research, existing segments, closed deals, call insights. */
export const context = internalQuery({
  args: { runId: v.id("tamSuggestionRuns") },
  handler: async (ctx, args): Promise<Omit<SuggestionContext, "sampleAccounts">> => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("run not found");
    const orgId = run.orgId;
    const session = await ctx.db
      .query("researchSessions")
      .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", orgId))
      .order("desc")
      .first();
    const ms = session?.marketSegments;
    const segments = await ctx.db
      .query("tamSegments")
      .withIndex("by_orgId_and_key", (q) => q.eq("orgId", orgId))
      .take(60);
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_orgId_closeDate", (q) => q.eq("orgId", orgId))
      .order("desc")
      .take(300);
    const closed = deals.filter((d) => d.isClosed && d.archivedAt === undefined).slice(0, CLOSED_DEALS);
    const closedDeals = [];
    for (const d of closed) {
      const account = d.accountId ? await ctx.db.get(d.accountId) : null;
      closedDeals.push({
        name: d.name,
        won: d.isWon,
        ...(d.amount !== undefined ? { amount: d.amount } : {}),
        ...(account ? { account: account.name } : {}),
        ...(account?.industry ? { industry: account.industry } : {}),
        ...(account?.employeeCount !== undefined ? { employees: account.employeeCount } : {}),
      });
    }
    const callInsights = [];
    for (const type of CALL_INSIGHT_TYPES) {
      const rows = await ctx.db
        .query("callInsights")
        .withIndex("by_orgId_type", (q) => q.eq("orgId", orgId).eq("type", type))
        .order("desc")
        .take(INSIGHTS_PER_TYPE);
      for (const r of rows) if (r.status !== "dismissed") callInsights.push({ type, text: r.text, evidence: r.evidence });
    }
    return {
      ...(session ? { vendorDomain: session.domain } : {}),
      ...(session?.icp ? { icp: session.icp } : {}),
      buyers: [
        ...(ms?.buyers ?? []).map((b) => ({ label: b.label, why: b.why })),
        ...(ms?.adjacent ?? []).map((b) => ({ label: `${b.label} (adjacent)`, why: b.why })),
      ],
      jobs: ms?.jobs ?? [],
      existingSegments: segments.map((s) => ({ label: s.label, criterion: s.criterion })),
      closedDeals,
      callInsights,
    };
  },
});

const suggestionValidator = v.object({
  label: v.string(),
  kind: v.union(v.literal("noul"), v.literal("choice")),
  criterion: v.string(),
  options: v.optional(v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) }))),
  rationale: v.string(),
  basis: v.array(v.string()),
  counts: v.optional(v.record(v.string(), v.number())),
  score: v.optional(v.number()),
  verdict: v.optional(v.string()),
});

export const update = internalMutation({
  args: {
    runId: v.id("tamSuggestionRuns"),
    status: v.optional(v.union(v.literal("measuring"), v.literal("done"), v.literal("failed"))),
    suggestions: v.optional(v.array(suggestionValidator)),
    sampleSize: v.optional(v.number()),
    model: v.optional(v.string()),
    note: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    await ctx.db.patch(runId, { ...patch, updatedAt: Date.now() });
    return null;
  },
});
