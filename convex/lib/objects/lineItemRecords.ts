import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { Access } from "../access";
import { dealVisible } from "../../permissions";
import { MAX_DEAL_LINES } from "./lineItems";

export async function parentDeal(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, streamId: Id<"canonEntities">) {
  const entity = await ctx.db.get(streamId);
  const id = entity?.orgId === orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = id ? await ctx.db.get(id) : null;
  if (!deal || deal.orgId !== orgId || deal.archivedAt !== undefined || !dealVisible(access, deal)) return null;
  return deal;
}

export async function currentLines(ctx: QueryCtx, orgId: Id<"organizations">, deal: Id<"canonEntities">) {
  const rows = await ctx.db.query("recordRows")
    .withIndex("by_orgId_object_parentStreamId_lifecycleStatus", (q) => q.eq("orgId", orgId).eq("object", "lineItem").eq("parentStreamId", deal).eq("lifecycle.status", "active"))
    .take(MAX_DEAL_LINES + 1);
  if (rows.length > MAX_DEAL_LINES) throw new ConvexError(`A deal supports at most ${MAX_DEAL_LINES} line items`);
  return rows.sort((a, b) => Number(a.values.position ?? 0) - Number(b.values.position ?? 0) || a.streamId.localeCompare(b.streamId));
}
