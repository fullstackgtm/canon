import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser } from "./lib";
import { modelSettings } from "./lib/recipes";
import { TIMINGS_VERSION } from "./lib/calls/granola";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import {
  extractCallInsights,
  parseTranscript,
  summarizeInsights,
  type CallInsightType,
} from "./lib/callInsightExtraction";

const providerValidator = v.union(
  v.literal("gong"),
  v.literal("chorus"),
  v.literal("fathom"),
  v.literal("avoma"),
  v.literal("granola"),
  v.literal("salesforce"),
  v.literal("hubspot"),
  v.literal("csv"),
  v.literal("manual"),
  v.literal("custom"),
  v.literal("telnyx"),
);

function callReadinessFromRows(calls: any[], insights: any[], connectedProviders: string[]) {
  const callsWithTranscripts = calls.filter((call) => Boolean(call.transcriptText)).length;
  const analyzedCalls = calls.filter((call) => call.insightStatus === "analyzed").length;
  const relevant = connectedProviders.length > 0 || calls.length > 0;
  return {
    noun: "call",
    required: false,
    relevant,
    configured: calls.length > 0,
    lifecycle: !relevant ? "not_connected" : analyzedCalls > 0 ? "analyzed" : "imported",
    signals: { connectedProviders, totalCalls: calls.length, callsWithTranscripts, analyzedCalls, totalInsights: insights.length },
    nextActions: calls.length > 0
      ? ["do call.analyze", "find call insights", "set call.insight_status"]
      : ["connect Gong/Chorus/Fathom/Avoma", "do call.import", "parse call_transcript"],
  };
}

function emptyCallReadiness() {
  return {
    noun: "call",
    required: false,
    relevant: false,
    configured: false,
    lifecycle: "not_connected",
    signals: { connectedProviders: [], totalCalls: 0, callsWithTranscripts: 0, analyzedCalls: 0, totalInsights: 0 },
    nextActions: ["Sign in to inspect call readiness"],
  };
}

/** The error a Granola import is refused with when its poll is stale (see importProviderTranscript). */
export const GRANOLA_STALE_POLL = "granola_stale_poll";

const segmentTimingValidator = v.object({
  side: v.union(v.literal("rep"), v.literal("customer")),
  startSeconds: v.union(v.number(), v.null()),
  endSeconds: v.union(v.number(), v.null()),
});
type SegmentTiming = { side: "rep" | "customer"; startSeconds: number | null; endSeconds: number | null };

const insightTypeValidator = v.union(
  v.literal("pain_point"),
  v.literal("objection"),
  v.literal("competitor_mention"),
  v.literal("next_step"),
  v.literal("feature_request"),
  v.literal("pricing"),
  v.literal("decision_criteria"),
  v.literal("risk"),
  v.literal("coaching_moment"),
);

/**
 * Read budget: calls 250 + integrations 20 + insights 250 + viewer lookup ~2
 * ≈ 522 worst case (was 1000 + 100 + 2000 ≈ 3,100). Readiness only needs
 * bounded samples: totalCalls/totalInsights saturate at 250 ("250 = 250 or
 * more") — configured/lifecycle flip on presence, not exact counts.
 */
