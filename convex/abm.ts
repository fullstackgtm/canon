import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireCap } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import { countBy } from "./lib/collections";
import type { Doc, Id } from "./_generated/dataModel";
import { modelSettings } from "./lib/recipes";
import { accountStatus, engagementScore } from "./lib/abm";
import type { AbmModel } from "../recipes/models.ts";

function abmReadinessFromRows(lists: any[], listAccounts: any[], plays: any[], accounts: any[]) {
  const activePlays = plays.filter((play) => play.status === "active");
  const relevant = lists.length > 0 || listAccounts.length > 0 || plays.length > 0 || accounts.length > 0;
  return {
    noun: "abm",
    required: false,
    relevant,
    configured: lists.length > 0,
    lifecycle: activePlays.length > 0 ? "active" : lists.length > 0 ? "targeted" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { listCount: lists.length, targetAccountCount: listAccounts.length, playCount: plays.length, activePlays: activePlays.length, accountCount: accounts.length },
    nextActions: lists.length > 0 ? ["review target accounts", "launch ABM play"] : ["do abm.bootstrap", "sync account data"],
  };
}

function emptyAbmReadiness() {
  return {
    noun: "abm",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_relevant_yet",
    signals: { listCount: 0, targetAccountCount: 0, playCount: 0, activePlays: 0, accountCount: 0 },
    nextActions: ["Sign in to inspect ABM readiness"],
  };
}

function buildAccountContext(args: {
  model: AbmModel;
  accounts: Doc<"crmAccounts">[];
  contacts: Doc<"crmContacts">[];
  deals: Doc<"deals">[];
  users: Doc<"users">[];
  excludeAccountIds?: Set<Id<"crmAccounts">>;
}) {
  const usersById = new Map(args.users.map((member) => [member._id, member]));
  const contactsByAccount = new Map<Id<"crmAccounts">, number>();
  const dealsByAccount = new Map<Id<"crmAccounts">, Doc<"deals">[]>();

  for (const contact of args.contacts) {
    if (!contact.accountId) continue;
    contactsByAccount.set(
      contact.accountId,
      (contactsByAccount.get(contact.accountId) ?? 0) + 1,
    );
  }
  for (const deal of args.deals) {
    if (!deal.accountId) continue;
    dealsByAccount.set(deal.accountId, [
      ...(dealsByAccount.get(deal.accountId) ?? []),
      deal,
    ]);
  }

  return args.accounts
    .filter((account) => !args.excludeAccountIds?.has(account._id))
    .map((account) => {
      const accountDeals = dealsByAccount.get(account._id) ?? [];
      const openDeals = accountDeals.filter((deal) => !deal.isClosed);
      const wonDeals = accountDeals.filter((deal) => deal.isWon);
      const openPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
      const historicalBookings = wonDeals.reduce(
        (sum, deal) => sum + (deal.arr ?? deal.amount ?? 0),
        0,
      );
      const contactCount = contactsByAccount.get(account._id) ?? 0;
      const signals = { openDeals: openDeals.length, openPipeline, contacts: contactCount, owned: Boolean(account.ownerId), won: wonDeals.length > 0 };
      const score = engagementScore(args.model, signals);
      const owner = account.ownerId ? usersById.get(account.ownerId) : null;

      return {
        accountId: account._id,
        name: account.name,
        domain: account.domain ?? null,
        industry: account.industry ?? null,
        ownerId: account.ownerId ?? null,
        ownerName: owner?.name ?? null,
        contactCount,
        openDeals: openDeals.length,
        openPipeline,
        historicalBookings,
        suggestedEngagementScore: score,
        suggestedStatus: accountStatus(args.model, { score, ...signals }),
        lastSyncAt: account.lastSyncAt,
      };
    })
    .sort((a, b) => {
      if (b.openPipeline !== a.openPipeline) return b.openPipeline - a.openPipeline;
      if (b.suggestedEngagementScore !== a.suggestedEngagementScore) {
        return b.suggestedEngagementScore - a.suggestedEngagementScore;
      }
      if (b.contactCount !== a.contactCount) return b.contactCount - a.contactCount;
      return a.name.localeCompare(b.name);
    });
}

