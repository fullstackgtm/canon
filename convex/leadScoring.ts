import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import type { Doc, Id } from "./_generated/dataModel";
import { modelSettings } from "./lib/recipes";

function routingReadinessFromRows(models: any[], rules: any[], scores: any[], contacts: any[]) {
  const relevant = models.length > 0 || rules.length > 0 || scores.length > 0 || contacts.length > 0;
  return {
    noun: "routing",
    required: false,
    relevant,
    configured: models.length > 0 || rules.length > 0,
    lifecycle: models.length > 0 || rules.length > 0 ? "active_or_draft" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { modelCount: models.length, ruleCount: rules.length, scoreCount: scores.length, contactCount: contacts.length },
    nextActions: models.length > 0 || rules.length > 0 ? ["review scores", "set routing.rule"] : ["do routing.bootstrap", "set routing.model"],
  };
}

function emptyRoutingReadiness() {
  return {
    noun: "routing",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { modelCount: 0, ruleCount: 0, scoreCount: 0, contactCount: 0 },
    nextActions: ["Sign in to inspect routing readiness"],
  };
}

type ScoringRule = Doc<"leadScoringModels">["rules"][number];
type LeadGrade = "hot" | "warm" | "cold";

function gradeForScore(
  score: number,
  thresholds: Doc<"leadScoringModels">["thresholds"],
): LeadGrade {
  if (score >= thresholds.hot) return "hot";
  if (score >= thresholds.warm) return "warm";
  return "cold";
}

function comparableFieldValue(args: {
  field: string;
  contact: Doc<"crmContacts">;
  account: Doc<"crmAccounts"> | undefined;
  contactCount: number;
}) {
  const normalizedField = args.field.toLowerCase();
  if (normalizedField === "title") return args.contact.title ?? "";
  if (normalizedField === "industry") return args.account?.industry ?? "";
  if (normalizedField === "revenue" || normalizedField === "annualrevenue") {
    return args.account?.annualRevenue ?? 0;
  }
  if (
    normalizedField === "employee_count" ||
    normalizedField === "employeecount"
  ) {
    return args.account?.employeeCount ?? 0;
  }
  if (normalizedField === "engagement") return args.contactCount;
  return "";
}

function numericValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ruleMatches(args: {
  rule: ScoringRule;
  contact: Doc<"crmContacts">;
  account: Doc<"crmAccounts"> | undefined;
  contactCount: number;
}) {
  const actual = comparableFieldValue({
    field: args.rule.field,
    contact: args.contact,
    account: args.account,
    contactCount: args.contactCount,
  });
  const expected = args.rule.value;
  const operator = args.rule.operator.toLowerCase();
  const actualNumber = numericValue(actual);
  const expectedNumber = numericValue(expected);

  if (operator === "contains") {
    return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  }
  if (operator === "equals" || operator === "eq") {
    return String(actual).toLowerCase() === String(expected).toLowerCase();
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
  return false;
}

// ── Queries ───────────────────────────────────────────────────────

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyRoutingReadiness();
    const [models, rules, scores, contacts] = await Promise.all([
      ctx.db.query("leadScoringModels").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("leadScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmContacts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    return routingReadinessFromRows(models, rules, scores, contacts);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyRoutingReadiness(), models: [], rules: [], scores: [], template: null };
    const [models, rules, scores, contacts] = await Promise.all([
      ctx.db.query("leadScoringModels").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("leadScores").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("crmContacts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const accounts = await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000);
    const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    const contactsById = new Map(contacts.map((contact) => [contact._id, contact]));
    const accountsById = new Map(accounts.map((account) => [account._id, account]));
    const usersById = new Map(users.map((member) => [member._id, member]));
    const modelsById = new Map(models.map((model) => [model._id, model]));
    const { thresholds } = await modelSettings(ctx, user.orgId, "scoring.lead");
    return {
      readiness: routingReadinessFromRows(models, rules, scores, contacts),
      models,
      // What the new model form starts from: the workspace's scoring.lead grades.
      template: { thresholds },
      rules,
      scores: scores.map((score) => {
        const contact = contactsById.get(score.contactId);
        const account = contact?.accountId ? accountsById.get(contact.accountId) : null;
        const ownerId = contact?.ownerId ?? account?.ownerId;
        const owner = ownerId ? usersById.get(ownerId) : null;
        const model = modelsById.get(score.modelId);
        return {
          ...score,
          contactName: contact
            ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || contact.email || "Unknown contact"
            : "Unknown contact",
          contactEmail: contact?.email,
          contactTitle: contact?.title,
          accountName: account?.name,
          accountDomain: account?.domain,
          accountIndustry: account?.industry,
          accountEmployeeCount: account?.employeeCount,
          accountAnnualRevenue: account?.annualRevenue,
          ownerName: owner?.name,
          modelName: model?.name,
        };
      }),
    };
  },
});

export const listModels = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("leadScoringModels")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(50);
  },
});

export const getModel = query({
  args: { modelId: v.id("leadScoringModels") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const model = await ctx.db.get(args.modelId);
    if (!model || model.orgId !== user.orgId) return null;
    return model;
  },
});

export const listScores = query({
  args: { modelId: v.optional(v.id("leadScoringModels")) },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const scores = await ctx.db
      .query("leadScores")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(500);

    const filteredScores = args.modelId
      ? scores.filter((score) => score.modelId === args.modelId)
      : scores;

    const enriched = [];
    for (const score of filteredScores) {
      const contact = await ctx.db.get(score.contactId);
      const account = contact?.accountId
        ? await ctx.db.get(contact.accountId)
        : null;
      const ownerId = contact?.ownerId ?? account?.ownerId;
      const owner = ownerId ? await ctx.db.get(ownerId) : null;
      const model = await ctx.db.get(score.modelId);
      enriched.push({
        ...score,
        contactName: contact
          ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() ||
            contact.email ||
            "Unknown contact"
          : "Unknown contact",
        contactEmail: contact?.email,
        contactTitle: contact?.title,
        accountName: account?.name,
        accountDomain: account?.domain,
        accountIndustry: account?.industry,
        accountEmployeeCount: account?.employeeCount,
        accountAnnualRevenue: account?.annualRevenue,
        ownerName: owner?.name,
        modelName: model?.name,
      });
    }

    return enriched;
  },
});

