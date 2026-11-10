/**
 * QuickEnrich people search through treg.to ("Contact Finder"): free
 * discovery, 100 people a page, about 0.7 s, cursor paging past the plan's
 * nominal 5 pages (observed 2026-10-06). Each person carries the company
 * domain, LinkedIn URL and firmographic ranges; no email or phone.
 */
import type { Icp } from "../../engine/src/icp.ts";
import { icpIndustriesToLeadsforge } from "./leadsforge.ts";
import { icpGeosToIso } from "./researchPipeline.ts";
import { tregCall, type TregMeta } from "./treg.ts";
import { peopleToRecords, type Person } from "./peopleSources.ts";
import type { AccountInput } from "./recordContract.ts";
import { NONE, seniorityOf } from "./staging.ts";
import type { IcpExclude } from "./icpSpec.ts";

export const QUICKENRICH_SEARCH = "quickenrich.people.search";
export const QE_PAGE = 100;

/** QuickEnrich's exact spellings of the Leadsforge industries (quickenrich.x.industries, 2026-10-06). */
const QE_INDUSTRIES: readonly string[] = ["Accounting", "Administration of Justice", "Advertising Services", "Airlines and Aviation", "Alternative Dispute Resolution", "Alternative Medicine", "Animation and Post-production", "Appliances, Electrical, and Electronics Manufacturing", "Architecture and Planning", "Armed Forces", "Artists and Writers", "Automation Machinery Manufacturing", "Aviation and Aerospace Component Manufacturing", "Banking", "Beverage Manufacturing", "Biotechnology Research", "Book and Periodical Publishing", "Broadcast Media Production and Distribution", "Business Consulting and Services", "Capital Markets", "Chemical Manufacturing", "Civic and Social Organizations", "Civil Engineering", "Computer and Network Security", "Computer Games", "Computer Hardware Manufacturing", "Computer Networking Products", "Computers and Electronics Manufacturing", "Construction", "Consumer Services", "Dairy Product Manufacturing", "Defense and Space Manufacturing", "Design Services", "Education Administration Programs", "E-Learning Providers", "Entertainment Providers", "Environmental Services", "Events Services", "Executive Offices", "Facilities Services", "Farming", "Financial Services", "Fisheries", "Food and Beverage Manufacturing", "Food and Beverage Services", "Freight and Package Transportation", "Fundraising", "Furniture and Home Furnishings Manufacturing", "Gambling Facilities and Casinos", "Glass, Ceramics and Concrete Manufacturing", "Government Administration", "Government Relations Services", "Graphic Design", "Higher Education", "Hospitality", "Hospitals and Health Care", "Human Resources Services", "Individual and Family Services", "Industrial Machinery Manufacturing", "Information Services", "Insurance", "International Affairs", "International Trade and Development", "Investment Banking", "Investment Management", "IT Services and IT Consulting", "Law Enforcement", "Law Practice", "Leasing Non-residential Real Estate", "Legal Services", "Legislative Offices", "Libraries", "Machinery Manufacturing", "Manufacturing", "Maritime Transportation", "Market Research", "Media Production", "Medical Equipment Manufacturing", "Medical Practices", "Mental Health Care", "Mining", "Mobile Gaming Apps", "Motor Vehicle Manufacturing", "Movies, Videos, and Sound", "Museums, Historical Sites, and Zoos", "Musicians", "Nanotechnology Research", "Newspaper Publishing", "Non-profit Organizations", "Oil and Gas", "Online Audio and Video Media", "Outsourcing and Offshoring Consulting", "Packaging and Containers Manufacturing", "Paper and Forest Product Manufacturing", "Performing Arts", "Personal Care Product Manufacturing", "Pharmaceutical Manufacturing", "Philanthropic Fundraising Services", "Photography", "Plastics Manufacturing", "Political Organizations", "Primary and Secondary Education", "Printing Services", "Professional Training and Coaching", "Public Policy Offices", "Public Relations and Communications Services", "Public Safety", "Railroad Equipment Manufacturing", "Ranching", "Real Estate", "Recreational Facilities", "Religious Institutions", "Research Services", "Restaurants", "Retail", "Retail Apparel and Fashion", "Retail Art Supplies", "Retail Groceries", "Retail Luxury Goods and Jewelry", "Retail Office Equipment", "Security and Investigations", "Semiconductor Manufacturing", "Shipbuilding", "Software Development", "Spectator Sports", "Sporting Goods Manufacturing", "Staffing and Recruiting", "Strategic Management Services", "Technology, Information and Internet", "Telecommunications", "Textile Manufacturing", "Think Tanks", "Tobacco Manufacturing", "Translation and Localization", "Transportation, Logistics, Supply Chain and Storage", "Travel Arrangements", "Truck Transportation", "Utilities", "Venture Capital and Private Equity Principals", "Veterinary Services", "Warehousing and Storage", "Wellness and Fitness Services", "Wholesale", "Wholesale Building Materials", "Wholesale Import and Export", "Wireless Services", "Writing and Editing"];
const QE_BY_LOWER = new Map(QE_INDUSTRIES.map((v) => [v.toLowerCase(), v]));
/** A Leadsforge industry value in QuickEnrich's spelling. */
export const qeIndustry = (leadsforge: string): string | undefined => QE_BY_LOWER.get(leadsforge);

