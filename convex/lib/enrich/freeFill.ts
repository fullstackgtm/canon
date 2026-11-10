/**
 * Free CRM fill (docs/enrich-free-fill.md): what a connected HubSpot portal's
 * companies are missing, and which blanks Canon can fill at no cost from
 * - the shared prospect index (People Data Labs free company dataset, CC BY 4.0),
 * - SEC-reported revenue for US public companies (secRevenue.v1.json),
 * - a revenue estimate from industry and size (revenueCalibration.v1.json).
 *
 * Fill-blanks only: a field with any value is never proposed. Pure: no I/O.
 */
import type { PatchOperation, PatchPlan } from "../../../engine/src/types.ts";
import type { SharedCompanyDetail } from "../recordContract.ts";
import secRevenue from "./secRevenue.v1.json" with { type: "json" };
import calibration from "./revenueCalibration.v1.json" with { type: "json" };
import { canonIndustry } from "../../../modules/kernel/industries.ts";
import type { EnrichmentValues } from "../consolidate.ts";

export const PDL_ATTRIBUTION = "Company data from People Data Labs";

/** The HubSpot company properties the fill covers, in display order. */
export const FILL_FIELDS = [
  { property: "domain", label: "Domain" },
  { property: "industry", label: "Industry" },
  { property: "numberofemployees", label: "Employees" },
  { property: "annualrevenue", label: "Annual revenue" },
  { property: "city", label: "City" },
  { property: "state", label: "State / region" },
  { property: "country", label: "Country" },
  { property: "linkedin_company_page", label: "LinkedIn page" },
  { property: "founded_year", label: "Year founded" },
] as const;
export type FillProperty = (typeof FILL_FIELDS)[number]["property"];
/** Properties read per company: the fill fields plus its name. */
export const READ_PROPERTIES = ["name", ...FILL_FIELDS.map((f) => f.property)];

export type FillSource = "pdl" | "crustdata" | "sec" | "estimate" | "name";
export type HubspotCompany = { id: string; properties: Record<string, string | null | undefined> };
export type Fill = { companyId: string; companyName: string; domain: string; property: FillProperty; before: string | null; value: string; display: string; source: FillSource; reason: string };
/** An enumeration property's options, e.g. HubSpot's `industry`. */
export type PropertyOption = { label: string; value: string };

/**
 * How a company was matched to a source row:
 * - `domain`: the index has its domain with a domain that looks like the company's own;
 * - `name`: the index has its domain, flagged low confidence, but the CRM's name agrees with the index's;
 * - `root`: its root domain (shop.acme.com -> acme.com, acme.co.uk -> acme.com) with agreeing names;
 * - `crustdata`: Crustdata identify knows the domain (PDL doesn't);
 * - `lookup`: a company with no domain whose exact name resolved to one, then matched in the index.
 */
export type MatchVia = "domain" | "name" | "root" | "crustdata" | "lookup";
export type Match = { row: SharedCompanyDetail; source: "pdl" | "crustdata"; via: MatchVia; domain: string };

/** Why a company has no match, for the report's gaps. */
export type GapReason = "noDomain" | "notFound" | "namesDisagree";

export type FieldCoverage = {
  property: FillProperty; label: string; filled: number; fillable: number; bySource: Partial<Record<FillSource, number>>;
  /** Blank on a matched company, but the source has no value (or, for industry, the portal no matching option). */
  sourceEmpty: number;
};
export type CoverageReport = {
  companies: number;
  /** Companies with no usable domain: nothing can be matched for them unless their name resolves. */
  withoutDomain: number;
  /** Companies matched to a source row, by how. */
  matched: number;
  matchedVia: Partial<Record<MatchVia, number>>;
  /** Companies left unmatched, by why. */
  gaps: Partial<Record<GapReason, number>>;
  fields: FieldCoverage[];
  emptyCells: number;
  fillableCells: number;
  /** A handful of fills per field, to show what a write will look like. */
  samples: Fill[];
  calibration: { exactBand: number; withinOneBand: number; companies: number };
  attribution: string;
};

const SEC = secRevenue.rows as unknown as Record<string, [number, number]>;
const RPE = calibration.industries as Record<string, number>;

export function normalizeDomain(raw: string | null | undefined): string | null {
  const d = (raw ?? "").trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/[/:?#].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";

/** "united states" -> "United States", keeping short words lowercase the way place names read. */
function placeCase(v: string): string {
  return v.replace(/\b([a-z])([a-z]*)/g, (_, a: string, b: string, i: number) => (i > 0 && /^(of|and|the|da|de|del)$/.test(a + b) ? a + b : a.toUpperCase() + b));
}

const squash = (v: string) => v.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

// Words that never tell two companies apart.
const NAME_STOPWORDS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "sa", "sas", "srl", "bv", "ab", "ag",
  "plc", "pty", "the", "and", "of", "group", "holdings", "holding", "international", "global", "technologies", "technology", "labs", "hq",
]);
const nameTokens = (v: string) => v.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t && !NAME_STOPWORDS.has(t));

