import { ConvexError, v } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

const NAME_MAX = 80;
export const DASHBOARDS_MAX = 100;
export const TILES_MAX = 24;

export const tile = v.object({ reportId: v.id("reports"), wide: v.boolean() });

export function cleanDashboardName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) throw new ConvexError(`A dashboard name is 1 to ${NAME_MAX} characters`);
  return trimmed;
}

/** Every tile must be a report the caller can see; on a shared dashboard, a shared one, so no viewer meets a tile they cannot open. */
export async function checkTiles(ctx: QueryCtx, user: Doc<"users">, tiles: readonly { reportId: Id<"reports"> }[], sharedDashboard: boolean, module?: string | readonly (string | undefined)[]) {
  if (tiles.length > TILES_MAX) throw new ConvexError(`A dashboard holds at most ${TILES_MAX} tiles`);
  for (const t of tiles) {
    const r = await ctx.db.get(t.reportId);
    if (!r || r.orgId !== user.orgId || !(Array.isArray(module) ? module.includes(r.module?.moduleId) : r.module?.moduleId === module) || !(r.shared || r.createdBy === user._id)) throw new ConvexError("Report not found");
    if (sharedDashboard && !r.shared) throw new ConvexError(`Share "${r.name}" with the workspace before it goes on a shared dashboard`);
  }
}

