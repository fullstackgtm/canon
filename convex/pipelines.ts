import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap } from "./lib";
import { accessFor, visibleDeals } from "./permissions";
import { hiddenFields, isRestricted } from "./lib/access";
import { FORECAST_CATEGORIES, planPipelineSave, resolvePipelines, type Pipeline, type PipelineInput } from "./lib/pipelines";
import type { Provenance } from "../recipes/templates.ts";
import { resolveObjectDef, STANDARD_OBJECTS, type OrgObjectExtension } from "./lib/objects/registry";
import { fromStored, toStored } from "./lib/objects/validators";

/** Deals `totals` reads; past it the totals say they are partial. */
const TOTALS_CAP = 5000;
const forecastCategory = v.union(...FORECAST_CATEGORIES.map((c) => v.literal(c)));

async function readState(ctx: QueryCtx, orgId: Id<"organizations">) {
  const defRow = await ctx.db.query("objectDefs").withIndex("by_orgId_apiName", (q) => q.eq("orgId", orgId).eq("apiName", "deal")).unique();
  const ext = defRow ? fromStored<OrgObjectExtension>(defRow) : undefined;
  const field = resolveObjectDef(STANDARD_OBJECTS.deal, ext).byApiName.get("stage");
  const options = field && "options" in field ? field.options : [];
  const rows = await ctx.db.query("dealPipelines").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(100);
  const stored = rows.map((r) => ({ id: r._id as string, name: r.name, stages: r.stages, createdAt: r.createdAt }));
  return { defRow, ext, options, stored };
}

/** The org's deal pipelines, default first, with each stage's probability and forecast category. */
export async function orgPipelines(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Pipeline[]> {
  const { options, stored } = await readState(ctx, orgId);
  return resolvePipelines(options, stored);
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? orgPipelines(ctx, user.orgId) : null;
  },
});

/**
 * Deal count and amount (cents) per stage value; "" is deals with no stage. A
 * list, not an object: a CRM's stage names are not valid Convex object keys.
 */
export const totals = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    // Totals count only the deals the caller sees (CP14).
    const access = await accessFor(ctx, user);
    const deals = isRestricted(access)
      ? await visibleDeals(ctx, user.orgId, access, TOTALS_CAP + 1)
      : await ctx.db.query("deals").withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined)).take(TOTALS_CAP + 1);
    const byStage = new Map<string, { stage: string; count: number; amount: number }>();
    // A role that may not see deal amounts sees counts only (CP14).
    const amounts = !hiddenFields(access, "deal").includes("amount");
    for (const d of deals.slice(0, TOTALS_CAP)) {
      const stage = d.stage ?? "";
      const t = byStage.get(stage) ?? { stage, count: 0, amount: 0 };
      byStage.set(stage, { stage, count: t.count + 1, amount: t.amount + (amounts ? d.amount ?? 0 : 0) });
    }
    return { stages: [...byStage.values()], partial: deals.length > TOTALS_CAP };
  },
});

/** Create a pipeline (`pipelineId` null) or replace one, with its full ordered stage list. Admins and managers. */
export const save = mutation({
  args: {
    pipelineId: v.union(v.id("dealPipelines"), v.literal("default"), v.null()),
    name: v.string(),
    stages: v.array(v.object({ value: v.union(v.string(), v.null()), label: v.string(), probability: v.number(), forecastCategory })),
  },
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "pipelines.edit");
    const target = args.pipelineId === null ? { kind: "new" as const } : { kind: "existing" as const, id: args.pipelineId === "default" ? null : args.pipelineId };
    await savePipeline(ctx, user.orgId, { target, name: args.name, stages: args.stages });
    return null;
  },
});

/** Write a checked pipeline save and return the pipeline it saved, the plan's last write. A recipe's template installs through it. */
export async function savePipeline(ctx: MutationCtx, orgId: Id<"organizations">, input: PipelineInput, recipe?: Provenance): Promise<Id<"dealPipelines">> {
  const { defRow, ext, options, stored } = await readState(ctx, orgId);
  const plan = planPipelineSave(options, stored, input);
  if (!plan.ok) throw new ConvexError(plan.error);
  const picklistOptions = toStored({ ...ext?.picklistOptions, stage: plan.options });
  if (defRow) await ctx.db.patch(defRow._id, { picklistOptions, updatedAt: Date.now() });
  else await ctx.db.insert("objectDefs", { orgId, apiName: "deal", registryVersion: 0, customFields: [], picklistOptions, updatedAt: Date.now() });
  let createdAt = Date.now();
  let saved: Id<"dealPipelines"> | null = null;
  for (const [i, w] of plan.writes.entries()) {
    const mine = i === plan.writes.length - 1 && recipe ? { recipe } : {};
    if (w.kind === "insert") saved = await ctx.db.insert("dealPipelines", { orgId, name: w.name, stages: w.stages, createdAt: createdAt++, ...mine });
    else {
      const row = await ctx.db.get(w.id as Id<"dealPipelines">);
      if (!row || row.orgId !== orgId) throw new ConvexError("That pipeline no longer exists");
      await ctx.db.patch(row._id, { name: w.name, stages: w.stages });
      saved = row._id;
    }
  }
  return saved!;
}
