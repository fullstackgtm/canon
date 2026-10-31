/**
 * Homepage text for onboarding, with fallbacks for sites a plain fetch can't read
 * (bot protection, JavaScript-only pages):
 *
 *   1. direct fetch (the caller's fetcher, e.g. publicHttpGet)
 *   2. the fsgtm-homepage-fetch Cloudflare Worker (infra/fetch-worker): other IPs,
 *      title + meta description + first 1,500 characters of visible text
 *   3. ScrapingBee with JavaScript rendering (~5 credits per call)
 *
 * Each step runs only when the previous one produced under MIN_TEXT characters.
 * Steps 2-3 run only when their credentials are configured. Pass the
 * ScrapingBee key only where paid calls are allowed (paidCallsAllowed), and
 * file every billed ScrapingBee response through onScrapingBee.
 */
export const MIN_TEXT = 200;

/** Hobby plan, $19 for 75,000 credits: the highest per-credit price, so the ledger never undercounts. */
export const SCRAPINGBEE_MICRO_PER_CREDIT = 253;
const SCRAPINGBEE_JS_CREDITS = 5;

// Same extraction as icpDerive's websiteText. Not imported: icpDerive pulls in Node-only
// modules, and every file under convex/ is bundled for the default (non-Node) runtime.
function websiteText(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

export type Page = { text: string; finalUrl: string; via: "direct" | "worker" | "scrapingbee" };

export async function fetchHomepage(
  domain: string,
  deps: {
    direct: (url: string) => Promise<{ text: string; finalUrl: string } | null>;
    fetch?: typeof fetch;
    workerUrl?: string;
    workerToken?: string;
    scrapingBeeKey?: string;
    /** Called for each billed ScrapingBee response, readable or not. */
    onScrapingBee?: (call: { costMicro: number; hit: boolean }) => Promise<unknown>;
  },
): Promise<Page | null> {
  const f = deps.fetch ?? fetch;
  const url = `https://${domain}/`;
  const readable = (html: string) => websiteText(html).length >= MIN_TEXT;

  const direct = await deps.direct(url).catch(() => null);
  if (direct && readable(direct.text)) return { ...direct, via: "direct" };

  if (deps.workerToken) {
    try {
      const r = await f(deps.workerUrl ?? "https://fsgtm-homepage-fetch.ryan-ad7.workers.dev", {
        method: "POST",
        headers: { authorization: `Bearer ${deps.workerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ domains: [domain] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) {
        const [x] = ((await r.json()) as { results: Array<{ title: string; description: string; text: string; finalUrl: string | null; blocked: boolean }> }).results;
        const text = [x?.title, x?.description, x?.text].filter(Boolean).join("\n");
        if (x && !x.blocked && readable(text)) return { text, finalUrl: x.finalUrl ?? url, via: "worker" };
      }
    } catch {
      // fall through
    }
  }

  if (deps.scrapingBeeKey) {
    try {
      const u = new URL("https://app.scrapingbee.com/api/v1/");
      u.searchParams.set("api_key", deps.scrapingBeeKey);
      u.searchParams.set("url", url);
      u.searchParams.set("render_js", "true");
      const r = await f(u, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) {
        const html = await r.text();
        const credits = Number(r.headers.get("spb-cost")) || SCRAPINGBEE_JS_CREDITS;
        await deps.onScrapingBee?.({ costMicro: credits * SCRAPINGBEE_MICRO_PER_CREDIT, hit: readable(html) });
        if (readable(html)) return { text: html, finalUrl: r.headers.get("spb-resolved-url") ?? url, via: "scrapingbee" };
      }
    } catch {
      // fall through
    }
  }
  return direct ? { ...direct, via: "direct" } : null;
}
