/**
 * Crustdata company identify through treg.to: free, up to 25 domains a call,
 * 30 calls a minute on treg's account (observed 2026-10-06). Used to replace
 * domain-derived account names ("Thetradedesk") with real ones ("The Trade Desk").
 */
import { tregCall, type TregMeta } from "./treg.ts";
import { normDomain } from "./peopleSources.ts";
import type { SharedCompanyDetail } from "./recordContract.ts";

export const CRUSTDATA_IDENTIFY = "crustdata.companies.identify";
export const IDENTIFY_BATCH = 25;

type Match = { confidence_score?: number; company_data?: { basic_info?: { name?: string; primary_domain?: string; professional_network_url?: string } } };

/** Domain -> real name (and LinkedIn page) for the confident matches. */
export async function identifyCompanies(opts: {
  token: string;
  domains: string[];
  meta: TregMeta;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Map<string, { name: string; linkedinUrl?: string }>> {
  const res = await tregCall({
    token: opts.token,
    endpoint: CRUSTDATA_IDENTIFY,
    body: { domains: opts.domains.slice(0, IDENTIFY_BATCH) },
    meta: opts.meta,
    free: true,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  const out = new Map<string, { name: string; linkedinUrl?: string }>();
  // A 404 is "none of these matched".
  if (res.status === 404) return out;
  if (res.status !== 200) throw new Error(`Crustdata identify failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  for (const row of (res.body as Array<{ matched_on?: string; matches?: Match[] }>) ?? []) {
    const best = row.matches?.[0];
    const info = best?.company_data?.basic_info;
    if (!row.matched_on || !info?.name || (best?.confidence_score ?? 0) < 0.8) continue;
    out.set(normDomain(row.matched_on), { name: info.name, ...(info.professional_network_url ? { linkedinUrl: info.professional_network_url } : {}) });
  }
  return out;
}

type DetailMatch = {
  confidence_score?: number;
  company_data?: { basic_info?: {
    name?: string; primary_domain?: string; professional_network_url?: string;
    year_founded?: number; employee_count_range?: string; industries?: string[];
  } };
};

/**
 * Domain -> the firmographics identify returns (name, industry, size band, founded year, LinkedIn page) for the
 * confident matches, shaped like a shared-index row. Identify has no location or revenue.
 */
export async function identifyCompanyDetails(opts: {
  token: string;
  domains: string[];
  meta: TregMeta;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Map<string, SharedCompanyDetail>> {
  const res = await tregCall({
    token: opts.token, endpoint: CRUSTDATA_IDENTIFY, body: { domains: opts.domains.slice(0, IDENTIFY_BATCH) }, meta: opts.meta, free: true,
    baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs,
  });
  const out = new Map<string, SharedCompanyDetail>();
  if (res.status === 404) return out;
  if (res.status !== 200) throw new Error(`Crustdata identify failed: HTTP ${res.status}`);
  for (const row of (res.body as Array<{ matched_on?: string; matches?: DetailMatch[] }>) ?? []) {
    const best = row.matches?.[0];
    const info = best?.company_data?.basic_info;
    if (!row.matched_on || !info?.name || (best?.confidence_score ?? 0) < 0.8) continue;
    const [min, max] = (info.employee_count_range ?? "").split(/[-+]/).map((n) => (n ? Number(n) : undefined));
    const domain = normDomain(row.matched_on);
    out.set(domain, {
      domain,
      name: info.name,
      domainConfidence: "high",
      ...(info.industries?.[0] ? { industry: info.industries[0] } : {}),
      ...(info.employee_count_range && min ? { sizeBand: info.employee_count_range, employeesMin: min, ...(max ? { employeesMax: max } : {}) } : {}),
      ...(info.year_founded ? { founded: info.year_founded } : {}),
      ...(info.professional_network_url ? { linkedinUrl: info.professional_network_url } : {}),
    });
  }
  return out;
}
