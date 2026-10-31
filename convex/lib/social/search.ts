"use node";

import { publicHttpGet } from "../../../engine/src/publicHttp.ts";
import { domainForName } from "../companyenrich";
import { discoverBoard } from "../signals/boards";
import { paidCallsAllowed, tregCall, TregRefusal, type TregReceipt } from "../treg";
import { socialSearchRequest, SOCIAL_MAX_USD, SOCIAL_TEXT_MAX, type SocialRow, type SocialSearch, type SocialSource } from "../../../modules/kernel/social.ts";
import { socialFixtures } from "./fixtures";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const date = (v: unknown) => { const d = typeof v === "number" ? new Date(v * 1000) : new Date(str(v)); return Number.isFinite(d.getTime()) ? d.toISOString() : ""; };
const url = (v: unknown) => { try { const u = new URL(str(v)); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch { return ""; } };

function row(source: SocialSource, p: Record<string, unknown>): SocialRow | null {
  const authorInfo = obj(p.authorInfo), author = obj(p.author), company = obj(p.company), legacy = obj(p.legacy);
  const id = str(p.id ?? p.objectID ?? p.rest_id ?? legacy.id_str);
  const handle = str(p.authorUsername ?? authorInfo.name ?? author.name ?? p.author);
  const link = source === "hn" && id ? `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}` : url(p.permalink ? `https://www.reddit.com${str(p.permalink)}` : p.url ?? p.postUrl);
  const text = [p.title, p.text ?? p.selftext ?? p.descriptionText ?? p.story_text ?? p.comment_text ?? legacy.full_text].map(str).filter(Boolean).join("\n").slice(0, SOCIAL_TEXT_MAX);
  if (!id || !link || !text) return null;
  return { id: `${source}:${id}`, source, url: link, author: str(p.authorName ?? company.name) || handle, authorUrl: url(p.authorUrl ?? company.linkedinUrl) || (handle && source === "reddit" ? `https://www.reddit.com/user/${encodeURIComponent(handle)}` : handle && source === "x" ? `https://x.com/${encodeURIComponent(handle)}` : handle && source === "hn" ? `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}` : ""), postedAt: date(p.createdUtc ?? p.created_at ?? p.createdAt ?? p.created_utc ?? legacy.created_at), text };
}

export function socialRows(source: SocialSource, body: unknown, limit: number): SocialRow[] {
  // Reddit's app response and routed X's provider-native posts have nested wrappers.
  const rows = new Map<string, SocialRow>();
  let visited = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 20 || ++visited > 20000 || rows.size >= limit) return;
    if (Array.isArray(v)) { for (const item of v) walk(item, depth + 1); return; }
    if (!v || typeof v !== "object") return;
    const p = obj(v), found = row(source, p);
    if (found) { rows.set(found.id, found); return; }
    for (const child of Object.values(p)) walk(child, depth + 1);
  };
  walk(body, 0);
  return [...rows.values()];
}

const guardedFetch: typeof fetch = async (input) => {
  const res = await publicHttpGet(String(input), { timeoutMs: 15000, maxRedirects: 3, maxBytes: 2_000_000 });
  return new Response(new TextDecoder().decode(res.body), { status: res.status });
};

export async function searchSocial(raw: Record<string, unknown>, opts: { fake: boolean; token?: string; orgId: string; fetchImpl?: typeof fetch; onPaid?: (res: TregReceipt) => Promise<void> }): Promise<SocialRow[]> {
  const request = socialSearchRequest(raw);
  const { source, query, limit } = request;
  const fetchImpl = opts.fetchImpl ?? guardedFetch;
  if (opts.fake) {
    if (source === "jobs") return companyJobs(request, async () => Response.json(socialFixtures.jobs), opts);
    return socialRows(source, socialFixtures[source], limit);
  }
  if (source === "hn") {
    const res = await fetchImpl(`https://hn.algolia.com/api/v1/search?${new URLSearchParams({ query, hitsPerPage: String(limit) })}`);
    if (!res.ok) throw new Error(`Hacker News search failed (${res.status}).`);
    return socialRows(source, await res.json(), limit);
  }
  if (source === "jobs") return companyJobs(request, fetchImpl, opts);
  if (!paidCallsAllowed()) throw new TregRefusal(402, "paid_calls_off", "Paid social searches are switched off on this deployment.", null);
  if (!opts.token) throw new Error("Social search requires the treg token.");
  const endpoint = { reddit: "tikhub.x.reddit-app-fetch-dynamic-search", x: "treg.x.search.posts", linkedin_posts: "anyapi.linkedin.search.posts", linkedin_jobs: "anyapi.linkedin.search.jobs.full" }[source];
  const res = await tregCall({ token: opts.token, endpoint, meta: { customer: opts.orgId, feature: "pull" }, maxCostUsd: SOCIAL_MAX_USD[source], baseUrl: process.env.TREG_BASE_URL, onResponse: opts.onPaid,
    ...(source === "reddit" ? { query: { query, search_type: "post", sort: "RELEVANCE", time_range: "all", safe_search: "strict", allow_nsfw: "0", need_format: "false" } } : { body: source === "x" ? { q: query } : { query, ...(source === "linkedin_jobs" ? { limit } : {}) } }),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (res.status < 200 || res.status >= 300 || obj(res.body).code && obj(res.body).code !== 200) throw new Error(`Social provider failed (${res.status}).`);
  return socialRows(source, res.body, limit);
}

async function companyJobs(request: SocialSearch, fetchImpl: typeof fetch, opts: { fake: boolean; token?: string; orgId: string; fetchImpl?: typeof fetch }): Promise<SocialRow[]> {
  const name = request.query.trim();
  const isDomain = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(name);
  const domain = isDomain ? name.toLowerCase() : opts.fake ? "acme.test" : opts.token ? await domainForName({
    token: opts.token, name, meta: { customer: opts.orgId, feature: "pull" }, baseUrl: process.env.TREG_BASE_URL, fetchImpl: opts.fetchImpl,
  }) : null;
  if (!domain) throw new Error("Could not resolve that company name. Supply its company domain to search job boards.");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) throw new Error("Company jobs need a company domain or name.");
  const result = await discoverBoard(domain, isDomain ? undefined : name, fetchImpl);
  if (!result.hit && result.transient) throw new Error("The company's job boards could not be read. Retry later.");
  return (result.hit?.jobs ?? []).slice(0, request.limit).map((j) => ({ id: `jobs:${result.hit!.source}:${result.hit!.token}:${j.firstSeenKey}`, source: "jobs", url: j.url, author: name, authorUrl: `https://${domain}/`, postedAt: j.postedAt ?? "", text: `${j.title}\n${j.description ?? j.jdSnippet}`.slice(0, SOCIAL_TEXT_MAX) }));
}
