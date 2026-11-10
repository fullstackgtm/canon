// GENERATED from engine/src/portable/websiteSources.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script. Apache-2.0, as engine/LICENSE.
export function normalizeCompanyWebsite(raw: string): { domain: string; url: string } {
  const candidate = raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error(`icp derive: "${raw}" is not a valid company website.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("icp derive supports only public HTTP websites.");
  const domain = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!domain.includes(".")) throw new Error(`icp derive: "${raw}" is not a public company domain.`);
  return { domain, url: `https://${domain}/` };
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", nbsp: " ", lt: "<", gt: ">", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#")) {
      const point = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return lower === "amp" ? "&" : NAMED_ENTITIES[lower] ?? entity;
  });
}

export function websiteText(html: string): string {
  return decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** The page's title and meta descriptions, which `websiteText` drops with the tags: often a thin homepage's only prose. */
export function websiteMeta(html: string): string {
  const head = html.slice(0, 200_000);
  const found: string[] = [];
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(?:name|property)\s*=\s*["'](?:description|og:description|og:title|twitter:description)["']/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
    const text = decodeEntities(content?.[1] ?? content?.[2] ?? "").replace(/\s+/g, " ").trim();
    if (text && !found.includes(text)) found.push(text);
  }
  return found.join(" ");
}

/** Pages a homepage links to that say what the company sells and to whom. */
const KEY_PAGE = /about|product|solution|service|business|platform|pricing|customer|feature|enterprise|industr|use-?case|how-it-works|why|advertis|\bads\b|partners?\b/i;
const SKIP_PAGE = /log-?in|sign-?(?:in|up)|register|account|privacy|terms|legal|cookie|polic|career|jobs|press|status|support|help|contact|download|\.(?:pdf|png|jpe?g|svg|gif|zip|xml)$/i;

/**
 * Up to `max` same-site pages the homepage links to that likely describe the offer: about, products,
 * solutions, pricing, customers. Subdomains of the domain count as the same site (ads.google.com).
 */
export function keyPageLinks(html: string, baseUrl: string, domain: string, max = 4): string[] {
  const scored = new Map<string, number>();
  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try { url = new URL(decodeEntities(match[1]), baseUrl); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if ((url.protocol !== "https:" && url.protocol !== "http:") || (host !== domain && !host.endsWith(`.${domain}`))) continue;
    url.hash = "";
    const path = url.pathname;
    const label = websiteText(match[2]).slice(0, 80);
    // The homepage itself, not a subdomain's root (ads.example.com/ is a product).
    if (host === domain && path === "/" && !url.search) continue;
    if (SKIP_PAGE.test(path) || SKIP_PAGE.test(url.hostname.split(".")[0]) || !(KEY_PAGE.test(path) || KEY_PAGE.test(label))) continue;
    const href = url.toString();
    // Shallow pages first: /pricing over /blog/2024/why-we-changed-pricing.
    const score = path.split("/").filter(Boolean).length + (url.search ? 1 : 0);
    if (!scored.has(href) || score < scored.get(href)!) scored.set(href, score);
  }
  return [...scored].sort((a, b) => a[1] - b[1]).slice(0, max).map(([href]) => href);
}

/** Below this much readable text across every source there is nothing to derive an ICP from. */
export const MIN_SOURCE_CHARS = 200;
export const PAGE_CHARS = 10_000;

