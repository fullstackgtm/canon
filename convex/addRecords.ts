/**
 * Add records: a manager fills the CRM from the free population sources on
 * demand, without a signup research session. Two ways in, each one tray job
 * on the population pipeline (populateActions.ts):
 *
 *   target accounts  companies the user names: written as accounts, then
 *                    the people at them who match the persona.
 *   market search    a market the user describes: every company and buyer
 *                    the sources find in it, previewed first.
 *
 * Every call is free ($0 ceiling), as in signup population. Adding a single
 * record by hand goes through records.upsert instead.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalQuery, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { startPopulation, type PopulateTask } from "./populateActions";
import type { Icp } from "../engine/src/icp";
import { quickEnrichPage } from "./lib/quickenrich";
import { icpGeosToCountries } from "./lib/researchPipeline";
import { normDomain } from "./lib/peopleSources";
import { TregRefusal } from "./lib/treg";
import {
  accountQueries, MAX_TARGET_ACCOUNTS, marketIsNarrow, marketQueries, parseAccountList,
} from "./lib/addRecords";
import { icpExcludeValidator, type IcpSpec } from "./lib/icpSpec";
import { emptySpec, specFromIcp } from "./lib/icps";
import { readIcps } from "./lib/icpsInterface";
import { isFillJob } from "./lib/runs";

/** Fills one workspace may have running at once. */
const MAX_RUNNING = 3;

const personaValidator = v.object({ levels: v.array(v.string()), departments: v.array(v.string()), titles: v.array(v.string()), countries: v.optional(v.array(v.string())) });
const marketValidator = v.object({ industries: v.array(v.string()), employeeBands: v.array(v.string()), countries: v.array(v.string()) });

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds imports.run. */
const isManager = (who: { role: string; capabilities?: readonly string[] }) => can(who, "imports.run");

/**
 * Who may run a fill, the workspace's saved ICPs to start the form from, and
 * its starting values: the default ICP, else the claimed session's ICP.
 */
export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const icps = (await readIcps(ctx, user.orgId)).map((i) => ({ key: i.key, name: i.name, isDefault: i.isDefault, spec: i.spec }));
    let start: { icpId: string | null; spec: IcpSpec } = icps[0] ? { icpId: icps[0].key, spec: icps[0].spec } : { icpId: null, spec: emptySpec() };
    if (!icps.length) {
      const session = await ctx.db
        .query("researchSessions")
        .withIndex("by_claimedByOrgId", (q) => q.eq("claimedByOrgId", user.orgId))
        .order("desc")
        .first();
      start = { icpId: null, spec: specFromIcp(session?.icp as Icp | undefined) };
    }
    return { canRun: isManager(user), configured: integrationEnabled("treg"), icps, start };
  },
});

export const scope = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    if (!isManager(user)) throw new ConvexError("Only admins and managers can add records from data sources.");
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("backgroundJobs")
      .withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId).gte("startedAt", since))
      .take(50);
    return { orgId: user.orgId, running: recent.filter((j) => isFillJob(j) && j.status === "processing").length };
  },
});

async function requireFill(ctx: ActionCtx): Promise<{ orgId: Id<"organizations">; token: string }> {
  const { orgId, running } = await ctx.runQuery(internal.addRecords.scope, {});
  const token = process.env.TREG_TOKEN;
  if (!token) throw new ConvexError("Data sources are not configured on this deployment (TREG_TOKEN is missing).");
  if (running >= MAX_RUNNING) throw new ConvexError(`${running} fills are already running. Wait for one to finish, then try again.`);
  return { orgId, token };
}

