import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import type { Doc } from "./_generated/dataModel";

function researchReadinessFromRows(enrichments: any[], accounts: any[]) {
  const stale = enrichments.filter((row) => !row.lastEnrichedAt || Date.now() - row.lastEnrichedAt > 30 * 86_400_000).length;
  const relevant = accounts.length > 0 || enrichments.length > 0;
  return {
    noun: "research",
    required: false,
    relevant,
    configured: enrichments.length > 0,
    lifecycle: enrichments.length > 0 ? "enriched" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { enrichmentCount: enrichments.length, staleEnrichments: stale, accountCount: accounts.length },
    nextActions: enrichments.length > 0 ? ["refresh stale research", "find account research"] : ["do research.enrich_accounts", "sync accounts"],
  };
}

function emptyResearchReadiness() {
  return {
    noun: "research",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { enrichmentCount: 0, staleEnrichments: 0, accountCount: 0 },
    nextActions: ["Sign in to inspect research readiness"],
  };
}

function employeeRange(count: number | undefined) {
  if (!count) return undefined;
  if (count < 50) return "1-49";
  if (count < 200) return "50-199";
  if (count < 1000) return "200-999";
  if (count < 5000) return "1,000-4,999";
  return "5,000+";
}

function revenueRange(cents: number | undefined) {
  if (!cents) return undefined;
  const revenue = cents / 100;
  if (revenue < 10_000_000) return "<$10M";
  if (revenue < 50_000_000) return "$10M-$50M";
  if (revenue < 250_000_000) return "$50M-$250M";
  if (revenue < 1_000_000_000) return "$250M-$1B";
  return "$1B+";
}

function fundingStage(account: Doc<"crmAccounts">) {
  const revenue = account.annualRevenue ?? 0;
  const employees = account.employeeCount ?? 0;
  if (revenue >= 100000000000 || employees >= 5000) return "public_or_late_stage";
  if (revenue >= 25000000000 || employees >= 1000) return "growth";
  if (revenue >= 5000000000 || employees >= 200) return "scale_up";
  return "early";
}

function headquarters(account: Doc<"crmAccounts">) {
  const address = account.address;
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return undefined;
  }
  const fields = address as Record<string, unknown>;
  return [fields.city, fields.state, fields.country]
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .join(", ") || undefined;
}

function defaultTechStack(account: Doc<"crmAccounts">) {
  const industry = account.industry?.toLowerCase() ?? "";
  const stack = ["CRM", "Marketing automation"];
  if (industry.includes("software") || industry.includes("technology")) {
    stack.push("Product analytics", "Data warehouse");
  } else if (industry.includes("financial")) {
    stack.push("Revenue intelligence", "Compliance workflow");
  } else {
    stack.push("Sales engagement", "Customer success");
  }
  return stack;
}

function defaultFirmographics(account: Doc<"crmAccounts">) {
  const firmographics: {
    headquarters?: string;
    employeeRange?: string;
    revenueRange?: string;
    fundingStage?: string;
  } = {
    fundingStage: fundingStage(account),
  };
  const hq = headquarters(account);
  const employees = employeeRange(account.employeeCount);
  const revenue = revenueRange(account.annualRevenue);
  if (hq) firmographics.headquarters = hq;
  if (employees) firmographics.employeeRange = employees;
  if (revenue) firmographics.revenueRange = revenue;
  return firmographics;
}

function defaultSignals(account: Doc<"crmAccounts">, now: number) {
  const signals = [
    {
      type: "news",
      title: "CRM account fit available",
      summary: `${account.name} has enough CRM firmographic data to seed account research.`,
      detectedAt: now,
    },
  ];

  if ((account.employeeCount ?? 0) >= 200) {
    signals.push({
      type: "hiring",
      title: "Scaling account",
      summary: "Employee count suggests a larger buying committee and multi-threading opportunity.",
      detectedAt: now,
    });
  }
  if ((account.annualRevenue ?? 0) >= 5000000000) {
    signals.push({
      type: "funding",
      title: "High revenue fit",
      summary: "Revenue range supports enterprise qualification and higher ACV assumptions.",
      detectedAt: now,
    });
  }
  if (account.ownerId) {
    signals.push({
      type: "partnership",
      title: "CRM owner mapped",
      summary: "The account already has an owner, so routing and ABM follow-up can inherit coverage.",
      detectedAt: now,
    });
  }

  return signals;
}

