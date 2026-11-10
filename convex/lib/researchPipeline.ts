/**
 * Domain-first research pipeline (WS3). Pure + injectable so tests run it with
 * the fake record client and a stubbed LLM; convex/researchSessionActions.ts
 * wires the real dependencies.
 *
 *   domain -> ICP (LLM via engine/src/icpDerive.ts; no ICP fails the session, never a guess)
 *          -> searchTam (Leadsforge through treg.to, see leadsforge.ts)
 *             or, without TREG_TOKEN, icpToFilter -> recordClient.searchShared (PDL index)
 *          -> firmographic fit score -> segments -> sorted preview
 *
 * Contacts are deliberately NOT shown here: anonymous visitors only see
 * company data. The CRM is populated with accounts and contacts after claim
 * (populateActions.ts, started from recordActions.importSession).
 */
import type { Icp } from "../../engine/src/icp.ts";
import { employeeBandsToRange } from "../../engine/src/icp.ts";
import type { AccountInput, AccountRow, AccountsFilter, IcpWeights } from "./recordContract.ts";
import type { RecordClient } from "./recordClient.ts";
import type { MarketSegment, MarketSegments } from "./segments/marketSegments.ts";
import { accountIdFor, fitUnderWeights } from "./recordClient.ts";
import { icpIndustriesToLeadsforge } from "./leadsforge.ts";
import { canonIndustry, industrySourceNames } from "../../modules/kernel/industries.ts";
import type { FitModel } from "../../recipes/models.ts";
import { defaultModel } from "../../recipes/index.ts";

export type ResearchStatus = "deriving" | "building_tam" | "sampling_contacts" | "ready" | "failed";
export type Segment = { id: string; name: string; count: number };
export type IcpSource = "llm" | "heuristic";

export const TAM_IMPORT_LIMIT = 1000;
export const PREVIEW_SIZE = 25;
export const SESSION_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// ───────────────────────────── Domain ─────────────────────────────

export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) throw new Error("Enter a company domain, like acme.com.");
  let host: string;
  try {
    host = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new Error(`"${raw}" is not a valid company domain.`);
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error(`"${raw}" is not a valid company domain.`);
  if (/^\d+(\.\d+){3}$/.test(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`"${raw}" is not a public company domain.`);
  }
  return host;
}

// ───────────────────────────── Heuristic ICP ─────────────────────────────

/**
 * A broad B2B-software ICP nudged by domain keywords, for seed data and model
 * checks only. Signup research never shows it: a visitor who gets a generic
 * template instead of their own ICP is worse off than one told it failed.
 */
export function heuristicIcp(domain: string): Icp {
  const d = domain.toLowerCase();
  const hints: Array<[RegExp, string[]]> = [
    [/(pay|bank|fin|capital|ledger|money)/, ["financial services", "computer software"]],
    [/(health|med|care|clinic|bio)/, ["hospital & health care", "biotechnology"]],
    [/(hire|talent|recruit|staff|jobs)/, ["staffing and recruiting", "computer software"]],
    [/(learn|edu|school|academy)/, ["e-learning", "computer software"]],
    [/(ship|freight|logist|fleet)/, ["logistics and supply chain", "computer software"]],
    [/(shop|store|retail|commerce)/, ["retail", "internet"]],
  ];
  const industries = hints.find(([re]) => re.test(d))?.[1] ?? ["computer software", "internet", "information technology and services"];
  return {
    name: `${domain} (heuristic)`,
    motion: "sales",
    firmographics: {
      industries,
      employeeBands: ["51-200", "201-500", "501-1000", "1001-5000"],
      geos: ["us", "gb", "ca"],
    },
    persona: {
      jobLevels: ["vp", "director", "head"],
      departments: ["sales", "operations", "marketing"],
      titleKeywords: ["revenue operations", "sales operations", "head of sales"],
    },
    scoring: { threshold: 0.5 },
  };
}

// ───────────────────────────── ICP -> filter ─────────────────────────────

/**
 * An ICP's industries as canonical keys plus every spelling the sources write for them
 * (industries.ts), with each key's rank. A record service from 1.17.0 matches the keys; the
 * spellings let an older one, and the PDL index, match the same accounts.
 */
export function icpIndustryTerms(industries: string[] | undefined): Array<{ key: string; names: string[] }> {
  return icpIndustriesToLeadsforge(industries).map((key) => ({ key, names: [...new Set([key, ...industrySourceNames(key)])] }));
}

