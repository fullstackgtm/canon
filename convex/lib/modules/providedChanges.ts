import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";
import { scheduleAudienceIcpGaps, scheduleWorkspaceGaps } from "../../icpFills";
import { interfaceOwner } from "./interfaceOwnership";
import { invalidateFit } from "../fitInvalidation";

type Data = Record<string, unknown> | null;
type Consumer = {
  module: string;
  provide: string;
  fields: readonly string[];
  invalidate(ctx: MutationCtx, orgId: Id<"organizations">, before?: Data, after?: Data): Promise<unknown>;
};

/** Canon consumers subscribe to published definitions, never module-selected effects or arbitrary doc writes. */
const consumers: readonly Consumer[] = [
  { module: "@canon/icps", provide: "icps.v1", fields: ["spec", "active", "isDefault"], invalidate: invalidateFit },
  { module: "@canon/icps", provide: "icps.v1", fields: ["spec", "active"], invalidate: async (ctx, orgId) => { if (await interfaceOwner(ctx, orgId)) await scheduleWorkspaceGaps(ctx, orgId); } },
  { module: "@canon/audiences", provide: "audiences.v1", fields: ["filter"], invalidate: async (ctx, orgId, _before, after) => { if (after) await scheduleAudienceIcpGaps(ctx, orgId, after.filter); } },
];

function collectionOf(m: ModuleManifest, consumer: Consumer): string | null {
  if (m.id !== consumer.module) return null;
  const provide = m.provides?.[consumer.provide];
  const view = provide && m.views[provide.view];
  return view && "collection" in view ? view.collection : null;
}

/** Runs after the guarded write, in its transaction. Imports use this same boundary. */
export async function providedCollectionChanged(ctx: MutationCtx, orgId: Id<"organizations">, m: ModuleManifest, collection: string, before: Data, after: Data): Promise<void> {
  for (const consumer of consumers) {
    if (collectionOf(m, consumer) !== collection) continue;
    if (before !== null && after !== null && consumer.fields.every((f) => JSON.stringify(before[f]) === JSON.stringify(after[f]))) continue;
    await consumer.invalidate(ctx, orgId, before, after);
  }
}

/** A set publication or lifecycle change can alter a provided view without changing a doc's fields. */
export async function providedCollectionsReset(ctx: MutationCtx, orgId: Id<"organizations">, manifests: readonly ModuleManifest[], collection?: string): Promise<void> {
  for (const consumer of consumers) {
    if (manifests.some((m) => {
      const served = collectionOf(m, consumer);
      return served !== null && (collection === undefined || served === collection);
    })) await consumer.invalidate(ctx, orgId);
  }
}
