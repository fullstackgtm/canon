/**
 * The ICP query line: the one text form an ICP, a segment or a persona is stored, shown, edited and sent
 * by agents in (docs/icp-tree.md). Pure and Node-free (the UI imports it).
 *
 *   industry:software-development,it-services-and-it-consulting size:201-500,501-1000 country:us,gb
 *   -industry:staffing-and-recruiting field.business-model:saas has(level:vp,head dept:revenue-operations -title:intern)
 *
 * Company keys: industry, size, country (each may be negated with "-", except size) and field.<slug>, an
 * account AI field's answers (`field.arr:5..50` for a number range). A segment or a territory also takes region
 * (north-america, latin-america, europe, middle-east-africa, asia-pacific; its countries), city, owner (a member's id,
 * or none) and revenue (annual, as bands: 1m-10m, 50m+); region and owner may be negated. Person keys, inside has(…) or on a
 * persona: level, dept, title (a word in the job title; "-title" never matches) and location.
 *
 * - An ICP takes company keys and at most one has(…): its buyer, exactly the spec's persona. Without one,
 *   the buyer is C-suite, VP, Head or Director (lib/icps.ts DEFAULT_BUYER_LEVELS).
 * - A segment narrows its parent's accounts: company keys, has(…) ("employs someone like") and -has(…)
 *   ("employs no one like").
 * - A persona is the people to reach at its parent's accounts: person keys only.
 */
import { COUNTRIES, DEPARTMENTS, EMPLOYEE_BANDS, LEVELS, canonDepartments } from "./icpVocabulary.ts";
import type { IcpSpec } from "./icpSpec.ts";
import type { IcpTreeAccount, IcpTreePerson } from "./recordContract.ts";
import { icpGeosToCountries } from "../../modules/kernel/icpGeography.ts";
import { canonIndustry } from "../../modules/kernel/industries.ts";
import { NONE, REGIONS, REGION_OF_COUNTRY } from "../../modules/kernel/dimensions.ts";

export type NodeKind = "icp" | "segment" | "persona";
type ListKey = "industry" | "size" | "country" | "region" | "city" | "owner" | "revenue" | "level" | "dept" | "title" | "location";
export type Clause =
  | { key: ListKey; neg: boolean; values: string[] }
  | { key: "field"; slug: string; neg: false; values?: string[]; min?: number; max?: number };
export type Has = { neg: boolean; clauses: Clause[] };
export type IcpQuery = { clauses: Clause[]; has: Has[] };

const COMPANY = new Set(["industry", "size", "country", "region", "city", "owner", "revenue", "field"]);
/** Keys that narrow a segment or a territory, never an ICP's gate (which reads industry, size, country and fields). */
const SEGMENT_ONLY = new Set(["region", "city", "owner", "revenue"]);
const PERSON = new Set(["level", "dept", "title", "location"]);
const NEGATABLE = new Set(["industry", "country", "region", "owner", "title"]);
const MAX_VALUES = 60;
const MAX_HAS = 4;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Lowercase, words joined by "-": how vocabulary values with spaces are written in a query. */
export const slugOf = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9+]+/g, "-").replace(/^-|-$/g, "");

const DEPT_BY_SLUG = new Map(DEPARTMENTS.map((d) => [slugOf(d), d]));
const LEVEL_SET = new Set(LEVELS.map((l) => l.value));
const COUNTRY_SET = new Set(COUNTRIES.map((c) => c.value));
const BAND_SET = new Set<string>(EMPLOYEE_BANDS);
// "other" is every country no region lists, which a list of countries can't say.
const REGION_KEYS = new Set<string>(REGIONS.map((r) => r.key).filter((k) => k !== "other"));
const REVENUE = /^(\d+(?:\.\d+)?)([kmb]?)(?:-(\d+(?:\.\d+)?)([kmb]?)|\+)$/;
const SCALE: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };

