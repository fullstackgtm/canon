// Canonical industries (contract 1.17.0): one list every source maps onto exactly, so an
// ICP, a filter and a treemap tile mean the same accounts whichever source wrote them.
// The canonical list is LinkedIn's 2022 industry names, the ones Leadsforge and QuickEnrich
// search by; PDL, HubSpot and older CRMs use LinkedIn's earlier names, mapped here one to
// one from LinkedIn's rename. Matching is on a normalized form (lowercase, "&", "/", ",",
// "_" and "-" as spaces, "and" dropped), never on patterns: a value no table names stays
// itself, marked unmapped (UNMAPPED_PREFIX), and is never folded into a neighbour.
// Pure and import-free: the service turns it into SQL (industryKeySql); Convex and the UI
// import it directly, like dimensions.ts.

export type IndustryKey = string;

/** [key, label]: the key is the lowercase LinkedIn 2022 name (Leadsforge's value), the label QuickEnrich's spelling. */
const CANONICAL: ReadonlyArray<readonly [IndustryKey, string]> = [
  ["accounting", "Accounting"],
  ["administration of justice", "Administration of Justice"],
  ["advertising services", "Advertising Services"],
  ["airlines and aviation", "Airlines and Aviation"],
  ["alternative dispute resolution", "Alternative Dispute Resolution"],
  ["alternative medicine", "Alternative Medicine"],
  ["animation and post-production", "Animation and Post-production"],
  ["appliances, electrical, and electronics manufacturing", "Appliances, Electrical, and Electronics Manufacturing"],
  ["architecture and planning", "Architecture and Planning"],
  ["armed forces", "Armed Forces"],
  ["artists and writers", "Artists and Writers"],
  ["automation machinery manufacturing", "Automation Machinery Manufacturing"],
  ["aviation and aerospace component manufacturing", "Aviation and Aerospace Component Manufacturing"],
  ["banking", "Banking"],
  ["beverage manufacturing", "Beverage Manufacturing"],
  ["biotechnology research", "Biotechnology Research"],
  ["book and periodical publishing", "Book and Periodical Publishing"],
  ["broadcast media production and distribution", "Broadcast Media Production and Distribution"],
  ["business consulting and services", "Business Consulting and Services"],
  ["capital markets", "Capital Markets"],
  ["chemical manufacturing", "Chemical Manufacturing"],
  ["civic and social organizations", "Civic and Social Organizations"],
  ["civil engineering", "Civil Engineering"],
  ["computer and network security", "Computer and Network Security"],
  ["computer games", "Computer Games"],
  ["computer hardware manufacturing", "Computer Hardware Manufacturing"],
  ["computer networking products", "Computer Networking Products"],
  ["computers and electronics manufacturing", "Computers and Electronics Manufacturing"],
  ["construction", "Construction"],
  ["consumer services", "Consumer Services"],
  ["dairy product manufacturing", "Dairy Product Manufacturing"],
  ["defense and space manufacturing", "Defense and Space Manufacturing"],
  ["design services", "Design Services"],
  ["e-learning providers", "E-Learning Providers"],
  ["education administration programs", "Education Administration Programs"],
  ["entertainment providers", "Entertainment Providers"],
  ["environmental services", "Environmental Services"],
  ["events services", "Events Services"],
  ["executive offices", "Executive Offices"],
  ["facilities services", "Facilities Services"],
  ["farming", "Farming"],
  ["financial services", "Financial Services"],
  ["fisheries", "Fisheries"],
  ["food and beverage manufacturing", "Food and Beverage Manufacturing"],
  ["food and beverage services", "Food and Beverage Services"],
  ["freight and package transportation", "Freight and Package Transportation"],
  ["fundraising", "Fundraising"],
  ["furniture and home furnishings manufacturing", "Furniture and Home Furnishings Manufacturing"],
  ["gambling facilities and casinos", "Gambling Facilities and Casinos"],
  ["glass, ceramics and concrete manufacturing", "Glass, Ceramics and Concrete Manufacturing"],
  ["government administration", "Government Administration"],
  ["government relations services", "Government Relations Services"],
  ["graphic design", "Graphic Design"],
  ["higher education", "Higher Education"],
  ["hospitality", "Hospitality"],
  ["hospitals and health care", "Hospitals and Health Care"],
  ["human resources services", "Human Resources Services"],
  ["individual and family services", "Individual and Family Services"],
  ["industrial machinery manufacturing", "Industrial Machinery Manufacturing"],
  ["information services", "Information Services"],
  ["insurance", "Insurance"],
  ["international affairs", "International Affairs"],
  ["international trade and development", "International Trade and Development"],
  ["investment banking", "Investment Banking"],
  ["investment management", "Investment Management"],
  ["it services and it consulting", "IT Services and IT Consulting"],
  ["law enforcement", "Law Enforcement"],
  ["law practice", "Law Practice"],
  ["leasing non-residential real estate", "Leasing Non-residential Real Estate"],
  ["legal services", "Legal Services"],
  ["legislative offices", "Legislative Offices"],
  ["libraries", "Libraries"],
  ["machinery manufacturing", "Machinery Manufacturing"],
  ["manufacturing", "Manufacturing"],
  ["maritime transportation", "Maritime Transportation"],
  ["market research", "Market Research"],
  ["media production", "Media Production"],
  ["medical equipment manufacturing", "Medical Equipment Manufacturing"],
  ["medical practices", "Medical Practices"],
  ["mental health care", "Mental Health Care"],
  ["mining", "Mining"],
  ["mobile gaming apps", "Mobile Gaming Apps"],
  ["motor vehicle manufacturing", "Motor Vehicle Manufacturing"],
  ["movies, videos, and sound", "Movies, Videos, and Sound"],
  ["museums, historical sites, and zoos", "Museums, Historical Sites, and Zoos"],
  ["musicians", "Musicians"],
  ["nanotechnology research", "Nanotechnology Research"],
  ["newspaper publishing", "Newspaper Publishing"],
  ["non-profit organizations", "Non-profit Organizations"],
  ["oil and gas", "Oil and Gas"],
  ["online audio and video media", "Online Audio and Video Media"],
  ["outsourcing and offshoring consulting", "Outsourcing and Offshoring Consulting"],
  ["packaging and containers manufacturing", "Packaging and Containers Manufacturing"],
  ["paper and forest product manufacturing", "Paper and Forest Product Manufacturing"],
  ["performing arts", "Performing Arts"],
  ["personal care product manufacturing", "Personal Care Product Manufacturing"],
  ["pharmaceutical manufacturing", "Pharmaceutical Manufacturing"],
  ["philanthropic fundraising services", "Philanthropic Fundraising Services"],
  ["photography", "Photography"],
  ["plastics manufacturing", "Plastics Manufacturing"],
  ["political organizations", "Political Organizations"],
  ["primary and secondary education", "Primary and Secondary Education"],
  ["printing services", "Printing Services"],
  ["professional training and coaching", "Professional Training and Coaching"],
  ["public policy offices", "Public Policy Offices"],
  ["public relations and communications services", "Public Relations and Communications Services"],
  ["public safety", "Public Safety"],
  ["railroad equipment manufacturing", "Railroad Equipment Manufacturing"],
  ["ranching", "Ranching"],
  ["real estate", "Real Estate"],
  ["recreational facilities", "Recreational Facilities"],
  ["religious institutions", "Religious Institutions"],
  ["renewable energy semiconductor manufacturing", "Renewable Energy Semiconductor Manufacturing"],
  ["research services", "Research Services"],
  ["restaurants", "Restaurants"],
  ["retail", "Retail"],
  ["retail apparel and fashion", "Retail Apparel and Fashion"],
  ["retail art supplies", "Retail Art Supplies"],
  ["retail groceries", "Retail Groceries"],
  ["retail luxury goods and jewelry", "Retail Luxury Goods and Jewelry"],
  ["retail office equipment", "Retail Office Equipment"],
  ["security and investigations", "Security and Investigations"],
  ["semiconductor manufacturing", "Semiconductor Manufacturing"],
  ["shipbuilding", "Shipbuilding"],
  ["software development", "Software Development"],
  ["spectator sports", "Spectator Sports"],
  ["sporting goods manufacturing", "Sporting Goods Manufacturing"],
  ["staffing and recruiting", "Staffing and Recruiting"],
  ["strategic management services", "Strategic Management Services"],
  ["technology, information and internet", "Technology, Information and Internet"],
  ["telecommunications", "Telecommunications"],
  ["textile manufacturing", "Textile Manufacturing"],
  ["think tanks", "Think Tanks"],
  ["tobacco manufacturing", "Tobacco Manufacturing"],
  ["translation and localization", "Translation and Localization"],
  ["transportation, logistics, supply chain and storage", "Transportation, Logistics, Supply Chain and Storage"],
  ["travel arrangements", "Travel Arrangements"],
  ["truck transportation", "Truck Transportation"],
  ["utilities", "Utilities"],
  ["venture capital and private equity principals", "Venture Capital and Private Equity Principals"],
  ["veterinary services", "Veterinary Services"],
  ["warehousing and storage", "Warehousing and Storage"],
  ["wellness and fitness services", "Wellness and Fitness Services"],
  ["wholesale", "Wholesale"],
  ["wholesale building materials", "Wholesale Building Materials"],
  ["wholesale import and export", "Wholesale Import and Export"],
  ["wireless services", "Wireless Services"],
  ["writing and editing", "Writing and Editing"],
];

