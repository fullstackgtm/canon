/**
 * Paid provider catalog and capped test runs (Add records -> Paid sources).
 * A manager picks a paid people search (convex/lib/paidProviders.ts) and
 * runs it once against the market: up to TEST_SIZE records, scored against
 * the acceptable-record bar, the persona, and the accounts already in the CRM.
 * CanonCRM pays for tests from a monthly per-workspace allowance; the cost
 * counted is what treg metered, and nothing from a test is written to the CRM.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { clientFor } from "./records";
import { paidCallsAllowed, TregRefusal } from "./lib/treg";
import { tregFor, tregKey } from "./lib/providers/treg";
import { acceptable, onTarget, PAID_PROVIDERS, paidProvider, TEST_SIZE, type PaidPerson } from "./lib/paidProviders";
import { creditsPerRecord, minCapCredits } from "./lib/creditPacks";

/** What CanonCRM spends on one workspace's tests in a calendar month (UTC). */
export const MONTHLY_ALLOWANCE_USD = 1;
/** Tests one workspace may run in a calendar month: every one of them is read to count the allowance. */
const MONTHLY_TESTS = 50;
/** A test still "running" after this long died; it no longer blocks or counts as in flight. */
const STALE_MS = 5 * 60_000;
const SAMPLE_ROWS = 10;

const personaValidator = v.object({ levels: v.array(v.string()), departments: v.array(v.string()), titles: v.array(v.string()), countries: v.optional(v.array(v.string())) });
const marketValidator = v.object({ industries: v.array(v.string()), employeeBands: v.array(v.string()), countries: v.array(v.string()) });

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds integrations.manage. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "integrations.manage");
const monthStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
/** Worst case for one test: a third over the catalog estimate, the most treg may bill the call. */
const testCapUsd = (usdPerRecord: number) => Math.round(usdPerRecord * TEST_SIZE * 1.33 * 10_000) / 10_000;

/** This month's spend: metered cost of finished tests plus the cap of any still running. */
function spentUsd(tests: Doc<"providerTests">[], now: number): number {
  let micro = 0;
  for (const t of tests) {
    if (t.status === "running" && now - t.startedAt < STALE_MS) micro += testCapUsd(paidProvider(t.provider)?.usdPerRecord ?? 0) * 1e6;
    else micro += t.costMicro ?? 0;
  }
  return micro / 1e6;
}

/** The catalog, this month's allowance, and the workspace's recent tests. */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const month = await ctx.db
      .query("providerTests")
      .withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId).gte("startedAt", monthStart(now)))
      .take(MONTHLY_TESTS + 1);
    const recent = await ctx.db.query("providerTests").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(12);
    return {
      canRun: isManager(user),
      configured: integrationEnabled("treg"),
      paidEnabled: paidCallsAllowed(),
      allowance: { limitUsd: MONTHLY_ALLOWANCE_USD, usedUsd: spentUsd(month, now) },
      providers: PAID_PROVIDERS.map((p) => ({
        id: p.id, label: p.label, note: p.note, usdPerRecord: p.usdPerRecord, testCapUsd: testCapUsd(p.usdPerRecord),
        // A run's smallest cap: whole dollars covering one page's hold.
        minRunCapCredits: minCapCredits(p), creditsPerRecord: creditsPerRecord(p.usdPerRecord),
      })),
      tests: recent.map((t) => ({
        id: t._id, provider: t.provider, status: t.status === "running" && now - t.startedAt >= STALE_MS ? ("failed" as const) : t.status,
        startedAt: t.startedAt, returned: t.returned, acceptable: t.acceptable, onTarget: t.onTarget, known: t.known, available: t.available,
        costUsd: t.costMicro !== undefined ? t.costMicro / 1e6 : undefined, sample: t.sample ?? [], error: t.error,
      })),
    };
  },
});

/** Start a test if the caller may, nothing else of theirs is running, and the allowance covers its worst case. */
export const reserve = internalMutation({
  args: { provider: v.string(), market: marketValidator, persona: personaValidator },
  handler: async (ctx, args): Promise<{ testId: Id<"providerTests">; orgId: Id<"organizations"> }> => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!isManager(user)) throw new ConvexError("Only admins and managers can test paid sources.");
    const provider = paidProvider(args.provider);
    if (!provider) throw new ConvexError(`Unknown source "${args.provider}".`);
    const now = Date.now();
    const month = await ctx.db
      .query("providerTests")
      .withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId).gte("startedAt", monthStart(now)))
      .take(MONTHLY_TESTS + 1);
    if (month.length >= MONTHLY_TESTS) throw new ConvexError(`This workspace has run ${MONTHLY_TESTS} tests this month, the most there are. They reset on the 1st.`);
    if (month.some((t) => t.status === "running" && now - t.startedAt < STALE_MS)) throw new ConvexError("A test is already running. Wait for it to finish.");
    const left = MONTHLY_ALLOWANCE_USD - spentUsd(month, now);
    if (testCapUsd(provider.usdPerRecord) > left) {
      throw new ConvexError(`This month's free test allowance is used up ($${left.toFixed(2)} of $${MONTHLY_ALLOWANCE_USD.toFixed(2)} left). It resets on the 1st.`);
    }
    const testId = await ctx.db.insert("providerTests", {
      orgId: user.orgId, userId: user._id, provider: provider.id, status: "running", market: args.market, persona: args.persona, startedAt: now,
    });
    return { testId, orgId: user.orgId };
  },
});

