import { assertLegacyIcpsWritable } from "./lib/modules/interfaceOwnership";
import { ConvexError, v } from "convex/values";
import { seedDefaultModules } from "./moduleDefaults";
import { DEFAULT_BUDGET } from "./lib/agents/webhook";
import { action, internalAction, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { clientFor } from "./records";
import { promoteContacts } from "./lib/recordPromotion";
import { saveCrmAccount, saveCrmContact, saveDeal, saveDealValues, SYNCED_DEAL_ATTRIBUTES } from "./canon";
import { applyAccount } from "./signals";
import { invalidateFit } from "./lib/fitInvalidation";
import { modelSettings } from "./lib/recipes";
import { rescoreOrg } from "./icps";
import { saveDealAsCaller } from "./objects";
import { peopleField } from "./researchAgents";
import { RECIPES, defaultPlays } from "../recipes/index.ts";
import { ACME_COMPANIES, ACME_DEALS } from "./lib/sampleAcme.ts";
import { checkPackage } from "./recipes";
import { copyOf } from "./workspaceRecipes";
import { attributeFor } from "./lib/research/agentLoop";
import { emptySpec } from "./lib/icps";
import { icpVersionWeightsValidator } from "./lib/scoreHistory";
import { generatePdlSample, pdlToAccountInput } from "./lib/recordClient";
import { startPopulation } from "./populateActions";
import { stagePage } from "./staging";
import { peopleToRecords, type Person } from "./lib/peopleSources";
import { linkContacts } from "./lib/conversations/store";
import { heuristicIcp } from "./lib/researchPipeline";
import { FREE_CREDITS_PER_MONTH, MICRO } from "./lib/creditPacks";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  DEV_ORG_CLERK_ID,
  DEV_ORG_SLUG,
  DEV_USER_CLERK_ID,
  isDevAuthBypassEnabled,
} from "./lib";

/** The seeded deal is worked the FSGTM way, the default recipe's. */
const SEED_PEOPLE = defaultPlays("fsgtm-enterprise-deal")!.people;

const DAY_MS = 24 * 60 * 60 * 1000;

function cents(amount: number) {
  return Math.round(amount * 100);
}

function ymd(date: Date) {
  return date.toISOString().split("T")[0];
}

function daysFrom(now: number, days: number) {
  return ymd(new Date(now + days * DAY_MS));
}

async function ensureOrganization(ctx: MutationCtx, now: number) {
  const existing = await ctx.db
    .query("organizations")
    .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID))
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      name: "CanonCRM Demo",
      slug: DEV_ORG_SLUG,
      updatedAt: now,
    });
    return existing._id;
  }

  return ctx.db.insert("organizations", {
    clerkOrgId: DEV_ORG_CLERK_ID,
    name: "CanonCRM Demo",
    slug: DEV_ORG_SLUG,
    industry: "B2B SaaS",
    fiscalYearStartMonth: 1,
    defaultCurrency: "USD",
    timezone: "America/Los_Angeles",
    onboardingCompletedAt: now,
    syncSchedule: "daily",
    hierarchySource: "hubspot",
    hierarchySyncedAt: now,
    planTier: "growth",
    createdAt: now,
    updatedAt: now,
  });
}

export async function ensureUser(
  ctx: MutationCtx,
  input: {
    orgId: Id<"organizations">;
    clerkUserId: string;
    email: string;
    name: string;
    role: "admin" | "manager" | "rep" | "other";
    title: string;
    managerId?: Id<"users">;
    startDate: string;
  },
) {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", input.clerkUserId))
    .first();

  const patch = {
    orgId: input.orgId,
    email: input.email,
    name: input.name,
    role: input.role,
    title: input.title,
    ...(input.managerId ? { managerId: input.managerId } : {}),
    department: "Sales",
    isActive: true,
    isHidden: false,
    startDate: input.startDate,
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return existing._id;
  }

  return ctx.db.insert("users", {
    clerkUserId: input.clerkUserId,
    ...patch,
    createdAt: Date.now(),
  });
}

export async function ensureAccount(
  ctx: MutationCtx,
  input: {
    orgId: Id<"organizations">;
    crmId: string;
    name: string;
    domain: string;
    industry: string;
    employeeCount: number;
    annualRevenue: number;
    ownerId: Id<"users">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("crmAccounts")
    .withIndex("by_orgId_crmId", (q) =>
      q.eq("orgId", input.orgId).eq("crmId", input.crmId),
    )
    .first();

  const doc = {
    orgId: input.orgId,
    crmId: input.crmId,
    provider: "hubspot",
    name: input.name,
    domain: input.domain,
    industry: input.industry,
    employeeCount: input.employeeCount,
    annualRevenue: input.annualRevenue,
    ownerId: input.ownerId,
    crmOwnerId: `owner-${input.ownerId}`,
    rawData: { source: "demo" },
    lastSyncAt: input.now,
    createdAt: input.now,
  };

  const id = existing ? existing._id : await ctx.db.insert("crmAccounts", doc);
  if (existing) await ctx.db.patch(id, doc);
  const saved = await ctx.db.get(id);
  if (saved) await saveCrmAccount(ctx, saved);
  return id;
}

async function ensureContact(
  ctx: MutationCtx,
  input: {
    orgId: Id<"organizations">;
    crmId: string;
    accountId: Id<"crmAccounts">;
    firstName: string;
    lastName: string;
    email: string;
    title: string;
    ownerId: Id<"users">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("crmContacts")
    .withIndex("by_orgId_crmId", (q) =>
      q.eq("orgId", input.orgId).eq("crmId", input.crmId),
    )
    .first();

  const doc = {
    orgId: input.orgId,
    crmId: input.crmId,
    provider: "hubspot",
    accountId: input.accountId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    title: input.title,
    ownerId: input.ownerId,
    crmOwnerId: `owner-${input.ownerId}`,
    rawData: { source: "demo" },
    lastSyncAt: input.now,
    createdAt: input.now,
  };

  const id = existing ? existing._id : await ctx.db.insert("crmContacts", doc);
  if (existing) await ctx.db.patch(id, doc);
  const saved = await ctx.db.get(id);
  if (saved) await saveCrmContact(ctx, saved);
  return id;
}

export async function ensureDeal(
  ctx: MutationCtx,
  input: {
    orgId: Id<"organizations">;
    crmId: string;
    name: string;
    amount: number;
    closeDate: string;
    stage: string;
    forecastCategory:
      | "pipeline"
      | "best_case"
      | "commit"
      | "closed_won"
      | "closed_lost";
    probability: number;
    primaryRepId: Id<"users">;
    accountId: Id<"crmAccounts">;
    isClosed: boolean;
    isWon: boolean;
    now: number;
    dealType?: Doc<"deals">["dealType"];
    closedAt?: number;
  },
) {
  const existing = await ctx.db
    .query("deals")
    .withIndex("by_orgId_crmId", (q) =>
      q.eq("orgId", input.orgId).eq("crmId", input.crmId),
    )
    .first();

  const doc = {
    orgId: input.orgId,
    name: input.name,
    amount: input.amount,
    currency: "USD",
    closeDate: input.closeDate,
    dealType: input.dealType ?? "new_business",
    revenueType: "recurring" as const,
    contractLengthMonths: 12,
    mrr: Math.round(input.amount / 12),
    arr: input.amount,
    primaryRepId: input.primaryRepId,
    stage: input.stage,
    forecastCategory: input.forecastCategory,
    probability: input.probability,
    accountId: input.accountId,
    crmId: input.crmId,
    crmProvider: "hubspot",
    crmUrl: `https://app.hubspot.com/contacts/demo/deal/${input.crmId}`,
    products: ["Core platform"],
    competitorMentioned: input.isWon ? [] : ["Point Solution Co"],
    rawData: { source: "demo" },
    isClosed: input.isClosed,
    isWon: input.isWon,
    ...(input.isClosed ? { closedAt: input.closedAt ?? input.now - 7 * DAY_MS } : {}),
    lastSyncAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  };

  const dealId = existing ? existing._id : await ctx.db.insert("deals", doc);
  // An existing deal's owner goes through the ledger, as a HubSpot sync's does, so an owner a person chose holds.
  if (existing) await ctx.db.patch(existing._id, Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "primaryRepId")));
  // The seed stands in for a HubSpot sync, so its deals go through the deal ledger as one.
  const row = await ctx.db.get(dealId);
  if (row) await saveDeal(ctx, row, { kind: "hubspot", crmId: input.crmId, rawData: doc.rawData }, SYNCED_DEAL_ATTRIBUTES, input.now, { owner: input.primaryRepId });
  return dealId;
}

