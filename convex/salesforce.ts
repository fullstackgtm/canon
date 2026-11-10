import { ConvexError, v, type Infer } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type DatabaseReader,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap, scopeUserToActiveOrg } from "./lib";
import { crmAccountEntity, crmContactEntity, dealEntity, partySyncHasBudget, saveCrmAccount, saveCrmContact, saveDeal, SYNCED_DEAL_ATTRIBUTES } from "./canon";
import { shardOf } from "./lib/objects/write";
import { syncPartyBatch } from "./lib/canon/partyLedger";
import { NOT_WRITTEN, SYNC_STAMP_MS, syncFingerprint, unchangedRow } from "./lib/syncUnchanged";
import { decryptFromStorage, encryptForStorage } from "./lib/tokenHelpers";

const PROVIDER = "salesforce";
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
      authMethod: integration.clientCredentials ? ("key" as const) : ("oauth" as const),
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
    codeVerifier: v.string(),
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
    if (!record.userId || !record.codeVerifier) return null;

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
    instanceUrl: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.optional(v.array(v.string())),
    displayName: v.optional(v.string()),
    externalOrgId: v.optional(v.string()),
    externalOrgDomain: v.optional(v.string()),
    // JSON of a key connection's SalesforceClientCredentials; omitted for OAuth, which drops any stored key.
    clientCredentials: v.optional(v.string()),
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
      instanceUrl: args.instanceUrl,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes: args.scopes,
      clientCredentials: args.clientCredentials ? await encryptForStorage(args.clientCredentials) : undefined,
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
      await ctx.scheduler.runAfter(0, internal.salesforceActions.syncAllInternal, {
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

    await ctx.scheduler.runAfter(0, internal.salesforceActions.syncAllInternal, {
      orgId: args.orgId,
      trigger: "oauth",
    });

    return integrationId;
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
      lastSyncError: args.error,
      updatedAt: Date.now(),
    };
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

// The signed-in member who may connect Salesforce (getCurrentUser, which a local stack's dev user also passes).
export const connector = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await requireCap(ctx, "integrations.manage");
    return { orgId: user.orgId, userId: user._id };
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

    if (!integration) throw new ConvexError("No Salesforce integration found");
    return {
      instanceUrl: integration.instanceUrl,
      refreshToken: integration.refreshToken,
    };
  },
});

export const disconnectWithRevocation = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    const integration: { instanceUrl?: string; refreshToken?: string } =
      await ctx.runQuery(internal.salesforce.getDisconnectTarget, {});

    if (integration.refreshToken && integration.instanceUrl) {
      try {
        const refreshToken = await decryptFromStorage(integration.refreshToken);
        // A key connection has no refresh token to revoke; the admin revokes the app in Salesforce.
        if (!refreshToken) throw new Error("No refresh token to revoke");
        const response = await fetch(
          `${integration.instanceUrl.replace(/\/$/, "")}/services/oauth2/revoke`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken }),
          },
        );
        if (!response.ok) {
          throw new Error(`Salesforce revocation failed with ${response.status}`);
        }
      } catch {
        // Best-effort provider revocation; local disconnect must still complete.
      }
    }

    await ctx.runMutation(api.salesforce.disconnect, {});
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

    if (!integration) throw new ConvexError("No Salesforce integration found");
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
        isActive: v.boolean(),
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
          isActive: owner.isActive,
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
        isActive: owner.isActive,
        createdAt: now,
      });
      ownerMap[owner.crmOwnerId] = userId;
      results.created++;
    }

    return { ...results, ownerMap };
  },
});

// A sync's rows, as the action maps them from Salesforce (salesforceActions.ts writeSyncPage). Mirrors the HubSpot
// sync's rows (hubspot.ts): people and deals name their account by Salesforce id, resolved here.
const syncAccountRow = v.object({
  crmId: v.string(),
  name: v.string(),
  domain: v.optional(v.string()),
  industry: v.optional(v.string()),
  employeeCount: v.optional(v.number()),
  annualRevenue: v.optional(v.number()),
  crmOwnerId: v.optional(v.string()),
  ownerId: v.optional(v.id("users")),
  rawData: v.optional(v.any()),
});

