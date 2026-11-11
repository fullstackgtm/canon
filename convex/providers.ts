/**
 * The provider registry's reads (convex/lib/providers/registry.ts): which providers a workspace brought its own key
 * for. A workspace key lives sealed on the workspace's `integrations` row for that provider; this says only whether
 * one is set, never what it is.
 */
import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { can } from "./lib/capabilities";
import { PROVIDER_IDS, PROVIDERS, providerSettings, type CapabilityRow, type ProviderId } from "./lib/providers/registry";

/** A workspace-keyed provider keeps its key on an `integrations` row of its own name. */
const WORKSPACE_KEYED = PROVIDER_IDS.filter((id) => PROVIDERS[id].keys.some((k) => k.source === "workspace")) as Array<Extract<ProviderId, Doc<"integrations">["provider"]>>;

async function keysSet(ctx: QueryCtx, orgId: Id<"organizations">): Promise<string[]> {
  const set: string[] = [];
  for (const provider of WORKSPACE_KEYED) {
    const row = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", provider)).first();
    if (row?.isActive) set.push(provider);
  }
  return set;
}

/** The providers whose workspace key `orgId` has set. */
export const workspaceKeys = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args): Promise<string[]> => keysSet(ctx, args.orgId),
});

/**
 * Settings → Providers: each capability, the provider that serves it in the caller's workspace, where each key comes
 * from and what a call costs. Any member reads it (Find email and LinkedIn show only where a provider serves them);
 * `canManage` says whether the caller may set the workspace's own keys.
 */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<{ canManage: boolean; capabilities: CapabilityRow[] } | null> => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const workspace = new Set(await keysSet(ctx, user.orgId));
    return { canManage: can(user, "integrations.manage"), capabilities: providerSettings({ workspace, env: process.env }) };
  },
});
