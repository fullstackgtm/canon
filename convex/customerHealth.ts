import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { query, mutation } from "./_generated/server";
import { requireUser } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import { modelSettings } from "./lib/recipes";
import type { HealthModel } from "../recipes/index.ts";

function healthReadinessFromRows(configs: any[], scores: any[], accounts: any[]) {
  const atRisk = scores.filter((score) => score.health === "at_risk" || score.health === "churning").length;
  const relevant = configs.length > 0 || scores.length > 0 || accounts.length > 0;
  return {
    noun: "health",
    required: false,
    relevant,
    configured: configs.length > 0 || scores.length > 0,
    lifecycle: scores.length > 0 ? "scored" : configs.length > 0 ? "configured" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { configCount: configs.length, scoreCount: scores.length, accountCount: accounts.length, atRiskAccounts: atRisk },
    nextActions: configs.length > 0 || scores.length > 0 ? ["review at-risk accounts", "set health.config"] : ["do health.bootstrap", "sync account usage/support data"],
  };
}

function emptyHealthReadiness() {
  return {
    noun: "health",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { configCount: 0, scoreCount: 0, accountCount: 0, atRiskAccounts: 0 },
    nextActions: ["Sign in to inspect health readiness"],
  };
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function daysSince(timestamp: number | undefined) {
  if (!timestamp) return 999;
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

function healthFromScore(score: number, bands: HealthModel["bands"]): "healthy" | "at_risk" | "churning" {
  if (score >= bands.healthy) return "healthy";
  if (score >= bands.atRisk) return "at_risk";
  return "churning";
}

function expansionPotential(args: {
  openExpansion: number;
  arrAmount: number;
  contactCount: number;
}, expansion: HealthModel["expansion"]): "high" | "medium" | "low" {
  if (args.openExpansion > 0 || args.arrAmount >= expansion.highArr) return "high";
  if (args.contactCount >= expansion.mediumContacts || args.arrAmount >= expansion.mediumArr) return "medium";
  return "low";
}

// ── Queries ───────────────────────────────────────────────────────

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyHealthReadiness();
    const [configs, scores, accounts] = await Promise.all([
      ctx.db.query("customerHealthConfigs").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("customerHealthScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    return healthReadinessFromRows(configs, scores, accounts);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyHealthReadiness(), configs: [], scores: [], bands: null };
    const [configs, scores, accounts] = await Promise.all([
      ctx.db.query("customerHealthConfigs").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("customerHealthScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const accountsById = new Map(accounts.map((account) => [account._id, account]));
    return {
      readiness: healthReadinessFromRows(configs, scores, accounts),
      configs,
      // Where the health page's score bars change colour: the workspace's health.model bands.
      bands: (await modelSettings(ctx, user.orgId, "health.model")).bands,
      scores: scores.map((score) => {
        const account = accountsById.get(score.accountId);
        return {
          ...score,
          accountName: account?.name ?? "Unknown",
          accountDomain: account?.domain,
          accountIndustry: account?.industry,
        };
      }),
    };
  },
});

export const listConfigs = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("customerHealthConfigs")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(50);
  },
});

export const listScores = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const scores = await ctx.db
      .query("customerHealthScores")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(500);

    // Enrich with account data
    const enriched = await Promise.all(
      scores.map(async (score) => {
        const account = await ctx.db.get(score.accountId);
        return {
          ...score,
          accountName: account?.name ?? "Unknown",
          accountDomain: account?.domain,
          accountIndustry: account?.industry,
        };
      }),
    );

    return enriched;
  },
});

export const listByHealth = query({
  args: {
    health: v.union(
      v.literal("healthy"),
      v.literal("at_risk"),
      v.literal("churning"),
    ),
  },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const scores = await ctx.db
      .query("customerHealthScores")
      .withIndex("by_orgId_health", (q) =>
        q.eq("orgId", user.orgId).eq("health", args.health),
      )
      .take(500);

    const enriched = await Promise.all(
      scores.map(async (score) => {
        const account = await ctx.db.get(score.accountId);
        return {
          ...score,
          accountName: account?.name ?? "Unknown",
          accountDomain: account?.domain,
          accountIndustry: account?.industry,
        };
      }),
    );

    return enriched;
  },
});

export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { healthy: 0, atRisk: 0, churning: 0, total: 0, totalArrAtRisk: 0 };
    const scores = await ctx.db
      .query("customerHealthScores")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(1000);

    let healthy = 0;
    let atRisk = 0;
    let churning = 0;
    let totalArrAtRisk = 0;

    for (const score of scores) {
      if (score.health === "healthy") healthy++;
      else if (score.health === "at_risk") {
        atRisk++;
        totalArrAtRisk += score.arrAmount ?? 0;
      } else if (score.health === "churning") {
        churning++;
        totalArrAtRisk += score.arrAmount ?? 0;
      }
    }

    return {
      healthy,
      atRisk,
      churning,
      total: scores.length,
      totalArrAtRisk,
    };
  },
});