const syncContactRow = v.object({
  crmId: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  title: v.optional(v.string()),
  accountId: v.optional(v.id("crmAccounts")),
  // The account's Salesforce id, resolved here when accountId is not given (a sync page holds no account ids).
  accountCrmId: v.optional(v.string()),
  crmOwnerId: v.optional(v.string()),
  ownerId: v.optional(v.id("users")),
  rawData: v.optional(v.any()),
});

const syncDealRow = v.object({
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
  accountCrmId: v.optional(v.string()),
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
});

/** The mirror account of each Salesforce account id a batch names, read once per id (rows may ask at once). */
function accountResolver(ctx: { db: DatabaseReader }, orgId: Id<"organizations">) {
  const seen = new Map<string, Promise<Id<"crmAccounts"> | undefined>>();
  return (crmId: string | undefined) => {
    if (!crmId) return Promise.resolve(undefined);
    if (!seen.has(crmId)) {
      seen.set(crmId, ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", crmId)).first().then((row) => row?._id));
    }
    return seen.get(crmId)!;
  };
}

/** What a sync writes to an account's mirror row. An owner a person or territory rule assigned stays. */
function accountSyncValue(existing: Doc<"crmAccounts"> | null, account: Infer<typeof syncAccountRow>, now: number) {
  const hasManualOwnerOverride =
    typeof existing?.rawData === "object" &&
    existing.rawData !== null &&
    ["manual", "territory_rule"].includes(existing.rawData.accountAssignmentSource);
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
  const syncedRawData = typeof account.rawData === "object" && account.rawData !== null ? account.rawData : {};
  return {
    provider: PROVIDER,
    name: account.name,
    domain: account.domain,
    industry: account.industry,
    employeeCount: account.employeeCount,
    annualRevenue: account.annualRevenue,
    ownerId: hasManualOwnerOverride ? existing.ownerId : account.ownerId,
    crmOwnerId: account.crmOwnerId,
    rawData: { ...syncedRawData, ...manualAssignmentMetadata },
    lastSyncAt: now,
  };
}

/** What a sync writes to a person's mirror row. */
function contactSyncValue(contact: Infer<typeof syncContactRow>, accountId: Id<"crmAccounts"> | undefined, now: number) {
  return {
    provider: PROVIDER,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email?.toLowerCase(),
    phone: contact.phone,
    title: contact.title,
    accountId,
    ownerId: contact.ownerId,
    crmOwnerId: contact.crmOwnerId,
    rawData: contact.rawData,
    lastSyncAt: now,
  };
}

/**
 * What a sync writes to a deal's row, before the ledger projects it. The owner is not among them: it goes through the
 * ledger (saveDeal's `ownerId`), which leaves an owner a person chose as it is (lib/canon/personHold.ts).
 */
function dealSyncValue(deal: Infer<typeof syncDealRow>, accountId: Id<"crmAccounts"> | undefined, instanceUrl: string, now: number) {
  return {
    name: deal.name,
    amount: deal.amount,
    currency: "USD",
    closeDate: deal.closeDate,
    dealType: deal.dealType,
    revenueType: deal.revenueType,
    crmOwnerId: deal.crmOwnerId,
    accountId,
    stage: deal.stage,
    forecastCategory: deal.forecastCategory,
    probability: deal.probability,
    crmProvider: PROVIDER,
    crmUrl: `${instanceUrl}/lightning/r/Opportunity/${deal.crmId}/view`,
    rawData: deal.rawData,
    isClosed: deal.isClosed,
    isWon: deal.isWon,
    closedAt: deal.closedAt,
    lastSyncAt: now,
    updatedAt: now,
  };
}

/** The fingerprint of what a sync last sent for a deal, the owner included: the same as before the owner left the row's patch. */
const dealSyncHash = (deal: Infer<typeof syncDealRow>, value: ReturnType<typeof dealSyncValue>) => syncFingerprint({ ...value, primaryRepId: deal.primaryRepId });

/** A sync's unchanged rows: their Salesforce ids, and the rows among them whose daily sync time is due. */
type UnchangedRows<T extends "crmAccounts" | "crmContacts" | "deals"> = { unchanged: string[]; stamp: Array<Id<T>> };


/** `stampAll`: a full sync stamps every row it sees, so a deal it did not see reads as gone (dealTotalsPage). */
function unchangedRows<T extends "crmAccounts" | "crmContacts" | "deals">(stampAll = false) {
  const out: UnchangedRows<T> = { unchanged: [], stamp: [] };
  return {
    out,
    add(crmId: string, row: { _id: Id<T>; lastSyncAt?: number }, now: number) {
      out.unchanged.push(crmId);
      if (stampAll || now - (row.lastSyncAt ?? 0) > SYNC_STAMP_MS) out.stamp.push(row._id);
    },
  };
}

/*
 * Which of a sync's rows would change nothing (lib/syncUnchanged.ts), asked before the upsert, as the HubSpot sync
 * does (hubspot.ts unchangedAccounts): queries, so the action sorts many batches at once while only the rows that
 * change wait for its write slot. The upserts still check every row they are given.
 */
export const unchangedAccounts = internalQuery({
  args: { orgId: v.id("organizations"), accounts: v.array(syncAccountRow) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = unchangedRows<"crmAccounts">();
    await Promise.all(args.accounts.map(async (account) => {
      const existing = await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", account.crmId)).first();
      if (existing && existing.lastSyncAt !== NOT_WRITTEN && unchangedRow(existing, accountSyncValue(existing, account, now))) rows.add(account.crmId, existing, now);
    }));
    return rows.out;
  },
});

export const unchangedContacts = internalQuery({
  args: { orgId: v.id("organizations"), contacts: v.array(syncContactRow) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = unchangedRows<"crmContacts">();
    const accountOf = accountResolver(ctx, args.orgId);
    await Promise.all(args.contacts.map(async (contact) => {
      const [existing, accountId] = await Promise.all([
        ctx.db.query("crmContacts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", contact.crmId)).first(),
        contact.accountId ? Promise.resolve(contact.accountId) : accountOf(contact.accountCrmId),
      ]);
      if (existing && existing.lastSyncAt !== NOT_WRITTEN && unchangedRow(existing, contactSyncValue(contact, accountId, now))) rows.add(contact.crmId, existing, now);
    }));
    return rows.out;
  },
});