/** quickenrich.x.employee-ranges, 2026-10-06, with their bounds. */
const QE_SIZES: Array<{ value: string; min: number; max: number }> = [
  { value: "< 5", min: 1, max: 4 }, { value: "5 - 19", min: 5, max: 19 }, { value: "20 - 99", min: 20, max: 99 },
  { value: "100 - 249", min: 100, max: 249 }, { value: "250 - 499", min: 250, max: 499 }, { value: "500 - 999", min: 500, max: 999 },
  { value: "1000 - 4999", min: 1000, max: 4999 }, { value: "5000 - 9999", min: 5000, max: 9999 }, { value: ">10000", min: 10000, max: 10_000_000 },
];

type Include = { include: string[]; exclude: string[] };
export type QuickEnrichQuery = {
  /** Named companies (Add records -> target accounts): people at these domains only. */
  company_url?: Include;
  title?: Include;
  industry_linkedin?: Include;
  number_of_employees?: Include;
  /** The company's HQ country, not the person's (checked live 2026-10-10). */
  country_code?: Include;
  /** Where the person is: free text such as "Bengaluru, Karnataka, India", matched by substring. */
  locality?: Include;
};

const inc = (values: string[]): Include => ({ include: values, exclude: [] });

const LEVEL_TITLES: Record<string, string[]> = {
  cxo: ["Chief"], "c-suite": ["Chief"], c_suite: ["Chief"], executive: ["Chief"], vp: ["VP", "Vice President"],
  director: ["Director"], head: ["Head of"], manager: ["Manager"], owner: ["Owner"], founder: ["Founder"], partner: ["Partner"],
};
const DEPT_WORDS: Array<[RegExp, string]> = [
  [/(revops|revenue)/, "Revenue"], [/sales ?op/, "Sales Operations"], [/sales/, "Sales"], [/marketing|demand/, "Marketing"],
  [/growth/, "Growth"], [/operation/, "Operations"], [/finance/, "Finance"], [/customer success/, "Customer Success"],
  [/business development|partnership/, "Business Development"], [/engineer/, "Engineering"], [/product/, "Product"],
  [/\bhr\b|people|talent/, "People"], [/\bit\b|information technology/, "IT"],
];

/**
 * Title phrases for the ICP: level x topic ("VP Sales", "Head of Compensation"), where the
 * topics are its departments and its keywords. QuickEnrich ORs the phrases, so a bare keyword
 * ("Compensation") would match every level: keywords are paired with the levels, and only
 * those that name a level themselves ("VP Sales", "CRO") are kept as they are.
 */