export const ensureWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) {
      throw new ConvexError("Demo workspace seeding is disabled");
    }

    const now = Date.now();
    // A second workspace that devWorkspaces.moveDevUser made keeps the dev user until it is moved back, so a page
    // load (which calls this) opens the imported workspace rather than the demo one.
    const dev = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    const away = dev ? await ctx.db.get(dev.orgId) : null;
    if (dev && away?.clerkOrgId?.startsWith("dev_import_")) return { orgId: away._id, userId: dev._id, seededAt: now };
    const orgId = await ensureOrganization(ctx, now);
    await seedDefaultModules(ctx, orgId);

    const adminId = await ensureUser(ctx, {
      orgId,
      clerkUserId: DEV_USER_CLERK_ID,
      email: "founder@fullstackgtm.demo",
      name: "Riley Founder",
      role: "admin",
      title: "Founder & CEO",
      startDate: daysFrom(now, -420),
    });
    const salesLeaderId = await ensureUser(ctx, {
      orgId,
      clerkUserId: "dev_user_sales_leader",
      email: "morgan@fullstackgtm.demo",
      name: "Morgan Lee",
      role: "manager",
      title: "GTM Leader",
      managerId: adminId,
      startDate: daysFrom(now, -210),
    });
    const aeWestId = await ensureUser(ctx, {
      orgId,
      clerkUserId: "dev_user_ae_west",
      email: "avery@fullstackgtm.demo",
      name: "Avery Chen",
      role: "rep",
      title: "Account Executive, West",
      managerId: salesLeaderId,
      startDate: daysFrom(now, -120),
    });
    const aeEastId = await ensureUser(ctx, {
      orgId,
      clerkUserId: "dev_user_ae_east",
      email: "jordan@fullstackgtm.demo",
      name: "Jordan Patel",
      role: "rep",
      title: "Account Executive, East",
      managerId: salesLeaderId,
      startDate: daysFrom(now, -70),
    });

    const teamGroup = (
      await ctx.db
        .query("teamGroups")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((group) => group.name === "Founding GTM Team");
    if (!teamGroup) {
      await ctx.db.insert("teamGroups", {
        orgId,
        name: "Founding GTM Team",
        managerId: salesLeaderId,
        memberIds: [salesLeaderId, aeWestId, aeEastId],
        createdAt: now,
      });
    }

    const hubspot = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", orgId).eq("provider", "hubspot"),
      )
      .first();
    const hubspotPatch = {
      orgId,
      provider: "hubspot" as const,
      accessToken: "demo-access-token",
      refreshToken: "demo-refresh-token",
      instanceUrl: "https://api.hubapi.com",
      scopes: ["crm.objects.deals.read", "crm.objects.contacts.read"],
      lastSyncAt: now,
      lastSyncStatus: "success" as const,
      lastSyncDealCount: 4,
      syncCursors: { accounts: "demo", contacts: "demo", deals: "demo" },
      fieldMappings: {
        dealAmount: "amount",
        closeDate: "closedate",
        owner: "hubspot_owner_id",
      },
      syncConfig: { schedule: "daily" },
      isActive: true,
      connectedBy: adminId,
      connectedAt: now - 4 * DAY_MS,
      createdAt: now,
      updatedAt: now,
    };
    // A connection someone made on this stack (a `fixture:` portal, lib/hubspotFixture.ts) is kept; only the demo one is reset.
    const hubspotId = hubspot
      ? (hubspot.accessToken === hubspotPatch.accessToken ? await ctx.db.patch(hubspot._id, hubspotPatch) : null, hubspot._id)
      : await ctx.db.insert("integrations", hubspotPatch);

    const syncRuns = await ctx.db
      .query("integrationSyncRuns")
      .withIndex("by_orgId_provider_startedAt", (q) =>
        q.eq("orgId", orgId).eq("provider", "hubspot"),
      )
      .take(5);
    if (syncRuns.length === 0) {
      await ctx.db.insert("integrationSyncRuns", {
        orgId,
        integrationId: hubspotId,
        provider: "hubspot",
        trigger: "system",
        status: "success",
        startedAt: now - 60_000,
        finishedAt: now - 45_000,
        counts: { accounts: 3, contacts: 3, deals: 4, users: 4 },
      });
    }

    const atlasId = await ensureAccount(ctx, {
      orgId,
      crmId: "demo-account-atlas",
      name: "Atlas Cloud",
      domain: "atlascloud.example",
      industry: "Cloud Infrastructure",
      employeeCount: 640,
      annualRevenue: cents(76_000_000),
      ownerId: aeWestId,
      now,
    });
    const northstarId = await ensureAccount(ctx, {
      orgId,
      crmId: "demo-account-northstar",
      name: "Northstar Data",
      domain: "northstardata.example",
      industry: "Data Platform",
      employeeCount: 310,
      annualRevenue: cents(31_000_000),
      ownerId: aeEastId,
      now,
    });
    const brightlineId = await ensureAccount(ctx, {
      orgId,
      crmId: "demo-account-brightline",
      name: "Brightline Robotics",
      domain: "brightlinerobotics.example",
      industry: "Manufacturing",
      employeeCount: 1200,
      annualRevenue: cents(210_000_000),
      ownerId: salesLeaderId,
      now,
    });

    await ensureContact(ctx, {
      orgId,
      crmId: "demo-contact-atlas-cfo",
      accountId: atlasId,
      firstName: "Sam",
      lastName: "Rivera",
      email: "sam.rivera@atlascloud.example",
      title: "CFO",
      ownerId: aeWestId,
      now,
    });
    const northstarContactId = await ensureContact(ctx, {
      orgId,
      crmId: "demo-contact-northstar-cro",
      accountId: northstarId,
      firstName: "Taylor",
      lastName: "Ng",
      email: "taylor.ng@northstardata.example",
      title: "CRO",
      ownerId: aeEastId,
      now,
    });

    await ensureDeal(ctx, {
      orgId,
      crmId: "demo-deal-atlas-platform",
      name: "Atlas Cloud - Platform Expansion",
      amount: cents(145_000),
      closeDate: daysFrom(now, 24),
      stage: "Proposal",
      forecastCategory: "commit",
      probability: 0.8,
      primaryRepId: aeWestId,
      accountId: atlasId,
      isClosed: false,
      isWon: false,
      now,
    });
    const northstarDealId = await ensureDeal(ctx, {
      orgId,
      crmId: "demo-deal-northstar-new",
      name: "Northstar Data - New Business",
      amount: cents(92_000),
      closeDate: daysFrom(now, 42),
      stage: "Discovery",
      forecastCategory: "best_case",
      probability: 0.45,
      primaryRepId: aeEastId,
      accountId: northstarId,
      isClosed: false,
      isWon: false,
      now,
    });
    await ensureDeal(ctx, {
      orgId,
      crmId: "demo-deal-brightline-won",
      name: "Brightline Robotics - Initial Rollout",
      amount: cents(210_000),
      closeDate: daysFrom(now, -8),
      stage: "Closed Won",
      forecastCategory: "closed_won",
      probability: 1,
      primaryRepId: salesLeaderId,
      accountId: brightlineId,
      isClosed: true,
      isWon: true,
      now,
    });

    const icpProfile = (
      await ctx.db
        .query("icpProfiles")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((profile) => profile.name === "Enterprise SaaS");
    const icpProfileId =
      icpProfile?._id ??
      (await ctx.db.insert("icpProfiles", {
        orgId,
        name: "Enterprise SaaS",
        description: "High-growth SaaS accounts with clear RevOps pain.",
        attributes: [
          { field: "industry", operator: "contains", value: "Cloud", weight: 35 },
          { field: "employeeCount", operator: "gte", value: 250, weight: 30 },
          { field: "annualRevenue", operator: "gte", value: cents(20_000_000), weight: 35 },
        ],
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }));

    const icpScore = (
      await ctx.db
        .query("icpScores")
        .withIndex("by_accountId", (q) => q.eq("accountId", atlasId))
        .take(20)
    ).find((score) => score.profileId === icpProfileId);
    if (!icpScore) {
      await ctx.db.insert("icpScores", {
        orgId,
        accountId: atlasId,
        profileId: icpProfileId,
        score: 92,
        breakdown: { industry: 35, size: 27, revenue: 30 },
        calculatedAt: now,
      });
    }

    const enrichment = (
      await ctx.db
        .query("accountEnrichments")
        .withIndex("by_accountId", (q) => q.eq("accountId", atlasId))
        .take(20)
    ).find((row) => row.source === "ai");
    if (!enrichment) {
      await ctx.db.insert("accountEnrichments", {
        orgId,
        accountId: atlasId,
        source: "ai",
        firmographics: {
          founded: "2018",
          headquarters: "San Francisco, CA",
          employeeRange: "501-1000",
          revenueRange: "$50M-$100M",
          fundingStage: "Series C",
          totalFunding: cents(82_000_000),
        },
        techStack: ["Salesforce", "Snowflake", "Marketo"],
        signals: [
          {
            type: "hiring",
            title: "Hiring RevOps leadership",
            summary: "Open role indicates investment in GTM systems.",
            detectedAt: now - 2 * DAY_MS,
          },
        ],
        lastEnrichedAt: now,
        createdAt: now,
      });
    }

    const competitor = (
      await ctx.db
        .query("competitors")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((row) => row.name === "Point Solution Co");
    const competitorId =
      competitor?._id ??
      (await ctx.db.insert("competitors", {
        orgId,
        name: "Point Solution Co",
        website: "https://pointsolution.example",
        description: "Narrow RevOps spreadsheet automation tool.",
        strengths: ["Fast onboarding", "Familiar spreadsheet UI"],
        weaknesses: ["Limited cross-module data model", "No planning workflow"],
        positioning: "Best for tactical spreadsheet replacement.",
        pricingNotes: "$499/mo team plan",
        createdAt: now,
        updatedAt: now,
      }));

    const battlecard = (
      await ctx.db
        .query("battlecards")
        .withIndex("by_competitorId", (q) => q.eq("competitorId", competitorId))
        .take(20)
    ).find((row) => row.title === "Why CanonCRM wins");
    if (!battlecard) {
      await ctx.db.insert("battlecards", {
        orgId,
        competitorId,
        title: "Why CanonCRM wins",
        category: "talk_track",
        content: "Lead with connected CRM inheritance, planning primitives, and cross-module recommendations.",
        isActive: true,
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const winLoss = (
      await ctx.db
        .query("winLossRecords")
        .withIndex("by_dealId", (q) => q.eq("dealId", northstarDealId))
        .take(10)
    ).find((row) => row.competitorId === competitorId);
    if (!winLoss) {
      await ctx.db.insert("winLossRecords", {
        orgId,
        dealId: northstarDealId,
        outcome: "lost",
        competitorId,
        primaryReason: "Existing spreadsheet workflow felt familiar",
        reasons: ["change_management", "spreadsheet_familiarity"],
        notes: "Re-engage after next planning cycle.",
        recordedBy: salesLeaderId,
        createdAt: now,
      });
    }

    const leadModel = (
      await ctx.db
        .query("leadScoringModels")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((model) => model.name === "Enterprise Intent Score");
    const leadModelId =
      leadModel?._id ??
      (await ctx.db.insert("leadScoringModels", {
        orgId,
        name: "Enterprise Intent Score",
        description: "Scores CRM contacts using ICP fit and buying signals.",
        rules: [
          { field: "title", operator: "contains", value: "CRO", points: 30 },
          { field: "employeeCount", operator: "gte", value: 250, points: 25 },
          { field: "engagement", operator: "gte", value: 2, points: 20 },
        ],
        thresholds: { hot: 70, warm: 45, cold: 0 },
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }));

    const leadScore = (
      await ctx.db
        .query("leadScores")
        .withIndex("by_contactId", (q) => q.eq("contactId", northstarContactId))
        .take(20)
    ).find((score) => score.modelId === leadModelId);
    if (!leadScore) {
      await ctx.db.insert("leadScores", {
        orgId,
        contactId: northstarContactId,
        modelId: leadModelId,
        score: 78,
        grade: "hot",
        breakdown: { title: 30, firmographics: 28, engagement: 20 },
        calculatedAt: now,
      });
    }

    const routingRule = (
      await ctx.db
        .query("routingRules")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((rule) => rule.name === "Enterprise Round Robin");
    if (!routingRule) {
      await ctx.db.insert("routingRules", {
        orgId,
        name: "Enterprise Round Robin",
        method: "round_robin",
        assignees: [
          { userId: aeWestId, weight: 1 },
          { userId: aeEastId, weight: 1 },
        ],
        criteria: { grade: "hot" },
        slaMinutes: 30,
        isActive: true,
        lastAssignedIndex: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const abmList = (
      await ctx.db
        .query("abmLists")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((list) => list.name === "Tier 1 Enterprise Expansion");
    const abmListId =
      abmList?._id ??
      (await ctx.db.insert("abmLists", {
        orgId,
        name: "Tier 1 Enterprise Expansion",
        description: "Highest-fit accounts for founder-led executive outreach.",
        tier: "tier_1",
        status: "active",
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      }));

    const abmAccount = (
      await ctx.db
        .query("abmListAccounts")
        .withIndex("by_listId", (q) => q.eq("listId", abmListId))
        .take(20)
    ).find((row) => row.accountId === atlasId);
    if (!abmAccount) {
      await ctx.db.insert("abmListAccounts", {
        listId: abmListId,
        orgId,
        accountId: atlasId,
        engagementScore: 82,
        ownerId: aeWestId,
        status: "opportunity",
        notes: "CFO engaged after pricing workshop.",
        addedAt: now,
      });
    }

    const abmPlay = (
      await ctx.db
        .query("abmPlays")
        .withIndex("by_listId", (q) => q.eq("listId", abmListId))
        .take(20)
    ).find((play) => play.name === "Executive Mutual Plan");
    if (!abmPlay) {
      await ctx.db.insert("abmPlays", {
        orgId,
        listId: abmListId,
        name: "Executive Mutual Plan",
        description: "Multi-touch sequence for target account buying committees.",
        steps: [
          { order: 1, channel: "email", action: "Send CFO benchmark brief", owner: "AE", daysAfterStart: 0 },
          { order: 2, channel: "linkedin", action: "Founder connection request", owner: "Founder", daysAfterStart: 2 },
          { order: 3, channel: "call", action: "Mutual action plan review", owner: "AE", daysAfterStart: 7 },
        ],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const healthConfig = (
      await ctx.db
        .query("customerHealthConfigs")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .take(20)
    ).find((row) => row.name === "B2B SaaS Customer Health");
    const healthConfigId =
      healthConfig?._id ??
      (await ctx.db.insert("customerHealthConfigs", {
        orgId,
        name: "B2B SaaS Customer Health",
        signals: [
          { name: "Executive engagement", source: "crm", weight: 30, goodThreshold: 70, badThreshold: 30 },
          { name: "Expansion pipeline", source: "deals", weight: 40, goodThreshold: 60, badThreshold: 20 },
          { name: "Support risk", source: "manual", weight: 30, goodThreshold: 80, badThreshold: 40 },
        ],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }));
    const healthScore = (
      await ctx.db
        .query("customerHealthScores")
        .withIndex("by_accountId", (q) => q.eq("accountId", brightlineId))
        .take(20)
    ).find((score) => score.configId === healthConfigId);
    if (!healthScore) {
      await ctx.db.insert("customerHealthScores", {
        orgId,
        accountId: brightlineId,
        configId: healthConfigId,
        overallScore: 83,
        health: "healthy",
        signalBreakdown: { engagement: 85, expansion: 78, risk: 90 },
        arrAmount: cents(210_000),
        renewalDate: daysFrom(now, 220),
        expansionPotential: "high",
        lastCalculatedAt: now,
        createdAt: now,
      });
    }

    return {
      orgId,
      userId: adminId,
      seededAt: now,
    };
  },
});

/** The TAM size real imports target; the local stack seeds this many synthetic accounts. */
const TAM_SEED_SIZE = 10_000;
const DEMO_BUYERS: Array<[string, string, string]> = [
  ["sales_distribution/wholesale_distributor", "Wholesale distributors", "Run large outside-sales teams paid on commission."],
  ["staffing_hr/staffing_agency", "Staffing agencies", "Recruiters are paid per placement."],
  ["sales_distribution/manufacturers_rep", "Manufacturers' reps", "Commission-only sales organizations."],
  ["staffing_hr/peo_payroll_services", "PEOs & payroll providers", "Administer pay plans for client companies."],
];

const DEMO_JOBS = [
  "calculate sales commissions",
  "set quotas and territories",
  "forecast the sales pipeline",
  "pay commission-only outside reps",
  "track recruiter placement fees",
];

/** TAM rows for the demo CRM accounts, so the revenue run's CRM pass has matches. */
const CRM_TWINS = [
  { domain: "atlascloud.example", name: "Atlas Cloud", industry: "computer software", employees: 420, country: "united states" },
  { domain: "northstardata.example", name: "Northstar Data", industry: "computer software", employees: 160, country: "united states" },
  { domain: "brightlinerobotics.example", name: "Brightline Robotics", industry: "industrial automation", employees: 900, country: "united states" },
];

const DEV_ICP = heuristicIcp("fullstackgtm.demo");

/** Local stack only: a claimed research session with buyer segments, for the TAM explorer's jobs-to-be-done level. */
export const seedTamSession = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("researchSessions")
      .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", args.orgId))
      .first();
    if (existing) return null;
    const now = Date.now();
    const seg = ([archetype, label, why]: [string, string, string], i: number) => ({
      archetype, label, group: archetype.split("/")[0], kind: "buyer" as const, score: 0.9 - i * 0.1, why, pdlIndustries: [], estCount: null,
    });
    await ctx.db.insert("researchSessions", {
      token: `dev-tam-${now}`,
      domain: "fullstackgtm.demo",
      status: "ready",
      icp: DEV_ICP,
      marketSegments: { buyers: DEMO_BUYERS.map(seg), adjacent: [], horizontal: false, jobs: DEMO_JOBS },
      claimedByOrgId: args.orgId,
      claimedAt: now,
      importStatus: "done",
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const devOrgId = internalMutation({
  args: {},
  handler: async (ctx) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID))
      .first();
    return org?._id ?? null;
  },
});

/**
 * Local stack only: create the demo org's workspace in the record service.
 * The real service answers 404 for an unprovisioned workspace; the fake does not.
 */
export const provisionRecords = internalAction({
  args: {},
  handler: async (ctx): Promise<{ created: boolean; mode: "http" | "fake" }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const client = clientFor(ctx);
    const { created } = await client.provision(orgId);
    // A small scored register: the demo ICP is stored before the rows land, so each fit is explainable.
    // A workspace with active saved ICPs scores through them (their gates); a fresh one with the dev ICP.
    await ctx.runMutation(internal.devSeed.seedTamSession, { orgId });
    await rescoreOrg(ctx, orgId);
    await client.upsertAccounts(orgId, { records: CRM_TWINS, source: "dev-seed", idempotencyKey: "dev-twins" });
    return { created, mode: client.mode };
  },
});

/**
 * Local stack only: load the synthetic PDL fixture into the demo workspace so
 * the TAM explorer has realistic volume (`convex run devSeed:seedTam`).
 */
export const seedTam = internalAction({
  args: {},
  handler: async (ctx): Promise<{ accounts: number }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const client = clientFor(ctx);
    await client.provision(orgId);
    // Store the session's ICP before the rows land, so they are scored (and explainable) like a claimed workspace.
    // A workspace with active saved ICPs scores through them (their gates); a fresh one with the dev ICP.
    await ctx.runMutation(internal.devSeed.seedTamSession, { orgId });
    await rescoreOrg(ctx, orgId);
    const records = [...generatePdlSample(TAM_SEED_SIZE).map(pdlToAccountInput), ...CRM_TWINS];
    for (let i = 0; i < records.length; i += 500) {
      await client.upsertAccounts(orgId, { records: records.slice(i, i + 500), source: "dev-seed", idempotencyKey: `dev-tam-${i}` });
    }
    return { accounts: records.length };
  },
});

/**
 * Local stack only: a finished Market fill held for review, built from
 * synthetic people through the real staging path (no data source is called).
 * Two of its companies are the demo CRM's, so the review shows records already
 * in the CRM (`convex run devSeed:seedStagedRun`).
 */
export const seedStagedRun = internalAction({
  args: { people: v.optional(v.number()) },
  handler: async (ctx, a): Promise<{ jobId: Id<"backgroundJobs"> }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const jobId = await startPopulation(ctx, undefined, orgId, [], { title: "Add a market", detail: "Seeded" }, { stage: true });
    const titles = ["VP Sales", "Head of Marketing", "Chief Revenue Officer", "Director of RevOps", "Sales Manager", "Account Executive", "CFO", "Founder & CEO"];
    const companies = [
      { domain: "atlascloud.example", name: "Atlas Cloud", industry: "Software", employees: 420, country: "United States" },
      { domain: "northstardata.example", name: "Northstar Data", industry: "Software", employees: 1800, country: "United States" },
      ...Array.from({ length: 40 }, (_, i) => ({
        domain: `staged${i}.example`, ...(i % 5 ? { name: `Staged ${i}` } : {}), industry: ["Software", "Fintech", "Healthcare"][i % 3],
        employees: [30, 150, 700, 4000][i % 4], country: ["United States", "Germany", "United Kingdom", "Brazil"][i % 4],
      })),
    ];
    // The first page knows only each company's domain and name, as some sources do; later pages fill in the rest.
    const people: Person[] = Array.from({ length: a.people ?? 300 }, (_, i) => {
      const company = companies[i % companies.length];
      return {
        fullName: `Person ${i}`, title: titles[i % titles.length], linkedinUrl: `https://www.linkedin.com/in/staged-person-${i}`,
        company: i < 100 ? { domain: company.domain, ...(company.name ? { name: company.name } : {}) } : company,
      };
    });
    for (let i = 0; i < people.length; i += 100) {
      const recs = peopleToRecords(people.slice(i, i + 100));
      const guessed = new Set(recs.derivedNames);
      await stagePage(ctx, orgId, jobId, "quickenrich", recs.accounts.map((acc) => ({ ...acc, nameGuessed: guessed.has(acc.domain) })), recs.contacts);
    }
    await ctx.runMutation(internal.populateActions.finishJob, { jobId });
    return { jobId };
  },
});

/** Local stack only: accept a changed ICP weight set for the demo org, as a new ICP version (icpVersions.ts). */
export const acceptIcpVersion = action({
  args: { weights: icpVersionWeightsValidator },
  handler: async (ctx, args): Promise<{ rescored: number }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    await ctx.runMutation(internal.fitReconciler.setFallback, { orgId, weights: args.weights });
    return rescoreOrg(ctx, orgId);
  },
});

/**
 * Local stack only: four daily checks of Atlas Cloud's board through the real save path, so its account
 * page shows a signal history (a quote change, a role that closed and reopened) without reading a real board.
 */
export const seedSignalHistory = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    if (!org) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const role = (title: string, quote: string, id: number, postedDaysAgo: number) => ({
      trigger: `hiring: ${title}`, quote, sourceUrl: `https://boards.greenhouse.io/atlascloud/jobs/${id}`, source: "greenhouse" as const, observedAt: now - postedDaysAgo * DAY_MS,
    });
    const growth = role("head of growth", "Own pipeline generation across outbound and paid.", 101, 22);
    const growthV2 = { ...growth, quote: "Own pipeline generation and build a team of four SDRs." };
    const checks = [
      { daysAgo: 20, signals: [growth, role("revops manager", "Run our Salesforce and HubSpot stack.", 102, 21)] },
      { daysAgo: 12, signals: [growthV2, role("revops manager", "Run our Salesforce and HubSpot stack.", 102, 21)] },
      { daysAgo: 5, signals: [growthV2] },
      { daysAgo: 1, signals: [growthV2, role("revops manager", "Own the GTM systems roadmap.", 117, 2)] },
    ];
    for (const check of checks) await applyAccount(ctx, org._id, { domain: "atlascloud.example", signals: check.signals }, now - check.daysAgo * DAY_MS);
    return null;
  },
});

/** Local stack only: a stand-in linked Gmail account for the dev user. Its sends are recorded and never leave Canon (emailActions.ts). */
export const seedGmailAccount = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const existing = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", "local-gmail")).first();
    if (existing) return existing._id;
    const now = Date.now();
    return ctx.db.insert("emailAccounts", {
      orgId: org._id, userId: user._id, unipileAccountId: "local-gmail", provider: "google", address: "dev@local.test",
      displayName: "Local stand-in", status: "ok", connectedAt: now, updatedAt: now,
    });
  },
});

