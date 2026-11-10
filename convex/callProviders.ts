import { NO_CREDENTIAL } from "./lib/sealed";
import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser, scopeUserToActiveOrg } from "./lib";
import { encryptForStorage } from "./lib/tokenHelpers";

const callProviderValidator = v.union(
  v.literal("gong"),
  v.literal("chorus"),
  v.literal("fathom"),
  v.literal("avoma"),
  v.literal("granola"),
);

export const listConnections = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const integrations = await ctx.db
      .query("integrations")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .collect();

    return integrations
      .filter((integration) =>
        integration.provider === "gong" ||
        integration.provider === "chorus" ||
        integration.provider === "fathom" ||
        integration.provider === "avoma" ||
        integration.provider === "granola",
      )
      .map((integration) => ({
        _id: integration._id,
        provider: integration.provider,
        instanceUrl: integration.instanceUrl,
        isActive: integration.isActive,
        lastSyncAt: integration.lastSyncAt,
        lastSyncStatus: integration.lastSyncStatus,
        lastSyncError: integration.lastSyncError,
        lastSyncDealCount: integration.lastSyncDealCount,
        connectedAt: integration.connectedAt,
        scopes: integration.scopes,
        syncConfig: integration.syncConfig,
        fieldMappings: integration.fieldMappings,
      }));
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
  args: {
    orgId: v.id("organizations"),
    provider: callProviderValidator,
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", args.provider),
      )
      .first();
  },
});

export const connect = mutation({
  args: {
    provider: callProviderValidator,
    apiKey: v.string(),
    apiSecret: v.optional(v.string()),
    instanceUrl: v.optional(v.string()),
    callsPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    if (!args.apiKey.trim()) throw new ConvexError("API key is required");

    const now = Date.now();
    const existing = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", args.provider),
      )
      .first();

    const patch = {
      accessToken: await encryptForStorage(args.apiKey.trim()),
      refreshToken: await encryptForStorage(args.apiSecret?.trim() ?? ""),
      instanceUrl: args.instanceUrl?.trim() || defaultBaseUrl(args.provider),
      scopes: ["calls:read", "transcripts:read"],
      syncConfig: {
        ...(typeof existing?.syncConfig === "object" && existing.syncConfig !== null
          ? existing.syncConfig
          : {}),
        schedule: existing?.syncConfig?.schedule ?? "manual",
        callsPath: args.callsPath?.trim() || defaultCallsPath(args.provider),
      },
      isActive: true,
      connectedBy: user._id,
      connectedAt: existing?.connectedAt ?? now,
      lastSyncStatus: existing?.lastSyncStatus,
      lastSyncError: undefined,
      updatedAt: now,
    };

    const integrationId = existing
      ? existing._id
      : await ctx.db.insert("integrations", { orgId: user.orgId, provider: args.provider, ...patch, createdAt: now });
    if (existing) await ctx.db.patch(existing._id, patch);
    // Granola polls on its own every 15 minutes; the first poll starts now so the card fills right away.
    if (args.provider === "granola") {
      await ctx.scheduler.runAfter(0, internal.granolaActions.syncOrg, { orgId: user.orgId, trigger: "system" });
    }
    return { integrationId };
  },
});

export const disconnect = mutation({
  args: { provider: callProviderValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", args.provider),
      )
      .first();
    if (!integration) return;

    await ctx.db.patch(integration._id, {
      isActive: false,
      accessToken: NO_CREDENTIAL,
      refreshToken: NO_CREDENTIAL,
      lastSyncStatus: undefined,
      lastSyncError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const updateSyncStatus = internalMutation({
  args: {
    orgId: v.id("organizations"),
    provider: callProviderValidator,
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("error"),
      v.literal("in_progress"),
    ),
    error: v.optional(v.string()),
    callCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", args.provider),
      )
      .first();
    if (!integration) return;

    await ctx.db.patch(integration._id, {
      // lastSyncAt means "last COMPLETED sync". Stamping it on in_progress
      // (which runs BEFORE the fetch reads this row) made incremental
      // providers like Granola filter against "now" and sync 0 every time.
      ...(args.status === "success" || args.status === "partial"
        ? { lastSyncAt: Date.now() }
        : {}),
      lastSyncStatus: args.status,
      lastSyncDealCount: args.callCount,
      lastSyncError: args.error,
      updatedAt: Date.now(),
    });
  },
});

function defaultBaseUrl(provider: "gong" | "chorus" | "fathom" | "avoma" | "granola") {
  if (provider === "gong") return "https://api.gong.io";
  if (provider === "chorus") return "https://api.chorus.ai";
  if (provider === "granola") return "https://public-api.granola.ai";
  if (provider === "avoma") return "https://api.avoma.com/v1";
  return "https://api.fathom.video";
}

function defaultCallsPath(provider: "gong" | "chorus" | "fathom" | "avoma" | "granola") {
  if (provider === "gong") return "/v2/calls/transcripts";
  if (provider === "chorus") return "/v1/calls/transcripts";
  if (provider === "granola") return "/v1/notes";
  if (provider === "avoma") return "/meetings/";
  return "/external/v1/calls";
}
