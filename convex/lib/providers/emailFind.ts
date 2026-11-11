/**
 * Find a person's work email through the provider registry (registry.ts): the workspace's own Deepline account when
 * it connected one, then Canon's hosted treg waterfall, with every receipt filed by `meter`. The only place an email
 * lookup runs (tests/providerCensus.test.ts).
 */
import { ConvexError } from "convex/values";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { createDeeplineClient, DeeplineError, DEEPLINE_EMAIL_ENDPOINT } from "../deepline";
import { findVerifiedWorkEmail, type EmailResult, type VerifiedEmail } from "../emailFinder";
import { decryptFromStorage } from "../tokenHelpers";
import type { ProviderCapability } from "../../../modules/kernel/providers.ts";
import { PAID_EMAIL_HITS_PER_MONTH, resolveCapability, runChain, type KeySource, type ProviderId, type Resolution } from "./registry";

/** getleadsio lookups per UTC day across all workspaces. Free to us, but each hit spends one of treg's own getleadsio credits. */
export const GETLEADS_LOOKUPS_PER_DAY = 200;

/** Which providers serve `capability` in `orgId`'s workspace now. */
export async function resolveFor(ctx: ActionCtx, orgId: string, capability: ProviderCapability, opts: { sources?: readonly KeySource[] } = {}): Promise<Resolution> {
  const workspace: string[] = await ctx.runQuery(internal.providers.workspaceKeys, { orgId: orgId as Id<"organizations"> });
  return resolveCapability(capability, { workspace: new Set(workspace), env: process.env }, opts);
}

const FEATURE: Partial<Record<ProviderCapability, string>> = { "email.find": "find_email" };

/** One provider call's receipt. Every metered call is filed through here, as a `providerCalls` row. */
export async function meter(ctx: ActionCtx, r: {
  orgId: string; provider: ProviderId; capability: ProviderCapability; endpoint: string; callId?: string | null; costMicro: number; outcome: "hit" | "miss";
}): Promise<Id<"providerCalls">> {
  const feature = FEATURE[r.capability];
  if (!feature) throw new Error(`No usage feature for ${r.capability}`);
  return ctx.runMutation(internal.records.recordProviderCall, {
    orgId: r.orgId, provider: r.provider, endpoint: r.endpoint, feature, costMicro: r.costMicro, outcome: r.outcome, ...(r.callId ? { callId: r.callId } : {}),
  });
}

/** What a lookup found. `call` is the receipt that carries the answer, when the provider filed one; `paid` marks a Hunter hit. */
export type FoundEmail = { email: string | null; emailStatus?: VerifiedEmail["emailStatus"]; provider: EmailResult["provider"]; paid: boolean; call: Id<"providerCalls"> | null };

/** The daily or monthly allowance of the hosted lookup is used up; nothing was looked up. */
export class EmailLookupLimit extends Error {
  constructor(readonly limit: "daily" | "monthly") { super(`${limit === "daily" ? "Daily" : "Monthly"} email lookup limit reached.`); }
}

/**
 * Find a work email for one person. Throws ProviderUnavailable when no provider is set up, EmailLookupLimit when the
 * hosted allowance is spent, and the hosted path's TregRefusal. A Deepline failure is never the rep's problem while
 * treg can still answer: it is logged and the lookup moves on.
 */
export async function findWorkEmail(ctx: ActionCtx, a: { orgId: string; fullName: string; domain: string; sources?: readonly KeySource[] }): Promise<FoundEmail> {
  const resolution = await resolveFor(ctx, a.orgId, "email.find", { sources: a.sources });
  return runChain<FoundEmail>(resolution, async ({ provider }, last) => {
    if (provider === "deepline") return deeplineLookup(ctx, a, last);
    const r = await hostedLookup(ctx, a);
    return { email: r.email, emailStatus: r.emailStatus, provider: r.provider, paid: Boolean(r.paid), call: null };
  }, (r, error) => console.warn(`${r.provider} email lookup failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`));
}

async function deeplineLookup(ctx: ActionCtx, a: { orgId: string; fullName: string; domain: string }, last: boolean): Promise<FoundEmail | null> {
  const sealed: string | null = await ctx.runQuery(internal.deepline.apiKey, { orgId: a.orgId as Id<"organizations"> });
  if (!sealed) return last ? { email: null, provider: "deepline", paid: false, call: null } : null;
  let r;
  try { r = await createDeeplineClient({ apiKey: await decryptFromStorage(sealed), fetchImpl: fetch }).findWorkEmail({ fullName: a.fullName, domain: a.domain }); }
  catch (error) { throw error instanceof DeeplineError && last ? new ConvexError(error.message) : error; }
  const call = await meter(ctx, { orgId: a.orgId, provider: "deepline", capability: "email.find", endpoint: DEEPLINE_EMAIL_ENDPOINT, callId: r.runId, costMicro: 0, outcome: r.email ? "hit" : "miss" });
  if (!r.email && !last) return null;
  return { email: r.email, provider: "deepline", paid: false, call };
}

/** Canon's hosted waterfall on treg: pattern guesses verified, then the free and the paid finders, within the allowances. */
async function hostedLookup(ctx: ActionCtx, a: { orgId: string; fullName: string; domain: string }): Promise<VerifiedEmail> {
  const token = process.env.TREG_TOKEN;
  if (!token) throw new ConvexError("Email lookup is not configured on this deployment.");
  if (!await ctx.runMutation(internal.records.reserveEmailLookup, { orgId: a.orgId })) throw new EmailLookupLimit("daily");
  const knownPattern = await ctx.runQuery(internal.emailPatterns.read, { domain: a.domain });
  return findVerifiedWorkEmail({ ...a, token, meta: { customer: a.orgId, feature: "find_email" }, baseUrl: process.env.TREG_BASE_URL, knownPattern: knownPattern ?? undefined,
    learn: async (pattern) => { await ctx.runMutation(internal.emailPatterns.learn, { domain: a.domain, pattern }); },
    allowFreeFinder: () => ctx.runMutation(internal.populateActions.takeDaily, { provider: "getleadsio", cap: GETLEADS_LOOKUPS_PER_DAY }),
    allowPaidFinder: async () => {
      if ((await ctx.runQuery(internal.records.paidEmailHitsThisMonth, { orgId: a.orgId })) >= PAID_EMAIL_HITS_PER_MONTH) throw new EmailLookupLimit("monthly");
      return true;
    },
    receipt: async (endpoint, r, hit = r.status === 200) => {
      await meter(ctx, { orgId: a.orgId, provider: "treg", capability: "email.find", endpoint, callId: r.callId, costMicro: r.costMicro ?? 0, outcome: hit ? "hit" : "miss" });
    },
  });
}
