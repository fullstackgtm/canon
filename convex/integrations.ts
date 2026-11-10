import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { normalizeFieldMappings } from "./lib/crmMappings";
import { salesforceCanRefresh } from "./lib/salesforceClientCredentials";

function integrationReadinessFromRows(integrations: any[], syncRuns: any[]) {
  const active = integrations.filter((integration) => integration.isActive);
  const errors = syncRuns.filter((run) => run.status === "error").length;
  return {
    noun: "integration",
    required: false,
    relevant: integrations.length > 0,
    configured: active.length > 0,
    lifecycle: errors > 0 ? "error" : active.length > 0 ? "healthy" : "not_connected",
    signals: { activeProviders: active.map((row) => row.provider), integrationCount: integrations.length, recentSyncRuns: syncRuns.length, errorRuns: errors },
    nextActions: active.length > 0 ? ["do integration.sync", "review sync_runs"] : ["connect Salesforce/HubSpot", "connect Gong/Chorus/Fathom/Avoma"],
  };
}

function emptyIntegrationReadiness() {
  return {
    noun: "integration",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_connected",
    signals: { activeProviders: [], integrationCount: 0, recentSyncRuns: 0, errorRuns: 0 },
    nextActions: ["Sign in to inspect integration readiness"],
  };
}

const providerValidator = v.union(
  v.literal("hubspot"),
  v.literal("salesforce"),
  v.literal("gong"),
  v.literal("chorus"),
  v.literal("fathom"),
  v.literal("avoma"),
  v.literal("granola"),
);
const scheduleValidator = v.union(
  v.literal("manual"),
  v.literal("hourly"),
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);

function publicConnection(integration: any) {
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
}

/** Integration rows that are not a CRM: no scheduled sync, no default schedule. */
const NOT_SYNCED = ["stripe", "instantly", "emailbison", "smartlead", "slack", "explee", "deepline"] as const;
type Provider = Doc<"integrations">["provider"];
const isSynced = (p: Provider): p is Exclude<Provider, (typeof NOT_SYNCED)[number]> => !(NOT_SYNCED as readonly string[]).includes(p);

const SCHEDULE_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return emptyIntegrationReadiness();
    const [integrations, syncRuns] = await Promise.all([
      ctx.db.query("integrations").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("integrationSyncRuns").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(50),
    ]);
    return integrationReadinessFromRows(integrations, syncRuns);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { readiness: emptyIntegrationReadiness(), integrations: [], syncRuns: [] };
    const [integrations, syncRuns] = await Promise.all([
      ctx.db.query("integrations").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("integrationSyncRuns").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(50),
    ]);
    return {
      readiness: integrationReadinessFromRows(integrations, syncRuns),
      // Never the stored credentials: the encrypted tokens stay on the server.
      integrations: integrations.map(publicConnection),
      syncRuns,
      hubspot: publicConnection(integrations.find((integration) => integration.provider === "hubspot")),
      salesforce: publicConnection(integrations.find((integration) => integration.provider === "salesforce")),
      stripe: publicConnection(integrations.find((integration) => integration.provider === "stripe")),
      callProviders: integrations
        .filter((integration) => ["gong", "chorus", "fathom", "avoma", "granola"].includes(integration.provider))
        .map(publicConnection),
    };
  },
});

export const updateSettings = mutation({
  args: {
    provider: providerValidator,
    schedule: scheduleValidator,
    fieldMappings: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));

    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", user.orgId).eq("provider", args.provider),
      )
      .first();
    if (!integration) throw new ConvexError("Integration not found");

    await ctx.db.patch(integration._id, {
      syncConfig: {
        ...(typeof integration.syncConfig === "object" &&
        integration.syncConfig !== null
          ? integration.syncConfig
          : {}),
        schedule: args.schedule,
      },
      // The page saves only the schedule; mappings change through the API, and are kept when it leaves them out.
      ...(args.fieldMappings === undefined ? {} : { fieldMappings: normalizeFieldMappings(args.fieldMappings) }),
      updatedAt: Date.now(),
    });
  },
});

