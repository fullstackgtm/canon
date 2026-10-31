import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getCurrentUser, requireCap, scopeUserToActiveOrg } from "./lib";
import { partySyncHasBudget, saveCrmAccount, saveCrmContact, saveDeal, saveDealValues, SYNCED_DEAL_ATTRIBUTES } from "./canon";
import type { DealValues } from "./lib/canon/dealLedger";

/** A value a portal import adds beside the mirror's: a Canon field value (a multi-select is a list). */
const extraValue = v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()));
import { syncPartyBatch } from "./lib/canon/partyLedger";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";

const PROVIDER = "hubspot";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const getConnection = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", PROVIDER),
      )
      .first();

    if (!integration) return null;

    return {
      _id: integration._id,
      provider: integration.provider,
      instanceUrl: integration.instanceUrl,
      displayName: integration.displayName,
      externalOrgDomain: integration.externalOrgDomain,
      isActive: integration.isActive,
      lastSyncAt: integration.lastSyncAt,
      lastSyncStatus: integration.lastSyncStatus,
      lastSyncError: integration.lastSyncError,
      lastSyncDealCount: integration.lastSyncDealCount,
      connectedAt: integration.connectedAt,
      scopes: integration.scopes,
      syncConfig: integration.syncConfig,
      fieldMappings: integration.fieldMappings,
    };
  },
});

// activeClerkOrgId (the JWT's active-org claim) re-scopes the returned row's
// orgId/role to the org the session has switched into — same contract as
// lib.ts:getCurrentUser. Action-layer callers MUST pass it or they operate on
// the user's home org regardless of the OrganizationSwitcher.
export const getUserByClerkId = internalQuery({
  args: { clerkUserId: v.string(), activeClerkOrgId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (!user) return null;
    return scopeUserToActiveOrg(ctx, user, args.activeClerkOrgId ?? null);
  },
});

export const getIntegration = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", PROVIDER),
      )
      .first();
  },
});

export const createOAuthState = internalMutation({
  args: {
    state: v.string(),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    codeVerifier: v.optional(v.string()),
    cliAuthRequestId: v.optional(v.id("cliAuthRequests")),
    cliAuthDeviceCodeHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("oauthStates", {
      state: args.state,
      orgId: args.orgId,
      userId: args.userId,
      provider: PROVIDER,
      codeVerifier: args.codeVerifier,
      cliAuthRequestId: args.cliAuthRequestId,
      cliAuthDeviceCodeHash: args.cliAuthDeviceCodeHash,
      createdAt: now,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });
  },
});

export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();

    if (!record) return null;
    await ctx.db.delete(record._id);
    if (record.provider !== PROVIDER) return null;
    if (record.expiresAt && Date.now() > record.expiresAt) return null;
    if (!record.userId) return null;

    return {
      orgId: record.orgId,
      userId: record.userId,
      codeVerifier: record.codeVerifier,
      cliAuthRequestId: record.cliAuthRequestId,
      cliAuthDeviceCodeHash: record.cliAuthDeviceCodeHash,
    };
  },
});

export const storeTokens = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    accessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.optional(v.array(v.string())),
    displayName: v.optional(v.string()),
    externalOrgId: v.optional(v.string()),
    externalOrgDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", PROVIDER),
      )
      .first();

    const patch = {
      accessToken: await encryptForStorage(args.accessToken),
      refreshToken: await encryptForStorage(args.refreshToken),
      instanceUrl: "https://api.hubapi.com",
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      ...(args.externalOrgId ? { externalOrgId: args.externalOrgId } : {}),
      ...(args.externalOrgDomain
        ? { externalOrgDomain: args.externalOrgDomain }
        : {}),
      isActive: true,
      connectedBy: args.userId,
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      // Default to a daily scheduled sync when the org has never chosen one —
      // without a schedule, health/issues data goes stale after the initial sync.
      const syncConfig = (existing.syncConfig as { schedule?: string } | undefined)?.schedule
        ? existing.syncConfig
        : { ...(existing.syncConfig ?? {}), schedule: "daily" };
      await ctx.db.patch(existing._id, { ...patch, syncConfig });
      await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
        orgId: args.orgId,
        trigger: "oauth",
      });
      return existing._id;
    }

    const integrationId = await ctx.db.insert("integrations", {
      orgId: args.orgId,
      provider: PROVIDER,
      ...patch,
      syncConfig: { schedule: "daily" },
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
      orgId: args.orgId,
      trigger: "oauth",
    });

    return integrationId;
  },
});

/**
 * Connect/refresh HubSpot from a PAIRED CLI's own credential (broker-authed, no
 * browser). Stores the token like storeTokens, but only kicks a sync on the
 * first connect or a reactivation — repeated paired audits refresh the token
 * without re-syncing every time.
 */
