"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import type { FieldMappings } from "./lib/crmMappings";
import { createHubspotConnector, hubspotTokenScopes, missingHubspotScopes } from "../engine/src/index.ts";
import type { HubspotSyncPage, HubspotWritableConnector } from "../engine/src/connectors/hubspot.ts";
import type { CanonicalAccount, CanonicalContact, CanonicalDeal } from "../engine/src/types.ts";
import { CRM_SYNC_STAGES, type ProgressEmitter } from "../engine/src/progress.ts";
import { SyncRunEnded, stopIfEnded, syncRunProgressEmitter } from "./lib/syncRunProgress";
import type { Id } from "./_generated/dataModel";
import { chunk } from "./lib/collections";
import { writeInBatches } from "./lib/batchWrites";
import { shardLocks } from "./lib/shardLocks";
import { SHARDS } from "./lib/objects/write";
import { prefetchPages, writeInOrder } from "./lib/pagePrefetch";
import { mergeSlice, planSlices, readSlicePage, SliceCursorUnsupported, sliceRanks, type SyncSlice } from "./lib/hubspotSlices";
import { crmContactLinks, linkCrmContacts } from "./lib/crmLinks";
import { clientFor } from "./records";
import { mirrorAccount, mirrorContact, mirrorDeal } from "./lib/hubspotMirror";
import { mappingsKey, planHubspotSync } from "./lib/hubspotSyncPlan";
import { nextRate, RATE_MIN_INTERVAL_MS, type RateSample } from "./lib/syncObjectProgress";
import { fixtureFetch } from "./lib/hubspotFixture";
import { activeClerkOrgIdFromIdentity } from "./lib";

const HS_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HS_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
// Must match the "FullStackGTM CLI" public app's requiredScopes exactly
// (portal 244977247, project fullstackgtm-oauth). NOTE: no tasks/engagements
// scope — neither legacy `contacts` nor granular tasks/engagements scope
// names are authorizable for new-platform public apps, so hosted-connected
// HubSpot cannot create_task (BYO private-app token covers that).
const HS_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.owners.read",
  "crm.schemas.contacts.read",
  "crm.schemas.companies.read",
  "crm.schemas.deals.read",
];

/**
 * Asked for as optional scopes (CP12): the portal import reads logged emails (`sales-email-read`) and note
 * attachments (`files`) with them, and skips those, saying so on the import screen, when the app or the token
 * lacks them. Calls, meetings, notes and tasks read under the contacts scope above. Each must also be added to the
 * HubSpot app's optional scopes, a step in HubSpot's developer portal.
 */
export const HS_OPTIONAL_SCOPES = ["sales-email-read", "files"];

type SyncCounts = {
  owners: number;
  accounts: number;
  contacts: number;
  deals: number;
  createdDeals: number;
  updatedDeals: number;
  skippedDeals: number;
  /** Whether this sync read every record or only those modified since the last. */
  mode?: "full" | "incremental";
  /** The sync goes on in scheduled steps; its run shows the progress. */
  continuing?: boolean;
};

type ExchangeResult =
  | { success: true; cliLogin: boolean }
  | { error: "invalid_state" | "token_exchange_failed" | "incomplete_token_response" };

type ConsumedOAuthState = {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  codeVerifier?: string;
  cliAuthRequestId?: Id<"cliAuthRequests">;
  cliAuthDeviceCodeHash?: string;
} | null;

type HubSpotAccountInfo = {
  portalId?: number;
  accountType?: string;
  timeZone?: string;
  companyCurrency?: string;
  additionalCurrencies?: string[];
  uiDomain?: string;
  domain?: string;
  portalDomain?: string;
  dataHostingLocation?: string;
};

function hubspotConnectionMetadata(info: HubSpotAccountInfo) {
  const portal = info.portalId ? String(info.portalId) : undefined;
  const domain = info.domain ?? info.portalDomain ?? info.uiDomain;
  return {
    displayName: `HubSpot — ${domain ?? (portal ? `portal ${portal}` : "connected account")}`,
    externalOrgId: portal,
    externalOrgDomain: domain,
  };
}

function hubspotFallbackMetadata(integration?: {
  externalOrgId?: string;
  externalOrgDomain?: string;
} | null) {
  return {
    displayName: integration?.externalOrgDomain
      ? `HubSpot — ${integration.externalOrgDomain}`
      : integration?.externalOrgId
        ? `HubSpot — portal ${integration.externalOrgId}`
        : "HubSpot",
  };
}

