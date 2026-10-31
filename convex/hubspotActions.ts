"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import type { FieldMappings } from "./lib/crmMappings";
import { createHubspotConnector } from "../engine/src/index.ts";
import { CRM_SYNC_STAGES } from "../engine/src/progress.ts";
import { SyncRunEnded, stopIfEnded, syncRunProgressEmitter } from "./lib/syncRunProgress";
import type { Id } from "./_generated/dataModel";
import { chunk } from "./lib/collections";
import { resubmitUnprocessed } from "./lib/canon/partyLedger";
import { crmContactLinks, linkCrmContacts } from "./lib/crmLinks";
import { clientFor } from "./records";
import { mirrorAccount, mirrorContact, mirrorDeal } from "./lib/hubspotMirror";
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

    const FAR_FUTURE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
    await ctx.runMutation(internal.hubspot.storeTokens, {
      orgId: who.orgId,
      userId: who.userId,
      accessToken: token,
      refreshToken: "",
      tokenExpiresAt: FAR_FUTURE,
      scopes: HS_SCOPES,
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
  args: {},
  handler: async (ctx): Promise<SyncCounts> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    return syncAllForOrg(ctx, user.orgId, "manual");
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

/**
 * Sync = the open-source connector's canonical snapshot, persisted. The
 * connector owns HubSpot REST, pagination, and field mapping; this function
 * owns only the Convex boundary: cents, enum normalization, owner/account id
 * resolution, and upserts. Deals the org cannot own yet (no mapped owner or
 * no amount) are counted as skipped rather than silently dropped.
 */
async function syncAllForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  trigger: "manual" | "scheduled" | "oauth" | "system",
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

  // Shared progress vocabulary: same stages the CLI checklist renders.
  const progress = syncRunProgressEmitter(ctx, syncRunId);
  const stageCount = CRM_SYNC_STAGES.length;

  try {
    // Snapshot pull first: the connector reports per-page fetch totals, passed
    // through as throttled `items` heartbeats (no stage yet — the note labels it).
    progress.note("pulling CRM snapshot");
    const integration = await ctx.runQuery(internal.hubspot.getIntegration, { orgId });
    const { accessToken, fieldMappings } = await accessTokenForOrg(ctx, orgId);
    const connector = hubspotConnectorFromCredentials(
      accessToken,
      fieldMappings,
      ({ fetched }) => progress.items(fetched),
    );
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
    const snapshot = await connector.fetchSnapshot();

    const owners = snapshot.users
      .filter((user) => user.crmId && user.email)
      .map((user) => ({
        crmOwnerId: user.crmId!,
        email: user.email!,
        name: user.name,
      }));
    // Every upsert mutation is batched: each row costs ~2 document ops
    // (indexed lookup + write) and one Convex mutation caps at 4096 reads, so
    // a real CRM's full contact/deal list must never ride in a single call.
    const SYNC_BATCH = 400;
    // Deal upserts also write fact-ledger rows (~25 documents per new deal), so
    // they use smaller batches to stay well inside mutation limits.
    const DEAL_SYNC_BATCH = 50;
    // Account and contact upserts append to the ledger too (~20 documents per new record).
    // A batch that reaches its facts-read budget hands back the rest, which is resubmitted.
    const PARTY_SYNC_BATCH = 100;
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[0], 0, stageCount); // owners
    const ownerMap: Record<string, Id<"users">> = {};
    let ownersDone = 0;
    for (const batch of chunk(owners, SYNC_BATCH)) {
      const ownerResult = await ctx.runMutation(internal.hubspot.upsertOwners, {
        orgId,
        owners: batch,
      });
      Object.assign(ownerMap, ownerResult.ownerMap as Record<string, Id<"users">>);
      ownersDone += batch.length;
      progress.items(ownersDone, owners.length);
    }

    const mappedAccounts = snapshot.accounts.map((account) => mirrorAccount(account, ownerMap));
    // upsertAccounts returns an array (Convex caps object values at 1024 fields);
    // rebuild the crmId -> docId lookup here in the action runtime (no cap).
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[1], 1, stageCount); // accounts
    const accountMap: Record<string, Id<"crmAccounts">> = {};
    let accountsDone = 0;
    for (const batch of chunk(mappedAccounts, PARTY_SYNC_BATCH)) {
      await resubmitUnprocessed(batch, async (rows) => {
        const accountResult = await ctx.runMutation(internal.hubspot.upsertAccounts, {
          orgId,
          accounts: rows,
        });
        for (const entry of accountResult.accounts as Array<{ crmId: string; id: Id<"crmAccounts"> }>) {
          accountMap[entry.crmId] = entry.id;
        }
        return rows.filter((r) => accountResult.unprocessed.includes(r.crmId));
      });
      accountsDone += batch.length;
      progress.items(accountsDone, mappedAccounts.length);
    }

    const mappedContacts = snapshot.contacts.map((contact) => mirrorContact(contact, ownerMap, accountMap));
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[2], 2, stageCount); // contacts
    const contactResult = { synced: 0 };
    let contactsDone = 0;
    for (const batch of chunk(mappedContacts, PARTY_SYNC_BATCH)) {
      await resubmitUnprocessed(batch, async (rows) => {
        const batchResult = await ctx.runMutation(internal.hubspot.upsertContacts, {
          orgId,
          contacts: rows,
        });
        contactResult.synced += batchResult.synced as number;
        return rows.filter((r) => batchResult.unprocessed.includes(r.crmId));
      });
      contactsDone += batch.length;
      progress.items(contactsDone, mappedContacts.length);
    }
    // The register links each person to their company, as the CRM associates them (lib/crmLinks.ts).
    try {
      await linkCrmContacts(clientFor(ctx), orgId as string, "hubspot", syncRunId, crmContactLinks(
        mappedAccounts,
        snapshot.contacts.map((c) => ({ email: c.email, firstName: c.firstName, lastName: c.lastName, accountCrmId: c.accountId })),
      ));
    } catch (cause) {
      console.warn(`hubspot sync: linking contacts to companies in the register failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    const today = new Date().toISOString().split("T")[0];
    // Ownerless and amountless deals both sync into the mirror: the audit flags them and patch plans propose the fixes.
    const mappedDeals = snapshot.deals.map((deal) => mirrorDeal(deal, ownerMap, accountMap, today));
    const validDeals = mappedDeals.filter(
      (deal): deal is NonNullable<typeof deal> => deal !== null,
    );
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[3], 3, stageCount); // deals
    const dealResults = {
      created: 0,
      updated: 0,
      skipped: mappedDeals.length - validDeals.length,
    };
    let dealsDone = 0;
    for (const batch of chunk(validDeals, DEAL_SYNC_BATCH)) {
      const dealResult = await ctx.runMutation(internal.hubspot.upsertDeals, {
        orgId,
        deals: batch,
      });
      dealResults.created += dealResult.created as number;
      dealResults.updated += dealResult.updated as number;
      dealResults.skipped += dealResult.skipped as number;
      dealsDone += batch.length;
      progress.items(dealsDone, validDeals.length);
    }

    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[4], 4, stageCount); // counters
    await ctx.runMutation(internal.hubspot.updateSyncStatus, {
      orgId,
      status: dealResults.skipped > 0 ? "partial" : "success",
      error:
        dealResults.skipped > 0
          ? `${dealResults.skipped} deal rows skipped (owner belongs to another org)`
          : undefined,
      dealCount: dealResults.created + dealResults.updated,
    });

    // Refresh the org's maintained aggregates (organizations.crmCounts) from
    // the mapped arrays already in memory — zero extra document reads. These
    // are what dashboard/readiness queries read instead of scanning 10k+ rows.
    // Amounts are already cents (toCents above).
    const openDealRows = validDeals.filter((deal) => !deal.isClosed);
    await ctx.runMutation(internal.organizations.updateCrmCounts, {
      orgId,
      counts: {
        accounts: mappedAccounts.length,
        contacts: mappedContacts.length,
        deals: validDeals.length,
        openDeals: openDealRows.length,
        openPipeline: openDealRows.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
        wonRevenue: validDeals
          .filter((deal) => deal.isWon)
          .reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
        unownedDeals: validDeals.filter((deal) => !deal.primaryRepId).length,
      },
    });

    // Capture a hygiene reading over the freshly synced rows — this is what
    // builds the Home page's health trend without requiring CLI runs.
    // Scheduled (not awaited): a scoring failure never fails the sync, and the
    // capture action budgets its reads per table.
    progress.stage(CRM_SYNC_STAGES[5], 5, stageCount); // health
    await ctx.scheduler.runAfter(0, internal.healthSnapshots.captureForOrg, { orgId });
    progress.flush();

    const counts = {
      owners: owners.length,
      accounts: snapshot.accounts.length,
      contacts: contactResult.synced as number,
      deals: dealResults.created + dealResults.updated,
      createdDeals: dealResults.created,
      updatedDeals: dealResults.updated,
      skippedDeals: dealResults.skipped,
    };

    await ctx.runMutation(internal.integrations.finishSyncRun, {
      syncRunId,
      status: dealResults.skipped > 0 ? "partial" : "success",
      counts,
      error:
        dealResults.skipped > 0
          ? `${dealResults.skipped} deal rows skipped (owner belongs to another org)`
          : undefined,
    });

    return counts;
  } catch (error: any) {
    // A stopped or ended run already says why; a later sync owns the connection's status now.
    if (error instanceof SyncRunEnded || !(await ctx.runQuery(internal.integrations.syncRunLive, { syncRunId }))) throw new ConvexError("Sync stopped");
    const message = error?.message ?? String(error);
    await ctx.runMutation(internal.hubspot.updateSyncStatus, {
      orgId,
      status: "error",
      error: message,
    });
    await ctx.runMutation(internal.integrations.finishSyncRun, {
      syncRunId,
      status: "error",
      error: message,
    });
    throw error;
  }
}