export function icpTitles(icp: Icp): string[] {
  const out = new Set<string>();
  const levels = (icp.persona.jobLevels?.length ? icp.persona.jobLevels : ["cxo", "vp", "head", "director"]).flatMap((l) => LEVEL_TITLES[l.toLowerCase()] ?? []);
  const topics = new Set<string>();
  for (const d of icp.persona.departments ?? []) {
    const hit = DEPT_WORDS.find(([re]) => re.test(d.toLowerCase()));
    if (hit) topics.add(hit[1]);
  }
  for (const keyword of (icp.persona.titleKeywords ?? []).map((t) => t.trim()).filter(Boolean)) {
    if (seniorityOf(keyword) !== NONE) out.add(keyword);
    else topics.add(keyword);
  }
  // Bare levels only when nothing narrows them: a keyword that names its own level already says who.
  const bare = !topics.size && !out.size;
  for (const level of levels) {
    if (bare) out.add(level === "Chief" ? "Chief Executive Officer" : level);
    for (const topic of topics) out.add(level === "Head of" ? `Head of ${topic}` : level === "Chief" ? `Chief ${topic} Officer` : `${level} ${topic}`);
  }
  return [...out].slice(0, 40);
}

/** A people search with an ICP's exclusions added (each field matches its include and exclude lists). */
export function excludeFromQuery(query: QuickEnrichQuery, exclude: IcpExclude | undefined): QuickEnrichQuery {
  if (!exclude) return query;
  const out: QuickEnrichQuery = { ...query };
  const add = (field: "title" | "industry_linkedin" | "country_code", values: string[]) => {
    if (!values.length) return;
    const prior = out[field] ?? { include: [], exclude: [] };
    out[field] = { include: prior.include, exclude: [...new Set([...prior.exclude, ...values])] };
  };
  add("title", exclude.titles.map((t) => t.trim()).filter(Boolean));
  add("industry_linkedin", icpIndustriesToLeadsforge(exclude.industries).map(qeIndustry).filter((v): v is string => Boolean(v)));
  add("country_code", icpGeosToIso(exclude.countries));
  return out;
}

export function icpToQuickEnrich(icp: Icp): QuickEnrichQuery {
  const q: QuickEnrichQuery = { title: inc(icpTitles(icp)) };
  const industries = icpIndustriesToLeadsforge(icp.firmographics.industries).map(qeIndustry).filter((v): v is string => Boolean(v));
  if (industries.length) q.industry_linkedin = inc(industries);
  const bands = icp.firmographics.employeeBands ?? [];
  if (bands.length) {
    const ranges = bands.map((b) => b.match(/^(\d+)(?:-(\d+)|\+)$/)).filter(Boolean).map((m) => ({ min: Number(m![1]), max: m![2] ? Number(m![2]) : 10_000_000 }));
    const sizes = QE_SIZES.filter((s) => ranges.some((r) => s.max >= r.min && s.min <= r.max)).map((s) => s.value);
    if (sizes.length) q.number_of_employees = inc(sizes);
  }
  // Codes, country names and regions ("North America") alike, as the other TAM paths read them.
  const countries = icpGeosToIso(icp.firmographics.geos);
  if (countries.length) q.country_code = inc(countries);
  return q;
}

type QeRow = {
  first_name?: string | null; last_name?: string | null; title?: string | null; headline?: string | null; employee_linkedin?: string | null;
  company_url?: string | null; company_name?: string | null; industry?: string | null; employee_count?: string | null;
  country_code?: string | null;
};

/**
 * ">10000" -> 10001, "1000 - 4999" -> 1001, "100 - 249" -> 100, "< 5" -> 1: the range's lower bound, so fit bands
 * match. A range starting at 500, 1000, 5000 or 10000 starts where an ICP band ends, so it takes the next band:
 * Northstar ("1000 - 4999") is in 1001-5000, not 501-1000.
 */