/** LinkedIn's earlier names (PDL's index; HubSpot's enum normalizes to these) -> canonical. */
const EARLIER_NAMES: ReadonlyArray<readonly [string, IndustryKey]> = [
  ["accounting", "accounting"],
  ["airlines/aviation", "airlines and aviation"],
  ["alternative dispute resolution", "alternative dispute resolution"],
  ["alternative medicine", "alternative medicine"],
  ["animation", "animation and post-production"],
  ["apparel & fashion", "retail apparel and fashion"],
  ["architecture & planning", "architecture and planning"],
  ["arts and crafts", "retail art supplies"],
  ["automotive", "motor vehicle manufacturing"],
  ["aviation & aerospace", "aviation and aerospace component manufacturing"],
  ["banking", "banking"],
  ["biotechnology", "biotechnology research"],
  ["broadcast media", "broadcast media production and distribution"],
  ["building materials", "wholesale building materials"],
  ["business supplies and equipment", "retail office equipment"],
  ["capital markets", "capital markets"],
  ["chemicals", "chemical manufacturing"],
  ["civic & social organization", "civic and social organizations"],
  ["civil engineering", "civil engineering"],
  ["commercial real estate", "leasing non-residential real estate"],
  ["computer & network security", "computer and network security"],
  ["computer games", "computer games"],
  ["computer hardware", "computer hardware manufacturing"],
  ["computer networking", "computer networking products"],
  ["computer software", "software development"],
  ["construction", "construction"],
  ["consumer electronics", "computers and electronics manufacturing"],
  ["consumer goods", "manufacturing"],
  ["consumer services", "consumer services"],
  ["cosmetics", "personal care product manufacturing"],
  ["dairy", "dairy product manufacturing"],
  ["defense & space", "defense and space manufacturing"],
  ["design", "design services"],
  ["e-learning", "e-learning providers"],
  ["education management", "education administration programs"],
  ["electrical/electronic manufacturing", "appliances, electrical, and electronics manufacturing"],
  ["entertainment", "entertainment providers"],
  ["environmental services", "environmental services"],
  ["events services", "events services"],
  ["executive office", "executive offices"],
  ["facilities services", "facilities services"],
  ["farming", "farming"],
  ["financial services", "financial services"],
  ["fine art", "artists and writers"],
  ["fishery", "fisheries"],
  ["food & beverages", "food and beverage services"],
  ["food production", "food and beverage manufacturing"],
  ["fund-raising", "fundraising"],
  ["furniture", "furniture and home furnishings manufacturing"],
  ["gambling & casinos", "gambling facilities and casinos"],
  ["glass, ceramics & concrete", "glass, ceramics and concrete manufacturing"],
  ["government administration", "government administration"],
  ["government relations", "government relations services"],
  ["graphic design", "graphic design"],
  ["health, wellness and fitness", "wellness and fitness services"],
  ["higher education", "higher education"],
  ["hospital & health care", "hospitals and health care"],
  ["hospitality", "hospitality"],
  ["human resources", "human resources services"],
  ["import and export", "wholesale import and export"],
  ["individual & family services", "individual and family services"],
  ["industrial automation", "automation machinery manufacturing"],
  ["information services", "information services"],
  ["information technology and services", "it services and it consulting"],
  ["insurance", "insurance"],
  ["international affairs", "international affairs"],
  ["international trade and development", "international trade and development"],
  ["internet", "technology, information and internet"],
  ["investment banking", "investment banking"],
  ["investment management", "investment management"],
  ["judiciary", "administration of justice"],
  ["law enforcement", "law enforcement"],
  ["law practice", "law practice"],
  ["legal services", "legal services"],
  ["legislative office", "legislative offices"],
  ["leisure, travel & tourism", "travel arrangements"],
  ["libraries", "libraries"],
  ["logistics and supply chain", "transportation, logistics, supply chain and storage"],
  ["luxury goods & jewelry", "retail luxury goods and jewelry"],
  ["machinery", "industrial machinery manufacturing"],
  ["management consulting", "business consulting and services"],
  ["maritime", "maritime transportation"],
  ["market research", "market research"],
  ["marketing and advertising", "advertising services"],
  ["mechanical or industrial engineering", "industrial machinery manufacturing"],
  ["media production", "media production"],
  ["medical devices", "medical equipment manufacturing"],
  ["medical practice", "medical practices"],
  ["mental health care", "mental health care"],
  ["military", "armed forces"],
  ["mining & metals", "mining"],
  ["motion pictures and film", "movies, videos, and sound"],
  ["museums and institutions", "museums, historical sites, and zoos"],
  ["music", "musicians"],
  ["nanotechnology", "nanotechnology research"],
  ["newspapers", "newspaper publishing"],
  ["non-profit organization management", "non-profit organizations"],
  ["oil & energy", "oil and gas"],
  ["online media", "online audio and video media"],
  ["outsourcing/offshoring", "outsourcing and offshoring consulting"],
  ["package/freight delivery", "freight and package transportation"],
  ["packaging and containers", "packaging and containers manufacturing"],
  ["paper & forest products", "paper and forest product manufacturing"],
  ["performing arts", "performing arts"],
  ["pharmaceuticals", "pharmaceutical manufacturing"],
  ["philanthropy", "philanthropic fundraising services"],
  ["photography", "photography"],
  ["plastics", "plastics manufacturing"],
  ["political organization", "political organizations"],
  ["primary/secondary education", "primary and secondary education"],
  ["printing", "printing services"],
  ["professional training & coaching", "professional training and coaching"],
  ["program development", "software development"],
  ["public policy", "public policy offices"],
  ["public relations and communications", "public relations and communications services"],
  ["public safety", "public safety"],
  ["publishing", "book and periodical publishing"],
  ["railroad manufacture", "railroad equipment manufacturing"],
  ["ranching", "ranching"],
  ["real estate", "real estate"],
  ["recreational facilities and services", "recreational facilities"],
  ["religious institutions", "religious institutions"],
  ["renewables & environment", "renewable energy semiconductor manufacturing"],
  ["research", "research services"],
  ["restaurants", "restaurants"],
  ["retail", "retail"],
  ["security and investigations", "security and investigations"],
  ["semiconductors", "semiconductor manufacturing"],
  ["shipbuilding", "shipbuilding"],
  ["sporting goods", "sporting goods manufacturing"],
  ["sports", "spectator sports"],
  ["staffing and recruiting", "staffing and recruiting"],
  ["supermarkets", "retail groceries"],
  ["telecommunications", "telecommunications"],
  ["textiles", "textile manufacturing"],
  ["think tanks", "think tanks"],
  ["tobacco", "tobacco manufacturing"],
  ["translation and localization", "translation and localization"],
  ["transportation/trucking/railroad", "truck transportation"],
  ["utilities", "utilities"],
  ["venture capital & private equity", "venture capital and private equity principals"],
  ["veterinary", "veterinary services"],
  ["warehousing", "warehousing and storage"],
  ["wholesale", "wholesale"],
  ["wine and spirits", "beverage manufacturing"],
  ["wireless", "wireless services"],
  ["writing and editing", "writing and editing"],
];