// ── Queries ───────────────────────────────────────────────────────

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyAbmReadiness();
    const [lists, listAccounts, plays, accounts] = await Promise.all([
      ctx.db.query("abmLists").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("abmListAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("abmPlays").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    return abmReadinessFromRows(lists, listAccounts, plays, accounts);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyAbmReadiness(), lists: [], listAccounts: [], plays: [] };
    const [lists, listAccounts, plays, accounts] = await Promise.all([
      ctx.db.query("abmLists").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("abmListAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
      ctx.db.query("abmPlays").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(1000),
    ]);
    const accountCounts = countBy(listAccounts, (account) => account.listId);
    return {
      readiness: abmReadinessFromRows(lists, listAccounts, plays, accounts),
      lists: lists.map((list) => ({ ...list, accountCount: accountCounts.get(list._id) ?? 0 })),
      listAccounts,
      plays,
    };
  },
});

export const listLists = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const [lists, listAccounts] = await Promise.all([
      ctx.db
        .query("abmLists")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(100),
      ctx.db
        .query("abmListAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
    ]);

    const accountCounts = countBy(listAccounts, (account) => account.listId);

    return lists.map((list) => ({
      ...list,
      accountCount: accountCounts.get(list._id) ?? 0,
    }));
  },
});

export const getList = query({
  args: { listId: v.id("abmLists") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId) return null;
    return list;
  },
});

export const listAccounts = query({
  args: { listId: v.id("abmLists") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId) return [];

    const listAccounts = await ctx.db
      .query("abmListAccounts")
      .withIndex("by_listId", (q) => q.eq("listId", args.listId))
      .take(500);

    // Enrich with CRM account and owner data for the dashboard table.
    const enriched = [];
    for (const listAccount of listAccounts) {
      const account = await ctx.db.get(listAccount.accountId);
      if (!account || account.orgId !== user.orgId) continue;
      const ownerId = listAccount.ownerId ?? account.ownerId;
      const owner = ownerId ? await ctx.db.get(ownerId) : null;
      enriched.push({
        ...listAccount,
        account,
        accountName: account?.name,
        ownerName: owner?.name,
      });
    }
    return enriched;
  },
});

export const listCandidateAccounts = query({
  args: { listId: v.id("abmLists") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId) return [];

    const [existingAccounts, accounts, contacts, deals, users] = await Promise.all([
      ctx.db
        .query("abmListAccounts")
        .withIndex("by_listId", (q) => q.eq("listId", args.listId))
        .take(500),
      ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("crmContacts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(500),
      ctx.db
        .query("users")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(500),
    ]);

    const existingAccountIds = new Set(
      existingAccounts
        .filter((account) => account.orgId === user.orgId)
        .map((account) => account.accountId),
    );
    return buildAccountContext({
      model: await modelSettings(ctx, user.orgId, "abm.model"),
      accounts,
      contacts,
      deals,
      users,
      excludeAccountIds: existingAccountIds,
    }).slice(0, 100);
  },
});

export const listPlays = query({
  args: { listId: v.id("abmLists") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId) return [];
    return ctx.db
      .query("abmPlays")
      .withIndex("by_listId", (q) => q.eq("listId", args.listId))
      .take(200)
      .then((plays) => plays.filter((p) => p.orgId === user.orgId));
  },
});

export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { totalLists: 0, totalAccounts: 0, byTier: {}, byStatus: {} };

    const lists = await ctx.db
      .query("abmLists")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(100);

    const accounts = await ctx.db
      .query("abmListAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(1000);

    const byTier: Record<string, number> = {};
    for (const list of lists) {
      byTier[list.tier] = (byTier[list.tier] ?? 0) + 1;
    }

    const byStatus: Record<string, number> = {};
    for (const account of accounts) {
      byStatus[account.status] = (byStatus[account.status] ?? 0) + 1;
    }

    return {
      totalLists: lists.length,
      totalAccounts: accounts.length,
      byTier,
      byStatus,
    };
  },
});

// ── Mutations ─────────────────────────────────────────────────────