/**
 * Whether two company names name the same company: equal once legal suffixes and punctuation go, or one name's
 * distinctive words all appear in the other ("Acme" / "Acme Robotics Inc"). A single short word must match whole.
 */
/** Whether a name is distinctive enough to look its domain up by: two distinctive words, or one of 8+ letters. */
export function distinctiveName(name: string | null | undefined): boolean {
  const t = nameTokens(name ?? "");
  return t.length >= 2 ? t.join("").length >= 6 : (t[0]?.length ?? 0) >= 8;
}

export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join("") === tb.join("")) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.join("").length < 4) return false;
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

// Second-level labels under a country code (acme.co.uk): the registrable domain keeps three labels.
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ltd", "plc"]);

/** Other domains the same company is likely to own: its root (shop.acme.com -> acme.com) and, under a country code, acme.com. */
export function rootDomainCandidates(domain: string): string[] {
  const labels = domain.split(".");
  const tld = labels[labels.length - 1]!;
  const keep = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  const root = labels.slice(-keep).join(".");
  const out = new Set<string>();
  if (root !== domain) out.add(root);
  if (tld.length === 2) out.add(`${labels[labels.length - keep]}.com`);
  out.delete(domain);
  return [...out];
}

/**
 * The index's own match for a company: exact domain (a low-confidence one only when the names agree), else a root
 * domain whose name agrees. Null with why when there is none.
 */
export function indexMatch(company: HubspotCompany, index: Map<string, SharedCompanyDetail>): Match | { gap: GapReason } {
  const domain = normalizeDomain(company.properties.domain);
  if (!domain) return { gap: "noDomain" };
  const exact = index.get(domain);
  if (exact?.domainConfidence === "high") return { row: exact, source: "pdl", via: "domain", domain };
  if (exact && namesAgree(company.properties.name, exact.name)) return { row: exact, source: "pdl", via: "name", domain };
  for (const candidate of rootDomainCandidates(domain)) {
    const row = index.get(candidate);
    if (row && namesAgree(company.properties.name, row.name)) return { row, source: "pdl", via: "root", domain };
  }
  return { gap: exact ? "namesDisagree" : "notFound" };
}

/**
 * The portal's industry option for a source industry: the same words (punctuation and "&"/"and" aside), else the
 * same canonical industry across LinkedIn's old and 2022 lists (record-service industries.ts). Left blank rather
 * than guessed when neither matches.
 */
export function industryOption(industry: string, options: PropertyOption[]): PropertyOption | null {
  const want = squash(industry);
  const same = options.find((o) => squash(o.label) === want || squash(o.value) === want);
  if (same) return same;
  const key = canonIndustry(industry);
  if (!key) return null;
  return options.find((o) => canonIndustry(o.label) === key || canonIndustry(o.value) === key) ?? null;
}

/** Revenue estimate: industry revenue per employee x the size band's geometric midpoint, to two significant figures. */
export function estimateRevenue(industry: string | undefined, employeesMin: number | undefined, employeesMax: number | undefined): number | null {
  if (!employeesMin) return null;
  const emp = Math.sqrt(employeesMin * (employeesMax ?? 20_000));
  const rpe = (industry && RPE[industry.toLowerCase()]) || calibration.globalRevenuePerEmployee;
  const raw = rpe * emp;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1);
  return Math.round(raw / mag) * mag;
}

export function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

function linkedinUrl(v: string): string {
  return /^https?:\/\//.test(v) ? v : `https://www.${v.replace(/^www\./, "")}`;
}

const VIA_NOTE: Record<MatchVia, string> = {
  domain: "",
  name: " Matched on domain and confirmed by company name.",
  root: " Matched on the root domain and confirmed by company name.",
  crustdata: "",
  lookup: " The domain was found from the exact company name.",
};

/**
 * A match's own values per fill property, before any mapping into the portal: industry is the source's string, not a
 * HubSpot option, and employees the size band's lower bound. Revenue is never a source's own value (SEC or estimate).
 */
