/**
 * Find a person's phone through the provider registry (registry.ts): Canon's hosted treg phone finder on the
 * deployment's key, its receipt filed by `meter`. The only place a phone lookup runs (tests/providerCensus.test.ts).
 */
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { findPhoneViaTreg, TREG_PHONE_ENDPOINT, type PhoneResult } from "../phoneFinder";
import { runChain, type Resolution } from "./registry";
import { meter } from "./meter";

export type FoundPhone = Pick<PhoneResult, "phone" | "status" | "provider"> & { call: Id<"providerCalls"> };

/**
 * Look up one person's phone on a resolution of `phone.find` (meter.ts resolveFor), with everything known about
 * them. Throws ProviderUnavailable when nothing serves it, and the hosted path's TregRefusal.
 */
export async function findPhone(ctx: ActionCtx, resolution: Resolution, a: {
  orgId: string; fullName: string; domain: string; linkedinUrl?: string; email?: string; idempotencyKey: string;
}): Promise<FoundPhone> {
  return runChain<FoundPhone>(resolution, async () => {
    const r = await findPhoneViaTreg({
      token: process.env.TREG_TOKEN!, fullName: a.fullName, domain: a.domain,
      ...(a.linkedinUrl ? { linkedinUrl: a.linkedinUrl } : {}), ...(a.email ? { email: a.email } : {}),
      meta: { customer: a.orgId, feature: "find_phone" }, idempotencyKey: a.idempotencyKey, baseUrl: process.env.TREG_BASE_URL,
    });
    const call = await meter(ctx, { orgId: a.orgId, provider: "treg", capability: "phone.find", endpoint: TREG_PHONE_ENDPOINT, callId: r.callId, costMicro: r.costMicro, outcome: r.phone ? "hit" : "miss" });
    return { phone: r.phone, status: r.status, provider: r.provider, call };
  });
}
