/**
 * Research enrichment through the provider registry (registry.ts): a person's profile, a company's, and a job change
 * check, each one treg call on the deployment's key with its receipt filed by `meter`. The caller (lib/researchEnrich.ts)
 * decides what counts as found and charges credits for it; this is the only place these lookups run
 * (tests/providerCensus.test.ts).
 */
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { TregResult } from "../treg";
import { meter } from "./meter";
import { tregFor, tregKey } from "./treg";

/** What one lookup found (null: nothing that counts), what treg charged for it, and its receipt. */
export type Enriched<T> = { found: T | null; costMicro: number | null; call: Id<"providerCalls"> };

/** Whether this deployment has a key for research enrichment (person and company profiles, job change checks). */
export const enrichmentReady = () => Boolean(tregKey("person.enrich"));

async function lookUp<T>(ctx: ActionCtx, a: {
  orgId: string; capability: "person.enrich" | "company.enrich"; feature: string; endpoint: string; body: unknown; maxCostUsd: number; timeoutMs: number;
}, read: (res: TregResult) => T | null): Promise<Enriched<T>> {
  const res = await tregFor(a.capability, {
    endpoint: a.endpoint, body: a.body, maxCostUsd: a.maxCostUsd, baseUrl: process.env.TREG_BASE_URL, timeoutMs: a.timeoutMs, meta: { customer: a.orgId, feature: a.feature },
  });
  const found = read(res);
  const call = await meter(ctx, { orgId: a.orgId, provider: "treg", capability: a.capability, feature: a.feature, endpoint: a.endpoint, callId: res.callId, costMicro: res.costMicro ?? 0, outcome: found ? "hit" : "miss" });
  return { found, costMicro: res.costMicro, call };
}

/** One person's routed profile (treg people.enrich): `read` returns it only when it is them. */
export const enrichPersonProfile = <T>(ctx: ActionCtx, a: { orgId: string; body: unknown; maxCostUsd: number }, read: (res: TregResult) => T | null) =>
  lookUp(ctx, { ...a, capability: "person.enrich", feature: "research_enrich", endpoint: "treg.people.enrich", timeoutMs: 60_000 }, read);

/** One company's routed profile by its domain (treg companies.enrich). */
export const enrichCompanyProfile = <T>(ctx: ActionCtx, a: { orgId: string; domain: string; maxCostUsd: number }, read: (res: TregResult) => T | null) =>
  lookUp(ctx, { orgId: a.orgId, body: { domain: a.domain }, maxCostUsd: a.maxCostUsd, capability: "company.enrich", feature: "research_enrich", endpoint: "treg.companies.enrich", timeoutMs: 30_000 }, read);

/** Whether a person still works at `company` (LeadMagic's job change detector on treg). */
export const checkJobChange = <T>(ctx: ActionCtx, a: { orgId: string; profileUrl: string; company: string; maxCostUsd: number }, read: (res: TregResult) => T | null) =>
  lookUp(ctx, { orgId: a.orgId, body: { profile_url: a.profileUrl, company_name: a.company }, maxCostUsd: a.maxCostUsd, capability: "person.enrich", feature: "job_change", endpoint: "leadmagic.x.job-change-detector", timeoutMs: 60_000 }, read);
