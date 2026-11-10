/**
 * Challenging an ICP: the prompts and schemas that ask a model for adjacent markets, the parse that keeps proposals
 * outside the current market, and the evidence gate that keeps a quote only when it is verbatim in a page that was
 * read. The ICPs module (modules/examples/icps/challenge.ts) and Canon's ICP challenge (convex/lib/tam/challengeIcp.ts)
 * both run them.
 */
import { INDUSTRIES as INDUSTRY_ROWS } from "./industries.ts";
import type { FreePopulationQuery } from "./freePopulation.ts";
import type { DerivedIcp } from "./icpResearchSpec.ts";
const INDUSTRIES = INDUSTRY_ROWS.map((i) => i.key);
export type FetchedPage = { url: string; text: string };

/** The current market a proposal must sit outside: its industries and size, as a Leadsforge search names them. */
export type CurrentMarket = { companyIndustries?: { include?: string[] }; companyEmployeeNumberRange?: { min?: number; max?: number } };

export const MAX_PROPOSALS = 5;
export const MAX_READ_URLS = 6;
/** Where quotes taken from the CRM data we showed the model point. */
export const CRM_SOURCE = "canoncrm:data";

export type Claim = { text: string; quote?: string; sourceUrl?: string };

export type Proposal = {
  name: string;
  rationale: string;
  industries: string[];
  employeeMin?: number;
  employeeMax?: number;
  countries: string[];
  risks: string[];
  claims: Claim[];
  readUrls: string[];
};

