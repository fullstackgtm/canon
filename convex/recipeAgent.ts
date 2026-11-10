"use node";

/**
 * Editing a recipe with an agent (docs/recipes.md, "Editing with an agent"). `proposeEdit` takes a recipe.md and a
 * person's request, and returns the recipe.md a model wrote for it with the Canon layout skill, checked by Canon's
 * parser, its evals run, and its diff. It runs on the requesting person's own ChatGPT plan, never on a Canon key, and
 * refuses without one. It saves nothing: saving is the person's, in the recipe editor. The loop is lib/recipeAgent.ts.
 */
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { CANON_LAYOUT_SKILL } from "../recipes/skills/canon-layout/skill.generated.ts";
import { RECIPE_MAX_BYTES } from "../recipes/manifest.ts";
import { turnMeter } from "./lib/agents/webhook";
import { resolveLlm } from "./lib/llmResolver";
import { EDIT_SCHEMA, EDIT_TOOL, NO_PLAN, PROPOSAL_BUDGET, REQUEST_MAX, proposeRecipeEdit, type Proposal } from "./lib/recipeAgent";
import { STAND_IN_MODEL, recipeAgentStandIn, standInAnswer } from "./lib/recipeAgentStandIn";
import { runEvals } from "./lib/recipeRuntime";
import type { ActionCaller } from "./records";

export const proposeEdit = action({
  args: {
    recipeId: v.string(),
    baseMarkdown: v.string(),
    request: v.string(),
    object: v.optional(v.union(v.literal("deal"), v.literal("account"), v.literal("contact"))),
  },
  handler: async (ctx, args): Promise<Proposal & { model: string }> => {
    const caller: ActionCaller | null = await ctx.runQuery(internal.records.callerContext, {});
    if (!caller) throw new ConvexError("Not authenticated");
    const request = args.request.trim();
    if (!request) throw new ConvexError("Say what to change in the package.");
    if (request.length > REQUEST_MAX) throw new ConvexError(`A request is at most ${REQUEST_MAX} characters.`);
    if (new TextEncoder().encode(args.baseMarkdown).length > RECIPE_MAX_BYTES) throw new ConvexError(`A customization.md is at most ${RECIPE_MAX_BYTES / 1024} KB.`);
    // A local stack answers with a stand-in, so a local check never spends the dev user's real plan.
    const standIn = recipeAgentStandIn();
    // The requesting person's own plan pays; there is no server key to fall back to (docs/org-agents.md, "Who pays").
    const llm = standIn ? null : await resolveLlm(ctx, caller.userId as Id<"users">);
    if (!standIn && !llm) throw new ConvexError(NO_PLAN);
    const model = llm ? `${llm.provider}:${llm.model ?? DEFAULT_MODELS[llm.provider]}` : STAND_IN_MODEL;
    const meter = turnMeter(PROPOSAL_BUDGET, Date.now());
    const proposal = await proposeRecipeEdit({ ...args, request }, {
      skill: CANON_LAYOUT_SKILL,
      call: async (prompt) => (llm ? forcedToolCall(prompt, EDIT_TOOL, EDIT_SCHEMA, llm.model ?? DEFAULT_MODELS[llm.provider], llm) : standInAnswer(args.baseMarkdown, request)),
      charge: (prompt) => meter.charge(prompt),
      spent: () => meter.spent.tokens,
      runEvals,
    });
    console.log(`customization agent: ${args.recipeId} for ${caller.userId}: ${proposal.attempts} attempt(s), ~${proposal.tokens} tokens, ${proposal.problems.length} problem(s), ${proposal.evals.filter((e) => !e.ok).length}/${proposal.evals.length} evals failing`);
    return { ...proposal, model };
  },
});