/**
 * Local stack only: the dev user's stand-in Gmail account reading its mail, and a logging address with `token`, so
 * conversations.storeLogged (what /email-log/* stores) and conversations.storeEmail (what inbox sync stores) can be
 * run on one thread to see them meet. A local stack has no EMAIL_LOG_DOMAIN, so the endpoints themselves are off.
 */
export const seedEmailLogging = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    const inbox = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", "local-gmail")).first();
    if (!user || !inbox) throw new ConvexError("Run devSeed:ensureWorkspace and devSeed:seedGmailAccount first");
    const now = Date.now();
    await ctx.db.patch(inbox._id, { ingest: true, ingestConsentAt: now, ingestBackfilledAt: now, ingestSyncedAt: now, updatedAt: now });
    if (!(await ctx.db.query("emailLogAddresses").withIndex("by_token", (q) => q.eq("token", args.token)).first())) {
      await ctx.db.insert("emailLogAddresses", { orgId: user.orgId, userId: user._id, token: args.token, createdAt: now });
    }
    return { inboxId: inbox._id, userId: user._id, address: inbox.address };
  },
});

/**
 * Local stack only: the calendar transport's stand-in (docs/calendar-meetings.md). Fixture events for the dev user go
 * through calendarEvents.ingest, the path a real calendar will use: a meeting tomorrow with `attendee` (a Canon
 * person's email) and an unknown colleague of theirs, the same meeting moved an hour later, an internal one, a
 * private one, and a weekly series' instances from 100 days back to 40 ahead. Returns what each came to.
 */
