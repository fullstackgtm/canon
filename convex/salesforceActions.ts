"use node";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptFromStorage } from "./lib/tokenHelpers";
import type { FieldMappings } from "./lib/crmMappings";
import { createSalesforceConnector } from "../engine/src/index.ts";
import type { SalesforceWritableConnector } from "../engine/src/connectors/salesforce.ts";
import type { CanonicalAccount, CanonicalContact, CanonicalDeal } from "../engine/src/types.ts";
import { CRM_SYNC_STAGES, type ProgressEmitter } from "../engine/src/progress.ts";
import { SyncRunEnded, stopIfEnded, syncRunProgressEmitter } from "./lib/syncRunProgress";
import type { Id } from "./_generated/dataModel";
import { chunk } from "./lib/collections";
import { writeInBatches } from "./lib/batchWrites";
import { shardLocks } from "./lib/shardLocks";
import { SHARDS } from "./lib/objects/write";
import { prefetchPages, writeInOrder } from "./lib/pagePrefetch";
import { mappingsKey, planHubspotSync } from "./lib/hubspotSyncPlan";
import { nextRate, RATE_MIN_INTERVAL_MS, type RateSample } from "./lib/syncObjectProgress";
import { crmContactLinks, linkCrmContacts } from "./lib/crmLinks";
import { clientFor } from "./records";
import { createHash, randomBytes } from "crypto";
import { activeClerkOrgIdFromIdentity } from "./lib";
import {
  mintClientCredentialsToken,
  myDomainOrigin,
  type SalesforceClientCredentials,
} from "./lib/salesforceClientCredentials";

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
  mode?: "full" | "incremental";
  // The sync goes on in further steps after this call returns (salesforceActions.ts syncStep).
  continuing?: boolean;
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