export const createList = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    tier: v.union(
      v.literal("tier_1"),
      v.literal("tier_2"),
      v.literal("tier_3"),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const now = Date.now();
    return ctx.db.insert("abmLists", {
      orgId: user.orgId,
      ...args,
      status: "draft",
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateList = mutation({
  args: {
    listId: v.id("abmLists"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    tier: v.optional(
      v.union(
        v.literal("tier_1"),
        v.literal("tier_2"),
        v.literal("tier_3"),
      ),
    ),
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("archived"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { listId, ...updates } = args;
    const list = await ctx.db.get(listId);
    if (!list || list.orgId !== user.orgId)
      throw new Error("List not found");

    const cleanUpdates: Partial<Doc<"abmLists">> = { updatedAt: Date.now() };
    if (updates.name !== undefined) cleanUpdates.name = updates.name;
    if (updates.description !== undefined) {
      cleanUpdates.description = updates.description;
    }
    if (updates.tier !== undefined) cleanUpdates.tier = updates.tier;
    if (updates.status !== undefined) cleanUpdates.status = updates.status;
    await ctx.db.patch(listId, cleanUpdates);
  },
});

export const generateFromCrm = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "ABM from the whole CRM");
    const now = Date.now();
    const [lists, listAccounts, accounts, contacts, deals, users, plays] =
      await Promise.all([
        ctx.db
          .query("abmLists")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .take(100),
        ctx.db
          .query("abmListAccounts")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .take(1000),
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
        ctx.db
          .query("users")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .take(200),
        ctx.db
          .query("abmPlays")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
          .take(500),
      ]);

    const name = "CRM Tier 1 Target Accounts";
    const existingList = lists.find((list) => list.name === name);
    let listId: Id<"abmLists">;
    let listsCreated = 0;
    let listsUpdated = 0;

    if (existingList) {
      listId = existingList._id;
      await ctx.db.patch(listId, {
        description:
          "Auto-generated from CRM pipeline, account ownership, contact coverage, and bookings.",
        tier: "tier_1",
        status: "active",
        updatedAt: now,
      });
      listsUpdated++;
    } else {
      listId = await ctx.db.insert("abmLists", {
        orgId: user.orgId,
        name,
        description:
          "Auto-generated from CRM pipeline, account ownership, contact coverage, and bookings.",
        tier: "tier_1",
        status: "active",
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      listsCreated++;
    }

    const existingByAccount = new Map(
      listAccounts
        .filter((account) => account.listId === listId)
        .map((account) => [account.accountId, account]),
    );
    const recommendedAccounts = buildAccountContext({
      model: await modelSettings(ctx, user.orgId, "abm.model"),
      accounts,
      contacts,
      deals,
      users,
    }).slice(0, 25);

    let accountsAdded = 0;
    let accountsUpdated = 0;
    for (const account of recommendedAccounts) {
      const value = {
        ownerId: account.ownerId ?? undefined,
        engagementScore: account.suggestedEngagementScore,
        status: account.suggestedStatus,
        notes:
          account.openPipeline > 0
            ? `Generated from ${account.openDeals} open deal${account.openDeals === 1 ? "" : "s"} and ${account.contactCount} mapped contact${account.contactCount === 1 ? "" : "s"}.`
            : `Generated from CRM fit signals and ${account.contactCount} mapped contact${account.contactCount === 1 ? "" : "s"}.`,
      };
      const existing = existingByAccount.get(account.accountId);
      if (existing) {
        await ctx.db.patch(existing._id, value);
        accountsUpdated++;
      } else {
        await ctx.db.insert("abmListAccounts", {
          listId,
          orgId: user.orgId,
          accountId: account.accountId,
          ...value,
          addedAt: now,
        });
        accountsAdded++;
      }
    }

    const playName = "Executive Mutual Action Plan";
    const existingPlay = plays.find(
      (play) => play.listId === listId && play.name === playName,
    );
    let playsCreated = 0;
    if (!existingPlay) {
      await ctx.db.insert("abmPlays", {
        orgId: user.orgId,
        listId,
        name: playName,
        description:
          "Default multi-touch play for CRM-derived target accounts.",
        steps: [
          {
            order: 1,
            channel: "email",
            action: "Send account-specific operating benchmark and CRM pain hypothesis",
            owner: "AE",
            daysAfterStart: 0,
          },
          {
            order: 2,
            channel: "linkedin",
            action: "Connect with executive buyer and reference the relevant planning cycle",
            owner: "Founder",
            daysAfterStart: 2,
          },
          {
            order: 3,
            channel: "call",
            action: "Confirm operating pain, spreadsheet owner, and mutual action next step",
            owner: "AE",
            daysAfterStart: 5,
          },
        ],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      playsCreated++;
    }

    return {
      listId,
      listsCreated,
      listsUpdated,
      accountsAdded,
      accountsUpdated,
      playsCreated,
    };
  },
});

export const addAccount = mutation({
  args: {
    listId: v.id("abmLists"),
    accountId: v.id("crmAccounts"),
    ownerId: v.optional(v.id("users")),
    engagementScore: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("target"),
        v.literal("engaged"),
        v.literal("opportunity"),
        v.literal("customer"),
        v.literal("churned"),
      ),
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "ABM from the whole CRM");
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId)
      throw new Error("List not found");

    const account = await ctx.db.get(args.accountId);
    if (!account || account.orgId !== user.orgId)
      throw new Error("Account not found");

    const ownerId = args.ownerId ?? account.ownerId;
    if (ownerId) {
      const owner = await ctx.db.get(ownerId);
      if (!owner || owner.orgId !== user.orgId) {
        throw new Error("Owner not found");
      }
    }

    const existing = await ctx.db
      .query("abmListAccounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .take(100);
    const duplicate = existing.find(
      (row) => row.orgId === user.orgId && row.listId === args.listId,
    );
    if (duplicate) return duplicate._id;

    return ctx.db.insert("abmListAccounts", {
      listId: args.listId,
      orgId: user.orgId,
      accountId: args.accountId,
      ownerId,
      engagementScore: args.engagementScore,
      status: args.status ?? "target",
      notes: args.notes,
      addedAt: Date.now(),
    });
  },
});

export const updateAccount = mutation({
  args: {
    listAccountId: v.id("abmListAccounts"),
    engagementScore: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("target"),
        v.literal("engaged"),
        v.literal("opportunity"),
        v.literal("customer"),
        v.literal("churned"),
      ),
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "ABM from the whole CRM");
    const { listAccountId, ...updates } = args;
    const listAccount = await ctx.db.get(listAccountId);
    if (!listAccount || listAccount.orgId !== user.orgId)
      throw new Error("List account not found");

    const cleanUpdates: Partial<Doc<"abmListAccounts">> = {};
    if (updates.engagementScore !== undefined) {
      cleanUpdates.engagementScore = updates.engagementScore;
    }
    if (updates.status !== undefined) cleanUpdates.status = updates.status;
    if (updates.notes !== undefined) cleanUpdates.notes = updates.notes;
    await ctx.db.patch(listAccountId, cleanUpdates);
  },
});

export const removeAccount = mutation({
  args: { listAccountId: v.id("abmListAccounts") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    await requireUnrestricted(ctx, "ABM from the whole CRM");
    const listAccount = await ctx.db.get(args.listAccountId);
    if (!listAccount || listAccount.orgId !== user.orgId)
      throw new Error("List account not found");

    await ctx.db.delete(args.listAccountId);
  },
});

export const createPlay = mutation({
  args: {
    listId: v.id("abmLists"),
    name: v.string(),
    description: v.optional(v.string()),
    steps: v.array(
      v.object({
        order: v.number(),
        channel: v.string(),
        action: v.string(),
        owner: v.optional(v.string()),
        daysAfterStart: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const list = await ctx.db.get(args.listId);
    if (!list || list.orgId !== user.orgId)
      throw new Error("List not found");

    const now = Date.now();
    return ctx.db.insert("abmPlays", {
      orgId: user.orgId,
      ...args,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updatePlay = mutation({
  args: {
    playId: v.id("abmPlays"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    steps: v.optional(
      v.array(
        v.object({
          order: v.number(),
          channel: v.string(),
          action: v.string(),
          owner: v.optional(v.string()),
          daysAfterStart: v.number(),
        }),
      ),
    ),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const { playId, ...updates } = args;
    const play = await ctx.db.get(playId);
    if (!play || play.orgId !== user.orgId)
      throw new Error("Play not found");

    const cleanUpdates: Partial<Doc<"abmPlays">> = { updatedAt: Date.now() };
    if (updates.name !== undefined) cleanUpdates.name = updates.name;
    if (updates.description !== undefined) {
      cleanUpdates.description = updates.description;
    }
    if (updates.steps !== undefined) cleanUpdates.steps = updates.steps;
    if (updates.isActive !== undefined) cleanUpdates.isActive = updates.isActive;
    await ctx.db.patch(playId, cleanUpdates);
  },
});
