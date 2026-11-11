/**
 * The registry's two action-side reads and writes: which providers serve a capability in a workspace now, and one
 * provider call's receipt. Every receipt a ported capability files goes through `meter`, as a `providerCalls` row.
 */
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { ProviderCapability } from "../../../modules/kernel/providers.ts";
import { resolveCapability, type KeySource, type ProviderId, type Resolution } from "./registry";

/** Which providers serve `capability` in `orgId`'s workspace now. */
export async function resolveFor(ctx: ActionCtx, orgId: string, capability: ProviderCapability, opts: { sources?: readonly KeySource[] } = {}): Promise<Resolution> {
  const workspace: string[] = await ctx.runQuery(internal.providers.workspaceKeys, { orgId: orgId as Id<"organizations"> });
  return resolveCapability(capability, { workspace: new Set(workspace), env: process.env }, opts);
}

/** The usage feature a capability's receipt is filed under, when its caller names none. */
const FEATURE: Partial<Record<ProviderCapability, string>> = { "email.find": "find_email", "phone.find": "find_phone" };

/** One provider call's receipt. `feature` is the usage line it counts toward (Settings → Usage), else the capability's. */
export async function meter(ctx: ActionCtx, r: {
  orgId: string; provider: Extract<ProviderId, Doc<"providerCalls">["provider"]>; capability: ProviderCapability; feature?: string; endpoint: string; callId?: string | null; costMicro: number; outcome: "hit" | "miss";
}): Promise<Id<"providerCalls">> {
  const feature = r.feature ?? FEATURE[r.capability];
  if (!feature) throw new Error(`No usage feature for ${r.capability}`);
  return ctx.runMutation(internal.records.recordProviderCall, {
    orgId: r.orgId, provider: r.provider, endpoint: r.endpoint, feature, costMicro: r.costMicro, outcome: r.outcome, ...(r.callId ? { callId: r.callId } : {}),
  });
}
