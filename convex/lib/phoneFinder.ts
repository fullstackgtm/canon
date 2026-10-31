import { tregCall, type TregMeta } from "./treg.ts";

/** A contact's phone number, on demand (when a rep acts on the contact). */
export type PhoneResult = {
  phone: string | null;
  status: "found" | "not_found";
  /** The routed child that answered (`X-Treg-Served-By`), e.g. `treg:contactout`. */
  provider: string;
  /** USD millionths treg charged. */
  costMicro: number;
  /** `X-Treg-Call-Id`, to reconcile against treg's usage/by-tag ledger. */
  callId?: string;
};

export const TREG_PHONE_ENDPOINT = "treg.people.phone.find";

/**
 * Most phone providers bill a few cents a hit, a few up to $0.75; treg tries
 * them cheapest first. This ceiling bounds the whole waterfall for one lookup.
 */
export const PHONE_LOOKUP_MAX_COST_USD = 0.3;

/**
 * Find a person's phone through treg's routed phone finder: treg picks the
 * provider (cheapest per hit first) and bills only a hit. `meta` must carry
 * `customer=<orgId>` so treg attributes the spend to the workspace.
 */
export async function findPhoneViaTreg(opts: {
  token: string;
  fullName: string;
  domain: string;
  linkedinUrl?: string;
  email?: string;
  meta: TregMeta;
  idempotencyKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<PhoneResult> {
  // Everything known about the person: treg sends each provider the identity it matches on.
  const body: Record<string, string> = { full_name: opts.fullName, domain: opts.domain };
  if (opts.linkedinUrl) body.linkedin_url = opts.linkedinUrl;
  if (opts.email) body.email = opts.email;
  const res = await tregCall({
    token: opts.token,
    endpoint: TREG_PHONE_ENDPOINT,
    body,
    meta: opts.meta,
    idempotencyKey: opts.idempotencyKey,
    maxCostUsd: PHONE_LOOKUP_MAX_COST_USD,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const answer = res.body as { output?: { phone?: unknown } | null; _treg?: { served_by?: unknown } } | null;
  const servedBy = typeof answer?._treg?.served_by === "string" ? answer._treg.served_by : null;
  const meter = { provider: servedBy ? `treg:${servedBy}` : "treg:phone", costMicro: res.costMicro ?? 0, ...(res.callId ? { callId: res.callId } : {}) };
  if (res.status === 404) return { phone: null, status: "not_found", ...meter };
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`treg phone lookup failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  // A miss is `output.phone == null` (free on per-success providers).
  const raw = typeof answer?.output?.phone === "string" ? answer.output.phone.trim() : "";
  const phone = /\d{6,}/.test(raw.replace(/[\s().-]/g, "")) ? raw : null;
  return { phone, status: phone ? "found" : "not_found", ...meter };
}
