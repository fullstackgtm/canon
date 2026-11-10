/**
 * Paid people searches on treg that pass the acceptable-record bar: a full
 * last name, a LinkedIn profile URL and the company's domain on every row we
 * keep. Each one maps the Add records market and persona to its own request
 * and its rows to one shape, so a capped test run can score it against that
 * bar. Prices are treg's catalog rates, checked live on 2026-10-09; what a run
 * really costs is what treg meters (`X-Treg-Cost-Micro`), never this estimate.
 *
 * Leadsforge (no LinkedIn URLs), Exa (no company domain) and Lusha (metered
 * at ~25x its catalog price) are deliberately absent.
 */
import { icpToQuickEnrich } from "./quickenrich.ts";
import { icpGeosToCountries } from "./researchPipeline.ts";
import { normDomain } from "./peopleSources.ts";
import { specToIcp, type Market, type Persona } from "./addRecords.ts";

export type PaidPerson = {
  firstName: string;
  lastName: string;
  title?: string;
  linkedinUrl?: string;
  companyName?: string;
  companyDomain?: string;
};

export type PaidProvider = {
  id: "icypeas" | "prospeo" | "crustdata";
  label: string;
  endpoint: string;
  /** Catalog estimate, USD per returned record. */
  usdPerRecord: number;
  /** One line on what it is good and less good at, shown in the catalog. */
  note: string;
  /** The request for up to `size` people in the market. */
  /** Records one page of a full run asks for (the page's price is this times usdPerRecord). */
  pageSize: number;
  /** The request for up to `size` people in the market; `cursor` continues a run from the previous page. */
  body: (market: Partial<Market>, persona: Partial<Persona>, size: number, cursor?: string | null) => unknown;
  /** How many people the search has in all (null when the provider can't say), and the next page's cursor. */
  page: (body: unknown) => { total: number | null; next: string | null };
  rows: (body: unknown) => PaidPerson[];
};

/** Records one test run asks for: enough to judge quality, cheap enough to give away. */
export const TEST_SIZE = 25;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const domainOf = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const d = normDomain(s);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : undefined;
};
const splitName = (full: string | undefined): { firstName: string; lastName: string } => {
  const parts = (full ?? "").trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.length > 1 ? parts[parts.length - 1] : "" };
};

/** The bar: a full (not abbreviated or masked) last name, a LinkedIn profile URL, the company's domain. */
export function acceptable(p: PaidPerson): boolean {
  const last = p.lastName.replace(/\.$/, "");
  return last.length > 1 && !/\*/.test(last) && /linkedin\.com\/in\//i.test(p.linkedinUrl ?? "") && Boolean(p.companyDomain);
}

