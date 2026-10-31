import type { Id } from "../../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../../_generated/server";
import { userBelongsToOrg } from "../../lib";
import { feedOf } from "./registry";

type Ctx = QueryCtx | MutationCtx;
export type FeedReadStamp = { linkId: Id<"connectorLinks">; revision: number };

export const feedGrant = (ctx: Ctx, orgId: Id<"organizations">, linkId: Id<"connectorLinks">, moduleId: string) =>
  ctx.db.query("connectorFeedGrants").withIndex("by_orgId_and_linkId_and_moduleId", (q) => q.eq("orgId", orgId).eq("linkId", linkId).eq("moduleId", moduleId)).unique();

/** Member read permission only. Action consent belongs to the connector's action authority. */
export async function feedReadAccess(ctx: Ctx, orgId: Id<"organizations">, moduleId: string, feed: string, linkId: Id<"connectorLinks">): Promise<{ stamp: FeedReadStamp | null } | null> {
  const owner = feedOf(feed);
  const link = await ctx.db.get(linkId);
  if (!owner || !link || link.orgId !== orgId || link.connector !== owner.connector.id) return null;
  if (owner.connector.scope === "workspace") return link.userId ? null : { stamp: null };
  if (!link.userId || link.status === "revoked") return null;
  const member = await ctx.db.get(link.userId);
  if (!member?.isActive || !await userBelongsToOrg(ctx, member, orgId)) return null;
  const grant = await feedGrant(ctx, orgId, linkId, moduleId);
  return grant?.granted === false ? null : { stamp: { linkId, revision: grant?.revision ?? 0 } };
}

/** Rechecked in the transaction applying the isolate's result, including a revoke followed by restore. */
export async function currentFeedGrants(ctx: Ctx, orgId: Id<"organizations">, moduleId: string, feed: string, stamps: FeedReadStamp[]): Promise<boolean> {
  for (const stamp of stamps) {
    const access = await feedReadAccess(ctx, orgId, moduleId, feed, stamp.linkId);
    if (!access?.stamp || access.stamp.revision !== stamp.revision) return false;
  }
  return true;
}
