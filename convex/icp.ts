import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import type { Doc, Id } from "./_generated/dataModel";

function icpReadinessFromRows(profiles: any[], scores: any[], accounts: any[]) {
  const activeProfiles = profiles.filter((profile) => profile.isActive);
  const relevant = profiles.length > 0 || accounts.length > 0 || scores.length > 0;
  return {
    noun: "icp",
    required: false,
    relevant,
    configured: profiles.length > 0,
    lifecycle: activeProfiles.length > 0 ? "active" : profiles.length > 0 ? "draft" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { profileCount: profiles.length, activeProfiles: activeProfiles.length, scoreCount: scores.length, accountCount: accounts.length },
    nextActions: profiles.length > 0 ? ["review top accounts", "set icp.profile"] : ["do icp.bootstrap", "connect account data"],
  };
}

function emptyIcpReadiness() {
  return {
    noun: "icp",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { profileCount: 0, activeProfiles: 0, scoreCount: 0, accountCount: 0 },
    nextActions: ["Sign in to inspect ICP readiness"],
  };
}

type IcpAttribute = Doc<"icpProfiles">["attributes"][number];
type AccountMetrics = {
  contactCount: number;
  openPipeline: number;
  wonRevenue: number;
  openDeals: number;
};

function normalizeText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function numericValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractRegion(account: Doc<"crmAccounts">) {
  const address = account.address;
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return "";
  }
  const fields = address as Record<string, unknown>;
  return [fields.state, fields.country, fields.region]
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .join(" ");
}

function fieldValue(args: {
  field: string;
  account: Doc<"crmAccounts">;
  metrics: AccountMetrics;
  enrichment: Doc<"accountEnrichments"> | undefined;
}) {
  const normalizedField = args.field.toLowerCase();
  if (normalizedField === "industry") return args.account.industry ?? "";
  if (normalizedField === "domain") return args.account.domain ?? "";
  if (
    normalizedField === "employee_count" ||
    normalizedField === "employeecount"
  ) {
    return args.account.employeeCount ?? 0;
  }
  if (
    normalizedField === "annual_revenue" ||
    normalizedField === "annualrevenue" ||
    normalizedField === "revenue"
  ) {
    return args.account.annualRevenue ?? 0;
  }
  if (normalizedField === "region") return extractRegion(args.account);
  if (normalizedField === "tech_stack" || normalizedField === "techstack") {
    return args.enrichment?.techStack ?? [];
  }
  if (normalizedField === "contact_count" || normalizedField === "contacts") {
    return args.metrics.contactCount;
  }
  if (normalizedField === "open_pipeline") return args.metrics.openPipeline;
  if (normalizedField === "won_revenue") return args.metrics.wonRevenue;
  if (normalizedField === "open_deals") return args.metrics.openDeals;
  if (normalizedField === "owner" || normalizedField === "owner_mapped") {
    return Boolean(args.account.ownerId);
  }
  if (normalizedField === "signals" || normalizedField === "signal_count") {
    return args.enrichment?.signals?.length ?? 0;
  }
  return "";
}

function rangeValues(value: unknown) {
  if (Array.isArray(value)) {
    const [minValue, maxValue] = value;
    return { min: numericValue(minValue), max: numericValue(maxValue) };
  }
  if (typeof value === "string") {
    const [minValue, maxValue] = value.split(/[-,]/);
    return { min: numericValue(minValue), max: numericValue(maxValue) };
  }
  return { min: null, max: null };
}

function attributeMatches(args: {
  attribute: IcpAttribute;
  account: Doc<"crmAccounts">;
  metrics: AccountMetrics;
  enrichment: Doc<"accountEnrichments"> | undefined;
}) {
  const actual = fieldValue({
    field: args.attribute.field,
    account: args.account,
    metrics: args.metrics,
    enrichment: args.enrichment,
  });
  const expected = args.attribute.value;
  const operator = args.attribute.operator.toLowerCase();
  const actualNumber = numericValue(actual);
  const expectedNumber = numericValue(expected);

  if (operator === "contains") {
    const expectedText = normalizeText(expected);
    if (Array.isArray(actual)) {
      return actual.some((item) => normalizeText(item).includes(expectedText));
    }
    return normalizeText(actual).includes(expectedText);
  }

  if (operator === "equals" || operator === "eq") {
    if (typeof actual === "boolean") {
      return actual === (expected === true || normalizeText(expected) === "true");
    }
    return normalizeText(actual) === normalizeText(expected);
  }

  if (
    operator === "greater_than" ||
    operator === "gt" ||
    operator === "gte"
  ) {
    if (actualNumber === null || expectedNumber === null) return false;
    return operator === "gt"
      ? actualNumber > expectedNumber
      : actualNumber >= expectedNumber;
  }

  if (operator === "less_than" || operator === "lt" || operator === "lte") {
    if (actualNumber === null || expectedNumber === null) return false;
    return operator === "lt"
      ? actualNumber < expectedNumber
      : actualNumber <= expectedNumber;
  }

  if (operator === "between") {
    if (actualNumber === null) return false;
    const { min, max } = rangeValues(expected);
    if (min === null || max === null) return false;
    return actualNumber >= min && actualNumber <= max;
  }

  if (operator === "exists") {
    if (Array.isArray(actual)) return actual.length > 0;
    return Boolean(actual);
  }

  return false;
}

