"use node";

import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
// Node-free module imports (never the package barrel) — established pattern.
import {
  captureMarket,
  computeFrontStates,
  createMemoryMarketStore,
  diffFrontStates,
  observationId,
  validateObservationSet,
  verifyEvidenceSpans,
  type CaptureEntry,
  type MarketConfig,
  type MarketObservation,
  type MarketStore,
  type ObservationSet,
} from "../engine/src/market.ts";
import { classifyMarket } from "../engine/src/marketClassify.ts";
import { assessAxes } from "../engine/src/marketAxes.ts";
import { suggestMarketConfig } from "../engine/src/marketTaxonomy.ts";
import {
  createProgressEmitter,
  MARKET_CAPTURE_STAGES,
  type ProgressEmitter,
} from "../engine/src/progress.ts";
import { resolveLlm } from "./lib/llmResolver";

/**
 * Market Map run actions — the hosted MVP of the CLI `market` layer, running
 * the SAME package engines over a Convex-backed MarketStore so a hosted map
 * and a CLI workspace stay in sync by construction:
 *
 *  - runCapture  == `market capture`  (captureMarket: SSRF-guarded fetch,
 *                   readable-text extraction, content-addressed hashes)
 *  - runClassify == `market classify` (classifyMarket: LLM proposals with the
 *                   sacred evidence gate — every quoted span is mechanically
 *                   verified verbatim against the stored capture it cites, one
 *                   retry with the failures named, else the run FAILS and
 *                   nothing is persisted; ConvexMarketStore.append re-verifies
 *                   before writing, so `verified: true` is earned at persist
 *                   time, never asserted). A map with no claim taxonomy yet
 *                   gets one auto-proposed first (suggestMarketConfig — the
 *                   CLI's `market init --auto` engine) and saved to the map.
 *  - fronts/drift/axes == `market fronts` / `market axes` (computeFrontStates,
 *                   diffFrontStates, assessAxes) — computed here right after a
 *                   classify run and persisted onto the marketRuns row, because
 *                   the default Convex runtime can't import the node-tainted
 *                   package module. The CLI recomputes on demand; hosted reads
 *                   per-run snapshots. Same math, same inputs.
 *
 * Intentionally NOT in the hosted MVP (CLI-only for now): `market sourcing`,
 * `scale`, `overlay` (CRM directive layer), `worksheet`/`observe` (the no-key
 * manual channel), the md/html `report` renderer, and `refresh` scheduling.
 *
 * LLM credentials come from lib/llmResolver: the caller's connected ChatGPT
 * plan. Without one, classify reports itself skipped.
 */

/**
 * Capture content cap per row (chars). The classifier's dossier budget is
 * 48K chars/vendor anyway, and the evidence verifier reads the SAME stored
 * text the model saw, so truncation never desyncs quotes from pages.
 */
const MAX_CAPTURE_CONTENT_CHARS = 50_000;
const CAPTURE_PAGE_SIZE = 20;
const CAPTURE_INSERT_BATCH = 10;

type MarketMap = Doc<"marketMaps">;
type ClassificationRow = Doc<"marketClassifications">;

function newRunLabel(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // e.g. 20260702T153000
  return `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Hosted map document → the package's MarketConfig (domain == vendor id). */
function mapToMarketConfig(map: MarketMap): MarketConfig {
  const anchor = map.anchorDomain && map.competitors.some((c) => c.domain === map.anchorDomain)
    ? map.anchorDomain
    : undefined;
  return {
    category: map.category,
    ...(anchor ? { anchorVendor: anchor } : {}),
    vendors: map.competitors.map((competitor) => ({
      id: competitor.domain,
      name: competitor.name,
      urls: {
        home: `https://${competitor.domain}/`,
        pricing: null,
        product: competitor.urls ?? [],
      },
    })),
    claims: map.claims ?? [],
    ...(map.surfaceRule ? { surfaceRule: map.surfaceRule } : {}),
    ...(map.axes ? { axes: map.axes } : {}),
    ...(map.primaryAxes && map.primaryAxes.length === 2
      ? { primaryAxes: [map.primaryAxes[0], map.primaryAxes[1]] as [string, string] }
      : {}),
  };
}