export const finish = internalMutation({
  args: {
    testId: v.id("providerTests"),
    status: v.union(v.literal("done"), v.literal("failed")),
    returned: v.optional(v.number()),
    acceptable: v.optional(v.number()),
    onTarget: v.optional(v.number()),
    known: v.optional(v.number()),
    available: v.optional(v.number()),
    costMicro: v.optional(v.number()),
    sample: v.optional(v.array(v.object({
      name: v.string(), title: v.optional(v.string()), company: v.optional(v.string()), domain: v.optional(v.string()),
      linkedinUrl: v.optional(v.string()), acceptable: v.boolean(),
    }))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { testId, ...patch }) => {
    await ctx.db.patch(testId, { ...patch, finishedAt: Date.now() });
    return null;
  },
});

/** Run one capped test of a paid source against the market. */
export const run = action({
  args: { provider: v.string(), market: marketValidator, persona: personaValidator },
  handler: async (ctx, args): Promise<{ testId: Id<"providerTests"> }> => {
    if (!tregKey("people.search")) throw new ConvexError("Data sources are not configured on this deployment (TREG_TOKEN is missing).");
    if (!paidCallsAllowed()) throw new ConvexError("Paid sources are switched off on this deployment, so tests can't run here.");
    const provider = paidProvider(args.provider)!;
    const { testId, orgId } = await ctx.runMutation(internal.providerTests.reserve, args);
    let costMicro: number | undefined;
    try {
      const res = await tregFor("people.search", {
        endpoint: provider.endpoint, body: provider.body(args.market, args.persona, TEST_SIZE),
        meta: { customer: orgId, feature: "provider_test" }, maxCostUsd: testCapUsd(provider.usdPerRecord), baseUrl: process.env.TREG_BASE_URL,
      });
      costMicro = res.costMicro ?? undefined;
      if (res.status >= 400) throw new Error(`${provider.label} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      const rows = provider.rows(res.body).slice(0, TEST_SIZE);
      const good = rows.filter(acceptable);
      const available = provider.page(res.body).total;
      const known = await knownDomains(ctx, orgId, good);
      const name = (p: PaidPerson) => [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
      await ctx.runMutation(internal.providerTests.finish, {
        testId, status: "done", returned: rows.length, acceptable: good.length, ...(available !== null ? { available } : {}),
        onTarget: good.filter((p) => onTarget(p, args.market, args.persona)).length,
        known: good.filter((p) => known.has(p.companyDomain!)).length,
        costMicro: costMicro ?? 0,
        sample: rows.slice(0, SAMPLE_ROWS).map((p) => ({
          name: name(p), acceptable: acceptable(p),
          ...(p.title ? { title: p.title } : {}), ...(p.companyName ? { company: p.companyName } : {}),
          ...(p.companyDomain ? { domain: p.companyDomain } : {}), ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
        })),
      });
    } catch (error) {
      const message = error instanceof TregRefusal ? `${provider.label} refused the call (${error.code}).` : error instanceof Error ? error.message.slice(0, 300) : String(error);
      await ctx.runMutation(internal.providerTests.finish, { testId, status: "failed", error: message, ...(costMicro !== undefined ? { costMicro } : {}) });
    }
    return { testId };
  },
});

/** Which of these people's companies are already accounts in the workspace. */
async function knownDomains(ctx: Parameters<typeof clientFor>[0], orgId: string, people: PaidPerson[]): Promise<Set<string>> {
  const domains = [...new Set(people.map((p) => p.companyDomain!).filter(Boolean))];
  const found = new Set<string>();
  const client = clientFor(ctx);
  for (let i = 0; i < domains.length; i += 5) {
    await Promise.all(domains.slice(i, i + 5).map(async (domain) => {
      try {
        const page = await client.list(orgId, { filter: { q: domain }, limit: 5 });
        if (page.rows.some((r) => r.domain === domain)) found.add(domain);
      } catch {
        // Overlap is a hint; a failed lookup only means "not counted".
      }
    }));
  }
  return found;
}