export async function credentialsForOrg(ctx: any, orgId: Id<"organizations">) {
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

// Connect with the workspace's own External Client App (client-credentials flow), the way HubSpot takes a
// private-app token: no redirect, and no SALESFORCE_CLIENT_ID on this deployment.
export const connectWithClientCredentials = action({
  args: { domainUrl: v.string(), clientId: v.string(), clientSecret: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; instanceUrl: string }> => {
    const who: { orgId: Id<"organizations">; userId: Id<"users"> } = await ctx.runQuery(internal.salesforce.connector, {});

    const clientId = args.clientId.trim();
    const clientSecret = args.clientSecret.trim();
    if (!clientId || !clientSecret) throw new ConvexError("A consumer key and consumer secret are required");
    let credentials: SalesforceClientCredentials;
    let token: Awaited<ReturnType<typeof mintClientCredentialsToken>>;
    try {
      credentials = { domain: myDomainOrigin(args.domainUrl), clientId, clientSecret };
      token = await mintClientCredentialsToken(credentials);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : String(error));
    }

    // A token alone does not prove API access: the run-as user needs API Enabled and the app the api scope.
    const check = await fetch(`${token.instanceUrl}/services/data/v59.0/sobjects/`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!check.ok) {
      throw new ConvexError(
        `Salesforce issued a token but its API refused it (HTTP ${check.status}). Give the app the api scope and its run-as user the API Enabled permission.`,
      );
    }

    const sfIdentity = await fetchSalesforceIdentity(token.accessToken, token.identityUrl, token.instanceUrl);
    await ctx.runMutation(internal.salesforce.storeTokens, {
      orgId: who.orgId,
      userId: who.userId,
      accessToken: token.accessToken,
      refreshToken: "",
      instanceUrl: token.instanceUrl,
      tokenExpiresAt: token.expiresAt,
      scopes: ["api"],
      clientCredentials: JSON.stringify(credentials),
      ...salesforceConnectionMetadata(token.instanceUrl, sfIdentity),
    });
    return { ok: true, instanceUrl: token.instanceUrl };
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

  if (integration.clientCredentials) {
    const credentials = JSON.parse(await decryptFromStorage(integration.clientCredentials)) as SalesforceClientCredentials;
    let token: Awaited<ReturnType<typeof mintClientCredentialsToken>>;
    try {
      token = await mintClientCredentialsToken(credentials);
    } catch (error) {
      console.error("Salesforce client-credentials token failed:", error);
      throw new ConvexError(`Salesforce token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await ctx.runMutation(internal.salesforce.updateTokens, {
      integrationId: integration._id,
      accessToken: token.accessToken,
      tokenExpiresAt: token.expiresAt,
    });
    return { accessToken: token.accessToken, instanceUrl: integration.instanceUrl };
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

const SYNC_OBJECTS = ["accounts", "contacts", "deals"] as const;
type SyncObject = (typeof SYNC_OBJECTS)[number];
const STAGE_INDEX: Record<SyncObject, number> = { accounts: 1, contacts: 2, deals: 3 };

const syncStateValidator = v.object({
  syncRunId: v.id("integrationSyncRuns"),
  orgId: v.id("organizations"),
  mode: v.union(v.literal("full"), v.literal("incremental")),
  // An incremental sync reads records modified in [since, until) by SystemModstamp; `until` is when the sync started.
  since: v.optional(v.number()),
  until: v.number(),
  mappingsKey: v.string(),
  // The org's counts before an incremental sync, which adds the records it creates.
  base: v.optional(v.object({ accounts: v.number(), contacts: v.number() })),
  // When the last full sync started: deal totals count only deals seen since (salesforce.ts dealTotalsPage). A full
  // sync's own start is `until`.
  fullSyncAt: v.optional(v.number()),
  lanes: v.array(v.object({
    object: v.union(v.literal("accounts"), v.literal("contacts"), v.literal("deals")),
    // The last record Id written: the next page starts after it (keyset paging, so it outlives a step).
    after: v.union(v.string(), v.null()),
    done: v.boolean(),
    read: v.number(),
    total: v.optional(v.number()),
    // Records written a second, smoothed (lib/syncObjectProgress.ts); carried across steps.
    perSecond: v.optional(v.number()),
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

// One step reads and writes until this, then hands its cursors to the next, well inside the 10-minute action limit.
const STEP_MS = 3 * 60 * 1000;
// Account and contact upserts append to the ledger (~20 documents per new record); a batch that reaches its
// facts-read budget hands back the rest, which is resubmitted.
const PARTY_SYNC_BATCH = 100;
// Deal upserts write fact-ledger rows (~25 documents per new deal), so they use smaller batches.
const DEAL_SYNC_BATCH = 50;
// Batches a page submits at once (lib/batchWrites.ts); a batch of new records still waits for the ledger shards it takes.
const WRITE_CONCURRENCY = 3;
// People linked to their accounts in the register per call (lib/crmLinks.ts).
const LINK_FLUSH = 1000;
// Pages an object writes at once; a Salesforce page is up to 2,000 records, written in batches.
const PAGE_WRITES = 2;
// Pages an object reads ahead of its writes, as people and deals wait for accounts.
const PREFETCH_PAGES = 3;
// How often a step records its objects' progress for the panel.
const OBJECTS_PUBLISH_MS = 3_000;
// How long a step reuses a token before asking for it again (credentialsForOrg refreshes one near its expiry).
const TOKEN_REUSE_MS = 60_000;

/** The org's token for a step's requests, asked for again each minute so a short-lived one is refreshed in time. */
function liveConnection(ctx: any, orgId: Id<"organizations">, first: { accessToken: string; instanceUrl: string }) {
  let current = { ...first, at: Date.now() };
  return async () => {
    if (Date.now() - current.at > TOKEN_REUSE_MS) {
      const { accessToken, instanceUrl } = await credentialsForOrg(ctx, orgId);
      current = { accessToken, instanceUrl, at: Date.now() };
    }
    return { accessToken: current.accessToken, instanceUrl: current.instanceUrl };
  };
}

async function syncConnector(ctx: any, orgId: Id<"organizations">) {
  const { accessToken, instanceUrl, fieldMappings } = await credentialsForOrg(ctx, orgId);
  const connector = createSalesforceConnector({ getConnection: liveConnection(ctx, orgId, { accessToken, instanceUrl }), fieldMappings });
  return { connector, accessToken, instanceUrl, fieldMappings };
}

/**
 * Sync = the connector's canonical records, persisted into the mirror tables, as the HubSpot sync does
 * (hubspotActions.ts):
 *
 * - Incremental: after a complete sync, the next reads only records whose SystemModstamp moved since it started
 *   (lib/hubspotSyncPlan.ts); a full sync still runs every few days and when the field mappings change.
 * - Steps: the sync runs as a chain of actions, each reading and writing pages until STEP_MS and handing its
 *   cursors (the last Id written) to the next (syncStep), so a large org never meets Convex's 10-minute action limit.
 * - Pages are written as they arrive, the next read while one writes; people and opportunities run side by side once
 *   accounts are in, and name their account by Salesforce id, resolved as they are written.
 * - Unchanged rows write nothing (lib/syncUnchanged.ts), and the `facts` mirror follows off the write transactions.
 *
 * The connector owns SOQL and field mapping; this owns the Convex boundary: cents, enum normalization and owner ids.
 * Opportunities the org cannot own yet (an owner from another org) are counted as skipped rather than dropped.
 */
async function syncAllForOrg(
  ctx: any,
  orgId: Id<"organizations">,
  trigger: "manual" | "scheduled" | "oauth" | "system",
): Promise<SyncCounts> {
  const syncRunId = await ctx.runMutation(internal.integrations.startSyncRun, { orgId, provider: "salesforce", trigger });
  await ctx.runMutation(internal.salesforce.updateSyncStatus, { orgId, status: "in_progress" });

  const progress = syncRunProgressEmitter(ctx, syncRunId);
  try {
    progress.note("planning the sync");
    const integration = await ctx.runQuery(internal.salesforce.getIntegration, { orgId });
    const { connector, accessToken, instanceUrl, fieldMappings } = await syncConnector(ctx, orgId);
    if (!integration?.displayName) {
      const identity = await fetchSalesforceIdentity(accessToken, undefined, instanceUrl);
      await ctx.runMutation(internal.salesforce.updateSyncStatus, {
        orgId,
        status: "in_progress",
        ...salesforceConnectionMetadata(instanceUrl, identity),
      });
    }
    // The window ends when this sync starts: anything modified after is the next sync's.
    const until = Date.now();
    const baseline = await ctx.runQuery(internal.salesforce.syncBaseline, { orgId });
    const key = mappingsKey(fieldMappings ?? null);
    const plan = planHubspotSync(baseline.cursors, { hasCounts: Boolean(baseline.counts), mappingsKey: key, now: until });

    await stopIfEnded(ctx, syncRunId);
    // Until this sync succeeds, the next one reads everything: records this one creates before it fails would read as
    // unchanged to an incremental sync, which would never count them.
    await ctx.runMutation(internal.salesforce.markSyncOpen, { orgId, at: until });
    progress.stage(CRM_SYNC_STAGES[0], 0, CRM_SYNC_STAGES.length); // owners
    const owners = (await connector.fetchUsers())
      .filter((user) => user.crmId && user.email)
      .map((user) => ({ crmOwnerId: user.crmId!, name: user.name, email: user.email!, title: user.title, isActive: user.active ?? true }));
    // Each upsert costs ~2 document ops (indexed lookup + write); a mutation caps at 4096 reads.
    const OWNER_BATCH = 400;
    for (const batch of chunk(owners, OWNER_BATCH)) await ctx.runMutation(internal.salesforce.upsertOwners, { orgId, owners: batch });

    const window = plan.mode === "incremental" ? { since: plan.since, until } : undefined;
    const totals = await Promise.all(SYNC_OBJECTS.map((object) => connector.countRecords(object, window)));
    const state: SyncState = {
      syncRunId,
      orgId,
      mode: plan.mode,
      ...(window ? { since: window.since } : {}),
      until,
      mappingsKey: key,
      ...(plan.mode === "incremental" && baseline.counts ? { base: { accounts: baseline.counts.accounts, contacts: baseline.counts.contacts } } : {}),
      ...(plan.mode === "incremental" && baseline.cursors?.fullSyncAt !== undefined ? { fullSyncAt: baseline.cursors.fullSyncAt } : {}),
      lanes: SYNC_OBJECTS.map((object, i) => ({ object, after: null, done: false, read: 0, ...(totals[i] !== undefined ? { total: totals[i] } : {}) })),
      totals: { owners: owners.length, accounts: 0, accountsCreated: 0, contacts: 0, contactsCreated: 0, createdDeals: 0, updatedDeals: 0, skippedDeals: 0 },
      step: 0,
    };
    return await runSyncSteps(ctx, state, connector, instanceUrl, progress);
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
      const { connector, instanceUrl } = await syncConnector(ctx, state.orgId);
      return await runSyncSteps(ctx, state, connector, instanceUrl, progress);
    } catch (error) {
      return failSync(ctx, state.syncRunId, state.orgId, error);
    }
  },
});

/** Run an upsert once no earlier one holds any of `shards` (none named: any shard, so every earlier one). */
type WriteSlot = <T>(task: () => Promise<T>, shards?: readonly number[]) => Promise<T>;

async function runSyncSteps(ctx: any, state: SyncState, connector: SalesforceWritableConnector, instanceUrl: string, progress: ProgressEmitter): Promise<SyncCounts> {
  const deadline = Date.now() + STEP_MS;
  // Rebuilt each step, so the hand-off carries no list that grows with the org: Salesforce's users, matched to the
  // org's users by email as upsertOwners matched them (Salesforce users sharing an email map to the same user).
  const userByEmail = new Map<string, Id<"users">>();
  let userCursor: string | null = null;
  do {
    const page: { users: Array<{ email: string; userId: Id<"users"> }>; cursor: string | null } = await ctx.runQuery(internal.salesforce.ownerMapPage, { orgId: state.orgId, cursor: userCursor });
    for (const u of page.users) userByEmail.set(u.email, u.userId);
    userCursor = page.cursor;
  } while (userCursor);
  const ownerMap: Record<string, Id<"users">> = {};
  for (const user of await connector.fetchUsers()) {
    const userId = user.crmId && user.email ? userByEmail.get(user.email.toLowerCase()) : undefined;
    if (userId) ownerMap[user.crmId!] = userId;
  }
  // New records' ledger appends take the org's shard heads, so upserts wait for the shards they take
  // (lib/shardLocks.ts): every record's shard is learned before it is written (prepareAccounts, prepareContacts,
  // prepareDeals), and groups of shards write at once. Reads still run ahead of the writes.
  const locks = shardLocks(SHARDS);
  let shown: string | undefined;
  const samples = new Map<string, RateSample>(state.lanes.map((l) => [l.object, { done: l.read, at: Date.now() }]));
  let publishedAt = 0;
  // Set once a publish finds the run stopped or ended: the lanes take no further page, so a stop lands in seconds.
  // `writing`: rows written of each object's pages not yet committed. A 2,000-row page takes a minute to write, so
  // the bars count its rows as they land rather than jump once the page is done.
  const run: SyncRun = { ended: false, writing: new Map() };
  const shownDone = (lane: SyncLane) => lane.read + (run.writing.get(lane.object) ?? 0);
  const writeSlot: WriteSlot = (task, shards) => locks(shards ?? null, () => (run.ended ? Promise.reject(new SyncRunEnded("Sync stopped")) : task()));
  const publishObjects = (force = false) => {
    const now = Date.now();
    for (const lane of state.lanes) {
      if (lane.done) continue;
      const prev = samples.get(lane.object)!;
      const next = { done: shownDone(lane), at: now };
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
        object: l.object, done: shownDone(l), finished: l.done, updatedAt: now,
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
    progress.items(shownDone(lane), lane.total);
  };
  const ticker = setInterval(() => void publishObjects(), OBJECTS_PUBLISH_MS);
  try {
    while (Date.now() < deadline && state.lanes.some((lane) => !lane.done)) {
      await stopIfEnded(ctx, state.syncRunId);
      show();
      // Every object reads at once, but people and opportunities name their account by Salesforce id, resolved as
      // they are written: they read ahead while accounts write, and write once accounts are all in.
      const accounts = state.lanes.find((lane) => lane.object === "accounts")!;
      const lane = (l: SyncLane, ready: Promise<boolean>) => runSyncLane(ctx, state, l, connector, instanceUrl, ownerMap, writeSlot, deadline, show, ready, run);
      const accountsRun = accounts.done ? Promise.resolve() : lane(accounts, Promise.resolve(true));
      const accountsIn = accountsRun.then(() => accounts.done);
      const settled = await Promise.allSettled([
        accountsRun,
        ...state.lanes.filter((l) => l.object !== "accounts" && !l.done).map((l) => lane(l, accountsIn)),
      ]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  } finally {
    clearInterval(ticker);
  }
  await publishObjects(true);
  if (state.lanes.some((lane) => !lane.done)) {
    await stopIfEnded(ctx, state.syncRunId);
    await ctx.scheduler.runAfter(0, internal.salesforceActions.syncStep, { state: { ...state, step: state.step + 1 } });
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
  connector: SalesforceWritableConnector,
  instanceUrl: string,
  ownerMap: Record<string, Id<"users">>,
  writeSlot: WriteSlot,
  deadline: number,
  show: () => void,
  ready: Promise<boolean>,
  run: SyncRun,
) {
  const time = { pages: 0, readMs: 0, writeMs: 0, rows: 0, started: Date.now() };
  const links = { accounts: new Set<string>(), contacts: [] as LinkContact[] };
  const window = state.mode === "incremental" ? { since: state.since!, until: state.until } : undefined;
  const read = async (after: string | null) => {
    const at = Date.now();
    const page = await connector.readPage(lane.object, after, window);
    time.pages++;
    time.readMs += Date.now() - at;
    return page;
  };
  const pages = prefetchPages(lane.after, read, { max: PREFETCH_PAGES, until: deadline });
  try {
    if (!(await ready) || run.ended) return;
    // Past the deadline no further page is written; the first is written however late it arrives, so a slow page
    // still moves the lane on. The cursor moves only past pages written in full.
    await writeInOrder({
      next: () => pages.next(),
      more: (taken) => !run.ended && (taken === 0 || Date.now() < deadline),
      max: PAGE_WRITES,
      write: async (page) => {
        const at = Date.now();
        // People and opportunities whose account the window missed get it first, read by Id, so they link to it.
        if (lane.object !== "accounts") await ensureAccounts(ctx, state, connector, page.rows as Array<{ accountId?: string }>, instanceUrl, ownerMap, writeSlot);
        await writeSyncPage(ctx, state, lane.object, page.rows, instanceUrl, ownerMap, writeSlot, (n) => {
          run.writing.set(lane.object, (run.writing.get(lane.object) ?? 0) + n);
        });
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
        lane.after = page.next;
        lane.read += page.rows.length;
        run.writing.set(lane.object, Math.max(0, (run.writing.get(lane.object) ?? 0) - page.rows.length));
        if (!page.next) lane.done = true;
        show();
      },
    });
    if (links.contacts.length) await linkPeople(ctx, state, links);
  } finally {
    pages.stop();
    const perPage = time.pages ? Math.round(time.readMs / time.pages) : 0;
    console.log(
      `salesforce sync step ${state.step} ${lane.object}: ${time.rows} rows written in ${Math.round((Date.now() - time.started) / 1000)}s; ` +
        `${time.pages} pages read, ${perPage} ms each; page writes took ${Math.round(time.writeMs / 1000)}s`,
    );
  }
}

type SyncRun = { ended: boolean; writing: Map<SyncObject, number> };

type LinkContact = { email?: string; firstName?: string; lastName?: string; accountCrmId?: string };

function mirrorAccount(account: CanonicalAccount, ownerMap: Record<string, Id<"users">>) {
  return {
    crmId: account.crmId ?? account.id,
    name: account.name,
    domain: account.domain,
    industry: account.industry,
    employeeCount: account.employeeCount === undefined ? undefined : Math.round(account.employeeCount),
    annualRevenue: account.annualRevenue === undefined ? undefined : toCents(account.annualRevenue),
    crmOwnerId: account.ownerId,
    ownerId: account.ownerId ? ownerMap[account.ownerId] : undefined,
    rawData: account.raw,
  };
}

function mirrorContact(contact: CanonicalContact, ownerMap: Record<string, Id<"users">>) {
  return {
    crmId: contact.crmId ?? contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    title: contact.title,
    accountCrmId: contact.accountId,
    crmOwnerId: contact.ownerId,
    ownerId: contact.ownerId ? ownerMap[contact.ownerId] : undefined,
    rawData: contact.raw,
  };
}

function mirrorDeal(deal: CanonicalDeal, ownerMap: Record<string, Id<"users">>, today: string) {
  // Ownerless and amountless deals both sync into the mirror: the audit flags them and patch plans propose the fixes.
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
    primaryRepId: deal.ownerId ? ownerMap[deal.ownerId] : undefined,
    crmOwnerId: deal.ownerId,
    accountCrmId: deal.accountId,
    stage: deal.stage,
    forecastCategory: mapForecastCategory(deal.stage),
    probability: deal.probability,
    isClosed,
    isWon: deal.isWon ?? false,
    closedAt: isClosed && Number.isFinite(closeTime) ? closeTime : undefined,
    rawData: deal.raw,
  };
}

/** `wrote` hears how many of the page's rows each batch wrote or found unchanged, as the batches land. */
async function writeSyncPage(
  ctx: any,
  state: SyncState,
  object: SyncObject,
  rows: unknown[],
  instanceUrl: string,
  ownerMap: Record<string, Id<"users">>,
  writeSlot: WriteSlot,
  wrote: (rows: number) => void = () => undefined,
) {
  const { orgId, totals } = state;
  if (object === "accounts") {
    await writeInShardGroups((rows as CanonicalAccount[]).map((account) => mirrorAccount(account, ownerMap)), {
      size: PARTY_SYNC_BATCH,
      writeSlot,
      changed: (batch) => changedRows(ctx, batch, internal.salesforce.unchangedAccounts, { orgId, accounts: batch }),
      skipped: (n) => {
        totals.accounts += n;
        wrote(n);
      },
      prepare: (batch) => ctx.runMutation(internal.salesforce.prepareAccounts, { orgId, accounts: batch }),
      // Counted once the batch's upsert succeeds: a failed one is split and its rows submitted again.
      upsert: async (batch) => {
        const result = await ctx.runMutation(internal.salesforce.upsertAccounts, { orgId, accounts: batch });
        totals.accounts += result.synced as number;
        totals.accountsCreated += result.created as number;
        wrote(batch.length - result.unprocessed.length);
        return batch.filter((r) => result.unprocessed.includes(r.crmId));
      },
    });
  } else if (object === "contacts") {
    await writeInShardGroups((rows as CanonicalContact[]).map((contact) => mirrorContact(contact, ownerMap)), {
      size: PARTY_SYNC_BATCH,
      writeSlot,
      changed: (batch) => changedRows(ctx, batch, internal.salesforce.unchangedContacts, { orgId, contacts: batch }),
      skipped: (n) => {
        totals.contacts += n;
        wrote(n);
      },
      prepare: (batch) => ctx.runMutation(internal.salesforce.prepareContacts, { orgId, contacts: batch }),
      upsert: async (batch) => {
        const result = await ctx.runMutation(internal.salesforce.upsertContacts, { orgId, contacts: batch });
        totals.contacts += result.synced as number;
        totals.contactsCreated += result.created as number;
        wrote(batch.length - result.unprocessed.length);
        return batch.filter((r) => result.unprocessed.includes(r.crmId));
      },
    });
  } else {
    const today = new Date().toISOString().split("T")[0];
    // A full sync stamps every deal it reads, so one it did not read drops out of the deal totals.
    const stampAll = state.mode === "full" ? { stampAll: true } : {};
    await writeInShardGroups((rows as CanonicalDeal[]).map((deal) => mirrorDeal(deal, ownerMap, today)), {
      size: DEAL_SYNC_BATCH,
      writeSlot,
      changed: (batch) => changedRows(ctx, batch, internal.salesforce.unchangedDeals, { orgId, instanceUrl, deals: batch, ...stampAll }),
      skipped: (n) => {
        totals.updatedDeals += n;
        wrote(n);
      },
      prepare: (batch) => ctx.runMutation(internal.salesforce.prepareDeals, { orgId, instanceUrl, deals: batch }),
      upsert: async (batch) => {
        const result = await ctx.runMutation(internal.salesforce.upsertDeals, { orgId, instanceUrl, deals: batch, ...stampAll });
        totals.createdDeals += result.created as number;
        totals.updatedDeals += result.updated as number;
        totals.skippedDeals += result.skipped as number;
        wrote(batch.length);
      },
    });
  }
}

/**
 * Write a page's rows that change, grouped by the ledger shard their writes take (lib/shardLocks.ts). `prepare` names
 * each row's shard (making a new record's mirror row and stream first), so each shard's upserts wait only for that
 * shard and the shards write at once: on a local stack, 1,000 new accounts wrote at ~250 a second this way, ~100 one
 * upsert at a time. A row whose shard is not known writes alone. Every shard finishes before a failure is thrown:
 * whoever sees it knows nothing of this page is still writing.
 */
async function writeInShardGroups<R extends { crmId: string }>(rows: R[], o: {
  size: number;
  writeSlot: WriteSlot;
  changed: (batch: R[]) => Promise<R[]>;
  /** Rows a batch left unchanged, heard once its preparation succeeded: a batch that fails is submitted again. */
  skipped: (rows: number) => void;
  prepare: (batch: R[]) => Promise<Array<{ crmId: string; shard: number | null }>>;
  upsert: (batch: R[]) => Promise<R[] | void>;
}) {
  const groups = new Map<number | null, R[]>();
  await writeInBatches(rows, {
    size: o.size,
    concurrency: WRITE_CONCURRENCY,
    submit: async (batch) => {
      const changed = await o.changed(batch);
      const shards = changed.length ? await o.prepare(changed) : [];
      o.skipped(batch.length - changed.length);
      const shardOf = new Map(shards.map((s) => [s.crmId, s.shard]));
      for (const row of changed) {
        const shard = shardOf.get(row.crmId) ?? null;
        const group = groups.get(shard) ?? [];
        group.push(row);
        groups.set(shard, group);
      }
    },
  });
  const written = await Promise.allSettled([...groups].map(([shard, group]) => writeInBatches(group, {
    size: o.size,
    submit: (batch) => o.writeSlot(() => o.upsert(batch), shard === null ? undefined : [shard]),
  })));
  const failed = written.find((w): w is PromiseRejectedResult => w.status === "rejected");
  if (failed) throw failed.reason;
}

/** Write the accounts a page's people or opportunities name that the mirror lacks, read from Salesforce by Id. */
async function ensureAccounts(ctx: any, state: SyncState, connector: SalesforceWritableConnector, rows: Array<{ accountId?: string }>, instanceUrl: string, ownerMap: Record<string, Id<"users">>, writeSlot: WriteSlot) {
  const named = [...new Set(rows.flatMap((r) => (r.accountId ? [r.accountId] : [])))];
  if (!named.length) return;
  const known: Array<{ crmId: string }> = await ctx.runQuery(internal.salesforce.accountsByCrmIds, { orgId: state.orgId, crmIds: named });
  const have = new Set(known.map((a) => a.crmId));
  const missing = named.filter((id) => !have.has(id));
  if (!missing.length) return;
  const accounts = await connector.readAccountsByIds(missing);
  if (accounts.length) await writeSyncPage(ctx, state, "accounts", accounts, instanceUrl, ownerMap, writeSlot);
}

/**
 * The rows of a batch that would change something, for the write slot. The rest are sorted out by a query, many at
 * once beside the writes (convex/salesforce.ts unchangedAccounts), and only have their sync time stamped when due.
 */
async function changedRows<R extends { crmId: string }>(ctx: any, rows: R[], unchanged: any, args: Record<string, unknown>): Promise<R[]> {
  const sorted: { unchanged: string[]; stamp: string[] } = await ctx.runQuery(unchanged, args);
  if (sorted.stamp.length) await ctx.runMutation(internal.salesforce.stampSynced, { ids: sorted.stamp });
  const same = new Set(sorted.unchanged);
  return rows.filter((r) => !same.has(r.crmId));
}

/** The register links each person to their account, as the CRM associates them (lib/crmLinks.ts). Never fails the sync. */
async function linkPeople(ctx: any, state: SyncState, links: { accounts: Set<string>; contacts: LinkContact[] }) {
  const contacts = links.contacts.splice(0);
  const crmIds = [...links.accounts];
  links.accounts.clear();
  try {
    const accounts = await ctx.runQuery(internal.salesforce.accountsByCrmIds, { orgId: state.orgId, crmIds });
    await linkCrmContacts(clientFor(ctx), state.orgId as string, "salesforce", state.syncRunId, crmContactLinks(accounts, contacts));
  } catch (cause) {
    console.warn(`salesforce sync: linking contacts to accounts in the register failed: ${cause instanceof Error ? cause.message : String(cause)}`);
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
  // scanning 10k+ rows. A full sync saw every account and person; an incremental one adds those it created. Deal
  // totals change with any deal, so they are summed from the mirror. Amounts are cents.
  const deals = { deals: 0, openDeals: 0, openPipeline: 0, wonRevenue: 0, unownedDeals: 0 };
  let cursor: string | null = null;
  do {
    const seenSince = state.mode === "full" ? state.until : state.fullSyncAt;
    const page: { totals: typeof deals; cursor: string | null } = await ctx.runQuery(internal.salesforce.dealTotalsPage, { orgId, cursor, ...(seenSince !== undefined ? { seenSince } : {}) });
    for (const k of Object.keys(deals) as Array<keyof typeof deals>) deals[k] += page.totals[k];
    cursor = page.cursor;
  } while (cursor);
  const error = totals.skippedDeals > 0 ? `${totals.skippedDeals} opportunity rows skipped (owner belongs to another org)` : undefined;
  const status = totals.skippedDeals > 0 ? "partial" : "success";
  await ctx.runMutation(internal.salesforce.updateSyncStatus, { orgId, status, error, dealCount: deals.deals });
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
  // Only a sync that wrote every record moves the mark: the next reads what changed since this one started. A partial
  // sync (opportunities skipped) leaves it, so the next reads those again.
  if (status === "success") {
    await ctx.runMutation(internal.salesforce.setSyncCursors, {
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
  await ctx.runMutation(internal.salesforce.updateSyncStatus, { orgId, status: "error", error: message });
  await ctx.runMutation(internal.integrations.finishSyncRun, { syncRunId, status: "error", error: message });
  throw error;
}
