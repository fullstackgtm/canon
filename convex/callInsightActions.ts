"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
// Node-free module imports (never the package barrel) — established pattern.
import { extractInsightsChunked } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";

/**
 * The chunked-LLM insight pass (the TamTone langextract method, ported into
 * engine/src/llm.ts): scheduled after every deterministic
 * analyze, it re-extracts the call with per-chunk LLM calls + verbatim
 * grounding + quality gating and REPLACES the heuristic insights.
 *
 * Runs on the analyzing user's connected ChatGPT plan (`userId`) — see
 * lib/llmResolver. Without one this is a silent no-op — the heuristic
 * insights stand, nothing breaks, and the user opts into quality by
 * connecting ChatGPT. Best-effort: a failure leaves the heuristic insights in
 * place.
 */
export const analyzeCallLlm = internalAction({
  args: {
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    // Who started the analysis; their ChatGPT plan pays when connected.
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ insights: number; model?: string; skipped?: string }> => {
    // Scheduling sites set insightStatus "refining"; every path out of this
    // action must resolve it back to "analyzed" — replaceInsightsLlm does so
    // on success, and this best-effort mutation covers every skip/failure
    // (a call can never be left permanently "refining").
    const settleRefining = async () => {
      await ctx
        .runMutation(internal.callIntelligence.finishInsightRefinement, {
          orgId: args.orgId,
          callId: args.callId,
        })
        .catch(() => {});
    };

    try {
      const llm = await resolveLlm(ctx, args.userId);
      if (!llm) {
        await settleRefining();
        return { insights: 0, skipped: "no LLM available" };
      }
      const { provider } = llm;

      const call = await ctx.runQuery(internal.callIntelligence.getCallForLlm, {
        orgId: args.orgId,
        callId: args.callId,
      });
      if (!call?.transcriptText || !call.transcriptText.trim()) {
        await settleRefining();
        return { insights: 0, skipped: "call has no transcript" };
      }

      const result = await extractInsightsChunked(call.transcriptText, {
        ...llm,
        title: call.title ?? undefined,
      });

      // An empty result on a substantive transcript is more likely a bad run
      // than a truly insight-free call — keep the heuristic insights instead of
      // wiping them with nothing.
      if (result.insights.length === 0) {
        await settleRefining();
        return { insights: 0, skipped: "LLM pass produced no grounded insights; heuristics kept" };
      }

      await ctx.runMutation(internal.callIntelligence.replaceInsightsLlm, {
        orgId: args.orgId,
        callId: args.callId,
        model: `${provider}:${result.model}`,
        insights: result.insights.map((insight) => ({
          type: insight.type,
          title: insight.title,
          text: insight.text,
          evidence: insight.evidence,
          speaker: insight.speaker,
          confidence: insight.confidence,
          importance: insight.importance,
        })),
      });
      return { insights: result.insights.length, model: `${provider}:${result.model}` };
    } catch (error) {
      // Best-effort by design: the heuristic insights stand, the status
      // settles, and the failure is surfaced in logs only.
      await settleRefining();
      throw error;
    }
  },
});