function rowsToObservationSet(category: string, rows: ClassificationRow[]): ObservationSet | null {
  if (rows.length === 0) return null;
  const { runLabel, runAt, extractor } = rows[0];
  const observedAt = new Date(runAt).toISOString();
  const observations: MarketObservation[] = [];
  for (const row of rows) {
    for (const reading of row.readings) {
      const obsId = observationId(category, runLabel, row.competitorDomain, reading.claimId);
      observations.push({
        id: obsId,
        vendorId: row.competitorDomain,
        claimId: reading.claimId,
        observedAt,
        intensity: reading.intensity,
        confidence: reading.confidence,
        reason: reading.reason,
        evidence: reading.evidence.map((item, index) => ({
          id: `${obsId}_ev${index}`,
          sourceSystem: "web" as const,
          sourceObjectType: "page",
          sourceObjectId: item.url,
          text: item.quote,
          observedAt,
          metadata: { url: item.url, captureHash: item.captureHash },
        })),
      });
    }
  }
  return { id: `set_${category}_${runLabel}`, category, runLabel, runAt: observedAt, extractor, observations };
}

/**
 * The package MarketStore implemented over the Convex tables. Reads are paged
 * (≤20 rows ≈ 1MiB per internal query call — see market.listCapturePage);
 * writes are batched. `captureRunLabel` scopes loadCaptureTexts to one run so
 * the read never grows with capture history.
 */
