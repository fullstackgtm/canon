"use node";
import { siteUrl } from "./lib/siteUrl";

/**
 * Homepage text for TAM explorer scoring (convex/tam.ts runJob). Cached in
 * tamSiteTexts, so a page is fetched once however many segments use it.
 * Unreadable pages cache as "" and are scored on firmographics alone.
 * Direct fetch, then the fetch Worker; ScrapingBee is reserved for onboarding.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { publicHttpGet } from "../engine/src/publicHttp.ts";
import { fetchHomepage, MIN_TEXT } from "./lib/homepageFetch";
import { SITE_TEXT_CHARS } from "./lib/tam/jevSegments";

const direct = (url: string) =>
  publicHttpGet(url, {
    timeoutMs: 10_000, maxRedirects: 4, maxBytes: 3_000_000,
    headers: { "User-Agent": `fullstackgtm-tam/1 (+${siteUrl()})` },
  }).then((r) => (r.status >= 200 && r.status < 300 ? { text: new TextDecoder().decode(r.body), finalUrl: r.finalUrl } : null)).catch(() => null);

function visibleText(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

const CONCURRENCY = 8;

export const homepages = internalAction({
  args: { domains: v.array(v.string()) },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const domains = [...new Set(args.domains)].slice(0, 100);
    const cached: Record<string, string> = await ctx.runQuery(internal.tam.siteTexts, { domains });
    const missing = domains.filter((d) => !(d in cached));
    const fetched: Array<{ domain: string; text: string }> = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
      while (next < missing.length) {
        const domain = missing[next++];
        const page = await fetchHomepage(domain, {
          direct,
          workerUrl: process.env.FETCH_URL,
          workerToken: process.env.FETCH_TOKEN,
          // No ScrapingBee: ~5 credits a page is too much per TAM account.
        }).catch(() => null);
        const text = page ? visibleText(page.text) : "";
        fetched.push({ domain, text: text.length >= MIN_TEXT ? text.slice(0, SITE_TEXT_CHARS) : "" });
      }
    }));
    if (fetched.length) await ctx.runMutation(internal.tam.putSiteTexts, { pages: fetched });
    const out: Record<string, string> = {};
    for (const [d, t] of Object.entries(cached)) if (t) out[d] = t;
    for (const f of fetched) if (f.text) out[f.domain] = f.text;
    return out;
  },
});
