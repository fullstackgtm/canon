/**
 * Sample data for a shared test workspace: an admin on dev.canoncrm.com (or a local stack) picks sets (SAMPLE_SETS)
 * and loads them into their own workspace, so everyone in it sees the same records:
 *
 *   - Forecast's "Northwind" (docs/module-plans/forecast.md §12): a sales team, Q4 2026 targets and eight deals whose
 *     changes are dated, so What moved has history to draw.
 *   - Customer success's "Acme Analytics" (docs/module-plans/customer-success.md §12): six companies and twelve
 *     renewal, expansion and churn deals, so Retention has ARR to bridge.
 *
 *   - A large generated set (convex/lib/sampleDataset.ts): a ten-person sales team, 300 companies, 900 people and
 *     600 deals over the past year with dated stage, close-date and amount changes, dated from the day it loads.
 *
 * The fixtures' people are members who never sign in (clerk ids under `sample_<orgId>_`). Never on production: the
 * deployment check reads CONVEX_CLOUD_URL. Loading again writes the same records: the Northwind deals' history is
 * written once.
 */
import { ConvexError, v } from "convex/values";
import { action, internalMutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { can } from "./lib/capabilities";
import { isDevOrLocalDeployment } from "./lib/devDeployment.ts";
import { clientFor } from "./records";
import { saveDealValues } from "./canon";
import { ensureAccount, ensureDeal, ensureUser, seedAcmeDeal, seedNorthwind, upsertAcmeCompanies } from "./devSeed";
import { SAMPLE_SETS, sampleDataset, withNeeds, type SampleSetKey } from "./lib/sampleDataset";
import { ACME_DEALS } from "./lib/sampleAcme.ts";
import type { Id } from "./_generated/dataModel";

const enabled = () => isDevOrLocalDeployment(process.env);
const prefix = (orgId: Id<"organizations">, fixture: string) => `sample_${orgId}_${fixture}_`;

/** Whether the caller can load sample data here, and which sets this workspace already has (as far as Convex knows). */
export const status = query({
  args: {},
  handler: async (ctx): Promise<{ available: boolean; loaded: SampleSetKey[] }> => {
    const user = await getCurrentUser(ctx);
    if (!enabled() || !user || !can(user, "members.manage")) return { available: false, loaded: [] };
    const orgId = user.orgId;
    const deal = async (crmId: string) => !!await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", crmId)).first();
    const member = async (clerkUserId: string) => !!await ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId)).first();
    const loaded: SampleSetKey[] = [];
    if (await member(`${prefix(orgId, "team")}maya`)) loaded.push("team");
    if (await deal("sample-d1")) loaded.push("deals");
    if (await deal("northwind-D1")) loaded.push("forecast");
    if (await deal(`acme-${ACME_DEALS[0]!.key}`)) loaded.push("customerSuccess");
    return { available: true, loaded };
  },
});

/** The caller's workspace, once they are an admin on a deployment that allows sample data. */
async function callerOrg(ctx: MutationCtx): Promise<{ orgId: Id<"organizations">; userId: Id<"users"> }> {
  if (!enabled()) throw new ConvexError("Sample data is only available on dev.canoncrm.com and local stacks");
  const user = await requireUser(ctx);
  if (!can(user, "members.manage")) throw new ConvexError("Only a workspace admin can load sample data");
  return { orgId: user.orgId, userId: user._id };
}

/** The CRM account the sample deals hang off: always a sample one, so no real account gains sample deals. */
async function sampleAccount(ctx: MutationCtx, orgId: Id<"organizations">, ownerId: Id<"users">): Promise<Id<"crmAccounts">> {
  const existing = await ctx.db.query("crmAccounts").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", "sample-northwind")).first();
  if (existing) return existing._id;
  return ensureAccount(ctx, {
    orgId, crmId: "sample-northwind", name: "Northwind Sample Co", domain: "northwind.demo", industry: "computer software",
    employeeCount: 250, annualRevenue: 25_000_000, ownerId, now: Date.now(),
  });
}

export const begin = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ orgId: Id<"organizations"> }> => {
    const { orgId } = await callerOrg(ctx);
    return { orgId };
  },
});

export const loadNorthwind = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const { orgId, userId } = await callerOrg(ctx);
    await seedNorthwind(ctx, orgId, await sampleAccount(ctx, orgId, userId), prefix(orgId, "northwind"));
    return null;
  },
});

export const loadAcmeDeal = internalMutation({
  args: { companies: v.record(v.string(), v.string()), deal: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { orgId, userId } = await callerOrg(ctx);
    await seedAcmeDeal(ctx, orgId, await sampleAccount(ctx, orgId, userId), args.companies, args.deal, prefix(orgId, "acme"));
    return null;
  },
});

const BATCH = 100;
const DEALS_PER_MUTATION = 4;

/** The large set's team, in the caller's workspace: two managers and eight reps. Returns user ids by key. */
export const loadTeam = internalMutation({
  args: { today: v.string() },
  handler: async (ctx, args): Promise<Record<string, Id<"users">>> => {
    const { orgId } = await callerOrg(ctx);
    const ids: Record<string, Id<"users">> = {};
    for (const r of sampleDataset(args.today).reps) {
      ids[r.key] = await ensureUser(ctx, {
        orgId, clerkUserId: `${prefix(orgId, "team")}${r.key}`, email: `${r.key}@team.demo`, name: r.name, role: r.role, title: r.title,
        startDate: "2025-01-06", ...(r.manager ? { managerId: ids[r.manager] } : {}),
      });
    }
    return ids;
  },
});

