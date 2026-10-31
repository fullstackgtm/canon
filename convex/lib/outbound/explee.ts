/**
 * Explee (public API) adapter: check a key and read the hot-leads feed, with the
 * workspace's own API key. Explee runs the cold email (its own warmed inboxes);
 * Canon reads back the people who replied with real interest. The fetch is
 * injected, so tests run it against a fake HTTP layer.
 *
 * The key goes only in the X-API-Key header. Errors carry the HTTP status and
 * never the response body or the key.
 *
 * Pure: no database access, no Node-only imports.
 */

export const EXPLEE_BASE_URL = "https://api.explee.com";
/** Explee's page-size cap for the hot-leads feed. */
export const EXPLEE_PAGE = 200;

/** One hot lead as Explee returns it: an enriched contact plus the reply that made it hot. */
export type ExpleeHotLead = {
  personId: string;
  campaignId: number;
  name: string | null;
  email: string | null;
  jobTitle: string | null;
  companyName: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
  country: string | null;
  phone: string | null;
  /** The qualifying reply, verbatim. */
  whyHot: string | null;
  /** ISO 8601, as Explee sent it: the next poll's `since`. */
  becameHotAt: string | null;
};

export class ExpleeError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401 || status === 403
        ? `Explee rejected the API key (HTTP ${status}). Check it at explee.com, API keys.`
        : status === 429
          ? "Explee is rate limiting this key (HTTP 429). Try again in a minute."
          : `Explee request failed (HTTP ${status}).`,
    );
    this.name = "ExpleeError";
    this.status = status;
  }
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** A feed item, or null when it lacks the ids Explee always sends. */
export function hotLeadOf(raw: unknown): ExpleeHotLead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const personId = str(r.person_id);
  if (!personId || typeof r.campaign_id !== "number") return null;
  return {
    personId,
    campaignId: r.campaign_id,
    name: str(r.name),
    email: str(r.email),
    jobTitle: str(r.job_title),
    companyName: str(r.company_name),
    companyDomain: str(r.company_domain),
    linkedinUrl: str(r.linkedin_url),
    country: str(r.country),
    phone: str(r.phone),
    whyHot: typeof r.why_hot === "string" && r.why_hot.trim() ? r.why_hot : null,
    becameHotAt: str(r.became_hot_at),
  };
}

export type ExpleeProject = { id: number; domain: string };
export type HotLeadsPage = { leads: ExpleeHotLead[]; nextOffset: number | null };

export type ExpleeClient = ReturnType<typeof createExpleeClient>;

export function createExpleeClient(opts: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? EXPLEE_BASE_URL).replace(/\/$/, "");
  async function get<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${base}/public/api/v1${path}`, { method: "GET", headers: { "X-API-Key": opts.apiKey } });
    if (!response.ok) throw new ExpleeError(response.status);
    return (await response.json()) as T;
  }
  return {
    /** The key's projects. Throws ExpleeError when Explee refuses the key, so it doubles as the check. */
    async projects(): Promise<ExpleeProject[]> {
      const r = await get<{ projects?: Array<{ id?: unknown; domain?: unknown }> }>("/autogtm/projects");
      return (r.projects ?? []).flatMap((p) => (typeof p.id === "number" ? [{ id: p.id, domain: typeof p.domain === "string" ? p.domain : "" }] : []));
    },
    /** One page of leads that went hot at or after `since` (inclusive), newest first. */
    async hotLeads(req: { since?: string; offset?: number }): Promise<HotLeadsPage> {
      const q = new URLSearchParams({ limit: String(EXPLEE_PAGE), offset: String(req.offset ?? 0) });
      if (req.since) q.set("since", req.since);
      const r = await get<{ leads?: unknown[]; has_more?: unknown; next_offset?: unknown }>(`/autogtm/hot-leads?${q}`);
      const leads = (r.leads ?? []).flatMap((x) => hotLeadOf(x) ?? []);
      const nextOffset = r.has_more === true && typeof r.next_offset === "number" ? r.next_offset : null;
      return { leads, nextOffset };
    },
  };
}
