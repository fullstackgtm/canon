/** Initialization of the existing whole-doc projection; source documents remain authoritative. */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { ConvexError } from "convex/values";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { projectedCollections } from "../../../modules/kernel/reports.ts";
import type { ModuleProjection } from "../objects/moduleReport";
import { markDirty, REPORT_JOB } from "./jobs";
export { sameProjection } from "../objects/moduleReport";

export function projectionOf(pkg: Doc<"modulePackages">, m: ModuleManifest): ModuleProjection | null {
  const p = pkg.projection;
  const collections = [...projectedCollections(m)].sort();
  return p && p.epoch === (pkg.epoch ?? 1) && JSON.stringify(p.collections) === JSON.stringify(collections)
    ? { packageId: pkg._id, epoch: p.epoch, generation: p.generation, collections } : null;
}

/** Rebuild once for old installations, and again on enable/serving-version changes. No missing-state readiness. */
export async function initializeProjection(ctx: MutationCtx, pkg: Doc<"modulePackages">, m: ModuleManifest, force = false) {
  const current = projectionOf(pkg, m);
  if (current && !force) return current;
  const p = { epoch: pkg.epoch ?? 1, generation: (pkg.projection?.generation ?? 0) + 1, collections: [...projectedCollections(m)].sort(), completed: [] as string[] };
  if (p.collections.length > 100 || !Number.isSafeInteger(p.generation)) throw new ConvexError("This module exceeds the report projection protocol's supported bounds.");
  await ctx.db.patch(pkg._id, { projection: p });
  for (const collection of p.collections) await markDirty(ctx, pkg.orgId, pkg.moduleId, m, REPORT_JOB, `${collection}|*`, {});
  return { packageId: pkg._id, epoch: p.epoch, generation: p.generation, collections: p.collections };
}
