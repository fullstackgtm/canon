"use node";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { qualificationFor, playsFor, termsFor } from "./lib/recipes";
import { buildPlane, type PlaneCaller } from "./dealPlays";
import { requireCaller } from "./records";
import { isRestricted, may } from "./lib/access";
import { dealTermValidator, selectStateSources, sourceKey, stateInputHash, stateOutputSchema, statePrompt, verifiedState, type StateSource } from "./lib/plays/state";

export async function startState(ctx: ActionCtx, caller: PlaneCaller, streamId: string, force = false): Promise<{ started: boolean; connected: boolean }> {
  const orgId = caller.orgId as Id<"organizations">;
  const userId = caller.userId as Id<"users">;
  const plane = await buildPlane(ctx, caller, streamId);
  if (!plane || !plane.canEdit || !may(caller.access, "deal", "edit")) throw new ConvexError("Only deal editors can regenerate its state");
  if (isRestricted(caller.access)) throw new ConvexError("Your role sees only part of this deal, so it can't generate its state");
  const llm = await resolveLlm(ctx, userId);
  if (!llm) return { started: false, connected: false };
  const inputs = await ctx.runQuery(internal.dealState.inputs, { orgId, userId, streamId, contactIds: plane.people.map((p) => p.contactId), companyDomain: plane.deal.domain });
  const context: StateSource[] = [
    { kind: "deal", id: streamId, text: JSON.stringify(plane.deal), at: 0, buyerTexts: [], activity: false },
    { kind: "play", id: streamId, text: JSON.stringify({ brief: plane.brief, items: plane.items.filter((i) => i.evidence === "verified"), people: plane.people.map(({ contactId, name, role, persona, angle }) => ({ contactId, name, role, persona, angle })) }), at: 0, buyerTexts: [], activity: false },
  ];
  const selected = selectStateSources([...context, ...inputs.sources], 60_000, inputs.inventoryLimited);
  const framework = qualificationFor(playsFor(plane.recipe));
  const terms = [...termsFor(playsFor(plane.recipe))];
  const inputHash = stateInputHash({ framework, terms, sources: selected.sources, coverage: selected.coverage, inventory: inputs.inventory });
  const startedAt = await ctx.runMutation(internal.dealState.claim, { orgId, userId, streamId, inputHash, force });
  if (startedAt === null) return { started: false, connected: true };
  // Keep the claim and scheduling short. Model work happens in its own action.
  await ctx.scheduler.runAfter(0, internal.dealStateActions.run, { orgId, userId, streamId, startedAt, inputHash, terms, framework: { ...framework, lines: [...framework.lines] }, sources: selected.sources, coverage: selected.coverage, crmStage: plane.deal.stage });
  return { started: true, connected: true };
}

export const regenerate = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<{ started: boolean; connected: boolean }> => {
    const caller = await requireCaller(ctx);
    return startState(ctx, caller, args.streamId, true);
  },
});

export const generate = internalAction({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const caller = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId: args.orgId, userId: args.userId });
    if (caller) await startState(ctx, caller, args.streamId);
    return null;
  },
});

const stateSource = v.object({
  kind: v.union(v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("fact"), v.literal("deal"), v.literal("play")),
  id: v.string(), text: v.string(), at: v.number(), activity: v.boolean(), buyerTexts: v.array(v.string()), partial: v.optional(v.boolean()), ownerUserId: v.optional(v.string()),
});
export const run = internalAction({
  args: {
    orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), startedAt: v.number(), inputHash: v.string(),
    framework: v.object({ name: v.string(), lines: v.array(v.object({ key: v.string(), group: v.string(), label: v.string() })) }),
    terms: v.optional(v.array(dealTermValidator)),
    sources: v.array(stateSource), coverage: v.object({ read: v.number(), total: v.number(), omitted: v.number(), partial: v.boolean(), inventoryLimited: v.boolean() }), crmStage: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { orgId, userId, streamId, startedAt, inputHash } = args;
    try {
      const caller = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId, userId });
      const plane = caller ? await buildPlane(ctx, caller, streamId) : null;
      if (!plane?.canEdit || !caller || !may(caller.access, "deal", "edit")) throw new ConvexError("Deal access changed");
      const llm = await resolveLlm(ctx, userId);
      if (!llm) throw new ConvexError("Connect ChatGPT under Integrations to regenerate deal state.");
      const raw = await forcedToolCall(statePrompt(args.framework, args.sources, args.coverage, plane.state?.concerns ?? [], args.terms ?? []), "record_deal_state", stateOutputSchema, llm.model ?? DEFAULT_MODELS[llm.provider], llm);
      const state = verifiedState(raw, args.framework, args.sources, args.coverage, args.crmStage, Date.now(), args.terms ?? []);
      await ctx.runMutation(internal.dealState.finish, { orgId, streamId, startedAt, inputHash, state, readKeys: args.sources.filter((s) => s.text).map(sourceKey) });
    } catch (cause) {
      await ctx.runMutation(internal.dealState.finish, { orgId, streamId, startedAt, inputHash, error: cause instanceof Error ? cause.message : String(cause) });
    }
    return null;
  },
});