export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyCallReadiness();
    const [calls, providers, insights] = await Promise.all([
      ctx.db.query("callRecordings").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(250),
      ctx.db.query("integrations").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(20),
      ctx.db.query("callInsights").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(250),
    ]);
    const activeCallProviders = providers.filter(
      (provider) => provider.isActive && ["gong", "chorus", "fathom", "avoma"].includes(provider.provider),
    );
    return callReadinessFromRows(calls, insights, activeCallProviders.map((provider) => provider.provider));
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyCallReadiness(), summary: emptySummary(), calls: [], insights: [] };
    const [calls, providers, insights] = await Promise.all([
      ctx.db.query("callRecordings").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(200),
      ctx.db.query("integrations").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100),
      ctx.db.query("callInsights").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500),
    ]);
    const activeCallProviders = providers.filter(
      (provider) => provider.isActive && ["gong", "chorus", "fathom", "avoma"].includes(provider.provider),
    );
    const insightCounts = new Map<string, number>();
    for (const insight of insights) {
      insightCounts.set(insight.callId, (insightCounts.get(insight.callId) ?? 0) + 1);
    }
    const callsById = new Map(calls.map((call) => [call._id, call]));
    return {
      readiness: callReadinessFromRows(calls, insights, activeCallProviders.map((provider) => provider.provider)),
      summary: summarizeCallRows(calls, insights),
      calls: calls.map((call) => ({
        ...call,
        insightCount: insightCounts.get(call._id) ?? 0,
        hasTranscript: Boolean(call.transcriptText),
      })),
      insights: insights.map((insight) => {
        const call = callsById.get(insight.callId);
        return {
          ...insight,
          call: call
            ? {
                _id: call._id,
                title: call.title,
                provider: call.provider,
                callDate: call.callDate,
                dealId: call.dealId,
                accountId: call.accountId,
              }
            : null,
        };
      }),
    };
  },
});

export const proposeDealNextStepPatchPlan = mutation({
  args: {
    insightId: v.id("callInsights"),
    nextStep: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "call intelligence over the CRM");
    const insight = await ctx.db.get(args.insightId);
    if (!insight || insight.orgId !== user.orgId) throw new ConvexError("Call insight not found");
    if (insight.type !== "next_step") throw new ConvexError("Only next-step insights can propose deal next-step patches");
    const call = await ctx.db.get(insight.callId);
    if (!call || call.orgId !== user.orgId) throw new ConvexError("Call not found");
    if (!call.dealId) throw new ConvexError("Call is not linked to a deal");
    const deal = await ctx.db.get(call.dealId);
    if (!deal || deal.orgId !== user.orgId) throw new ConvexError("Deal not found");
    const nextStep = (args.nextStep ?? insight.text).trim();
    if (!nextStep) throw new ConvexError("Next step is required");

    const now = Date.now();
    const sourceRuleOrPolicy = "call_intelligence.next_step";
    const rollback =
      "Restore the previous deal next step in Salesforce/HubSpot or the local deal record if verification fails.";
    const planArgs = {
      dealId: call.dealId,
      nextStep,
      sourceInsightId: insight._id,
      sourceCallId: call._id,
      sourceRuleOrPolicy,
      evidenceText: insight.evidence || insight.text,
      currentNextStep: deal.nextStep ?? null,
      proposedNextStep: nextStep,
      crmProvider: deal.crmProvider ?? null,
      crmId: deal.crmId ?? null,
    };
    const reason = `Call insight: ${insight.title}. Evidence: ${insight.evidence || insight.text}`;
    const patchPlanId = await ctx.db.insert("patchPlans", {
      orgId: user.orgId,
      createdBy: user._id,
      verb: "set",
      operation: "deal.next_step",
      args: planArgs,
      reason,
      status: "pending_approval",
      riskLevel: "high",
      approvalRequirement: "required",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("patchOperations", {
      orgId: user.orgId,
      patchPlanId,
      objectType: "deal",
      objectId: call.dealId,
      fieldOrAction: "nextStep",
      beforeValue: deal.nextStep ?? null,
      afterValue: nextStep,
      reason,
      sourceRuleOrPolicy,
      riskLevel: "high",
      approvalRequirement: "required",
      rollback,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("approvalRequests", {
      orgId: user.orgId,
      patchPlanId,
      requestedBy: user._id,
      status: "pending",
      reason,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId,
      userId: user._id,
      patchPlanId,
      verb: "set",
      operation: "deal.next_step",
      status: "previewed",
      details: {
        kind: "patch_plan_preview",
        source: "call_intelligence",
        sourceRuleOrPolicy,
        sourceCallId: call._id,
        sourceInsightId: insight._id,
        evidenceText: insight.evidence || insight.text,
        currentLocalDealNextStep: deal.nextStep ?? null,
        proposedNextStep: nextStep,
        crmProvider: deal.crmProvider ?? null,
        crmId: deal.crmId ?? null,
        riskLevel: "high",
        approvalRequirement: "required",
        rollback,
        args: planArgs,
        reason,
      },
      createdAt: now,
    });
    await ctx.db.patch(insight._id, { status: "reviewed", updatedAt: now });
    return { patchPlanId, status: "pending_approval", operation: "deal.next_step" };
  },
});

export const listCalls = query({
  args: {
    limit: v.optional(v.number()),
    provider: v.optional(providerValidator),
    dealId: v.optional(v.id("deals")),
    accountId: v.optional(v.id("crmAccounts")),
  },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    // Read budget: calls scan 500 + (≤100 visible × 25 insight probe) ≈ 3,002
    // worst case, realistic ≤ ~2,600 — under the 4096 cap. insightCount
    // saturates at 25 per call ("25 = 25 or more"); the detail page (getCall)
    // still returns every insight.
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);

    let calls = await ctx.db
      .query("callRecordings")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(500);

    if (args.provider) calls = calls.filter((call) => call.provider === args.provider);
    if (args.dealId) calls = calls.filter((call) => call.dealId === args.dealId);
    if (args.accountId) calls = calls.filter((call) => call.accountId === args.accountId);

    const visible = calls.slice(0, limit);
    const insightCounts = await Promise.all(
      visible.map(async (call) => {
        const insights = await ctx.db
          .query("callInsights")
          .withIndex("by_callId", (q) => q.eq("callId", call._id))
          .take(25);
        return { callId: call._id, count: insights.length };
      }),
    );
    const counts = new Map(insightCounts.map((row) => [row.callId, row.count]));

    return visible.map((call) => ({
      ...call,
      insightCount: counts.get(call._id) ?? 0,
      hasTranscript: Boolean(call.transcriptText),
    }));
  },
});

export const getCall = query({
  args: { callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== user.orgId) return null;
    const [segments, insights] = await Promise.all([
      ctx.db
        .query("callTranscriptSegments")
        .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", args.callId))
        .collect(),
      ctx.db
        .query("callInsights")
        .withIndex("by_callId", (q) => q.eq("callId", args.callId))
        .collect(),
    ]);
    return { call, segments, insights };
  },
});