export function sourceValues(match: Match): EnrichmentValues {
  const { row } = match;
  const values: EnrichmentValues = {
    industry: row.industry || undefined,
    numberofemployees: row.employeesMin || undefined,
    city: row.locality ? placeCase(row.locality) : undefined,
    state: row.region ? placeCase(row.region) : undefined,
    country: row.country ? placeCase(row.country) : undefined,
    linkedin_company_page: row.linkedinUrl ? linkedinUrl(row.linkedinUrl) : undefined,
    founded_year: row.founded || undefined,
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as EnrichmentValues;
}

/** Every blank a company's match (and SEC data) can fill, plus the blanks its source left empty. */
export function fillsFor(company: HubspotCompany, match: Match | null, industryOptions: PropertyOption[]): { fills: Fill[]; sourceEmpty: FillProperty[] } {
  const p = company.properties;
  const domain = match?.domain ?? normalizeDomain(p.domain);
  if (!domain) return { fills: [], sourceEmpty: [] };
  const fills: Fill[] = [];
  const base = { companyId: company.id, companyName: p.name?.trim() || domain, domain };
  const add = (property: FillProperty, value: string | null | undefined, display: string | undefined, source: FillSource, reason: string) => {
    if (value === null || value === undefined || value === "" || !blank(p[property])) return;
    fills.push({ ...base, property, before: p[property] ?? null, value, display: display ?? value, source, reason });
  };
  // A name alone can name another company (a fictional "Hooli" resolved to a real hooli.co.uk), so a name lookup only
  // proposes the domain, for review; once it is approved the next check fills the rest from the exact domain.
  if (match?.via === "lookup") {
    add("domain", domain, undefined, "name", `Domain of "${p.name}" found by exact company name (${match.row.name}); check it is the same company.`);
    return { fills, sourceEmpty: [] };
  }
  const sec = SEC[domain];
  if (sec) add("annualrevenue", String(sec[0]), formatUsd(sec[0]), "sec", `SEC filing revenue, calendar ${secRevenue.fiscalYear} (CIK ${sec[1]}).`);
  if (!match) return { fills, sourceEmpty: [] };
  const { row } = match;
  const src = match.source;
  const raw = sourceValues(match);
  const cite = `${src === "pdl" ? PDL_ATTRIBUTION : "Company data from Crustdata"} (${row.domain}).${VIA_NOTE[match.via]}`;
  if (raw.industry) {
    const option = industryOption(raw.industry, industryOptions);
    if (option) add("industry", option.value, option.label, src, cite);
  }
  if (raw.numberofemployees) {
    add("numberofemployees", String(raw.numberofemployees), `${raw.numberofemployees}${row.sizeBand ? ` (band ${row.sizeBand})` : ""}`, src,
      `${cite} Size band ${row.sizeBand ?? "unknown"}; written as the band's lower bound.`);
  }
  if (!sec) {
    const est = estimateRevenue(row.industry, row.employeesMin, row.employeesMax);
    if (est) add("annualrevenue", String(est), `~${formatUsd(est)} (estimate)`, "estimate",
      `Estimate: ${row.industry ?? "all-industry"} revenue per employee x size band ${row.sizeBand ?? "?"}. Within one revenue band for ${Math.round(calibration.heldOut.withinOneBand * 100)}% of public companies tested.`);
  }
  add("city", raw.city, undefined, src, cite);
  add("state", raw.state, undefined, src, cite);
  add("country", raw.country, undefined, src, cite);
  add("linkedin_company_page", raw.linkedin_company_page, undefined, src, cite);
  if (raw.founded_year) add("founded_year", String(raw.founded_year), undefined, src, cite);
  const covered = new Set(fills.map((f) => f.property));
  const sourceEmpty = FILL_FIELDS.map((f) => f.property).filter((property) => blank(p[property]) && !covered.has(property) && property !== "domain");
  return { fills, sourceEmpty };
}

/**
 * The report for a set of companies, given each one's match (or why it has none). `matches` holds only the
 * matched; `gaps` says why each other company with a domain is unmatched.
 */
export function coverageReport(
  companies: HubspotCompany[],
  matches: Map<string, Match>,
  industryOptions: PropertyOption[],
  gaps: Map<string, GapReason> = new Map(),
  samplesPerField = 3,
): { report: CoverageReport; fills: Fill[] } {
  const fills: Fill[] = [];
  const sourceEmpty = new Map<FillProperty, number>();
  const matchedVia: CoverageReport["matchedVia"] = {};
  const gapCounts: CoverageReport["gaps"] = {};
  let withoutDomain = 0;
  for (const company of companies) {
    if (!normalizeDomain(company.properties.domain)) withoutDomain++;
    const match = matches.get(company.id) ?? null;
    if (match) matchedVia[match.via] = (matchedVia[match.via] ?? 0) + 1;
    else {
      const gap = gaps.get(company.id) ?? (normalizeDomain(company.properties.domain) ? "notFound" : "noDomain");
      gapCounts[gap] = (gapCounts[gap] ?? 0) + 1;
    }
    const r = fillsFor(company, match, industryOptions);
    fills.push(...r.fills);
    for (const property of r.sourceEmpty) sourceEmpty.set(property, (sourceEmpty.get(property) ?? 0) + 1);
  }
  const fields = FILL_FIELDS.map(({ property, label }): FieldCoverage => {
    const mine = fills.filter((f) => f.property === property);
    const bySource: FieldCoverage["bySource"] = {};
    for (const f of mine) bySource[f.source] = (bySource[f.source] ?? 0) + 1;
    return { property, label, filled: companies.filter((c) => !blank(c.properties[property])).length, fillable: mine.length, bySource, sourceEmpty: sourceEmpty.get(property) ?? 0 };
  });
  const samples = FILL_FIELDS.flatMap(({ property }) => fills.filter((f) => f.property === property).slice(0, samplesPerField));
  return {
    fills,
    report: {
      companies: companies.length,
      withoutDomain,
      matched: Object.values(matchedVia).reduce((n, x) => n + (x ?? 0), 0),
      matchedVia,
      gaps: gapCounts,
      fields,
      emptyCells: fields.reduce((n, f) => n + companies.length - f.filled, 0),
      fillableCells: fills.length,
      samples,
      calibration: { exactBand: calibration.heldOut.exactBand, withinOneBand: calibration.heldOut.withinOneBand, companies: calibration.heldOut.companies },
      attribution: PDL_ATTRIBUTION,
    },
  };
}

function addCounts<K extends string>(a: Partial<Record<K, number>> | undefined, b: Partial<Record<K, number>> | undefined): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = { ...(a ?? {}) };
  for (const [k, n] of Object.entries(b ?? {}) as Array<[K, number]>) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Two chunks' reports as one: counts add, samples keep the first few per field. */
export function mergeReports(a: CoverageReport | null, b: CoverageReport, samplesPerField = 3): CoverageReport {
  if (!a) return b;
  const fields = a.fields.map((f, i) => {
    const g = b.fields[i]!;
    const bySource: FieldCoverage["bySource"] = { ...f.bySource };
    for (const [k, n] of Object.entries(g.bySource) as Array<[FillSource, number]>) bySource[k] = (bySource[k] ?? 0) + n;
    return { ...f, filled: f.filled + g.filled, fillable: f.fillable + g.fillable, bySource, sourceEmpty: (f.sourceEmpty ?? 0) + (g.sourceEmpty ?? 0) };
  });
  const samples = FILL_FIELDS.flatMap(({ property }) => [...a.samples, ...b.samples].filter((s) => s.property === property).slice(0, samplesPerField));
  return {
    ...a,
    companies: a.companies + b.companies,
    withoutDomain: a.withoutDomain + b.withoutDomain,
    matched: a.matched + b.matched,
    matchedVia: addCounts(a.matchedVia, b.matchedVia),
    gaps: addCounts(a.gaps, b.gaps),
    fields,
    emptyCells: a.emptyCells + b.emptyCells,
    fillableCells: a.fillableCells + b.fillableCells,
    samples,
  };
}

/** The fills a plan proposes: estimates only when asked for, and nothing in a property a Canon field owns. */
export function planFills(fills: Fill[], options: { includeEstimates: boolean; owned: ReadonlySet<string> }): Fill[] {
  return fills.filter((f) => (options.includeEstimates || f.source !== "estimate") && !options.owned.has(f.property));
}

/**
 * A reviewable plan for the fills: one fill-blank `set_field` per value, compare-and-set on the blank the
 * analysis saw. Estimates are medium risk, everything else low; every write still needs approval.
 */
export function fillPlan(fills: Fill[], now: Date): PatchPlan {
  const operations: PatchOperation[] = fills.map((f) => ({
    id: `free_fill:${f.companyId}:${f.property}`,
    objectType: "account",
    objectId: f.companyId,
    operation: "set_field",
    field: f.property,
    beforeValue: f.before,
    afterValue: f.value,
    reason: `${f.companyName}: ${f.reason}`,
    riskLevel: f.source === "estimate" || f.source === "name" ? "medium" : "low",
    approvalRequired: true,
    sourceRuleOrPolicy: "enrich.free_fill",
    rollback: `Clear ${f.property} on company ${f.companyId}.`,
  }));
  const companies = new Set(fills.map((f) => f.companyId)).size;
  return {
    id: `free_fill_${now.getTime()}`,
    title: "Free fill: company fields",
    createdAt: now.toISOString(),
    status: "needs_approval",
    dryRun: true,
    summary: `Fill ${operations.length} blank field(s) on ${companies} compan${companies === 1 ? "y" : "ies"} from free sources. ${PDL_ATTRIBUTION}; revenue from SEC filings or marked as an estimate.`,
    findings: [],
    operations,
  } as PatchPlan;
}