/** A value in its stored spelling, or null when the key's vocabulary has no such value. */
function canonValue(key: ListKey, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (key) {
    case "industry": return canonIndustry(v.replace(/-/g, " "));
    case "size": return BAND_SET.has(v) ? v : null;
    case "country": case "location": return COUNTRY_SET.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "region": return REGION_KEYS.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "city": return /["()]/.test(v) ? null : v.toLowerCase().slice(0, 80);
    case "owner": return v.toLowerCase() === "none" ? "none" : /^[a-z0-9]{8,40}$/.test(v) ? v : null;
    case "revenue": return REVENUE.test(v.toLowerCase()) ? v.toLowerCase() : null;
    case "level": return LEVEL_SET.has(v.toLowerCase()) ? v.toLowerCase() : null;
    case "dept": {
      if (/["()]/.test(v)) return null;
      const department = DEPT_BY_SLUG.get(slugOf(v)) ?? canonDepartments([v.replace(/-/g, " ")])[0];
      return department ? DEPARTMENTS.includes(department) ? department : department.toLowerCase() : null;
    }
    case "title": return /["()]/.test(v) ? null : v.slice(0, 120);
  }
}
/** A stored value as written in a query: vocabularies as slugs, free text quoted when it needs it. */
function writeValue(key: ListKey | "field", v: string): string {
  if (key === "industry" || key === "dept") return slugOf(v);
  // An answer shaped like a range ("1..10") stays quoted, or it would read back as one.
  return /^[^\s,"()]+$/.test(v) && !(key === "field" && v.includes("..")) ? v : `"${v}"`;
}

/** Split on a top-level separator, keeping quoted text and has(…) groups whole. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && /\s/.test(ch)) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function splitValues(raw: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (const ch of raw) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : Number(s));

function parseClause(token: string, errors: string[]): Clause | null {
  const m = token.match(/^(-?)([a-z_]+)(?:\.([A-Za-z0-9_-]+))?:(.*)$/i);
  if (!m) { errors.push(`can't read "${token.slice(0, 40)}": write key:value`); return null; }
  const [, dash, rawKey, slug, rest] = m;
  const key = rawKey.toLowerCase();
  const neg = dash === "-";
  if (key === "field") {
    if (!slug || !SLUG_RE.test(slug)) { errors.push(`field needs an AI field: field.<slug>:answer`); return null; }
    if (neg) { errors.push(`-field.${slug} isn't supported`); return null; }
    const range = rest.match(/^(-?[\d.]*)\.\.(-?[\d.]*)$/);
    if (range) {
      const min = num(range[1]), max = num(range[2]);
      if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (min === undefined && max === undefined)) {
        errors.push(`field.${slug}: a range is min..max`); return null;
      }
      return { key: "field", slug, neg: false, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }
    const values = splitValues(rest).map((v) => v.toLowerCase().slice(0, 120));
    if (!values.length) { errors.push(`field.${slug} needs an answer`); return null; }
    return { key: "field", slug, neg: false, values: [...new Set(values)].slice(0, MAX_VALUES) };
  }
  if (slug) { errors.push(`unknown key "${rawKey}.${slug}"`); return null; }
  if (!COMPANY.has(key) && !PERSON.has(key)) { errors.push(`unknown key "${rawKey}"`); return null; }
  if (neg && !NEGATABLE.has(key)) { errors.push(`-${key} isn't supported`); return null; }
  const values: string[] = [];
  for (const raw of splitValues(rest)) {
    const v = canonValue(key as ListKey, raw);
    if (v === null) errors.push(`${key}: no value "${raw}"`);
    else if (!values.includes(v)) values.push(v);
  }
  if (!values.length) { if (!errors.length) errors.push(`${key} needs a value`); return null; }
  return { key: key as ListKey, neg, values: values.slice(0, MAX_VALUES) };
}

const clauseId = (c: Clause) => `${c.neg ? "-" : ""}${c.key === "field" ? `field.${c.slug}` : c.key}`;

function parseClauses(parts: string[], scope: "company" | "person", errors: string[], where: string): Clause[] {
  const out: Clause[] = [];
  for (const part of parts) {
    const c = parseClause(part, errors);
    if (!c) continue;
    const isCompany = COMPANY.has(c.key);
    if (scope === "company" && !isCompany) { errors.push(`${c.key} describes a person: put it in has(…)${where === "icp" ? "" : " or on a persona"}`); continue; }
    if (scope === "person" && isCompany) { errors.push(`${clauseId(c)} describes the company: put it on the ICP or a segment`); continue; }
    if (out.some((o) => clauseId(o) === clauseId(c))) { errors.push(`${clauseId(c)} appears twice: list its values with commas`); continue; }
    out.push(c);
  }
  return out;
}

/** Parse a node's query line. `errors` is empty when it can be saved. */
export type ParsedIcpQuery = { query: IcpQuery; errors: string[]; source: { text: string; canonical: string } };

export function parseQuery(text: string, kind: NodeKind): ParsedIcpQuery {
  const errors: string[] = [];
  const query: IcpQuery = { clauses: [], has: [] };
  if ((text.match(/"/g)?.length ?? 0) % 2) errors.push("a quote is never closed");
  const company: string[] = [];
  for (const t of tokens(text.trim())) {
    const h = t.match(/^(-?)has\(([\s\S]*)\)$/i);
    if (h) {
      if (kind === "persona") { errors.push("has(…) belongs on an ICP or a segment: a persona already is the people"); continue; }
      const clauses = parseClauses(tokens(h[2]), "person", errors, kind);
      if (clauses.length) query.has.push({ neg: h[1] === "-", clauses });
      else errors.push(`${h[1]}has(…) needs who: level, dept or title`);
    } else if (/^-?has\(/i.test(t)) errors.push("a has( is never closed");
    else company.push(t);
  }
  query.clauses = parseClauses(company, kind === "persona" ? "person" : "company", errors, kind);
  const listed = (key: ListKey) => query.clauses.some((c) => c.key === key && !c.neg);
  if (listed("country") && listed("region")) errors.push("name countries or regions, not both");
  if (kind === "icp") {
    const narrow = query.clauses.find((c) => SEGMENT_ONLY.has(c.key));
    if (narrow) errors.push(`${narrow.key} narrows a segment or a territory, not an ICP: add a segment for it`);
    if (query.has.some((h) => h.neg)) errors.push("-has(…) belongs on a segment: an ICP's has(…) is its buyer");
    if (query.has.filter((h) => !h.neg).length > 1) errors.push("an ICP takes one has(…), its buyer: add a segment to require more");
  }
  if (query.has.length > MAX_HAS) errors.push(`at most ${MAX_HAS} has(…) on a segment`);
  if (kind === "persona" && !query.clauses.length && !errors.length) errors.push("a persona needs who: level, dept or title");
  return { query, errors, source: { text, canonical: formatQuery(query) } };
}

function writeClause(c: Clause): string {
  if (c.key === "field") {
    if (c.values) return `field.${c.slug}:${c.values.map((v) => writeValue("field", v)).join(",")}`;
    return `field.${c.slug}:${c.min ?? ""}..${c.max ?? ""}`;
  }
  return `${c.neg ? "-" : ""}${c.key}:${c.values.map((v) => writeValue(c.key, v)).join(",")}`;
}

/** A query in its canonical spelling: parsing it gives the same query back. */
export function formatQuery(q: IcpQuery): string {
  return [...q.clauses.map(writeClause), ...q.has.map((h) => `${h.neg ? "-" : ""}has(${h.clauses.map(writeClause).join(" ")})`)].join(" ");
}

/** Preserve spelling, quotes and whitespace until the typed tree is edited. Saves use formatQuery. */
export function serializeQuery(parsed: Pick<ParsedIcpQuery, "query" | "source">): string {
  const canonical = formatQuery(parsed.query);
  return canonical === parsed.source.canonical ? parsed.source.text : canonical;
}

const listOf = (cs: readonly Clause[], key: ListKey, neg = false) => cs.find((c): c is Extract<Clause, { key: ListKey }> => c.key === key && c.neg === neg)?.values ?? [];

/** An ICP's spec as its query line (lossless: queryToSpec gives the same spec back). */
export function specToQuery(spec: IcpSpec): string {
  const list = (key: ListKey, values: readonly string[], neg = false): Clause[] => (values.length ? [{ key, neg, values: [...values] }] : []);
  const buyer: Clause[] = [
    ...list("level", spec.persona.levels), ...list("dept", canonDepartments(spec.persona.departments)), ...list("title", spec.persona.titles),
    ...list("location", spec.persona.countries ?? []), ...list("title", spec.exclude.titles, true),
  ];
  return formatQuery({
    clauses: [
      ...list("industry", spec.market.industries), ...list("size", spec.market.employeeBands), ...list("country", spec.market.countries),
      ...list("industry", spec.exclude.industries, true), ...list("country", spec.exclude.countries, true),
      ...(spec.custom ?? []).map((c): Clause => ({ key: "field", slug: c.slug, neg: false, ...(c.values?.length ? { values: c.values } : {}), ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) })),
    ],
    has: buyer.length ? [{ neg: false, clauses: buyer }] : [],
  });
}

/** An ICP query (parsed without errors) as the spec the gate, fills and Add records read. */
export function queryToSpec(q: IcpQuery): IcpSpec {
  const buyer = q.has.find((h) => !h.neg)?.clauses ?? [];
  const custom = q.clauses.flatMap((c) => (c.key === "field" ? [{ slug: c.slug, ...(c.values ? { values: c.values } : {}), ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) }] : []));
  return {
    market: { industries: listOf(q.clauses, "industry"), employeeBands: listOf(q.clauses, "size"), countries: listOf(q.clauses, "country") },
    persona: { levels: listOf(buyer, "level"), departments: listOf(buyer, "dept"), titles: listOf(buyer, "title"), countries: listOf(buyer, "location") },
    exclude: { industries: listOf(q.clauses, "industry", true), countries: listOf(q.clauses, "country", true), titles: listOf(buyer, "title", true) },
    ...(custom.length ? { custom } : {}),
  };
}

/** The AI fields a query names, for the server to check against the workspace's account fields. */
export const fieldSlugs = (q: IcpQuery) => q.clauses.flatMap((c) => (c.key === "field" ? [c.slug] : []));

const BAND = /^(\d+)(?:-(\d+)|\+)$/;
const bandRange = (band: string) => {
  const m = band.match(BAND);
  return m ? { min: Number(m[1]), max: m[2] ? Number(m[2]) : 1_000_000_000 } : null;
};

/** A region's countries, as names and codes (record service dimensions.ts), the way accounts may carry them. */
const regionCountries = (regions: readonly string[]) => Object.entries(REGION_OF_COUNTRY).filter(([, r]) => regions.includes(r)).map(([c]) => c);
/** "1m-10m" as cents (annual revenue is stored in cents); "50m+" has no top. */
function revenueRange(band: string) {
  const m = band.match(REVENUE);
  if (!m) return null;
  const amount = (n: string, unit: string) => Math.round(Number(n) * SCALE[unit] * 100);
  return { min: amount(m[1], m[2]), max: m[3] ? amount(m[3], m[4]) : 1e17 };
}

/** A segment's company keys as record-service criteria (contract 1.31.0; cities, owners and revenue 1.40.0). */
export function accountCriteria(clauses: readonly Clause[]): IcpTreeAccount {
  const owners = (neg: boolean) => listOf(clauses, "owner", neg).map((o) => (o === "none" ? NONE : o));
  return {
    industries: listOf(clauses, "industry"),
    // Accounts carry country names, as gates match them (lib/icps.ts specGate). A region is its countries.
    countries: [...icpGeosToCountries(listOf(clauses, "country")), ...regionCountries(listOf(clauses, "region"))],
    employees: listOf(clauses, "size").flatMap((b) => bandRange(b) ?? []),
    excludeIndustries: listOf(clauses, "industry", true),
    excludeCountries: [...icpGeosToCountries(listOf(clauses, "country", true)), ...regionCountries(listOf(clauses, "region", true))],
    ...(listOf(clauses, "city").length ? { cities: listOf(clauses, "city") } : {}),
    ...(owners(false).length ? { owners: owners(false) } : {}),
    ...(owners(true).length ? { excludeOwners: owners(true) } : {}),
    ...(listOf(clauses, "revenue").length ? { revenue: listOf(clauses, "revenue").flatMap((b) => revenueRange(b) ?? []) } : {}),
    custom: clauses.flatMap((c) => (c.key === "field" ? [{ key: `custom.${c.slug}`, ...(c.values ? { values: c.values } : {}), ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) }] : [])),
  };
}

/**
 * Person keys as record-service criteria: someone whose title holds one of `titles`, or whose level is one of
 * `levels` (any, when none) and whose department is one of `departments` (any, when none); never anyone whose
 * title holds an `exclude` word. Location isn't checked: contacts carry none.
 */
export function personCriteria(clauses: readonly Clause[]): IcpTreePerson {
  const lower = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  return {
    levels: lower(listOf(clauses, "level")),
    departments: lower(listOf(clauses, "dept")),
    titles: lower(listOf(clauses, "title")),
    exclude: lower(listOf(clauses, "title", true)),
  };
}
