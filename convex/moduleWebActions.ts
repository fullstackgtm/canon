"use node";

import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { websiteText, websiteMeta } from "../modules/kernel/websiteSources.ts";
import { marketSampleRequest } from "../modules/kernel/freePopulation.ts";
import { freePopulationQuery } from "./lib/modules/freePopulation";
import { quickEnrichPage } from "./lib/quickenrich";
import { icpGeosToCountries } from "../modules/kernel/icpGeography";
import { TregRefusal } from "./lib/treg";
import { websiteSources } from "../engine/src/icpDerive.ts";
import { publicPageUrl, webPagesRequest, type WebPagesRequest } from "../modules/kernel/webPages.ts";
import { fakeModel } from "./lib/modules/ai";
import type { WebsiteSource } from "../engine/src/portable/icpDeriveContract.ts";
import { webSearchRequest, type WebSearchRequest, type WebSearchRow } from "../modules/kernel/webSearch.ts";
import { unreadable, type SearchHit } from "./lib/research/webSearch";
import { resolveLlm } from "./lib/llmResolver";
import { chatgptWebSearch, DEFAULT_MODELS } from "../engine/src/llm.ts";

async function fetchPublicPage(url: string) {
  const response = await publicHttpGet(url, { timeoutMs: 12_000, maxRedirects: 4, maxBytes: 4_000_000 });
  return response.status >= 200 && response.status < 300 ? { text: new TextDecoder().decode(response.body), finalUrl: response.finalUrl } : null;
}

export async function readWebPages(request: WebPagesRequest, fake: boolean, fetchPage?: Parameters<typeof websiteSources>[1]): Promise<WebsiteSource[]> {
  const parsed = webPagesRequest(request);
  if ("urls" in parsed && parsed.urls) {
    const rows: WebsiteSource[] = [];
    for (const url of parsed.urls) {
      if (fake) { if (!url.includes("unreadable.")) rows.push({ id: url, url, text: "Canon public-page fixture. No website was fetched and no AI ran. Regional manufacturing teams use inventory tools to manage warehouse stock and purchasing." }); continue; }
      try {
        const page = await (fetchPage ?? fetchPublicPage)(url);
        if (page) publicPageUrl(page.finalUrl);
        const text = page ? [websiteMeta(page.text), websiteText(page.text)].filter(Boolean).join(" ").slice(0, 8000) : "";
        if (text) rows.push({ id: url, url, text });
      } catch { /* An unreadable requested page contributes no evidence. */ }
    }
    return rows;
  }
  const domain = parsed.domain!;
  if (fake) {
    if (domain.startsWith("unreadable.")) throw new Error(`Could not read ${domain}. Check the domain and retry.`);
    if (domain.startsWith("thin.")) throw new Error(`${domain} exposed too little readable content.`);
    return [
      { id: "homepage", url: `https://${domain}/`, text: "Canon's public-source test fixture. No website was fetched and no AI ran. This fictional company supplies warehouse inventory tools to regional manufacturers. Its buyers manage stock, purchasing, and factory operations." },
      { id: "page-1", url: `https://${domain}/products`, text: "The test product tracks warehouse stock and purchase orders for manufacturing teams. This is fixture text for local proof only. No live website or provider was contacted. The product helps operations managers schedule replenishment." },
    ];
  }
  return websiteSources(domain, fetchPage);
}

export const pages = internalAction({
  args: { domain: v.optional(v.string()), urls: v.optional(v.array(v.string())) },
  handler: async (_ctx, request): Promise<WebsiteSource[]> => {
    try { return await readWebPages(webPagesRequest(request), fakeModel()); }
    catch (error) { throw new ConvexError(error instanceof Error ? error.message : "Website research could not read its sources."); }
  },
});

const SEARCH_PLAN_REQUIRED = "Sign in with ChatGPT to use web.search.";