/** The market as QuickEnrich's vocabulary already has it: LinkedIn industries, ISO countries, title phrases. */
function spec(market: Partial<Market>, persona: Partial<Persona>) {
  const qe = icpToQuickEnrich(specToIcp(market, persona));
  const iso = qe.country_code?.include ?? [];
  const bands = (market.employeeBands ?? []).map((b) => b.match(/^(\d+)(?:-(\d+)|\+)$/)).filter((m): m is RegExpMatchArray => Boolean(m));
  // These searches filter on where the person is: the buyers' countries when the ICP names them, else the market's.
  const buyers = (persona.countries ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  return {
    titles: (qe.title?.include ?? []).slice(0, 12),
    industries: qe.industry_linkedin?.include ?? [],
    countries: icpGeosToCountries(buyers.length ? buyers : iso.map((c) => c.toLowerCase())),
    companyCountries: icpGeosToCountries(iso.map((c) => c.toLowerCase())),
    buyerCountries: icpGeosToCountries(buyers),
    minEmployees: bands.length ? Math.min(...bands.map((m) => Number(m[1]))) : undefined,
    maxEmployees: bands.length && bands.every((m) => m[2]) ? Math.max(...bands.map((m) => Number(m[2]))) : undefined,
  };
}

/** Our employee bands as Prospeo's headcount ranges (51-100 and 101-200 checked live 2026-10-09). */
const PROSPEO_HEADCOUNT: Record<string, string[]> = {
  "1-10": ["1-10"], "11-50": ["11-20", "21-50"], "51-200": ["51-100", "101-200"], "201-500": ["201-500"], "501-1000": ["501-1000"],
  "1001-5000": ["1001-2000", "2001-5000"], "5001-10000": ["5001-10000"], "10001+": ["10000+"],
};

export const PAID_PROVIDERS: PaidProvider[] = [
  {
    id: "icypeas",
    label: "Icypeas",
    endpoint: "icypeas.people.search",
    usdPerRecord: 0.00038,
    note: "Cheapest per record. LinkedIn-sourced profiles with the current company's website.",
    pageSize: 100,
    body: (market, persona, size, cursor) => {
      const s = spec(market, persona);
      const query: Record<string, unknown> = { currentJobTitle: { include: s.titles } };
      if (s.countries.length) query.location = { include: s.countries };
      if (s.industries.length) query["currentCompany.industry"] = { include: s.industries };
      if (s.minEmployees !== undefined || s.maxEmployees !== undefined) {
        query["currentCompany.headcount"] = { ...(s.minEmployees !== undefined ? { ">=": s.minEmployees } : {}), ...(s.maxEmployees !== undefined ? { "<=": s.maxEmployees } : {}) };
      }
      return { query, pagination: { size, ...(cursor ? { token: cursor } : {}) } };
    },
    page: (body) => {
      const b = body as { total?: number; leads?: unknown[]; pagination?: { token?: string } };
      // The last page still carries a token; an empty page means the search is done.
      return { total: typeof b?.total === "number" ? b.total : null, next: b?.leads?.length ? b.pagination?.token ?? null : null };
    },
    rows: (body) => ((body as { leads?: unknown[] })?.leads ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        firstName: str(o.firstname) ?? "", lastName: str(o.lastname) ?? "", title: str(o.lastJobTitle),
        linkedinUrl: str(o.profileUrl), companyName: str(o.lastCompanyName), companyDomain: domainOf(o.lastCompanyWebsite),
      };
    }),
  },
  {
    id: "prospeo",
    label: "Prospeo",
    endpoint: "prospeo.people.search",
    usdPerRecord: 0.00098,
    note: "Fixed 25-person pages at one price; strong LinkedIn and domain coverage.",
    pageSize: 25,
    body: (market, persona, _size, cursor) => {
      const s = spec(market, persona);
      const filters: Record<string, unknown> = { person_job_title: { include: s.titles, match_mode: "CONTAINS" } };
      if (s.countries.length) filters.person_location_search = { include: s.countries };
      if (s.industries.length) filters.company_industry = { include: s.industries };
      const headcount = (market.employeeBands ?? []).flatMap((b) => PROSPEO_HEADCOUNT[b] ?? []);
      if (headcount.length) filters.company_headcount_range = headcount;
      return { page: cursor ? Number(cursor) : 1, filters };
    },
    page: (body) => {
      const p = (body as { pagination?: { current_page?: number; total_page?: number; total_count?: number } })?.pagination;
      const current = p?.current_page ?? 1;
      return { total: p?.total_count ?? null, next: p?.total_page && current < Math.min(p.total_page, 1000) ? String(current + 1) : null };
    },
    rows: (body) => ((body as { results?: unknown[] })?.results ?? []).map((r) => {
      const o = r as { person?: Record<string, unknown>; company?: Record<string, unknown> };
      const p = o.person ?? {};
      const c = o.company ?? {};
      const names = str(p.last_name) ? { firstName: str(p.first_name) ?? "", lastName: str(p.last_name)! } : splitName(str(p.full_name));
      return {
        ...names, title: str(p.current_job_title), linkedinUrl: str(p.linkedin_url),
        companyName: str(c.name), companyDomain: domainOf(c.domain) ?? domainOf(c.website),
      };
    }),
  },
  {
    id: "crustdata",
    label: "Crustdata",
    endpoint: "crustdata.people.search",
    usdPerRecord: 0.009,
    note: "Takes the market in plain words and ranks by fit; the priciest of the three.",
    pageSize: 100,
    body: (market, persona, size, cursor) => {
      const s = spec(market, persona);
      const size_ = s.minEmployees !== undefined ? ` with ${s.minEmployees}${s.maxEmployees !== undefined ? `-${s.maxEmployees}` : "+"} employees` : "";
      // Plain words name both places, so buyers in one country at companies in another read right.
      const where = s.buyerCountries.length
        ? `${s.companyCountries.length ? ` headquartered in ${s.companyCountries.join(", ")}` : ""}, the people based in ${s.buyerCountries.join(", ")}`
        : s.countries.length ? ` in ${s.countries.join(", ")}` : "";
      const industry = s.industries.length ? ` ${s.industries.slice(0, 4).join(" or ")}` : "";
      return { search: { query: `${s.titles.slice(0, 4).join(" or ")} at${industry} companies${size_}${where}` }, limit: size, ...(cursor ? { cursor } : {}) };
    },
    // A plain-words search ranks everyone, so its total is not a market size: the run's cap bounds it.
    page: (body) => {
      const b = body as { profiles?: unknown[]; next_cursor?: string | null };
      return { total: null, next: b?.profiles?.length ? b.next_cursor ?? null : null };
    },
    rows: (body) => ((body as { profiles?: unknown[] })?.profiles ?? []).map((r) => {
      const o = r as { basic_profile?: Record<string, unknown>; social_handles?: Record<string, Record<string, unknown>>; experience?: { employment_details?: { current?: Array<Record<string, unknown>> } } };
      const job = o.experience?.employment_details?.current?.[0] ?? {};
      return {
        ...splitName(str(o.basic_profile?.name)), title: str(o.basic_profile?.current_title),
        linkedinUrl: str(o.social_handles?.professional_network_identifier?.profile_url),
        companyName: str(job.name) ?? str(job.company_name), companyDomain: domainOf(job.company_website),
      };
    }),
  },
];

/**
 * The person's title is the buyer asked for: every word (but "of", "and") of
 * one persona title phrase appears in it ("VP Sales" matches "VP of Sales").
 */
export function onTarget(p: PaidPerson, market: Partial<Market>, persona: Partial<Persona>): boolean {
  const title = ` ${(p.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return spec(market, persona).titles.some((phrase) => {
    const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "of" && w !== "and");
    return words.length > 0 && words.every((w) => title.includes(` ${w} `));
  });
}

export const paidProvider = (id: string): PaidProvider | undefined => PAID_PROVIDERS.find((p) => p.id === id);
