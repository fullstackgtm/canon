"use node";
/**
 * Derive an ICP from a company's website (the signup research's model call) and save it, inactive unless it
 * is the first. It runs on the caller's connected ChatGPT plan; without one, on the deployment's OpenRouter key.
 */
import { forcedToolCall } from "../engine/src/llm.ts";
import { WEBSITE_ICP_DERIVE_SCHEMA } from "../engine/src/portable/icpDeriveContract.ts";
import { DEFAULT_ICP_DERIVATION_MODEL, OPENROUTER_API_BASE } from "../engine/src/icpDerive.ts";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { deriveWebsiteIcp } from "../engine/src/icpDerive.ts";
import { memoFetcher } from "./researchSessionActions";
import { icpFailureMessage, normalizeDomain } from "./lib/researchPipeline";
import { specFromIcp } from "./lib/icps";
import { resolveLlm } from "./lib/llmResolver";

export const deriveFromWebsite = action({
  args: { domain: v.string() },
  handler: async (ctx, args): Promise<{ icpId: Id<"icps"> }> => {
    const { orgId, userId } = await ctx.runQuery(internal.icps.editor, {});
    let domain: string;
    try {
      domain = normalizeDomain(args.domain);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid domain.");
    }
    await ctx.runMutation(internal.icps.reserveDerivation, { orgId });
    const llm = await resolveLlm(ctx, userId);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!llm && !apiKey) throw new ConvexError("Connect your ChatGPT plan in Integrations → ChatGPT to derive an ICP.");
    let derived;
    try {
      derived = await deriveWebsiteIcp({ domain, ...(llm ? { llm } : { apiKey }), fetchPages: memoFetcher(ctx, orgId, "icp_derive"),
        derive: async (prompt, model) => {
          let hit = false;
          try {
            const result = await forcedToolCall(prompt, "derive_website_icp", WEBSITE_ICP_DERIVE_SCHEMA, model || DEFAULT_ICP_DERIVATION_MODEL, llm ?? { provider: "openai", apiKey: apiKey!, openaiBaseUrl: OPENROUTER_API_BASE });
            hit = true;
            return result as Record<string, unknown>;
          } finally {
            if (!llm) await ctx.runMutation(internal.records.recordProviderCall, { orgId, provider: "openrouter", endpoint: "derive_website_icp", feature: "icp_derive", costMicro: 0, outcome: hit ? "hit" : "miss" });
          }
        } });
    } catch (error) {
      const message = icpFailureMessage(domain, error);
      await ctx.runMutation(internal.researchSessions.logFailure, {
        domain, stage: "deriving", message, detail: error instanceof Error ? error.message : String(error), orgId,
      });
      throw new ConvexError(message);
    }
    const name = `${derived.company.name || domain} (from website)`;
    const icpId: Id<"icps"> = await ctx.runMutation(internal.icps.insertDerived, { orgId, userId, name, domain, spec: specFromIcp(derived.icp) });
    return { icpId };
  },
});