export function employeesFrom(range: string | null | undefined): number | undefined {
  if (!range) return undefined;
  const m = range.match(/(\d[\d,]*)/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return range.trim().startsWith("<") ? 1 : BAND_ENDS.has(n) ? n + 1 : n;
}
/** The ICP employee bands' upper ends (addRecords.ts EMPLOYEE_BANDS) that QuickEnrich ranges start at. */
const BAND_ENDS = new Set([500, 1000, 5000, 10000]);

const real = (v: string | null | undefined) => (v && v !== "N/A" && v !== "Not Available" ? v : undefined);

export function quickEnrichPeople(rows: QeRow[], countryName: (iso: string) => string | undefined): Person[] {
  const people: Person[] = [];
  for (const r of rows) {
    const domain = real(r.company_url);
    const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    if (!domain || !fullName) continue;
    const iso = real(r.country_code);
    people.push({
      fullName,
      ...(real(r.title) ? { title: r.title! } : {}),
      ...(real(r.headline) ? { headline: r.headline! } : {}),
      ...(real(r.employee_linkedin) ? { linkedinUrl: r.employee_linkedin!.replace(/^http:/, "https:") } : {}),
      company: {
        domain,
        ...(real(r.company_name) ? { name: r.company_name! } : {}),
        ...(real(r.industry) ? { industry: r.industry!.toLowerCase() } : {}),
        ...(employeesFrom(real(r.employee_count)) !== undefined ? { employees: employeesFrom(r.employee_count) } : {}),
        ...(iso && countryName(iso) ? { country: countryName(iso) } : {}),
      },
    });
  }
  return people;
}

export async function quickEnrichPage(opts: {
  token: string;
  query: QuickEnrichQuery;
  cursor?: string | null;
  meta: TregMeta;
  countryName: (iso: string) => string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ people: Person[]; next: string | null; total: number | null; rateRemaining: number | null }> {
  const res = await tregCall({
    token: opts.token,
    endpoint: QUICKENRICH_SEARCH,
    body: { ...opts.query, per_page: QE_PAGE, ...(opts.cursor ? { cursor: opts.cursor } : { page: 1 }) },
    meta: opts.meta,
    free: true,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  if (res.status !== 200) throw new Error(`QuickEnrich search failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  const body = res.body as { data?: QeRow[]; meta?: { next_cursor?: string | null; has_more?: boolean; total?: number } } | null;
  const rows = body?.data ?? [];
  const next = body?.meta?.has_more && body.meta.next_cursor && rows.length ? body.meta.next_cursor : null;
  return { people: quickEnrichPeople(rows, opts.countryName), next, total: body?.meta?.total ?? null, rateRemaining: res.rateRemaining };
}

/** Above this many matches a query is split so its slices page in parallel. */
export const QE_SPLIT_ABOVE = 2_000;

/**
 * Disjoint narrower queries covering `q`, one dimension at a time (country,
 * then size range, then industry), or null when every dimension is single.
 * Titles are never split: one person can match several title phrases.
 */
export function splitQuickEnrich(q: QuickEnrichQuery): QuickEnrichQuery[] | null {
  for (const key of ["country_code", "number_of_employees", "industry_linkedin"] as const) {
    // Each child keeps the field's exclusions, and a value the field also excludes gets no child.
    const exclude = q[key]?.exclude ?? [];
    const values = (q[key]?.include ?? []).filter((v) => !exclude.includes(v));
    if (values.length > 1) return values.map((value) => ({ ...q, [key]: { include: [value], exclude } }));
  }
  return null;
}

/** The pre-signup TAM from QuickEnrich (the fallback when Leadsforge is out): up to `pages` pages, distinct companies. */
export async function quickEnrichTam(opts: {
  token: string;
  icp: Icp;
  meta: TregMeta;
  countryName: (iso: string) => string | undefined;
  pages?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ rows: AccountInput[]; total: number; filter: Record<string, unknown>; saturated: boolean }> {
  const query = icpToQuickEnrich(opts.icp);
  const people: Person[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < (opts.pages ?? 3); i++) {
    const page = await quickEnrichPage({ ...opts, query, cursor });
    people.push(...page.people);
    cursor = page.next;
    if (!cursor) break;
  }
  const rows = peopleToRecords(people).accounts;
  return { rows, total: rows.length, filter: { source: "quickenrich", query }, saturated: Boolean(cursor) };
}
