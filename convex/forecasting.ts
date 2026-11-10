import { query, type QueryCtx } from "./_generated/server";
import { currentPeriod } from "./targets";
import { lastDay, periodOf } from "../modules/kernel/pacing";
import { v } from "convex/values";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import type { Doc, Id } from "./_generated/dataModel";
import { modelSettings } from "./lib/recipes";
import { defaultModel, type ForecastModel } from "../recipes/index.ts";

type ForecastCategory = "closed_won" | "commit" | "best_case" | "pipeline" | "omit";

function emptyCategories() {
  return {
    closed_won: { count: 0, amount: 0, weighted: 0 },
    commit: { count: 0, amount: 0, weighted: 0 },
    best_case: { count: 0, amount: 0, weighted: 0 },
    pipeline: { count: 0, amount: 0, weighted: 0 },
    omit: { count: 0, amount: 0, weighted: 0 },
  };
}

function quarterLabel(date: string) {
  const [year, month] = date.split("-").map(Number);
  return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
}

function categoryForDeal(deal: Doc<"deals">): ForecastCategory {
  if (deal.isWon) return "closed_won";
  if (deal.isClosed) return "omit";
  const category = deal.forecastCategory ?? "pipeline";
  if (category === "closed_won") return "closed_won";
  if (category === "closed_lost" || category === "omit") return "omit";
  return category;
}

function weightedAmount(deal: Doc<"deals">, category: ForecastCategory, model: ForecastModel) {
  if (category === "closed_won") return deal.amount ?? 0;
  if (category === "omit") return 0;
  return Math.round((deal.amount ?? 0) * (deal.probability ?? model.defaultProbability));
}

/** A forecast's dates, YYYY-MM-DD; without them, the workspace's current fiscal quarter. */
const period = { periodStart: v.optional(v.string()), periodEnd: v.optional(v.string()) };