// ── Queries ───────────────────────────────────────────────────────

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyResearchReadiness();
    const [enrichments, accounts] = await Promise.all([
      ctx.db.query("accountEnrichments").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    return researchReadinessFromRows(enrichments, accounts);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyResearchReadiness(), enrichments: [] };
    const [enrichments, accounts] = await Promise.all([
      ctx.db.query("accountEnrichments").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const accountsById = new Map(accounts.map((account) => [account._id, account]));
    return {
      readiness: researchReadinessFromRows(enrichments, accounts),
      enrichments: enrichments.map((enrichment) => ({
        ...enrichment,
        accountName: accountsById.get(enrichment.accountId)?.name,
      })),
    };
  },
});

export const listEnrichments = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const enrichments = await ctx.db
      .query("accountEnrichments")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(100);

    const enriched = [];
    for (const enrichment of enrichments) {
      const account = await ctx.db.get(enrichment.accountId);
      enriched.push({
        ...enrichment,
        accountName: account?.name,
      });
    }
    return enriched;
  },
});

export const getForAccount = query({
  args: { accountId: v.id("crmAccounts") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const enrichment = await ctx.db
      .query("accountEnrichments")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!enrichment || enrichment.orgId !== user.orgId) return null;
    return enrichment;
  },
});

// ── Mutations ─────────────────────────────────────────────────────

export const addEnrichment = mutation({
  args: {
    accountId: v.id("crmAccounts"),
    source: v.union(
      v.literal("manual"),
      v.literal("ai"),
      v.literal("api"),
    ),
    firmographics: v.optional(
      v.object({
        founded: v.optional(v.string()),
        headquarters: v.optional(v.string()),
        employeeRange: v.optional(v.string()),
        revenueRange: v.optional(v.string()),
        fundingStage: v.optional(v.string()),
        totalFunding: v.optional(v.number()),
      }),
    ),
    techStack: v.optional(v.array(v.string())),
    signals: v.optional(
      v.array(
        v.object({
          type: v.string(),
          title: v.string(),
          summary: v.optional(v.string()),
          url: v.optional(v.string()),
          detectedAt: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "account research over the CRM");
    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== user.orgId) {
      throw new Error("Account not found");
    }
    const now = Date.now();
    return ctx.db.insert("accountEnrichments", {
      orgId: user.orgId,
      ...args,
      lastEnrichedAt: now,
      createdAt: now,
    });
  },
});

export const generateFromCrm = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "account research over the CRM");
    const now = Date.now();
    const [accounts, enrichments] = await Promise.all([
      ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("accountEnrichments")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
    ]);

    const enrichmentByAccount = new Map(
      enrichments.map((enrichment) => [enrichment.accountId, enrichment]),
    );
    const accountsToEnrich = accounts
      .sort((a, b) => {
        const aScore = (a.annualRevenue ?? 0) + (a.employeeCount ?? 0) * 100000;
        const bScore = (b.annualRevenue ?? 0) + (b.employeeCount ?? 0) * 100000;
        return bScore - aScore;
      })
      .slice(0, 100);

    let created = 0;
    let updated = 0;
    for (const account of accountsToEnrich) {
      const payload = {
        source: "api" as const,
        firmographics: defaultFirmographics(account),
        techStack: defaultTechStack(account),
        signals: defaultSignals(account, now),
        lastEnrichedAt: now,
      };
      const existing = enrichmentByAccount.get(account._id);

      if (existing && existing.orgId === user.orgId) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert("accountEnrichments", {
          orgId: user.orgId,
          accountId: account._id,
          ...payload,
          createdAt: now,
        });
        created++;
      }
    }

    return { created, updated, enriched: created + updated };
  },
});

export const addSignal = mutation({
  args: {
    enrichmentId: v.id("accountEnrichments"),
    type: v.string(),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "account research over the CRM");
    const enrichment = await ctx.db.get(args.enrichmentId);
    if (!enrichment || enrichment.orgId !== user.orgId)
      throw new Error("Enrichment not found");

    const now = Date.now();
    const newSignal = {
      type: args.type,
      title: args.title,
      summary: args.summary,
      url: args.url,
      detectedAt: now,
    };

    const existingSignals = enrichment.signals ?? [];
    await ctx.db.patch(args.enrichmentId, {
      signals: [...existingSignals, newSignal],
      lastEnrichedAt: now,
    });
  },
});