export const listRoutingRules = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("routingRules")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(50);
  },
});

// ── Mutations ─────────────────────────────────────────────────────

export const createModel = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    rules: v.array(
      v.object({
        field: v.string(),
        operator: v.string(),
        value: v.any(),
        points: v.number(),
      }),
    ),
    thresholds: v.object({
      hot: v.number(),
      warm: v.number(),
      cold: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const now = Date.now();
    return ctx.db.insert("leadScoringModels", {
      orgId: user.orgId,
      ...args,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ── Batched CRM score generation ──────────────────────────────────
//
// `generateFromCrm` used to be a single mutation that read up to 50 models +
// 1000 contacts + 500 accounts up front and then, per contact, a take(20) on
// leadScores.by_contactId — ≈1550 + contacts×20 reads and up to 1000 writes
// in ONE transaction. That blows Convex's 4096-read/8192-write mutation caps
// on a real org, and it silently scored only the first 1000 of 10K contacts.
//
// It is now a public ACTION of the same name (same result shape) that
// orchestrates bounded internal calls, mirroring the sync-action pattern:
//   1. requireStrategyEditor   — identity → user lookup (auth in a query)
//   2. ensureActiveModelInternal — small mutation resolving/creating the model
//   3. contactPageInternal       — pages ALL contacts (slim rows) to build the
//      per-account buying-committee counts and the batch id lists
//   4. scoreContactsBatchInternal per page — scores + upserts one batch using
//      the composite leadScores.by_contactId_modelId index (1 read per
//      contact×model instead of take(20))
//
// Worst-case math per batch (pageSize = floor(1200 / modelsScored); each run
// scores contacts against exactly ONE active model, so modelsScored = 1 and
// pageSize = 400 — if this ever scores M models per contact, the divisor
// shrinks the page automatically):
//   reads  ≤ 1 (model) + 400 (contact gets) + 400 (account gets, deduped)
//            + 400×1 (existing-score composite lookups) = 1201  ≤ 1600
//   writes ≤ 400×1 (one patch/insert per contact×model)         ≤ 1600
// Each contactPageInternal query transaction reads ~one page (≤400 rows).

/** Identity → user lookup for the action. Enforces the manager gate. */
export const requireStrategyEditor = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "lead scores over the CRM");
    return { userId: user._id, orgId: user.orgId };
  },
});

/** Resolve the active scoring model, creating the workspace's scoring.lead model if none exists. */
export const ensureActiveModelInternal = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<Doc<"leadScoringModels">> => {
    const models = await ctx.db
      .query("leadScoringModels")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .take(50);
    const existing = models.find((candidate) => candidate.isActive) ?? models[0];
    if (existing) return existing;

    const now = Date.now();
    const template = await modelSettings(ctx, args.orgId, "scoring.lead");
    const modelId = await ctx.db.insert("leadScoringModels", {
      orgId: args.orgId,
      name: "CRM Fit + Intent Score",
      description:
        "Default model generated from CRM titles, account size, revenue, and buying committee coverage.",
      rules: template.rules.map((rule) => ({ ...rule })),
      thresholds: template.thresholds,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(modelId);
    if (!created) throw new Error("Lead scoring model could not be loaded");
    return created;
  },
});