export const seedCalendarEvents = action({
  args: { attendee: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const seeded: { orgId: Id<"organizations">; userId: Id<"users">; email: string } = await ctx.runMutation(internal.devSeed.devCalendarOwner, {});
    const HOUR = 3_600_000;
    const day = Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR;
    const domain = args.attendee.split("@")[1] ?? "example.org";
    const event = (uid: string, start: number, extra: Record<string, unknown> = {}) => ({
      icalUid: uid, instanceStart: start, title: "Pilot review", startAt: start, endAt: start + HOUR, allDay: false, cancelled: false,
      visibility: "default" as const, eventType: "default",
      attendees: [
        { email: seeded.email, response: "accepted" as const },
        { email: args.attendee, response: "accepted" as const },
        { email: `new.colleague@${domain}`, name: "New Colleague", response: "pending" as const },
      ],
      ...extra,
    });
    const tomorrow = day + 24 * HOUR + 15 * HOUR;
    const weekly = Array.from({ length: 20 }, (_, i) => day - 100 * 24 * HOUR + i * 7 * 24 * HOUR + 16 * HOUR)
      .map((at) => event("local-weekly-sync", at, { title: "Weekly sync" }));
    return ctx.runAction(internal.calendarEvents.ingest, {
      orgId: seeded.orgId, userId: seeded.userId, memberEmail: seeded.email,
      events: [
        event("local-pilot-review", tomorrow),
        event("local-pilot-review", tomorrow, { startAt: tomorrow + HOUR, endAt: tomorrow + 2 * HOUR }),
        event("local-internal", tomorrow + 3 * HOUR, { title: "Team standup", attendees: [{ email: seeded.email, response: "accepted" }] }),
        event("local-private", tomorrow + 5 * HOUR, { title: "Doctor", visibility: "private" }),
        ...weekly,
      ],
    });
  },
});

export const devCalendarOwner = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    return { orgId: user.orgId, userId: user._id, email: user.email };
  },
});

/** Local-only legacy data for proving the read-only DNC rollout against an actual backend. */
export const seedSuppressionLegacy = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const ids = [];
    for (const number of ["+14155550198", "+14155550199"]) {
      const row = await ctx.db.query("dialerDoNotCall").withIndex("by_orgId_and_number", (q) => q.eq("orgId", org._id).eq("number", number)).first();
      ids.push(row?._id ?? await ctx.db.insert("dialerDoNotCall", {
        orgId: org._id, number, addedBy: user._id, addedAt: 1_700_000_000_000,
        reason: "Local suppression rollout fixture", contactId: "local-suppression-fixture",
      }));
    }
    return { orgId: org._id, ids };
  },
});

/**
 * Local stack only: a paused LinkedIn sender, a three-step cadence and one contact (its register id) enrolled
 * in it, then the worker's `finish` for a cadence run, to fill the contact's timeline without Unipile.
 */
export const seedLinkedinEnrollment = mutation({
  args: { contactId: v.string(), contactName: v.string() },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const accountId = await ctx.db.insert("linkedinAccounts", {
      orgId: org._id, userId: user._id, unipileAccountId: "local-demo", status: "paused", tier: "premium", timezone: "UTC",
      window: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 }, overrides: {}, rampStep: 0, rampAdvancedAt: now,
      riskAcceptedAt: now, riskTextVersion: "local", connectedAt: now, updatedAt: now,
    });
    const cadenceId = await ctx.db.insert("linkedinCadences", {
      orgId: org._id, name: "Q4 founders", senderAccountId: accountId, status: "active", createdBy: user._id, createdAt: now, updatedAt: now,
      steps: [
        { kind: "invite", note: "Hi {{first_name}}, saw your talk on pipeline hygiene." },
        { kind: "message", body: "Thanks for connecting, {{first_name}}. Worth comparing notes on CRM cleanup?", delayDays: 2 },
        { kind: "message", body: "Following up once, {{first_name}}.", delayDays: 4 },
      ],
    });
    const enrollmentId = await ctx.db.insert("linkedinEnrollments", {
      orgId: org._id, cadenceId, senderAccountId: accountId, contactId: args.contactId, contactName: args.contactName,
      linkedinUrl: "https://www.linkedin.com/in/local-demo", publicIdentifier: "local-demo", vars: {}, state: "queued", stepIndex: 0,
      nextAt: now, enrolledBy: user._id, enrolledAt: now, updatedAt: now,
    });
    // The worker's own finish, a few seconds apart: invite (delivered twice), acceptance, first message, reply.
    const id = enrollmentId;
    const runs = [
      { sends: [{ kind: "invite" as const, ok: true, enrollmentId: id }], events: [{ event: "invited" as const, id, providerId: "local-demo" }], rendered: { enrollmentId: id, cadenceId, step: 0, text: "Hi Sam, saw your talk on pipeline hygiene." } },
      { sends: [{ kind: "invite" as const, ok: true, enrollmentId: id }], events: [{ event: "invited" as const, id, providerId: "local-demo" }], rendered: { enrollmentId: id, cadenceId, step: 0, text: "Hi Sam, saw your talk on pipeline hygiene." } },
      { sends: [{ kind: "sync" as const, ok: true }], events: [{ event: "connected" as const, id, accepted: true }] },
      { sends: [{ kind: "message" as const, ok: true, enrollmentId: id }], events: [{ event: "sent" as const, id, chatId: "local-chat" }], rendered: { enrollmentId: id, cadenceId, step: 1, text: "Thanks for connecting, Sam. Worth comparing notes on CRM cleanup?" } },
      { sends: [], events: [{ event: "replied" as const, id }] },
    ];
    for (const [i, run] of runs.entries()) await ctx.scheduler.runAfter(i * 2000, internal.linkedinWorker.finish, { accountId, effect: null, ...run });
    return { accountId, cadenceId, enrollmentId };
  },
});

/** Local stack only: about 60 people across five weeks in the newest LinkedIn cadence, so its funnel and acceptance charts have data. */
export const seedLinkedinFunnel = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const cadence = await ctx.db.query("linkedinCadences").order("desc").first();
    if (!cadence) throw new ConvexError("Run devSeed:seedLinkedinEnrollment first");
    const now = Date.now();
    const DAY = 86_400_000;
    let n = 0;
    for (let i = 0; i < 60; i++) {
      // A fixed pseudo-random spread: invites over 35 days, about half accepted, mostly within 3 days, at business hours.
      const r = (k: number) => ((i * 9301 + k * 49297) % 233280) / 233280;
      const invitedAt = now - Math.floor(r(1) * 35 * DAY);
      const accepts = r(2) < 0.5 && i % 7 !== 0;
      const lag = (r(3) < 0.6 ? r(4) * 2 : 2 + r(4) * 10) * DAY;
      const acceptedAt = accepts && invitedAt + lag < now ? invitedAt + lag - ((invitedAt + lag) % DAY) + (13 + Math.floor(r(5) * 9)) * 3_600_000 : undefined;
      const accepted = acceptedAt !== undefined && acceptedAt < now;
      const state = i % 7 === 0 ? "queued" : accepted ? (r(6) < 0.2 ? "replied" : "connected") : now - invitedAt > 21 * DAY ? "withdrawn" : "invited";
      await ctx.db.insert("linkedinEnrollments", {
        orgId: cadence.orgId, cadenceId: cadence._id, senderAccountId: cadence.senderAccountId,
        contactId: `seed-funnel-${i}`, contactName: `Funnel Person ${i}`, linkedinUrl: `https://www.linkedin.com/in/seed-funnel-${i}`,
        publicIdentifier: `seed-funnel-${i}`, vars: {}, state, stepIndex: state === "queued" ? 0 : 1, nextAt: now + DAY,
        ...(state === "queued" ? {} : { invitedAt }),
        ...(accepted ? { connectedAt: acceptedAt + 2 * 3_600_000, ...(i % 5 === 0 ? {} : { acceptedAt }), ...(state === "replied" ? { lastSentAt: acceptedAt + DAY } : {}) } : {}),
        enrolledBy: cadence.createdBy, enrolledAt: invitedAt - DAY, updatedAt: now,
      });
      n++;
    }
    return { cadenceId: cadence._id, inserted: n };
  },
});

/** Local deal prospects: the Northstar deal's people, two saved ICPs with a point of view each, and research notes on five. */
const PROSPECT_ICPS = [
  {
    name: "Revenue leaders", isDefault: true, titles: ["VP Revenue", "Head of Revenue Operations", "Chief Revenue Officer"],
    pointOfView: "Revenue teams don't lose deals to bad reps; they lose them to a CRM nobody trusts, so forecasts get rebuilt by hand every Friday.",
    offer: "A free audit of their CRM's duplicate and stale records",
  },
  {
    name: "Data platform leaders", isDefault: false, titles: ["VP Engineering", "Head of Data", "Director of Data Engineering"],
    pointOfView: "Data teams end up owning CRM pipelines they never chose, and every sync breaks on fields sales renamed last quarter.",
    offer: "A map of which CRM fields their warehouse syncs actually read",
  },
];
/** Seeded people research answers (goal, systems): what the deal page's research columns show without a live run. */
type SeedAnswers = { still_at_company: boolean; primary_goal: string; responsible_systems: string };
const PROSPECTS: Array<{ fullName: string; title: string; persona?: string; angle?: string; confidence?: "high" | "medium" | "low"; answers?: SeedAnswers }> = [
  { fullName: "Priya Raman", title: "VP Revenue Operations", persona: "Owns forecasting and the CRM since the Series B; reports to the CRO.", angle: "Posted about rebuilding the Q3 forecast by hand after a pipeline field migration.", confidence: "high",
    answers: { still_at_company: true, primary_goal: "Rebuild forecasting on Salesforce after the HubSpot migration, with a new pipeline process for the growing sales team.", responsible_systems: "Salesforce (owner after the migration), HubSpot (being retired), Clari for forecasting." } },
  { fullName: "Dana Whitfield", title: "Chief Revenue Officer", persona: "Joined from Snowflake in May to scale the sales team from 12 to 30 reps.", angle: "Said on a podcast that clean pipeline data is her first-year priority.", confidence: "medium",
    answers: { still_at_company: true, primary_goal: "Scale the sales team from 12 to 30 reps this year while keeping the forecast within 5%.", responsible_systems: "Salesforce and Gong through her RevOps team; no system she runs herself." } },
  { fullName: "Marcus Hale", title: "Head of Revenue Operations", persona: "Runs the HubSpot to Salesforce move announced on the careers page.", confidence: "medium" },
  { fullName: "Ines Duarte", title: "Head of Data", persona: "Owns the warehouse and the reverse-ETL syncs into the CRM.", angle: "Hiring a data engineer to 'own GTM data quality', per a job post from last month.", confidence: "high",
    answers: { still_at_company: true, primary_goal: "Keep the warehouse and its syncs into the CRM reliable and compliant while the sales stack changes.", responsible_systems: "Snowflake, dbt, Hightouch reverse-ETL into Salesforce." } },
  { fullName: "Leo Park", title: "VP Engineering", angle: "Wrote an engineering blog post on retiring brittle internal sync jobs.", confidence: "low" },
  { fullName: "Chris Okafor", title: "Director of Data Engineering",
    answers: { still_at_company: false, primary_goal: "Keep pipelines running and on-call load down; owns uptime for the data platform.", responsible_systems: "Airflow, Snowflake, Fivetran." } },
  { fullName: "Ava Lindqvist", title: "Account Executive" },
  { fullName: "Jordan Bell", title: "Marketing Coordinator" },
];

