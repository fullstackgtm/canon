import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** Resolve only a live module deal projection to its unmerged opportunity stream. */
export async function moduleDealTarget(ctx: QueryCtx, orgId: Id<"organizations">, raw: string) {
  const id = ctx.db.normalizeId("deals", raw);
  const deal = id ? await ctx.db.get(id) : null;
  if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined) return null;
  const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", raw)).unique();
  return entity?.projectionTable === "deals" && entity.entityType === "opportunity" && !entity.mergedInto ? { deal, entity } : null;
}