/** One slim page of contacts: just the ids needed for batching + counts. */
export const contactPageInternal = internalQuery({
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
        contactId: contact._id,
        accountId: contact.accountId ?? null,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

function scoreContactAgainstModel(args: {
  model: Doc<"leadScoringModels">;
  contact: Doc<"crmContacts">;
  account: Doc<"crmAccounts"> | undefined;
  contactCount: number;
  ownerPoints: number;
}) {
  const { model, contact, account, contactCount, ownerPoints } = args;
  const matchedRules = [];
  let score = 0;

  for (const rule of model.rules) {
    if (ruleMatches({ rule, contact, account, contactCount })) {
      score += rule.points;
      matchedRules.push({
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        points: rule.points,
      });
    }
  }

  if (account?.ownerId || contact.ownerId) {
    score += ownerPoints;
    matchedRules.push({
      field: "owner",
      operator: "exists",
      value: true,
      points: ownerPoints,
    });
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  return {
    score: normalizedScore,
    grade: gradeForScore(normalizedScore, model.thresholds),
    breakdown: {
      matchedRules,
      accountName: account?.name,
      accountIndustry: account?.industry,
      employeeCount: account?.employeeCount ?? 0,
      annualRevenue: account?.annualRevenue ?? 0,
      buyingCommitteeContacts: contactCount,
      ownerMapped: Boolean(account?.ownerId || contact.ownerId),
    },
  };
}

/**
 * Score + upsert one bounded batch of contacts. Reads ≤ 1 + 3×batch size,
 * writes ≤ batch size (see math above) — callers must keep batches ≤ ~400.
 */
export const scoreContactsBatchInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    modelId: v.id("leadScoringModels"),
    contactIds: v.array(v.id("crmContacts")),
    accountContactCounts: v.array(
      v.object({ accountId: v.id("crmAccounts"), count: v.number() }),
    ),
    calculatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const model = await ctx.db.get(args.modelId);
    if (!model || model.orgId !== args.orgId) {
      throw new Error("Lead scoring model not found");
    }
    const { ownerPoints } = await modelSettings(ctx, args.orgId, "scoring.lead");

    const countByAccount = new Map(
      args.accountContactCounts.map((entry) => [entry.accountId, entry.count]),
    );
    const accountCache = new Map<Id<"crmAccounts">, Doc<"crmAccounts"> | null>();

    let created = 0;
    let updated = 0;
    for (const contactId of args.contactIds) {
      const contact = await ctx.db.get(contactId);
      if (!contact || contact.orgId !== args.orgId) continue;

      let account: Doc<"crmAccounts"> | undefined;
      if (contact.accountId) {
        if (!accountCache.has(contact.accountId)) {
          accountCache.set(contact.accountId, await ctx.db.get(contact.accountId));
        }
        account = accountCache.get(contact.accountId) ?? undefined;
      }
      const contactCount = contact.accountId
        ? countByAccount.get(contact.accountId) ?? 0
        : 0;

      const result = scoreContactAgainstModel({
        model,
        contact,
        account,
        contactCount,
        ownerPoints,
      });

      // Composite index: exactly one read per contact×model.
      const existing = await ctx.db
        .query("leadScores")
        .withIndex("by_contactId_modelId", (q) =>
          q.eq("contactId", contact._id).eq("modelId", args.modelId),
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          score: result.score,
          grade: result.grade,
          breakdown: result.breakdown,
          calculatedAt: args.calculatedAt,
        });
        updated++;
      } else {
        await ctx.db.insert("leadScores", {
          orgId: args.orgId,
          contactId: contact._id,
          modelId: args.modelId,
          score: result.score,
          grade: result.grade,
          breakdown: result.breakdown,
          calculatedAt: args.calculatedAt,
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
    modelId: Id<"leadScoringModels">;
    created: number;
    updated: number;
    scored: number;
    totalScored: number;
  }> => {
    const auth: { userId: Id<"users">; orgId: Id<"organizations"> } =
      await ctx.runQuery(internal.leadScoring.requireStrategyEditor, {});
    const model: Doc<"leadScoringModels"> = await ctx.runMutation(
      internal.leadScoring.ensureActiveModelInternal,
      { orgId: auth.orgId },
    );
    const now = Date.now();

    // Each run scores against exactly one active model; shrink pages if that
    // ever changes so a batch stays ≤ ~1600 reads/writes.
    const modelsScored = 1;
    const pageSize = Math.max(50, Math.floor(1200 / Math.max(modelsScored, 1)));

    type SlimContact = {
      contactId: Id<"crmContacts">;
      accountId: Id<"crmAccounts"> | null;
    };

    // Phase A: page through ALL contacts (slim) to build global buying-
    // committee counts — every contact is considered, not just the first 1000.
    const pages: SlimContact[][] = [];
    const contactCountByAccount = new Map<Id<"crmAccounts">, number>();
    let cursor: string | null = null;
    for (;;) {
      const result: {
        page: SlimContact[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.leadScoring.contactPageInternal, {
        orgId: auth.orgId,
        paginationOpts: { numItems: pageSize, cursor },
      });
      if (result.page.length > 0) pages.push(result.page);
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

    // Phase B: score each page in its own bounded mutation.
    let created = 0;
    let updated = 0;
    for (const page of pages) {
      const accountIds = new Set<Id<"crmAccounts">>();
      for (const row of page) {
        if (row.accountId) accountIds.add(row.accountId);
      }
      const batch: { created: number; updated: number } = await ctx.runMutation(
        internal.leadScoring.scoreContactsBatchInternal,
        {
          orgId: auth.orgId,
          modelId: model._id,
          contactIds: page.map((row) => row.contactId),
          accountContactCounts: Array.from(accountIds, (accountId) => ({
            accountId,
            count: contactCountByAccount.get(accountId) ?? 0,
          })),
          calculatedAt: now,
        },
      );
      created += batch.created;
      updated += batch.updated;
    }

    return {
      modelId: model._id,
      created,
      updated,
      scored: created + updated,
      totalScored: created + updated,
    };
  },
});

export const updateModel = mutation({
  args: {
    modelId: v.id("leadScoringModels"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    rules: v.optional(
      v.array(
        v.object({
          field: v.string(),
          operator: v.string(),
          value: v.any(),
          points: v.number(),
        }),
      ),
    ),
    thresholds: v.optional(
      v.object({
        hot: v.number(),
        warm: v.number(),
        cold: v.number(),
      }),
    ),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { modelId, ...updates } = args;
    const model = await ctx.db.get(modelId);
    if (!model || model.orgId !== user.orgId)
      throw new Error("Model not found");

    const cleanUpdates: Record<string, any> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) cleanUpdates[key] = value;
    }
    await ctx.db.patch(modelId, cleanUpdates);
  },
});

export const createRoutingRule = mutation({
  args: {
    name: v.string(),
    method: v.union(
      v.literal("round_robin"),
      v.literal("weighted"),
      v.literal("territory_based"),
      v.literal("skill_based"),
    ),
    assignees: v.array(
      v.object({
        userId: v.id("users"),
        weight: v.optional(v.number()),
      }),
    ),
    criteria: v.optional(v.any()),
    slaMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    if (args.assignees.length === 0) {
      throw new Error("At least one assignee is required");
    }
    for (const assignee of args.assignees) {
      const teamMember = await ctx.db.get(assignee.userId);
      if (!teamMember || teamMember.orgId !== user.orgId) {
        throw new Error("Assignee not found");
      }
      if (!teamMember.isActive) {
        throw new Error("Assignee must be active");
      }
    }

    const now = Date.now();
    return ctx.db.insert("routingRules", {
      orgId: user.orgId,
      ...args,
      isActive: true,
      lastAssignedIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateRoutingRule = mutation({
  args: {
    ruleId: v.id("routingRules"),
    name: v.optional(v.string()),
    method: v.optional(
      v.union(
        v.literal("round_robin"),
        v.literal("weighted"),
        v.literal("territory_based"),
        v.literal("skill_based"),
      ),
    ),
    assignees: v.optional(
      v.array(
        v.object({
          userId: v.id("users"),
          weight: v.optional(v.number()),
        }),
      ),
    ),
    criteria: v.optional(v.any()),
    slaMinutes: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { ruleId, ...updates } = args;
    const rule = await ctx.db.get(ruleId);
    if (!rule || rule.orgId !== user.orgId)
      throw new Error("Routing rule not found");
    if (args.assignees) {
      if (args.assignees.length === 0) {
        throw new Error("At least one assignee is required");
      }
      for (const assignee of args.assignees) {
        const teamMember = await ctx.db.get(assignee.userId);
        if (!teamMember || teamMember.orgId !== user.orgId) {
          throw new Error("Assignee not found");
        }
        if (!teamMember.isActive) {
          throw new Error("Assignee must be active");
        }
      }
    }

    const cleanUpdates: Record<string, any> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) cleanUpdates[key] = value;
    }
    await ctx.db.patch(ruleId, cleanUpdates);
  },
});