/**
 * Local stack only: a deal on finding the way in with people to choose from (`convex run devSeed:seedDealProspects`).
 * Links the Northstar deal to its company, adds eight people there, two saved ICPs whose buyers six of them match,
 * research notes on five, and goal and systems answers for four, so the deal page's ICP filter, ranking, people research
 * columns and drafts have something to work on.
 */
export const seedDealProspects = internalAction({
  args: {},
  handler: async (ctx): Promise<{ streamId: string; contacts: number }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const client = clientFor(ctx);
    await client.provision(orgId);
    const northstar = CRM_TWINS.find((a) => a.domain === "northstardata.example")!;
    const account = await client.upsertAccounts(orgId, { records: [northstar], source: "dev-seed", idempotencyKey: "dev-deal-prospects-account" });
    const accountId = account.ids[0];
    if (!accountId) throw new ConvexError("The record service did not return the Northstar account");
    const contacts = await client.upsertContacts(orgId, {
      records: PROSPECTS.map((p) => ({
        accountId, fullName: p.fullName, title: p.title,
        email: `${p.fullName.toLowerCase().replace(/ /g, ".")}@${northstar.domain}`,
        linkedinUrl: `https://www.linkedin.com/in/${p.fullName.toLowerCase().replace(/ /g, "-")}-example`,
      })),
      source: "dev-seed", idempotencyKey: "dev-deal-prospects-contacts",
    });
    const anchored = await promoteContacts(ctx, client, orgId, contacts.ids.filter(Boolean));
    const entityOf = new Map(anchored.map((a) => [a.recordId, a.entityId]));
    const streamId: string = await ctx.runMutation(internal.devSeed.seedDealProspectsDb, {
      orgId, accountId,
      answers: PROSPECTS.flatMap((p, i) => {
        const entityId = contacts.ids[i] ? entityOf.get(contacts.ids[i]) : undefined;
        return entityId && p.answers ? SEED_PEOPLE.fields.map((f) => ({ entityId, slug: f.slug, value: p.answers![f.slug as keyof SeedAnswers] })) : [];
      }),
      people: PROSPECTS.flatMap((p, i) => contacts.ids[i] && (p.persona || p.angle) ? [{ contactId: contacts.ids[i], persona: p.persona, angle: p.angle, confidence: p.confidence }] : []),
    });
    // ICP membership needs a matching buyer at the account, so score after the people land.
    await rescoreOrg(ctx, orgId);
    return { streamId, contacts: contacts.ids.length };
  },
});

export const seedDealProspectsDb = internalMutation({
  args: {
    orgId: v.id("organizations"), accountId: v.string(),
    answers: v.array(v.object({ entityId: v.id("canonEntities"), slug: v.string(), value: v.union(v.string(), v.boolean()) })),
    people: v.array(v.object({ contactId: v.string(), persona: v.optional(v.string()), angle: v.optional(v.string()), confidence: v.optional(v.union(v.literal("high"), v.literal("medium"), v.literal("low"))) })),
  },
  handler: async (ctx, args): Promise<string> => {
    const now = Date.now();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).unique();
    if (!user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    await assertLegacyIcpsWritable(ctx, args.orgId);
    const icps = await ctx.db.query("icps").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).collect();
    for (const icp of PROSPECT_ICPS) {
      if (icps.some((i) => i.name === icp.name)) continue;
      const spec = emptySpec();
      await ctx.db.insert("icps", {
        orgId: args.orgId, name: icp.name, spec: { ...spec, persona: { ...spec.persona, titles: icp.titles } }, active: true,
        isDefault: icp.isDefault && !icps.some((i) => i.isDefault), source: "manual", pointOfView: icp.pointOfView, offer: icp.offer,
        createdBy: user._id, createdAt: now, updatedAt: now,
      });
      await invalidateFit(ctx, args.orgId);
    }
    // The people fields and accepted answers for some of the people, as a research run would have left them.
    const fsgtm = RECIPES["fsgtm-enterprise-deal"];
    for (const spec of SEED_PEOPLE.fields) await peopleField(ctx, user, { recipe: fsgtm, pkg: null }, fsgtm.settings, spec, SEED_PEOPLE.refresh);
    for (const a of args.answers) {
      const attribute = attributeFor(a.slug);
      const has = await ctx.db.query("facts").withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", a.entityId).eq("attribute", attribute)).first();
      if (has) continue;
      await ctx.db.insert("facts", {
        orgId: args.orgId, entityType: "contact", entityId: a.entityId, attribute, value: a.value, sourceKind: "agent_run", sourceRef: "dev-seed:people-research",
        actor: { kind: "agent", id: "dev-seed" }, evidence: `${typeof a.value === "boolean" ? (a.value ? "Lists Northstar Data as their current role." : "Moved to Acme Analytics as Head of Data Platform in August.") : a.value}\n\nSource: https://example.com/dev-seed`, confidence: 0.9,
        observedAt: now, lastConfirmedAt: now, status: "accepted", decidedBy: "dev-seed", decidedAt: now,
      });
    }
    const deal = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", "demo-deal-northstar-new")).first();
    if (!deal) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", args.orgId).eq("projectionId", deal._id)).first();
    if (!entity) throw new ConvexError("The Northstar deal has no record stream yet");
    if (deal.companyId !== args.accountId) {
      const saved = await saveDealAsCaller(ctx, user, entity._id, { companyId: args.accountId });
      if (saved.status !== "applied") throw new ConvexError(`Linking the deal to Northstar failed: ${JSON.stringify(saved)}`);
    }
    const existing = await ctx.db.query("dealPlays").withIndex("by_orgId_and_streamId", (q) => q.eq("orgId", args.orgId).eq("streamId", entity._id)).first();
    const playId = existing?._id ?? await ctx.db.insert("dealPlays", { orgId: args.orgId, dealId: deal._id, streamId: entity._id, createdBy: user._id, createdAt: now, updatedAt: now });
    if (!existing) {
      await ctx.db.patch(playId, {
        context: "Canon keeps a CRM clean on its own: it finds duplicates, stale fields and missing people, and fixes them with evidence.",
        whyNow: "Northstar is moving from HubSpot to Salesforce this quarter and hiring for GTM data quality.", briefBy: "user",
      });
    }
    for (const p of args.people) {
      const row = await ctx.db.query("dealPlayPeople").withIndex("by_playId_and_contactId", (q) => q.eq("playId", playId).eq("contactId", p.contactId)).unique();
      const notes = { persona: p.persona, angle: p.angle, confidence: p.confidence, origin: "research" as const, updatedAt: now };
      if (row) await ctx.db.patch(row._id, notes);
      else await ctx.db.insert("dealPlayPeople", { orgId: args.orgId, playId, contactId: p.contactId, ...notes });
    }
    return entity._id;
  },
});

/**
 * Local stack only: a month of credit activity for Settings -> Billing's usage chart (#427): a pack bought
 * on the 2nd, research and paid-search spend most days (the free allowance first), and one hold still pending.
 */
export const seedCreditUsage = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    if (!org) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const start = new Date(now);
    const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const month = start.toISOString().slice(0, 7);
    let paid = 0;
    let freeLeft = FREE_CREDITS_PER_MONTH * MICRO;
    const row = async (at: number, kind: "purchase" | "spend", credits: number, note: string, pending = false) => {
      const amountMicro = Math.round(credits * MICRO);
      const freeMicro = kind === "spend" ? Math.min(freeLeft, -amountMicro) : 0;
      freeLeft -= freeMicro;
      paid += amountMicro + freeMicro;
      await ctx.db.insert("creditLedger", {
        orgId: org._id, kind, amountMicro, unit: "credits", balanceAfterMicro: paid, ref: `dev-usage-${at}-${note}`, note, at,
        ...(kind === "spend" ? { freeMicro, pending } : {}),
      });
    };
    for (let d = 0; first + d * DAY_MS <= now; d++) {
      const day = first + d * DAY_MS;
      if (d === 1) await row(day + 9 * 3_600_000, "purchase", 500, "Bought 500 credits");
      if (d % 3 === 2) continue;
      for (let k = 0; k < 1 + (d % 4); k++) await row(Math.min(now, day + (10 + k) * 3_600_000), "spend", -(3 + ((d * 7 + k * 5) % 11)), k % 2 ? "Paid search: Prospeo emails" : "Account research: Atlas Cloud", d === start.getUTCDate() - 1 && k === 0);
    }
    await ctx.db.patch(org._id, { creditBalanceMicro: paid, creditUnit: "credits", freeCreditsMonth: month, freeCreditsUsedMicro: FREE_CREDITS_PER_MONTH * MICRO - freeLeft });
    return null;
  },
});

/**
 * Local stack only: install a markdown-only package into the demo workspace from a recipe.md served on this machine,
 * checked and stored as an install from GitHub stores it. A local backend reads no GitHub fixture, so this stands in:
 *   (cd recipes/fsgtm-velocity-deal && python3 -m http.server 4799 --bind 127.0.0.1) &
 *   convex run devSeed:installLocalPackage '{"url": "http://127.0.0.1:4799/recipe.md"}'
 */
export const installLocalPackage = internalAction({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<{ recipeId: string; version: string }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(args.url)) throw new ConvexError("Serve the customization.md on 127.0.0.1");
    const res = await fetch(args.url);
    if (!res.ok) throw new ConvexError(`${args.url} answered ${res.status}`);
    const pkg = await checkPackage(await res.text(), null);
    const storageId = await ctx.storage.store(new Blob([pkg.code], { type: "text/javascript" }));
    const { id: recipeId, version } = pkg.manifest;
    await ctx.runMutation(internal.devSeed.storeLocalPackage, { recipeId, version, manifest: pkg.manifestText, bundleHash: pkg.hash, storageId });
    return { recipeId, version };
  },
});

