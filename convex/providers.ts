/**
 * The provider registry's reads (convex/lib/providers/registry.ts): which providers a workspace brought its own key
 * for. A workspace key lives sealed on the workspace's `integrations` row for that provider; this says only whether
 * one is set, never what it is.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "./lib/providers/registry";

/** A workspace-keyed provider keeps its key on an `integrations` row of its own name. */
const WORKSPACE_KEYED = PROVIDER_IDS.filter((id) => PROVIDERS[id].keys.some((k) => k.source === "workspace")) as Array<Extract<ProviderId, Doc<"integrations">["provider"]>>;

/** The providers whose workspace key `orgId` has set. */
export const workspaceKeys = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args): Promise<string[]> => {
    const set: string[] = [];
    for (const provider of WORKSPACE_KEYED) {
      const row = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", args.orgId).eq("provider", provider)).first();
      if (row?.isActive) set.push(provider);
    }
    return set;
  },
});
