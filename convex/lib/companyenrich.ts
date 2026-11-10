/**
 * CompanyEnrich autocomplete through treg.to: free, one domain a call, about
 * 0.5 s, 300 calls a minute on treg's account shared with its other users
 * (observed 2026-10-06). Used beside Crustdata to resolve domain-guessed
 * account names: an exact domain match gave the real name for 30 of 32.
 */
import { tregCall, type TregMeta } from "./treg.ts";
import { normDomain } from "./peopleSources.ts";

export const COMPANYENRICH_AUTOCOMPLETE = "companyenrich.companies.autocomplete";

/** The real name for `domain`, or null when no result has exactly that domain. */
export async function companyNameFor(opts: {
  token: string;
  domain: string;
  meta: TregMeta;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | null> {
  const domain = normDomain(opts.domain);
  const res = await tregCall({
    token: opts.token,
    endpoint: COMPANYENRICH_AUTOCOMPLETE,
    query: { query: domain },
    meta: opts.meta,
    free: true,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`CompanyEnrich autocomplete failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  const rows = Array.isArray(res.body) ? (res.body as Array<{ domain?: string; name?: string }>) : [];
  const hit = rows.find((r) => r.domain && normDomain(r.domain) === domain && r.name);
  return hit?.name ?? null;
}

/** The domain of the company named `name`: the first autocomplete result with exactly that name, or null. */
export async function domainForName(opts: { token: string; name: string; meta: TregMeta; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<string | null> {
  const res = await tregCall({
    token: opts.token, endpoint: COMPANYENRICH_AUTOCOMPLETE, query: { query: opts.name.trim() }, meta: opts.meta, free: true,
    baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl,
  });
  if (res.status !== 200) return null;
  const rows = Array.isArray(res.body) ? (res.body as Array<{ domain?: string; name?: string }>) : [];
  const want = opts.name.trim().toLowerCase();
  const hit = rows.find((r) => r.domain && r.name?.trim().toLowerCase() === want);
  return hit?.domain ? normDomain(hit.domain) : null;
}
