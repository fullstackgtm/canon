import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";

/**
 * Market Map — queries/mutations for the hosted MVP of the CLI `market`
 * layer. This file is default-runtime only (it must NOT import the package's
 * market modules, which pull node builtins); the engines run in
 * convex/marketActions.ts ("use node"), which talks to these internal
 * functions through the package's MarketStore seam.
 */

const MAX_COMPETITORS = 15;

const competitorValidator = v.object({
  name: v.string(),
  domain: v.string(),
  urls: v.optional(v.array(v.string())),
});

const claimValidator = v.object({
  id: v.string(),
  capability: v.string(),
  icp: v.string(),
  pricingStructure: v.string(),
  definition: v.string(),
  terms: v.optional(v.array(v.string())),
});

/** "https://www.Acme.com/pricing " → "www.acme.com" (the package vendor id). */
function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  const host = trimmed.split(/[/?#]/, 1)[0];
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    throw new ConvexError(`"${raw}" is not a valid domain (expected e.g. acme.com)`);
  }
  return host;
}

function normalizeCompetitors(
  competitors: Array<{ name: string; domain: string; urls?: string[] }>,
) {
  if (competitors.length === 0) throw new ConvexError("At least one competitor is required");
  if (competitors.length > MAX_COMPETITORS) {
    throw new ConvexError(`At most ${MAX_COMPETITORS} competitors per map (a focused set maps better)`);
  }
  const seen = new Set<string>();
  return competitors.map((competitor) => {
    const domain = normalizeDomain(competitor.domain);
    if (seen.has(domain)) throw new ConvexError(`Duplicate competitor domain "${domain}"`);
    seen.add(domain);
    const name = competitor.name.trim() || domain;
    const urls = (competitor.urls ?? [])
      .map((url) => url.trim())
      .filter((url) => /^https?:\/\//i.test(url))
      .slice(0, 5);
    return { name, domain, ...(urls.length > 0 ? { urls } : {}) };
  });
}

async function mustGetOrgMap(
  ctx: QueryCtx | MutationCtx,
  mapId: Id<"marketMaps">,
  orgId: Id<"organizations">,
): Promise<Doc<"marketMaps">> {
  const map = await ctx.db.get(mapId);
  if (!map || map.orgId !== orgId) throw new ConvexError("Market map not found");
  return map;
}

// ── Public queries ───────────────────────────────────────────────────────────

/** All maps for the org. Read budget: ≤50 small config docs. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("marketMaps")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(50);
  },
});

/**
 * One map with its latest capture run (content stripped), latest classify run
 * rows (verbatim evidence included), and recent runs (live progress).
 *
 * Read budget: 1 map + ≤60 capture rows (≤50KB content each ≈ 3MiB — content
 * bytes count against the read budget even though we strip them from the
 * result) + ≤30 classification rows (≈20KB each) + ≤10 run rows. Total ≈ 100
 * docs / ≤4.5MiB, well under the 4096-doc / 16MiB query limits.
 */
export const get = query({
  args: { mapId: v.id("marketMaps") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const map = await ctx.db.get(args.mapId);
    if (!map || map.orgId !== user.orgId) return null;

    const captures = map.lastCaptureRunLabel
      ? await ctx.db
          .query("marketCaptures")
          .withIndex("by_mapId_runLabel", (q) =>
            q.eq("mapId", map._id).eq("runLabel", map.lastCaptureRunLabel!),
          )
          .take(60)
      : [];
    const classifications = map.lastClassifyRunLabel
      ? await ctx.db
          .query("marketClassifications")
          .withIndex("by_mapId_runLabel", (q) =>
            q.eq("mapId", map._id).eq("runLabel", map.lastClassifyRunLabel!),
          )
          .take(30)
      : [];
    const runs = await ctx.db
      .query("marketRuns")
      .withIndex("by_mapId", (q) => q.eq("mapId", map._id))
      .order("desc")
      .take(10);

    return {
      map,
      // Page content stays server-side; the UI needs status, not 50KB of text.
      captures: captures.map(({ content: _content, ...rest }) => rest),
      classifications,
      runs,
    };
  },
});

// ── Public mutations (admin/manager gated) ──────────────────────────────────

export const createMap = mutation({
  args: {
    name: v.string(),
    category: v.string(),
    competitors: v.array(competitorValidator),
    anchorDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const name = args.name.trim();
    const category = args.category.trim();
    if (!name) throw new ConvexError("Map name is required");
    if (!category) throw new ConvexError("Category is required");
    const competitors = normalizeCompetitors(args.competitors);
    const anchorDomain = args.anchorDomain ? normalizeDomain(args.anchorDomain) : undefined;
    if (anchorDomain && !competitors.some((competitor) => competitor.domain === anchorDomain)) {
      throw new ConvexError(`Anchor domain "${anchorDomain}" must be one of the competitors`);
    }
    const now = Date.now();
    return ctx.db.insert("marketMaps", {
      orgId: user.orgId,
      name,
      category,
      competitors,
      ...(anchorDomain ? { anchorDomain } : {}),
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateMap = mutation({
  args: {
    mapId: v.id("marketMaps"),
    name: v.optional(v.string()),
    competitors: v.optional(v.array(competitorValidator)),
    anchorDomain: v.optional(v.string()),
    surfaceRule: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const map = await mustGetOrgMap(ctx, args.mapId, user.orgId);
    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      if (!args.name.trim()) throw new ConvexError("Map name is required");
      updates.name = args.name.trim();
    }
    if (args.competitors !== undefined) updates.competitors = normalizeCompetitors(args.competitors);
    if (args.anchorDomain !== undefined) updates.anchorDomain = normalizeDomain(args.anchorDomain);
    if (args.surfaceRule !== undefined) updates.surfaceRule = args.surfaceRule;
    await ctx.db.patch(map._id, updates);
    return map._id;
  },
});

export const deleteMap = mutation({
  args: { mapId: v.id("marketMaps") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    const map = await mustGetOrgMap(ctx, args.mapId, user.orgId);
    await ctx.db.delete(map._id);
    // Child rows (captures / classifications / runs) can outnumber a single
    // transaction's budget, so they are purged in scheduled batches.
    await ctx.scheduler.runAfter(0, internal.market.purgeMapChildren, { mapId: args.mapId });
    return null;
  },
});

/**
 * Batched child purge after deleteMap: ≤100 docs per table per invocation
 * (≤300 reads+writes, safely inside transaction limits); reschedules itself
 * until every table is clean.
 */
export const purgeMapChildren = internalMutation({
  args: { mapId: v.id("marketMaps") },
  handler: async (ctx, args) => {
    let remaining = false;
    for (const table of ["marketCaptures", "marketClassifications", "marketRuns"] as const) {
      const batch = await ctx.db
        .query(table)
        .withIndex("by_mapId", (q) => q.eq("mapId", args.mapId))
        .take(100);
      for (const row of batch) await ctx.db.delete(row._id);
      if (batch.length === 100) remaining = true;
    }
    if (remaining) {
      await ctx.scheduler.runAfter(0, internal.market.purgeMapChildren, { mapId: args.mapId });
    }
  },
});

// ── Internal functions for the Node actions (marketActions.ts) ─────────────

/**
 * Auth + org gate for run actions: the action's identity flows through
 * ctx.runQuery, so requireCap works here exactly as in a mutation.
 */
export const getMapForRun = internalQuery({
  args: { mapId: v.id("marketMaps") },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    return mustGetOrgMap(ctx, args.mapId, user.orgId);
  },
});

export const createRun = internalMutation({
  args: {
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    kind: v.union(v.literal("capture"), v.literal("classify")),
    runLabel: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("marketRuns", {
      orgId: args.orgId,
      mapId: args.mapId,
      kind: args.kind,
      runLabel: args.runLabel,
      status: "in_progress",
      startedAt: Date.now(),
    });
  },
});

/**
 * Live heartbeat (the shared progress vocabulary, already throttled at the
 * emitter). 1 read + 1 write; failures are swallowed by the caller — a
 * heartbeat must never fail the run.
 */
export const heartbeatRun = internalMutation({
  args: {
    runId: v.id("marketRuns"),
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
    await ctx.db.patch(args.runId, { progress: args.progress });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("marketRuns"),
    status: v.union(v.literal("success"), v.literal("error")),
    counts: v.optional(v.any()),
    error: v.optional(v.string()),
    fronts: v.optional(
      v.array(
        v.object({
          claimId: v.string(),
          state: v.string(),
          loudVendorIds: v.array(v.string()),
          quietVendorIds: v.array(v.string()),
        }),
      ),
    ),
    frontDrift: v.optional(
      v.array(v.object({ claimId: v.string(), before: v.string(), after: v.string() })),
    ),
    axes: v.optional(v.any()),
    // Recency denormalization onto the map, applied atomically with the finish.
    mapPatch: v.optional(
      v.object({
        lastCaptureAt: v.optional(v.number()),
        lastCaptureRunLabel: v.optional(v.string()),
        lastClassifyAt: v.optional(v.number()),
        lastClassifyRunLabel: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      ...(args.counts !== undefined ? { counts: args.counts } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.fronts !== undefined ? { fronts: args.fronts } : {}),
      ...(args.frontDrift !== undefined ? { frontDrift: args.frontDrift } : {}),
      ...(args.axes !== undefined ? { axes: args.axes } : {}),
    });
    if (args.mapPatch && args.status === "success") {
      await ctx.db.patch(run.mapId, { ...args.mapPatch, updatedAt: Date.now() });
    }
  },
});

/** Persist the auto-proposed claim taxonomy (first classify run, empty map). */
export const updateMapTaxonomy = internalMutation({
  args: {
    mapId: v.id("marketMaps"),
    claims: v.array(claimValidator),
    surfaceRule: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.mapId, {
      claims: args.claims,
      ...(args.surfaceRule !== undefined ? { surfaceRule: args.surfaceRule } : {}),
      updatedAt: Date.now(),
    });
  },
});

/** Batch insert from the ConvexMarketStore (≤10 rows/call ≈ ≤500KB args). */
export const insertCaptureRows = internalMutation({
  args: {
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    rows: v.array(
      v.object({
        runLabel: v.string(),
        competitorDomain: v.string(),
        kind: v.union(v.literal("home"), v.literal("pricing"), v.literal("product")),
        url: v.string(),
        capturedAt: v.number(),
        httpStatus: v.union(v.number(), v.null()),
        captureHash: v.union(v.string(), v.null()),
        textChars: v.number(),
        content: v.optional(v.string()),
        contentTruncated: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const row of args.rows) {
      await ctx.db.insert("marketCaptures", { orgId: args.orgId, mapId: args.mapId, ...row });
    }
  },
});

/**
 * One page of capture rows for the store adapter. Read budget per call:
 * ≤numItems (caller uses 20) docs × ≤50KB content ≈ 1MiB; the action loops
 * pages so no single query grows with history.
 */
export const listCapturePage = internalQuery({
  args: {
    mapId: v.id("marketMaps"),
    runLabel: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(args.numItems, 1), 20);
    const builder = args.runLabel
      ? ctx.db
          .query("marketCaptures")
          .withIndex("by_mapId_runLabel", (q) =>
            q.eq("mapId", args.mapId).eq("runLabel", args.runLabel!),
          )
      : ctx.db.query("marketCaptures").withIndex("by_mapId", (q) => q.eq("mapId", args.mapId));
    return builder.paginate({ cursor: args.cursor, numItems });
  },
});

export const classificationRunExists = internalQuery({
  args: { mapId: v.id("marketMaps"), runLabel: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("marketClassifications")
      .withIndex("by_mapId_runLabel", (q) =>
        q.eq("mapId", args.mapId).eq("runLabel", args.runLabel),
      )
      .first();
    return row !== null;
  },
});

/** One competitor's row per call (≈20KB worst case — no batching needed). */
export const insertClassificationRow = internalMutation({
  args: {
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    runLabel: v.string(),
    runAt: v.number(),
    extractor: v.string(),
    model: v.string(),
    competitorDomain: v.string(),
    classifiedAt: v.number(),
    readings: v.array(
      v.object({
        claimId: v.string(),
        intensity: v.union(
          v.literal("loud"),
          v.literal("quiet"),
          v.literal("absent"),
          v.literal("unobservable"),
        ),
        confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
        reason: v.string(),
        evidence: v.array(
          v.object({
            quote: v.string(),
            url: v.string(),
            captureHash: v.string(),
            verified: v.boolean(),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("marketClassifications", args);
  },
});

/** Rows for one classify run. Read budget: ≤30 rows × ≈20KB ≈ 600KB. */
export const listClassificationsForRun = internalQuery({
  args: { mapId: v.id("marketMaps"), runLabel: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("marketClassifications")
      .withIndex("by_mapId_runLabel", (q) =>
        q.eq("mapId", args.mapId).eq("runLabel", args.runLabel),
      )
      .take(30);
  },
});

/**
 * Recent classify runs (successful ones carry observation runs). Small rows;
 * bounded take(100), newest first.
 */
export const listClassifyRuns = internalQuery({
  args: { mapId: v.id("marketMaps") },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("marketRuns")
      .withIndex("by_mapId", (q) => q.eq("mapId", args.mapId))
      .order("desc")
      .take(100);
    return runs.filter((run) => run.kind === "classify" && run.status === "success");
  },
});
