"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import type { FieldMappings } from "./lib/crmMappings";
import { createSalesforceConnector } from "../engine/src/index.ts";
import { CRM_SYNC_STAGES } from "../engine/src/progress.ts";
import { SyncRunEnded, stopIfEnded, syncRunProgressEmitter } from "./lib/syncRunProgress";
import type { Id } from "./_generated/dataModel";
import { chunk } from "./lib/collections";
import { resubmitUnprocessed } from "./lib/canon/partyLedger";
import { crmContactLinks, linkCrmContacts } from "./lib/crmLinks";
import { clientFor } from "./records";
import { createHash, randomBytes } from "crypto";
import { activeClerkOrgIdFromIdentity } from "./lib";

const SF_AUTH_URL = "https://login.salesforce.com/services/oauth2/authorize";
const SF_TOKEN_URL = "https://login.salesforce.com/services/oauth2/token";
const SF_SCOPES = ["api", "refresh_token"];

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
  codeVerifier: string;
  cliAuthRequestId?: Id<"cliAuthRequests">;
  cliAuthDeviceCodeHash?: string;
} | null;

type SalesforceIdentity = {
  organization_id?: string;
  username?: string;
};

function salesforceConnectionMetadata(
  instanceUrl: string,
  identity?: SalesforceIdentity | null,
) {
  const host = new URL(instanceUrl).host;
  const orgId = identity?.organization_id;
  return {
    displayName: `Salesforce — ${host || orgId || "connected org"}`,
    externalOrgId: orgId,
    externalOrgDomain: host,
  };
}

async function fetchSalesforceIdentity(
  accessToken: string,
  identityUrl?: string,
  instanceUrl?: string,
): Promise<SalesforceIdentity | null> {
  const url = identityUrl ?? (instanceUrl ? `${instanceUrl.replace(/\/$/, "")}/services/oauth2/userinfo` : null);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as SalesforceIdentity;
  } catch (error) {
    console.warn("Salesforce identity metadata fetch failed", error);
    return null;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConvexError(`${name} is not configured`);
  return value;
}

function callbackUrl(): string {
  return `${requiredEnv("CONVEX_SITE_URL").replace(/\/$/, "")}/api/salesforce/callback`;
}

function randomState(): string {
  return randomBytes(32).toString("hex");
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// The canonical model carries amounts in major units; the app stores cents.
function toCents(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function mapDealType(value: unknown):
  | "new_business"
  | "expansion"
  | "renewal"
  | "one_time" {
  const type = String(value ?? "").toLowerCase();
  if (type.includes("renew")) return "renewal";
  if (type.includes("expan") || type.includes("upsell") || type.includes("add")) {
    return "expansion";
  }
  if (type.includes("one")) return "one_time";
  return "new_business";
}

function mapForecastCategory(stage: unknown):
  | "omit"
  | "pipeline"
  | "best_case"
  | "commit"
  | "closed_won"
  | "closed_lost" {
  const normalized = String(stage ?? "").toLowerCase();
  if (normalized === "closed won") return "closed_won";
  if (normalized === "closed lost") return "closed_lost";
  if (normalized.includes("commit")) return "commit";
  if (normalized.includes("best")) return "best_case";
  return "pipeline";
}

async function credentialsForOrg(ctx: any, orgId: Id<"organizations">) {
  const integration = await ctx.runQuery(internal.salesforce.getIntegration, {
    orgId,
  });
  if (!integration || !integration.isActive || !integration.instanceUrl) {
    throw new ConvexError("No active Salesforce integration");
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
    instanceUrl: integration.instanceUrl as string,
    fieldMappings: integration.fieldMappings as FieldMappings | undefined,
  };
}

function salesforceConnectorFromCredentials(
  accessToken: string,
  instanceUrl: string,
  fieldMappings: FieldMappings | undefined,
  onProgress?: (progress: { objectType: string; fetched: number }) => void,
) {
  return {
    connector: createSalesforceConnector({
      getConnection: () => ({ accessToken, instanceUrl }),
      fieldMappings,
      ...(onProgress ? { onProgress } : {}),
    }),
    instanceUrl,
  };
}

export async function connectorForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  onProgress?: (progress: { objectType: string; fetched: number }) => void,
) {
  const { accessToken, instanceUrl, fieldMappings } = await credentialsForOrg(ctx, orgId);
  return salesforceConnectorFromCredentials(
    accessToken,
    instanceUrl,
    fieldMappings,
    onProgress,
  );
}

// Used by the CLI broker (cliAuthActions.mintProviderToken) to hand a
// short-lived org connection to a paired CLI.
export const getOrgAccessToken = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args,
  ): Promise<{ accessToken: string; instanceUrl: string; fieldMappings: unknown }> => {
    const { accessToken, instanceUrl, fieldMappings } = await credentialsForOrg(ctx, args.orgId);
    return { accessToken, instanceUrl, fieldMappings: fieldMappings ?? null };
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
    const user = await ctx.runQuery(internal.salesforce.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user || user.orgId !== args.orgId) throw new ConvexError("Organization not found");
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    const { connector } = await connectorForOrg(ctx, args.orgId);
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
      throw new ConvexError(result.detail ?? "Salesforce write failed");
    }
    const providerData = result.providerData as { field?: string } | undefined;
    return { provider: "salesforce", crmId: args.crmId, field: providerData?.field };
  },
});

