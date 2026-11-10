import { z } from "zod";
import { canonIndustry } from "../../../modules/kernel/industries.ts";
import { htmlText } from "../research/agentLoop.ts";
import type { SerpRow } from "../research/webSearch.ts";
import { companyRootDomain } from "./siteExtract.ts";
import { catalogAllowsFetch, SOURCE_KINDS, type SourceKind } from "./sourceCatalog.ts";

export type Seed = { domain: string; name: string };
export type SourceFacts = { key: string; url: string; title: string; kind: SourceKind; listedCount?: number; filterable?: boolean; exportable?: boolean; markets: string[] };
export type SourceMatch = { sourceKey: string; seedDomain: string; quote: string; query: string };
const classificationSchema = z.object({
  listsCompanies: z.literal(true), title: z.string().trim().min(1).max(200), kind: z.enum(SOURCE_KINDS),
  listedCount: z.number().finite().gte(2).transform(Math.round).optional(),
  filterable: z.boolean().optional(), exportable: z.boolean().optional(),
  markets: z.array(z.string()).default([]).transform((values) => [...new Set(values.flatMap((value) => { const key = canonIndustry(value); return key ? [key] : []; }))]),
});
export type SourceClassification = z.infer<typeof classificationSchema>;
export const SEARCH_REFUSAL = "Website searches run on dev and production. Paid searches are switched off on this deployment.";
export const SOURCE_MAX_AGE = 30 * 24 * 60 * 60_000;
export function seedQueries(seed: Seed): string[] {
  const name = seed.name.replace(/"/g, "");
  return [`"${name}" -site:${seed.domain}`, `"${seed.domain}" -site:${seed.domain}`, `"${name}" (directory OR "member list" OR "vendor list" OR "contractor list")`];
}
export function sourceKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.search = ""; url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch { return null; }
}
export function eligibleSource(url: string, seeds: Seed[]): boolean {
  const key = sourceKey(url), root = key && companyRootDomain(key);
  return Boolean(key && root && !seeds.some((s) => s.domain === root) && !/^(?:linkedin|facebook|instagram|twitter|x|tiktok|youtube|reddit|google|bing|yahoo|duckduckgo)\./.test(root) && catalogAllowsFetch(key));
}
export function classifySource(raw: unknown): SourceClassification | null {
  const parsed = classificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function rankSources<T extends { seedHits: number; title: string }>(sources: T[]): T[] {
  return [...sources].sort((a, b) => b.seedHits - a.seedHits || a.title.localeCompare(b.title));
}
export type SourceSearchDeps = {
  paid: boolean; now: number;
  serp(query: string): Promise<SerpRow[]>;
  cached(key: string): Promise<(SourceFacts & { lastSeenAt: number }) | null>;
  fetchPage(url: string): Promise<{ text: string; finalUrl: string } | null>;
  model(text: string): Promise<unknown>;
  keep(source: SourceFacts, match: SourceMatch): Promise<void>;
};
export async function searchMarketSources(seeds: Seed[], deps: SourceSearchDeps): Promise<{ status: "done" | "refused"; reason?: string }> {
  if (!deps.paid) return { status: "refused", reason: SEARCH_REFUSAL };
  const pages = new Map<string, { source: SourceFacts; text: string } | null>();
  let read = 0;
  for (const seed of seeds.slice(0, 10)) {
    const matched = new Set<string>();
    for (const query of seedQueries(seed)) {
      const rows = await deps.serp(query);
      for (const row of rows.slice(0, 5)) {
        const key = sourceKey(row.url);
        if (!key || matched.has(key) || !eligibleSource(row.url, seeds)) continue;
        if (!pages.has(key)) {
          const cached = await deps.cached(key);
          pages.set(key, null);
          if (++read > 30) continue;
          const page = await deps.fetchPage(row.url).catch(() => null);
          if (!page || !eligibleSource(page.finalUrl, seeds)) continue;
          const text = htmlText(page.text).slice(0, 24_000);
          if (!seeds.some((s) => verbatimMention(text, s))) continue;
          if (cached && deps.now - cached.lastSeenAt < SOURCE_MAX_AGE) {
            const source = { key: cached.key, url: cached.url, title: cached.title, kind: cached.kind, markets: cached.markets,
              ...(cached.listedCount !== undefined ? { listedCount: cached.listedCount } : {}),
              ...(cached.filterable !== undefined ? { filterable: cached.filterable } : {}),
              ...(cached.exportable !== undefined ? { exportable: cached.exportable } : {}),
            };
            pages.set(key, { source, text });
          } else {
            const classification = classifySource(await deps.model(text).catch(() => null));
            if (!classification) continue;
            const { title, kind, markets, listedCount, filterable, exportable } = classification;
            pages.set(key, { source: { title, kind, markets, key, url: key,
              ...(listedCount !== undefined ? { listedCount } : {}),
              ...(filterable !== undefined ? { filterable } : {}),
              ...(exportable !== undefined ? { exportable } : {}),
            }, text });
          }
        }
        const page = pages.get(key);
        if (!page) continue;
        const quote = verbatimMention(page.text, seed);
        if (!quote) continue;
        matched.add(key);
        await deps.keep(page.source, { sourceKey: key, seedDomain: seed.domain, quote, query });
      }
    }
  }
  return { status: "done" };
}
function verbatimMention(text: string, seed: Seed): string | null {
  const at = [text.indexOf(seed.name), text.indexOf(seed.domain)].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return null;
  const sentence = text.lastIndexOf(". ", at);
  const start = Math.max(0, sentence < 0 ? 0 : sentence + 2, at - 160);
  return text.slice(start, Math.min(text.length, at + Math.max(seed.name.length, seed.domain.length) + 200));
}