async function periodOr(ctx: QueryCtx, user: Doc<"users"> | null, given: { periodStart?: string; periodEnd?: string }) {
  if (given.periodStart && given.periodEnd) return { periodStart: given.periodStart, periodEnd: given.periodEnd };
  const quarter = user ? await currentPeriod(ctx, user.orgId, "quarter") : periodOf(new Date().toISOString().slice(0, 10), "quarter");
  return { periodStart: given.periodStart ?? quarter.start, periodEnd: given.periodEnd ?? lastDay(quarter) };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

function coverage(value: number, target: number) {
  return target > 0 ? value / target : 0;
}

// Compute forecast from pipeline deals. `model` is the workspace's forecast.model; the pipeline route weighs its category
// rows by it.
export const getCurrentForecast = query({
  args: period,
  handler: async (ctx, given) => {
    const user = await unrestrictedUser(ctx);
    const args = await periodOr(ctx, user, given);
    if (!user) return {
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      totalDeals: 0,
      totalPipeline: 0,
      targetAmount: 0,
      weightedCoverage: 0,
      commitCoverage: 0,
      gapToTarget: 0,
      status: "no_target",
      recommendations: [],
      weightedForecast: 0,
      categories: emptyCategories(),
      model: defaultModel("forecast.model"),
    };
    const model = await modelSettings(ctx, user.orgId, "forecast.model");
    const [deals, quotaPlans, quotaTargets] = await Promise.all([
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(1000),
      ctx.db
        .query("quotaPlans")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(50),
      ctx.db
        .query("quotaPlanTargets")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
    ]);

    const inPeriod = deals.filter(
      (d) => d.closeDate >= args.periodStart && d.closeDate <= args.periodEnd,
    );

    const activePlanIds = new Set(
      quotaPlans.filter((plan) => plan.status === "active").map((plan) => plan._id),
    );
    const periodLabel = quarterLabel(args.periodStart);
    const matchingTargets = quotaTargets.filter(
      (target) =>
        activePlanIds.has(target.quotaPlanId) && target.period === periodLabel,
    );
    const activeTargets =
      matchingTargets.length > 0
        ? matchingTargets
        : quotaTargets.filter((target) => activePlanIds.has(target.quotaPlanId));
    const targetAmount = activeTargets.reduce(
      (sum, target) => sum + target.targetAmount,
      0,
    );
    const categories = emptyCategories();

    for (const deal of inPeriod) {
      const cat = categoryForDeal(deal);
      categories[cat].count++;
      categories[cat].amount += deal.amount ?? 0;
      categories[cat].weighted += weightedAmount(deal, cat, model);
    }

    const totalPipeline = inPeriod
      .filter((d) => !d.isClosed)
      .reduce((sum, d) => sum + (d.amount ?? 0), 0);

    const weightedForecast = Object.values(categories).reduce(
      (sum, cat) => sum + cat.weighted,
      0,
    );
    const commitAmount = categories.closed_won.amount + categories.commit.amount;
    const weightedCoverage = coverage(weightedForecast, targetAmount);
    const commitCoverage = coverage(commitAmount, targetAmount);
    const gapToTarget = Math.max(0, targetAmount - weightedForecast);
    const recommendations = [];
    if (targetAmount === 0) {
      recommendations.push("Set an active quota plan target to compare forecast coverage against plan.");
    } else if (commitCoverage < model.coverage.commit) {
      recommendations.push(`Commit coverage is below ${percent(model.coverage.commit)} of target; inspect best-case deals and next-step hygiene.`);
    }
    if (categories.pipeline.amount > categories.commit.amount * model.coverage.pipelineOverCommit && targetAmount > 0) {
      recommendations.push("Pipeline is much larger than commit; run a manager review to promote or omit weak opportunities.");
    }
    if (gapToTarget > 0 && weightedCoverage < model.coverage.weighted) {
      recommendations.push("Weighted forecast is short of target; add pipeline generation or pull-forward actions.");
    }

    return {
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      totalDeals: inPeriod.length,
      totalPipeline,
      targetAmount,
      weightedCoverage,
      commitCoverage,
      gapToTarget,
      status:
        targetAmount === 0
          ? "no_target"
          : weightedCoverage >= model.coverage.onTrack
            ? "on_track"
            : weightedCoverage >= model.coverage.watch
              ? "watch"
              : "risk",
      recommendations,
      weightedForecast,
      categories,
      model,
    };
  },
});

// Forecast by rep
export const getForecastByRep = query({
  args: period,
  handler: async (ctx, given) => {
    const user = await unrestrictedUser(ctx);
    const args = await periodOr(ctx, user, given);
    if (!user) return [];
    const model = await modelSettings(ctx, user.orgId, "forecast.model");
    const [deals, quotaPlans, quotaTargets] = await Promise.all([
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(1000),
      ctx.db
        .query("quotaPlans")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(50),
      ctx.db
        .query("quotaPlanTargets")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
    ]);

    const inPeriod = deals.filter(
      (d) => d.closeDate >= args.periodStart && d.closeDate <= args.periodEnd,
    );

    const repMap = new Map<
      Id<"users">,
      {
        userId: Id<"users">;
        commit: number;
        bestCase: number;
        pipeline: number;
        closed: number;
        weighted: number;
      }
    >();

    for (const deal of inPeriod) {
      const repId = deal.primaryRepId;
      // Unassigned deals have no rep bucket; org-level rollups still count them.
      if (!repId) continue;
      if (!repMap.has(repId)) {
        repMap.set(repId, {
          userId: repId,
          commit: 0,
          bestCase: 0,
          pipeline: 0,
          closed: 0,
          weighted: 0,
        });
      }
      const rep = repMap.get(repId)!;
      const category = categoryForDeal(deal);
      rep.weighted += weightedAmount(deal, category, model);
      if (category === "closed_won") rep.closed += deal.amount ?? 0;
      else if (category === "commit") rep.commit += deal.amount ?? 0;
      else if (category === "best_case") rep.bestCase += deal.amount ?? 0;
      else if (category === "pipeline") rep.pipeline += deal.amount ?? 0;
    }

    const activePlanIds = new Set(
      quotaPlans.filter((plan) => plan.status === "active").map((plan) => plan._id),
    );
    const periodLabel = quarterLabel(args.periodStart);
    const targetByRep = new Map<Id<"users">, number>();
    for (const target of quotaTargets) {
      if (
        !target.userId ||
        !activePlanIds.has(target.quotaPlanId) ||
        target.period !== periodLabel
      ) {
        continue;
      }
      targetByRep.set(
        target.userId,
        (targetByRep.get(target.userId) ?? 0) + target.targetAmount,
      );
    }

    const results = [];
    for (const [repId, data] of Array.from(repMap.entries())) {
      const repUser: Doc<"users"> | null = await ctx.db.get(repId);
      const targetAmount = targetByRep.get(repId) ?? 0;
      results.push({
        ...data,
        repName: repUser?.name ?? "Unknown",
        total: data.closed + data.commit + data.bestCase + data.pipeline,
        targetAmount,
        weightedCoverage: coverage(data.weighted, targetAmount),
      });
    }

    return results.sort((a, b) => b.total - a.total);
  },
});
