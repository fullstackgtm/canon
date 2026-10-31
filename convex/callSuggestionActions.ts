"use node";

/**
 * Who a suggested person on personal email is (lib/calls/whoIs.ts): a few web searches on the ChatGPT plan
 * of the person whose meeting it was, then one read of what they found. ChatGPT search finds pages; a
 * LinkedIn result's title (which LinkedIn will not let us fetch) counts as a snippet, as research agents
 * treat it, and Google through treg is the fallback where paid calls are on. Canon keeps an answer only
 * when its quote names the person word for word.
 */
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, chatgptWebSearch, forcedToolCall, type LlmCallOptions } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { requireCaller } from "./records";
import { fetchPage } from "./researchAgentActions";
import { paidCallsAllowed, tregCall } from "./lib/treg";
import { serpRows, unreadable } from "./lib/research/webSearch";
import {
  atCompanyPrompt, atCompanyQueries, companyPrompt, companyQueries, COMPANY_SCHEMA, domainConfirmed, groundedAtCompany, groundedCompany,
  groundedIdentity, hintPrompt, hintsOf, transcriptSource, whoIsPrompt, whoIsQueries, WHO_IS_HINT_SCHEMA, WHO_IS_SCHEMA,
  type CompanyIdentity, type Identity, type NamedPerson, type WhoIsMeeting, type WhoIsPage, type WhoIsPerson,
} from "./lib/calls/whoIs";

/** Pages read per search, pages in all, and how long one identification may take. */
const READS_PER_QUERY = 2;
const MAX_PAGES = 8;
const WHO_IS_TIMEOUT_MS = 90_000;
/** What one Google search through treg may cost (research agents' cap). */
const GOOGLE_MAX_USD = 0.002;

export type WhoIs = (person: WhoIsPerson, meeting: WhoIsMeeting) => Promise<Identity | null>;

/** Search and read for one question: ChatGPT search's results (LinkedIn titles as snippets, up to two readable pages each), Google through treg when nothing came back. */
type Gather = (queries: readonly string[], signal: AbortSignal, seed?: WhoIsPage | null) => Promise<WhoIsPage[]>;

function gatherer(llm: LlmCallOptions, model: string, ws: string): Gather {
  const tregToken = process.env.TREG_TOKEN;
  const google = tregToken && paidCallsAllowed()
    ? async (q: string) => serpRows((await tregCall({
        token: tregToken, endpoint: "treg.google.serp.organic", body: { q }, meta: { customer: ws, feature: "meeting_people" },
        maxCostUsd: GOOGLE_MAX_USD, baseUrl: process.env.TREG_BASE_URL, timeoutMs: 20_000,
      })).body)
    : undefined;
  return async (queries, signal, seed) => {
    const pages: WhoIsPage[] = [];
    const seen = new Set<string>();
    const keep = (p: WhoIsPage | null) => {
      if (!p?.text || seen.has(p.url) || pages.length >= MAX_PAGES) return;
      seen.add(p.url);
      pages.push(p);
    };
    if (seed) keep(seed);
    for (const q of queries) {
      if (signal.aborted) break;
      const hits = llm.provider === "chatgpt" ? await chatgptWebSearch(q.slice(0, 200), model, { ...llm, signal }).catch(() => []) : [];
      for (const h of hits) if (h.title && unreadable(h.url)) keep({ url: h.url, text: h.title, snippet: true });
      const readable = hits.filter((h) => !unreadable(h.url) && !seen.has(h.url)).slice(0, READS_PER_QUERY);
      for (const page of await Promise.all(readable.map((h) => fetchPage(h.url).catch(() => null)))) if (page) keep({ url: page.url, text: page.text });
    }
    if (pages.every((pg) => pg.transcript) && google) {
      for (const q of queries.slice(0, 2)) {
        for (const row of await google(q).catch(() => [])) if (row.snippet) keep({ url: row.url, text: `${row.title} ${row.snippet}`.trim(), snippet: true });
      }
    }
    return pages;
  };
}