export const getAuthUrl = action({
  args: { cliUserCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.salesforce.getUserByClerkId, {
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
        { userCode: args.cliUserCode, provider: "salesforce" },
      );
      if (!request) throw new ConvexError("No pending Salesforce CLI login for that code");
      cliAuthRequestId = request._id;
      cliAuthDeviceCodeHash = request.deviceCodeHash;
    }

    const state = randomState();
    const codeVerifier = generateCodeVerifier();
    await ctx.runMutation(internal.salesforce.createOAuthState, {
      state,
      orgId: user.orgId,
      userId: user._id,
      codeVerifier,
      cliAuthRequestId,
      cliAuthDeviceCodeHash,
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: requiredEnv("SALESFORCE_CLIENT_ID"),
      redirect_uri: callbackUrl(),
      scope: SF_SCOPES.join(" "),
      state,
      code_challenge: generateCodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    });

    return { authUrl: `${SF_AUTH_URL}?${params.toString()}` };
  },
});

export const exchangeCode = action({
  args: {
    code: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args): Promise<ExchangeResult> => {
    const stateData: ConsumedOAuthState = await ctx.runMutation(
      internal.salesforce.consumeOAuthState,
      { state: args.state },
    );
    if (!stateData) return { error: "invalid_state" };

    const response = await fetch(SF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        client_id: requiredEnv("SALESFORCE_CLIENT_ID"),
        // PKCE public client: the Connected App has isConsumerSecretOptional,
        // so client_secret is sent only if configured.
        ...(process.env.SALESFORCE_CLIENT_SECRET
          ? { client_secret: process.env.SALESFORCE_CLIENT_SECRET }
          : {}),
        redirect_uri: callbackUrl(),
        code_verifier: stateData.codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      console.error("Salesforce token exchange failed:", await response.text());
      return { error: "token_exchange_failed" };
    }

    const tokenData = await response.json();
    if (
      !tokenData.access_token ||
      !tokenData.refresh_token ||
      !tokenData.instance_url
    ) {
      return { error: "incomplete_token_response" };
    }

    const identity = await fetchSalesforceIdentity(
      tokenData.access_token,
      tokenData.id,
      tokenData.instance_url,
    );

    await ctx.runMutation(internal.salesforce.storeTokens, {
      orgId: stateData.orgId,
      userId: stateData.userId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      instanceUrl: tokenData.instance_url,
      tokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
      scopes: SF_SCOPES,
      ...salesforceConnectionMetadata(tokenData.instance_url, identity),
    });

    if (stateData.cliAuthRequestId && stateData.cliAuthDeviceCodeHash) {
      await ctx.runMutation(internal.cliAuth.approveOAuth, {
        cliAuthRequestId: stateData.cliAuthRequestId,
        provider: "salesforce",
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
  handler: async (ctx, args): Promise<{ accessToken: string; instanceUrl: string }> => {
    return refreshAccessTokenForOrg(ctx, args.orgId);
  },
});

async function refreshAccessTokenForOrg(
  ctx: any,
  orgId: Id<"organizations">,
): Promise<{ accessToken: string; instanceUrl: string }> {
  const integration = await ctx.runQuery(internal.salesforce.getIntegration, {
    orgId,
  });
  if (!integration || !integration.instanceUrl) {
    throw new ConvexError("No Salesforce integration found");
  }

  const response = await fetch(SF_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: await decryptFromStorage(integration.refreshToken),
      client_id: requiredEnv("SALESFORCE_CLIENT_ID"),
      ...(process.env.SALESFORCE_CLIENT_SECRET
        ? { client_secret: process.env.SALESFORCE_CLIENT_SECRET }
        : {}),
    }).toString(),
  });

  if (!response.ok) {
    console.error("Salesforce token refresh failed:", await response.text());
    throw new ConvexError("Salesforce token refresh failed");
  }

  const tokenData = await response.json();
  await ctx.runMutation(internal.salesforce.updateTokens, {
    integrationId: integration._id,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    tokenExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
  });

  return {
    accessToken: tokenData.access_token,
    instanceUrl: integration.instanceUrl,
  };
}

export const syncAll = action({
  args: {},
  handler: async (ctx): Promise<SyncCounts> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const user = await ctx.runQuery(internal.salesforce.getUserByClerkId, {
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

/**
 * Sync = the open-source connector's canonical snapshot, persisted. The
 * connector owns SOQL, pagination, and field mapping; this function owns the
 * Convex boundary: cents, enum normalization, owner/account id resolution,
 * and upserts. Opportunities the org cannot own yet (no mapped owner or no
 * amount) are counted as skipped rather than silently dropped.
 */
async function syncAllForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  trigger: "manual" | "scheduled" | "oauth" | "system",
): Promise<SyncCounts> {
  const syncRunId = await ctx.runMutation(internal.integrations.startSyncRun, {
    orgId,
    provider: "salesforce",
    trigger,
  });

  await ctx.runMutation(internal.salesforce.updateSyncStatus, {
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
    const integration = await ctx.runQuery(internal.salesforce.getIntegration, { orgId });
    const { accessToken, instanceUrl, fieldMappings } = await credentialsForOrg(ctx, orgId);
    const { connector } = salesforceConnectorFromCredentials(
      accessToken,
      instanceUrl,
      fieldMappings,
      ({ fetched }) => progress.items(fetched),
    );
    if (!integration?.displayName) {
      const identity = await fetchSalesforceIdentity(accessToken, undefined, instanceUrl);
      await ctx.runMutation(internal.salesforce.updateSyncStatus, {
        orgId,
        status: "in_progress",
        ...salesforceConnectionMetadata(instanceUrl, identity),
      });
    }
    const snapshot = await connector.fetchSnapshot();

    const owners = snapshot.users
      .filter((user) => user.crmId && user.email)
      .map((user) => ({
        crmOwnerId: user.crmId!,
        name: user.name,
        email: user.email!,
        title: user.title,
        isActive: user.active ?? true,
      }));
    // Batched like the HubSpot sync: ~2 doc ops per row vs the 4096-read cap.
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
      const ownerResult = await ctx.runMutation(internal.salesforce.upsertOwners, {
        orgId,
        owners: batch,
      });
      Object.assign(ownerMap, ownerResult.ownerMap as Record<string, Id<"users">>);
      ownersDone += batch.length;
      progress.items(ownersDone, owners.length);
    }

    const mappedAccounts = snapshot.accounts.map((account) => ({
      crmId: account.crmId ?? account.id,
      name: account.name,
      domain: account.domain,
      industry: account.industry,
      employeeCount:
        account.employeeCount === undefined
          ? undefined
          : Math.round(account.employeeCount),
      annualRevenue:
        account.annualRevenue === undefined ? undefined : toCents(account.annualRevenue),
      crmOwnerId: account.ownerId,
      ownerId: account.ownerId ? ownerMap[account.ownerId] : undefined,
      rawData: account.raw,
    }));
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[1], 1, stageCount); // accounts
    const accountMap: Record<string, Id<"crmAccounts">> = {};
    let accountsDone = 0;
    for (const batch of chunk(mappedAccounts, PARTY_SYNC_BATCH)) {
      await resubmitUnprocessed(batch, async (rows) => {
        const accountResult = await ctx.runMutation(internal.salesforce.upsertAccounts, {
          orgId,
          accounts: rows,
        });
        Object.assign(accountMap, accountResult.accountMap as Record<string, Id<"crmAccounts">>);
        return rows.filter((r) => accountResult.unprocessed.includes(r.crmId));
      });
      accountsDone += batch.length;
      progress.items(accountsDone, mappedAccounts.length);
    }

    const mappedContacts = snapshot.contacts.map((contact) => ({
      crmId: contact.crmId ?? contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      accountId: contact.accountId ? accountMap[contact.accountId] : undefined,
      crmOwnerId: contact.ownerId,
      ownerId: contact.ownerId ? ownerMap[contact.ownerId] : undefined,
      rawData: contact.raw,
    }));
    await stopIfEnded(ctx, syncRunId);
    progress.stage(CRM_SYNC_STAGES[2], 2, stageCount); // contacts
    const contactResult = { synced: 0 };
    let contactsDone = 0;
    for (const batch of chunk(mappedContacts, PARTY_SYNC_BATCH)) {
      await resubmitUnprocessed(batch, async (rows) => {
        const batchResult = await ctx.runMutation(internal.salesforce.upsertContacts, {
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
      await linkCrmContacts(clientFor(ctx), orgId as string, "salesforce", syncRunId, crmContactLinks(
        mappedAccounts,
        snapshot.contacts.map((c) => ({ email: c.email, firstName: c.firstName, lastName: c.lastName, accountCrmId: c.accountId })),
      ));
    } catch (cause) {
      console.warn(`salesforce sync: linking contacts to companies in the register failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    const today = new Date().toISOString().split("T")[0];
    const mappedDeals = snapshot.deals.map((deal) => {
      const repId = deal.ownerId ? ownerMap[deal.ownerId] : undefined;
      // Ownerless AND amountless deals both sync into the mirror — the audit
      // flags them (missing-deal-owner / missing-deal-amount) and patch plans
      // propose the fixes. Sync never silently drops a deal.

      const closeDate = deal.closeDate ?? today;
      const closeTime = Date.parse(closeDate);
      const isClosed = deal.isClosed ?? false;

      return {
        crmId: deal.crmId ?? deal.id,
        name: deal.name,
        amount: deal.amount === undefined ? undefined : toCents(deal.amount),
        closeDate,
        dealType: mapDealType(deal.dealType),
        revenueType: "one_time" as const,
        primaryRepId: repId,
        crmOwnerId: deal.ownerId,
        accountId: deal.accountId ? accountMap[deal.accountId] : undefined,
        stage: deal.stage,
        forecastCategory: mapForecastCategory(deal.stage),
        probability: deal.probability,
        isClosed,
        isWon: deal.isWon ?? false,
        closedAt: isClosed && Number.isFinite(closeTime) ? closeTime : undefined,
        rawData: deal.raw,
      };
    });
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
      const dealResult = await ctx.runMutation(internal.salesforce.upsertDeals, {
        orgId,
        instanceUrl,
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
    await ctx.runMutation(internal.salesforce.updateSyncStatus, {
      orgId,
      status: dealResults.skipped > 0 ? "partial" : "success",
      error:
        dealResults.skipped > 0
          ? `${dealResults.skipped} opportunity rows skipped (owner belongs to another org)`
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
          ? `${dealResults.skipped} opportunity rows skipped (owner belongs to another org)`
          : undefined,
    });

    return counts;
  } catch (error: any) {
    // A stopped or ended run already says why; a later sync owns the connection's status now.
    if (error instanceof SyncRunEnded || !(await ctx.runQuery(internal.integrations.syncRunLive, { syncRunId }))) throw new ConvexError("Sync stopped");
    const message = error?.message ?? String(error);
    await ctx.runMutation(internal.salesforce.updateSyncStatus, {
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