export const listInsights = query({
  args: {
    type: v.optional(insightTypeValidator),
    status: v.optional(
      v.union(
        v.literal("open"),
        v.literal("reviewed"),
        v.literal("dismissed"),
        v.literal("synced"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return [];
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
    let insights = await ctx.db
      .query("callInsights")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(500);

    if (args.type) insights = insights.filter((insight) => insight.type === args.type);
    if (args.status) insights = insights.filter((insight) => insight.status === args.status);

    const visible = insights.slice(0, limit);
    const calls = await Promise.all(visible.map((insight) => ctx.db.get(insight.callId)));
    return visible.map((insight, index) => ({
      ...insight,
      call: calls[index]
        ? {
            _id: calls[index]!._id,
            title: calls[index]!.title,
            provider: calls[index]!.provider,
            callDate: calls[index]!.callDate,
            dealId: calls[index]!.dealId,
            accountId: calls[index]!.accountId,
          }
        : null,
    }));
  },
});

export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) {
      return emptySummary();
    }
    const [calls, insights] = await Promise.all([
      ctx.db
        .query("callRecordings")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(1000),
      ctx.db
        .query("callInsights")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(2000),
    ]);

    return summarizeCallRows(calls, insights);
  },
});

export const ingestTranscript = mutation({
  args: {
    provider: v.optional(providerValidator),
    externalCallId: v.optional(v.string()),
    title: v.string(),
    callDate: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    ownerId: v.optional(v.id("users")),
    dealId: v.optional(v.id("deals")),
    accountId: v.optional(v.id("crmAccounts")),
    recordingUrl: v.optional(v.string()),
    participants: v.optional(v.array(v.any())),
    transcriptText: v.string(),
    sourceMetadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "call intelligence over the CRM");
    if (!args.title.trim()) throw new ConvexError("Call title is required");
    if (!args.transcriptText.trim()) throw new ConvexError("Transcript text is required");

    if (args.dealId) await assertDealInOrg(ctx, args.dealId, user.orgId);
    if (args.accountId) await assertAccountInOrg(ctx, args.accountId, user.orgId);

    const now = Date.now();
    const callId = await ctx.db.insert("callRecordings", {
      orgId: user.orgId,
      provider: args.provider ?? "manual",
      externalCallId: args.externalCallId,
      title: args.title.trim(),
      callDate: args.callDate,
      durationSeconds: args.durationSeconds,
      ownerId: args.ownerId ?? user._id,
      dealId: args.dealId,
      accountId: args.accountId,
      participants: args.participants,
      recordingUrl: args.recordingUrl,
      transcriptText: args.transcriptText,
      transcriptStatus: "uploaded",
      insightStatus: "pending",
      sourceMetadata: args.sourceMetadata,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await parseAndStoreSegments(ctx, user.orgId, callId, args.transcriptText, now);
    await ctx.db.patch(callId, { transcriptStatus: "parsed", parsedAt: now, updatedAt: now });
    if (args.dealId) await ctx.scheduler.runAfter(0, internal.dealState.onCall, { callId });
    return { callId };
  },
});

export const importProviderTranscript = internalMutation({
  args: {
    orgId: v.id("organizations"),
    provider: providerValidator,
    externalCallId: v.optional(v.string()),
    title: v.string(),
    callDate: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),
    participants: v.optional(v.array(v.any())),
    transcriptText: v.string(),
    sourceMetadata: v.optional(v.any()),
    /**
     * Granola: the window generation the poll began under. The import is refused in this same transaction
     * when Granola was disconnected, is switching folders, or started over since, so a poll that was mid-note
     * can never write after a purge (convex/granola.ts).
     */
    granolaWindow: v.optional(v.number()),
    /** The side and times of each line of `transcriptText`, in order, when the provider sent them. */
    segments: v.optional(v.array(segmentTimingValidator)),
  },
  handler: async (ctx, args) => {
    if (!args.title.trim()) throw new ConvexError("Call title is required");
    if (!args.transcriptText.trim()) throw new ConvexError("Transcript text is required");
    if (args.granolaWindow !== undefined) await assertGranolaWindow(ctx, args.orgId, args.granolaWindow);

    const now = Date.now();
    const existing = args.externalCallId
      ? await ctx.db
          .query("callRecordings")
          .withIndex("by_orgId_externalCallId", (q) =>
            q.eq("orgId", args.orgId).eq("externalCallId", args.externalCallId),
          )
          .first()
      : null;

    const callPatch = {
      provider: args.provider,
      externalCallId: args.externalCallId,
      title: args.title.trim(),
      callDate: args.callDate,
      durationSeconds: args.durationSeconds,
      recordingUrl: args.recordingUrl,
      participants: args.participants,
      transcriptText: args.transcriptText,
      transcriptStatus: "uploaded" as const,
      insightStatus: "pending" as const,
      // A re-import keeps what was written after the first one (Granola's meeting activity id, its matches).
      sourceMetadata: isPlainObject(existing?.sourceMetadata) && isPlainObject(args.sourceMetadata)
        ? { ...existing.sourceMetadata, ...args.sourceMetadata }
        : args.sourceMetadata,
      updatedAt: now,
    };

    const callId = existing
      ? existing._id
      : await ctx.db.insert("callRecordings", {
          orgId: args.orgId,
          ...callPatch,
          createdAt: now,
        });

    if (existing) await ctx.db.patch(existing._id, callPatch);
    await parseAndStoreSegments(ctx, args.orgId, callId, args.transcriptText, now, args.segments);
    await ctx.db.patch(callId, { transcriptStatus: "parsed", parsedAt: now, updatedAt: now });
    if (existing?.dealId) await ctx.scheduler.runAfter(0, internal.dealState.onCall, { callId });
    return { callId, created: !existing };
  },
});