/**
 * A slice of the large set's deals. A deal already loaded is left as it is: its history is written once, so loading
 * again on a later day adds nothing and rewrites nothing.
 */
export const loadDeals = internalMutation({
  args: { today: v.string(), from: v.number(), to: v.number(), companies: v.record(v.string(), v.string()), team: v.record(v.string(), v.id("users")) },
  handler: async (ctx, args): Promise<number> => {
    const { orgId, userId } = await callerOrg(ctx);
    const accountId = await sampleAccount(ctx, orgId, userId);
    const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
    let written = 0;
    for (const d of sampleDataset(args.today).deals.slice(args.from, args.to)) {
      const crmId = `sample-${d.key}`;
      const existing = await ctx.db.query("deals").withIndex("by_orgId_crmId", (q) => q.eq("orgId", orgId).eq("crmId", crmId)).first();
      const owner = args.team[d.owner];
      if (existing || !owner) continue;
      const created = at(d.created);
      const dealId = await ensureDeal(ctx, {
        orgId, crmId, name: d.name, amount: d.amount * 100, closeDate: d.closeDate, dealType: d.type, stage: d.start.stage,
        forecastCategory: d.start.forecastCategory, probability: 0.2, primaryRepId: owner, accountId, isClosed: false, isWon: false, now: created,
      });
      let row = await ctx.db.get(dealId);
      if (!row) continue;
      // A sync carries no Canon owner or company, so they are set as a person would.
      const company = args.companies[d.companyKey];
      await saveDealValues(ctx, row, { kind: "user", userId: owner }, { ownerId: owner, ...(company ? { companyId: company } : {}) }, { now: created + 60_000 });
      for (const change of d.changes) {
        row = await ctx.db.get(dealId);
        if (row) await saveDealValues(ctx, row, { kind: "user", userId: owner }, change.values, { now: at(change.day) });
      }
      written++;
    }
    return written;
  },
});

/** The large set's companies (and, when asked, their people) in the record service. Returns company ids by key. */
async function loadCompanies(ctx: ActionCtx, orgId: Id<"organizations">, today: string, people: boolean): Promise<Record<string, string>> {
  const set = sampleDataset(today);
  const client = clientFor(ctx);
  await client.provision(orgId);
  const ids: Record<string, string> = {};
  for (let i = 0; i < set.companies.length; i += BATCH) {
    const slice = set.companies.slice(i, i + BATCH);
    const saved = await client.upsertAccounts(orgId, {
      records: slice.map(({ domain, name, industry, employees, country }) => ({ domain, name, industry, employees, country })),
      source: "dev-seed", idempotencyKey: `sample-large-companies-${orgId}-${i}`,
    });
    slice.forEach((c, j) => { if (saved.ids[j]) ids[c.key] = saved.ids[j]!; });
  }
  if (!people) return ids;
  const domain = new Map(set.companies.map((c) => [c.key, c.domain]));
  for (let i = 0; i < set.people.length; i += BATCH) {
    await client.upsertContacts(orgId, {
      records: set.people.slice(i, i + BATCH).map((p) => ({ accountDomain: domain.get(p.companyKey)!, fullName: p.fullName, title: p.title, email: p.email })),
      source: "dev-seed", idempotencyKey: `sample-large-people-${orgId}-${i}`,
    });
  }
  return ids;
}

const setKey = v.union(...SAMPLE_SETS.map((s) => v.literal(s.key)));

/** Load the picked sets, and what they need, into the caller's workspace. Each step checks the caller again. */
export const load = action({
  args: { sets: v.array(setKey) },
  handler: async (ctx, args): Promise<{ sets: SampleSetKey[] }> => {
    const sets = withNeeds(args.sets);
    if (!sets.length) throw new ConvexError("Pick at least one set");
    const { orgId } = await ctx.runMutation(internal.sampleData.begin, {});
    const today = new Date().toISOString().slice(0, 10);
    const set = sampleDataset(today);
    const team = sets.includes("team") ? await ctx.runMutation(internal.sampleData.loadTeam, { today }) : {};
    const companies = sets.includes("companies") ? await loadCompanies(ctx, orgId, today, sets.includes("people")) : {};
    if (sets.includes("deals")) {
      for (let from = 0; from < set.deals.length; from += DEALS_PER_MUTATION) {
        const slice = set.deals.slice(from, from + DEALS_PER_MUTATION);
        const theirs = Object.fromEntries(slice.flatMap((d) => (companies[d.companyKey] ? [[d.companyKey, companies[d.companyKey]!]] : [])));
        await ctx.runMutation(internal.sampleData.loadDeals, { today, from, to: from + DEALS_PER_MUTATION, companies: theirs, team });
      }
    }
    if (sets.includes("forecast")) await ctx.runMutation(internal.sampleData.loadNorthwind, {});
    if (sets.includes("customerSuccess")) {
      const acme = await upsertAcmeCompanies(ctx, orgId, `sample-acme-companies-${orgId}`);
      // A deal a mutation, as the local seed does: each goes through the deal ledger twice.
      for (const d of ACME_DEALS) await ctx.runMutation(internal.sampleData.loadAcmeDeal, { companies: acme, deal: d.key });
    }
    return { sets };
  },
});