export const unchangedDeals = internalQuery({
  args: { orgId: v.id("organizations"), instanceUrl: v.string(), deals: v.array(syncDealRow), stampAll: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = unchangedRows<"deals">(args.stampAll);
    const accountOf = accountResolver(ctx, args.orgId);
    const repOrg = new Map<string, Promise<string | undefined>>();
    await Promise.all(args.deals.map(async (deal) => {
      // A rep from another org is the upsert's to skip and count.
      if (deal.primaryRepId) {
        const rep = deal.primaryRepId;
        if (!repOrg.has(rep)) repOrg.set(rep, ctx.db.get(rep).then((u) => u?.orgId));
        if ((await repOrg.get(rep)) !== args.orgId) return;
      }
      const [existing, accountId] = await Promise.all([
        ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", deal.crmId)).first(),
        deal.accountId ? Promise.resolve(deal.accountId) : accountOf(deal.accountCrmId),
      ]);
      if (existing && existing.syncHash === dealSyncHash(deal, dealSyncValue(deal, accountId, args.instanceUrl, now))) rows.add(deal.crmId, existing, now);
    }));
    return rows.out;
  },
});

/** Stamp the sync time on unchanged rows (they write nothing else, so this never waits for the sync's write slot). */
export const stampSynced = internalMutation({
  args: { ids: v.array(v.union(v.id("crmAccounts"), v.id("crmContacts"), v.id("deals"))) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    for (const id of ids) if (await ctx.db.get(id)) await ctx.db.patch(id, { lastSyncAt: now });
  },
});

export const upsertAccounts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accounts: v.array(syncAccountRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let synced = 0;
    let created = 0;

    const syncAccount = async (account: (typeof args.accounts)[number]) => {
      const existing = await ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", account.crmId))
        .first();
      const value = accountSyncValue(existing, account, now);

      // An unchanged account writes nothing to the ledger; its sync time is stamped at most daily (lib/syncUnchanged.ts).
      const written = existing && existing.lastSyncAt !== NOT_WRITTEN;
      if (written && unchangedRow(existing, value)) {
        if (now - existing.lastSyncAt > SYNC_STAMP_MS) await ctx.db.patch(existing._id, { lastSyncAt: now });
        synced++;
        return;
      }
      let accountId = existing?._id;
      if (accountId) {
        if (!written) created++;
        await ctx.db.patch(accountId, value);
      } else {
        created++;
        accountId = await ctx.db.insert("crmAccounts", { orgId: args.orgId, crmId: account.crmId, ...value, createdAt: now });
      }
      const saved = await ctx.db.get(accountId);
      // The `facts` mirror follows from its queue, off this transaction (convex/canon.ts queuePartyMirror).
      if (saved) await saveCrmAccount(ctx, saved, {}, { deferMirror: true });
      synced++;
    };
    // Rows past the transaction's facts-read budget go back to the action, which resubmits them.
    const { unprocessed } = await syncPartyBatch(args.accounts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncAccount });

    return { synced, created, unprocessed: unprocessed.map((a) => a.crmId) };
  },
});