/**
 * A Granola call imported before Canon kept segment times: its stored segments get the sides and times of the
 * note as Granola sends it now, patched in place so the call's insights keep pointing at their segments. Only
 * when the transcript is unchanged and every line lines up; either way the call is marked, so it is read once.
 */
export const keepTimings = internalMutation({
  args: {
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    granolaWindow: v.number(),
    transcriptText: v.union(v.string(), v.null()),
    segments: v.array(segmentTimingValidator),
  },
  handler: async (ctx, args): Promise<{ kept: boolean }> => {
    await assertGranolaWindow(ctx, args.orgId, args.granolaWindow);
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId || call.provider !== "granola") return { kept: false };
    const meta = isPlainObject(call.sourceMetadata) ? call.sourceMetadata : {};
    await ctx.db.patch(call._id, { sourceMetadata: { ...meta, timings: TIMINGS_VERSION } });
    if (args.transcriptText === null || args.transcriptText !== call.transcriptText) return { kept: false };
    const stored = await ctx.db
      .query("callTranscriptSegments")
      .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", call._id))
      .take(args.segments.length + 1);
    if (stored.length !== args.segments.length) return { kept: false };
    for (const [i, segment] of stored.entries()) await ctx.db.patch(segment._id, timingFields(args.segments[i]!));
    return { kept: true };
  },
});

