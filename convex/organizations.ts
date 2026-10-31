import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { query, mutation, internalMutation, internalAction, type MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { seedEnablements } from "./lib/recipes";
import { seedDefaultModules } from "./moduleDefaults";

function organizationReadinessFromRow(org: any) {
  const configured = Boolean(org.name && org.fiscalYearStartMonth && org.defaultCurrency && org.timezone);
  return {
    noun: "organization",
    required: true,
    relevant: true,
    configured,
    lifecycle: configured ? "configured" : "needs_settings",
    signals: { hasName: Boolean(org.name), fiscalYearStartMonth: org.fiscalYearStartMonth, defaultCurrency: org.defaultCurrency, timezone: org.timezone, hierarchySource: org.hierarchySource ?? null },
    nextActions: configured ? ["connect integrations", "review users"] : ["set organization.settings", "set organization.hierarchy_source"],
  };
}

function emptyOrganizationReadiness() {
  return {
    noun: "organization",
    required: true,
    relevant: false,
    configured: false,
    lifecycle: "not_found",
    signals: { hasName: false, fiscalYearStartMonth: null, defaultCurrency: null, timezone: null, hierarchySource: null },
    nextActions: ["Sign in to inspect organization readiness"],
  };
}

const syncScheduleValidator = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);

const hierarchySourceValidator = v.union(
  v.literal("salesforce"),
  v.literal("hubspot"),
  v.literal("csv"),
  v.literal("manual"),
);

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return emptyOrganizationReadiness();
    const org = await ctx.db.get(user.orgId);
    if (!org) return emptyOrganizationReadiness();
    return organizationReadinessFromRow(org);
  },
});

function organizationWithoutEmailPolicy(org: Doc<"organizations">): Omit<Doc<"organizations">, "outboundEmailPolicy"> {
  const row = { ...org };
  delete row.outboundEmailPolicy;
  return row;
}

export const context = query({
  args: {},
  handler: async (ctx) => {
    const features: { outbound: boolean; suppressions: boolean; mailboxGrants?: boolean; outboundEmailPolicy?: boolean } = { outbound: true, suppressions: true, mailboxGrants: true, outboundEmailPolicy: true };
    const user = await getCurrentUser(ctx);
    if (!user) return { readiness: emptyOrganizationReadiness(), organization: null, features };
    const org = await ctx.db.get(user.orgId);
    return { readiness: org ? organizationReadinessFromRow(org) : emptyOrganizationReadiness(), organization: org ? { ...organizationWithoutEmailPolicy(org), currentUserRole: user.role } : null, features };
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    const org = await ctx.db.get(user.orgId);
    if (!org) return null;

    return {
      ...organizationWithoutEmailPolicy(org),
      currentUserRole: user.role,
    };
  },
});

