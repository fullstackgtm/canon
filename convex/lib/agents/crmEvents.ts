/**
 * CRM events for event agents (GT7b). Every deal write goes through
 * convex/canon.ts saveDealValues; it reads the deal's projected stage before
 * and after the write, and when the stage changed, this schedules
 * agentTurns.crmEvent for agents listening to `deal.stage_changed`. The event
 * is keyed by the stream version the write produced, so it fires once.
 */
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { fromStored } from "../objects/validators";
import { stageChange } from "./routing";
import { withEventDefinition } from "./definitions";

/** The deal's projected stage, from its hot row; null when the stream has none yet (a deal being created or converted). */
export async function projectedStage(ctx: MutationCtx, orgId: Id<"organizations">, streamId: string): Promise<{ stage: unknown } | null> {
  const row = await ctx.db.query("recordRows")
    .withIndex("by_orgId_streamId", (q) => q.eq("orgId", orgId).eq("streamId", streamId as Id<"canonEntities">))
    .unique();
  return row ? { stage: fromStored<Record<string, unknown>>(row.values).stage } : null;
}

/** Per transaction: whether an org has a live agent listening to deal stage changes (a sync writes many deals in one). */
const listening = new WeakMap<MutationCtx, Map<string, boolean>>();

async function hasListeners(ctx: MutationCtx, orgId: Id<"organizations">): Promise<boolean> {
  const seen = listening.get(ctx) ?? new Map<string, boolean>();
  listening.set(ctx, seen);
  const known = seen.get(orgId);
  if (known !== undefined) return known;
  const agents = await ctx.db.query("agents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId)).take(300);
  const definitions = await Promise.all(agents.map((agent) => withEventDefinition(ctx, agent)));
  const yes = definitions.some((a) => a.crmTrigger?.event === "deal.stage_changed" && a.fieldSlugs && a.archivedAt === undefined);
  seen.set(orgId, yes);
  return yes;
}

/** After an applied deal write: when its projected stage moved, wake the agents listening for it. */
export async function afterDealWrite(ctx: MutationCtx, deal: Doc<"deals">, streamId: string, before: { stage: unknown }, version: number) {
  const after = await projectedStage(ctx, deal.orgId, streamId);
  const change = after && stageChange(before.stage, after.stage);
  if (!change) return;
  await ctx.scheduler.runAfter(0, internal.dealState.onDeal, { dealId: deal._id });
  if (!(await hasListeners(ctx, deal.orgId))) return;
  await ctx.scheduler.runAfter(0, internal.agentTurns.crmEvent, {
    orgId: deal.orgId, dealId: deal._id, version, to: change.to, ...(change.from ? { from: change.from } : {}),
  });
}
