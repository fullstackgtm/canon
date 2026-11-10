"use node";

import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
// Node-free module imports (never the package barrel) — established pattern.
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { clientFor } from "./records";
import { normalizeDomain } from "./lib/recordClient";
import type { AccountsFilter, AccountRow } from "./lib/recordContract";
import { resolveLlm } from "./lib/llmResolver";
import { jevSystemOne, type SystemOneAnswer, type SystemOneQuestion } from "./lib/segments/jev";
import { evidenceState } from "./lib/tam/jevSegments";
import {
  bucketCounts,
  contextText,
  parseSuggestions,
  questionFor,
  SAMPLE_SIZE,
  splitScore,
  SUGGESTION_SCHEMA,
  suggestionPrompt,
} from "./lib/tam/segmentSuggestions";

const JEV_CONCURRENCY = 8;

/**
 * Recommended AI segments, end to end:
 * 1. sample the scope's highest-fit accounts (what the team would work first);
 * 2. the LLM proposes traits from research, deals, calls and that sample;
 * 3. Jev answers every proposal for each sampled account (one request each);
 * 4. rank by how decisively each trait splits the sample.
 * Without JEV_API_KEY the proposals are shown unmeasured.
 */
export const run = internalAction({
  args: { runId: v.id("tamSuggestionRuns"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const fail = (error: string) =>
      ctx.runMutation(internal.tamSuggestions.update, { runId: args.runId, status: "failed", error: error.slice(0, 500) });
    try {
      const run: Doc<"tamSuggestionRuns"> | null = await ctx.runQuery(internal.tamSuggestions.getRun, { runId: args.runId });
      if (!run) return null;
      const ws = run.orgId as string;

      const llm = await resolveLlm(ctx, args.userId);
      if (!llm) return void (await fail("No LLM available. Connect ChatGPT in Integrations → ChatGPT."));

      const client = clientFor(ctx);
      const page = await client.list(ws, { filter: run.filter as AccountsFilter, sort: { field: "fit", dir: "desc" }, limit: SAMPLE_SIZE });
      const sample: AccountRow[] = page.rows.slice(0, SAMPLE_SIZE);

      const base = await ctx.runQuery(internal.tamSuggestions.context, { runId: args.runId });
      const context = {
        ...base,
        sampleAccounts: sample.map((a) => ({ name: a.name, industry: a.industry, employees: a.employees, country: a.country })),
      };
      const model = llm.model ?? DEFAULT_MODELS[llm.provider];
      const raw = await forcedToolCall(suggestionPrompt(context), "segment_suggestions", SUGGESTION_SCHEMA, model, llm);
      const proposals = parseSuggestions(raw, contextText(context), base.existingSegments);
      if (!proposals.length) return void (await fail("The model proposed no usable segments. Try again."));
      await ctx.runMutation(internal.tamSuggestions.update, {
        runId: args.runId,
        status: "measuring",
        suggestions: proposals,
        model: `${llm.provider}:${model}`,
      });

      const jevKey = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
      if (!jevKey || !sample.length) {
        await ctx.runMutation(internal.tamSuggestions.update, {
          runId: args.runId,
          status: "done",
          note: !jevKey ? "Not measured: JEV_API_KEY is not set." : "Not measured: no accounts in this view.",
        });
        return null;
      }

      const texts: Record<string, string> = await ctx.runAction(internal.tamFetch.homepages, {
        domains: sample.map((a) => normalizeDomain(a.domain)),
      });
      const questions: Record<string, SystemOneQuestion> = Object.fromEntries(proposals.map((p, i) => [`s${i}`, questionFor(p)]));
      const answers = await pool(sample, JEV_CONCURRENCY, async (row) => {
        try {
          const res = await jevSystemOne(jevKey, evidenceState({ ...row, siteText: texts[normalizeDomain(row.domain)] ?? null }), questions);
          return res.answers;
        } catch (error) {
          console.warn(`tamSuggest: jev failed for ${row.domain}: ${error instanceof Error ? error.message : error}`);
          return null;
        }
      });
      const measured = proposals
        .map((p, i) => {
          const counts = bucketCounts(answers.map((a): SystemOneAnswer | null => a?.[`s${i}`] ?? null));
          const { score, verdict } = splitScore(counts);
          return { ...p, counts, score, verdict };
        })
        .sort((a, b) => b.score - a.score);
      await ctx.runMutation(internal.tamSuggestions.update, {
        runId: args.runId,
        status: "done",
        suggestions: measured,
        sampleSize: answers.filter(Boolean).length,
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "Could not prepare recommendations.");
    }
    return null;
  },
});

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
