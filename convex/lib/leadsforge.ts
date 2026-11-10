/**
 * Leadsforge people search through treg.to: the source that populates a
 * workspace's CRM with accounts and contacts. The search is free (treg relays
 * it at $0 on its own Leadsforge account; we send a $0 ceiling so anything
 * billable is refused) and returns people with their company's firmographics,
 * so one call yields both contacts and the accounts they work at.
 *
 * Leadsforge returns at most 1,000 results per search (a 410 past that). To
 * go past it we split a saturated search into narrower ones, along one
 * dimension at a time (see splitFilters), until each slice is exhausted or
 * cannot be split further. There is no CanonCRM-side volume cap.
 */
import type { Icp } from "../../engine/src/icp.ts";
import { employeeBandsToRange } from "../../engine/src/icp.ts";
import type { AccountInput, ContactInput } from "./recordContract.ts";
import { tregCall, type TregMeta } from "./treg.ts";
import { normDomain, peopleToRecords, type Person } from "./peopleSources.ts";
import { INDUSTRIES as CANONICAL_INDUSTRIES } from "../../services/record-service/src/industries.ts";

export const LEADSFORGE_SEARCH = "leadsforge.people.search";
/** Leadsforge's per-search ceiling, and the page size we ask for. */
export const SEARCH_MAX = 1000;

/**
 * The canonical industries (services/record-service/src/industries.ts), which are exactly
 * Leadsforge's values (leadsforge.people.search.filters.industries, 2026-10-06).
 */
export const INDUSTRIES: readonly string[] = CANONICAL_INDUSTRIES.map((i) => i.key);

/** leadsforge.people.search.filters.seniorities, 2026-10-06. */
export const SENIORITIES = ["senior", "entry", "manager", "director", "mid_level", "c_suite", "owner", "intern", "founder", "head", "vp", "partner"] as const;

/** leadsforge.people.search.filters.departments, 2026-10-06. */
export const DEPARTMENTS = [
  "engineering_technical", "sales", "medical_health", "education", "operations", "skilled_trades_construction_and_maintenance",
  "finance", "information_technology", "administrative", "accounting", "design", "transportation_and_logistics", "marketing",
  "hospitality_food_and_guest_services", "human_resources", "program_and_project_management", "consulting",
  "community_and_social_services", "media_and_communication", "legal", "customer_success_and_support", "research",
  "quality_assurance", "business_development", "manufacturing_and_production", "real_estate",
  "military_and_protective_services", "purchasing", "arts_entertainment_and_performance", "sports_and_recreation",
  "energy_mining_and_utilities", "agriculture_forestry_and_animal_care", "beauty_and_personal_care", "product_management",
  "public_administration_and_government",
] as const;

/** leadsforge.people.search.filters.revenue_ranges values, 2026-10-06, smallest first. */
export const REVENUE_RANGES = [
  "very_small", "small_lower", "small_upper", "lower_mid_sized", "mid_sized_lower", "mid_sized_upper", "large_lower",
  "large_upper", "enterprise_lower", "enterprise_upper", "global_giants_lower", "global_giants_upper", "super_enterprises",
] as const;

export const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia",
  "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
] as const;

/** Employee bands we split along (the ICP's bands). */
const EMPLOYEE_BANDS: Array<{ min: number; max: number }> = [
  { min: 1, max: 10 }, { min: 11, max: 50 }, { min: 51, max: 200 }, { min: 201, max: 500 }, { min: 501, max: 1000 },
  { min: 1001, max: 5000 }, { min: 5001, max: 10000 }, { min: 10001, max: 10_000_000 },
];

type Include = { include: string[] };
export type LeadsforgeFilters = {
  /** Named companies (Add records -> target accounts): people at these domains only. */
  companyDomains?: Include;
  companyIndustries?: Include;
  companyLocations?: Include;
  companyEmployeeNumberRange?: { min?: number; max?: number };
  companyRevenueRanges?: string[];
  leadSeniorities?: Include;
  leadDepartments?: Include;
  /** Where the person is (free text country names), as against `companyLocations`. */
  leadLocations?: Include;
  maxContactsPerCompany?: number;
};

// ───────────────────────────── ICP -> filters ─────────────────────────────

/** ICP industry labels (LLM free text or PDL names) -> Leadsforge's exact industries. */
export { icpIndustriesToLeadsforge } from "./icpIndustries.ts";
import { icpIndustriesToLeadsforge } from "./icpIndustries.ts";