function percentile(values: number[], rank: number) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * rank));
  return sorted[index];
}

function topIndustry(accounts: Doc<"crmAccounts">[]) {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    const industry = account.industry?.trim();
    if (!industry) continue;
    counts.set(industry, (counts.get(industry) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function defaultAttributes(args: {
  accounts: Doc<"crmAccounts">[];
  hasContacts: boolean;
  hasDeals: boolean;
  hasEnrichments: boolean;
}): IcpAttribute[] {
  const attributes: IcpAttribute[] = [];
  const industry = topIndustry(args.accounts);
  const employeeFloor =
    percentile(
      args.accounts.map((account) => account.employeeCount ?? 0),
      0.4,
    ) ?? 50;
  const revenueFloor =
    percentile(
      args.accounts.map((account) => account.annualRevenue ?? 0),
      0.4,
    ) ?? 500000000;

  if (industry) {
    attributes.push({
      field: "industry",
      operator: "contains",
      value: industry,
      weight: 3,
    });
  }
  attributes.push(
    {
      field: "employee_count",
      operator: "greater_than",
      value: Math.max(25, Math.round(employeeFloor)),
      weight: 3,
    },
    {
      field: "annual_revenue",
      operator: "greater_than",
      value: Math.max(100000000, Math.round(revenueFloor)),
      weight: 2,
    },
  );

  if (args.hasContacts) {
    attributes.push({
      field: "contact_count",
      operator: "greater_than",
      value: 1,
      weight: 2,
    });
  }
  if (args.hasDeals) {
    attributes.push({
      field: "open_pipeline",
      operator: "greater_than",
      value: 0,
      weight: 2,
    });
  }
  if (args.hasEnrichments) {
    attributes.push({
      field: "signals",
      operator: "greater_than",
      value: 0,
      weight: 1,
    });
  }
  attributes.push({
    field: "owner",
    operator: "equals",
    value: true,
    weight: 1,
  });

  return attributes;
}

function scoreAccount(args: {
  account: Doc<"crmAccounts">;
  profile: Doc<"icpProfiles">;
  metrics: AccountMetrics;
  enrichment: Doc<"accountEnrichments"> | undefined;
}) {
  const matchedAttributes = [];
  let matchedWeight = 0;
  let possibleWeight = 0;

  for (const attribute of args.profile.attributes) {
    const weight = Math.max(attribute.weight, 0);
    possibleWeight += weight;
    const actual = fieldValue({
      field: attribute.field,
      account: args.account,
      metrics: args.metrics,
      enrichment: args.enrichment,
    });
    const matched = attributeMatches({
      attribute,
      account: args.account,
      metrics: args.metrics,
      enrichment: args.enrichment,
    });
    if (matched) matchedWeight += weight;
    matchedAttributes.push({
      field: attribute.field,
      operator: attribute.operator,
      expected: attribute.value,
      actual,
      weight,
      matched,
    });
  }

  const score =
    possibleWeight > 0
      ? Math.round((matchedWeight / possibleWeight) * 100)
      : Math.min(
          100,
          30 +
            Math.min(args.metrics.contactCount, 4) * 10 +
            (args.account.ownerId ? 10 : 0) +
            (args.metrics.openPipeline > 0 ? 15 : 0),
        );
  const recommendation =
    score >= 80
      ? "Prioritize for outbound, ABM, and executive coverage."
      : score >= 55
        ? "Qualify gaps in buying committee, timing, or fit before heavy investment."
        : "Keep nurtured unless new pipeline, contacts, or fit signals appear.";

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      matchedAttributes,
      metrics: {
        contactCount: args.metrics.contactCount,
        openPipeline: args.metrics.openPipeline,
        wonRevenue: args.metrics.wonRevenue,
        openDeals: args.metrics.openDeals,
        hasOwner: Boolean(args.account.ownerId),
        enrichmentSignals: args.enrichment?.signals?.length ?? 0,
      },
      recommendation,
    },
  };
}

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyIcpReadiness();
    const [profiles, scores, accounts] = await Promise.all([
      ctx.db.query("icpProfiles").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("icpScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    return icpReadinessFromRows(profiles, scores, accounts);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyIcpReadiness(), profiles: [], scores: [] };
    const [profiles, scores, accounts] = await Promise.all([
      ctx.db.query("icpProfiles").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("icpScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const accountIds = scores.map((score) => score.accountId);
    const accountsById = new Map(accounts.map((account) => [account._id, account]));
    return {
      readiness: icpReadinessFromRows(profiles, scores, accounts),
      profiles,
      scores,
      topAccounts: scores
        .filter((score) => accountsById.has(score.accountId))
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
        .map((score) => ({ ...score, account: accountsById.get(score.accountId) })),
      accountIds,
    };
  },
});

export const listProfiles = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("icpProfiles")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(50);
  },
});

export const getProfile = query({
  args: { profileId: v.id("icpProfiles") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.orgId !== user.orgId) return null;
    return profile;
  },
});