// ── Mutations ─────────────────────────────────────────────────────

export const createConfig = mutation({
  args: {
    name: v.string(),
    signals: v.array(
      v.object({
        name: v.string(),
        source: v.string(),
        weight: v.number(),
        goodThreshold: v.number(),
        badThreshold: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const now = Date.now();
    return ctx.db.insert("customerHealthConfigs", {
      orgId: user.orgId,
      name: args.name,
      signals: args.signals,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const generateFromCrm = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "health scores over the CRM");
    if (!can(user, "strategy.edit")) throw new ConvexError(refusal("strategy.edit"));

    const now = Date.now();
    const model = await modelSettings(ctx, user.orgId, "health.model");
    const [configs, accounts, contacts, deals] = await Promise.all([
      ctx.db
        .query("customerHealthConfigs")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(25),
      ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("crmContacts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(1000),
    ]);

    const activeConfig = configs.find((candidate) => candidate.isActive) ?? configs[0];
    let configId = activeConfig?._id;
    if (!configId) {
      configId = await ctx.db.insert("customerHealthConfigs", {
        orgId: user.orgId,
        name: "CRM Health Model",
        signals: [
          {
            name: "Won revenue",
            source: "deals",
            weight: 0.35,
            goodThreshold: 10000000,
            badThreshold: 1000000,
          },
          {
            name: "Buying committee coverage",
            source: "contacts",
            weight: 0.2,
            goodThreshold: 3,
            badThreshold: 1,
          },
          {
            name: "Expansion pipeline",
            source: "deals",
            weight: 0.2,
            goodThreshold: 1,
            badThreshold: 0,
          },
          {
            name: "Owner coverage",
            source: "crm",
            weight: 0.15,
            goodThreshold: 1,
            badThreshold: 0,
          },
          {
            name: "Sync freshness",
            source: "crm",
            weight: 0.1,
            goodThreshold: 7,
            badThreshold: 30,
          },
        ],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const contactsByAccount = new Map<string, number>();
    for (const contact of contacts) {
      if (!contact.accountId) continue;
      contactsByAccount.set(
        contact.accountId,
        (contactsByAccount.get(contact.accountId) ?? 0) + 1,
      );
    }

    const dealsByAccount = new Map<string, typeof deals>();
    for (const deal of deals) {
      if (!deal.accountId) continue;
      dealsByAccount.set(deal.accountId, [
        ...(dealsByAccount.get(deal.accountId) ?? []),
        deal,
      ]);
    }

    const accountRows = accounts.map((account) => {
      const accountDeals = dealsByAccount.get(account._id) ?? [];
      const wonDeals = accountDeals.filter((deal) => deal.isWon);
      const openDeals = accountDeals.filter((deal) => !deal.isClosed);
      const openExpansionDeals = accountDeals.filter(
        (deal) =>
          !deal.isClosed &&
          (deal.dealType === "expansion" || deal.dealType === "renewal"),
      );
      const arrAmount = wonDeals.reduce(
        (sum, deal) => sum + (deal.arr ?? deal.amount ?? 0),
        0,
      );
      const openPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
      const openExpansion = openExpansionDeals.reduce(
        (sum, deal) => sum + (deal.amount ?? 0),
        0,
      );
      const contactCount = contactsByAccount.get(account._id) ?? 0;
      const syncAge = daysSince(account.lastSyncAt);
      const hasCustomerSignal = wonDeals.length > 0 || openExpansionDeals.length > 0;
      const priority =
        (hasCustomerSignal ? 1_000_000_000_000 : 0) +
        arrAmount +
        openExpansion +
        openPipeline * 0.5 +
        contactCount * 100_000 +
        (account.annualRevenue ?? 0) * 0.001;

      return {
        account,
        accountDeals,
        arrAmount,
        contactCount,
        hasCustomerSignal,
        openExpansion,
        openPipeline,
        priority,
        syncAge,
      };
    });

    const hasCustomerSignals = accountRows.some((row) => row.hasCustomerSignal);
    const rowsToScore = accountRows
      .filter((row) => !hasCustomerSignals || row.hasCustomerSignal)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, model.accountsScored);

    let created = 0;
    let updated = 0;
    for (const row of rowsToScore) {
      const {
        account,
        accountDeals,
        arrAmount,
        contactCount,
        hasCustomerSignal,
        openExpansion,
        openPipeline,
        syncAge,
      } = row;

      const { points, revenueCap, contactTarget, sync } = model;
      const revenueBasis =
        arrAmount || openExpansion || openPipeline || Math.min(account.annualRevenue ?? 0, revenueCap);
      const revenueScore = Math.min(revenueBasis / revenueCap, 1) * points.revenue;
      const contactScore = Math.min(contactCount / contactTarget, 1) * points.contacts;
      const expansionScore = openExpansion > 0 ? points.expansion.open : openPipeline > 0 ? points.expansion.pipeline : points.expansion.neither;
      const ownerScore = account.ownerId ? points.owner.yes : points.owner.no;
      const syncScore = syncAge <= sync.freshDays ? points.sync.fresh : syncAge <= sync.recentDays ? points.sync.recent : points.sync.stale;
      const customerSignalAdjustment = hasCustomerSignal ? 0 : points.noCustomerSignal;
      const overallScore = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            revenueScore +
              contactScore +
              expansionScore +
              ownerScore +
              syncScore +
              customerSignalAdjustment,
          ),
        ),
      );
      const health = healthFromScore(overallScore, model.bands);
      const renewalDeal = accountDeals
        .filter((deal) => deal.dealType === "renewal")
        .sort((a, b) => a.closeDate.localeCompare(b.closeDate))[0];

      const scorePayload = {
        configId,
        overallScore,
        health,
        signalBreakdown: {
          wonRevenue: arrAmount,
          crmAnnualRevenue: account.annualRevenue ?? 0,
          contacts: contactCount,
          openExpansion,
          openPipeline,
          hasOwner: Boolean(account.ownerId),
          hasCustomerSignal,
          syncAgeDays: syncAge,
          components: {
            revenueScore: Math.round(revenueScore),
            contactScore: Math.round(contactScore),
            expansionScore,
            ownerScore,
            syncScore,
            customerSignalAdjustment,
          },
        },
        arrAmount,
        renewalDate: renewalDeal?.closeDate ?? daysFromNow(model.renewalDefaultDays),
        expansionPotential: expansionPotential({
          openExpansion,
          arrAmount,
          contactCount,
        }, model.expansion),
        lastCalculatedAt: now,
      };

      const existing = await ctx.db
        .query("customerHealthScores")
        .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
        .first();

      if (existing && existing.orgId === user.orgId) {
        await ctx.db.patch(existing._id, scorePayload);
        updated++;
      } else {
        await ctx.db.insert("customerHealthScores", {
          orgId: user.orgId,
          accountId: account._id,
          ...scorePayload,
          createdAt: now,
        });
        created++;
      }
    }

    return { configId, created, updated, scored: created + updated };
  },
});

export const updateConfig = mutation({
  args: {
    configId: v.id("customerHealthConfigs"),
    name: v.optional(v.string()),
    signals: v.optional(
      v.array(
        v.object({
          name: v.string(),
          source: v.string(),
          weight: v.number(),
          goodThreshold: v.number(),
          badThreshold: v.number(),
        }),
      ),
    ),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const { configId, ...updates } = args;
    const config = await ctx.db.get(configId);
    if (!config || config.orgId !== user.orgId)
      throw new Error("Config not found");

    const cleanUpdates: Record<string, any> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) cleanUpdates[key] = value;
    }
    await ctx.db.patch(configId, cleanUpdates);
  },
});

export const upsertScore = mutation({
  args: {
    accountId: v.id("crmAccounts"),
    configId: v.id("customerHealthConfigs"),
    overallScore: v.number(),
    health: v.union(
      v.literal("healthy"),
      v.literal("at_risk"),
      v.literal("churning"),
    ),
    signalBreakdown: v.optional(v.any()),
    arrAmount: v.optional(v.number()),
    renewalDate: v.optional(v.string()),
    expansionPotential: v.optional(
      v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "health scores over the CRM");
    const now = Date.now();

    // Check for existing score for this account
    const existing = await ctx.db
      .query("customerHealthScores")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .first();

    if (existing && existing.orgId === user.orgId) {
      const cleanUpdates: Record<string, any> = { lastCalculatedAt: now };
      const updates = {
        overallScore: args.overallScore,
        health: args.health,
        signalBreakdown: args.signalBreakdown,
        arrAmount: args.arrAmount,
        renewalDate: args.renewalDate,
        expansionPotential: args.expansionPotential,
      };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) cleanUpdates[key] = value;
      }
      cleanUpdates.configId = args.configId;
      await ctx.db.patch(existing._id, cleanUpdates);
      return existing._id;
    }

    return ctx.db.insert("customerHealthScores", {
      orgId: user.orgId,
      accountId: args.accountId,
      configId: args.configId,
      overallScore: args.overallScore,
      health: args.health,
      signalBreakdown: args.signalBreakdown,
      arrAmount: args.arrAmount,
      renewalDate: args.renewalDate,
      expansionPotential: args.expansionPotential,
      lastCalculatedAt: now,
      createdAt: now,
    });
  },
});