/**
 * Local stack only: Customize `recipeId` with the recipe.md served at `url` as its source text, as the Recipes page's
 * Customize would. A package installLocalPackage stored has no GitHub commit to fetch again, and an older recipe.md
 * here makes a copy whose upstream has since changed (docs/recipes.md, "Upstream updates").
 *   convex run devSeed:customizeLocal '{"recipeId": "@fsgtm/velocity-deal", "url": "http://127.0.0.1:4799/recipe.md"}'
 */
export const customizeLocal = internalAction({
  args: { recipeId: v.string(), url: v.string() },
  handler: async (ctx, args): Promise<{ recipeId: string }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(args.url)) throw new ConvexError("Serve the customization.md on 127.0.0.1");
    const res = await fetch(args.url);
    if (!res.ok) throw new ConvexError(`${args.url} answered ${res.status}`);
    return copyOf(ctx, { recipeId: args.recipeId }, await res.text());
  },
});

export const storeLocalPackage = internalMutation({
  args: { recipeId: v.string(), version: v.string(), manifest: v.string(), bundleHash: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Seed the demo workspace first");
    const source = { kind: "github-public" as const, owner: "local", repo: "recipes", path: args.recipeId.split("/")[1], ref: `v${args.version}`, sha: args.bundleHash.slice(0, 40) };
    const fields = { source, version: args.version, manifest: args.manifest, bundleHash: args.bundleHash, bundleStorageId: args.storageId, installedBy: user._id, installedAt: Date.now(), status: "installed" as const };
    const fitBefore = JSON.stringify(await modelSettings(ctx, org._id, "scoring.fit"));
    const row = await ctx.db.query("recipePackages").withIndex("by_orgId_and_recipeId", (q) => q.eq("orgId", org._id).eq("recipeId", args.recipeId)).unique();
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("recipePackages", { orgId: org._id, recipeId: args.recipeId, ...fields });
    if (JSON.stringify(await modelSettings(ctx, org._id, "scoring.fit")) !== fitBefore) await invalidateFit(ctx, org._id);
    return null;
  },
});

/** The pacing history `seedPacing` writes: 150 deals created over the last 18 months, won or lost once they close. */
function pacingDeals(reps: readonly Id<"users">[], now: number) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: 150 }, (_, i) => {
    const created = now - Math.floor(rand() * 540) * DAY_MS;
    let close = created + (20 + Math.floor(rand() * 70)) * DAY_MS;
    // Deals bunch at the end of the month, as they do in a real pipeline.
    const d = new Date(close);
    if (rand() < 0.4) close = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) - Math.floor(rand() * 3) * DAY_MS;
    const closed = close < now;
    const won = closed && rand() < 0.35;
    return {
      crmId: `demo-pacing-${i}`,
      name: `Pacing demo deal ${i + 1}`,
      amount: cents(5_000 + Math.round(rand() ** 1.5 * 60) * 1_000),
      created, closeDate: new Date(close).toISOString().slice(0, 10), closed, won,
      rep: reps[i % reps.length],
    };
  });
}

export const seedPacingBatch = internalMutation({
  args: { orgId: v.id("organizations"), from: v.number(), to: v.number() },
  handler: async (ctx, { orgId, from, to }) => {
    const reps = (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(20)).map((u) => u._id);
    const account = await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).first();
    if (!reps.length || !account) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    for (const d of pacingDeals(reps, now).slice(from, to)) {
      // `now` is the deal's created time: the ledger event lands then, as a sync of an older deal would.
      const dealId = await ensureDeal(ctx, {
        orgId, crmId: d.crmId, name: d.name, amount: d.amount, closeDate: d.closeDate,
        stage: d.won ? "Closed Won" : d.closed ? "Closed Lost" : "Proposal",
        forecastCategory: d.won ? "closed_won" : d.closed ? "closed_lost" : "pipeline",
        probability: d.won ? 1 : d.closed ? 0 : 0.4,
        primaryRepId: d.rep, accountId: account._id, isClosed: d.closed, isWon: d.won, now: d.created,
      });
      // A CRM sync does not carry the Canon owner; assign it as a person would, so pacing splits by rep.
      const row = await ctx.db.get(dealId);
      if (row) await saveDealValues(ctx, row, { kind: "user", userId: d.rep }, { ownerId: d.rep }, { now: d.created + 60_000 });
    }
    return null;
  },
});

/**
 * Local stack only: 18 months of deals for Reports pacing, so the running totals, past periods and targets have
 * history (`convex run devSeed:seedPacing`).
 */
export const seedPacing = internalAction({
  args: {},
  handler: async (ctx): Promise<{ deals: number }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    for (let i = 0; i < 150; i += 25) await ctx.runMutation(internal.devSeed.seedPacingBatch, { orgId, from: i, to: i + 25 });
    return { deals: 150 };
  },
});

/**
 * Local stack only: the Forecast module's fixture "Northwind" (docs/module-plans/forecast.md §12), so its goldens can
 * be checked live (`convex run devSeed:seedForecast`). Dana's tree joins the demo workspace beside its members, with
 * Q4 2026 targets, and the eight deals' changes land in the ledger on their own dates, so the deal history reads
 * (What moved, risks) see them. A re-run sets the targets again and refuses the deals: their history is written once. Activities and calls are the
 * check's to log, as people do.
 */
export const seedForecast = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ users: Record<string, Id<"users">>; deals: Record<string, string> }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const account = org && await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", org._id)).first();
    if (!org || !account) throw new ConvexError("Run devSeed:ensureWorkspace first");
    return seedNorthwind(ctx, org._id, account._id, "dev_user_northwind_");
  },
});

/**
 * The Northwind fixture in one workspace: its six members (clerk ids `<prefix><key>`, never signed in), Q4 2026
 * targets, and the eight deals with their dated changes. Shared by the local seed and sample data (convex/sampleData.ts).
 */
export async function seedNorthwind(
  ctx: MutationCtx, orgId: Id<"organizations">, accountId: Id<"crmAccounts">, clerkPrefix: string,
): Promise<{ users: Record<string, Id<"users">>; deals: Record<string, string> }> {
    const org = { _id: orgId }, account = { _id: accountId };
    const seeded = !!await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", `${clerkPrefix}dana`)).first();
    const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
    const person = (key: string, name: string, role: "admin" | "manager" | "rep", title: string, managerId?: Id<"users">) => ensureUser(ctx, {
      orgId: org._id, clerkUserId: `${clerkPrefix}${key}`, email: `${key}@northwind.demo`, name, role, title, startDate: "2025-01-06", ...(managerId ? { managerId } : {}),
    });
    const dana = await person("dana", "Dana Okafor", "admin", "VP Sales");
    const mo = await person("mo", "Mo Haddad", "manager", "Sales Manager, East", dana);
    const lee = await person("lee", "Lee Park", "manager", "Sales Manager, West", dana);
    const ava = await person("ava", "Ava Lindqvist", "rep", "Account Executive", mo);
    const ben = await person("ben", "Ben Adeyemi", "rep", "Account Executive", mo);
    const cal = await person("cal", "Cal Moreno", "rep", "Account Executive", lee);
    // Q4 targets, a third in each month: Ava $300,000, Ben $200,000, Cal $250,000.
    const plan = await ctx.db.query("targetPlans").withIndex("by_orgId_and_year", (q) => q.eq("orgId", org._id).eq("year", 2026)).unique();
    if (plan) {
      const third = (total: number) => Math.floor(total / 3);
      const q4 = (total: number) => [0, 0, 0, 0, 0, 0, 0, 0, 0, third(total), third(total), total - 2 * third(total)].map((n) => cents(n));
      const fy = plan.fyStart ?? 1;
      const shift = (months: number[]) => months.map((_, i) => months[(i + fy - 1) % 12]);
      await ctx.db.patch(plan._id, {
        repMonths: { ...plan.repMonths, [ava]: shift(q4(300_000)), [ben]: shift(q4(200_000)), [cal]: shift(q4(250_000)) },
        repTeam: { ...plan.repTeam, [ava]: "none", [ben]: "none", [cal]: "none" },
      });
    }
    // The targets above are set again on a re-run; the deals' history is written once.
    if (seeded) return { users: { dana, mo, lee, ava, ben, cal }, deals: {} };
    type Open = { amount: number; closeDate: string; category: "pipeline" | "best_case" | "commit" };
    const deals: Array<{ key: string; name: string; owner: Id<"users">; created: string; start: Open; nextStep?: string; changes: Array<[string, Record<string, string | number | boolean>]> }> = [
      { key: "D1", name: "Acme", owner: ava, created: "2026-09-01", start: { amount: 120_000, closeDate: "2026-11-15", category: "commit" }, nextStep: "Security review on 10-20", changes: [] },
      { key: "D2", name: "Birch", owner: ava, created: "2026-09-01", start: { amount: 80_000, closeDate: "2026-11-20", category: "best_case" }, nextStep: "Pricing call",
        changes: [["2026-09-28", { closeDate: "2026-12-01" }], ["2026-10-03", { closeDate: "2026-12-10" }]] },
      { key: "D3", name: "Cobalt", owner: ava, created: "2026-09-01", start: { amount: 60_000, closeDate: "2026-10-30", category: "commit" }, nextStep: "Kickoff",
        changes: [["2026-10-08", { stage: "Closed Won", forecastCategory: "closed_won", isClosed: true, isWon: true }]] },
      { key: "D4", name: "Delta", owner: ben, created: "2026-09-01", start: { amount: 150_000, closeDate: "2026-12-20", category: "commit" }, nextStep: "Legal redlines",
        changes: [["2026-10-09", { closeDate: "2027-01-15" }]] },
      { key: "D5", name: "Echo", owner: ben, created: "2026-09-01", start: { amount: 50_000, closeDate: "2026-11-30", category: "pipeline" },
        changes: [["2026-10-10", { forecastCategory: "best_case" }]] },
      { key: "D6", name: "Fjord", owner: cal, created: "2026-09-01", start: { amount: 200_000, closeDate: "2026-12-05", category: "best_case" }, nextStep: "Order form",
        changes: [["2026-10-07", { forecastCategory: "commit", amount: cents(180_000) }]] },
      { key: "D7", name: "Grove", owner: cal, created: "2026-09-01", start: { amount: 90_000, closeDate: "2026-12-15", category: "pipeline" }, nextStep: "Demo",
        changes: [["2026-10-11", { stage: "Closed Lost", forecastCategory: "closed_lost", isClosed: true, isWon: false }]] },
      { key: "D8", name: "Harbor", owner: cal, created: "2026-10-08", start: { amount: 40_000, closeDate: "2026-12-01", category: "pipeline" }, nextStep: "Discovery", changes: [] },
    ];
    const out: Record<string, string> = {};
    for (const d of deals) {
      const created = at(d.created);
      const dealId = await ensureDeal(ctx, {
        orgId: org._id, crmId: `northwind-${d.key}`, name: `${d.key} ${d.name}`, amount: cents(d.start.amount), closeDate: d.start.closeDate,
        stage: "Proposal", forecastCategory: d.start.category, probability: 0.5, primaryRepId: d.owner, accountId: account._id, isClosed: false, isWon: false, now: created,
      });
      // As the pacing seed does: a sync doesn't carry the Canon owner, so the owner is set as a person would, with the next step.
      let row = await ctx.db.get(dealId);
      if (!row) continue;
      const set = await saveDealValues(ctx, row, { kind: "user", userId: d.owner }, { ownerId: d.owner, ...(d.nextStep ? { nextStep: d.nextStep } : {}) }, { now: created + 60_000 });
      out[d.key] = set.entityId;
      for (const [day, values] of d.changes) {
        row = await ctx.db.get(dealId);
        if (row) await saveDealValues(ctx, row, { kind: "user", userId: d.owner }, values, { now: at(day) });
      }
    }
    return { users: { dana, mo, lee, ava, ben, cal }, deals: out };
}

