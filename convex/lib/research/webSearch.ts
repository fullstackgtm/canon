/**
 * Web search for research agents (agentLoop.ts WebSearch): ChatGPT's own web
 * search first, on the signed-in user's plan, then Google through treg only
 * when ChatGPT finds no page Canon can read (docs/research-agent-patterns.md).
 *
 * ChatGPT search returns pages, which are fetched and read like any other.
 * Google returns its own snippet of each result, which counts as evidence like
 * a page (Ryan's call, 2026-10-10): it is how a LinkedIn headline, which
 * refuses our fetches, becomes quotable. Node-free; the network calls are
 * injected.
 */
import { SEARCH_READS, type FetchedPage, type PageFetcher, type PageLink, type WebSearch } from "./agentLoop.ts";

/** Sites that refuse our fetches: their results are only useful as snippets. */
const UNREADABLE = /(?:^|\.)(?:linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com)$/i;
export const unreadable = (url: string) => {
  try { return UNREADABLE.test(new URL(url).hostname); } catch { return true; }
};

export type SearchHit = { url: string; title: string };
export type SerpRow = { url: string; title: string; snippet: string };

/**
 * Organic rows of a treg Google SERP body, whose row shape differs per provider. treg wraps them as
 * `{ output: { results: [...] } }` (measured 2026-10-13, served by crawl4ai); a bare `{ results }` is read too.
 */
export function serpRows(body: unknown): SerpRow[] {
  const inner = body && typeof body === "object" && "output" in body ? (body as { output: unknown }).output : body;
  const rows = inner && typeof inner === "object" && Array.isArray((inner as { results?: unknown }).results) ? (inner as { results: unknown[] }).results : [];
  const out: SerpRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const url = [o.link, o.url, o.href].find((x) => typeof x === "string" && /^https?:\/\//i.test(x)) as string | undefined;
    const snippet = [o.snippet, o.description, o.content, o.text].find((x) => typeof x === "string" && x.trim()) as string | undefined;
    if (url) out.push({ url, title: typeof o.title === "string" ? o.title : "", snippet: snippet?.trim() ?? "" });
  }
  return out;
}

export function makeWebSearch(deps: {
  fetchPage: PageFetcher;
  /** ChatGPT web search; absent without a ChatGPT sign-in. */
  chatgpt?: (query: string) => Promise<SearchHit[]>;
  /** Google results through treg; absent where paid calls are off. */
  google?: (query: string) => Promise<SerpRow[]>;
}): WebSearch {
  return async (query) => {
    let calls = 0;
    const links: PageLink[] = [];
    if (deps.chatgpt) {
      calls++;
      const hits = await deps.chatgpt(query).catch(() => [] as SearchHit[]);
      const readable = hits.filter((h) => !unreadable(h.url));
      const tried = readable.slice(0, SEARCH_READS);
      const pages = (await Promise.all(tried.map((h) => deps.fetchPage(h.url).catch(() => null)))).filter((p): p is FetchedPage => !!p?.text);
      links.push(...readable.slice(SEARCH_READS).map((h) => ({ href: h.url, text: h.title.slice(0, 80) })));
      if (pages.length) return { pages, links, calls };
    }
    if (deps.google) {
      // A result can come back more than once (seen from treg, 2026-10-13): one row per URL.
      const rows = dedupeByUrl(await deps.google(query).catch(() => [] as SerpRow[]));
      // The top readable results are read in full (a ~250-character snippet rarely settles a question); the
      // rest, and LinkedIn and the like that refuse fetches, count by their snippet.
      const tried = rows.filter((r) => !unreadable(r.url)).slice(0, SEARCH_READS);
      const got = await Promise.all(tried.map((r) => deps.fetchPage(r.url).catch(() => null)));
      // By the result's own URL: a page that redirected is still that result.
      const full = new Set(tried.filter((_, i) => got[i]?.text).map((r) => r.url));
      const pages = [
        ...got.filter((p): p is FetchedPage => !!p?.text),
        ...rows.filter((r) => r.snippet && !full.has(r.url)).map((r): FetchedPage => ({ url: r.url, text: `${r.title} ${r.snippet}`.trim(), links: [], snippet: true })),
      ];
      links.push(...rows.filter((r) => !unreadable(r.url) && !full.has(r.url)).map((r) => ({ href: r.url, text: r.title.slice(0, 80) })));
      return { pages, links, calls };
    }
    return { pages: [], links, calls };
  };
}

function dedupeByUrl(rows: readonly SerpRow[]): SerpRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}
