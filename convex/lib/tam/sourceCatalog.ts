import { icpGeosToIso } from "../../../modules/kernel/icpGeography.ts";
import { INDUSTRIES, canonIndustry, type IndustryKey } from "../../../modules/kernel/industries.ts";

export const SOURCE_KINDS = ["registry", "directory", "marketplace", "award_list", "license_board", "association"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export type CatalogSource = {
  id: string; name: string; url: string; kinds: SourceKind[]; markets: IndustryKey[]; countries?: string[];
  method: "api" | "export" | "search" | "page"; dedupeKey?: "registryId" | "address" | "domain" | "linkedin";
  termsNote: string; scrapeAllowed: boolean;
};
const all = INDUSTRIES.map((i) => i.key);
function markets(...names: string[]): IndustryKey[] {
  return names.map((name) => { const key = canonIndustry(name); if (!key) throw new Error(`Unknown catalog industry: ${name}`); return key; });
}
const contractors = markets("construction", "civil engineering", "defense and space manufacturing", "it services and it consulting", "facilities services");
const software = markets("software development", "technology, information and internet");
export const SOURCE_CATALOG_VERSION = 1;
export const SOURCE_CATALOG: readonly CatalogSource[] = [
  { id: "usaspending", name: "USAspending.gov", url: "https://www.usaspending.gov/", kinds: ["award_list"], markets: contractors, countries: ["US"], method: "api", dedupeKey: "registryId", termsNote: "Use the public API at https://api.usaspending.gov/docs/ and its downloads.", scrapeAllowed: true },
  { id: "sam", name: "SAM.gov entities", url: "https://sam.gov/entity-information", kinds: ["registry"], markets: contractors, countries: ["US"], method: "api", dedupeKey: "registryId", termsNote: "Unique Entity ID (UEI). Use the authorized entity API or public extracts; restricted fields require access.", scrapeAllowed: false },
  { id: "state-procurement", name: "State procurement portals", url: "https://www.usa.gov/state-purchasing", kinds: ["award_list", "registry"], markets: contractors, countries: ["US"], method: "search", dedupeKey: "registryId", termsNote: 'Search "<state> procurement portal" or "<state> bid awards". Check each portal’s terms before automation.', scrapeAllowed: false },
  { id: "edgar", name: "SEC EDGAR", url: "https://www.sec.gov/edgar/search/", kinds: ["registry"], markets: all, countries: ["US"], method: "api", dedupeKey: "registryId", termsNote: "Use data.sec.gov APIs with a declared User-Agent and SEC fair-access limits. CIK identifies filers.", scrapeAllowed: true },
  { id: "thomasnet", name: "Thomasnet", url: "https://www.thomasnet.com/", kinds: ["directory"], markets: markets("manufacturing", "wholesale", "industrial machinery manufacturing", "construction"), method: "page", dedupeKey: "domain", termsNote: "Browse only. https://www.thomasnet.com/terms prohibits scraping and data-mining tools.", scrapeAllowed: false },
  { id: "getlatka", name: "GetLatka", url: "https://getlatka.com/", kinds: ["directory"], markets: software, method: "page", dedupeKey: "domain", termsNote: "Browse only until permission for automated reuse is established.", scrapeAllowed: false },
  { id: "clutch", name: "Clutch", url: "https://clutch.co/", kinds: ["directory"], markets: markets("it services and it consulting", "advertising services", "business consulting and services", "software development"), method: "page", dedupeKey: "domain", termsNote: "Browse only. https://clutch.co/terms restricts automated extraction; API terms restrict bulk download and retention.", scrapeAllowed: false },
  { id: "g2", name: "G2", url: "https://www.g2.com/", kinds: ["marketplace"], markets: software, method: "page", dedupeKey: "domain", termsNote: "Browse only. https://legal.g2.com/community-guidelines requires permission for automated collection.", scrapeAllowed: false },
  { id: "crunchbase", name: "Crunchbase", url: "https://www.crunchbase.com/", kinds: ["directory"], markets: all, method: "export", dedupeKey: "domain", termsNote: "Browse only. Licensed exports have reuse restrictions. https://about.crunchbase.com/terms-of-service", scrapeAllowed: false },
  { id: "bbb", name: "Better Business Bureau", url: "https://www.bbb.org/", kinds: ["directory"], markets: all, countries: ["US", "CA"], method: "page", dedupeKey: "address", termsNote: "Browse only until permission for automated reuse is established.", scrapeAllowed: false },
  { id: "contractor-licenses", name: "State contractor licensing boards", url: "https://www.usa.gov/licenses", kinds: ["license_board"], markets: markets("construction", "civil engineering", "facilities services"), countries: ["US"], method: "search", dedupeKey: "registryId", termsNote: 'Search "<state> contractor license lookup". License numbers identify contractors; check the board’s terms before automation.', scrapeAllowed: false },
];

export function catalogForMarket(market: { industry?: string[]; country?: string[] }): CatalogSource[] {
  const keys = (market.industry ?? []).map(canonIndustry).filter(Boolean);
  const countries = icpGeosToIso(market.country);
  return SOURCE_CATALOG.filter((s) => (!keys.length || s.markets.some((m) => keys.includes(m))) && (!s.countries || !countries.length || s.countries.some((c) => countries.includes(c))));
}

export function catalogAllowsFetch(url: string): boolean {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return !SOURCE_CATALOG.some((s) => {
    const sourceHost = new URL(s.url).hostname.replace(/^www\./, "");
    return !s.scrapeAllowed && (host === sourceHost || host.endsWith(`.${sourceHost}`));
  });
}