/**
 * Local stack only: the Customer success module's fixture "Acme Analytics" (docs/module-plans/customer-success.md
 * §12), so its Retention goldens can be checked live (`convex run devSeed:seedCustomerSuccess`). Six companies join the
 * record service, and Dana Ruiz (CSM) and Lee Park (her manager) the demo workspace, with the twelve deals of
 * `convex/lib/sampleAcme.ts`, each linked to its company and owned by Dana. A re-run writes
 * the same rows again.
 */
export const seedCustomerSuccess = internalAction({
  args: {},
  handler: async (ctx): Promise<{ companies: Record<string, string>; deals: number }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const orgId = await ctx.runMutation(internal.devSeed.devOrgId, {});
    if (!orgId) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const companies = await upsertAcmeCompanies(ctx, orgId, "dev-customer-success-companies");
    // A deal a mutation: each goes through the deal ledger twice, and the local backend gives a mutation a second.
    for (const d of ACME_DEALS) await ctx.runMutation(internal.devSeed.seedCustomerSuccessDb, { companies, deal: d.key });
    return { companies, deals: ACME_DEALS.length };
  },
});

/** The six Acme companies in a workspace's record service, by fixture key. Shared with sample data. */
export async function upsertAcmeCompanies(ctx: ActionCtx, orgId: Id<"organizations">, idempotencyKey: string): Promise<Record<string, string>> {
  const client = clientFor(ctx);
  await client.provision(orgId);
  const saved = await client.upsertAccounts(orgId, {
    records: ACME_COMPANIES.map((c) => ({ domain: c.domain, name: c.name, industry: "computer software", employees: 300, country: "united states" })),
    source: "dev-seed", idempotencyKey,
  });
  const companies = Object.fromEntries(ACME_COMPANIES.map((c, i) => [c.company, saved.ids[i]]));
  if (ACME_COMPANIES.some((c) => !companies[c.company])) throw new ConvexError("The record service did not return every Acme company");
  return companies;
}

export const seedCustomerSuccessDb = internalMutation({
  args: { companies: v.record(v.string(), v.string()), deal: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const account = org && await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", org._id)).first();
    if (!org || !account) throw new ConvexError("Run devSeed:ensureWorkspace first");
    await seedAcmeDeal(ctx, org._id, account._id, args.companies, args.deal, "dev_user_acme_");
    return null;
  },
});

/**
 * One Acme deal in a workspace, owned by Dana Ruiz (CSM; clerk ids `<prefix><key>`, never signed in) under Lee Park,
 * and linked to its company. Writes the same row again on a re-run. Shared with sample data.
 */
export async function seedAcmeDeal(
  ctx: MutationCtx, orgId: Id<"organizations">, accountId: Id<"crmAccounts">, companies: Record<string, string>, key: string, clerkPrefix: string,
): Promise<void> {
  const lee = await ensureUser(ctx, { orgId, clerkUserId: `${clerkPrefix}lee`, email: "lee@acme.demo", name: "Lee Park", role: "manager", title: "Head of Customer Success", startDate: "2025-01-06" });
  const dana = await ensureUser(ctx, { orgId, clerkUserId: `${clerkPrefix}dana`, email: "dana@acme.demo", name: "Dana Ruiz", role: "rep", title: "Customer Success Manager", startDate: "2025-01-06", managerId: lee });
  const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).collect();
  if (!teams.some((t) => t.name === "Customer success")) await ctx.db.insert("teamGroups", { orgId, name: "Customer success", managerId: lee, memberIds: [dana], createdAt: Date.now() });
  const STATUS = {
    won: { stage: "Closed Won", forecastCategory: "closed_won", isClosed: true, isWon: true },
    lost: { stage: "Closed Lost", forecastCategory: "closed_lost", isClosed: true, isWon: false },
    commit: { stage: "Negotiation", forecastCategory: "commit", isClosed: false, isWon: false },
    best_case: { stage: "Proposal", forecastCategory: "best_case", isClosed: false, isWon: false },
  } as const;
  const d = ACME_DEALS.find((x) => x.key === key);
  if (!d) throw new ConvexError(`No Acme deal ${key}`);
  const s = STATUS[d.status], at = Date.parse(`${d.close}T12:00:00Z`);
  const dealId = await ensureDeal(ctx, {
    orgId, crmId: `acme-${d.key}`, name: d.name, amount: cents(d.arr), closeDate: d.close, dealType: d.type,
    stage: s.stage, forecastCategory: s.forecastCategory, probability: s.isWon ? 1 : s.isClosed ? 0 : 0.6, primaryRepId: dana, accountId,
    isClosed: s.isClosed, isWon: s.isWon, now: at - 30 * DAY_MS, closedAt: at,
  });
  const row = await ctx.db.get(dealId);
  // A sync carries no Canon owner or company, so they are set as a person would.
  if (row) await saveDealValues(ctx, row, { kind: "user", userId: dana }, { ownerId: dana, companyId: companies[d.company] }, { now: at - 29 * DAY_MS });
}

/**
 * Local stack only: a timed two-sided call (Granola's shape, the "Northwind" C1 fixture), imported as
 * Granola's are, so a transcript shows its sides and times (`convex run devSeed:seedTimedCall`).
 */
export const seedTimedCall = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ callId: Id<"callRecordings"> }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    if (!org) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const lines = [
      ["rep", "Avery Chen", 0, 90, "Thanks for making time. What prompted the search? Who else is involved?"],
      ["customer", "Sam Lee", 91, 211, "Our team is growing fast and our budget for this is set."],
      ["rep", "Avery Chen", 211.8, 242, "How do you run reviews today?"],
      ["customer", "Sam Lee", 243, 423, "Mostly by hand, and we looked at Gong last year."],
      ["rep", "Avery Chen", 424.2, 574, "That makes sense. I will put together a plan for your team."],
      ["customer", "Sam Lee", 575, 600, "Great, send the proposal by Friday."],
    ] as const;
    return ctx.runMutation(internal.callIntelligence.importProviderTranscript, {
      orgId: org._id, provider: "granola", externalCallId: "granola:dev-atlas-discovery", title: "Atlas discovery",
      callDate: "2026-10-14T15:00:00.000Z", durationSeconds: 600,
      transcriptText: lines.map(([, who, , , text]) => `${who}: ${text}`).join("\n"),
      segments: lines.map(([side, , startSeconds, endSeconds]) => ({ side, startSeconds, endSeconds })),
      sourceMetadata: { provider: "granola", noteId: "dev-atlas-discovery", timings: 1 },
    });
  },
});

export const seedRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const org = await ctx.db.query("organizations").first();
    const user = org && await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", org._id)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const cliTokenId = await ctx.db.insert("cliTokens", { orgId: org._id, userId: user._id, tokenHash: `dev-seed-${now}`, name: "Dev seed", createdAt: now });
    const base = { orgId: org._id, userId: user._id, cliTokenId };
    await ctx.db.insert("cliRuns", {
      ...base, command: "audit", status: "partial", profile: "hubspot-prod", startedAt: now - 3_600_000, finishedAt: now - 3_540_000, durationMs: 60_000,
      counts: { findings: 3, spendUsd: 0.12 }, crm: { provider: "hubspot", recordUrlBase: "https://app.hubspot.com/contacts/123/record" },
      findings: [
        { objectType: "contact", objectId: "501", severity: "info", ruleId: "missing_title", field: "jobtitle" },
        { objectType: "account", objectId: "77", severity: "critical", ruleId: "duplicate_domain", operation: "merge" },
        { objectType: "deal", objectId: "9", severity: "warning", ruleId: "stale_close_date", field: "closedate" },
      ],
      events: [{ ts: now - 3_600_000, type: "start" }, { ts: now - 3_570_000, type: "fetched", detail: "1,204 records" }, { ts: now - 3_540_000, type: "done" }],
      createdAt: now - 3_600_000,
    });
    await ctx.db.insert("cliRuns", {
      ...base, command: "enrich apply", status: "in_progress", startedAt: now - 120_000, finishedAt: now, durationMs: 120_000,
      progress: { stage: "operations", stageIndex: 1, stageCount: 3, itemsDone: 40, itemsTotal: 120, heartbeatAt: now }, createdAt: now - 120_000,
    });
    await ctx.db.insert("cliArtifacts", {
      orgId: org._id, kind: "signal_run", key: `dev-signals-${now}`, label: "Hiring signals", domain: "acme.com", createdAt: now, updatedAt: now - 7_200_000, updatedByUserId: user._id,
      document: { icpRef: { domain: "acme.com", revision: 3 }, counts: { new: 1, fetched: 14 }, costUsd: 0.042, warnings: ["One board timed out."],
        signals: [{ id: "s1", companyName: "Globex", accountDomain: "globex.com", trigger: "Hiring RevOps", quote: "We are hiring a Head of Revenue Operations.", sourceUrl: "https://globex.com/careers/revops", hypothesisId: "h1", source: "greenhouse", weight: 0.8 }] },
    });
    await ctx.db.insert("cliArtifacts", {
      orgId: org._id, kind: "lead_run", key: `dev-leads-${now}`, label: "Lead preview", domain: "acme.com", createdAt: now, updatedAt: now - 10_800_000, updatedByUserId: user._id,
      document: { runLabel: "RevOps leaders", icpRef: { domain: "acme.com", revision: 3 }, counts: { fetched: 20, matched: 4, ambiguous: 1 },
        plan: { id: "p1", operations: [{ id: "o1", reason: "Title and company fit the ICP.", afterValue: { properties: { firstname: "Dana", lastname: "Ruiz", jobtitle: "VP RevOps", company: "Globex", hs_linkedin_url: "https://www.linkedin.com/in/dana-ruiz" }, associateCompanyDomain: "globex.com" }, evidenceIds: ["e1"] }],
          evidence: [{ id: "e1", text: JSON.stringify({ fitScore: 0.91 }) }] } },
    });
    return null;
  },
});

