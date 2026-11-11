"use node";

/**
 * Free fill for a connected HubSpot portal (docs/enrich-free-fill.md): report how complete each company field is and
 * how many blanks Canon can fill at no cost, then turn fills into a patch plan that goes through the usual review,
 * approval and compare-and-set apply (hygiene.apply_operations).
 *
 * The coverage check is a resumable job, not one long action (portals run to a million companies):
 * - `readChunk` walks HubSpot's company list (cursor paging is sequential) CHUNK companies at a time, hands each
 *   chunk to its own `matchChunk`, and schedules itself with the next cursor;
 * - `matchChunk`s run in parallel with the reader and each other: index lookup, SEC revenue, fills;
 * - enrichFreeFillRuns.ts merges each chunk's report into the run, which the panel subscribes to.
 */
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { can, refusal } from "./lib/capabilities";
import { accessTokenForOrg } from "./hubspotActions";
import { fixtureFetch } from "./lib/hubspotFixture";
import { clientFor } from "./records";
import {
  coverageReport, distinctiveName, fillPlan, indexMatch, namesAgree, normalizeDomain, planFills, READ_PROPERTIES, rootDomainCandidates, sourceValues,
  type Fill, type GapReason, type HubspotCompany, type Match, type PropertyOption,
} from "./lib/enrich/freeFill";
import { IDENTIFY_BATCH } from "./lib/crustdata";
import { companyDomain, identifyDetails, tregKey } from "./lib/providers/treg";
import { TregRefusal } from "./lib/treg";
import type { SharedCompanyDetail } from "./lib/recordContract";
import type { IndexLookup } from "./enrichFreeFillRuns";
import { UPSERT_BATCH } from "./enrichmentMatches";

/** Companies a check reads; a bigger portal is reported on its first this-many and says so. */
const MAX_COMPANIES = 1_000_000;
/** Companies per chunk: 20 HubSpot pages read, then matched by one action (well inside its limits). */
const CHUNK = 2_000;
/** Operations per plan, as hygiene plans cap them. Fills are blank-only, so the next plan picks up the rest. */
const PLAN_OPERATION_CAP = 500;
/** A plan reads the portal until it has enough fills or this much time has passed. */
const PLAN_READ_BUDGET_MS = 6 * 60_000;

async function signedInManager(ctx: ActionCtx) {
  const user = await ctx.runQuery(api.users.me, {});
  if (!user) throw new ConvexError("Not authenticated");
  if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return user;
}