async function fetchHubSpotAccountInfo(accessToken: string): Promise<HubSpotAccountInfo | null> {
  try {
    const response = await (fixtureFetch(accessToken) ?? fetch)("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as HubSpotAccountInfo;
  } catch (error) {
    console.warn("HubSpot account metadata fetch failed", error);
    return null;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConvexError(`${name} is not configured`);
  return value;
}

function callbackUrl(): string {
  return `${requiredEnv("CONVEX_SITE_URL").replace(/\/$/, "")}/api/hubspot/callback`;
}

function randomState(): string {
  const stateBytes = new Uint8Array(32);
  crypto.getRandomValues(stateBytes);
  return Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function accessTokenForOrg(
  ctx: any,
  orgId: Id<"organizations">,
): Promise<{ accessToken: string; fieldMappings: FieldMappings | undefined }> {
  const integration = await ctx.runQuery(internal.hubspot.getIntegration, {
    orgId,
  });
  if (!integration || !integration.isActive) {
    throw new ConvexError("No active HubSpot integration");
  }

  let accessToken = await decryptFromStorage(integration.accessToken);
  if (
    integration.tokenExpiresAt &&
    Date.now() > integration.tokenExpiresAt - 5 * 60 * 1000
  ) {
    const refreshed = await refreshAccessTokenForOrg(ctx, orgId);
    accessToken = refreshed.accessToken;
  }

  return {
    accessToken,
    fieldMappings: integration.fieldMappings as FieldMappings | undefined,
  };
}

function hubspotConnectorFromCredentials(
  accessToken: string,
  fieldMappings: FieldMappings | undefined,
  onProgress?: (progress: { objectType: string; fetched: number }) => void,
): ReturnType<typeof createHubspotConnector> {
  const fetchImpl = fixtureFetch(accessToken);
  return createHubspotConnector({
    getAccessToken: () => accessToken,
    fieldMappings,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

export async function connectorForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  onProgress?: (progress: { objectType: string; fetched: number }) => void,
): Promise<ReturnType<typeof createHubspotConnector>> {
  const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, orgId);
  return hubspotConnectorFromCredentials(accessToken, fieldMappings, onProgress);
}

export const getAuthUrl = action({
  args: { cliUserCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    let cliAuthRequestId: Id<"cliAuthRequests"> | undefined;
    let cliAuthDeviceCodeHash: string | undefined;
    if (args.cliUserCode !== undefined) {
      const request: { _id: Id<"cliAuthRequests">; deviceCodeHash: string } | null = await ctx.runQuery(
        internal.cliAuth.getPendingOAuthRequest,
        { userCode: args.cliUserCode, provider: "hubspot" },
      );
      if (!request) throw new ConvexError("No pending HubSpot CLI login for that code");
      cliAuthRequestId = request._id;
      cliAuthDeviceCodeHash = request.deviceCodeHash;
    }

    const state = randomState();
    await ctx.runMutation(internal.hubspot.createOAuthState, {
      state,
      orgId: user.orgId,
      userId: user._id,
      cliAuthRequestId,
      cliAuthDeviceCodeHash,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
      redirect_uri: callbackUrl(),
      scope: HS_SCOPES.join(" "),
      optional_scope: HS_OPTIONAL_SCOPES.join(" "),
      state,
    });

    return { authUrl: `${HS_AUTH_URL}?${params.toString()}` };
  },
});

/**
 * Connect HubSpot with a private-app token instead of OAuth. Private-app tokens
 * are long-lived bearer tokens with no refresh, so we validate the token against
 * the account, then store it with a far-future expiry so the OAuth refresh path
 * is never taken. `storeTokens` schedules the initial sync.
 */
export const connectWithToken = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; portalId: number }> => {
    // The signed-in admin or manager (lib.ts getCurrentUser, which a local stack's dev user also passes).
    const who = await ctx.runQuery(internal.hubspotImport.importer, {});

    const token = args.token.trim();
    if (!token) throw new ConvexError("A private-app token is required");

    const info = await fetchHubSpotAccountInfo(token);
    if (!info) {
      throw new ConvexError(
        "HubSpot rejected this token. Use a private-app token with CRM read scopes (companies, contacts, deals, owners).",
      );
    }
    const scopes = await hubspotTokenScopes(token, fixtureFetch(token));
    const missing = scopes && missingHubspotScopes(scopes);
    if (missing) throw new ConvexError(missing);

    const FAR_FUTURE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
    await ctx.runMutation(internal.hubspot.storeTokens, {
      orgId: who.orgId,
      userId: who.userId,
      accessToken: token,
      refreshToken: "",
      tokenExpiresAt: FAR_FUTURE,
      scopes: scopes ?? HS_SCOPES,
      ...hubspotConnectionMetadata(info),
    });

    return { ok: true, portalId: info.portalId ?? 0 };
  },
});

// INTERNAL-ONLY: writes to the live CRM. Reachable exclusively through the
// approved patch-plan apply path (patchPlanActions.apply) — never callable
// directly from a client, so there is no unaudited path to this write.
export const patchDealNextStep = internalAction({
  args: {
    orgId: v.id("organizations"),
    crmId: v.string(),
    nextStep: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Organization not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    const connector = await connectorForOrg(ctx, args.orgId);
    const result = await connector.applyOperation!({
      id: `op_next_step_${args.crmId}`,
      objectType: "deal",
      objectId: args.crmId,
      operation: "set_field",
      field: "nextStep",
      beforeValue: null,
      afterValue: args.nextStep,
      reason: "Approved patch plan: set deal next step",
      riskLevel: "low",
      approvalRequired: true,
    });
    if (result.status !== "applied") {
      throw new ConvexError(result.detail ?? "HubSpot write failed");
    }
    const providerData = result.providerData as { id?: string; property?: string } | undefined;
    return {
      provider: "hubspot",
      crmId: args.crmId,
      field: providerData?.property,
      responseId: providerData?.id,
    };
  },
});

export const exchangeCode = action({
  args: {
    code: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args): Promise<ExchangeResult> => {
    const stateData: ConsumedOAuthState = await ctx.runMutation(internal.hubspot.consumeOAuthState, {
      state: args.state,
    });
    if (!stateData) return { error: "invalid_state" };

    const response = await fetch(HS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
        client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
        redirect_uri: callbackUrl(),
      }).toString(),
    });

    if (!response.ok) {
      console.error("HubSpot token exchange failed:", await response.text());
      return { error: "token_exchange_failed" };
    }

    const tokenData = await response.json();
    if (!tokenData.access_token || !tokenData.refresh_token) {
      return { error: "incomplete_token_response" };
    }

    const accountInfo = await fetchHubSpotAccountInfo(tokenData.access_token);

    await ctx.runMutation(internal.hubspot.storeTokens, {
      orgId: stateData.orgId,
      userId: stateData.userId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpiresAt: Date.now() + (tokenData.expires_in ?? 1800) * 1000,
      scopes: HS_SCOPES,
      ...(accountInfo
        ? hubspotConnectionMetadata(accountInfo)
        : hubspotFallbackMetadata()),
    });

    if (stateData.cliAuthRequestId && stateData.cliAuthDeviceCodeHash) {
      await ctx.runMutation(internal.cliAuth.approveOAuth, {
        cliAuthRequestId: stateData.cliAuthRequestId,
        provider: "hubspot",
        orgId: stateData.orgId,
        userId: stateData.userId,
        deviceCodeHash: stateData.cliAuthDeviceCodeHash,
      });
    }

    return { success: true, cliLogin: Boolean(stateData.cliAuthRequestId) };
  },
});