/** Common CRM picklist values (Salesforce's standard Industry list) and shorthand with one clear meaning. */
const ALIASES: ReadonlyArray<readonly [string, IndustryKey]> = [
  ["agriculture", "farming"],
  ["apparel", "retail apparel and fashion"],
  ["biotech", "biotechnology research"],
  ["communications", "telecommunications"],
  ["consulting", "business consulting and services"],
  ["electronics", "computers and electronics manufacturing"],
  ["environmental", "environmental services"],
  ["finance", "financial services"],
  ["fintech", "financial services"],
  ["food & beverage", "food and beverage services"],
  ["government", "government administration"],
  ["healthcare", "hospitals and health care"],
  ["health care", "hospitals and health care"],
  ["media", "media production"],
  ["not for profit", "non-profit organizations"],
  ["nonprofit", "non-profit organizations"],
  ["recreation", "recreational facilities"],
  ["shipping", "freight and package transportation"],
  ["technology", "technology, information and internet"],
  ["transportation", "transportation, logistics, supply chain and storage"],
  ["software", "software development"],
  ["saas", "software development"],
  ["it services", "it services and it consulting"],
  ["cybersecurity", "computer and network security"],
  ["staffing", "staffing and recruiting"],
  ["logistics", "transportation, logistics, supply chain and storage"],
  ["pharma", "pharmaceutical manufacturing"],
];