/**
 * The ledger shard each of a sync's accounts will be written on (lib/objects/write.ts shardOf), as prepareContacts for
 * people: the action writes accounts of different shards at once. An account new to the mirror gets its row here with
 * no sync time (NOT_WRITTEN) until upsertAccounts writes it, so an account whose write never ran is written by the
 * next sync.
 */
export const prepareAccounts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accounts: v.array(syncAccountRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const shards: Array<{ crmId: string; shard: number | null }> = [];
    for (const account of args.accounts) {
      const existing = await ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", account.crmId))
        .first();
      const value = accountSyncValue(existing, account, now);
      const row = existing
        ? { ...existing, ...value }
        : await ctx.db.get(await ctx.db.insert("crmAccounts", { orgId: args.orgId, crmId: account.crmId, ...value, lastSyncAt: NOT_WRITTEN, createdAt: now }));
      const entityId = row && (await crmAccountEntity(ctx, row));
      shards.push({ crmId: account.crmId, shard: entityId ? shardOf(entityId) : null });
    }
    return shards;
  },
});

/**
 * The ledger shard each of a sync's people will be written on (lib/objects/write.ts shardOf), as hubspot.ts
 * prepareContacts: the action writes people of different shards at once. A person new to the mirror gets their row
 * here with no sync time (NOT_WRITTEN) until upsertContacts writes them, so a person whose write never ran is written
 * by the next sync.
 */
export const prepareContacts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    contacts: v.array(syncContactRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const accountOf = accountResolver(ctx, args.orgId);
    const shards: Array<{ crmId: string; shard: number | null }> = [];
    for (const contact of args.contacts) {
      const value = contactSyncValue(contact, contact.accountId ?? (await accountOf(contact.accountCrmId)), now);
      const existing = await ctx.db
        .query("crmContacts")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", contact.crmId))
        .first();
      const row = existing
        ? { ...existing, ...value }
        : await ctx.db.get(await ctx.db.insert("crmContacts", { orgId: args.orgId, crmId: contact.crmId, ...value, lastSyncAt: NOT_WRITTEN, createdAt: now }));
      const entityId = row && (await crmContactEntity(ctx, row));
      shards.push({ crmId: contact.crmId, shard: entityId ? shardOf(entityId) : null });
    }
    return shards;
  },
});

export const upsertContacts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    contacts: v.array(syncContactRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let synced = 0;
    let created = 0;
    const accountOf = accountResolver(ctx, args.orgId);

    const syncContact = async (contact: (typeof args.contacts)[number]) => {
      const existing = await ctx.db
        .query("crmContacts")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", contact.crmId))
        .first();
      const value = contactSyncValue(contact, contact.accountId ?? (await accountOf(contact.accountCrmId)), now);

      const written = existing && existing.lastSyncAt !== NOT_WRITTEN;
      if (written && unchangedRow(existing, value)) {
        if (now - existing.lastSyncAt > SYNC_STAMP_MS) await ctx.db.patch(existing._id, { lastSyncAt: now });
        synced++;
        return;
      }
      let contactId = existing?._id;
      if (contactId) {
        if (!written) created++;
        await ctx.db.patch(contactId, value);
      } else {
        created++;
        contactId = await ctx.db.insert("crmContacts", { orgId: args.orgId, crmId: contact.crmId, ...value, createdAt: now });
      }
      const saved = await ctx.db.get(contactId);
      if (saved) await saveCrmContact(ctx, saved, {}, { deferMirror: true });
      synced++;
    };
    const { unprocessed } = await syncPartyBatch(args.contacts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncContact });

    return { synced, created, unprocessed: unprocessed.map((c) => c.crmId) };
  },
});

