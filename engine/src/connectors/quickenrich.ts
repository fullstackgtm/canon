/**
 * QuickEnrich — B2B work-email / phone finder, used as a step in the contact
 * reveal waterfall (contactProviders.ts).
 *
 * STATUS: built against QuickEnrich's public product description only; no API
 * key was available while writing this, so the endpoint path and the
 * request/response field names below are UNVERIFIED. They are isolated in
 * QUICKENRICH_DEFAULTS + `parseQuickEnrichResult` so confirming them against
 * the real API is a one-place change. Without a key every call fails fast
 * with QuickEnrichMissingKeyError (no network request is made).
 *
 * Zero runtime deps: global fetch only, injectable for tests. The key comes
 * from QUICKENRICH_API_KEY (env/credential store), never argv.
 */
import type { Prospect } from "./prospectSources.ts";
import { ProviderHttpError } from "../providerError.ts";

export const QUICKENRICH_DEFAULTS = {
  baseUrl: "https://api.quickenrich.io",
  /** UNVERIFIED path — confirm with QuickEnrich docs once a key exists. */
  enrichPath: "/v1/enrich/person",
  concurrency: 4,
} as const;

export class QuickEnrichMissingKeyError extends Error {
  constructor() {
    super("QuickEnrich is not configured: set QUICKENRICH_API_KEY to enable the QuickEnrich waterfall step.");
    this.name = "QuickEnrichMissingKeyError";
  }
}

export type QuickEnrichOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
};

export function quickEnrichKey(opts: { apiKey?: string } = {}, env: Record<string, string | undefined> = process.env): string {
  const key = opts.apiKey ?? env.QUICKENRICH_API_KEY;
  if (!key || !key.trim()) throw new QuickEnrichMissingKeyError();
  return key.trim();
}

export type QuickEnrichInput = {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  domain?: string;
  company_name?: string;
  linkedin_url?: string;
};

/** Build the request body for one prospect, or null when it lacks a usable identity. */
export function quickEnrichInput(prospect: Prospect): QuickEnrichInput | null {
  if (prospect.linkedin) return { linkedin_url: prospect.linkedin, domain: prospect.companyDomain };
  const hasName = Boolean(prospect.fullName || (prospect.firstName && prospect.lastName));
  if (!hasName || !(prospect.companyDomain || prospect.companyName)) return null;
  return {
    first_name: prospect.firstName,
    last_name: prospect.lastName,
    full_name: prospect.fullName,
    domain: prospect.companyDomain,
    company_name: prospect.companyDomain ? undefined : prospect.companyName,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Tolerant parser: accepts `{email, phone}` at the top level or under `data`/`result`. */
export function parseQuickEnrichResult(body: unknown): { email?: string; mobile?: string } {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = data?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const email = pick("email", "work_email");
  const status = pick("email_status", "status")?.toLowerCase();
  const mobile = pick("mobile", "mobile_phone", "phone");
  return {
    email: email && EMAIL_RE.test(email) && status !== "invalid" ? email.toLowerCase() : undefined,
    mobile: mobile && /\d{7,}/.test(mobile.replace(/\D/g, "")) ? mobile : undefined,
  };
}

/**
 * Resolve each prospect. Output is index-aligned with input (the waterfall
 * contract); prospects QuickEnrich cannot resolve come back unchanged.
 * 404 = no match. 401/403 and other HTTP failures throw ProviderHttpError.
 */
export async function quickEnrichResolve(prospects: Prospect[], opts: QuickEnrichOptions = {}): Promise<Prospect[]> {
  const apiKey = quickEnrichKey(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? QUICKENRICH_DEFAULTS.baseUrl).replace(/\/$/, "")}${QUICKENRICH_DEFAULTS.enrichPath}`;
  const out = prospects.map((p) => ({ ...p }));
  let next = 0;
  async function worker() {
    while (next < prospects.length) {
      const index = next++;
      const input = quickEnrichInput(prospects[index]);
      if (!input) continue;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (response.status === 404) continue;
      if (!response.ok) throw new ProviderHttpError("quickenrich", "person enrich", response.status);
      const found = parseQuickEnrichResult(await response.json());
      if (found.email && !out[index].email) out[index].email = found.email;
      if (found.mobile && !out[index].mobile) out[index].mobile = found.mobile;
    }
  }
  const workers = Math.max(1, Math.min(opts.concurrency ?? QUICKENRICH_DEFAULTS.concurrency, prospects.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