const LEVEL_TO_SENIORITY: Record<string, string> = {
  cxo: "c_suite", "c-suite": "c_suite", c_suite: "c_suite", executive: "c_suite", vp: "vp", director: "director",
  head: "head", manager: "manager", owner: "owner", founder: "founder", partner: "partner", senior: "senior",
};
/** Who to find when the ICP names no levels: the people who buy. */
const DEFAULT_SENIORITIES = ["c_suite", "vp", "head", "director"];

const DEPARTMENT_RULES: Array<[RegExp, string]> = [
  [/(revops|revenue|sales ?op)/, "operations"],
  [/sales/, "sales"],
  [/marketing|growth|demand/, "marketing"],
  [/operation/, "operations"],
  [/finance|fp&a/, "finance"],
  [/account/, "accounting"],
  [/customer (success|support)|support/, "customer_success_and_support"],
  [/business development|partnership/, "business_development"],
  [/engineer|technical|developer/, "engineering_technical"],
  [/\bit\b|information technology|security/, "information_technology"],
  [/product/, "product_management"],
  [/\bhr\b|people|human resources|talent/, "human_resources"],
  [/legal/, "legal"],
  [/procure|purchas/, "purchasing"],
  [/design/, "design"],
  [/research/, "research"],
];

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The ICP as one Leadsforge search. `countries` are lowercased country names
 * (researchPipeline.icpGeosToCountries); titles are left to ranking, not
 * filtering, because they narrow the search far more than levels do.
 */
export function icpToLeadsforge(icp: Icp, countries: string[]): LeadsforgeFilters {
  const f: LeadsforgeFilters = {};
  const industries = icpIndustriesToLeadsforge(icp.firmographics.industries);
  if (industries.length) f.companyIndustries = { include: industries };
  if (countries.length) f.companyLocations = { include: countries.map(titleCase) };
  const range = employeeBandsToRange(icp.firmographics.employeeBands);
  if (range.min !== undefined || range.max !== undefined) f.companyEmployeeNumberRange = range;
  const levels = [...new Set((icp.persona.jobLevels ?? []).map((l) => LEVEL_TO_SENIORITY[l.toLowerCase().trim()]).filter(Boolean))];
  f.leadSeniorities = { include: levels.length ? levels : DEFAULT_SENIORITIES };
  const depts = new Set<string>();
  for (const d of icp.persona.departments ?? []) {
    const hit = DEPARTMENT_RULES.find(([re]) => re.test(d.toLowerCase()));
    if (hit) depts.add(hit[1]);
  }
  if (depts.size) f.leadDepartments = { include: [...depts] };
  return f;
}

/** Wider searches to try, in order, when the ICP search finds too little. */
export function relaxLeadsforge(f: LeadsforgeFilters): LeadsforgeFilters[] {
  const steps = [f];
  for (const key of ["leadDepartments", "companyEmployeeNumberRange", "companyLocations"] as const) {
    if (!f[key]) continue;
    const next = { ...steps[steps.length - 1] };
    delete next[key];
    steps.push(next);
  }
  return steps;
}

// ───────────────────────────── Splitting ─────────────────────────────

function bandsWithin(range: { min?: number; max?: number } | undefined) {
  const lo = range?.min ?? 1;
  const hi = range?.max ?? 10_000_000;
  return EMPLOYEE_BANDS.filter((b) => b.max >= lo && b.min <= hi).map((b) => ({ min: Math.max(b.min, lo), max: Math.min(b.max, hi) }));
}

/**
 * Narrower searches that together cover `f`, or null when `f` cannot be split
 * further. One dimension per step, chosen from the filters themselves, so the
 * recursion always ends: several named domains -> two halves; several locations -> one each; the United States ->
 * one per state; several industries -> one each; a size range spanning bands -> one per band; several
 * seniorities -> one each; several departments -> one each; no revenue filter
 * -> one per revenue range.
 */
