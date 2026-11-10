"use node";

/**
 * The model call of a module's hosted AI step (docs/modules.md, "Hosted AI steps"), in Node because the LLM client
 * is: the person's ChatGPT plan through resolveLlm, else Canon's model on the workspace's credits. The call's action
 * (convex/lib/modules/ai.ts) renders the prompt, gates the answer and writes it; this only asks.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { canonResearchLlm } from "./lib/canonModel";

/** How long one answer may take before the run fails. */
const ANSWER_MS = 120_000;

export const answer = internalAction({
  // `credits`: whether Canon's model may answer on the workspace's credits, without the person's plan: only a run a
  // person started themselves; a run Canon started (a system move) needs the doc owner's own plan.
  args: { orgId: v.id("organizations"), userId: v.id("users"), label: v.string(), prompt: v.string(), schema: v.any(), credits: v.boolean() },
  handler: async (ctx, a): Promise<{ raw: unknown; provider: "chatgpt" | "canon"; model: string }> => {
    const plan = await resolveLlm(ctx, a.userId);
    const llm = plan ?? (a.credits ? canonResearchLlm() : null);
    if (!llm) throw new ConvexError(`${a.label} runs on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT.`);
    // Canon's model is paid for in credits: a workspace that can't pay is told before the model runs.
    if (!plan) await ctx.runQuery(internal.researchAgents.checkResearchCredits, { orgId: a.orgId });
    const model = llm.model ?? DEFAULT_MODELS[llm.provider];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANSWER_MS);
    try {
      const raw = await forcedToolCall(a.prompt, "fill", a.schema, model, { ...llm, fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }) });
      return { raw, provider: plan ? "chatgpt" : "canon", model };
    } catch (e) {
      throw new ConvexError(controller.signal.aborted ? `${a.label}: the model took longer than ${ANSWER_MS / 1000} seconds. Run it again.` : `${a.label}: the model failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  },
});