export const updateSettings = mutation({
  args: {
    name: v.optional(v.string()),
    industry: v.optional(v.string()),
    fiscalYearStartMonth: v.optional(v.number()),
    defaultCurrency: v.optional(v.string()),
    /** The places money shows with: 0 to 4. */
    currencyDecimals: v.optional(v.number()),
    timezone: v.optional(v.string()),
    syncSchedule: v.optional(syncScheduleValidator),
    hierarchySource: v.optional(hierarchySourceValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "workspace.edit")) throw new ConvexError(refusal("workspace.edit"));

    const org = await ctx.db.get(user.orgId);
    if (!org) throw new ConvexError("Organization not found");

    const updates: Record<string, string | number> = { updatedAt: Date.now() };

    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new ConvexError("Organization name is required");
      updates.name = name;
    }

    if (args.industry !== undefined) {
      const industry = args.industry.trim();
      if (industry) updates.industry = industry;
    }

    if (args.fiscalYearStartMonth !== undefined) {
      if (
        !Number.isInteger(args.fiscalYearStartMonth) ||
        args.fiscalYearStartMonth < 1 ||
        args.fiscalYearStartMonth > 12
      ) {
        throw new ConvexError("Fiscal year start month must be between 1 and 12");
      }
      updates.fiscalYearStartMonth = args.fiscalYearStartMonth;
    }

    if (args.defaultCurrency !== undefined) {
      const currency = args.defaultCurrency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new ConvexError("Currency must be a three-letter ISO code");
      }
      updates.defaultCurrency = currency;
    }

    if (args.currencyDecimals !== undefined) {
      if (!Number.isInteger(args.currencyDecimals) || args.currencyDecimals < 0 || args.currencyDecimals > 4) {
        throw new ConvexError("Currency decimal places must be a whole number from 0 to 4");
      }
      updates.currencyDecimals = args.currencyDecimals;
    }

    if (args.timezone !== undefined) {
      const timezone = args.timezone.trim();
      if (!timezone) throw new ConvexError("Timezone is required");
      updates.timezone = timezone;
    }

    if (args.syncSchedule !== undefined) {
      updates.syncSchedule = args.syncSchedule;
    }

    if (args.hierarchySource !== undefined) {
      updates.hierarchySource = args.hierarchySource;
      updates.hierarchySyncedAt = Date.now();
    }

    await ctx.db.patch(org._id, updates);
    return org._id;
  },
});

/**
 * Refresh the org's maintained CRM aggregates (schema: organizations.crmCounts).
 * Called from the END of every successful CRM sync (hubspotActions /
 * salesforceActions), which already holds the full mapped arrays in the action
 * runtime — so this costs 1 read + 1 write, never a table scan. Money fields
 * are cents. Readers (dashboard.summary, per-noun readiness) treat these as
 * the source of truth for counts/pipeline instead of scanning row tables.
 */
export const updateCrmCounts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    counts: v.object({
      accounts: v.number(),
      contacts: v.number(),
      deals: v.number(),
      openDeals: v.number(),
      openPipeline: v.number(), // cents
      wonRevenue: v.number(), // cents
      unownedDeals: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new ConvexError("Organization not found");
    await ctx.db.patch(args.orgId, {
      crmCounts: { ...args.counts, updatedAt: Date.now() },
    });
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        updatedAt: now,
      });
      return existing._id;
    }

    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      fiscalYearStartMonth: 1,
      defaultCurrency: "USD",
      timezone: "America/New_York",
      planTier: "free",
      createdAt: now,
      updatedAt: now,
    });
    await seedEnablements(ctx, orgId, now);
    await seedDefaultModules(ctx, orgId);
    return orgId;
  },
});

// ── Org data purge ───────────────────────────────────────────
//
// Removes everything a CRM/call-provider sync wrote into an org (mirror rows,
// sync runs, health readings, call data, derived scores) WITHOUT touching org
// config, users, memberships, or governance ledgers (patchPlans /
// operationAuditLog stay — they are audit trail). Built for the 2026-07-02
// incident where the pre-#192 webhook bug landed CanonCRM's HubSpot
// sync inside the Vidmob org; reusable for any org reset.

// Tables holding synced or CRM-derived rows, all org-scoped. Config tables
// (icpProfiles, leadScoringModels, callInsightTags, scorecardConfigs) are
// deliberately absent.
const PURGE_TABLES = [
  "crmAccounts",
  "crmContacts",
  "deals",
  // CanonCRM fact ledger for those deals
  "facts",
  "canonFieldState",
  "canonOutboundShadow",
  "canonExternalIds",
  "canonEntities",
  "integrationSyncRuns",
  "callTranscriptSegments",
  "callInsights",
  "callRecordings",
  "accountEnrichments",
  "icpScores",
  "leadScores",
  "scorecardResults",
] as const;