export const createProfile = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    attributes: v.array(
      v.object({
        field: v.string(),
        operator: v.string(),
        value: v.any(),
        weight: v.number(),
      }),
    ),
    isDefault: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const now = Date.now();

    // If setting as default, unset previous default
    if (args.isDefault) {
      const existing = await ctx.db
        .query("icpProfiles")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(50);
      for (const profile of existing) {
        if (profile.isDefault) {
          await ctx.db.patch(profile._id, { isDefault: false, updatedAt: now });
        }
      }
    }

    return ctx.db.insert("icpProfiles", {
      orgId: user.orgId,
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateProfile = mutation({
  args: {
    profileId: v.id("icpProfiles"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    attributes: v.optional(
      v.array(
        v.object({
          field: v.string(),
          operator: v.string(),
          value: v.any(),
          weight: v.number(),
        }),
      ),
    ),
    isDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { profileId, ...updates } = args;
    const profile = await ctx.db.get(profileId);
    if (!profile || profile.orgId !== user.orgId)
      throw new ConvexError("ICP profile not found");

    const now = Date.now();
    if (updates.isDefault) {
      const existing = await ctx.db
        .query("icpProfiles")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(50);
      for (const p of existing) {
        if (p.isDefault && p._id !== profileId) {
          await ctx.db.patch(p._id, { isDefault: false, updatedAt: now });
        }
      }
    }

    const cleanUpdates: Partial<Doc<"icpProfiles">> = { updatedAt: now };
    if (updates.name !== undefined) cleanUpdates.name = updates.name;
    if (updates.description !== undefined) {
      cleanUpdates.description = updates.description;
    }
    if (updates.attributes !== undefined) {
      cleanUpdates.attributes = updates.attributes;
    }
    if (updates.isDefault !== undefined) {
      cleanUpdates.isDefault = updates.isDefault;
    }
    await ctx.db.patch(profileId, cleanUpdates);
  },
});

export const listScores = query({
  args: { profileId: v.optional(v.id("icpProfiles")) },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const scores = await ctx.db
      .query("icpScores")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(500);

    if (args.profileId) {
      return scores.filter((s) => s.profileId === args.profileId);
    }
    return scores;
  },
});

export const getTopAccounts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const scores = await ctx.db
      .query("icpScores")
      .withIndex("by_orgId_score", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(limit);

    // Enrich with account data
    const enriched = [];
    for (const score of scores) {
      const account = await ctx.db.get(score.accountId);
      enriched.push({ ...score, account });
    }
    return enriched;
  },
});

// ── Batched CRM score generation ──────────────────────────────────
//
// `generateFromCrm` used to be a single mutation that read ≈3050 documents up
// front (profiles + 500 accounts + 1000 contacts + 1000 deals + 500
// enrichments) and then a take(20) on icpScores.by_accountId per ranked
// account — over Convex's 4096-read mutation cap with ≥4 profiles' worth of
// score rows, and it silently considered only the first 500 of 5000 accounts
// (then scored just the top 250 by priority).
//
// It is now a public ACTION of the same name (same result shape) that
// orchestrates bounded internal calls, mirroring the sync-action pattern:
//   1. requireStrategyEditor    — identity → user lookup (auth in a query)
//   2. ensureDefaultProfileInternal — small mutation resolving/creating the
//      default profile (bootstrap attributes derived from a bounded sample)
//   3. contactAccountPageInternal / dealPageInternal — page ALL contacts and
//      deals (slim rows) to build per-account metrics
//   4. accountPageInternal — pages ALL accounts (every account gets scored;
//      the old top-250 priority cutoff is gone along with the truncation)
//   5. scoreAccountsBatchInternal per page — scores + upserts one batch using
//      the composite icpScores.by_accountId_profileId index (1 read per
//      account×profile instead of take(20))
//
// Worst-case math per batch (pageSize = floor(1200 / profilesScored); each
// run scores accounts against exactly ONE profile, so profilesScored = 1 and
// pageSize = 400 — if this ever scores P profiles per account, the divisor
// shrinks the page automatically):
//   reads  ≤ 1 (profile) + 400 (account gets)
//            + 400 (enrichment lookups via accountEnrichments.by_accountId)
//            + 400×1 (existing-score composite lookups) = 1201  ≤ 1600
//   writes ≤ 400×1 (one patch/insert per account×profile)       ≤ 1600
// Each paging query transaction reads ~one page (≤400 rows).

