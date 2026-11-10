// Queries over the shared prospect index (companies table built by build.ts).
// The record service wires these to POST /v1/shared/prospects/search and the
// onboarding pipeline; they take a DuckDB connection so they run in-process.
import type { DuckDBConnection } from "@duckdb/node-api";

export type SharedFilter = {
  industry?: string[]; // PDL industry values, lowercase (see facets())
  country?: string[]; // PDL country names, lowercase ("united states")
  region?: string[];
  employeeMin?: number;
  employeeMax?: number;
  foundedAfter?: number;
  q?: string; // name or domain substring
  excludeDomains?: string[]; // e.g. the visitor's own domain, existing customers
  minConfidence?: "high" | "low"; // "high" drops rows whose website looks unrelated
};

// Matches the record service's AccountInput (company fields of AccountRow),
// plus index provenance so the CRM can attribute and explain each row.
export type SharedCompany = {
  domain: string;
  name: string;
  industry: string | null;
  employees: number | null; // band midpoint, for sorting
  employeeMin: number | null;
  employeeMax: number | null;
  sizeBand: string | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  founded: number | null;
  linkedinUrl: string | null;
  domainConfidence: "high" | "low";
  source: "pdl";
  externalIds: { pdl: string };
};

export const ATTRIBUTION = "Company data from People Data Labs (CC BY 4.0)";
const MAX_LIMIT = 500;

export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/[/:?#].*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function where(f: SharedFilter) {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const list = (col: string, key: string, values?: string[]) => {
    if (!values?.length) return;
    clauses.push(`${col} IN (${values.map((_, i) => `$${key}${i}`).join(", ")})`);
    values.forEach((v, i) => (params[`${key}${i}`] = v.toLowerCase()));
  };
  list("industry", "ind", f.industry);
  list("country", "ctry", f.country);
  list("region", "reg", f.region);
  if (f.employeeMin != null) { clauses.push("coalesce(employeeMax, employeeMin) >= $empMin"); params.empMin = f.employeeMin; }
  if (f.employeeMax != null) { clauses.push("employeeMin <= $empMax"); params.empMax = f.employeeMax; }
  if (f.foundedAfter != null) { clauses.push("founded >= $founded"); params.founded = f.foundedAfter; }
  if (f.q) { clauses.push("(name ILIKE $q OR domain ILIKE $q)"); params.q = `%${f.q.replace(/[%_]/g, "")}%`; }
  if (f.minConfidence === "high") clauses.push("domainConfidence = 'high'");
  if (f.excludeDomains?.length) {
    const ds = f.excludeDomains.map(normalizeDomain).filter(Boolean) as string[];
    if (ds.length) {
      clauses.push(`domain NOT IN (${ds.map((_, i) => `$ex${i}`).join(", ")})`);
      ds.forEach((d, i) => (params[`ex${i}`] = d));
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const num = (v: unknown) => (v == null ? null : Number(v));
function toCompany(r: Record<string, unknown>): SharedCompany {
  const min = num(r.employeeMin), max = num(r.employeeMax);
  return {
    domain: r.domain as string,
    name: r.name as string,
    industry: (r.industry as string) ?? null,
    employees: min == null ? null : max == null ? min : Math.round((min + max) / 2),
    employeeMin: min,
    employeeMax: max,
    sizeBand: (r.sizeBand as string) ?? null,
    country: (r.country as string) ?? null,
    region: (r.region as string) ?? null,
    locality: (r.locality as string) ?? null,
    founded: num(r.founded),
    linkedinUrl: (r.linkedinUrl as string) ?? null,
    domainConfidence: r.domainConfidence as "high" | "low",
    source: "pdl",
    externalIds: { pdl: r.pdlId as string },
  };
}

async function rows(c: DuckDBConnection, sql: string, params: Record<string, unknown>) {
  return (await c.runAndReadAll(sql, params as never)).getRowObjects() as Record<string, unknown>[];
}

/** POST /v1/shared/prospects/search: a filtered, ranked page plus the full match count. */
export async function searchShared(c: DuckDBConnection, filter: SharedFilter, limit = 100, offset = 0) {
  const { sql, params } = where(filter);
  const lim = Math.min(Math.max(1, limit), MAX_LIMIT);
  // Sequential: a single DuckDB connection must not run statements concurrently.
  const page = await rows(c, `SELECT * FROM companies ${sql}
      ORDER BY (domainConfidence = 'high') DESC, (linkedinUrl IS NOT NULL) DESC, employeeMin DESC NULLS LAST, domain
      LIMIT ${lim} OFFSET ${Math.max(0, offset | 0)}`, params);
  const [count] = await rows(c, `SELECT count(*) AS n FROM companies ${sql}`, params);
  return { rows: page.map(toCompany), total: Number(count.n), attribution: ATTRIBUTION };
}

/**
 * The visitor's own company, from the domain typed on the homepage. Seeds ICP
 * derivation (industry, size, country). Falls back from a subdomain to its
 * parent ("app.acme.com" -> "acme.com").
 */
export async function lookupDomain(c: DuckDBConnection, input: string): Promise<SharedCompany | null> {
  const d = normalizeDomain(input);
  if (!d) return null;
  const parts = d.split(".");
  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = parts.slice(i).join(".");
    const [hit] = await rows(c, `SELECT * FROM companies WHERE domain = $d`, { d: candidate });
    if (hit) return toCompany(hit);
  }
  return null;
}

/** Facet values with counts, so ICP derivation maps onto values that exist in the index. */
export async function facets(c: DuckDBConnection, column: "industry" | "country" | "sizeBand", top = 200) {
  const r = await rows(c, `SELECT ${column} AS value, count(*) AS n FROM companies WHERE ${column} IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT ${Math.min(top, 1000)}`, {});
  return r.map((x) => ({ value: x.value as string, count: Number(x.n) }));
}