export const seedEventAgent = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Seed the demo workspace first");
    const existing = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", org._id).eq("slug", "local_demo_research")).unique();
    if (existing) return { agentId: existing._id };
    const now = Date.now();
    const slug = "local_demo_fit";
    if (!await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", org._id).eq("slug", slug)).unique()) {
      await ctx.db.insert("researchAgents", { orgId: org._id, slug, label: "Demo fit", entityType: "account", kind: "qa", question: "Does the fixture fit?", answerType: "boolean", createdBy: user._id, createdAt: now, updatedAt: now });
    }
    const agentId = await ctx.db.insert("agents", {
      orgId: org._id, slug: "local_demo_research", label: "Demo request research", kind: "hosted", ownerUserId: user._id,
      ledgerKey: "agent:local_demo_research", fieldSlugs: [slug, "deleted_demo_field"], budget: DEFAULT_BUDGET,
      pause: { reason: "paused_by_user", at: now, by: user._id }, createdBy: user._id, createdAt: now, updatedAt: now,
    });
    const grantId = await ctx.db.insert("agentGrants", { orgId: org._id, agentId, operation: "set_field", entityType: "account", attribute: `custom.${slug}`, allowedValues: ["false"], maxPerDay: 10, expiresAt: now + DAY_MS, signature: "inert-local-fixture", createdBy: user._id, createdAt: now });
    const base = { orgId: org._id, agentId, subject: { domain: "fixture.example" }, payload: '{"domain":"fixture.example"}', spend: { modelCalls: 2, tokens: 1500, pagesRead: 1, ms: 3000 }, createdAt: now - 60_000, updatedAt: now - 60_000 };
    const turnId = await ctx.db.insert("agentTurns", { ...base, trigger: "webhook", eventKey: "local-demo-done", admitted: true, status: "done", outputs: [{ fieldSlug: slug, label: "Demo fit", status: "answered", value: false, reason: "Synthetic receipt for read-only verification." }], slack: { status: "sent", at: now - 60_000 } });
    await ctx.db.insert("agentTurns", { ...base, trigger: "test", eventKey: "local-demo-waiting", admitted: true, status: "queued", outputs: [], createdAt: now, updatedAt: now });
    return { agentId, turnId, grantId };
  },
});

/**
 * Local stack only: a LinkedIn conversation and an email thread with one contact (its register id), as intake would
 * store them, and the LinkedIn one read by extraction: a proposed next step and a suggested company
 * (docs/conversation-intake.md CI4, the record page's Conversations section).
 */
export const seedConversations = action({
  args: { contactId: v.string(), contactName: v.string() },
  handler: async (ctx, args): Promise<{ linkedinId: Id<"conversations">; emailId: Id<"conversations"> }> => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const seeded: { orgId: Id<"organizations">; userId: Id<"users">; dealId: Id<"deals"> | null; linkedinId: Id<"conversations">; emailId: Id<"conversations"> } =
      await ctx.runMutation(internal.devSeed.seedConversationsDb, args);
    const result = await ctx.runMutation(internal.callFacts.submitConversation, {
      orgId: seeded.orgId, userId: seeded.userId, kind: "linkedin", title: args.contactName, model: "local fixture", ...(seeded.dealId ? { dealId: seeded.dealId } : {}),
      facts: [
        { entityType: "opportunity", attribute: "nextStep", value: "Send times for next week", evidence: "Great, I'll send times for next week." },
        { entityType: "contact", contactId: args.contactId, attribute: "title", value: "VP Revenue Operations", evidence: "I moved over to run RevOps as VP last month." },
      ],
    });
    await ctx.runMutation(internal.conversationExtract.finish, { conversationId: seeded.linkedinId, lease: 0, readAt: Date.now(), ...(result?.patchPlanId ? { patchPlanId: result.patchPlanId } : {}) });
    return { linkedinId: seeded.linkedinId, emailId: seeded.emailId };
  },
});

export const seedConversationsDb = internalMutation({
  args: { contactId: v.string(), contactName: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const HOUR = 3_600_000;
    const thread = async (channel: "email" | "linkedin", counterpart: Doc<"conversations">["counterpart"], subject: string | undefined, messages: Array<{ direction: "in" | "out"; hoursAgo: number; text: string }>) => {
      const lastMessageAt = now - Math.min(...messages.map((m) => m.hoursAgo)) * HOUR;
      const conversationId = await ctx.db.insert("conversations", {
        orgId: org._id, ownerUserId: user._id, channel, accountRef: `local-${channel}`, externalThreadId: `local-${channel}-${args.contactId}-${now}`,
        counterpart, contactIds: [args.contactId], ...(subject ? { subject } : {}), lastMessageAt, createdAt: now, updatedAt: now,
      });
      await linkContacts(ctx, org._id, conversationId, [args.contactId]);
      for (const [i, m] of messages.entries()) {
        await ctx.db.insert("conversationMessages", {
          orgId: org._id, conversationId, externalMessageId: `local-${channel}-${conversationId}-${i}`, direction: m.direction, at: now - m.hoursAgo * HOUR,
          from: m.direction === "in" ? args.contactName : user.name ?? "me", text: m.text,
        });
      }
      return conversationId;
    };
    const linkedinId = await thread("linkedin", { providerId: `local-${args.contactId}`, name: args.contactName }, undefined, [
      { direction: "out", hoursAgo: 30, text: `Hi ${args.contactName.split(" ")[0]}, congrats on the new role. Still looking at CRM cleanup this quarter?` },
      { direction: "in", hoursAgo: 26, text: "Thanks! I moved over to run RevOps as VP last month. Yes, it's on the list. Talk to Priya at Northwind too, they're evaluating as well." },
      { direction: "out", hoursAgo: 2, text: "Great, I'll send times for next week." },
    ]);
    const emailId = await thread("email", { email: "contact@local.test", name: args.contactName }, "Security questionnaire", [
      { direction: "out", hoursAgo: 72, text: "Following up on our call: the security questionnaire is attached." },
      { direction: "in", hoursAgo: 48, text: "Got it, legal is reviewing. Expect comments by Friday." },
    ]);
    await ctx.db.insert("callSuggestions", {
      orgId: org._id, conversationId: linkedinId, userId: user._id, kind: "account", key: "northwind.local", status: "pending",
      values: { name: "Northwind", domain: "northwind.local" }, evidence: "Talk to Priya at Northwind too, they're evaluating as well.", createdAt: now,
    });
    // The workspace's newest deal stands in for the one extraction would find open with this person.
    const deal = await ctx.db.query("deals").withIndex("by_orgId_updatedAt", (q) => q.eq("orgId", org._id)).order("desc").first();
    return { orgId: org._id, userId: user._id, dealId: deal?._id ?? null, linkedinId, emailId };
  },
});

/** Local Pull proof: opted-in synthetic accounts and linked intake threads. */
export const seedMeContext = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", DEV_ORG_CLERK_ID)).first();
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!org || !user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    let linkedin = await ctx.db.query("linkedinAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", "local-pull")).first();
    if (!linkedin) {
      const id = await ctx.db.insert("linkedinAccounts", { orgId: org._id, userId: user._id, unipileAccountId: "local-pull", status: "ok", ingest: true, ingestBackfilledAt: now, ingestSyncedAt: now, tier: "free", timezone: "UTC", window: { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 }, overrides: {}, rampStep: 0, rampAdvancedAt: now, riskAcceptedAt: now, riskTextVersion: "local", connectedAt: now, updatedAt: now });
      linkedin = await ctx.db.get(id);
    }
    let gmail = await ctx.db.query("emailAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", "local-pull-gmail")).first();
    if (!gmail) {
      const id = await ctx.db.insert("emailAccounts", { orgId: org._id, userId: user._id, unipileAccountId: "local-pull-gmail", provider: "google", address: "pull@local.test", status: "ok", ingest: true, ingestBackfilledAt: now, ingestSyncedAt: now, connectedAt: now, updatedAt: now });
      gmail = await ctx.db.get(id);
    }
    for (const [i, name] of ["Avery", "Morgan", "Taylor"].entries()) {
      for (const [channel, accountRef] of [["linkedin", linkedin!._id], ["email", gmail!._id]] as const) {
        const externalThreadId = `local-pull-${i}`;
        if (await ctx.db.query("conversations").withIndex("by_accountRef_and_externalThreadId", (q) => q.eq("accountRef", accountRef).eq("externalThreadId", externalThreadId)).first()) continue;
        const conversationId = await ctx.db.insert("conversations", { orgId: org._id, ownerUserId: user._id, channel, accountRef, externalThreadId, counterpart: { providerId: `fixture-${i}`, name, email: `${name.toLowerCase()}@fixture-saas.test`, domain: "fixture-saas.test" }, contactIds: [], lastMessageAt: now, createdAt: now, updatedAt: now });
        await ctx.db.insert("conversationMessages", { orgId: org._id, conversationId, externalMessageId: `fixture-${channel}-${i}`, direction: "in", from: name, at: now, text: "Private fixture message. The persona model must never read this text." });
      }
    }
    return { linkedin: linkedin!._id, gmail: gmail!._id };
  },
});

/**
 * Local stack only: an account hierarchy scan with one researched group, so the review page can be seen without a
 * Salesforce connection or a ChatGPT sign-in. The data comes in as arguments (a prototype run's group, research,
 * verification and proposal); nothing is read from or written to any CRM.
 */
export const seedHierarchy = internalMutation({
  args: {
    group: v.object({
      accounts: v.array(v.object({ id: v.string(), name: v.string(), parentId: v.optional(v.string()), shell: v.boolean() })),
      reasons: v.array(v.string()),
      suggestedRootId: v.string(),
    }),
    groupName: v.string(),
    research: v.any(),
    verification: v.any(),
    proposal: v.any(),
  },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!user) throw new ConvexError("Run devSeed:ensureWorkspace first");
    const now = Date.now();
    const scanId = await ctx.db.insert("hierarchyScans", {
      orgId: user.orgId, provider: "salesforce", status: "done", startedBy: user._id, startedAt: now, finishedAt: now,
      accounts: args.group.accounts.length, groups: 1, shellGroups: args.group.accounts.some((a) => a.shell) ? 1 : 0,
    });
    const groupId = await ctx.db.insert("hierarchyGroups", {
      orgId: user.orgId, scanId, rank: 0, groupKey: args.group.accounts[0]?.id ?? "seed", size: args.group.accounts.length,
      shellCount: args.group.accounts.filter((a) => a.shell).length, ...args.group,
    });
    await ctx.db.insert("hierarchyResearch", {
      orgId: user.orgId, scanId, groupId, groupName: args.groupName, rootAccountId: args.group.suggestedRootId, status: "done",
      startedBy: user._id, startedAt: now, finishedAt: now, model: "seed", research: args.research, verification: args.verification, proposal: args.proposal,
    });
    return groupId;
  },
});

/**
 * Local stack only: a finished research for one account hierarchy group, with the proposal given. Parent moves come
 * only from live research on a user's ChatGPT plan, which a local stack does not run (`convex run
 * devSeed:seedHierarchyResearch`).
 */
export const seedHierarchyResearch = internalMutation({
  args: { groupId: v.id("hierarchyGroups"), groupName: v.string(), rootAccountId: v.string(), research: v.any(), proposal: v.any() },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Demo workspace seeding is disabled");
    const g = await ctx.db.get(args.groupId);
    const user = await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", DEV_USER_CLERK_ID)).first();
    if (!g || !user) throw new ConvexError("Scan the demo workspace first");
    const now = Date.now();
    return ctx.db.insert("hierarchyResearch", {
      orgId: g.orgId, scanId: g.scanId, groupId: g._id, groupName: args.groupName, rootAccountId: args.rootAccountId, status: "done",
      startedBy: user._id, startedAt: now, finishedAt: now, model: "seeded locally", research: args.research, verification: { checks: [] }, proposal: args.proposal,
    });
  },
});