export async function readWebSearch(request: WebSearchRequest, fake: boolean, deps: { search?: (query: string) => Promise<SearchHit[]>; fetchPage?: Parameters<typeof websiteSources>[1] } = {}): Promise<WebSearchRow[]> {
  const { queries } = webSearchRequest(request);
  if (fake) return queries.flatMap((query) => Array.from({ length: 3 }, (_, i) => {
    const url = `https://search.example.test/${encodeURIComponent(query)}/${i + 1}`;
    return { id: url, url, title: "Canon public-search fixture", query, text: "Regional manufacturers use inventory tools to manage warehouse stock and purchasing. Canon public-search fixture. No website was fetched, search was sent or AI ran." };
  }));
  if (!deps.search) throw new Error(SEARCH_PLAN_REQUIRED);
  const seen = new Set<string>(), rows: WebSearchRow[] = [];
  for (const [i, query] of queries.entries()) {
    const quota = rows.length + Math.ceil((12 - rows.length) / (queries.length - i));
    const hits = await deps.search(query);
    for (const hit of hits.filter((h) => !unreadable(h.url)).slice(0, 12)) {
      let url: string;
      try { url = publicPageUrl(hit.url); } catch { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const pages = await readWebPages({ urls: [url] }, false, async (url) => {
        const page = await (deps.fetchPage ?? fetchPublicPage)(url);
        return page && !unreadable(page.finalUrl) ? page : null;
      });
      if (pages[0]) rows.push({ ...pages[0], title: hit.title.slice(0, 500), query });
      if (rows.length === quota) break;
    }
  }
  return rows;
}

export const search = internalAction({
  args: { queries: v.array(v.string()), userId: v.id("users") },
  handler: async (ctx, { userId, ...request }): Promise<WebSearchRow[]> => {
    try {
      const parsed = webSearchRequest(request);
      if (fakeModel()) return await readWebSearch(parsed, true);
      const llm = await resolveLlm(ctx, userId);
      if (!llm || llm.provider !== "chatgpt") throw new Error(SEARCH_PLAN_REQUIRED);
      const signal = AbortSignal.timeout(60_000);
      return await readWebSearch(parsed, false, { search: (query) => chatgptWebSearch(query, llm.model ?? DEFAULT_MODELS.chatgpt, { ...llm, signal }) });
    } catch (error) { throw new ConvexError(error instanceof Error ? error.message : "Web search could not read its sources."); }
  },
});

export type SampleSize = { accounts: number; capped: boolean };
export async function sampleMarkets(queries: string[], options: { token?: string; paused: boolean; page: (query: string) => ReturnType<typeof quickEnrichPage> }): Promise<Array<SampleSize | undefined>> {
  const checked = marketSampleRequest({ queries });
  const out: Array<SampleSize | undefined> = checked.map(() => undefined);
  if (!options.token || options.paused) return out;
  for (let i = 0; i < checked.length; i++) {
    try {
      const page = await options.page(checked[i]);
      out[i] = { accounts: new Set(page.people.map((p) => p.company.domain?.trim().toLowerCase()).filter(Boolean)).size, capped: page.next !== null || (page.total ?? 0) > page.people.length };
    } catch (error) { if (error instanceof TregRefusal) break; }
  }
  return out;
}

export const sample = internalAction({
  args: { queries: v.array(v.string()), orgId: v.id("organizations"), userId: v.id("users"), module: v.string() },
  handler: async (ctx: ActionCtx, a): Promise<Array<Record<string, unknown>>> => {
    const fake = fakeModel();
    const token = fake ? "explicit-fake-transport" : process.env.TREG_TOKEN;
    const pacing = fake || !token ? null : await ctx.runQuery(internal.populateActions.getPacing, { provider: "quickenrich" });
    const sizes = await sampleMarkets(a.queries, { token, paused: !!pacing && pacing.pausedUntil > Date.now(), page: async (query) => {
      if (fake) return { people: [], next: null, total: 0, rateRemaining: null };
      return quickEnrichPage({ token: token!, query: freePopulationQuery(query), meta: { customer: a.orgId, feature: "module_market_sample", userId: a.userId }, baseUrl: process.env.TREG_BASE_URL, countryName: (iso) => icpGeosToCountries([iso.toLowerCase()])[0] });
    } });
    return sizes.map((size, i) => ({ id: a.queries[i], ...(size ? { size } : {}), transport: fake ? "fake" : "quickenrich" }));
  },
});