/** About how many people one source finds for the market, with a few of them. Free; nothing is written. */
export const previewMarket = action({
  args: { market: marketValidator, persona: personaValidator, exclude: v.optional(icpExcludeValidator) },
  handler: async (ctx, args): Promise<{ total: number | null; sample: Array<{ name: string; title: string | null; company: string }> }> => {
    const { orgId, token } = await requireFill(ctx);
    if (!marketIsNarrow(args.market)) throw new ConvexError("Pick at least one industry, company size or country.");
    const { quickenrich } = marketQueries(args.market, args.persona, args.exclude);
    try {
      const countryName = (iso: string) => icpGeosToCountries([iso.toLowerCase()])[0];
      const page = await quickEnrichPage({ token, query: quickenrich, meta: { customer: orgId, feature: "add_records_preview" }, countryName, baseUrl: process.env.TREG_BASE_URL });
      return {
        total: page.total,
        sample: page.people.slice(0, 5).map((p) => ({ name: p.fullName, title: p.title ?? null, company: p.company.name ?? p.company.domain })),
      };
    } catch (error) {
      if (error instanceof TregRefusal && error.temporary) throw new ConvexError("The free search is busy right now. Try the preview again in a few minutes.");
      throw error;
    }
  },
});

/** Fill the workspace from a described market: every company and buyer the free source (QuickEnrich) finds. */
export const startMarket = action({
  args: { market: marketValidator, persona: personaValidator, exclude: v.optional(icpExcludeValidator) },
  handler: async (ctx, args): Promise<{ jobId: Id<"backgroundJobs"> }> => {
    const { orgId } = await requireFill(ctx);
    if (!marketIsNarrow(args.market)) throw new ConvexError("Pick at least one industry, company size or country.");
    const q = marketQueries(args.market, args.persona, args.exclude);
    const what = [args.market.industries.slice(0, 2).join(", "), args.market.countries.map((c) => c.toUpperCase()).join(", ")].filter(Boolean).join(" · ");
    const jobId = await startPopulation(ctx, undefined, orgId, [
      { kind: "people", source: "quickenrich", query: q.quickenrich },
    ], { title: "Add a market", detail: `Searching ${what || "your market"}…` }, { stage: true });
    return { jobId };
  },
});

/** Add the named companies as accounts, then find the people at them who match the persona. */
export const startAccounts = action({
  args: { text: v.string(), persona: personaValidator, exclude: v.optional(icpExcludeValidator) },
  handler: async (ctx, args): Promise<{ jobId: Id<"backgroundJobs">; accounts: number; invalid: string[] }> => {
    const { orgId } = await requireFill(ctx);
    const { accounts, invalid } = parseAccountList(args.text);
    if (!accounts.length) throw new ConvexError(invalid.length ? `No company domains found (for example "${invalid[0]}" is not a domain).` : "Paste at least one company domain.");
    if (accounts.length > MAX_TARGET_ACCOUNTS) throw new ConvexError(`Add at most ${MAX_TARGET_ACCOUNTS.toLocaleString("en-US")} companies at a time (this list has ${accounts.length.toLocaleString("en-US")}).`);
    const domains = accounts.map((a) => normDomain(a.domain));
    const roots: PopulateTask[] = [{ kind: "accounts", accounts }];
    for (const q of accountQueries(domains, args.persona, args.exclude)) {
      roots.push({ kind: "people", source: "quickenrich", query: q.quickenrich });
    }
    const jobId = await startPopulation(ctx, undefined, orgId, roots, {
      title: `Add ${accounts.length.toLocaleString("en-US")} ${accounts.length === 1 ? "account" : "accounts"}`,
      detail: "Finding your accounts' buyers…",
    }, { stage: true });
    return { jobId, accounts: accounts.length, invalid: invalid.slice(0, 20) };
  },
});

/**
 * The workspace's latest fill, coarsely: the Accounts and Contacts pages reload
 * when it changes. The count moves in steps so a busy fill doesn't reload them
 * on every page of results.
 */
export const fillTick = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    // Reading an inbox is a job too, but fills nothing.
    const job = (await ctx.db.query("backgroundJobs").withIndex("by_orgId_and_startedAt", (q) => q.eq("orgId", user.orgId)).order("desc").take(20)).find(isFillJob);
    if (!job) return null;
    // A fill held for review writes nothing to the lists until it is approved (its approval is a job of its own).
    const staged = await ctx.db.query("stagedRuns").withIndex("by_jobId", (q) => q.eq("jobId", job._id)).unique();
    if (staged) return `${job._id}:staged`;
    return `${job._id}:${job.status}:${Math.floor((job.phases[0]?.count ?? 0) / 250)}`;
  },
});