export const refreshAccessToken = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ accessToken: string }> => {
    return refreshAccessTokenForOrg(ctx, args.orgId);
  },
});

// Used by the CLI broker (cliAuthActions.mintProviderToken) to hand a
// short-lived org access token to a paired CLI.
export const getOrgAccessToken = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ accessToken: string; fieldMappings: unknown }> => {
    const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, args.orgId);
    return { accessToken, fieldMappings: fieldMappings ?? null };
  },
});

export const syncAll = action({
  // full: read every record again rather than only those modified since the last sync (Full resync).
  args: { full: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<SyncCounts> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    return syncAllForOrg(ctx, user.orgId, "manual", args.full === true);
  },
});

export const syncAllInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    trigger: v.optional(
      v.union(
        v.literal("manual"),
        v.literal("scheduled"),
        v.literal("oauth"),
        v.literal("system"),
      ),
    ),
  },
  handler: async (ctx, args): Promise<SyncCounts> => {
    return syncAllForOrg(ctx, args.orgId, args.trigger ?? "system");
  },
});

async function refreshAccessTokenForOrg(
  ctx: any,
  orgId: Id<"organizations">,
): Promise<{ accessToken: string }> {
  const integration = await ctx.runQuery(internal.hubspot.getIntegration, {
    orgId,
  });
  if (!integration) throw new ConvexError("No HubSpot integration found");

  const response = await fetch(HS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: await decryptFromStorage(integration.refreshToken),
      client_id: requiredEnv("HUBSPOT_CLIENT_ID"),
      client_secret: requiredEnv("HUBSPOT_CLIENT_SECRET"),
    }).toString(),
  });

  if (!response.ok) {
    console.error("HubSpot token refresh failed:", await response.text());
    throw new ConvexError("HubSpot token refresh failed");
  }

  const tokenData = await response.json();
  await ctx.runMutation(internal.hubspot.updateTokens, {
    integrationId: integration._id,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenExpiresAt: Date.now() + (tokenData.expires_in ?? 1800) * 1000,
  });

  return { accessToken: tokenData.access_token };
}

const SYNC_OBJECTS = ["accounts", "contacts", "deals"] as const;
type SyncObject = (typeof SYNC_OBJECTS)[number];
const HUBSPOT_OBJECT = { accounts: "companies", contacts: "contacts", deals: "deals" } as const;
const STAGE_INDEX: Record<SyncObject, number> = { accounts: 1, contacts: 2, deals: 3 };

const syncStateValidator = v.object({
  syncRunId: v.id("integrationSyncRuns"),
  orgId: v.id("organizations"),
  mode: v.union(v.literal("full"), v.literal("incremental")),
  // An incremental sync reads records modified in [since, until); `until` is when the sync started.
  since: v.optional(v.number()),
  until: v.number(),
  mappingsKey: v.string(),
  // The org's counts before an incremental sync, which adds the records it creates.
  base: v.optional(v.object({ accounts: v.number(), contacts: v.number() })),
  owners: v.array(v.object({ crmOwnerId: v.string(), userId: v.id("users") })),
  lanes: v.array(v.object({
    object: v.union(v.literal("accounts"), v.literal("contacts"), v.literal("deals")),
    // The next page's cursor: a list cursor in a full sync, the last record id read in an incremental one.
    after: v.union(v.string(), v.null()),
    done: v.boolean(),
    read: v.number(),
    total: v.optional(v.number()),
    // Records written a second, smoothed (lib/syncObjectProgress.ts); carried across steps.
    perSecond: v.optional(v.number()),
    // A full sync's id ranges, read at once (lib/hubspotSlices.ts); `after` and `done` are then theirs.
    slices: v.optional(v.array(v.object({
      after: v.union(v.string(), v.null()),
      from: v.optional(v.number()),
      end: v.optional(v.number()),
      done: v.boolean(),
      read: v.number(),
      merged: v.optional(v.boolean()),
      ended: v.optional(v.boolean()),
    }))),
  })),
  totals: v.object({
    owners: v.number(),
    accounts: v.number(),
    accountsCreated: v.number(),
    contacts: v.number(),
    contactsCreated: v.number(),
    createdDeals: v.number(),
    updatedDeals: v.number(),
    skippedDeals: v.number(),
  }),
  step: v.number(),
});
type SyncState = Infer<typeof syncStateValidator>;
type SyncLane = SyncState["lanes"][number];