export type ChallengeContext = {
  vendorDomain?: string;
  icp?: unknown;
  sells: string[];
  wonDeals: Array<{ name: string; account?: string; industry?: string; employees?: number; amount?: number; currency?: string }>;
  lostDeals: Array<{ name: string; account?: string; industry?: string; employees?: number }>;
  bestAccounts: Array<{ name: string; industry?: string; employees?: number; country?: string }>;
  /** Markets already proposed and accepted or dismissed: never repeat them. */
  decided: Array<{ name: string; industries: string[]; state: string; reason?: string }>;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The CRM data as text. Quotes from it are checked against exactly this. */
export function contextText(c: ChallengeContext): string {
  const parts: string[] = [];
  if (c.vendorDomain) parts.push(`## Our company\n${c.vendorDomain}`);
  if (c.sells.length) parts.push(`## What we sell / jobs we help with\n${c.sells.map((j) => `- ${j}`).join("\n")}`);
  if (c.icp) parts.push(`## Our current ideal customer profile\n${clip(JSON.stringify(c.icp), 3000)}`);
  const facts = (d: { account?: string; industry?: string; employees?: number; amount?: number; currency?: string; country?: string }) => {
    const f = [d.account, d.industry, d.employees !== undefined ? `${d.employees} employees` : undefined, d.amount !== undefined ? `${d.currency ? `${d.currency} ` : "$"}${d.amount.toLocaleString("en-US")}` : undefined, d.country].filter(Boolean);
    return f.length ? ` (${f.join(", ")})` : "";
  };
  if (c.wonDeals.length) parts.push(`## Deals we won\n${c.wonDeals.map((d) => `- ${d.name}${facts(d)}`).join("\n")}`);
  if (c.lostDeals.length) parts.push(`## Deals we lost\n${c.lostDeals.map((d) => `- ${d.name}${facts(d)}`).join("\n")}`);
  if (c.bestAccounts.length) parts.push(`## Our best-fit accounts today\n${c.bestAccounts.map((a) => `- ${a.name}${facts(a)}`).join("\n")}`);
  if (c.decided.length) {
    parts.push(`## Markets already considered (do not propose again)\n${c.decided.map((d) => `- ${d.name} [${d.state}]${d.reason ? `: ${d.reason}` : ""}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export const PROPOSE_SCHEMA = {
  type: "object",
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: MAX_PROPOSALS,
      items: {
        type: "object",
        required: ["name", "rationale", "industries", "claims"],
        properties: {
          name: { type: "string", description: "2-6 words, e.g. 'Auto dealerships with commissioned sales staff'." },
          rationale: { type: "string", description: "One or two sentences: why this market would buy what we sell." },
          industries: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            description: "The closest industries, from the allowed list.",
            items: { type: "string", enum: [...INDUSTRIES] },
          },
          employeeMin: { type: "number" },
          employeeMax: { type: "number" },
          countries: { type: "array", items: { type: "string" }, description: "Country names; omit to keep our current geography." },
          risks: { type: "array", maxItems: 3, items: { type: "string" }, description: "Why this might not work." },
          claims: {
            type: "array",
            maxItems: 4,
            description:
              "Each statement about this market or how it buys. Give `quote` + `sourceUrl` ONLY when copied word for word from a page or the CRM data below; otherwise leave them out and it will be shown as a hypothesis.",
            items: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" }, quote: { type: "string" }, sourceUrl: { type: "string" } },
            },
          },
          readUrls: {
            type: "array",
            maxItems: 2,
            description: "Public https pages (industry bodies, trade press, vendor pages) worth reading to check this market. We fetch them.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

export function proposePrompt(c: ChallengeContext, pages: readonly FetchedPage[]): string {
  return `You are a forward-deployed GTM engineer challenging a B2B company's ideal customer profile. Propose ${MAX_PROPOSALS - 2}-${MAX_PROPOSALS} ADJACENT markets this company is not selling to today, which could plausibly buy what it sells. The best proposals come from a mechanism in the product that the current ICP only partly exploits (for example: a commission product also fits any industry that pays commissions).

Rules:
- Each market must be outside the current ICP's industries or size band, and different from every market already considered.
- Map each market to the allowed industry list and, if size matters, an employee range.
- Do not state facts about the world from memory as if they were established. Put every such statement in \`claims\`. A claim carries a \`quote\` and \`sourceUrl\` only when the quote is copied exactly, character for character, from the company pages or CRM data below. Anything else must have no quote: it will be shown as a hypothesis.
- Offer \`readUrls\` for pages that could confirm a claim; we fetch them and ask you to cite them in a second step.
- Be specific and challenging, not generic. Include a real risk for each market.

# CRM data

${contextText(c)}

# Company pages

${pages.map((p) => `<page url="${p.url}">\n${p.text.slice(0, 6000)}\n</page>`).join("\n\n") || "(none could be read)"}`;
}

export const CITE_SCHEMA = {
  type: "object",
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["proposal", "text", "quote", "sourceUrl"],
        properties: {
          proposal: { type: "number", description: "Index of the proposal this supports." },
          text: { type: "string" },
          quote: { type: "string", description: "Copied exactly, character for character, from one page below." },
          sourceUrl: { type: "string" },
        },
      },
    },
  },
};

export function citePrompt(proposals: readonly Pick<Proposal, "name" | "rationale">[], pages: readonly FetchedPage[]): string {
  return `You proposed these adjacent markets:
${proposals.map((p, i) => `${i}. ${p.name}: ${p.rationale}`).join("\n")}

Below are the pages we fetched. Return only claims these pages directly support, each with a quote copied exactly, character for character, from one page and that page's URL. If a page supports nothing, return nothing for it.

${pages.map((p) => `<page url="${p.url}">\n${p.text.slice(0, 8000)}\n</page>`).join("\n\n")}`;
}

// ───────────────────────────── Validation ─────────────────────────────

/** Industries that are exactly Leadsforge's, lowercased and deduped. */
function validIndustries(raw: unknown): string[] {
  const allowed = new Set<string>(INDUSTRIES);
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((i) => norm(String(i))).filter((i) => allowed.has(i)))].slice(0, 3);
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 1 && x <= 1_000_000_000 ? Math.round(x) : undefined);
const strings = (x: unknown, max: number, len: number) =>
  (Array.isArray(x) ? x : []).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, len)).slice(0, max);

/** A market's identity for "already considered": its industries. */
export const marketKey = (industries: string[]) => [...industries].sort().join("|");

/**
 * The model's proposals, kept only when they are well formed, map to real
 * industries, sit outside the current ICP, and are new to this org. Claims are
 * not judged here (see verifyClaims).
 */
