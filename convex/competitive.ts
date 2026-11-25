import { ConvexError, v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import type { Doc, Id } from "./_generated/dataModel";

function competitorReadinessFromRows(competitors: any[], battlecards: any[], winLoss: any[]) {
  const relevant = competitors.length > 0 || battlecards.length > 0 || winLoss.length > 0;
  return {
    noun: "competitor",
    required: false,
    relevant,
    configured: competitors.length > 0,
    lifecycle: competitors.length > 0 ? "tracked" : relevant ? "evidence_only" : "not_relevant_yet",
    signals: { competitorCount: competitors.length, battlecardCount: battlecards.length, winLossRecords: winLoss.length },
    nextActions: competitors.length > 0 ? ["review battlecards", "find win/loss patterns"] : ["Use @canon/win-loss with verbatim evidence"],
  };
}

function emptyCompetitorReadiness() {
  return {
    noun: "competitor",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { competitorCount: 0, battlecardCount: 0, winLossRecords: 0 },
    nextActions: ["Sign in to inspect competitor readiness"],
  };
}

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyCompetitorReadiness();
    const [competitors, battlecards, winLoss] = await Promise.all([
      ctx.db.query("competitors").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("battlecards").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("winLossRecords").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(250),
    ]);
    return competitorReadinessFromRows(competitors, battlecards, winLoss);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyCompetitorReadiness(), competitors: [], battlecards: [], winLoss: [] };
    // Read budget: competitors 200 + battlecards 200 + winLoss 500 + one deal
    // point read per winLoss row (≤500) + viewer lookup ~2 ≈ 1,402 worst case
    // (was a take(5000) deals scan just to name/amount-join the records).
    const [competitors, battlecards, winLoss] = await Promise.all([
      ctx.db.query("competitors").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("battlecards").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("winLossRecords").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500),
    ]);
    const competitorsById = new Map(competitors.map((competitor) => [competitor._id, competitor]));
    const dealIds = Array.from(new Set(winLoss.map((record) => record.dealId)));
    const dealRows = await Promise.all(dealIds.map((dealId) => ctx.db.get(dealId)));
    const dealsById = new Map(
      dealRows
        .filter((deal): deal is NonNullable<typeof deal> => deal !== null && deal.orgId === user.orgId)
        .map((deal) => [deal._id, deal]),
    );
    return {
      readiness: competitorReadinessFromRows(competitors, battlecards, winLoss),
      competitors,
      battlecards,
      winLoss: winLoss.map((record) => ({
        ...record,
        dealName: dealsById.get(record.dealId)?.name ?? "Unknown deal",
        dealAmount: dealsById.get(record.dealId)?.amount,
        competitorName: record.competitorId ? competitorsById.get(record.competitorId)?.name ?? "Unknown competitor" : "No competitor",
      })),
    };
  },
});

export const listCompetitors = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("competitors")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(100);
  },
});

export const getCompetitor = query({
  args: { competitorId: v.id("competitors") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const competitor = await ctx.db.get(args.competitorId);
    if (!competitor || competitor.orgId !== user.orgId) return null;
    return competitor;
  },
});

export const listBattlecards = query({
  args: { competitorId: v.optional(v.id("competitors")) },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const cards = args.competitorId
      ? await ctx.db
          .query("battlecards")
          .withIndex("by_competitorId", (q) =>
            q.eq("competitorId", args.competitorId!),
          )
          .take(100)
      : await ctx.db
          .query("battlecards")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .take(100);

    const enriched = [];
    for (const card of cards.filter((card) => card.orgId === user.orgId)) {
      const competitor = await ctx.db.get(card.competitorId);
      enriched.push({
        ...card,
        competitorName: competitor?.name ?? "Unknown competitor",
      });
    }
    return enriched;
  },
});

export const listWinLoss = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const records = await ctx.db
      .query("winLossRecords")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(250);

    const enriched = [];
    for (const record of records) {
      const deal = await ctx.db.get(record.dealId);
      const competitor = record.competitorId
        ? await ctx.db.get(record.competitorId)
        : null;
      enriched.push({
        ...record,
        dealName: deal?.name ?? "Unknown deal",
        dealAmount: deal?.amount,
        competitorName: competitor?.name ?? "No competitor",
      });
    }
    return enriched;
  },
});