export const connectFromCli = internalMutation({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    accessToken: v.string(),
    scopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Private-app tokens don't expire; a far-future expiry skips the refresh path.
    const farFuture = now + 100 * 365 * 24 * 60 * 60 * 1000;
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", PROVIDER),
      )
      .first();

    const fields = {
      accessToken: await encryptForStorage(args.accessToken),
      refreshToken: await encryptForStorage(""),
      instanceUrl: "https://api.hubapi.com",
      tokenExpiresAt: farFuture,
      scopes: args.scopes,
      isActive: true,
      connectedBy: args.userId,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...fields,
        connectedAt: existing.connectedAt ?? now,
      });
      // Re-sync on reactivation or to retry a previously failed sync; otherwise
      // a healthy connection isn't re-synced on every paired audit.
      if (!existing.isActive || existing.lastSyncStatus === "error") {
        await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
          orgId: args.orgId,
          trigger: "system",
        });
      }
      return { created: false };
    }

    await ctx.db.insert("integrations", {
      orgId: args.orgId,
      provider: PROVIDER,
      ...fields,
      syncConfig: { schedule: "daily" },
      connectedAt: now,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
      orgId: args.orgId,
      trigger: "system",
    });
    return { created: true };
  },
});

export const updateTokens = internalMutation({
  args: {
    integrationId: v.id("integrations"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      accessToken: await encryptForStorage(args.accessToken),
      tokenExpiresAt: args.tokenExpiresAt,
      updatedAt: Date.now(),
    };
    if (args.refreshToken) {
      updates.refreshToken = await encryptForStorage(args.refreshToken);
    }
    await ctx.db.patch(args.integrationId, updates);
  },
});

export const updateSyncStatus = internalMutation({
  args: {
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("error"),
      v.literal("in_progress"),
    ),
    error: v.optional(v.string()),
    dealCount: v.optional(v.number()),
    displayName: v.optional(v.string()),
    externalOrgId: v.optional(v.string()),
    externalOrgDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", PROVIDER),
      )
      .first();
    if (!integration) return;

    const updates: Record<string, unknown> = {
      lastSyncAt: Date.now(),
      lastSyncStatus: args.status,
      lastSyncDealCount: args.dealCount,
      updatedAt: Date.now(),
    };
    updates.lastSyncError = args.error;
    if (!integration.displayName && args.displayName) {
      updates.displayName = args.displayName;
    }
    if (!integration.externalOrgId && args.externalOrgId) {
      updates.externalOrgId = args.externalOrgId;
    }
    if (!integration.externalOrgDomain && args.externalOrgDomain) {
      updates.externalOrgDomain = args.externalOrgDomain;
    }

    await ctx.db.patch(integration._id, updates);
  },
});

export const getDisconnectTarget = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "integrations.manage");

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", PROVIDER),
      )
      .first();

    if (!integration) throw new ConvexError("No HubSpot integration found");
    return { refreshToken: integration.refreshToken };
  },
});

export const disconnectWithRevocation = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    const integration: { refreshToken?: string } = await ctx.runQuery(
      internal.hubspot.getDisconnectTarget,
      {},
    );

    if (integration.refreshToken) {
      try {
        const refreshToken = await decryptFromStorage(integration.refreshToken);
        if (refreshToken) {
          const response = await fetch(
            `https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`,
            { method: "DELETE" },
          );
          if (!response.ok) {
            throw new Error(`HubSpot revocation failed with ${response.status}`);
          }
        }
      } catch {
        // Best-effort provider revocation; local disconnect must still complete.
      }
    }

    await ctx.runMutation(api.hubspot.disconnect, {});
    return null;
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "integrations.manage");

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", PROVIDER),
      )
      .first();

    if (!integration) throw new ConvexError("No HubSpot integration found");
    await ctx.db.delete(integration._id);
  },
});