export { icpGeosToCountries } from "../../modules/kernel/icpGeography.ts";
import { icpGeosToCountries } from "../../modules/kernel/icpGeography.ts";

export { icpGeosToIso } from "../../modules/kernel/icpGeography.ts";
import { icpGeosToIso } from "../../modules/kernel/icpGeography.ts";

export function icpToFilter(icp: Icp): AccountsFilter {
  const filter: AccountsFilter = {};
  const industry = icpIndustryTerms(icp.firmographics.industries).flatMap((t) => t.names);
  if (industry.length) filter.industry = industry;
  const country = icpGeosToCountries(icp.firmographics.geos);
  if (country.length) filter.country = country;
  const range = employeeBandsToRange(icp.firmographics.employeeBands);
  if (range.min !== undefined) filter.employeeMin = range.min;
  if (range.max !== undefined) filter.employeeMax = range.max;
  return filter;
}

/** Progressive relaxation when the strict ICP filter is too narrow for a useful TAM. */
export function relaxations(filter: AccountsFilter): AccountsFilter[] {
  const steps: AccountsFilter[] = [filter];
  if (filter.employeeMin !== undefined || filter.employeeMax !== undefined) {
    const rest = { ...filter };
    delete rest.employeeMin;
    delete rest.employeeMax;
    steps.push(rest);
  }
  const last = steps[steps.length - 1];
  if (last.country) {
    const rest = { ...last };
    delete rest.country;
    steps.push(rest);
  }
  return steps;
}

// ───────────────────────────── Scoring ─────────────────────────────

const BAND_ORDER = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];
function bandIndexForEmployees(n: number | undefined): number {
  if (n === undefined) return -1;
  const caps = [10, 50, 200, 500, 1000, 5000, 10000, Infinity];
  return caps.findIndex((cap) => n <= cap);
}

/**
 * Firmographic fit 0..1 for a company against the ICP: industry 0.45, size
 * 0.30 (adjacent band earns half), geography 0.25. Dimensions the ICP leaves
 * empty are dropped from the denominator.
 */
export function scoreCompany(account: AccountInput, icp: Icp): { fit: number; reasons: string[] } {
  let score = 0;
  let weight = 0;
  const reasons: string[] = [];
  const industries = icpIndustriesToLeadsforge(icp.firmographics.industries);
  if (industries.length) {
    weight += 0.45;
    const idx = industries.indexOf(canonIndustry(account.industry) ?? "");
    if (idx === 0) { score += 0.45; reasons.push(`industry ${account.industry}`); }
    else if (idx > 0) { score += 0.38; reasons.push(`industry ${account.industry}`); }
  }
  const bands = (icp.firmographics.employeeBands ?? []).map((b) => BAND_ORDER.indexOf(b)).filter((i) => i >= 0);
  if (bands.length) {
    weight += 0.3;
    const mine = bandIndexForEmployees(account.employees);
    if (bands.includes(mine)) { score += 0.3; reasons.push(`size ${BAND_ORDER[mine]}`); }
    else if (bands.some((b) => Math.abs(b - mine) === 1)) { score += 0.15; reasons.push(`size near ICP (${BAND_ORDER[mine] ?? "unknown"})`); }
  }
  const countries = icpGeosToCountries(icp.firmographics.geos);
  if (countries.length) {
    weight += 0.25;
    const idx = countries.indexOf((account.country ?? "").toLowerCase());
    if (idx === 0) { score += 0.25; reasons.push(`geo ${account.country}`); }
    else if (idx > 0) { score += 0.2; reasons.push(`geo ${account.country}`); }
  }
  const fit = weight > 0 ? score / weight : 0;
  return { fit: Number(fit.toFixed(3)), reasons };
}