export const getWinLossStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return {
      wins: 0,
      losses: 0,
      total: 0,
      lossReasons: {},
      byCompetitor: [],
    };
    const records = await ctx.db
      .query("winLossRecords")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(500);

    const statsByCompetitor = new Map<
      Id<"competitors"> | "none",
      { competitorId: Id<"competitors"> | null; wins: number; losses: number; total: number }
    >();

    for (const record of records) {
      const key = record.competitorId ?? "none";
      if (!statsByCompetitor.has(key)) {
        statsByCompetitor.set(key, {
          competitorId: record.competitorId ?? null,
          wins: 0,
          losses: 0,
          total: 0,
        });
      }
      const stats = statsByCompetitor.get(key)!;
      if (record.outcome === "won") stats.wins++;
      else stats.losses++;
      stats.total++;
    }

    const lossReasons: Record<string, number> = {};
    let wins = 0;
    let losses = 0;
    for (const record of records) {
      if (record.outcome === "won") {
        wins++;
      } else {
        losses++;
        const reason = record.primaryReason ?? "Unspecified";
        lossReasons[reason] = (lossReasons[reason] ?? 0) + 1;
      }
    }

    const results = [];
    const entries = Array.from(statsByCompetitor.values());
    for (const stats of entries) {
      let competitorName = "No competitor";
      if (stats.competitorId) {
        const competitor = await ctx.db.get(stats.competitorId);
        competitorName = competitor?.name ?? "Unknown";
      }
      results.push({ ...stats, competitorName });
    }

    return {
      wins,
      losses,
      total: records.length,
      lossReasons,
      byCompetitor: results.sort((a, b) => b.total - a.total),
    };
  },
});

// ── Mutations ─────────────────────────────────────────────────────

export const createCompetitor = mutation({
  args: {
    name: v.string(),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    strengths: v.optional(v.array(v.string())),
    weaknesses: v.optional(v.array(v.string())),
    positioning: v.optional(v.string()),
    pricingNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const now = Date.now();
    return ctx.db.insert("competitors", {
      orgId: user.orgId,
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCompetitor = mutation({
  args: {
    competitorId: v.id("competitors"),
    name: v.optional(v.string()),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    strengths: v.optional(v.array(v.string())),
    weaknesses: v.optional(v.array(v.string())),
    positioning: v.optional(v.string()),
    pricingNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { competitorId, ...updates } = args;
    const competitor = await ctx.db.get(competitorId);
    if (!competitor || competitor.orgId !== user.orgId)
      throw new Error("Competitor not found");

    const cleanUpdates: Partial<Doc<"competitors">> = {
      updatedAt: Date.now(),
    };
    if (updates.name !== undefined) cleanUpdates.name = updates.name;
    if (updates.website !== undefined) cleanUpdates.website = updates.website;
    if (updates.description !== undefined) {
      cleanUpdates.description = updates.description;
    }
    if (updates.strengths !== undefined) cleanUpdates.strengths = updates.strengths;
    if (updates.weaknesses !== undefined) {
      cleanUpdates.weaknesses = updates.weaknesses;
    }
    if (updates.positioning !== undefined) {
      cleanUpdates.positioning = updates.positioning;
    }
    if (updates.pricingNotes !== undefined) {
      cleanUpdates.pricingNotes = updates.pricingNotes;
    }
    await ctx.db.patch(competitorId, cleanUpdates);
  },
});

export const createBattlecard = mutation({
  args: {
    competitorId: v.id("competitors"),
    title: v.string(),
    category: v.union(
      v.literal("overview"),
      v.literal("objection_handling"),
      v.literal("feature_comparison"),
      v.literal("pricing"),
      v.literal("talk_track"),
      v.literal("landmine"),
    ),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const competitor = await ctx.db.get(args.competitorId);
    if (!competitor || competitor.orgId !== user.orgId)
      throw new Error("Competitor not found");

    const now = Date.now();
    return ctx.db.insert("battlecards", {
      orgId: user.orgId,
      ...args,
      isActive: true,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateBattlecard = mutation({
  args: {
    battlecardId: v.id("battlecards"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { battlecardId, ...updates } = args;
    const battlecard = await ctx.db.get(battlecardId);
    if (!battlecard || battlecard.orgId !== user.orgId)
      throw new Error("Battlecard not found");

    const cleanUpdates: Partial<Doc<"battlecards">> = {
      updatedAt: Date.now(),
    };
    if (updates.title !== undefined) cleanUpdates.title = updates.title;
    if (updates.content !== undefined) cleanUpdates.content = updates.content;
    if (updates.isActive !== undefined) cleanUpdates.isActive = updates.isActive;
    await ctx.db.patch(battlecardId, cleanUpdates);
  },
});

export const recordWinLoss = mutation({
  args: {
    dealId: v.id("deals"),
    outcome: v.union(v.literal("won"), v.literal("lost")),
    competitorId: v.optional(v.id("competitors")),
    primaryReason: v.optional(v.string()),
    reasons: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "win-loss over the CRM");
    const now = Date.now();
    return ctx.db.insert("winLossRecords", {
      orgId: user.orgId,
      ...args,
      recordedBy: user._id,
      createdAt: now,
    });
  },
});

/** Kept as a refusal for old GTM, HTTP and CLI callers; no generated claims are written. */
export const generateFromDeals = mutation({
  args: {},
  handler: async (): Promise<{ competitorsCreated: number; competitorsUpdated: number; battlecardsCreated: number; winLossCreated: number; competitors: number }> => {
    throw new ConvexError("Legacy competitive generation is retired. Use @canon/win-loss with verbatim evidence instead.");
  },
});
