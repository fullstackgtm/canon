"use node";
/**
 * Derive an ICP from a company's website (the signup research's model call) and save it, inactive unless it
 * is the first. It runs on the caller's connected ChatGPT plan; without one, on the deployment's OpenRouter key.
 */
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
    const llm = await resolveLlm(ctx, userId);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!llm && !apiKey) throw new ConvexError("Connect your ChatGPT plan in Integrations → ChatGPT to derive an ICP.");
    let derived;
    try {
      derived = await deriveWebsiteIcp({ domain, ...(llm ? { llm } : { apiKey }), fetchPages: memoFetcher(ctx, orgId, "icp_derive") });
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