/** Employee range for a PDL size band ("10001+" is open-ended). */
function bandRange(band: string): { min: number; max: number } | null {
  const open = band.match(/^(\d+)\+$/);
  if (open) return { min: Number(open[1]), max: 1_000_000_000 };
  const m = band.match(/^(\d+)-(\d+)$/);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

/**
 * ICP -> fit weights for the record service's model: used to rank the shared
 * TAM search before signup and stored with /rescore after claim, so a
 * company's fit is the same on both sides. The points are the workspace's
 * scoring.fit settings (docs/recipes.md, "Model points").
 *
 * Secondary industries, countries and edge size bands score less, so rows that
 * all pass the ICP filter are still ordered by how central they are to it.
 */
export function icpToWeights(icp: Icp, fit: FitModel): IcpWeights {
  const rank = (list: readonly number[], i: number) => list[Math.min(i, list.length - 1)];
  const industries: Record<string, number> = {};
  // Each canonical industry, and every source's spelling of it, ranks the same.
  icpIndustryTerms(icp.firmographics.industries).forEach((t, i) => {
    for (const name of t.names) industries[name] = rank(fit.industryRanks, i);
  });
  const countries: Record<string, number> = {};
  icpGeosToCountries(icp.firmographics.geos).forEach((c, i) => (countries[c] = rank(fit.countryRanks, i)));
  const idx = (icp.firmographics.employeeBands ?? []).map((b) => BAND_ORDER.indexOf(b)).filter((i) => i >= 0).sort((a, b) => a - b);
  const employeeBands: NonNullable<IcpWeights["employeeBands"]> = [];
  if (idx.length) {
    const mid = (idx[0] + idx[idx.length - 1]) / 2;
    for (let i = 0; i < BAND_ORDER.length; i++) {
      const range = bandRange(BAND_ORDER[i]);
      if (!range) continue;
      const inside = idx.includes(i);
      const adjacent = !inside && (i === idx[0] - 1 || i === idx[idx.length - 1] + 1);
      // A band the ICP names or borders keeps its entry at weight 0: specGate reads a missing one as a size Canon doesn't list.
      if (inside || adjacent) employeeBands.push({ ...range, weight: inside ? (Math.abs(i - mid) <= 0.5 ? fit.bands.central : fit.bands.inside) : fit.bands.adjacent });
    }
  }
  return { base: fit.base, industries, countries, employeeBands };
}

// ───────────────────────────── Segments ─────────────────────────────

export function sizeTier(employees: number | undefined): "smb" | "mid" | "ent" {
  if (employees === undefined || employees <= 200) return "smb";
  if (employees <= 1000) return "mid";
  return "ent";
}
const TIER_LABEL = { smb: "SMB", mid: "Mid-market", ent: "Enterprise" } as const;

function slug(value: string) {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function segmentFor(account: AccountInput): { id: string; name: string } {
  const industry = account.industry ?? "other";
  const tier = sizeTier(account.employees);
  const pretty = industry.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, "and");
  return { id: `seg-${slug(industry)}-${tier}`, name: `${pretty} · ${TIER_LABEL[tier]}` };
}

/**
 * Tag each account with its segment and return segments ordered by
 * average fit (best first), ties broken by size. The top segment is where the
 * user lands after claim.
 */
export function buildSegments(accounts: AccountInput[]): { accounts: AccountInput[]; segments: Segment[] } {
  const stats = new Map<string, { name: string; count: number; fitSum: number }>();
  const tagged = accounts.map((account) => {
    const seg = segmentFor(account);
    const s = stats.get(seg.id) ?? { name: seg.name, count: 0, fitSum: 0 };
    s.count += 1;
    s.fitSum += account.fit ?? 0;
    stats.set(seg.id, s);
    return { ...account, segmentIds: [...new Set([...(account.segmentIds ?? []), seg.id])] };
  });
  const segments = [...stats.entries()]
    .map(([id, s]) => ({ id, name: s.name, count: s.count, avg: s.fitSum / s.count }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count || a.id.localeCompare(b.id))
    .map(({ id, name, count }) => ({ id, name, count }));
  return { accounts: tagged, segments };
}

export function previewRow(account: AccountInput, now: number): AccountRow {
  return {
    id: accountIdFor(account.domain),
    domain: account.domain,
    name: account.name,
    industry: account.industry,
    employees: account.employees,
    country: account.country,
    linkedinUrl: account.linkedinUrl,
    fit: account.fit ?? 0,
    status: "new",
    segmentIds: account.segmentIds ?? [],
    source: "pdl",
    updatedAt: now,
    version: 0,
  };
}

// ───────────────────────────── Pipeline ─────────────────────────────

export type EstimatedSegment = MarketSegment & {
  estCount: number | null;
  /** tagged: companies tagged with this business type; industry: estimate from PDL industries. */
  countBasis?: "tagged" | "industry";
};
export type EstimatedMarketSegments = Omit<MarketSegments, "buyers" | "adjacent"> & {
  buyers: EstimatedSegment[];
  adjacent: EstimatedSegment[];
  note?: string;
};

/** An external TAM search (Leadsforge): accounts for the ICP, already relaxed if it was too narrow. */
export type TamSearch = (icp: Icp, minTam: number) => Promise<{
  rows: AccountInput[];
  total: number;
  /** The provider's own filters, kept on the session to re-run after claim. */
  filter: Record<string, unknown>;
  /** The provider stopped at its per-search cap: more companies match than \`total\`. */
  saturated: boolean;
}>;

export type PipelineResult = {
  icp: Icp;
  icpSource: IcpSource;
  filter: AccountsFilter | Record<string, unknown>;
  tamTotal: number;
  segments: Segment[];
  preview: AccountRow[];
  tam: AccountInput[];
  marketSegments?: EstimatedMarketSegments;
};

/**
 * Segment sizes in the ICP's countries. Preferably companies tagged with the
 * business type (company_tags in the prospect index); when the service or index
 * has no tags, an estimate from the archetype's PDL industries (e.g. dental
 * practices then count all medical practices).
 */
export async function estimateSegments(
  segs: MarketSegments,
  client: Pick<RecordClient, "searchShared">,
  filter: AccountsFilter,
): Promise<EstimatedMarketSegments> {
  const where = filter.country ? { country: filter.country } : {};
  const count = async (s: MarketSegment): Promise<EstimatedSegment> => {
    try {
      const r = await client.searchShared({ archetype: [s.archetype], ...where }, 1);
      return { ...s, estCount: r.total, countBasis: "tagged" };
    } catch {
      // No tags in this index or service: fall back to the industry estimate.
    }
    if (!s.pdlIndustries.length) return { ...s, estCount: null };
    try {
      const r = await client.searchShared({ industry: s.pdlIndustries, ...where }, 1);
      return { ...s, estCount: r.total, countBasis: "industry" };
    } catch {
      return { ...s, estCount: null };
    }
  };
  const [buyers, adjacent] = await Promise.all([Promise.all(segs.buyers.map(count)), Promise.all(segs.adjacent.map(count))]);
  return { ...segs, buyers, adjacent };
}

/** Research that stopped: `message` is what the visitor sees, `detail` goes to the failure log. */
export class ResearchFailure extends Error {
  readonly stage: ResearchStatus;
  readonly detail: string;
  constructor(stage: ResearchStatus, message: string, detail: string) {
    super(message);
    this.stage = stage;
    this.detail = detail;
  }
}

/** The visitor-facing reason an ICP couldn't be derived, from icpDerive's error. */
export function icpFailureMessage(domain: string, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const reason = /could not read/i.test(text)
    ? `We couldn't load ${domain}'s website.`
    : /too little readable content/i.test(text)
      ? `${domain}'s website has too little readable text to tell who it sells to.`
      : /evidence quotes/i.test(text)
        ? `We couldn't back an ICP for ${domain} with quotes from its website.`
        : /credential|not configured/i.test(text)
          ? "ICP research is unavailable right now."
          : `The model that reads ${domain}'s website failed.`;
  return `${reason} We stopped rather than guess, and logged it so we can fix it.`;
}

export async function runResearchPipeline(opts: {
  domain: string;
  /** PDL index: the TAM when no \`searchTam\` is given, and segment size estimates. */
  client: Pick<RecordClient, "searchShared">;
  searchTam?: TamSearch;
  /** The ICP derived from the domain's website. Throwing stops the pipeline with a ResearchFailure. */
  deriveIcp: (domain: string) => Promise<Icp>;
  /** Buyer and adjacent segments (Jev), or null when unavailable. Failures never fail the pipeline. */
  deriveSegments?: (domain: string) => Promise<MarketSegments | null>;
  onStatus?: (status: ResearchStatus, patch?: Partial<PipelineResult>) => Promise<void> | void;
  onFinding?: (patch: Partial<PipelineResult>) => Promise<void> | void;
  now?: () => number;
  tamLimit?: number;
  minTam?: number;
}): Promise<PipelineResult> {
  const now = opts.now ?? (() => Date.now());
  const domain = normalizeDomain(opts.domain);
  await opts.onStatus?.("deriving");
  // Runs alongside ICP derivation and the TAM search; it shares their homepage fetch.
  const segmentsPromise: Promise<MarketSegments | { error: string } | null> = opts.deriveSegments
    ? opts.deriveSegments(domain).catch((error) => ({ error: error instanceof Error ? error.message.slice(0, 160) : "unknown error" })).then(async (derived) => {
      if (derived && !("error" in derived)) await Promise.resolve().then(() => opts.onFinding?.({ marketSegments: { ...derived, buyers: derived.buyers.map((s) => ({ ...s, estCount: null })), adjacent: derived.adjacent.map((s) => ({ ...s, estCount: null })) } })).catch(() => undefined);
      return derived;
    })
    : Promise.resolve(null);

  let icp: Icp;
  try {
    icp = await opts.deriveIcp(domain);
  } catch (error) {
    throw new ResearchFailure("deriving", icpFailureMessage(domain, error), error instanceof Error ? error.message : String(error));
  }
  const icpSource: IcpSource = "llm";
  await opts.onStatus?.("building_tam", { icp, icpSource });

  const limit = opts.tamLimit ?? TAM_IMPORT_LIMIT;
  const minTam = opts.minTam ?? 25;
  const strict = icpToFilter(icp);
  let filter = strict;
  let resultFilter: PipelineResult["filter"] = strict;
  // Signup research has no workspace yet, so it ranks on Canon's defaults.
  const weights = icpToWeights(icp, defaultModel("scoring.fit"));
  let search: { rows: Array<AccountInput & { fit?: number }>; total: number };
  // A failed external search (e.g. its free allowance is used up) falls back to the PDL index.
  const found = opts.searchTam ? await opts.searchTam(icp, minTam).catch(() => null) : null;
  if (found) {
    search = { rows: found.rows, total: found.total };
    resultFilter = { ...found.filter, saturated: found.saturated };
  } else {
    // Rank the whole match set by ICP fit before limiting, so the TAM is the
    // best `limit` companies, not the first `limit` rows the index returns.
    search = await opts.client.searchShared(strict, limit, weights);
    for (const relaxed of relaxations(strict).slice(1)) {
      if (search.total >= minTam) break;
      filter = relaxed;
      search = await opts.client.searchShared(relaxed, limit, weights);
    }
    resultFilter = filter;
  }

  const scored = search.rows
    .filter((row) => row.domain !== domain)
    .map((row) => ({ ...row, fit: row.fit ?? fitUnderWeights(row, weights) }))
    // Stable sort by fit only: within a tie keep the service's order (data
    // quality, size, then a stable hash), never re-alphabetize.
    .sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
  const { accounts: tam, segments } = buildSegments(scored);
  const t = now();
  const preview = tam.slice(0, PREVIEW_SIZE).map((row) => previewRow(row, t));
  await opts.onStatus?.("sampling_contacts", { filter: resultFilter, tamTotal: search.total, segments, preview, tam });
  const derived = await segmentsPromise;
  let marketSegments: EstimatedMarketSegments | undefined;
  if (derived && "error" in derived) {
    marketSegments = { buyers: [], adjacent: [], horizontal: false, jobs: [], note: `Segment classification failed (${derived.error}).` };
  } else if (derived) {
    marketSegments = await estimateSegments(derived, opts.client, filter);
    if (derived.horizontal) marketSegments.note = `${domain} sells to many kinds of businesses; segments by industry are a weak guide for it.`;
  }
  const result: PipelineResult = { icp, icpSource, filter: resultFilter, tamTotal: search.total, segments, preview, tam, ...(marketSegments ? { marketSegments } : {}) };
  await opts.onStatus?.("ready", result);
  return result;
}

// Contacts are found after claim by the population job (populateActions.ts), not here.

// ───────────────────────────── Abuse controls ─────────────────────────────

export const RATE_LIMITS = {
  ip: { limit: 5, windowMs: 60 * 60 * 1000 },
  domain: { limit: 3, windowMs: 60 * 60 * 1000 },
  global: { limit: 300, windowMs: 60 * 60 * 1000 },
} as const;

export type ClaimDecision = { kind: "claim" } | { kind: "already_claimed_by_you" };

/** Claim is idempotent for the same org and rejected for any other org. */
export function decideClaim(session: { status: ResearchStatus; claimedByOrgId?: string | null }, orgId: string): ClaimDecision {
  if (session.claimedByOrgId) {
    if (session.claimedByOrgId === orgId) return { kind: "already_claimed_by_you" };
    throw new Error("This research session was already claimed by another workspace.");
  }
  if (session.status === "failed") throw new Error("This research session failed; start a new one from the homepage.");
  if (session.status !== "ready") throw new Error("Research is still running.");
  return { kind: "claim" };
}

export function claimRedirect(segments: Segment[] | undefined): string {
  const top = segments?.[0]?.id;
  return top ? `/dashboard/accounts?segment=${encodeURIComponent(top)}` : "/dashboard/accounts";
}

export function newToken(randomBytes: Uint8Array): string {
  return Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