/** Prefix of a key for a value no table maps: "~" + the value, lowercased. */
export const UNMAPPED_PREFIX = "~";

export const INDUSTRIES: ReadonlyArray<{ key: IndustryKey; label: string }> = CANONICAL.map(([key, label]) => ({ key, label }));
const LABEL = new Map<string, string>(CANONICAL);

/** The normalized form both sides match on; industryNormSql is the same in SQL. */
export function normIndustry(raw: string): string {
  return ` ${raw.toLowerCase().replace(/[&/,_-]+/g, " ")} `.replace(/ and /g, " ").replace(/\s+/g, " ").trim();
}

const BY_NORM = new Map<string, IndustryKey>();
for (const [key, label] of CANONICAL) {
  BY_NORM.set(normIndustry(key), key);
  BY_NORM.set(normIndustry(label), key);
}
for (const [name, key] of [...EARLIER_NAMES, ...ALIASES]) if (!BY_NORM.has(normIndustry(name))) BY_NORM.set(normIndustry(name), key);

/** The canonical industry for any source's value, or null when no table names it. */
export function canonIndustry(raw: string | null | undefined): IndustryKey | null {
  if (!raw || !raw.trim()) return null;
  return BY_NORM.get(normIndustry(raw)) ?? null;
}

/** The key accounts group and filter by: canonical, or the value itself marked unmapped. */
export function industryKey(raw: string): IndustryKey {
  return canonIndustry(raw) ?? `${UNMAPPED_PREFIX}${raw.trim().toLowerCase()}`;
}

