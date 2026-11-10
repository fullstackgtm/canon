/**
 * Growth signals from an account's own website, for the scheduled signal check (convex/signalActions.ts):
 *
 *   site    the sitemap's newest <lastmod>: the site changed on that date
 *   blog    posts in the site's RSS or Atom feed: one signal per recent post
 *   social  Instagram, TikTok, LinkedIn, YouTube and X profiles the homepage links to
 *
 * Every signal quotes the page it came from verbatim. No key, no cost: a handful of plain GETs per account.
 * Pure and free of Node imports: the caller passes the fetcher (publicHttpGet, with its SSRF guard).
 */
import type { Bucket, Signal } from "./observations";

/** A fetched page: null when the request failed without an answer (network error, timeout, refused). */
export type WebGet = (url: string) => Promise<{ status: number; text: string; finalUrl: string } | null>;

export type WebsiteSignal = { signal: Extract<Signal, { bucket: "site" | "blog" | "social" }>; occurredAt?: number };

/** What one read found, and which buckets it can vouch for: a bucket whose source failed to answer is left out. */
export type WebsiteRead = { signals: WebsiteSignal[]; buckets: Bucket[] };

const DAY_MS = 86_400_000;
/** Older site changes and posts are not signals. */
export const WEBSITE_WINDOW_DAYS = 90;
/** Posts kept per account, newest first. */
const MAX_POSTS = 10;
/** Feed URLs tried when the homepage names none. */
const FEED_GUESSES = ["/feed", "/rss.xml", "/blog/rss.xml"];

const decode = (text: string) => text
  .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1];