/** Identity → user lookup for the action. Enforces the manager gate. */
export const requireStrategyEditor = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!can(user, "strategy.edit")) throw new ConvexError(refusal("strategy.edit"));
    return { userId: user._id, orgId: user.orgId };
  },
});

/**
 * Resolve the default ICP profile, creating one if none exists. Bootstrap
 * attributes are derived from a bounded CRM sample (≤1600 reads) — they are
 * percentile/majority heuristics, so a sample is representative; scoring
 * itself still covers every account.
 */
export const ensureDefaultProfileInternal = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<Doc<"icpProfiles">> => {
    const profiles = await ctx.db
      .query("icpProfiles")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .take(50);
    const existing =
      profiles.find((candidate) => candidate.isDefault) ?? profiles[0];
    if (existing) return existing;

    const [accounts, contacts, deals, enrichments] = await Promise.all([
      ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
        .take(500),
      ctx.db
        .query("crmContacts")
        .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
        .take(500),
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", args.orgId).eq("archivedAt", undefined))
        .take(500),
      ctx.db
        .query("accountEnrichments")
        .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
        .take(100),
    ]);

    const now = Date.now();
    const profileId = await ctx.db.insert("icpProfiles", {
      orgId: args.orgId,
      name: "CRM-Derived ICP",
      description:
        "Default fit model generated from inherited CRM firmographics, buying committee coverage, pipeline, and enrichment signals.",
      attributes: defaultAttributes({
        accounts,
        hasContacts: contacts.some((contact) => Boolean(contact.accountId)),
        hasDeals: deals.some((deal) => Boolean(deal.accountId) && !deal.isClosed),
        hasEnrichments: enrichments.length > 0,
      }),
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(profileId);
    if (!created) throw new Error("ICP profile could not be loaded");
    return created;
  },
});

