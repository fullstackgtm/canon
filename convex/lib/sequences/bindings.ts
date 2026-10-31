import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { canonicalJson } from "../../../modules/kernel/integrity.ts";

export type Sq1Projection = Doc<"sequenceLaunches">["projection"];
type Address = { orgId: Id<"organizations">; moduleId: string; collection: string; key: string };
type Db = Pick<QueryCtx, "db">;
export const SQ1_MAX_LAUNCHES = 100;

export async function sq1Launches(ctx: Db, orgId: Id<"organizations">, moduleId: string) {
  const rows = await ctx.db.query("sequenceLaunches").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).take(SQ1_MAX_LAUNCHES + 1);
  if (rows.length > SQ1_MAX_LAUNCHES) throw new ConvexError("This module has too many canonical launches to change safely.");
  return rows;
}

export async function sq1ProjectionBindings(ctx: Db, at: Address): Promise<Sq1Projection[]> {
  const launches = await sq1Launches(ctx, at.orgId, at.moduleId);
  const same = (p: Sq1Projection) => p.collection === at.collection && p.key === at.key;
  const bindings = launches.flatMap((l) => [l.projection, ...l.sources]).filter(same);
  const enrollment = await ctx.db.query("sequenceEnrollments").withIndex("by_orgId_and_moduleId_and_moduleEnrollmentKey", (q) => q.eq("orgId", at.orgId).eq("moduleId", at.moduleId).eq("moduleEnrollmentKey", at.key)).unique();
  if (enrollment && same(enrollment.projection)) bindings.push(enrollment.projection);
  const requests = await ctx.db.query("outboxRequests").withIndex("by_orgId_moduleId_projection_collection_projection_key", (q) => q.eq("orgId", at.orgId).eq("moduleId", at.moduleId).eq("projection.collection", at.collection).eq("projection.key", at.key)).take(2);
  if (requests.length > 1) throw new ConvexError("A request projection has conflicting canonical identities.");
  if (requests[0]?.projection) bindings.push(requests[0].projection);
  return bindings;
}

export async function assertSq1ProjectionChange(ctx: Db, at: Address, after: { data: Record<string, unknown>; parentKey?: string; gen?: number; gens?: Record<string, number>; ownerUserId?: Id<"users"> } | null): Promise<void> {
  if (after?.parentKey) {
    const launches = await sq1Launches(ctx, at.orgId, at.moduleId);
    if (launches.some((l) => l.projection.key === after.parentKey && l.sources.some((p) => p.collection === at.collection) && !l.sources.some((p) => p.collection === at.collection && p.key === at.key))) {
      throw new ConvexError("A bound sequence's step set changes only through its trusted lifecycle.");
    }
  }
  for (const binding of await sq1ProjectionBindings(ctx, at)) {
    if (!after || Object.entries(binding.fields).some(([k, v]) => canonicalJson(after.data[k]) !== canonicalJson(v))
      || binding.absent.some((k) => Object.hasOwn(after.data, k)) || (after.ownerUserId ?? null) !== (binding.ownerUserId ?? null)
      || (after.parentKey ?? null) !== (binding.parentKey ?? null) || (after.gen ?? 0) !== (binding.gen ?? 0)
      || canonicalJson(after.gens ?? {}) !== canonicalJson(binding.gens ?? {})) {
      throw new ConvexError("This record is controlled by its canonical sequence lifecycle. Use that lifecycle to change its identity, plan or state.");
    }
  }
}

export async function assertSq1Copy(ctx: Db, at: Address): Promise<void> {
  if ((await sq1ProjectionBindings(ctx, at)).length) throw new ConvexError("A canonical sequence record cannot be copied into a new lifecycle identity.");
}

export async function assertSq1PackageUpgrade(ctx: Db, orgId: Id<"organizations">, moduleId: string): Promise<void> {
  if ((await sq1Launches(ctx, orgId, moduleId)).length) throw new ConvexError("This module has canonical sequence bindings. Its upgrade must preserve those bindings through a trusted lifecycle migration.");
}