export const upsertOwners = internalMutation({
  args: {
    orgId: v.id("organizations"),
    owners: v.array(
      v.object({
        crmOwnerId: v.string(),
        name: v.string(),
        email: v.string(),
        title: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results = { created: 0, updated: 0 };
    const ownerMap: Record<string, string> = {};

    for (const owner of args.owners) {
      const email = owner.email.toLowerCase();
      const existing = await ctx.db
        .query("users")
        .withIndex("by_orgId_email", (q) =>
          q.eq("orgId", args.orgId).eq("email", email),
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name: owner.name,
          title: owner.title ?? existing.title,
          // Persist the CRM owner id even when the owner merged onto an
          // existing Clerk user by email — owner suggestions key on this.
          crmOwnerId: owner.crmOwnerId,
          isActive: true,
        });
        ownerMap[owner.crmOwnerId] = existing._id;
        results.updated++;
        continue;
      }

      const userId = await ctx.db.insert("users", {
        clerkUserId: `${PROVIDER}:${args.orgId}:${owner.crmOwnerId}`,
        orgId: args.orgId,
        email,
        name: owner.name,
        title: owner.title,
        crmOwnerId: owner.crmOwnerId,
        role: "rep",
        isActive: true,
        createdAt: now,
      });
      ownerMap[owner.crmOwnerId] = userId;
      results.created++;
    }

    return { ...results, ownerMap };
  },
});

export const upsertAccounts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accounts: v.array(
      v.object({
        crmId: v.string(),
        name: v.string(),
        domain: v.optional(v.string()),
        industry: v.optional(v.string()),
        employeeCount: v.optional(v.number()),
        annualRevenue: v.optional(v.number()),
        crmOwnerId: v.optional(v.string()),
        ownerId: v.optional(v.id("users")),
        rawData: v.optional(v.any()),
        // A portal import's custom property values, as Canon values.
        extra: v.optional(v.record(v.string(), extraValue)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Return the crmId -> docId mapping as an ARRAY, not an object: Convex caps
    // a value at 1024 fields, and orgs can have far more accounts (this broke at
    // 1189). The caller rebuilds a lookup in the action runtime (no field cap).
    const accountEntries: Array<{ crmId: string; id: string }> = [];
    let synced = 0;

    const syncAccount = async (account: (typeof args.accounts)[number]) => {
      const existing = await ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId_crmId", (q) =>
          q.eq("orgId", args.orgId).eq("crmId", account.crmId),
        )
        .first();

      const hasManualOwnerOverride =
        typeof existing?.rawData === "object" &&
        existing.rawData !== null &&
        ["manual", "territory_rule"].includes(
          existing.rawData.accountAssignmentSource,
        );
      const manualAssignmentMetadata = hasManualOwnerOverride
        ? {
            accountAssignmentSource: existing.rawData.accountAssignmentSource,
            accountAssignmentUpdatedAt: existing.rawData.accountAssignmentUpdatedAt,
            accountAssignmentUpdatedBy: existing.rawData.accountAssignmentUpdatedBy,
            planningTerritoryId: existing.rawData.planningTerritoryId,
            planningTerritoryName: existing.rawData.planningTerritoryName,
            planningTerritoryAppliedAt: existing.rawData.planningTerritoryAppliedAt,
          }
        : {};
      const syncedRawData =
        typeof account.rawData === "object" && account.rawData !== null
          ? account.rawData
          : {};

      const value = {
        provider: PROVIDER,
        name: account.name,
        domain: account.domain,
        industry: account.industry,
        employeeCount: account.employeeCount,
        annualRevenue: account.annualRevenue,
        ownerId: hasManualOwnerOverride ? existing.ownerId : account.ownerId,
        crmOwnerId: account.crmOwnerId,
        rawData: {
          ...syncedRawData,
          ...manualAssignmentMetadata,
        },
        lastSyncAt: now,
      };

      let accountId = existing?._id;
      if (accountId) {
        await ctx.db.patch(accountId, value);
      } else {
        accountId = await ctx.db.insert("crmAccounts", {
          orgId: args.orgId,
          crmId: account.crmId,
          ...value,
          createdAt: now,
        });
      }
      accountEntries.push({ crmId: account.crmId, id: accountId });
      const saved = await ctx.db.get(accountId);
      if (saved) await saveCrmAccount(ctx, saved, account.extra);
      synced++;
    };
    // Rows past the transaction's facts-read budget go back to the action, which resubmits them.
    const { unprocessed } = await syncPartyBatch(args.accounts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncAccount });

    return { synced, accounts: accountEntries, unprocessed: unprocessed.map((a) => a.crmId) };
  },
});