/**
 * The ledger shard each of a sync's deals will be written on, as prepareAccounts. A deal new to the mirror gets its row
 * here archived, with no sync time (NOT_WRITTEN) and no syncHash: the pipeline, reports and audits read only live deals
 * (deals.archivedAt), so a deal whose write never ran shows nowhere, and upsertDeals writes it in full and makes it
 * live. A deal whose rep is from another org gets no row; upsertDeals skips it.
 */
export const prepareDeals = internalMutation({
  args: { orgId: v.id("organizations"), instanceUrl: v.string(), deals: v.array(syncDealRow) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const accountOf = accountResolver(ctx, args.orgId);
    const repOrg = new Map<string, string | undefined>();
    const shards: Array<{ crmId: string; shard: number | null }> = [];
    for (const deal of args.deals) {
      if (deal.primaryRepId) {
        if (!repOrg.has(deal.primaryRepId)) repOrg.set(deal.primaryRepId, (await ctx.db.get(deal.primaryRepId))?.orgId);
        if (repOrg.get(deal.primaryRepId) !== args.orgId) {
          shards.push({ crmId: deal.crmId, shard: null });
          continue;
        }
      }
      const existing = await ctx.db
        .query("deals")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", deal.crmId))
        .first();
      const row = existing ?? (await ctx.db.get(await ctx.db.insert("deals", {
        orgId: args.orgId, crmId: deal.crmId, ...dealSyncValue(deal, deal.accountId ?? (await accountOf(deal.accountCrmId)), args.instanceUrl, now), lastSyncAt: NOT_WRITTEN, archivedAt: now, createdAt: now,
      })));
      const entityId = row && (await dealEntity(ctx, row, { kind: "salesforce", crmId: deal.crmId }));
      shards.push({ crmId: deal.crmId, shard: entityId ? shardOf(entityId) : null });
    }
    return shards;
  },
});

export const upsertDeals = internalMutation({
  args: {
    orgId: v.id("organizations"),
    instanceUrl: v.string(),
    deals: v.array(syncDealRow),
    // A full sync: stamp every unchanged deal's sync time (dealTotalsPage counts only deals it saw).
    stampAll: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results = { created: 0, updated: 0, skipped: 0 };
    const accountOf = accountResolver(ctx, args.orgId);
    const repOrg = new Map<string, string | undefined>();

    for (const deal of args.deals) {
      // Ownerless deals sync into the mirror (the audit flags them and the deal.assign_owners plan proposes owners);
      // only a rep from ANOTHER org is rejected.
      if (deal.primaryRepId) {
        if (!repOrg.has(deal.primaryRepId)) repOrg.set(deal.primaryRepId, (await ctx.db.get(deal.primaryRepId))?.orgId);
        if (repOrg.get(deal.primaryRepId) !== args.orgId) {
          results.skipped++;
          continue;
        }
      }

      const existing = await ctx.db
        .query("deals")
        .withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", deal.crmId))
        .first();
      const value = dealSyncValue(deal, deal.accountId ?? (await accountOf(deal.accountCrmId)), args.instanceUrl, now);

      // A deal the sync wrote with these values before writes nothing to its ledger stream; its sync time is stamped
      // at most daily.
      const syncHash = dealSyncHash(deal, value);
      if (existing && existing.syncHash === syncHash) {
        if (args.stampAll || now - (existing.lastSyncAt ?? 0) > SYNC_STAMP_MS) await ctx.db.patch(existing._id, { lastSyncAt: now });
        results.updated++;
        continue;
      }
      let dealId;
      if (existing) {
        // A deal prepareDeals made goes live with its first write.
        const prepared = existing.lastSyncAt === NOT_WRITTEN;
        await ctx.db.patch(existing._id, { ...value, syncHash, ...(prepared ? { archivedAt: undefined } : {}) });
        dealId = existing._id;
        if (prepared) results.created++;
        else results.updated++;
      } else {
        dealId = await ctx.db.insert("deals", { orgId: args.orgId, crmId: deal.crmId, ...value, createdAt: now, syncHash });
        results.created++;
      }
      // Deal ledger: record what salesforce says; the row ends as the projection.
      const row = await ctx.db.get(dealId);
      // The `facts` mirror follows from its queue, off this transaction (convex/canon.ts queuePartyMirror).
      if (row) await saveDeal(ctx, row, { kind: "salesforce", crmId: deal.crmId, rawData: deal.rawData }, SYNCED_DEAL_ATTRIBUTES, now, { deferMirror: true, owner: deal.primaryRepId ?? null });
    }

    return results;
  },
});