export const analyzeCall = mutation({
  args: { callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "call intelligence over the CRM");
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== user.orgId) throw new ConvexError("Call not found");
    if (!call.transcriptText) throw new ConvexError("Call has no transcript");

    const now = Date.now();
    let segments = await ctx.db
      .query("callTranscriptSegments")
      .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", args.callId))
      .collect();
    if (segments.length === 0) {
      await parseAndStoreSegments(ctx, user.orgId, args.callId, call.transcriptText, now);
      segments = await ctx.db
        .query("callTranscriptSegments")
        .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", args.callId))
        .collect();
    }

    const existing = await ctx.db
      .query("callInsights")
      .withIndex("by_callId", (q) => q.eq("callId", args.callId))
      .collect();
    for (const insight of existing) await ctx.db.delete(insight._id);

    const segmentByIndex = new Map(segments.map((segment) => [segment.segmentIndex, segment._id]));
    const extracted = extractCallInsights(call.transcriptText, segments.map((segment) => ({
      index: segment.segmentIndex,
      speaker: segment.speaker,
      speakerRole: segment.speakerRole,
      text: segment.text,
      startChar: segment.startChar ?? 0,
      endChar: segment.endChar ?? 0,
    })), (await modelSettings(ctx, call.orgId, "calls.model")).phrases);

    for (const insight of extracted) {
      await ctx.db.insert("callInsights", {
        orgId: user.orgId,
        callId: args.callId,
        segmentId:
          insight.segmentIndex !== undefined
            ? segmentByIndex.get(insight.segmentIndex)
            : undefined,
        type: insight.type,
        title: insight.title,
        text: insight.text,
        evidence: insight.evidence,
        speaker: insight.speaker,
        confidence: insight.confidence,
        importance: insight.importance,
        startChar: insight.startChar,
        endChar: insight.endChar,
        crmImpact: crmImpactForInsight(insight.type),
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
    }

    // Heuristic insights are usable NOW; "refining" signals that the chunked
    // LLM pass is scheduled and will replace them. The action always resolves
    // the status back to "analyzed" (replaceInsightsLlm on success,
    // finishInsightRefinement on every skip/failure path) — never permanent.
    await ctx.db.patch(args.callId, {
      transcriptStatus: "analyzed",
      insightStatus: "refining",
      analyzedAt: now,
      updatedAt: now,
    });

    // Chunked LLM refinement replaces these heuristics async (no-op when no
    // server LLM key is configured).
    await ctx.scheduler.runAfter(0, internal.callInsightActions.analyzeCallLlm, {
      orgId: user.orgId,
      callId: args.callId,
      userId: user._id,
    });

    return {
      callId: args.callId,
      segments: segments.length,
      insights: extracted.length,
      summary: summarizeInsights(extracted),
    };
  },
});