// Purge tables with no plain by_orgId index: each reads through an index that
// starts with orgId. The object layer's ledger tables (docs/cp0-object-layer.md)
// keep to two indexes each, so they never get a by_orgId one. objectDefs is
// org config, like icpProfiles, and stays.
type OrgRows = (db: MutationCtx["db"], orgId: Id<"organizations">, n: number) => Promise<Array<{ _id: Id<TableNames> }>>;
const PURGE_BY_ORG_PREFIX: Record<string, OrgRows> = {
  healthSnapshots: (db, orgId, n) => db.query("healthSnapshots").withIndex("by_orgId_at", (q) => q.eq("orgId", orgId)).take(n),
  crmOpportunities: (db, orgId, n) => db.query("crmOpportunities").withIndex("by_orgId_rule", (q) => q.eq("orgId", orgId)).take(n),
  ledgerEntries: (db, orgId, n) => db.query("ledgerEntries").withIndex("by_orgId_shard_seq", (q) => q.eq("orgId", orgId)).take(n),
  ledgerShardHeads: (db, orgId, n) => db.query("ledgerShardHeads").withIndex("by_orgId_shard", (q) => q.eq("orgId", orgId)).take(n),
  recordRows: (db, orgId, n) => db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId)).take(n),
  associations: (db, orgId, n) => db.query("associations").withIndex("by_orgId_association_fromId_toId", (q) => q.eq("orgId", orgId)).take(n),
  proposalQueue: (db, orgId, n) => db.query("proposalQueue").withIndex("by_orgId_observedAt", (q) => q.eq("orgId", orgId)).take(n),
};

// One bounded batch: deletes up to 400 rows across the purge tables, then on
// the final pass optionally deletes the org's integrations and resets its
// sync counters. Read budget: ≤400 rows + org row + integrations (<10) —
// far under the 4096 cap. `slug` must match the org row exactly: a purge is
// irreversible, so the caller has to name its target twice.
export const purgeSyncedDataBatch = internalMutation({
  args: {
    orgId: v.id("organizations"),
    slug: v.string(),
    includeIntegrations: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new Error("Organization not found");
    if (org.slug !== args.slug) {
      throw new Error(
        `Slug mismatch: org is "${org.slug}" — refusing to purge`,
      );
    }

    const BATCH = 400;
    const deleted: Record<string, number> = {};
    let remaining = BATCH;

    for (const table of PURGE_TABLES) {
      if (remaining <= 0) break;
      const rows = await ctx.db
        .query(table)
        .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
        .take(remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length > 0) deleted[table] = rows.length;
      remaining -= rows.length;
    }

    for (const [table, takeByOrg] of Object.entries(PURGE_BY_ORG_PREFIX)) {
      if (remaining <= 0) break;
      const rows = await takeByOrg(ctx.db, args.orgId, remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length > 0) deleted[table] = rows.length;
      remaining -= rows.length;
    }

    if (remaining <= 0) return { deleted, done: false };

    if (args.includeIntegrations) {
      const integrations = await ctx.db
        .query("integrations")
        .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
        .collect();
      for (const integration of integrations) {
        await ctx.db.delete(integration._id);
      }
      if (integrations.length > 0) deleted["integrations"] = integrations.length;
    }

    await ctx.db.patch(args.orgId, {
      crmCounts: undefined,
      hierarchySource: undefined,
      hierarchySyncedAt: undefined,
      updatedAt: Date.now(),
    });
    return { deleted, done: true };
  },
});

// Driver: loops purgeSyncedDataBatch until it reports done. Run with
// `npx convex run organizations:purgeSyncedData
//   '{"orgId":"...","slug":"...","includeIntegrations":true}'`
export const purgeSyncedData = internalAction({
  args: {
    orgId: v.id("organizations"),
    slug: v.string(),
    includeIntegrations: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const totals: Record<string, number> = {};
    for (let batch = 0; batch < 1000; batch++) {
      const result: { deleted: Record<string, number>; done: boolean } =
        await ctx.runMutation(internal.organizations.purgeSyncedDataBatch, args);
      for (const [table, count] of Object.entries(result.deleted)) {
        totals[table] = (totals[table] ?? 0) + count;
      }
      if (result.done) return totals;
    }
    throw new Error("Purge did not converge in 1000 batches");
  },
});