/** What a sync plans from: where the last one left off, and the org's counts an incremental sync adds to. */
export const syncBaseline = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", PROVIDER))
      .first();
    const org = await ctx.db.get(args.orgId);
    return { cursors: integration?.syncCursors ?? null, counts: org?.crmCounts ?? null };
  },
});

/** A sync started: until one succeeds, the next sync reads every record (lib/hubspotSyncPlan.ts). */
export const markSyncOpen = internalMutation({
  args: { orgId: v.id("organizations"), at: v.number() },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", PROVIDER))
      .first();
    if (integration) await ctx.db.patch(integration._id, { syncCursors: { ...integration.syncCursors, openSince: args.at } });
  },
});

/**
 * Record a completed sync: the next one reads records modified since `modifiedSince` (the sync's start). Only a run
 * that finished as a success records anything, and it clears only its own open mark (as hubspot.ts setSyncCursors).
 */
export const setSyncCursors = internalMutation({
  args: { orgId: v.id("organizations"), syncRunId: v.id("integrationSyncRuns"), modifiedSince: v.number(), fullSyncAt: v.optional(v.number()), mappingsKey: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.syncRunId);
    if (run?.status !== "success") return;
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", PROVIDER))
      .first();
    if (!integration) return;
    const { openSince, ...rest } = integration.syncCursors ?? {};
    const cursors = openSince === undefined || openSince === args.modifiedSince ? rest : { ...rest, openSince };
    await ctx.db.patch(integration._id, {
      syncCursors: {
        ...cursors,
        modifiedSince: args.modifiedSince,
        mappingsKey: args.mappingsKey,
        ...(args.fullSyncAt !== undefined ? { fullSyncAt: args.fullSyncAt } : {}),
      },
    });
  },
});

/** The domain and name of each mirror account a page of people names, for the register's links (lib/crmLinks.ts). */
export const accountsByCrmIds = internalQuery({
  args: { orgId: v.id("organizations"), crmIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all([...new Set(args.crmIds)].map((crmId) =>
      ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first()));
    return rows.flatMap((row) => (row ? [{ crmId: row.crmId, domain: row.domain, name: row.name }] : []));
  },
});

/**
 * One page of the org's Salesforce deals, totalled for organizations.crmCounts (rows carry rawData, so pages stay
 * small). A full sync stamps every deal it reads, so a deal not synced since `seenSince` (the last full sync's start)
 * was not in Salesforce then: deleted there, it no longer counts.
 */
export const dealTotalsPage = internalQuery({
  args: { orgId: v.id("organizations"), cursor: v.union(v.string(), v.null()), seenSince: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("deals").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).paginate({ cursor: args.cursor, numItems: 500 });
    const totals = { deals: 0, openDeals: 0, openPipeline: 0, wonRevenue: 0, unownedDeals: 0 };
    for (const deal of page.page) {
      if (deal.crmProvider !== PROVIDER) continue;
      if (args.seenSince !== undefined && (deal.lastSyncAt ?? 0) < args.seenSince) continue;
      totals.deals++;
      if (!deal.isClosed) {
        totals.openDeals++;
        totals.openPipeline += deal.amount ?? 0;
      }
      if (deal.isWon) totals.wonRevenue += deal.amount ?? 0;
      if (!deal.primaryRepId) totals.unownedDeals++;
    }
    return { totals, cursor: page.isDone ? null : page.continueCursor };
  },
});

/**
 * One page of the org's users by email, so each sync step maps Salesforce owners to users as upsertOwners did: by
 * email, which keeps every Salesforce user that shares one (users.crmOwnerId holds only the last).
 */
export const ownerMapPage = internalQuery({
  args: { orgId: v.id("organizations"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).paginate({ cursor: args.cursor, numItems: 1000 });
    return {
      users: page.page.flatMap((u) => (u.email ? [{ email: u.email.toLowerCase(), userId: u._id }] : [])),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