export function splitFilters(f: LeadsforgeFilters): LeadsforgeFilters[] | null {
  const domains = f.companyDomains?.include ?? [];
  if (domains.length > 1) {
    const half = Math.ceil(domains.length / 2);
    return [domains.slice(0, half), domains.slice(half)].map((include) => ({ ...f, companyDomains: { include } }));
  }
  const locations = f.companyLocations?.include ?? [];
  if (locations.length > 1) return locations.map((l) => ({ ...f, companyLocations: { include: [l] } }));
  if (locations.length === 1 && locations[0].toLowerCase() === "united states") {
    return US_STATES.map((s) => ({ ...f, companyLocations: { include: [s] } }));
  }
  // A company has one industry, so per-industry searches are disjoint.
  const industries = f.companyIndustries?.include ?? [];
  if (industries.length > 1) return industries.map((i) => ({ ...f, companyIndustries: { include: [i] } }));
  const bands = bandsWithin(f.companyEmployeeNumberRange);
  if (bands.length > 1) return bands.map((b) => ({ ...f, companyEmployeeNumberRange: b }));
  const seniorities = f.leadSeniorities?.include ?? [];
  if (seniorities.length > 1) return seniorities.map((s) => ({ ...f, leadSeniorities: { include: [s] } }));
  const depts = f.leadDepartments?.include ?? [];
  if (depts.length > 1) return depts.map((d) => ({ ...f, leadDepartments: { include: [d] } }));
  if (!f.companyRevenueRanges) return REVENUE_RANGES.map((r) => ({ ...f, companyRevenueRanges: [r] }));
  return null;
}

// ───────────────────────────── Search + records ─────────────────────────────

export type Lead = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  location?: { city?: string | null; state?: string | null; country?: string | null } | null;
  company?: {
    domain?: string | null;
    website?: string | null;
    employeeCount?: number | null;
    industry?: string | null;
    location?: { country?: string | null } | null;
  } | null;
};

export type LeadsforgePage = { leads: Lead[]; saturated: boolean; callId: string | null };

export async function searchLeads(opts: {
  token: string;
  filters: LeadsforgeFilters;
  meta: TregMeta;
  limit?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<LeadsforgePage> {
  const limit = opts.limit ?? SEARCH_MAX;
  const res = await tregCall({
    token: opts.token,
    endpoint: LEADSFORGE_SEARCH,
    body: { ...opts.filters, limit },
    meta: opts.meta,
    free: true,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  if (res.status !== 200) {
    throw new Error(`Leadsforge search failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  const body = res.body as { leads?: Lead[]; cursor?: string | null } | null;
  const leads = body?.leads ?? [];
  // A full page with a cursor means there is more than this search can return.
  return { leads, saturated: leads.length >= limit && Boolean(body?.cursor), callId: res.callId };
}

/** Leads -> people with a company domain (leads without one are dropped). */
export function leadsToPeople(leads: Lead[]): Person[] {
  const people: Person[] = [];
  for (const lead of leads) {
    const raw = lead.company?.domain || lead.company?.website;
    if (!raw) continue;
    const c = lead.company!;
    people.push({
      fullName: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim(),
      ...(lead.jobTitle ? { title: lead.jobTitle } : {}),
      company: {
        domain: normDomain(raw),
        ...(c.industry ? { industry: c.industry } : {}),
        ...(typeof c.employeeCount === "number" ? { employees: c.employeeCount } : {}),
        ...(c.location?.country ? { country: c.location.country.toLowerCase() } : {}),
      },
    });
  }
  return people;
}

/** Leads -> one account per company domain plus a contact per person. */
export function leadsToRecords(leads: Lead[]): { accounts: AccountInput[]; contacts: ContactInput[] } {
  const { accounts, contacts } = peopleToRecords(leadsToPeople(leads));
  return { accounts, contacts };
}

/**
 * The pre-signup TAM: one free search per relaxation step (one person per
 * company, so the page is as many distinct accounts as possible), stopping at
 * the first step that finds `minTam` accounts.
 */
export async function leadsforgeTam(opts: {
  token: string;
  icp: Icp;
  countries: string[];
  minTam: number;
  meta: TregMeta;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ rows: AccountInput[]; total: number; filter: Record<string, unknown>; saturated: boolean }> {
  let best: { rows: AccountInput[]; filters: LeadsforgeFilters; saturated: boolean } | null = null;
  for (const filters of relaxLeadsforge(icpToLeadsforge(opts.icp, opts.countries))) {
    const page = await searchLeads({ ...opts, filters: { ...filters, maxContactsPerCompany: 1 } });
    const rows = leadsToRecords(page.leads).accounts;
    if (!best || rows.length > best.rows.length) best = { rows, filters, saturated: page.saturated };
    if (rows.length >= opts.minTam) break;
  }
  const b = best!;
  return { rows: b.rows, total: b.rows.length, filter: { source: "leadsforge", filters: b.filters }, saturated: b.saturated };
}

/** Short stable key for a filter set (idempotency keys, logs). FNV-1a over canonical JSON. */
export function filtersKey(f: LeadsforgeFilters): string {
  const canon = JSON.stringify(f, Object.keys(f).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) h = Math.imul(h ^ canon.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}