// One step reads and writes until this, then hands its cursors to the next. It leaves room inside the 10-minute action
// limit for a first page that arrives late, after HubSpot retries (each lane writes one page per step regardless).
const STEP_MS = 3 * 60 * 1000;
// Account and contact upserts append to the ledger (~20 documents per new record); a batch that reaches its
// facts-read budget hands back the rest, which is resubmitted.
const PARTY_SYNC_BATCH = 100;
// Deal upserts write fact-ledger rows (~25 documents per new deal), so they use smaller batches.
const DEAL_SYNC_BATCH = 50;
// Batches a page submits at once (lib/batchWrites.ts); a batch of new records still waits for the ledger shards it takes.
const WRITE_CONCURRENCY = 3;
// Groups of ledger shards whose people are written at once (shard % groups, lib/shardLocks.ts).
const CONTACT_WRITE_GROUPS = 8;
// People linked to their companies in the register per call (lib/crmLinks.ts).
const LINK_FLUSH = 1000;
// Pages an object writes at once (each in batches, lib/batchWrites.ts).
const PAGE_WRITES = 3;
// How often a step records its objects' progress for the panel.
const OBJECTS_PUBLISH_MS = 3_000;
// Pages an object reads ahead of its writes, as people and deals wait for companies (a page is 100-200 records),
// shared among its id ranges.
const PREFETCH_PAGES = 20;
// Pages each id range of an object writes at once.
const SLICE_PAGE_WRITES = 2;

/**
 * Sync = the connector's canonical records, persisted into the mirror tables, QuotaQueue's pattern:
 *
 * - Incremental: after a complete sync, the next reads only the records modified since it started
 *   (lib/hubspotSyncPlan.ts); a full sync still runs every few days and when the field mappings change.
 * - Steps: the sync runs as a chain of actions, each reading and writing pages until STEP_MS and handing its
 *   cursors to the next (syncStep), so a large portal never meets Convex's 10-minute action limit.
 * - Pages are written as they arrive, the next page read while one writes; people and deals run side by side once
 *   companies are in, and name their company by HubSpot id, resolved as they are written.
 * - Unchanged rows write nothing (lib/syncUnchanged.ts).
 *
 * The connector owns HubSpot REST and field mapping; this owns the Convex boundary. Deals the org cannot own yet (an
 * owner from another org) are counted as skipped rather than silently dropped.
 */
async function syncAllForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  trigger: "manual" | "scheduled" | "oauth" | "system",
  full = false,
): Promise<SyncCounts> {
  const syncRunId = await ctx.runMutation(internal.integrations.startSyncRun, {
    orgId,
    provider: "hubspot",
    trigger,
  });

  await ctx.runMutation(internal.hubspot.updateSyncStatus, {
    orgId,
    status: "in_progress",
  });

  const progress = syncRunProgressEmitter(ctx, syncRunId);
  try {
    progress.note("planning the sync");
    const integration = await ctx.runQuery(internal.hubspot.getIntegration, { orgId });
    const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, orgId);
    const connector = hubspotConnectorFromCredentials(accessToken, fieldMappings);
    if (!integration?.displayName) {
      const accountInfo = await fetchHubSpotAccountInfo(accessToken);
      await ctx.runMutation(internal.hubspot.updateSyncStatus, {
        orgId,
        status: "in_progress",
        ...(accountInfo
          ? hubspotConnectionMetadata(accountInfo)
          : hubspotFallbackMetadata(integration)),
      });
    }
    // The window ends when this sync starts: anything modified after is the next sync's.
    const until = Date.now();
    const baseline = await ctx.runQuery(internal.hubspot.syncBaseline, { orgId });
    const key = mappingsKey(fieldMappings ?? null);
    const plan = planHubspotSync(baseline.cursors, { hasCounts: Boolean(baseline.counts), mappingsKey: key, now: until, full });

    await stopIfEnded(ctx, syncRunId);
    // Until this sync succeeds, the next one reads everything: records this one creates before it fails would read as
    // unchanged to an incremental sync, which would never count them.
    await ctx.runMutation(internal.hubspot.markSyncOpen, { orgId, at: until });
    progress.stage(CRM_SYNC_STAGES[0], 0, CRM_SYNC_STAGES.length); // owners
    const owners = (await connector.fetchUsers())
      .filter((user) => user.crmId && user.email)
      .map((user) => ({ crmOwnerId: user.crmId!, email: user.email!, name: user.name }));
    // Each upsert costs ~2 document ops (indexed lookup + write); a mutation caps at 4096 reads.
    const OWNER_BATCH = 400;
    const ownerMap: Record<string, Id<"users">> = {};
    for (const batch of chunk(owners, OWNER_BATCH)) {
      const ownerResult = await ctx.runMutation(internal.hubspot.upsertOwners, { orgId, owners: batch });
      Object.assign(ownerMap, ownerResult.ownerMap as Record<string, Id<"users">>);
    }

    const window = plan.mode === "incremental" ? { since: plan.since, until } : undefined;
    const totals = await Promise.all(SYNC_OBJECTS.map((object) => connector.countRecords(HUBSPOT_OBJECT[object], window)));
    // A full read splits each large object into id ranges; without its ids, it is read in one cursor.
    const bounds = plan.mode === "full" && !baseline.cursors?.oneCursor
      ? await Promise.all(SYNC_OBJECTS.map((object, i) => connector.idsAtRanks(HUBSPOT_OBJECT[object], sliceRanks(totals[i])).catch(() => [])))
      : [];
    const state: SyncState = {
      syncRunId,
      orgId,
      mode: plan.mode,
      ...(window ? { since: window.since } : {}),
      until,
      mappingsKey: key,
      ...(plan.mode === "incremental" && baseline.counts ? { base: { accounts: baseline.counts.accounts, contacts: baseline.counts.contacts } } : {}),
      owners: Object.entries(ownerMap).map(([crmOwnerId, userId]) => ({ crmOwnerId, userId })),
      lanes: SYNC_OBJECTS.map((object, i) => ({
        object, after: null, done: false, read: 0,
        ...(totals[i] !== undefined ? { total: totals[i] } : {}),
        ...(plan.mode === "full" ? { slices: planSlices(bounds[i] ?? []) } : {}),
      })),
      totals: { owners: owners.length, accounts: 0, accountsCreated: 0, contacts: 0, contactsCreated: 0, createdDeals: 0, updatedDeals: 0, skippedDeals: 0 },
      step: 0,
    };
    return await runSyncSteps(ctx, state, connector, progress);
  } catch (error) {
    return failSync(ctx, syncRunId, orgId, error);
  }
}