export const hasFinishedSyncRunBefore = query({
  args: {
    provider: providerValidator,
    startedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return false;

    const rows = await ctx.db
      .query("integrationSyncRuns")
      .withIndex("by_orgId_provider_startedAt", (q) =>
        q.eq("orgId", user.orgId).eq("provider", args.provider).lt("startedAt", args.startedAt),
      )
      .order("desc")
      .take(250);

    return rows.some((run) => Boolean(run.finishedAt));
  },
});

export const listSyncRuns = query({
  args: {
    provider: v.optional(providerValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    if (args.provider) {
      return ctx.db
        .query("integrationSyncRuns")
        .withIndex("by_orgId_provider_startedAt", (q) =>
          q.eq("orgId", user.orgId).eq("provider", args.provider!),
        )
        .order("desc")
        .take(limit);
    }

    return ctx.db
      .query("integrationSyncRuns")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(limit);
  },
});

/**
 * One PAGE of the cross-tenant due-for-sync scan. The hourly cron
 * (integrationActions.runScheduledSyncs) drives the cursor loop, so each page
 * is its own query call with its own read budget: reads per call ≈ numItems
 * (≤ the caller's page size, e.g. 200) « 4096. The previous version async-
 * iterated the ENTIRE integrations table in a single query — at ≥4096 total
 * rows across all tenants that one query dies and every scheduled sync stops.
 */
export const listDueForScheduledSync = internalQuery({
  args: {
    now: v.number(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("integrations")
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    const due: Array<{
      orgId: Id<"organizations">;
      provider: "hubspot" | "salesforce" | "gong" | "chorus" | "fathom" | "avoma" | "granola";
    }> = [];

    for (const integration of page.page) {
      if (!integration.isActive) continue;
      // Stripe is not a scheduled CRM sync: invoice reads happen through the
      // governed backfill flow (stripeActions), never the sync engine.
      if (!isSynced(integration.provider)) continue;
      if (integration.provider === "salesforce" && !salesforceCanRefresh(integration)) continue;
      const schedule = integration.syncConfig?.schedule;
      if (!schedule || schedule === "manual") continue;
      const interval = SCHEDULE_MS[schedule];
      if (!interval) continue;
      if (integration.lastSyncStatus === "in_progress") continue;
      if (integration.lastSyncAt && args.now - integration.lastSyncAt < interval) {
        continue;
      }

      due.push({
        orgId: integration.orgId,
        provider: integration.provider,
      });
    }

    return { due, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const startSyncRun = internalMutation({
  args: {
    orgId: v.id("organizations"),
    provider: providerValidator,
    trigger: v.union(
      v.literal("manual"),
      v.literal("scheduled"),
      v.literal("oauth"),
      v.literal("system"),
    ),
  },
  handler: async (ctx, args) => {
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) =>
        q.eq("orgId", args.orgId).eq("provider", args.provider),
      )
      .first();

    if (isCrmSync(args.provider)) {
      const now = Date.now();
      for (const run of await inFlightRuns(ctx, args.orgId, args.provider)) {
        if (now - lastAlive(run) < CRM_SYNC_STALE_MS) throw new ConvexError("A sync is already running");
        await endSyncRun(ctx, run, STALE_SYNC_ERROR);
      }
    }

    return ctx.db.insert("integrationSyncRuns", {
      orgId: args.orgId,
      integrationId: integration?._id,
      provider: args.provider,
      trigger: args.trigger,
      status: "in_progress",
      startedAt: Date.now(),
    });
  },
});

/**
 * Live heartbeat for an in-flight sync run: the sync action's progress emitter
 * (engine/src/progress.ts) fire-and-forgets snapshots here,
 * already throttled at the emitter. Deliberately tiny — read budget: 1 read
 * (the patched doc) + 1 write, so a chatty run can never strain a transaction.
 * Failures are swallowed by the caller; a heartbeat must never fail the run.
 */
export const updateRunProgress = internalMutation({
  args: {
    syncRunId: v.id("integrationSyncRuns"),
    progress: v.object({
      stage: v.optional(v.string()),
      stageIndex: v.optional(v.number()),
      stageCount: v.optional(v.number()),
      itemsDone: v.optional(v.number()),
      itemsTotal: v.optional(v.number()),
      note: v.optional(v.string()),
      heartbeatAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.syncRunId, { progress: args.progress });
  },
});

/** A sync's per-object progress (integrationSyncRuns.objects); a run that has ended keeps what it had. */
export const updateRunObjects = internalMutation({
  args: {
    syncRunId: v.id("integrationSyncRuns"),
    objects: v.array(v.object({
      object: v.string(),
      done: v.number(),
      total: v.optional(v.number()),
      finished: v.boolean(),
      perSecond: v.optional(v.number()),
      updatedAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    // Whether the run is still live: a sync that learns it was stopped takes no further page.
    const run = await ctx.db.get(args.syncRunId);
    if (run?.status !== "in_progress") return false;
    // Publishes are not awaited in order: one that lands after a newer snapshot would move the bars backward.
    const at = (objects: ReadonlyArray<{ updatedAt: number }> | undefined) => Math.max(0, ...(objects ?? []).map((o) => o.updatedAt));
    if (at(args.objects) < at(run.objects)) return true;
    await ctx.db.patch(args.syncRunId, { objects: args.objects });
    return true;
  },
});

export const finishSyncRun = internalMutation({
  args: {
    syncRunId: v.id("integrationSyncRuns"),
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("error"),
    ),
    counts: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // A run someone stopped, or the sweep ended, keeps the reason it ended with.
    const run = await ctx.db.get(args.syncRunId);
    if (!run || run.status !== "in_progress") return;
    await ctx.db.patch(args.syncRunId, {
      status: args.status,
      counts: args.counts,
      error: args.error,
      finishedAt: Date.now(),
    });
  },
});

// ── Stuck and stopped CRM syncs ──
// Convex ends an action at 10 minutes without running its catch: a sync killed
// that way (time limit, memory) would stay "in progress" forever, hold the Sync
// button disabled and keep the hourly schedule from ever running it again. A
// Salesforce sync is one action; a HubSpot sync is a chain of steps that can run
// far longer, each beating its run's heartbeat. A run with no sign of life for
// CRM_SYNC_STALE_MS is dead; the sweep, the next sync and Stop each end it.

const CRM_SYNC_PROVIDERS = ["salesforce", "hubspot"] as const;
type CrmSyncProvider = (typeof CRM_SYNC_PROVIDERS)[number];
const isCrmSync = (p: string): p is CrmSyncProvider => (CRM_SYNC_PROVIDERS as readonly string[]).includes(p);
export const CRM_SYNC_STALE_MS = 15 * 60 * 1000;
const STALE_SYNC_ERROR = "The sync stopped responding and was ended. It runs again on its schedule, or sync now to retry.";

/** Old in-progress runs the sweep looks at per provider: live chains and dead runs alike. */
const STALE_SWEEP_SCAN = 2000;

/** When a run last showed it was alive: its latest heartbeat, or its start. */
const lastAlive = (run: Doc<"integrationSyncRuns">) => Math.max(run.startedAt, run.progress?.heartbeatAt ?? 0);

function inFlightRuns(ctx: QueryCtx, orgId: Id<"organizations">, provider: CrmSyncProvider) {
  return ctx.db
    .query("integrationSyncRuns")
    .withIndex("by_orgId_provider_startedAt", (q) => q.eq("orgId", orgId).eq("provider", provider))
    .order("desc")
    .take(20)
    .then((runs) => runs.filter((run) => run.status === "in_progress"));
}

/** Ends a run as an error, and its connection's "in progress" status with it unless another run is still going. */
async function endSyncRun(ctx: MutationCtx, run: Doc<"integrationSyncRuns">, error: string) {
  const now = Date.now();
  await ctx.db.patch(run._id, { status: "error", error, finishedAt: now });
  if (isCrmSync(run.provider) && (await inFlightRuns(ctx, run.orgId, run.provider)).length) return;
  const integration = await ctx.db
    .query("integrations")
    .withIndex("by_orgId_provider", (q) => q.eq("orgId", run.orgId).eq("provider", run.provider as Provider))
    .first();
  if (integration?.lastSyncStatus === "in_progress") {
    await ctx.db.patch(integration._id, { lastSyncStatus: "error", lastSyncError: error, updatedAt: now });
  }
}

/** Every few minutes: end the CRM sync runs that have outlived any action. */
export const endStaleSyncs = internalMutation({
  args: {},
  handler: async (ctx) => {
    let ended = 0;
    for (const provider of CRM_SYNC_PROVIDERS) {
      // Long-running live chains sort first among old runs, so look past them to the dead ones behind.
      const dead: Doc<"integrationSyncRuns">[] = [];
      let examined = 0;
      for await (const run of ctx.db
        .query("integrationSyncRuns")
        .withIndex("by_status_and_provider_and_startedAt", (q) =>
          q.eq("status", "in_progress").eq("provider", provider).lt("startedAt", Date.now() - CRM_SYNC_STALE_MS),
        )) {
        if (Date.now() - lastAlive(run) >= CRM_SYNC_STALE_MS) dead.push(run);
        if (dead.length >= 100 || ++examined >= STALE_SWEEP_SCAN) break;
      }
      for (const run of dead) await endSyncRun(ctx, run, STALE_SYNC_ERROR);
      ended += dead.length;
    }
    return { ended };
  },
});

/** Stop the org's running HubSpot or Salesforce sync. A live one stops at its next stage. */
export const stopSync = mutation({
  args: { provider: v.union(v.literal("salesforce"), v.literal("hubspot")) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
    const error = `Sync stopped by ${user.name || user.email}.`;
    const runs = await inFlightRuns(ctx, user.orgId, args.provider);
    for (const run of runs) await endSyncRun(ctx, run, error);
    // A connection marked in progress with no run behind it is stuck the same way.
    const integration = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", user.orgId).eq("provider", args.provider))
      .first();
    if (integration?.lastSyncStatus === "in_progress") {
      await ctx.db.patch(integration._id, { lastSyncStatus: "error", lastSyncError: error, updatedAt: Date.now() });
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      verb: "stop",
      operation: `${args.provider}.sync`,
      status: "applied",
      details: { runs: runs.map((run) => run._id) },
      createdAt: Date.now(),
    });
    return { stopped: runs.length };
  },
});

/** Whether a sync run is still meant to go on: false once stopped or ended. */
export const syncRunLive = internalQuery({
  args: { syncRunId: v.id("integrationSyncRuns") },
  handler: async (ctx, args) => (await ctx.db.get(args.syncRunId))?.status === "in_progress",
});

// Which CRM the org's hygiene/apply flows should target. Returns the single
// active CRM provider, or throws when ambiguous — callers that support
// per-provider disambiguation should pass an explicit provider instead.
export const activeCrmProviderForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const providers: Array<"hubspot" | "salesforce"> = [];
    for (const provider of ["hubspot", "salesforce"] as const) {
      const row = await ctx.db
        .query("integrations")
        .withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", provider))
        .first();
      if (row && row.isActive !== false) providers.push(provider);
    }
    if (providers.length === 0) throw new Error("No active CRM integration for this organization");
    if (providers.length > 1) throw new Error("Multiple active CRM integrations — cannot infer apply target");
    return providers[0];
  },
});

// One-off (idempotent) backfill: give pre-existing CRM connections the daily
// default schedule that new connections now receive at connect time.
// Run: npx convex run integrations:backfillDefaultSyncSchedule
export const backfillDefaultSyncSchedule = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("integrations").take(500);
    let updated = 0;
    for (const row of rows) {
      if (!isSynced(row.provider)) continue;
      const schedule = (row.syncConfig as { schedule?: string } | undefined)?.schedule;
      if (schedule) continue;
      await ctx.db.patch(row._id, {
        syncConfig: { ...((row.syncConfig as object | undefined) ?? {}), schedule: "daily" },
      });
      updated += 1;
    }
    return { scanned: rows.length, updated };
  },
});
