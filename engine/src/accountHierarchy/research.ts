/**
 * Stage 2, research: what the web says about a candidate group, as cited claims. Whoever writes the research (the
 * live agent in researchAgent.ts, a person, or another tool), it passes the same two gates before the planner uses
 * it:
 *
 *   1. `checkResearch`: structure. Every claim has a citation with a URL and a quote; a divested or not-owned entity
 *      says who owns it now; an `internal:` citation names the person who vouches for it.
 *   2. `verifyResearch`: the verbatim rule (engine/src/evidence.ts). A web citation counts only when its quote is
 *      found word for word in the page it names. The page text comes from the agent's own fetches when it has them,
 *      else from a fresh fetch. A page that can't be read (403, timeout) leaves the claim unverified, never passed.
 *
 * A claim without at least one verified (or person-attested) citation produces no operation; the planner turns it
 * into a flag for a person. Enrichment vendors (ZoomInfo and the like) are leads for detection, never citations.
 *
 * Pure apart from `fetch`, which Node and the Convex runtime both provide.
 */
import { foldText, quoteFound } from "../evidence.ts";

export const ENTITY_STATUSES = ["owned", "divested", "not_owned", "sale_pending"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export type Citation = {
  /** A page URL, or `internal:<who>-<yyyy-mm-dd>` for something a person at the company knows (where it bills). */
  url: string;
  /** Copied word for word from the page. For `internal:` citations, the statement itself. */
  quote: string;
  /** Optional one-line gloss of why the quote supports the claim. */
  note?: string;
  /** Who vouches for an `internal:` citation, or who checked a page by hand that a fetch can't read. */
  attestedBy?: string;
};

export type ResearchFact = {
  /** Account field, by canonical or provider name (`BillingCountry`, `Sales_Region__c`). */
  field: string;
  value: string;
  citations: Citation[];
};

export type ResearchEntity = {
  /** The company or brand, as the sources name it. */
  name: string;
  status: EntityStatus;
  /** CRM account ids that are this entity. Empty when the CRM has no account for it. */
  accountIds: string[];
  /** Name of an intermediate parent entity in this research (Parfums Christian Dior sits under Dior). */
  parent?: string;
  /** Required for divested and not_owned: who owns it now. */
  ownerNow?: string;
  citations: Citation[];
  facts?: ResearchFact[];
};

export type GroupResearch = {
  group: string;
  ultimateParent: { name: string; accountId: string; citations: Citation[] };
  researchedAt: string;
  researchedBy: string;
  entities: ResearchEntity[];
};

export type CitationCheck = {
  url: string;
  quote: string;
  result: "verified" | "attested" | "quote_not_found" | "unreachable";
  detail?: string;
};

export type ResearchVerification = {
  checkedAt: string;
  /** Keyed by `${url}\u0000${quote}`. */
  checks: Record<string, CitationCheck>;
};

export const isInternal = (url: string) => url.startsWith("internal:");
export const citationKey = (c: Citation) => `${c.url}\u0000${c.quote}`;

/** Structural gate. Throws with every problem listed, or returns the research. */
export function checkResearch(r: GroupResearch): GroupResearch {
  const problems: string[] = [];
  const cites = (label: string, list: Citation[] | undefined) => {
    if (!list?.length) problems.push(`${label}: no citation`);
    for (const c of list ?? []) {
      if (!c.url?.trim() || !c.quote?.trim()) problems.push(`${label}: a citation needs a url and a quote`);
      else if (isInternal(c.url) && !c.attestedBy) problems.push(`${label}: internal citation ${c.url} needs attestedBy`);
      else if (!isInternal(c.url) && !/^https?:\/\//.test(c.url)) problems.push(`${label}: ${c.url} is not a web URL`);
    }
  };
  if (!r.group?.trim()) problems.push("group is missing");
  if (!r.ultimateParent?.accountId) problems.push("ultimateParent.accountId is missing");
  cites("ultimateParent", r.ultimateParent?.citations);
  const names = new Set(r.entities.map((e) => e.name));
  for (const e of r.entities) {
    if (!ENTITY_STATUSES.includes(e.status)) problems.push(`${e.name}: unknown status ${e.status}`);
    cites(e.name, e.citations);
    if ((e.status === "divested" || e.status === "not_owned") && !e.ownerNow?.trim()) problems.push(`${e.name}: say who owns it now`);
    if (e.parent && !names.has(e.parent)) problems.push(`${e.name}: parent ${e.parent} is not an entity in this research`);
    for (const f of e.facts ?? []) cites(`${e.name} ${f.field}`, f.citations);
  }
  if (problems.length) throw new Error(`research incomplete: ${problems.join("; ")}`);
  return r;
}

export function allCitations(r: GroupResearch): Citation[] {
  return [
    ...r.ultimateParent.citations,
    ...r.entities.flatMap((e) => [...e.citations, ...(e.facts ?? []).flatMap((f) => f.citations)]),
  ];
}

/** HTML to readable text: drops scripts, styles and tags, decodes the common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;|&#038;/g, "&")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#039;|&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

export type PageReader = (url: string) => Promise<{ ok: true; text: string } | { ok: false; detail: string }>;

/** Reads a page with a browser-like user agent; many company sites refuse obvious bots. */
export const fetchPage: PageReader = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, text: htmlToText(await res.text()) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Verbatim gate. `pages` holds text the research agent already fetched (web_fetch results), keyed by URL; any other
 * URL is fetched once. Person-attested citations pass as "attested" and are shown to the approver as such.
 */
export async function verifyResearch(
  r: GroupResearch,
  options: { pages?: Record<string, string>; read?: PageReader; now?: string } = {},
): Promise<ResearchVerification> {
  const read = options.read ?? fetchPage;
  const cache = new Map<string, Promise<{ ok: true; text: string } | { ok: false; detail: string }>>();
  for (const [url, text] of Object.entries(options.pages ?? {})) cache.set(url, Promise.resolve({ ok: true, text: foldText(text) }));
  const checks: Record<string, CitationCheck> = {};
  for (const c of allCitations(r)) {
    const key = citationKey(c);
    if (checks[key]) continue;
    if (isInternal(c.url)) {
      checks[key] = { url: c.url, quote: c.quote, result: "attested", detail: `vouched for by ${c.attestedBy}` };
      continue;
    }
    if (!cache.has(c.url)) cache.set(c.url, read(c.url).then((p) => (p.ok ? { ok: true as const, text: foldText(p.text) } : p)));
    const page = await cache.get(c.url)!;
    if (page.ok && quoteFound(c.quote, page.text)) checks[key] = { url: c.url, quote: c.quote, result: "verified" };
    else if (c.attestedBy) checks[key] = { url: c.url, quote: c.quote, result: "attested", detail: `checked by hand by ${c.attestedBy}` };
    else if (page.ok) checks[key] = { url: c.url, quote: c.quote, result: "quote_not_found" };
    else checks[key] = { url: c.url, quote: c.quote, result: "unreachable", detail: page.detail };
  }
  return { checkedAt: options.now ?? new Date().toISOString(), checks };
}

/** The citations of a claim that passed the verbatim gate (or a person vouched for). */
export function passing(citations: Citation[], v: ResearchVerification): Citation[] {
  return citations.filter((c) => {
    const result = v.checks[citationKey(c)]?.result;
    return result === "verified" || result === "attested";
  });
}
