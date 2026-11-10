import { ConvexError, v } from "convex/values";
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
import { crmContactEntity, partySyncHasBudget, saveCrmAccount, saveCrmContact, saveDeal, saveDealValues, SYNCED_DEAL_ATTRIBUTES } from "./canon";
import { shardOf } from "./lib/objects/write";
import type { DealValues } from "./lib/canon/dealLedger";

import { syncPartyBatch } from "./lib/canon/partyLedger";
import { NOT_WRITTEN, SYNC_STAMP_MS } from "./lib/syncUnchanged";
import { syncAccountRow, syncContactRow, syncDealRow, accountSyncValue, contactSyncValue, dealSyncHash, dealSyncValue, accountUnchanged, contactUnchanged, dealUnchanged } from "./lib/hubspotSyncValue";
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

/** The portal's list cursor is not a record id (lib/hubspotSlices.ts): its full syncs read each object in one cursor. */
export const markOneCursor = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", PROVIDER))
      .first();
    if (integration) await ctx.db.patch(integration._id, { syncCursors: { ...integration.syncCursors, oneCursor: true } });
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
 * that finished as a success records anything (a stopped one did not), and it clears only its own open mark: a newer
 * sync that started after this one released the lock keeps its own, so if it fails the next sync is still full.
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

/** The domain and name of each mirror company a page of people names, for the register's links (lib/crmLinks.ts). */
export const accountsByCrmIds = internalQuery({
  args: { orgId: v.id("organizations"), crmIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const rows = await Promise.all([...new Set(args.crmIds)].map((crmId) =>
      ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", crmId)).first()));
    return rows.flatMap((row) => (row ? [{ crmId: row.crmId, domain: row.domain, name: row.name }] : []));
  },
});

/** One page of the org's HubSpot deals, totalled for organizations.crmCounts (rows carry rawData, so pages stay small). */
export const dealTotalsPage = internalQuery({
  args: { orgId: v.id("organizations"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("deals").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).paginate({ cursor: args.cursor, numItems: 500 });
    const totals = { deals: 0, openDeals: 0, openPipeline: 0, wonRevenue: 0, unownedDeals: 0 };
    for (const deal of page.page) {
      if (deal.crmProvider !== PROVIDER) continue;
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

/** The mirror company of each HubSpot company id a batch names, read once per id (rows may ask at once). */
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

/** A sync's unchanged rows: their HubSpot ids, and the rows among them whose daily sync time is due. */
type UnchangedRows<T extends "crmAccounts" | "crmContacts" | "deals"> = { unchanged: string[]; stamp: Array<Id<T>> };

function unchangedRows<T extends "crmAccounts" | "crmContacts" | "deals">() {
  const out: UnchangedRows<T> = { unchanged: [], stamp: [] };
  return {
    out,
    add(crmId: string, row: { _id: Id<T>; lastSyncAt?: number }, now: number) {
      out.unchanged.push(crmId);
      if (now - (row.lastSyncAt ?? 0) > SYNC_STAMP_MS) out.stamp.push(row._id);
    },
  };
}

/*
 * Which of a sync's rows would change nothing (lib/syncUnchanged.ts), asked before the upsert. Queries, so the action
 * sorts many batches at once while only the rows that change wait for its one write slot (hubspotActions.ts
 * runSyncSteps); a repeat sync of an unchanged portal writes only sync times. The upserts still check every row they
 * are given, so a row that changed since it was sorted is written.
 */
export const unchangedAccounts = internalQuery({
  args: { orgId: v.id("organizations"), accounts: v.array(syncAccountRow) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = unchangedRows<"crmAccounts">();
    await Promise.all(args.accounts.map(async (account) => {
      if (account.extra) return;
      const existing = await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", account.crmId)).first();
      if (existing && accountUnchanged(existing, accountSyncValue(existing, account, now), account.extra)) rows.add(account.crmId, existing, now);
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
      if (contact.extra) return;
      const [existing, accountId] = await Promise.all([
        ctx.db.query("crmContacts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", args.orgId).eq("crmId", contact.crmId)).first(),
        contact.accountId ? Promise.resolve(contact.accountId) : accountOf(contact.accountCrmId),
      ]);
      if (existing && contactUnchanged(existing, contactSyncValue(contact, accountId, now), contact.extra)) rows.add(contact.crmId, existing, now);
    }));
    return rows.out;
  },
});

export const unchangedDeals = internalQuery({
  args: { orgId: v.id("organizations"), deals: v.array(syncDealRow) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = unchangedRows<"deals">();
    const accountOf = accountResolver(ctx, args.orgId);
    const repOrg = new Map<string, Promise<string | undefined>>();
    await Promise.all(args.deals.map(async (deal) => {
      if (deal.extra) return;
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
      if (existing && dealUnchanged(existing, deal, dealSyncValue(deal, accountId, now), deal.extra)) rows.add(deal.crmId, existing, now);
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
    // Return the crmId -> docId mapping as an ARRAY, not an object: Convex caps
    // a value at 1024 fields, and orgs can have far more accounts (this broke at
    // 1189). The caller rebuilds a lookup in the action runtime (no field cap).
    const accountEntries: Array<{ crmId: string; id: string }> = [];
    let synced = 0;
    let created = 0;

    const syncAccount = async (account: (typeof args.accounts)[number]) => {
      const existing = await ctx.db
        .query("crmAccounts")
        .withIndex("by_orgId_crmId", (q) =>
          q.eq("orgId", args.orgId).eq("crmId", account.crmId),
        )
        .first();
      const value = accountSyncValue(existing, account, now);

      // An unchanged company writes nothing to the ledger; its sync time is stamped at most daily (lib/syncUnchanged.ts).
      if (existing && accountUnchanged(existing, value, account.extra)) {
        if (now - existing.lastSyncAt > SYNC_STAMP_MS) await ctx.db.patch(existing._id, { lastSyncAt: now });
        accountEntries.push({ crmId: account.crmId, id: existing._id });
        synced++;
        return;
      }
      let accountId = existing?._id;
      if (accountId) {
        await ctx.db.patch(accountId, value);
      } else {
        created++;
        accountId = await ctx.db.insert("crmAccounts", {
          orgId: args.orgId,
          crmId: account.crmId,
          ...value,
          createdAt: now,
        });
      }
      accountEntries.push({ crmId: account.crmId, id: accountId });
      const saved = await ctx.db.get(accountId);
      // The `facts` mirror follows from its queue, off this transaction (convex/canon.ts queuePartyMirror).
      if (saved) await saveCrmAccount(ctx, saved, account.extra, { deferMirror: true });
      synced++;
    };
    // Rows past the transaction's facts-read budget go back to the action, which resubmits them.
    const { unprocessed } = await syncPartyBatch(args.accounts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncAccount });

    return { synced, created, accounts: accountEntries, unprocessed: unprocessed.map((a) => a.crmId) };
  },
});

/**
 * The ledger shard each of a sync's people will be written on (lib/objects/write.ts shardOf), by finding or creating
 * the record upsertContacts will save them to: the action writes people of different shards at once
 * (hubspotActions.ts writeSyncPage). It writes no ledger entry, so it runs beside the writes. A person new to the
 * mirror gets their row here, with no sync time (NOT_WRITTEN) until upsertContacts writes them: until then every sync
 * reads the row as changed, so a person whose write never ran is written by the next.
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
      const entityId = row && (await crmContactEntity(ctx, row, contact.extra));
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
        .withIndex("by_orgId_crmId", (q) =>
          q.eq("orgId", args.orgId).eq("crmId", contact.crmId),
        )
        .first();

      const value = contactSyncValue(contact, contact.accountId ?? (await accountOf(contact.accountCrmId)), now);

      const written = existing && existing.lastSyncAt !== NOT_WRITTEN;
      if (existing && contactUnchanged(existing, value, contact.extra)) {
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
        contactId = await ctx.db.insert("crmContacts", {
          orgId: args.orgId,
          crmId: contact.crmId,
          ...value,
          createdAt: now,
        });
      }
      const saved = await ctx.db.get(contactId);
      if (saved) await saveCrmContact(ctx, saved, contact.extra, { deferMirror: true });
      synced++;
    };
    const { unprocessed } = await syncPartyBatch(args.contacts, { hasBudget: () => partySyncHasBudget(ctx), visit: syncContact });

    return { synced, created, unprocessed: unprocessed.map((c) => c.crmId) };
  },
});

export const upsertDeals = internalMutation({
  args: {
    orgId: v.id("organizations"),
    deals: v.array(syncDealRow),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const results = { created: 0, updated: 0, skipped: 0 };
    const accountOf = accountResolver(ctx, args.orgId);
    const repOrg = new Map<string, string | undefined>();

    for (const deal of args.deals) {
      // Ownerless deals sync into the mirror (the audit flags them and the
      // deal.assign_owners plan proposes owners); only a rep from ANOTHER org
      // is rejected.
      if (deal.primaryRepId) {
        if (!repOrg.has(deal.primaryRepId)) repOrg.set(deal.primaryRepId, (await ctx.db.get(deal.primaryRepId))?.orgId);
        if (repOrg.get(deal.primaryRepId) !== args.orgId) {
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

      const value = dealSyncValue(deal, deal.accountId ?? (await accountOf(deal.accountCrmId)), now);

      // A deal the sync wrote with these values before writes nothing to its ledger stream; its sync time is stamped
      // at most daily.
      const syncHash = dealSyncHash(deal, value);
      if (existing && dealUnchanged(existing, deal, value, deal.extra)) {
        if (now - (existing.lastSyncAt ?? 0) > SYNC_STAMP_MS) await ctx.db.patch(existing._id, { lastSyncAt: now });
        results.updated++;
        continue;
      }
      let dealId;
      if (existing) {
        await ctx.db.patch(existing._id, { ...value, syncHash });
        dealId = existing._id;
        results.updated++;
      } else {
        dealId = await ctx.db.insert("deals", {
          orgId: args.orgId,
          crmId: deal.crmId,
          createdAt: now,
          ...value,
          syncHash,
        });
        results.created++;
      }
      // Deal ledger: record what hubspot says; the row ends as the projection.
      const row = await ctx.db.get(dealId);
      // The `facts` mirror follows from its queue, off this transaction (convex/canon.ts queuePartyMirror).
      if (row) await saveDeal(ctx, row, { kind: "hubspot", crmId: deal.crmId, rawData: deal.rawData }, SYNCED_DEAL_ATTRIBUTES, now, { deferMirror: true, owner: deal.primaryRepId ?? null });
      // Custom values carry no snapshot time, so the snapshot just written cannot refuse them (canon.ts saveCrmContact).
      if (row && deal.extra && Object.keys(deal.extra).length) await saveDealValues(ctx, row, { kind: "hubspot", crmId: deal.crmId }, deal.extra as DealValues, { now, deferMirror: true });
    }

    return results;
  },
});