export const upsertContacts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    contacts: v.array(
      v.object({
        crmId: v.string(),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        title: v.optional(v.string()),
        accountId: v.optional(v.id("crmAccounts")),
        crmOwnerId: v.optional(v.string()),
        ownerId: v.optional(v.id("users")),
        rawData: v.optional(v.any()),
        // A portal import's further values (lifecycle stage, lead status), as Canon values.
        extra: v.optional(v.record(v.string(), extraValue)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let synced = 0;

    const syncContact = async (contact: (typeof args.contacts)[number]) => {
      const existing = await ctx.db
        .query("crmContacts")
        .withIndex("by_orgId_crmId", (q) =>
          q.eq("orgId", args.orgId).eq("crmId", contact.crmId),
        )
        .first();

      const value = {
        provider: PROVIDER,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email?.toLowerCase(),
        phone: contact.phone,
        title: contact.title,
        accountId: contact.accountId,
        ownerId: contact.ownerId,
        crmOwnerId: contact.crmOwnerId,
        rawData: contact.rawData,
        lastSyncAt: now,
      };

      let contactId = existing?._id;
      if (contactId) {
        await ctx.db.patch(contactId, value);
      } else {
        contactId = await ctx.db.insert("crmContacts", {
          orgId: args.orgId,
          crmId: contact.crmId,
          ...value,
          createdAt: now,
        });
      }
      const saved = await ctx.db.get(contactId);
      if (saved) await saveCrmContact(ctx, saved, contact.extra);
      synced++;
    };
    const { unprocessed } = await syncPartyBatch(args.contacts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncContact });

    return { synced, unprocessed: unprocessed.map((c) => c.crmId) };
  },
});

export const upsertDeals = internalMutation({
  args: {
    orgId: v.id("organizations"),
    deals: v.array(
      v.object({
        crmId: v.string(),
        name: v.string(),
        amount: v.optional(v.number()),
        closeDate: v.string(),
        dealType: v.union(
          v.literal("new_business"),
          v.literal("expansion"),
          v.literal("renewal"),
          v.literal("one_time"),
        ),
        revenueType: v.union(v.literal("one_time"), v.literal("recurring")),
        primaryRepId: v.optional(v.id("users")),
        crmOwnerId: v.optional(v.string()),
        accountId: v.optional(v.id("crmAccounts")),
        stage: v.optional(v.string()),
        forecastCategory: v.optional(
          v.union(
            v.literal("omit"),
            v.literal("pipeline"),
            v.literal("best_case"),
            v.literal("commit"),
            v.literal("closed_won"),
            v.literal("closed_lost"),
          ),
        ),
        probability: v.optional(v.number()),
        isClosed: v.boolean(),
        isWon: v.boolean(),
        closedAt: v.optional(v.number()),
        rawData: v.optional(v.any()),
        // When the deal was created in HubSpot.
        createdAt: v.optional(v.number()),
        // A portal import's custom property values (a deal field holds one value).
        extra: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results = { created: 0, updated: 0, skipped: 0 };

    for (const deal of args.deals) {
      // Ownerless deals sync into the mirror (the audit flags them and the
      // deal.assign_owners plan proposes owners); only a rep from ANOTHER org
      // is rejected.
      if (deal.primaryRepId) {
        const rep = await ctx.db.get(deal.primaryRepId);
        if (!rep || rep.orgId !== args.orgId) {
          results.skipped++;
          continue;
        }
      }

      const existing = await ctx.db
        .query("deals")
        .withIndex("by_orgId_crmId", (q) =>
          q.eq("orgId", args.orgId).eq("crmId", deal.crmId),
        )
        .first();

      const value = {
        name: deal.name,
        amount: deal.amount,
        currency: "USD",
        closeDate: deal.closeDate,
        dealType: deal.dealType,
        revenueType: deal.revenueType,
        primaryRepId: deal.primaryRepId,
        crmOwnerId: deal.crmOwnerId,
        accountId: deal.accountId,
        stage: deal.stage,
        forecastCategory: deal.forecastCategory,
        probability: deal.probability,
        crmProvider: PROVIDER,
        crmUrl: `https://app.hubspot.com/contacts/deal/${deal.crmId}`,
        rawData: deal.rawData,
        isClosed: deal.isClosed,
        isWon: deal.isWon,
        closedAt: deal.closedAt,
        lastSyncAt: now,
        updatedAt: now,
        ...(deal.createdAt !== undefined ? { createdAt: deal.createdAt } : {}),
      };

      let dealId;
      if (existing) {
        await ctx.db.patch(existing._id, value);
        dealId = existing._id;
        results.updated++;
      } else {
        dealId = await ctx.db.insert("deals", {
          orgId: args.orgId,
          crmId: deal.crmId,
          createdAt: now,
          ...value,
        });
        results.created++;
      }
      // Deal ledger: record what hubspot says; the row ends as the projection.
      const row = await ctx.db.get(dealId);
      if (row) await saveDeal(ctx, row, { kind: "hubspot", crmId: deal.crmId, rawData: deal.rawData }, SYNCED_DEAL_ATTRIBUTES, now);
      // Custom values carry no snapshot time, so the snapshot just written cannot refuse them (canon.ts saveCrmContact).
      if (row && deal.extra && Object.keys(deal.extra).length) await saveDealValues(ctx, row, { kind: "hubspot", crmId: deal.crmId }, deal.extra as DealValues, { now });
    }

    return results;
  },
});