export function industryLabel(key: IndustryKey): string {
  if (key.startsWith(UNMAPPED_PREFIX)) return `${key.slice(UNMAPPED_PREFIX.length)} (unmapped)`;
  return LABEL.get(key) ?? key;
}

export const isCanonicalIndustry = (key: string) => LABEL.has(key);

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** SQL for normIndustry(col). */
export function industryNormSql(col: string): string {
  return `trim(regexp_replace(regexp_replace(' ' || regexp_replace(lower(${col}), '[&/,_\\-]+', ' ', 'g') || ' ', ' and ', ' ', 'g'), '\\s+', ' ', 'g'))`;
}

const MAP_SQL = `MAP {${[...BY_NORM].map(([n, k]) => `${sqlLit(n)}: ${sqlLit(k)}`).join(", ")}}`;

/** SQL for industryKey(col), and NULL for an empty value. */
export function industryKeySql(col: string): string {
  return `CASE WHEN ${col} IS NULL OR trim(${col}) = '' THEN NULL ELSE coalesce(${MAP_SQL}[${industryNormSql(col)}], '${UNMAPPED_PREFIX}' || lower(trim(${col}))) END`;
}

/**
 * Filter values (canonical keys, any source's value, "~" unmapped keys) as the keys accounts
 * group by. "__none__" (dimensions.ts NONE) passes through.
 */
export function industryFilterKeys(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => (v === "__none__" || v.startsWith(UNMAPPED_PREFIX) ? v : industryKey(v))))];
}

const SOURCE_NAMES = new Map<IndustryKey, string[]>();
for (const [key, label] of CANONICAL) SOURCE_NAMES.set(key, [key, label.toLowerCase()]);
for (const [name, key] of EARLIER_NAMES) SOURCE_NAMES.get(key)!.push(name);

/**
 * Every lowercase spelling the sources write for a canonical key: for an index that holds only
 * source values (the PDL index), where matching names keeps its indexes. Unmapped keys give their value.
 */
export function industrySourceNames(key: IndustryKey): string[] {
  if (key.startsWith(UNMAPPED_PREFIX)) return [key.slice(UNMAPPED_PREFIX.length)];
  return [...new Set(SOURCE_NAMES.get(key) ?? [key])];
}

/** Whether two values, in any sources' spellings, name the same industry. */
export function sameIndustry(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a?.trim() && b?.trim()) && industryKey(a!) === industryKey(b!);
}

/** The weight a weight set gives a value's industry, whatever spelling either uses; undefined when none does. */
export function industryWeight(set: Record<string, number> | undefined, value: string | null | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const key = industryKey(value);
  let best: number | undefined;
  for (const [k, w] of Object.entries(set ?? {})) if (industryKey(k) === key && (best === undefined || w > best)) best = w;
  return best;
}