/** HubSpot with the org's token; waits out 429s (Retry-After) rather than failing a long read. */
export async function hubspot(ctx: ActionCtx, orgId: Id<"organizations">) {
  const { accessToken } = await accessTokenForOrg(ctx, orgId);
  const doFetch = fixtureFetch(accessToken) ?? fetch;
  return async (path: string, init: { method?: string; body?: unknown } = {}): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`https://api.hubapi.com${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const wait = Number(res.headers.get("Retry-After")) * 1000 || 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        continue;
      }
      if (!res.ok) throw new ConvexError(`HubSpot ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${res.status}`);
      return res.json();
    }
  };
}
type HubspotGet = Awaited<ReturnType<typeof hubspot>>;

type ChunkCompany = { id: string; properties: Record<string, string | null> };

async function readPage(get: HubspotGet, after: string | undefined): Promise<{ companies: ChunkCompany[]; after: string | undefined }> {
  const q = new URLSearchParams({ limit: "100", archived: "false", properties: READ_PROPERTIES.join(",") });
  if (after) q.set("after", after);
  const page = await get(`/crm/v3/objects/companies?${q}`);
  // Only the read properties travel on to the matcher, keeping chunk arguments small.
  const companies: ChunkCompany[] = (page.results ?? []).map((r: any) => ({
    id: String(r.id),
    properties: Object.fromEntries(READ_PROPERTIES.map((p) => [p, r.properties?.[p] ?? null])),
  }));
  return { companies, after: page.paging?.next?.after };
}

/** The portal's own industry options: a fill must be one of them (HubSpot rejects anything else). */
async function industryOptions(get: HubspotGet): Promise<PropertyOption[]> {
  try {
    const props = await get(`/crm/v3/properties/companies?archived=false`);
    const industry = (props.results ?? []).find((p: any) => p.name === "industry");
    return (industry?.options ?? []).filter((o: any) => !o.hidden).map((o: any) => ({ label: String(o.label), value: String(o.value) }));
  } catch (error) {
    console.warn("free fill: industry options unavailable", error);
    return [];
  }
}

/** Index rows for these domains, and what the lookup did (an error leaves SEC revenue still filling). */
async function lookupIndex(ctx: ActionCtx, domains: string[]): Promise<{ index: Map<string, SharedCompanyDetail>; lookup: IndexLookup }> {
  const index = new Map<string, SharedCompanyDetail>();
  const client = clientFor(ctx);
  const version = client.mode === "http" ? await client.contractVersion() : null;
  let error: string | null = null;
  try {
    if (domains.length) for (const row of await client.lookupShared(domains)) index.set(row.domain, row);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.warn("free fill: shared index lookup failed", error);
  }
  return { index, lookup: { mode: client.mode, version, domains: domains.length, rows: index.size, error } };
}

/** Time a chunk may spend on the rate-limited free providers before leaving the rest unmatched. */
const PROVIDER_BUDGET_MS = 4 * 60_000;

/** A free treg call, retried while treg or the provider says to wait, until the deadline. */
async function patiently<T>(deadline: number, call: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    try {
      return await call();
    } catch (error) {
      const retryAt = error instanceof TregRefusal ? error.retryAt : null;
      const limited = error instanceof TregRefusal ? error.status === 429 || error.status === 503 : /HTTP (429|503)/.test(String(error));
      if (!limited) {
        console.warn("free fill: provider call failed", error instanceof Error ? error.message : error);
        return null;
      }
      const wait = Math.max(1000, Math.min(30_000, (retryAt ?? 0) - Date.now() || 2000 * 2 ** attempt));
      if (Date.now() + wait > deadline) return null;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return null;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/**
 * Each company's best match, by the cheapest source first:
 * 1. the shared index on its domain (low confidence only when names agree), then its root domain;
 * 2. Crustdata identify (free) for domains the index lacks;
 * 3. for companies with no domain, the domain of their exact name (CompanyEnrich, free), then the index.
 */
async function resolveMatches(ctx: ActionCtx, orgId: Id<"organizations">, companies: HubspotCompany[], until = Infinity) {
  const domainOf = (c: HubspotCompany) => normalizeDomain(c.properties.domain);
  const wanted = new Set<string>();
  for (const c of companies) {
    const d = domainOf(c);
    if (d) [d, ...rootDomainCandidates(d)].forEach((x) => wanted.add(x));
  }
  const { index, lookup } = await lookupIndex(ctx, [...wanted]);
  const matches = new Map<string, Match>();
  const gaps = new Map<string, GapReason>();
  for (const c of companies) {
    const m = indexMatch(c, index);
    if ("gap" in m) gaps.set(c.id, m.gap);
    else matches.set(c.id, m);
  }

  if (!tregKey("company.enrich")) return { matches, gaps, lookup };
  const meta = { customer: String(orgId), feature: "free_fill" };
  const deadline = Math.min(until, Date.now() + PROVIDER_BUDGET_MS);
  const timeoutMs = () => Math.max(1000, Math.min(60_000, deadline - Date.now()));

  // Crustdata identify for domains the index lacks, 25 per call.
  const missing = companies.filter((c) => gaps.get(c.id) === "notFound" || gaps.get(c.id) === "namesDisagree");
  const missingDomains = [...new Set(missing.map(domainOf).filter((d): d is string => Boolean(d)))];
  const crust = new Map<string, SharedCompanyDetail>();
  for (let i = 0; i < missingDomains.length && Date.now() < deadline; i += IDENTIFY_BATCH) {
    const found = await patiently(deadline, () => identifyDetails({ domains: missingDomains.slice(i, i + IDENTIFY_BATCH), meta, timeoutMs: timeoutMs() }));
    for (const [d, row] of found ?? []) crust.set(d, row);
  }
  for (const c of missing) {
    const d = domainOf(c)!;
    const row = crust.get(d);
    if (row) {
      matches.set(c.id, { row, source: "crustdata", via: "crustdata", domain: d });
      gaps.delete(c.id);
    }
  }

  // No domain: the domain of the exact company name, then the index (CompanyEnrich allows about 300 calls a minute).
  const nameless = companies.filter((c) => gaps.get(c.id) === "noDomain" && distinctiveName(c.properties.name));
  const resolved = new Map<string, string>();
  await pool(nameless, 5, async (c) => {
    if (Date.now() >= deadline) return;
    const d = await patiently(deadline, () => companyDomain({ name: c.properties.name!, meta, timeoutMs: timeoutMs() }));
    if (d) resolved.set(c.id, d);
  });
  if (resolved.size) {
    const { index: byName } = await lookupIndex(ctx, [...new Set(resolved.values())]);
    for (const c of nameless) {
      const d = resolved.get(c.id);
      const row = d ? byName.get(d) : undefined;
      if (d && row && (row.domainConfidence === "high" || namesAgree(c.properties.name, row.name))) {
        matches.set(c.id, { row, source: "pdl", via: "lookup", domain: d });
        gaps.delete(c.id);
      }
    }
  }
  return { matches, gaps, lookup };
}

/**
 * Keep each match's raw values for field consolidation's enrichment columns. A match found by company name alone fills
 * only the domain here, so it is not kept as a source either.
 */
async function saveMatches(ctx: ActionCtx, orgId: Id<"organizations">, matches: Map<string, Match>) {
  const rows = [...matches]
    .filter(([, m]) => m.via !== "lookup")
    .map(([recordId, m]) => ({ recordId, source: m.source, via: m.via, domain: m.domain, values: sourceValues(m) }));
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await ctx.runMutation(internal.enrichmentMatches.upsert, { orgId, matches: rows.slice(i, i + UPSERT_BATCH) });
  }
}

/** Start a coverage check; the panel follows it through enrichFreeFillRuns.progress. */
export const coverage = action({
  args: { runKey: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const user = await signedInManager(ctx);
    // The report names companies across the whole portal: only for callers who see every record.
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "CRM coverage checks" });
    const get = await hubspot(ctx, user.orgId);
    let total: number | undefined;
    try {
      total = Math.min(MAX_COMPANIES, Number((await get("/crm/v3/objects/companies/search", { method: "POST", body: { limit: 1, filterGroups: [] } })).total ?? 0)) || undefined;
    } catch (error) {
      // A portal that refuses search still gets checked; progress then shows the count read so far.
      console.warn("free fill: company count unavailable", error);
    }
    await ctx.runMutation(internal.enrichFreeFillRuns.start, { orgId: user.orgId, userId: user._id, runKey: args.runKey, total });
    await ctx.scheduler.runAfter(0, internal.enrichFreeFill.readChunk, { orgId: user.orgId, runKey: args.runKey, read: 0 });
    return null;
  },
});

export const readChunk = internalAction({
  args: { orgId: v.id("organizations"), runKey: v.string(), after: v.optional(v.string()), read: v.number() },
  handler: async (ctx, args) => {
    if (!(await ctx.runQuery(internal.enrichFreeFillRuns.live, { runKey: args.runKey }))) return;
    try {
      const get = await hubspot(ctx, args.orgId);
      const companies: ChunkCompany[] = [];
      let after = args.after;
      do {
        const page = await readPage(get, after);
        companies.push(...page.companies);
        after = page.after;
      } while (after && companies.length < CHUNK && args.read + companies.length < MAX_COMPANIES);
      const capped = Boolean(after) && args.read + companies.length >= MAX_COMPANIES;
      const last = !after || capped;
      if (companies.length) await ctx.scheduler.runAfter(0, internal.enrichFreeFill.matchChunk, { orgId: args.orgId, runKey: args.runKey, companies });
      await ctx.runMutation(internal.enrichFreeFillRuns.chunkRead, { runKey: args.runKey, companies: companies.length, last, capped });
      if (!last) await ctx.scheduler.runAfter(0, internal.enrichFreeFill.readChunk, { orgId: args.orgId, runKey: args.runKey, after, read: args.read + companies.length });
    } catch (error) {
      await ctx.runMutation(internal.enrichFreeFillRuns.fail, { runKey: args.runKey, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const matchChunk = internalAction({
  args: { orgId: v.id("organizations"), runKey: v.string(), companies: v.array(v.object({ id: v.string(), properties: v.record(v.string(), v.union(v.string(), v.null())) })) },
  handler: async (ctx, args) => {
    if (!(await ctx.runQuery(internal.enrichFreeFillRuns.live, { runKey: args.runKey }))) return;
    try {
      const options = await industryOptions(await hubspot(ctx, args.orgId));
      const { matches, gaps, lookup } = await resolveMatches(ctx, args.orgId, args.companies);
      await saveMatches(ctx, args.orgId, matches);
      const { report } = coverageReport(args.companies, matches, options, gaps);
      await ctx.runMutation(internal.enrichFreeFillRuns.chunkMatched, { runKey: args.runKey, report: JSON.parse(JSON.stringify(report)), lookup });
    } catch (error) {
      await ctx.runMutation(internal.enrichFreeFillRuns.fail, { runKey: args.runKey, error: error instanceof Error ? error.message : String(error) });
    }
  },
});

export const createPlan = action({
  args: { includeEstimates: v.boolean() },
  handler: async (ctx, args): Promise<
    ({ status: "created"; patchPlanId: Id<"patchPlans">; operations: number; more: boolean } | { status: "nothing_to_fill" }) & { ownedByCanonField: string[] }
  > => {
    const user = await signedInManager(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "fill plans over the CRM" });
    const ownedByCanonField = await ctx.runQuery(internal.fieldConsolidations.ownedFields, { orgId: user.orgId });
    const owned = new Set(ownedByCanonField);
    const get = await hubspot(ctx, user.orgId);
    const options = await industryOptions(get);
    // Read and match a chunk at a time until the plan is full: a plan needs its first 500 fills, not the portal.
    const chosen: Fill[] = [];
    const started = Date.now();
    let after: string | undefined;
    let read = 0;
    do {
      const companies: HubspotCompany[] = [];
      do {
        const page = await readPage(get, after);
        companies.push(...page.companies);
        after = page.after;
      } while (after && companies.length < 500);
      read += companies.length;
      const { matches, gaps } = await resolveMatches(ctx, user.orgId, companies, started + PLAN_READ_BUDGET_MS);
      chosen.push(...planFills(coverageReport(companies, matches, options, gaps).fills, { includeEstimates: args.includeEstimates, owned }));
    } while (after && chosen.length < PLAN_OPERATION_CAP && read < MAX_COMPANIES && Date.now() - started < PLAN_READ_BUDGET_MS);
    if (!chosen.length) return { status: "nothing_to_fill", ownedByCanonField };
    const stored = chosen.slice(0, PLAN_OPERATION_CAP);
    const plan = fillPlan(stored, new Date());
    const { patchPlanId } = await ctx.runMutation(internal.hygiene.persistRulePlan, {
      userId: user._id,
      orgId: user.orgId,
      rule: "enrich.free_fill",
      summary: plan.summary,
      operations: plan.operations.map((operation) => ({ ...operation, packageOpId: operation.id })),
      document: JSON.parse(JSON.stringify(plan)),
      foundOperationCount: stored.length,
    });
    return { status: "created", patchPlanId, operations: stored.length, more: Boolean(after) || chosen.length > stored.length, ownedByCanonField };
  },
});