/**
 * Resolve a lingering "refining" back to "analyzed" — called by the LLM
 * refinement action on every skip/failure path so a call can never be left
 * permanently "refining" (the heuristic insights it already has stand).
 * Read budget: 1 read + ≤1 write.
 */
export const finishInsightRefinement = internalMutation({
  args: { orgId: v.id("organizations"), callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) return null;
    if (call.insightStatus === "refining") {
      await ctx.db.patch(args.callId, { insightStatus: "analyzed", updatedAt: Date.now() });
    }
    return null;
  },
});

/** The LLM refinement pass reads the call through this (action ctx). */
export const getCallForLlm = internalQuery({
  args: { orgId: v.id("organizations"), callId: v.id("callRecordings") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) return null;
    return { title: call.title, transcriptText: call.transcriptText ?? null };
  },
});

/**
 * Replace a call's insights with the LLM pipeline's output (scheduled after
 * the instant deterministic pass). Same row shape as the heuristic writer,
 * plus the extraction model recorded for provenance.
 */
export const replaceInsightsLlm = internalMutation({
  args: {
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    model: v.string(),
    insights: v.array(
      v.object({
        type: v.string(),
        title: v.string(),
        text: v.string(),
        evidence: v.string(),
        speaker: v.optional(v.string()),
        confidence: v.number(),
        importance: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) throw new ConvexError("Call not found");
    const now = Date.now();

    const existing = await ctx.db
      .query("callInsights")
      .withIndex("by_callId", (q) => q.eq("callId", args.callId))
      .collect();
    for (const insight of existing) await ctx.db.delete(insight._id);

    for (const insight of args.insights) {
      await ctx.db.insert("callInsights", {
        orgId: args.orgId,
        callId: args.callId,
        type: insight.type as any,
        title: insight.title,
        text: insight.text,
        evidence: insight.evidence,
        speaker: insight.speaker,
        confidence: insight.confidence,
        importance: insight.importance,
        crmImpact: crmImpactForInsight(insight.type as any),
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.patch(args.callId, {
      insightStatus: "analyzed",
      analyzedAt: now,
      analysisModel: args.model,
      updatedAt: now,
    });
    return { insights: args.insights.length };
  },
});

export const analyzeImportedCall = internalMutation({
  args: {
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    // Whose ChatGPT plan runs the LLM pass; without one only the heuristic insights stand.
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.orgId !== args.orgId) throw new ConvexError("Call not found");
    if (!call.transcriptText) throw new ConvexError("Call has no transcript");

    const now = Date.now();
    let segments = await ctx.db
      .query("callTranscriptSegments")
      .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", args.callId))
      .collect();
    if (segments.length === 0) {
      await parseAndStoreSegments(ctx, args.orgId, args.callId, call.transcriptText, now);
      segments = await ctx.db
        .query("callTranscriptSegments")
        .withIndex("by_callId_segmentIndex", (q) => q.eq("callId", args.callId))
        .collect();
    }

    const existing = await ctx.db
      .query("callInsights")
      .withIndex("by_callId", (q) => q.eq("callId", args.callId))
      .collect();
    for (const insight of existing) await ctx.db.delete(insight._id);

    const segmentByIndex = new Map(segments.map((segment) => [segment.segmentIndex, segment._id]));
    const extracted = extractCallInsights(call.transcriptText, segments.map((segment) => ({
      index: segment.segmentIndex,
      speaker: segment.speaker,
      speakerRole: segment.speakerRole,
      text: segment.text,
      startChar: segment.startChar ?? 0,
      endChar: segment.endChar ?? 0,
    })), (await modelSettings(ctx, call.orgId, "calls.model")).phrases);

    for (const insight of extracted) {
      await ctx.db.insert("callInsights", {
        orgId: args.orgId,
        callId: args.callId,
        segmentId:
          insight.segmentIndex !== undefined
            ? segmentByIndex.get(insight.segmentIndex)
            : undefined,
        type: insight.type,
        title: insight.title,
        text: insight.text,
        evidence: insight.evidence,
        speaker: insight.speaker,
        confidence: insight.confidence,
        importance: insight.importance,
        startChar: insight.startChar,
        endChar: insight.endChar,
        crmImpact: crmImpactForInsight(insight.type),
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
    }

    // Heuristic insights are usable NOW; "refining" signals that the chunked
    // LLM pass is scheduled and will replace them. The action always resolves
    // the status back to "analyzed" — never permanent.
    await ctx.db.patch(args.callId, {
      transcriptStatus: "analyzed",
      insightStatus: "refining",
      analyzedAt: now,
      updatedAt: now,
    });

    // Instant heuristics above; the chunked LLM pipeline refines async and
    // replaces these insights when a server LLM key is configured (no-op
    // otherwise). Best-effort by design.
    await ctx.scheduler.runAfter(0, internal.callInsightActions.analyzeCallLlm, {
      orgId: args.orgId,
      callId: args.callId,
      ...(args.userId ? { userId: args.userId } : {}),
    });

    return { callId: args.callId, segments: segments.length, insights: extracted.length };
  },
});

export const ingestAndAnalyzeDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "call intelligence over the CRM");
    const now = Date.now();
    const existing = await ctx.db
      .query("callRecordings")
      .withIndex("by_orgId_externalCallId", (q) =>
        q.eq("orgId", user.orgId).eq("externalCallId", "demo-call-operating-system"),
      )
      .first();
    if (existing) return { callId: existing._id, created: false };

    const callId = await ctx.db.insert("callRecordings", {
      orgId: user.orgId,
      provider: "manual",
      externalCallId: "demo-call-operating-system",
      title: "Demo discovery call — CRM operating model",
      callDate: new Date(now).toISOString(),
      durationSeconds: 2140,
      ownerId: user._id,
      participants: [
        { name: user.name, role: "rep" },
        { name: "Morgan Lee", role: "customer", email: "morgan@example.com" },
      ],
      transcriptText: demoTranscript,
      transcriptStatus: "uploaded",
      insightStatus: "pending",
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    await parseAndStoreSegments(ctx, user.orgId, callId, demoTranscript, now);
    await ctx.db.patch(callId, { transcriptStatus: "parsed", parsedAt: now, updatedAt: now });
    return { callId, created: true };
  },
});

async function parseAndStoreSegments(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  callId: Id<"callRecordings">,
  transcript: string,
  now: number,
  timings?: readonly SegmentTiming[],
) {
  const existing = await ctx.db
    .query("callTranscriptSegments")
    .withIndex("by_callId", (q) => q.eq("callId", callId))
    .collect();
  for (const segment of existing) await ctx.db.delete(segment._id);

  const segments = parseTranscript(transcript);
  // The provider's sides and times replace the guess from names, but only when its lines are the parsed segments.
  const timed = timings?.length === segments.length ? timings : undefined;
  for (const segment of segments) {
    await ctx.db.insert("callTranscriptSegments", {
      orgId,
      callId,
      segmentIndex: segment.index,
      speaker: segment.speaker,
      speakerRole: segment.speakerRole,
      text: segment.text,
      startChar: segment.startChar,
      endChar: segment.endChar,
      ...(timed ? timingFields(timed[segment.index]!) : {}),
      createdAt: now,
    });
  }
}

/** The call's integration still polls the window this write began under: else a purge may have run since. */
async function assertGranolaWindow(ctx: MutationCtx, orgId: Id<"organizations">, granolaWindow: number) {
  const granola = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "granola")).first();
  const config = (granola?.syncConfig ?? {}) as Record<string, unknown>;
  const window = typeof config.granolaWindow === "number" ? config.granolaWindow : 0;
  if (!granola?.isActive || config.granolaRescoping === true || window !== granolaWindow) {
    throw new ConvexError({ kind: GRANOLA_STALE_POLL });
  }
}

/** The segment fields a provider's timing sets: an absent time stays absent. */
function timingFields(t: SegmentTiming) {
  return {
    speakerRole: t.side,
    ...(t.startSeconds !== null ? { startSeconds: t.startSeconds } : {}),
    ...(t.endSeconds !== null ? { endSeconds: t.endSeconds } : {}),
  };
}

const isPlainObject = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x);

async function assertDealInOrg(ctx: MutationCtx, dealId: Id<"deals">, orgId: Id<"organizations">) {
  const deal = await ctx.db.get(dealId);
  if (!deal || deal.orgId !== orgId) throw new ConvexError("Deal not found");
}

async function assertAccountInOrg(ctx: MutationCtx, accountId: Id<"crmAccounts">, orgId: Id<"organizations">) {
  const account = await ctx.db.get(accountId);
  if (!account || account.orgId !== orgId) throw new ConvexError("Account not found");
}

function crmImpactForInsight(type: CallInsightType) {
  const impact: Record<CallInsightType, Record<string, string>> = {
    pain_point: { suggestedCrmField: "Pain_Points__c", forecastImpact: "qualification" },
    objection: { suggestedCrmField: "Objections__c", forecastImpact: "risk" },
    competitor_mention: { suggestedCrmField: "Competitors__c", forecastImpact: "competitive" },
    next_step: { suggestedCrmField: "NextStep", forecastImpact: "activity" },
    feature_request: { suggestedCrmField: "Product_Feedback__c", forecastImpact: "product" },
    pricing: { suggestedCrmField: "Pricing_Discussion__c", forecastImpact: "commercial" },
    decision_criteria: { suggestedCrmField: "Decision_Criteria__c", forecastImpact: "qualification" },
    risk: { suggestedCrmField: "Deal_Risk__c", forecastImpact: "risk" },
    coaching_moment: { suggestedCrmField: "Coaching_Notes__c", forecastImpact: "team" },
  };
  return impact[type];
}

function emptySummary() {
  return {
    totalCalls: 0,
    callsWithTranscripts: 0,
    analyzedCalls: 0,
    pendingCalls: 0,
    totalInsights: 0,
    highImportanceInsights: 0,
    openInsights: 0,
    byType: {},
    topTypes: [],
  };
}

function summarizeCallRows(calls: Array<Doc<"callRecordings">>, insights: Array<Doc<"callInsights">>) {
  const byType: Record<string, number> = {};
  for (const insight of insights) byType[insight.type] = (byType[insight.type] ?? 0) + 1;
  return {
    totalCalls: calls.length,
    callsWithTranscripts: calls.filter((call) => Boolean(call.transcriptText)).length,
    analyzedCalls: calls.filter((call) => call.insightStatus === "analyzed").length,
    pendingCalls: calls.filter((call) => call.insightStatus === "pending").length,
    totalInsights: insights.length,
    highImportanceInsights: insights.filter((insight) => insight.importance >= 4).length,
    openInsights: insights.filter((insight) => insight.status === "open").length,
    byType,
    topTypes: Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count })),
  };
}

const demoTranscript = `Rep: Thanks for joining. What is making CRM operations difficult right now?
Customer: We are struggling with manual Salesforce updates. It takes too long after every call, and our forecast is messy because the next steps are not captured.
Rep: That makes sense. What would success look like?
Customer: We need to see pain points, objections, and decision criteria automatically after calls. The must have is pushing the right summary back to Salesforce without creating more work.
Rep: Are you evaluating alternatives?
Customer: We looked at Gong and Clari, but they do not really solve our full GTM operating model problem. Pricing is also a concern because we have no budget for another point solution.
Rep: The next step is that I'll send a sample call-insights report and we can schedule a technical review next Tuesday.
Customer: Great. The risk is timing — procurement may push this into next quarter if security review takes too long.`;
