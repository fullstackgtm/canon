"use node";

/**
 * Ask Canon on the Automations page (lib/automationAgent.ts): a person's request in words, written as a rule by a model
 * on their own ChatGPT plan, never a Canon key, and refused without one. Canon's `check` reads each answer, and a rule
 * that passes is stored as a proposal from "ask-canon" with its replay, waiting for an admin to approve it on the page.
 * A local stack answers with a stand-in (lib/automationAgentStandIn.ts), so a local check never spends a real plan.
 */
import { ConvexError, v } from "convex/values";
import type { FunctionArgs } from "convex/server";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { turnMeter } from "./lib/agents/webhook";
import { resolveLlm } from "./lib/llmResolver";
import { recipeAgentStandIn } from "./lib/recipeAgentStandIn";
import { routineRequest } from "../engine/src/routineTraces.ts";
import { ASK_BUDGET, NO_PLAN, ROUTINE_IMPORT_AGENT, REQUEST_MAX, RULE_SCHEMA, RULE_TOOL, askForRule, type Checked, type RuleDocLike } from "./lib/automationAgent";
import { STAND_IN_MODEL, standInRule, vocabulary, workspaceText, type Ws } from "./lib/automationAgentStandIn";
import type { ActionCaller } from "./records";

/** What Ask Canon answers: the proposal it stored, or why Canon couldn't take what the model wrote. */
export type AskResult =
  | { ok: true; versionId: Id<"automationVersions">; sentence: string; summary: string; note: string | null; attempts: number; model: string }
  | { ok: false; problem: string; summary: string; attempts: number; model: string };

export const ask = action({
  args: { request: v.string(), ruleId: v.optional(v.id("automationRules")) },
  handler: async (ctx, args): Promise<AskResult> => askAndPropose(ctx, args),
});

/**
 * A routine found in the person's own agent traces (engine/src/routineTraces.ts, `routines scan` or their agent over
 * /mcp) made into a proposal the same way Ask Canon makes one: on their ChatGPT plan, checked, waiting for an admin.
 */
export const importRoutine = action({
  args: {
    title: v.string(),
    occurrences: v.number(),
    cadence: v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly"), v.literal("irregular")),
    tools: v.array(v.string()),
    samplePrompts: v.array(v.string()),
    source: v.string(),
    goal: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AskResult> => {
    if (args.tools.length > 40 || args.samplePrompts.length > 10) throw new ConvexError("A routine lists at most 40 tools and 10 prompts.");
    const request = routineRequest({ ...args, occurrences: Math.max(1, Math.floor(args.occurrences)) });
    return askAndPropose(ctx, { request, agent: ROUTINE_IMPORT_AGENT, noteHead: `Imported from ${args.source.slice(0, 60)} (seen ${Math.floor(args.occurrences)}x, ${args.cadence}).` });
  },
});

async function askAndPropose(ctx: ActionCtx, args: { request: string; ruleId?: Id<"automationRules">; agent?: typeof ROUTINE_IMPORT_AGENT; noteHead?: string }): Promise<AskResult> {
  const ws: Ws | null = await ctx.runQuery(api.automations.workspace, {});
  const user: ActionCaller | null = await ctx.runQuery(internal.records.callerContext, {});
  if (!ws || !user) throw new ConvexError("Only admins manage automation rules");
  const request = args.request.trim();
  if (!request) throw new ConvexError("Say what the rule should do.");
  if (request.length > REQUEST_MAX) throw new ConvexError(`A request is at most ${REQUEST_MAX} characters.`);
  const current: { name: string; object: string; trigger: unknown; conditions: unknown[]; actions: unknown[] } | null = args.ruleId ? await ctx.runQuery(api.automations.get, { id: args.ruleId }) : null;
  const standIn = recipeAgentStandIn();
  const llm = standIn ? null : await resolveLlm(ctx, user.userId as Id<"users">);
  if (!standIn && !llm) throw new ConvexError(NO_PLAN);
  const model = llm ? `${llm.provider}:${llm.model ?? DEFAULT_MODELS[llm.provider]}` : STAND_IN_MODEL;
  const meter = turnMeter(ASK_BUDGET, Date.now());
  const asked = await askForRule({ vocabulary: vocabulary(), workspace: workspaceText(ws), request, ...(current ? { current: JSON.stringify({ name: current.name, object: current.object, trigger: current.trigger, conditions: current.conditions, actions: current.actions }) } : {}) }, {
    call: async (prompt) => (llm ? forcedToolCall(prompt, RULE_TOOL, RULE_SCHEMA, llm.model ?? DEFAULT_MODELS[llm.provider], llm) : standInRule(ws, request)),
    check: async (doc: RuleDocLike): Promise<Checked> => {
      const out: Checked | null = await ctx.runQuery(api.automations.check, { ...(args.ruleId ? { ruleId: args.ruleId } : {}), ...doc } as FunctionArgs<typeof api.automations.check>).catch((cause: unknown) => ({ ok: false as const, problem: cause instanceof Error ? cause.message : "The rule doesn't fit the rule shape" }));
      return out ?? { ok: false, problem: "Only admins manage automation rules" };
    },
    charge: (prompt) => meter.charge(prompt),
  });
  if (!asked.ok) return { ok: false as const, problem: asked.problem, summary: asked.summary, attempts: asked.attempts, model };
  const stored: { versionId: Id<"automationVersions">; sentence: string } = await ctx.runMutation(internal.automations.proposeAsked, {
    ...(args.ruleId ? { ruleId: args.ruleId } : {}), doc: asked.doc as never, note: `${args.noteHead ? `${args.noteHead} ` : ""}${asked.summary ? `${asked.summary} ` : ""}(Asked: "${request.slice(0, 300)}")`, ...(args.agent ? { agent: args.agent } : {}),
  });
  return { ok: true as const, versionId: stored.versionId, sentence: stored.sentence, summary: asked.summary, note: asked.note ?? null, attempts: asked.attempts, model };
}