/** The next step of a sync too large for one action: it picks up the cursors the last step left. */
export const syncStep = internalAction({
  args: { state: syncStateValidator },
  handler: async (ctx, { state }): Promise<SyncCounts> => {
    const progress = syncRunProgressEmitter(ctx, state.syncRunId);
    try {
      const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, state.orgId);
      return await runSyncSteps(ctx, state, hubspotConnectorFromCredentials(accessToken, fieldMappings), progress);
    } catch (error) {
      return failSync(ctx, state.syncRunId, state.orgId, error);
    }
  },
});

async function runSyncSteps(ctx: any, state: SyncState, connector: HubspotWritableConnector, progress: ProgressEmitter): Promise<SyncCounts> {
  const deadline = Date.now() + STEP_MS;
  const ownerMap: Record<string, Id<"users">> = Object.fromEntries(state.owners.map((o) => [o.crmOwnerId, o.userId]));
  // A new record's ledger append takes one of the org's shard heads (convex/objects.ts nextSeq), and a batch of new
  // records takes nearly all of them, so batches written at once conflict, retry and split instead of going faster:
  // on dev, ~18 at once made people sync at ~17 a second. So upserts wait for the shards they take (lib/shardLocks.ts):
  // people, whose shards are known before they are written, in groups of shards at once; companies and deals, one
  // upsert at a time. Reads still run ahead of the writes.
  const locks = shardLocks(SHARDS);
  let shown: string | undefined;
  // Each object's progress and write rate for the panel's bars (integrationSyncRuns.objects), at most every few seconds.
  const samples = new Map<string, RateSample>(state.lanes.map((l) => [l.object, { done: l.read, at: Date.now() }]));
  let publishedAt = 0;
  // Set once a publish finds the run stopped or ended: the lanes take no further page, so a stop lands in seconds.
  const run = { ended: false };
  // A write still waiting for the slot when the run ends is not made.
  const writeSlot: WriteSlot = (task, shards) => locks(shards ?? null, () => (run.ended ? Promise.reject(new SyncRunEnded("Sync stopped")) : task()));
  const publishObjects = (force = false) => {
    const now = Date.now();
    for (const lane of state.lanes) {
      // A finished object keeps the rate it ended with.
      if (lane.done) continue;
      const prev = samples.get(lane.object)!;
      const next = { done: lane.read, at: now };
      const rate = nextRate(lane.perSecond, prev, next);
      if (rate !== lane.perSecond || next.at - prev.at >= RATE_MIN_INTERVAL_MS) {
        if (rate !== undefined) lane.perSecond = rate;
        samples.set(lane.object, next);
      }
    }
    if (!force && now - publishedAt < OBJECTS_PUBLISH_MS) return Promise.resolve();
    publishedAt = now;
    return ctx.runMutation(internal.integrations.updateRunObjects, {
      syncRunId: state.syncRunId,
      objects: state.lanes.map((l) => ({
        object: l.object, done: l.read, finished: l.done, updatedAt: now,
        ...(l.total !== undefined ? { total: l.total } : {}), ...(l.perSecond !== undefined ? { perSecond: l.perSecond } : {}),
      })),
    }).then((live: boolean) => {
      if (live === false) run.ended = true;
    }, () => undefined);
  };
  const show = () => {
    void publishObjects();
    const lane = state.lanes.find((l) => !l.done);
    if (!lane) return;
    if (lane.object !== shown) progress.stage(CRM_SYNC_STAGES[STAGE_INDEX[lane.object]], STAGE_INDEX[lane.object], CRM_SYNC_STAGES.length);
    shown = lane.object;
    progress.items(lane.read, lane.total);
  };
  // Published on a timer as well as on each page, so a stop lands while every lane waits on a slow page.
  const ticker = setInterval(() => void publishObjects(), OBJECTS_PUBLISH_MS);
  try {
    while (Date.now() < deadline && state.lanes.some((lane) => !lane.done)) {
      await stopIfEnded(ctx, state.syncRunId);
      show();
      // Every object reads at once, but people and deals name their company by HubSpot id, resolved as they are
      // written: they read ahead while companies write, and write once companies are all in.
      const accounts = state.lanes.find((lane) => lane.object === "accounts")!;
      const accountsRun = accounts.done ? Promise.resolve() : runSyncLane(ctx, state, accounts, connector, ownerMap, writeSlot, deadline, show, Promise.resolve(true), run);
      const companiesIn = accountsRun.then(() => accounts.done);
      const settled = await Promise.allSettled([
        accountsRun,
        ...state.lanes.filter((lane) => lane.object !== "accounts" && !lane.done).map((lane) => runSyncLane(ctx, state, lane, connector, ownerMap, writeSlot, deadline, show, companiesIn, run)),
      ]);
      // Rejected only once every lane has stopped writing.
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  } finally {
    clearInterval(ticker);
  }
  await publishObjects(true);
  if (state.lanes.some((lane) => !lane.done)) {
    await stopIfEnded(ctx, state.syncRunId);
    await ctx.scheduler.runAfter(0, internal.hubspotActions.syncStep, { state: { ...state, step: state.step + 1 } });
    progress.flush();
    return { ...syncCounts(state), continuing: true };
  }
  return finishSync(ctx, state, progress);
}

/**
 * Read and write one object's pages until it is done or the step's time is up. Pages are read ahead of the writes
 * (lib/pagePrefetch.ts); none is written until `ready` holds, nor after the deadline (but the first). Pages read and
 * not written are dropped, and the next step reads them again from the lane's cursor (the last page written).
 */
async function runSyncLane(
  ctx: any,
  state: SyncState,
  lane: SyncLane,
  connector: HubspotWritableConnector,
  ownerMap: Record<string, Id<"users">>,
  writeSlot: WriteSlot,
  deadline: number,
  show: () => void,
  ready: Promise<boolean>,
  run: { ended: boolean },
) {
  const object = HUBSPOT_OBJECT[lane.object];
  // Where the step's time went, logged when the lane stops: HubSpot reads or the writes.
  const time = { pages: 0, readMs: 0, writeMs: 0, rows: 0, started: Date.now() };
  const links = { accounts: new Set<string>(), contacts: [] as LinkContact[] };
  // A full sync reads a large object in id ranges at once (lib/hubspotSlices.ts); an incremental one, in one cursor.
  const slices: Array<SyncSlice | SyncLane> = lane.slices ? lane.slices.filter((s) => !s.done) : [lane];
  const ranged = slices.length > 1;
  const readCursor = async (cursor: SyncSlice | SyncLane) => {
    let lastId: number | undefined;
    const read = async (after: string | null): Promise<HubspotSyncPage<typeof object>> => {
      const at = Date.now();
      let page: HubspotSyncPage<typeof object>;
      if (state.mode === "full") {
        const slice = cursor as SyncSlice;
        // Only a bounded range relies on the cursor's id order; one cursor over the whole list reads it as HubSpot pages it.
        if (slice.from !== undefined || slice.end !== undefined) {
          try {
            const sliced = await readSlicePage(slice, after, {
              list: (at) => connector.readPage(object, at),
              firstIdFrom: (from) => connector.firstIdFrom(object, from),
              previousId: lastId,
            });
            lastId = sliced.lastId ?? lastId;
            page = { rows: sliced.rows, next: sliced.next };
          } catch (error) {
            if (!(error instanceof SliceCursorUnsupported)) throw error;
            // HubSpot's cursor does not hold as a record id: this portal's next full syncs read in one cursor.
            await ctx.runMutation(internal.hubspot.markOneCursor, { orgId: state.orgId });
            // A range refused on its first page wrote nothing: the range before it reads on through its ids.
            if (!error.firstPage || !mergeSlice(lane.slices!, slice)) {
              throw new Error(`HubSpot paged ${lane.object} out of id order (${error.message}); the next sync reads them in one cursor.`);
            }
            console.warn(`hubspot sync ${lane.object}: ids from ${slice.from} join the range before them (${error.message})`);
            page = { rows: [], next: null };
          }
        } else {
          page = await connector.readPage(object, after);
        }
      } else {
        page = await connector.readModifiedPage(object, { since: state.since!, until: state.until }, after);
      }
      time.pages++;
      time.readMs += Date.now() - at;
      return page;
    };
    const pages = prefetchPages(cursor.after, read, { max: ranged ? Math.max(3, Math.ceil(PREFETCH_PAGES / slices.length)) : PREFETCH_PAGES, until: deadline });
    try {
      if (!(await ready) || run.ended) return;
      // Past the deadline no further page is written, however many are buffered: the step must leave room to hand on
      // before the action limit. The pages read and not written are read again from the cursor.
      // The first page is written however late it arrives, so a page HubSpot is slow to serve still moves the lane on
      // instead of being dropped and read again by every step. A few pages write at once: a page of new records is
      // a few seconds of ledger writes, and the cursor moves only past pages written in full.
      await writeInOrder({
        next: () => pages.next(),
        more: (taken) => !run.ended && (taken === 0 || Date.now() < deadline),
        max: ranged ? SLICE_PAGE_WRITES : PAGE_WRITES,
        write: async (page) => {
          const at = Date.now();
          await writeSyncPage(ctx, state, lane.object, page.rows, ownerMap, writeSlot);
          time.writeMs += Date.now() - at;
          time.rows += page.rows.length;
          if (lane.object === "contacts") {
            for (const c of page.rows as CanonicalContact[]) {
              if (c.accountId) links.accounts.add(c.accountId);
              links.contacts.push({ email: c.email, firstName: c.firstName, lastName: c.lastName, accountCrmId: c.accountId });
            }
            if (links.contacts.length >= LINK_FLUSH) await linkPeople(ctx, state, links);
          }
        },
        commit: (page) => {
          cursor.after = page.next;
          cursor.read += page.rows.length;
          if (cursor !== lane) lane.read += page.rows.length;
          if (!page.next) cursor.done = true;
          if (lane.slices) lane.done = lane.slices.every((s) => s.done);
          show();
        },
      });
    } finally {
      pages.stop();
    }
  };
  try {
    // Rejected only once every range has stopped writing.
    const failed = (await Promise.allSettled(slices.map(readCursor))).find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    if (links.contacts.length) await linkPeople(ctx, state, links);
  } finally {
    const perPage = time.pages ? Math.round(time.readMs / time.pages) : 0;
    const limit = connector.rateLimitSeen();
    console.log(
      `hubspot sync step ${state.step} ${lane.object}: ${time.rows} rows written in ${Math.round((Date.now() - time.started) / 1000)}s; ` +
        `${time.pages} pages read in ${slices.length} range(s), ${perPage} ms each; page writes took ${Math.round(time.writeMs / 1000)}s` +
        (limit ? `; HubSpot window ${limit.max} per ${Math.round(limit.intervalMs / 1000)}s, ${limit.remaining} left` : ""),
    );
  }
}

type LinkContact = { email?: string; firstName?: string; lastName?: string; accountCrmId?: string };

/** Run an upsert once no earlier one holds any of `shards` (none named: any shard, so every earlier one). */
type WriteSlot = <T>(task: () => Promise<T>, shards?: readonly number[]) => Promise<T>;

async function writeSyncPage(ctx: any, state: SyncState, object: SyncObject, rows: unknown[], ownerMap: Record<string, Id<"users">>, writeSlot: WriteSlot) {
  const { orgId, totals } = state;
  if (object === "accounts") {
    await writeInBatches((rows as CanonicalAccount[]).map((account) => mirrorAccount(account, ownerMap)), {
      size: PARTY_SYNC_BATCH,
      concurrency: WRITE_CONCURRENCY,
      submit: async (rows) => {
        const batch = await changedRows(ctx, rows, internal.hubspot.unchangedAccounts, { orgId, accounts: rows });
        // Counted once the batch's upsert succeeds: a failed one is split and its rows submitted again.
        if (!batch.length) {
          totals.accounts += rows.length;
          return;
        }
        const result = await writeSlot<any>(() => ctx.runMutation(internal.hubspot.upsertAccounts, { orgId, accounts: batch }));
        const left = batch.filter((r) => result.unprocessed.includes(r.crmId));
        totals.accounts += rows.length - left.length;
        totals.accountsCreated += result.created as number;
        return left;
      },
    });
  } else if (object === "contacts") {
    const mapped = (rows as CanonicalContact[]).map((contact) => ({ ...mirrorContact(contact, ownerMap, {}), accountCrmId: contact.accountId }));
    // The people that change, by the group of ledger shards their writes take (hubspot.ts prepareContacts); null: a
    // person whose shard is not known, written alone.
    const groups = new Map<number | null, { rows: typeof mapped; shards: Set<number> }>();
    await writeInBatches(mapped, {
      size: PARTY_SYNC_BATCH,
      concurrency: WRITE_CONCURRENCY,
      submit: async (rows) => {
        const batch = await changedRows(ctx, rows, internal.hubspot.unchangedContacts, { orgId, contacts: rows });
        const shards: Array<{ crmId: string; shard: number | null }> = batch.length ? await ctx.runMutation(internal.hubspot.prepareContacts, { orgId, contacts: batch }) : [];
        const shardOf = new Map(shards.map((s) => [s.crmId, s.shard]));
        for (const row of batch) {
          const shard = shardOf.get(row.crmId) ?? null;
          const key = shard === null ? null : shard % CONTACT_WRITE_GROUPS;
          const group = groups.get(key) ?? { rows: [], shards: new Set<number>() };
          group.rows.push(row);
          if (shard !== null) group.shards.add(shard);
          groups.set(key, group);
        }
        totals.contacts += rows.length - batch.length;
      },
    });
    // Each group's upserts wait only for the groups' own shards, so the groups write at once. Every group finishes
    // before a failure is thrown: whoever sees it knows nothing of this page is still writing.
    const written = await Promise.allSettled([...groups.values()].map((group) => writeInBatches(group.rows, {
      size: PARTY_SYNC_BATCH,
      submit: async (batch) => {
        const result = await writeSlot<any>(() => ctx.runMutation(internal.hubspot.upsertContacts, { orgId, contacts: batch }), group.shards.size ? [...group.shards] : undefined);
        totals.contacts += result.synced as number;
        totals.contactsCreated += result.created as number;
        return batch.filter((r) => result.unprocessed.includes(r.crmId));
      },
    })));
    const failed = written.find((w): w is PromiseRejectedResult => w.status === "rejected");
    if (failed) throw failed.reason;
  } else {
    const today = new Date().toISOString().split("T")[0];
    // Ownerless and amountless deals both sync into the mirror: the audit flags them and patch plans propose the fixes.
    const mapped = (rows as CanonicalDeal[]).map((deal) => ({ ...mirrorDeal(deal, ownerMap, {}, today), accountCrmId: deal.accountId }));
    await writeInBatches(mapped, {
      size: DEAL_SYNC_BATCH,
      concurrency: WRITE_CONCURRENCY,
      submit: async (rows) => {
        const batch = await changedRows(ctx, rows, internal.hubspot.unchangedDeals, { orgId, deals: rows });
        if (!batch.length) {
          totals.updatedDeals += rows.length;
          return;
        }
        const result = await writeSlot<any>(() => ctx.runMutation(internal.hubspot.upsertDeals, { orgId, deals: batch }));
        totals.createdDeals += result.created as number;
        totals.updatedDeals += rows.length - batch.length + (result.updated as number);
        totals.skippedDeals += result.skipped as number;
      },
    });
  }
}

/**
 * The rows of a batch that would change something, for the write slot. The rest are sorted out by a query, many at
 * once beside the writes (convex/hubspot.ts unchangedAccounts), and only have their sync time stamped when it is due.
 */
async function changedRows<R extends { crmId: string }>(ctx: any, rows: R[], unchanged: any, args: Record<string, unknown>): Promise<R[]> {
  const sorted: { unchanged: string[]; stamp: string[] } = await ctx.runQuery(unchanged, args);
  if (sorted.stamp.length) await ctx.runMutation(internal.hubspot.stampSynced, { ids: sorted.stamp });
  const same = new Set(sorted.unchanged);
  return rows.filter((r) => !same.has(r.crmId));
}

/** The register links each person to their company, as the CRM associates them (lib/crmLinks.ts). Never fails the sync. */
async function linkPeople(ctx: any, state: SyncState, links: { accounts: Set<string>; contacts: LinkContact[] }) {
  const contacts = links.contacts.splice(0);
  const crmIds = [...links.accounts];
  links.accounts.clear();
  try {
    const accounts = await ctx.runQuery(internal.hubspot.accountsByCrmIds, { orgId: state.orgId, crmIds });
    await linkCrmContacts(clientFor(ctx), state.orgId as string, "hubspot", state.syncRunId, crmContactLinks(accounts, contacts));
  } catch (cause) {
    console.warn(`hubspot sync: linking contacts to companies in the register failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function syncCounts(state: SyncState): SyncCounts {
  const t = state.totals;
  return {
    owners: t.owners,
    accounts: t.accounts,
    contacts: t.contacts,
    deals: t.createdDeals + t.updatedDeals,
    createdDeals: t.createdDeals,
    updatedDeals: t.updatedDeals,
    skippedDeals: t.skippedDeals,
    mode: state.mode,
  };
}

async function finishSync(ctx: any, state: SyncState, progress: ProgressEmitter): Promise<SyncCounts> {
  const { orgId, syncRunId, totals } = state;
  await stopIfEnded(ctx, syncRunId);
  progress.stage(CRM_SYNC_STAGES[4], 4, CRM_SYNC_STAGES.length); // counters
  // The org's maintained aggregates (organizations.crmCounts), read by dashboard and readiness queries instead of
  // scanning 10k+ rows. A full sync saw every company and person; an incremental one adds those it created. Deal
  // totals change with any deal, so they are summed from the mirror. Amounts are cents.
  const deals = { deals: 0, openDeals: 0, openPipeline: 0, wonRevenue: 0, unownedDeals: 0 };
  let cursor: string | null = null;
  do {
    const page: { totals: typeof deals; cursor: string | null } = await ctx.runQuery(internal.hubspot.dealTotalsPage, { orgId, cursor });
    for (const k of Object.keys(deals) as Array<keyof typeof deals>) deals[k] += page.totals[k];
    cursor = page.cursor;
  } while (cursor);
  const error = totals.skippedDeals > 0 ? `${totals.skippedDeals} deal rows skipped (owner belongs to another org)` : undefined;
  const status = totals.skippedDeals > 0 ? "partial" : "success";
  await ctx.runMutation(internal.hubspot.updateSyncStatus, { orgId, status, error, dealCount: deals.deals });
  await ctx.runMutation(internal.organizations.updateCrmCounts, {
    orgId,
    counts: {
      accounts: state.base ? state.base.accounts + totals.accountsCreated : totals.accounts,
      contacts: state.base ? state.base.contacts + totals.contactsCreated : totals.contacts,
      ...deals,
    },
  });
  // A hygiene reading over the freshly synced rows builds the Home page's health trend. Scheduled (not awaited): a
  // scoring failure never fails the sync, and the capture action budgets its reads per table.
  progress.stage(CRM_SYNC_STAGES[5], 5, CRM_SYNC_STAGES.length); // health
  await ctx.scheduler.runAfter(0, internal.healthSnapshots.captureForOrg, { orgId });
  progress.flush();

  const counts = syncCounts(state);
  await ctx.runMutation(internal.integrations.finishSyncRun, { syncRunId, status, counts, error });
  // Only a sync that wrote every record moves the mark, and only once its run says so: the next reads what changed
  // since this one started. A partial sync (deals skipped) leaves it, so the next reads those deals again.
  if (status === "success") {
    await ctx.runMutation(internal.hubspot.setSyncCursors, {
      orgId,
      syncRunId,
      modifiedSince: state.until,
      mappingsKey: state.mappingsKey,
      ...(state.mode === "full" ? { fullSyncAt: state.until } : {}),
    });
  }
  return counts;
}

async function failSync(ctx: any, syncRunId: Id<"integrationSyncRuns">, orgId: Id<"organizations">, error: any): Promise<never> {
  // A stopped or ended run already says why; a later sync owns the connection's status now.
  if (error instanceof SyncRunEnded || !(await ctx.runQuery(internal.integrations.syncRunLive, { syncRunId }))) throw new ConvexError("Sync stopped");
  const message = error?.message ?? String(error);
  await ctx.runMutation(internal.hubspot.updateSyncStatus, { orgId, status: "error", error: message });
  await ctx.runMutation(internal.integrations.finishSyncRun, { syncRunId, status: "error", error: message });
  throw error;
}