/** One slim page of accounts: just the ids needed for batching. */
export const accountPageInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("crmAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .paginate(args.paginationOpts);
    return {
      page: result.page.map((account) => ({ accountId: account._id })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** One slim page of contacts: only the accountId, for committee counts. */
export const contactAccountPageInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("crmContacts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .paginate(args.paginationOpts);
    return {
      page: result.page.map((contact) => ({
        accountId: contact.accountId ?? null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** One slim page of deals: only the fields needed for account metrics. */
export const dealPageInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("deals")
      .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", args.orgId).eq("archivedAt", undefined))
      .paginate(args.paginationOpts);
    return {
      page: result.page.map((deal) => ({
        accountId: deal.accountId ?? null,
        amount: deal.amount ?? 0,
        arr: deal.arr ?? null,
        isWon: deal.isWon,
        isClosed: deal.isClosed,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Score + upsert one bounded batch of accounts. Reads ≤ 1 + 3×batch size,
 * writes ≤ batch size (see math above) — callers must keep batches ≤ ~400.
 */
export const scoreAccountsBatchInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    profileId: v.id("icpProfiles"),
    accounts: v.array(
      v.object({
        accountId: v.id("crmAccounts"),
        contactCount: v.number(),
        openPipeline: v.number(),
        wonRevenue: v.number(),
        openDeals: v.number(),
      }),
    ),
    calculatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.orgId !== args.orgId) {
      throw new Error("ICP profile not found");
    }

    let created = 0;
    let updated = 0;
    for (const entry of args.accounts) {
      const account = await ctx.db.get(entry.accountId);
      if (!account || account.orgId !== args.orgId) continue;

      const enrichment = await ctx.db
        .query("accountEnrichments")
        .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
        .first();

      const result = scoreAccount({
        account,
        profile,
        metrics: {
          contactCount: entry.contactCount,
          openPipeline: entry.openPipeline,
          wonRevenue: entry.wonRevenue,
          openDeals: entry.openDeals,
        },
        enrichment: enrichment ?? undefined,
      });

      // Composite index: exactly one read per account×profile.
      const existing = await ctx.db
        .query("icpScores")
        .withIndex("by_accountId_profileId", (q) =>
          q.eq("accountId", account._id).eq("profileId", args.profileId),
        )
        .first();

      const payload = {
        score: result.score,
        breakdown: result.breakdown,
        calculatedAt: args.calculatedAt,
      };

      if (existing) {
        await ctx.db.patch(existing._id, payload);
        updated++;
      } else {
        await ctx.db.insert("icpScores", {
          orgId: args.orgId,
          accountId: account._id,
          profileId: args.profileId,
          ...payload,
        });
        created++;
      }
    }

    return { created, updated };
  },
});

export const generateFromCrm = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    profileId: Id<"icpProfiles">;
    created: number;
    updated: number;
    scored: number;
    totalScored: number;
  }> => {
    const auth: { userId: Id<"users">; orgId: Id<"organizations"> } =
      await ctx.runQuery(internal.icp.requireStrategyEditor, {});
    const profile: Doc<"icpProfiles"> = await ctx.runMutation(
      internal.icp.ensureDefaultProfileInternal,
      { orgId: auth.orgId },
    );
    const now = Date.now();

    // Each run scores against exactly one profile; shrink pages if that ever
    // changes so a batch stays ≤ ~1600 reads/writes.
    const profilesScored = 1;
    const pageSize = Math.max(
      50,
      Math.floor(1200 / Math.max(profilesScored, 1)),
    );

    // Phase A: page through ALL contacts and deals (slim) to build global
    // per-account metrics — no more first-1000 truncation.
    const contactCountByAccount = new Map<Id<"crmAccounts">, number>();
    {
      let cursor: string | null = null;
      for (;;) {
        const result: {
          page: { accountId: Id<"crmAccounts"> | null }[];
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.icp.contactAccountPageInternal, {
          orgId: auth.orgId,
          paginationOpts: { numItems: pageSize, cursor },
        });
        for (const row of result.page) {
          if (!row.accountId) continue;
          contactCountByAccount.set(
            row.accountId,
            (contactCountByAccount.get(row.accountId) ?? 0) + 1,
          );
        }
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    const dealMetricsByAccount = new Map<
      Id<"crmAccounts">,
      Omit<AccountMetrics, "contactCount">
    >();
    {
      let cursor: string | null = null;
      for (;;) {
        const result: {
          page: {
            accountId: Id<"crmAccounts"> | null;
            amount: number;
            arr: number | null;
            isWon: boolean;
            isClosed: boolean;
          }[];
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.icp.dealPageInternal, {
          orgId: auth.orgId,
          paginationOpts: { numItems: pageSize, cursor },
        });
        for (const deal of result.page) {
          if (!deal.accountId) continue;
          const current = dealMetricsByAccount.get(deal.accountId) ?? {
            openPipeline: 0,
            wonRevenue: 0,
            openDeals: 0,
          };
          if (deal.isWon) {
            current.wonRevenue += deal.arr ?? deal.amount ?? 0;
          }
          if (!deal.isClosed) {
            current.openPipeline += deal.amount ?? 0;
            current.openDeals += 1;
          }
          dealMetricsByAccount.set(deal.accountId, current);
        }
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    // Phase B: page through ALL accounts and score each page in its own
    // bounded mutation.
    let created = 0;
    let updated = 0;
    {
      let cursor: string | null = null;
      for (;;) {
        const result: {
          page: { accountId: Id<"crmAccounts"> }[];
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.icp.accountPageInternal, {
          orgId: auth.orgId,
          paginationOpts: { numItems: pageSize, cursor },
        });
        if (result.page.length > 0) {
          const batch: { created: number; updated: number } =
            await ctx.runMutation(internal.icp.scoreAccountsBatchInternal, {
              orgId: auth.orgId,
              profileId: profile._id,
              accounts: result.page.map(({ accountId }) => {
                const dealMetrics = dealMetricsByAccount.get(accountId) ?? {
                  openPipeline: 0,
                  wonRevenue: 0,
                  openDeals: 0,
                };
                return {
                  accountId,
                  contactCount: contactCountByAccount.get(accountId) ?? 0,
                  ...dealMetrics,
                };
              }),
              calculatedAt: now,
            });
          created += batch.created;
          updated += batch.updated;
        }
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
    }

    return {
      profileId: profile._id,
      created,
      updated,
      scored: created + updated,
      totalScored: created + updated,
    };
  },
});
