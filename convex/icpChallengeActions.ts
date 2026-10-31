"use node";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import type { Icp } from "../engine/src/icp.ts";
import { clientFor } from "./records";
import { resolveLlm } from "./lib/llmResolver";
import { fetchPage } from "./researchAgentActions";
import { icpToLeadsforge, type LeadsforgeFilters } from "./lib/leadsforge";
import { quickEnrichPage, type QuickEnrichQuery } from "./lib/quickenrich";
import { icpGeosToCountries } from "./lib/researchPipeline";
import { TregRefusal } from "./lib/treg";
import { challengeIcp, proposalQuickEnrich, type Proposal } from "./lib/tam/challengeIcp";

const BEST_ACCOUNTS = 15;

/**
 * Challenge my ICP, end to end:
 * 1. read the ICP, what we sell, won/lost deals and best accounts, plus the company's site;
 * 2. the LLM (the user's ChatGPT plan, never a server key) proposes adjacent markets;
 * 3. the pages it asked for are fetched and it cites them; only verbatim quotes survive;
 * 4. each market gets a size estimate from one free Leadsforge search, if one is available at $0.
 */
export const run = internalAction({
  args: { runId: v.id("icpChallengeRuns"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const fail = (error: string) => ctx.runMutation(internal.icpChallenge.update, { runId: args.runId, status: "failed", error: error.slice(0, 500) });
    try {
      const run: Doc<"icpChallengeRuns"> | null = await ctx.runQuery(internal.icpChallenge.getRun, { runId: args.runId });
      if (!run) return null;
      const llm = await resolveLlm(ctx, args.userId);
      if (!llm) return void (await fail("No LLM available. Connect ChatGPT in Integrations → ChatGPT."));
      const model = llm.model ?? DEFAULT_MODELS[llm.provider];

      const base = await ctx.runQuery(internal.icpChallenge.context, { runId: args.runId });
      const icp: LeadsforgeFilters = base.icp ? icpToLeadsforge(base.icp as Icp, icpGeosToCountries((base.icp as Icp).firmographics.geos)) : {};
      let bestAccounts: Array<{ name: string; industry?: string; employees?: number; country?: string }> = [];
      try {
        const page = await clientFor(ctx).list(run.orgId as string, { sort: { field: "fit", dir: "desc" }, limit: BEST_ACCOUNTS });
        bestAccounts = page.rows.slice(0, BEST_ACCOUNTS).map((a) => ({ name: a.name, industry: a.industry, employees: a.employees, country: a.country }));
      } catch (error) {
        console.warn(`icp challenge: could not read best accounts: ${error instanceof Error ? error.message : error}`);
      }

      const found = await challengeIcp({ ...base, bestAccounts }, icp, {
        call: (prompt, tool, schema) => forcedToolCall(prompt, tool, schema, model, llm),
        fetchPage,
      });
      if (!found.length) return void (await fail("The model proposed no usable markets outside your current ICP. Try again."));

      const toRow = (p: Proposal, size?: { accounts: number; capped: boolean }) => {
        const { readUrls: _readUrls, ...rest } = p;
        return { ...rest, ...(size ? { size } : {}), state: "open" as const };
      };
      // Show the markets now; sizes fill in as the free searches come back.
      await ctx.runMutation(internal.icpChallenge.update, { runId: args.runId, proposals: found.map((p) => toRow(p)), model: `${llm.provider}:${model}` });

      const sizes = await estimateSizes(ctx, run.orgId as string, found.map((p) => proposalQuickEnrich(p, base.icp as Icp | undefined)));
      await ctx.runMutation(internal.icpChallenge.update, { runId: args.runId, status: "done", proposals: found.map((p, i) => toRow(p, sizes[i])) });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "Could not challenge your ICP.");
    }
    return null;
  },
});

/**
 * Distinct accounts each market's first free QuickEnrich page finds (a $0
 * ceiling, so treg refuses rather than bills): a lower bound, `capped` when
 * the search has more pages. Omitted, not guessed, when the token is missing,
 * the provider is paused, or a search fails.
 */
async function estimateSizes(
  ctx: ActionCtx,
  orgId: string,
  queries: QuickEnrichQuery[],
): Promise<Array<{ accounts: number; capped: boolean } | undefined>> {
  const token = process.env.TREG_TOKEN;
  const out: Array<{ accounts: number; capped: boolean } | undefined> = queries.map(() => undefined);
  if (!token) return out;
  const pacing = await ctx.runQuery(internal.populateActions.getPacing, { provider: "quickenrich" });
  if (pacing && pacing.pausedUntil > Date.now()) return out;
  for (let i = 0; i < queries.length; i++) {
    try {
      const page = await quickEnrichPage({
        token, query: queries[i], meta: { customer: orgId, feature: "icp_challenge" }, baseUrl: process.env.TREG_BASE_URL,
        countryName: (iso) => icpGeosToCountries([iso.toLowerCase()])[0],
      });
      out[i] = { accounts: new Set(page.people.map((p) => p.company.domain)).size, capped: page.next !== null || (page.total ?? 0) > page.people.length };
    } catch (error) {
      console.warn(`icp challenge: no size for market ${i}: ${error instanceof Error ? error.message.slice(0, 160) : error}`);
      if (error instanceof TregRefusal) break;
    }
  }
  return out;
}