export function parseProposals(
  raw: unknown,
  opts: { icp: CurrentMarket; decided: ChallengeContext["decided"] },
): Proposal[] {
  const list = (raw as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) return [];
  const icpIndustries = new Set(opts.icp.companyIndustries?.include ?? []);
  const seenNames = new Set(opts.decided.map((d) => norm(d.name)));
  const seenKeys = new Set(opts.decided.map((d) => marketKey(d.industries)));
  const out: Proposal[] = [];
  for (const item of list) {
    if (out.length >= MAX_PROPOSALS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, 80) : "";
    const industries = validIndustries(s.industries);
    if (!name || !industries.length || seenNames.has(norm(name))) continue;
    let employeeMin = num(s.employeeMin);
    let employeeMax = num(s.employeeMax);
    if (employeeMin !== undefined && employeeMax !== undefined && employeeMin > employeeMax) [employeeMin, employeeMax] = [employeeMax, employeeMin];
    const bandOutside = (() => {
      const r = opts.icp.companyEmployeeNumberRange;
      if (!r || (employeeMin === undefined && employeeMax === undefined)) return false;
      return (employeeMax ?? Infinity) < (r.min ?? 1) || (employeeMin ?? 1) > (r.max ?? Infinity);
    })();
    // Adjacent means outside today's TAM: a new industry, or the same industry at a disjoint size.
    if (industries.every((i) => icpIndustries.has(i)) && !bandOutside) continue;
    if (seenKeys.has(marketKey(industries))) continue;
    seenNames.add(norm(name));
    seenKeys.add(marketKey(industries));
    out.push({
      name,
      rationale: typeof s.rationale === "string" ? s.rationale.trim().slice(0, 500) : "",
      industries,
      ...(employeeMin !== undefined ? { employeeMin } : {}),
      ...(employeeMax !== undefined ? { employeeMax } : {}),
      countries: strings(s.countries, 5, 60),
      risks: strings(s.risks, 3, 240),
      claims: (Array.isArray(s.claims) ? s.claims : [])
        .filter((c) => !!c && typeof c === "object")
        .map((c) => c as { text?: unknown; quote?: unknown; sourceUrl?: unknown })
        .filter((c) => typeof c.text === "string" && c.text.trim())
        .slice(0, 4)
        .map((c) => ({
          text: String(c.text).trim().slice(0, 300),
          ...(typeof c.quote === "string" && c.quote.trim() ? { quote: c.quote.trim().slice(0, 600) } : {}),
          ...(typeof c.sourceUrl === "string" ? { sourceUrl: c.sourceUrl.trim().slice(0, 500) } : {}),
        })),
      readUrls: strings(s.readUrls, 2, 500).filter((u) => /^https:\/\//i.test(u)),
    });
  }
  return out;
}

/**
 * The evidence gate: a claim keeps its quote only if it appears verbatim in a
 * page that was read (or the CRM data shown); its source becomes the page that
 * contains it. Otherwise the quote is dropped and the claim is a hypothesis.
 */
export function verifyClaims(claims: readonly Claim[], pages: readonly FetchedPage[]): Claim[] {
  return claims.map((c) => {
    const page = c.quote && c.quote.trim().length >= 12 ? pages.find((p) => p.url === c.sourceUrl && p.text.includes(c.quote!)) : null;
    return page && c.quote ? { text: c.text, quote: c.quote, sourceUrl: page.url } : { text: c.text };
  });
}

/** Claims from the citing step, tagged by proposal, appended after verification. */
export function addCited(
  proposals: Proposal[],
  cited: unknown,
  pages: readonly FetchedPage[],
): Proposal[] {
  const list = (cited as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) return proposals;
  const out = proposals.map((p) => ({ ...p, claims: [...p.claims] }));
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as { proposal?: unknown; text?: unknown; quote?: unknown; sourceUrl?: unknown };
    const target = typeof c.proposal === "number" ? out[c.proposal] : undefined;
    if (!target || target.claims.length >= 6 || typeof c.text !== "string") continue;
    const [verified] = verifyClaims([{ text: c.text.trim().slice(0, 300), ...(typeof c.quote === "string" ? { quote: c.quote.trim().slice(0, 600) } : {}), ...(typeof c.sourceUrl === "string" ? { sourceUrl: c.sourceUrl } : {}) }], pages);
    if (verified?.text) target.claims.push(verified);
  }
  return out;
}


export function proposalSearch(p: Pick<Proposal, "industries" | "employeeMin" | "employeeMax" | "countries">, icp: DerivedIcp | undefined): string {
  const query: FreePopulationQuery = {
    industries: p.industries, countries: p.countries.length ? p.countries : icp?.firmographics.geos ?? [],
    ...(p.employeeMin !== undefined ? { employeeMin: p.employeeMin } : {}), ...(p.employeeMax !== undefined ? { employeeMax: p.employeeMax } : {}),
    ...(!p.employeeMin && !p.employeeMax && icp?.firmographics.employeeBands?.length ? { employeeBands: icp.firmographics.employeeBands } : {}),
    buyer: { levels: icp?.persona.jobLevels ?? [], departments: icp?.persona.departments ?? [], titles: icp?.persona.titleKeywords ?? [] },
  };
  return JSON.stringify(query);
}
