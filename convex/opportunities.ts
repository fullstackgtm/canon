import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireUser } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import type { Id } from "./_generated/dataModel";
import { builtinAuditRules } from "../engine/src/rules.ts";

const statusValidator = v.union(
  v.literal("open"),
  v.literal("planned"),
  v.literal("resolved"),
  v.literal("dismissed"),
);
const severityValidator = v.union(v.literal("info"), v.literal("warning"), v.literal("critical"));
const crmProviderValidator = v.union(v.literal("hubspot"), v.literal("salesforce"));

const RULE_BATCH = 500;
const SUMMARY_RULE_CAP = 2000;
const BUILTIN_RULE_IDS = builtinAuditRules.map((rule) => rule.id);
const pendingPlanStatuses = new Set(["draft", "pending_approval", "approved"]);

const opportunityValidator = v.object({
  rule: v.string(),
  severity: severityValidator,
  objectType: v.string(),
  objectId: v.string(),
  objectLabel: v.string(),
  summary: v.string(),
  truncated: v.optional(v.boolean()),
});

export const nonTerminalRulesPage = internalQuery({
  args: {
    orgId: v.id("organizations"),
    status: v.union(v.literal("open"), v.literal("planned")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crmOpportunities")
      .withIndex("by_orgId_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status))
      .paginate({ numItems: 1000, cursor: args.cursor });
    return {
      rules: [...new Set(page.page.map((row) => row.rule))],
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const cleanupResolvedRulePage = internalMutation({
  args: { orgId: v.id("organizations"), rule: v.string(), snapshotAt: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crmOpportunities")
      .withIndex("by_orgId_rule_status", (q) => q.eq("orgId", args.orgId).eq("rule", args.rule).eq("status", "resolved"))
      .paginate({ numItems: RULE_BATCH, cursor: args.cursor });
    let deleted = 0;
    for (const row of page.page) {
      if (row.snapshotAt < args.snapshotAt) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const resolveVanishedRulePage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    rule: v.string(),
    snapshotAt: v.number(),
    status: v.union(v.literal("open"), v.literal("planned")),
    incomingObjectIds: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const incoming = new Set(args.incomingObjectIds);
    const page = await ctx.db
      .query("crmOpportunities")
      .withIndex("by_orgId_rule_status", (q) => q.eq("orgId", args.orgId).eq("rule", args.rule).eq("status", args.status))
      .paginate({ numItems: RULE_BATCH, cursor: args.cursor });
    let resolved = 0;
    for (const row of page.page) {
      if (!incoming.has(row.objectId)) {
        await ctx.db.patch(row._id, { status: "resolved", snapshotAt: args.snapshotAt, updatedAt: Date.now() });
        resolved += 1;
      }
    }
    return { resolved, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const upsertIncomingRule = internalMutation({
  args: {
    orgId: v.id("organizations"),
    integrationId: v.optional(v.id("integrations")),
    provider: v.string(),
    snapshotAt: v.number(),
    rule: v.string(),
    opportunities: v.array(opportunityValidator),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    let deduped = 0;
    for (const op of args.opportunities) {
      const rows = await ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_rule_objectId", (q) =>
          q.eq("orgId", args.orgId).eq("rule", args.rule).eq("objectId", op.objectId),
        )
        .take(20);
      const keep = rows.find((row) => row.status === "dismissed") ?? rows.find((row) => row.status === "planned") ?? rows[0];
      let status: "open" | "planned" | "dismissed" = "open";
      let planId: Id<"patchPlans"> | undefined;
      if (keep?.status === "dismissed") {
        status = "dismissed";
      } else if (keep?.status === "planned" && keep.planId) {
        const plan = await ctx.db.get(keep.planId);
        if (plan && plan.orgId === args.orgId && pendingPlanStatuses.has(plan.status)) {
          status = "planned";
          planId = keep.planId;
        }
      }
      for (const row of rows) {
        if (keep && row._id !== keep._id) {
          await ctx.db.delete(row._id);
          deduped += 1;
        }
      }
      const patch = {
        integrationId: args.integrationId,
        provider: args.provider,
        snapshotAt: args.snapshotAt,
        severity: op.severity,
        objectType: op.objectType,
        objectId: op.objectId,
        objectLabel: op.objectLabel.slice(0, 180),
        summary: op.summary.slice(0, 280),
        status,
        planId,
        truncated: op.truncated,
        updatedAt: Date.now(),
      };
      if (keep) {
        await ctx.db.patch(keep._id, patch);
        updated += 1;
      } else {
        await ctx.db.insert("crmOpportunities", {
          orgId: args.orgId,
          rule: args.rule,
          ...patch,
        });
        inserted += 1;
      }
    }
    return { inserted, updated, deduped };
  },
});

async function summarizeOpenRows(ctx: QueryCtx, orgId: Id<"organizations">, provider?: "hubspot" | "salesforce") {
  const buckets = new Map<string, { rule: string; severity: string; count: number; truncated: boolean }>();
  let totalOpen = 0;
  let totalOpenTruncated = false;
  for (const rule of BUILTIN_RULE_IDS) {
    const rows = await ctx.db
      .query("crmOpportunities")
      .withIndex("by_orgId_rule_status", (q) => q.eq("orgId", orgId).eq("rule", rule).eq("status", "open"))
      .take(SUMMARY_RULE_CAP + 1);
    const visibleRows = provider ? rows.filter((row) => row.provider === provider) : rows;
    const clamped = rows.length > SUMMARY_RULE_CAP;
    totalOpen += Math.min(visibleRows.length, SUMMARY_RULE_CAP);
    totalOpenTruncated = totalOpenTruncated || (provider ? false : clamped);
    for (const row of visibleRows.slice(0, SUMMARY_RULE_CAP)) {
      const key = `${row.rule}:${row.severity}`;
      const bucket = buckets.get(key) ?? { rule: row.rule, severity: row.severity, count: 0, truncated: false };
      bucket.count += 1;
      bucket.truncated = bucket.truncated || row.truncated === true || (!provider && clamped);
      buckets.set(key, bucket);
    }
  }
  return { totalOpen, totalOpenTruncated, categories: [...buckets.values()].sort((a, b) => b.count - a.count) };
}

export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { totalOpen: 0, totalOpenTruncated: false, categories: [] };
    return summarizeOpenRows(ctx, user.orgId);
  },
});

export const summaryForProvider = query({
  args: { provider: crmProviderValidator },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { totalOpen: 0, totalOpenTruncated: false, categories: [] };
    return summarizeOpenRows(ctx, user.orgId, args.provider);
  },
});

export const rulesForStatus = query({
  args: { status: statusValidator },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const rules: string[] = [];
    for (const rule of BUILTIN_RULE_IDS) {
      const row = await ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_rule_status", (q) => q.eq("orgId", user.orgId).eq("rule", rule).eq("status", args.status))
        .first();
      if (row) rules.push(rule);
    }
    return rules;
  },
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    rule: v.optional(v.string()),
    status: v.optional(statusValidator),
  },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    if (args.rule && args.status) {
      return ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_rule_status", (q) =>
          q.eq("orgId", user.orgId).eq("rule", args.rule!).eq("status", args.status!),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }
    if (args.rule) {
      return ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_rule", (q) => q.eq("orgId", user.orgId).eq("rule", args.rule!))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    if (args.status) {
      return ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_status", (q) => q.eq("orgId", user.orgId).eq("status", args.status!))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return ctx.db
      .query("crmOpportunities")
      .withIndex("by_orgId_snapshotAt", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const dismiss = mutation({
  args: { opportunityId: v.id("crmOpportunities") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "opportunities over the CRM");
    const row = await ctx.db.get(args.opportunityId);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("Opportunity not found");
    await ctx.db.patch(args.opportunityId, { status: "dismissed", updatedAt: Date.now() });
    return { ok: true };
  },
});

export const markPlannedForRule = internalMutation({
  args: {
    orgId: v.id("organizations"),
    rule: v.string(),
    planId: v.id("patchPlans"),
    objectIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const covered = new Set(args.objectIds);
    let planned = 0;
    for (const objectId of covered) {
      const rows = await ctx.db
        .query("crmOpportunities")
        .withIndex("by_orgId_rule_objectId", (q) =>
          q.eq("orgId", args.orgId).eq("rule", args.rule).eq("objectId", objectId),
        )
        .take(20);
      for (const row of rows) {
        if (row.status !== "open") continue;
        await ctx.db.patch(row._id, { status: "planned", planId: args.planId, updatedAt: Date.now() });
        planned += 1;
      }
    }
    return { planned };
  },
});