function createConvexMarketStore(
  ctx: ActionCtx,
  scope: {
    orgId: Id<"organizations">;
    mapId: Id<"marketMaps">;
    category: string;
    captureRunLabel?: string;
  },
): MarketStore {
  // captureMarket saves texts before it appends entries; buffer them here and
  // join content onto the rows at append time (one row per page, CLI-manifest
  // shaped). Content-addressing still dedupes work upstream.
  const pendingTexts = new Map<string, string>();

  async function fetchRows(runLabel?: string): Promise<Doc<"marketCaptures">[]> {
    const rows: Doc<"marketCaptures">[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: {
        page: Doc<"marketCaptures">[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.market.listCapturePage, {
        mapId: scope.mapId,
        runLabel,
        cursor,
        numItems: CAPTURE_PAGE_SIZE,
      });
      rows.push(...page.page);
      if (page.isDone) return rows;
      cursor = page.continueCursor;
    }
  }

  const loadCaptureTexts = async () => {
    const rows = await fetchRows(scope.captureRunLabel);
    const entries: CaptureEntry[] = rows.map((row) => ({
      runLabel: row.runLabel,
      vendorId: row.competitorDomain,
      kind: row.kind,
      url: row.url,
      fetchedAt: new Date(row.capturedAt).toISOString(),
      httpStatus: row.httpStatus,
      captureHash: row.captureHash,
      textChars: row.textChars,
    }));
    const textByHash = new Map<string, string>();
    for (const row of rows) {
      if (row.captureHash && row.content && !textByHash.has(row.captureHash)) {
        textByHash.set(row.captureHash, row.content);
      }
    }
    return { entries, textByHash };
  };

  return {
    captureLocation: () => `convex://marketCaptures/${scope.mapId}`,
    async saveCaptureText(captureHash, text) {
      pendingTexts.set(captureHash, text);
    },
    async appendCaptureEntries(entries) {
      for (let i = 0; i < entries.length; i += CAPTURE_INSERT_BATCH) {
        const batch = entries.slice(i, i + CAPTURE_INSERT_BATCH).map((entry) => {
          const text = entry.captureHash ? pendingTexts.get(entry.captureHash) : undefined;
          const truncated = text !== undefined && text.length > MAX_CAPTURE_CONTENT_CHARS;
          return {
            runLabel: entry.runLabel,
            competitorDomain: entry.vendorId,
            kind: entry.kind,
            url: entry.url,
            capturedAt: Date.parse(entry.fetchedAt) || Date.now(),
            httpStatus: entry.httpStatus,
            captureHash: entry.captureHash,
            textChars: entry.textChars,
            ...(text !== undefined
              ? { content: truncated ? text.slice(0, MAX_CAPTURE_CONTENT_CHARS) : text }
              : {}),
            ...(truncated ? { contentTruncated: true } : {}),
          };
        });
        await ctx.runMutation(internal.market.insertCaptureRows, {
          orgId: scope.orgId,
          mapId: scope.mapId,
          rows: batch,
        });
      }
    },
    loadCaptureTexts,
    observations: {
      async append(set) {
        if (set.category !== scope.category) {
          throw new Error(
            `Observation set category "${set.category}" does not match store "${scope.category}"`,
          );
        }
        const exists: boolean = await ctx.runQuery(internal.market.classificationRunExists, {
          mapId: scope.mapId,
          runLabel: set.runLabel,
        });
        if (exists) {
          throw new Error(
            `Run "${set.runLabel}" already exists — observations are append-only; use a new run label`,
          );
        }
        // THE EVIDENCE GATE, re-run at persist time: `verified: true` below is
        // earned by this check, never asserted. classifyMarket already
        // verified every span, but the store defends itself — any future
        // caller that appends without verifying gets rejected here.
        const { textByHash } = await loadCaptureTexts();
        const failures = verifyEvidenceSpans(set.observations, textByHash);
        if (failures.length > 0) {
          const detail = failures
            .slice(0, 5)
            .map((failure) => `${failure.vendorId} × ${failure.claimId}: ${failure.problem}`);
          throw new Error(
            `Refusing to persist: ${failures.length} evidence span(s) failed verification against the stored captures.\n  ${detail.join("\n  ")}`,
          );
        }
        const byVendor = new Map<string, MarketObservation[]>();
        for (const obs of set.observations) {
          const bucket = byVendor.get(obs.vendorId) ?? [];
          bucket.push(obs);
          byVendor.set(obs.vendorId, bucket);
        }
        const runAt = Date.parse(set.runAt) || Date.now();
        const model = set.extractor.split(":").slice(2).join(":") || set.extractor;
        for (const [competitorDomain, observations] of byVendor) {
          await ctx.runMutation(internal.market.insertClassificationRow, {
            orgId: scope.orgId,
            mapId: scope.mapId,
            runLabel: set.runLabel,
            runAt,
            extractor: set.extractor,
            model,
            competitorDomain,
            classifiedAt: Date.now(),
            readings: observations.map((obs) => ({
              claimId: obs.claimId,
              intensity: obs.intensity,
              confidence: obs.confidence,
              reason: obs.reason,
              evidence: obs.evidence.map((item) => ({
                quote: item.text,
                url: String(item.metadata?.url ?? item.sourceObjectId),
                captureHash: String(item.metadata?.captureHash ?? ""),
                verified: true,
              })),
            })),
          });
        }
        return set;
      },
      async get(runLabel) {
        const rows: ClassificationRow[] = await ctx.runQuery(
          internal.market.listClassificationsForRun,
          { mapId: scope.mapId, runLabel },
        );
        return rowsToObservationSet(scope.category, rows);
      },
      async list() {
        const runs: Doc<"marketRuns">[] = await ctx.runQuery(internal.market.listClassifyRuns, {
          mapId: scope.mapId,
        });
        return runs
          .map((run) => ({
            runLabel: run.runLabel,
            runAt: new Date(run.startedAt).toISOString(),
            observations: Number((run.counts as { observations?: number } | undefined)?.observations ?? 0),
          }))
          .reverse();
      },
      async latest() {
        const runs: Doc<"marketRuns">[] = await ctx.runQuery(internal.market.listClassifyRuns, {
          mapId: scope.mapId,
        });
        if (runs.length === 0) return null;
        const rows: ClassificationRow[] = await ctx.runQuery(
          internal.market.listClassificationsForRun,
          { mapId: scope.mapId, runLabel: runs[0].runLabel },
        );
        return rowsToObservationSet(scope.category, rows);
      },
    },
  };
}

/**
 * Progress emitter whose listener fire-and-forgets a heartbeat patch onto the
 * marketRuns row (same contract as hubspotActions.syncRunProgressEmitter:
 * throttled at the emitter, failures swallowed twice — a heartbeat can never
 * fail the run).
 */
function marketRunProgressEmitter(ctx: ActionCtx, runId: Id<"marketRuns">): ProgressEmitter {
  return createProgressEmitter(
    (_event, snapshot) => {
      void ctx
        .runMutation(internal.market.heartbeatRun, {
          runId,
          progress: {
            stage: snapshot.stage,
            stageIndex: snapshot.stageIndex,
            stageCount: snapshot.stageCount,
            itemsDone: snapshot.itemsDone,
            itemsTotal: snapshot.itemsTotal,
            note: snapshot.note,
            heartbeatAt: snapshot.updatedAt,
          },
        })
        .catch(() => {});
    },
    { throttleMs: 3000 },
  );
}

/** `market capture` for a hosted map: fetch every competitor page, store rows. */
export const runCapture = action({
  args: { mapId: v.id("marketMaps") },
  handler: async (
    ctx,
    args,
  ): Promise<{ runLabel: string; pages: number; failed: number }> => {
    const map: MarketMap = await ctx.runQuery(internal.market.getMapForRun, { mapId: args.mapId });
    const config = mapToMarketConfig(map);
    const runLabel = newRunLabel();
    const runId: Id<"marketRuns"> = await ctx.runMutation(internal.market.createRun, {
      orgId: map.orgId,
      mapId: map._id,
      kind: "capture",
      runLabel,
    });
    const store = createConvexMarketStore(ctx, {
      orgId: map.orgId,
      mapId: map._id,
      category: map.category,
    });
    const progress = marketRunProgressEmitter(ctx, runId);
    try {
      const result = await captureMarket(config, { runLabel, store, progress });
      const failed = result.entries.filter((entry) => !entry.captureHash).length;
      await ctx.runMutation(internal.market.finishRun, {
        runId,
        status: "success",
        counts: { pages: result.entries.length, failed },
        mapPatch: { lastCaptureAt: Date.now(), lastCaptureRunLabel: runLabel },
      });
      return { runLabel, pages: result.entries.length, failed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.market.finishRun, { runId, status: "error", error: message });
      throw error;
    }
  },
});

/**
 * `market classify` for a hosted map: LLM intensity readings over the stored
 * captures, verbatim-evidence-verified, then fronts/drift/axes persisted onto
 * the run row. First run on a claim-less map auto-proposes the taxonomy.
 */
export const runClassify = action({
  args: { mapId: v.id("marketMaps") },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { skipped: string }
    | { runLabel: string; observations: number; model: string; taxonomyProposed: boolean }
  > => {
    const map: MarketMap = await ctx.runQuery(internal.market.getMapForRun, { mapId: args.mapId });
    const userId: Id<"users"> | null = await ctx.runQuery(internal.chatgptAuth.currentUserId, {});
    const llm = await resolveLlm(ctx, userId);
    if (!llm) {
      return { skipped: "no LLM available (connect ChatGPT in Integrations → ChatGPT)" };
    }
    if (!map.lastCaptureRunLabel) {
      throw new ConvexError("Run capture first — classification judges stored captures only.");
    }

    const runLabel = newRunLabel();
    const runId: Id<"marketRuns"> = await ctx.runMutation(internal.market.createRun, {
      orgId: map.orgId,
      mapId: map._id,
      kind: "classify",
      runLabel,
    });
    const store = createConvexMarketStore(ctx, {
      orgId: map.orgId,
      mapId: map._id,
      category: map.category,
      captureRunLabel: map.lastCaptureRunLabel,
    });
    const progress = marketRunProgressEmitter(ctx, runId);
    try {
      let config = mapToMarketConfig(map);
      let taxonomyProposed = false;
      if (config.claims.length === 0) {
        // Cold start: propose the claim taxonomy from the competitors' own
        // pages (the CLI's `market init --auto` engine). Grounding captures go
        // to a throwaway memory store; only the reviewed-shape config (claims
        // + surface rule) is persisted, onto the map for the analyst to edit.
        progress.stage(MARKET_CAPTURE_STAGES[0], 0, MARKET_CAPTURE_STAGES.length);
        progress.note("proposing claim taxonomy from competitor pages");
        const suggestion = await suggestMarketConfig({
          category: map.category,
          vendors: map.competitors.map((competitor) => ({
            url: `https://${competitor.domain}/`,
            name: competitor.name,
            anchor: competitor.domain === map.anchorDomain,
          })),
          llm,
          store: createMemoryMarketStore(map.category),
        });
        await ctx.runMutation(internal.market.updateMapTaxonomy, {
          mapId: map._id,
          claims: suggestion.config.claims,
          surfaceRule: suggestion.config.surfaceRule,
        });
        config = {
          ...config,
          claims: suggestion.config.claims,
          surfaceRule: suggestion.config.surfaceRule,
        };
        taxonomyProposed = true;
      }

      const prior = await store.observations.latest();
      const result = await classifyMarket(config, {
        llm,
        runLabel,
        captureRun: map.lastCaptureRunLabel,
        store,
        progress,
      });
      const problems = validateObservationSet(config, result.set);
      if (problems.length > 0) {
        throw new Error(`Classified set failed validation: ${problems.slice(0, 5).join("; ")}`);
      }

      progress.stage(MARKET_CAPTURE_STAGES[3], 3, MARKET_CAPTURE_STAGES.length);
      // append re-verifies every quoted span against the stored captures
      // before anything is written (see createConvexMarketStore).
      await store.observations.append(result.set);

      // Derived views (same pure engines as `market fronts` / `market axes`),
      // snapshotted per run — see the file doc comment for why hosted persists
      // what the CLI recomputes.
      const fronts = computeFrontStates(config, result.set);
      const frontDrift = prior ? diffFrontStates(computeFrontStates(config, prior), fronts) : [];
      // JSON round-trip strips `undefined` optionals (not a legal Convex value).
      const axes = JSON.parse(JSON.stringify(assessAxes(config, result.set)));
      await ctx.runMutation(internal.market.finishRun, {
        runId,
        status: "success",
        counts: {
          observations: result.set.observations.length,
          vendors: config.vendors.length,
          retriedVendors: result.retriedVendorIds.length,
        },
        fronts,
        frontDrift,
        axes,
        mapPatch: { lastClassifyAt: Date.now(), lastClassifyRunLabel: runLabel },
      });
      return {
        runLabel,
        observations: result.set.observations.length,
        model: result.model,
        taxonomyProposed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.market.finishRun, { runId, status: "error", error: message });
      throw error;
    }
  },
});