const attr = (el: string, name: string) => el.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((x) => x !== undefined);
const absolute = (href: string, base: string) => {
  try {
    const url = new URL(decode(href), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The newest <lastmod> in a sitemap or sitemap index, not in the future, with the entry it came from. */
export function newestSitemapChange(xml: string, now: number): { at: number; entry: string } | null {
  let best: { at: number; entry: string } | null = null;
  for (const [entry] of xml.matchAll(/<(url|sitemap)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    const lastmod = tag(entry, "lastmod");
    const at = lastmod ? Date.parse(lastmod.trim()) : NaN;
    if (!Number.isFinite(at) || at > now + DAY_MS) continue;
    if (!best || at > best.at) best = { at, entry };
  }
  return best;
}

/**
 * A feed's posts, newest first: RSS <item>s or Atom <entry>s with a title, a link and a date. `title` is for
 * display; `raw` is the title exactly as the feed has it (inside any CDATA), the verbatim quote.
 */
export function feedPosts(xml: string, base: string): Array<{ title: string; raw: string; url: string; at: number }> {
  const posts: Array<{ title: string; raw: string; url: string; at: number }> = [];
  for (const [item] of xml.matchAll(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    const raw = (tag(item, "title") ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
    const title = decode(raw);
    const atomLink = [...item.matchAll(/<link\b[^>]*>/gi)].map(([el]) => el).find((el) => attr(el, "href") && (attr(el, "rel") ?? "alternate") === "alternate");
    const href = atomLink ? attr(atomLink, "href") : tag(item, "link");
    const url = href ? absolute(href.trim(), base) : null;
    const date = tag(item, "pubDate") ?? tag(item, "published") ?? tag(item, "updated") ?? tag(item, "dc:date");
    const at = date ? Date.parse(decode(date)) : NaN;
    if (title && url && Number.isFinite(at)) posts.push({ title, raw, url, at });
  }
  return posts.sort((a, b) => b.at - a.at);
}

/** Feed URLs the page declares (`<link rel="alternate" type="application/rss+xml">`), absolute. */
export function declaredFeeds(html: string, base: string): string[] {
  const out: string[] = [];
  for (const [el] of html.matchAll(/<link\b[^>]*>/gi)) {
    const type = attr(el, "type")?.toLowerCase() ?? "";
    const href = attr(el, "href");
    if (/\balternate\b/i.test(attr(el, "rel") ?? "") && /^application\/(rss|atom)\+xml$/.test(type) && href && !/comments/i.test(href)) {
      const url = absolute(href, base);
      if (url) out.push(url);
    }
  }
  return [...new Set(out)];
}

const NETWORKS: Array<{ network: string; label: string; host: RegExp; path: RegExp }> = [
  { network: "instagram", label: "Instagram", host: /(^|\.)instagram\.com$/, path: /^\/(?!p\/|reel\/|explore\/|accounts\/)[\w.]+\/?$/ },
  { network: "tiktok", label: "TikTok", host: /(^|\.)tiktok\.com$/, path: /^\/@[\w.-]+\/?$/ },
  { network: "linkedin", label: "LinkedIn", host: /(^|\.)linkedin\.com$/, path: /^\/(company|school|showcase)\/[^/]+\/?$/ },
  { network: "youtube", label: "YouTube", host: /(^|\.)youtube\.com$/, path: /^\/(@[\w.-]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+)\/?$/ },
  { network: "x", label: "X", host: /(^|\.)(x|twitter)\.com$/, path: /^\/(?!intent\/|share|home\b|search\b)\w{1,15}\/?$/ },
];

/** The first profile per network the page links to. A share button or a single post is not a profile. */
export function socialProfiles(html: string, base: string): Array<{ network: string; label: string; href: string; url: string }> {
  const found = new Map<string, { network: string; label: string; href: string; url: string }>();
  for (const [el] of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(el, "href");
    const url = href ? absolute(href, base) : null;
    if (!href || !url) continue;
    const { hostname, pathname } = new URL(url);
    const net = NETWORKS.find((n) => n.host.test(hostname.toLowerCase()) && n.path.test(pathname));
    if (net && !found.has(net.network)) found.set(net.network, { network: net.network, label: net.label, href, url });
  }
  return [...found.values()];
}

const ok = (page: { status: number } | null) => page !== null && page.status >= 200 && page.status < 300;
/** A definite answer that there is nothing here, as opposed to a failure that says nothing. */
const absent = (page: { status: number } | null) => page !== null && (page.status === 404 || page.status === 410 || ok(page));

async function readSitemap(domain: string, get: WebGet, now: number): Promise<{ signals: WebsiteSignal[]; covered: boolean }> {
  const url = `https://${domain}/sitemap.xml`;
  const page = await get(url);
  if (!ok(page)) return { signals: [], covered: absent(page) };
  const newest = newestSitemapChange(page!.text, now);
  if (!newest || newest.at < now - WEBSITE_WINDOW_DAYS * DAY_MS) return { signals: [], covered: true };
  const quote = newest.entry.trim().slice(0, 400);
  return { signals: [{ signal: { bucket: "site", trigger: `site updated: ${isoDay(newest.at)}`, quote, url: page!.finalUrl }, occurredAt: newest.at }], covered: true };
}

async function readFeed(candidates: string[], get: WebGet, now: number): Promise<{ signals: WebsiteSignal[]; covered: boolean }> {
  let covered = true;
  for (const url of candidates) {
    const page = await get(url);
    if (!absent(page)) covered = false;
    if (!ok(page) || !/<(rss|feed)\b/i.test(page!.text.slice(0, 2_000))) continue;
    const posts = feedPosts(page!.text, page!.finalUrl).filter((p) => p.at >= now - WEBSITE_WINDOW_DAYS * DAY_MS && p.at <= now + DAY_MS);
    const signals = posts.map((p): WebsiteSignal => ({ signal: { bucket: "blog", trigger: `blog: ${p.title.slice(0, 120)}`, quote: p.raw, url: p.url }, occurredAt: p.at }))
      // A trigger is a signal's identity: two posts that share one are one signal, the newest.
      .filter((s, i, all) => all.findIndex((o) => o.signal.trigger === s.signal.trigger) === i);
    return { covered: true, signals: signals.slice(0, MAX_POSTS) };
  }
  return { signals: [], covered };
}

/** Read one account's website. Each bucket is vouched for only when its source answered. */
export async function readWebsite(domain: string, get: WebGet, now: number): Promise<WebsiteRead> {
  const home = await get(`https://${domain}/`);
  const homeOk = ok(home) ? home! : null;
  const feeds = homeOk ? declaredFeeds(homeOk.text, homeOk.finalUrl) : [];
  const guesses = FEED_GUESSES.map((path) => `https://${domain}${path}`);
  const [site, blog] = await Promise.all([
    readSitemap(domain, get, now),
    // With no homepage, a feed found by guessing still counts, but no feed found proves nothing.
    readFeed(feeds.length ? feeds.slice(0, 2) : guesses, get, now).then((r) => (homeOk || r.signals.length ? r : { ...r, covered: false })),
  ]);
  const social: WebsiteSignal[] = homeOk
    ? socialProfiles(homeOk.text, homeOk.finalUrl).map((p) => ({ signal: { bucket: "social", trigger: `social: ${p.network}`, quote: p.href, url: p.url } }))
    : [];
  const buckets: Bucket[] = [...(site.covered ? ["site" as const] : []), ...(blog.covered ? ["blog" as const] : []), ...(homeOk ? ["social" as const] : [])];
  return { signals: [...site.signals, ...blog.signals, ...social], buckets };
}