/** Run `work` under the research deadline; a failure is a "not found" (logged), never an error for the caller. */
async function underDeadline<T>(label: string, work: (signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHO_IS_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } catch (cause) {
    console.log(`${label}: failed (${cause instanceof Error ? cause.message.slice(0, 160) : "error"})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a company's website is its own: a searched page sits on it, or its homepage names it. */
async function confirmedSite(identity: { companyName: string; companyDomain: string }, pages: readonly WhoIsPage[]): Promise<boolean> {
  if (domainConfirmed(identity, pages, null)) return true;
  const home = await fetchPage(`https://${identity.companyDomain}/`).catch(() => null);
  return domainConfirmed(identity, pages, home?.text ?? null);
}

/** An identifier on `llm` (the meeting owner's ChatGPT plan), for one workspace. */
export function whoIsResearcher(llm: LlmCallOptions, ws: string): WhoIs {
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];
  const gather = gatherer(llm, model, ws);
  return (person, meeting) => underDeadline("who-is", async (signal) => {
    // The meeting first: what the person said there is a source, and the companies it ties them to steer the searches.
    const said = transcriptSource(person, meeting);
    const hints = said ? hintsOf(await forcedToolCall(hintPrompt(person, said.text), "companies", WHO_IS_HINT_SCHEMA, model, llm).catch(() => null)) : [];
    const pages = await gather(whoIsQueries(person, meeting, hints), signal, said);
    if (!pages.length) {
      console.log("who-is: no sources");
      return null;
    }
    const raw = await forcedToolCall(whoIsPrompt(person, meeting, pages), "who_is", WHO_IS_SCHEMA, model, llm);
    const found = groundedIdentity(raw, person, pages);
    if (!found) {
      console.log(`who-is: ${(raw as { found?: unknown } | null)?.found === true ? "answer failed the quote check" : "model found no match"} (${pages.length} sources)`);
      return null;
    }
    if (!(await confirmedSite(found, pages))) {
      console.log("who-is: employer's website not confirmed");
      return null;
    }
    return found;
  });
}

/** A company the meeting named, and the people it named there: who they are, from public sources. */
export type MentionResearch = {
  company: (name: string, hint: string, said: string) => Promise<CompanyIdentity | null>;
  person: (name: string, company: CompanyIdentity, said: string) => Promise<NamedPerson | null>;
};

export function mentionResearcher(llm: LlmCallOptions, ws: string): MentionResearch {
  const model = llm.model ?? DEFAULT_MODELS[llm.provider];
  const gather = gatherer(llm, model, ws);
  return {
    company: (name, hint, said) => underDeadline("what-is", async (signal) => {
      const pages = await gather(companyQueries(name, hint), signal);
      if (!pages.length) return null;
      const found = groundedCompany(await forcedToolCall(companyPrompt(name, hint, said, pages), "company", COMPANY_SCHEMA, model, llm), name, pages);
      if (!found) {
        console.log(`what-is: no confirmed company (${pages.length} sources)`);
        return null;
      }
      return (await confirmedSite(found, pages)) ? found : null;
    }),
    person: (name, company, said) => underDeadline("who-at", async (signal) => {
      const pages = await gather(atCompanyQueries(name, company.companyName), signal);
      if (!pages.length) return null;
      return groundedAtCompany(await forcedToolCall(atCompanyPrompt(name, company, said, pages), "who_is", WHO_IS_SCHEMA, model, llm), name, company, pages);
    }),
  };
}

/** "Find who this is" on a suggested person: research them now, on the caller's ChatGPT plan. */
export const identify = action({
  args: { id: v.id("callSuggestions") },
  handler: async (ctx: ActionCtx, args): Promise<{ found: boolean; companyName?: string }> => {
    const caller = await requireCaller(ctx);
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const target = await ctx.runQuery(internal.callSuggestions.forIdentify, { orgId, userId, id: args.id });
    if (!target) throw new ConvexError("This suggestion is gone or already handled");
    const llm = await resolveLlm(ctx, userId);
    if (!llm) throw new ConvexError("Connect ChatGPT in Integrations, ChatGPT to research people");
    const identity = await whoIsResearcher(llm, caller.orgId)(target.person, target.meeting);
    await ctx.runMutation(internal.callSuggestions.setIdentity, { orgId, id: args.id, identity });
    return identity ? { found: true, companyName: identity.companyName } : { found: false };
  },
});
