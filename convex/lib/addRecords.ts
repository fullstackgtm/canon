/**
 * Add records: the user drives the free population sources directly, either
 * with a list of companies they name or with a market they describe. Both
 * become an ICP-shaped spec, so they reuse the ICP -> Leadsforge/QuickEnrich
 * mappings population already runs on. Pure and Node-free (the UI imports it).
 */
import type { Icp } from "../../engine/src/icp.ts";
import { icpToLeadsforge, type LeadsforgeFilters } from "./leadsforge.ts";
import { excludeFromQuery, icpToQuickEnrich, type QuickEnrichQuery } from "./quickenrich.ts";
import { icpGeosToCountries } from "./researchPipeline.ts";
import { normDomain } from "./peopleSources.ts";
import type { IcpExclude } from "./icpSpec.ts";

/** Companies one run may name. */
export const MAX_TARGET_ACCOUNTS = 1000;
/** Domains per root search (a saturated Leadsforge search halves its list). */
export const DOMAINS_PER_SEARCH = 100;

export { EMPLOYEE_BANDS, LEVELS, DEPARTMENTS, canonDepartments, COUNTRIES } from "./icpVocabulary.ts";
import { EMPLOYEE_BANDS } from "./icpVocabulary.ts";

/** Who to find. Empty levels mean the buyers (C-suite, VP, Head, Director). `countries` is where they are located. */
export type Persona = { levels: string[]; departments: string[]; titles: string[]; countries?: string[] };
/** Where to look. `industries` are Leadsforge's exact values. */
export type Market = { industries: string[]; employeeBands: string[]; countries: string[] };
export type NamedAccount = { domain: string; name?: string };

const clean = (values: string[] | undefined, max = 40) => [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].slice(0, max);

export function specToIcp(market: Partial<Market>, persona: Partial<Persona>): Icp {
  return {
    name: "Add records",
    firmographics: {
      industries: clean(market.industries),
      employeeBands: clean(market.employeeBands).filter((b) => (EMPLOYEE_BANDS as readonly string[]).includes(b)),
      geos: clean(market.countries).map((c) => c.toLowerCase()),
    },
    persona: { jobLevels: clean(persona.levels), departments: clean(persona.departments), titleKeywords: clean(persona.titles) },
  };
}

/** Where the buyers must be, as country names ("India"): the market's countries say where the company is. */
export function personLocations(persona: Partial<Persona>): string[] {
  return icpGeosToCountries(clean(persona.countries).map((c) => c.toLowerCase())).map((c) => c.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()));
}

/** Both sources' searches narrowed to buyers located in the persona's countries. */
function withPersonLocations(q: { leadsforge: LeadsforgeFilters; quickenrich: QuickEnrichQuery }, persona: Partial<Persona>) {
  const where = personLocations(persona);
  if (!where.length) return q;
  return { leadsforge: { ...q.leadsforge, leadLocations: { include: where } }, quickenrich: { ...q.quickenrich, locality: { include: where, exclude: [] } } };
}

/** The market search as both sources' root queries. Exclusions narrow the QuickEnrich search, the one fills run. */
export function marketQueries(market: Partial<Market>, persona: Partial<Persona>, exclude?: IcpExclude): { leadsforge: LeadsforgeFilters; quickenrich: QuickEnrichQuery } {
  const icp = specToIcp(market, persona);
  return withPersonLocations({ leadsforge: icpToLeadsforge(icp, icpGeosToCountries(icp.firmographics.geos)), quickenrich: excludeFromQuery(icpToQuickEnrich(icp), exclude) }, persona);
}

/** A market search needs something to narrow it: an unfiltered search would pull every company in the index. */
export function marketIsNarrow(market: Partial<Market>): boolean {
  return clean(market.industries).length > 0 || clean(market.countries).length > 0 || clean(market.employeeBands).length > 0;
}

/** Searches for the people at named companies: persona filters only, one pair per chunk of domains. */
export function accountQueries(domains: string[], persona: Partial<Persona>, exclude?: IcpExclude): Array<{ leadsforge: LeadsforgeFilters; quickenrich: QuickEnrichQuery }> {
  const icp = specToIcp({}, persona);
  const lf = icpToLeadsforge(icp, []);
  // Named companies are wanted as named: only the persona's title exclusions apply.
  const qe = excludeFromQuery(icpToQuickEnrich(icp), exclude && { industries: [], countries: [], titles: exclude.titles });
  const out = [];
  for (let i = 0; i < domains.length; i += DOMAINS_PER_SEARCH) {
    const include = domains.slice(i, i + DOMAINS_PER_SEARCH);
    out.push(withPersonLocations({ leadsforge: { ...lf, companyDomains: { include } }, quickenrich: { ...qe, company_url: { include, exclude: [] } } }, persona));
  }
  return out;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One line's cells: split on commas, tabs or semicolons outside double quotes ("" is a literal quote). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\t" || ch === ";")) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Pasted text or a CSV -> named accounts. A line is a domain or URL, optionally
 * followed by a company name ("acme.com, Acme Inc"). A CSV with a header row
 * uses its domain/website column and its name/company column. Duplicates keep
 * the first name given; anything that isn't a domain is reported back.
 */
export function parseAccountList(text: string): { accounts: NamedAccount[]; invalid: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let domainCol = 0;
  let nameCol = 1;
  if (lines.length) {
    const header = cells(lines[0]).map((h) => h.toLowerCase());
    const d = header.findIndex((h) => /^(domain|website|url|company domain|company website)$/.test(h));
    if (d >= 0) {
      domainCol = d;
      nameCol = header.findIndex((h) => /^(name|company|company name|account|account name)$/.test(h));
      lines.shift();
    }
  }
  const byDomain = new Map<string, NamedAccount>();
  const invalid: string[] = [];
  for (const line of lines) {
    const row = cells(line);
    const raw = row[domainCol] ?? "";
    const domain = normDomain(raw);
    if (!DOMAIN_RE.test(domain)) {
      if (raw) invalid.push(raw.slice(0, 80));
      continue;
    }
    const name = nameCol >= 0 ? row[nameCol]?.slice(0, 120) : undefined;
    const prior = byDomain.get(domain);
    if (!prior) byDomain.set(domain, { domain, ...(name ? { name } : {}) });
    else if (!prior.name && name) prior.name = name;
  }
  return { accounts: [...byDomain.values()], invalid };
}
