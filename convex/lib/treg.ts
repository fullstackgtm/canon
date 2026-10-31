/**
 * Client for the hosted treg.to tool registry (https://treg.to/llms.txt).
 *
 * CanonCRM holds one treg team, one balance and one token. Every call is
 * tagged from our backend with `X-Treg-Meta: customer=<orgId>, ...` so
 * treg's ledger attributes spend per workspace (`GET /orgs/{id}/usage/by-tag`)
 * and per-workspace budgets can refuse a call. The hosted API used this way is
 * explicitly allowed by treg's terms; self-hosting treg's code for our
 * customers is not (its LICENSE restricts hosted/embedded use).
 *
 * The client relays: it never reshapes a provider's response. Callers parse
 * the provider body themselves (see emailFinder.ts for Hunter).
 */

import { ConvexError } from "convex/values";

export const TREG_BASE_URL = "https://treg.to";

/** treg's tag-bag rules, enforced here so a bad tag fails before it costs a round trip. */
const META_KEY = /^[a-z0-9_]{1,32}$/;
const META_MAX_PAIRS = 5;
const META_MAX_VALUE = 128;

export type TregMeta = Record<string, string>;

export type TregResult = {
  status: number;
  body: unknown;
  /** `X-Treg-Call-Id`: the join key between our ledger and treg's. */
  callId: string | null;
  /** `X-Treg-Cost-Micro` (USD millionths). null when treg did not meter the call (own-key relay). */
  costMicro: number | null;
  replay: boolean;
  /** The provider's remaining request quota, when it reports one (X-RateLimit-Remaining). */
  rateRemaining: number | null;
};

export type TregReceipt = Pick<TregResult, "status" | "callId" | "costMicro">;

/** The request failed before any response could establish its cost. */
export class TregTransportError extends Error {
  constructor(cause: unknown) {
    super("treg transport failed without a response", { cause });
    this.name = "TregTransportError";
  }
}

/** A refusal from treg itself (balance, budget, tag), as opposed to a provider answer. */
export class TregRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly callId: string | null;
  /** When the refusal says when to try again (epoch ms): a capacity reset or a Retry-After. */
  readonly retryAt: number | null;
  constructor(status: number, code: string, message: string, callId: string | null, retryAt: number | null = null) {
    super(message);
    this.name = "TregRefusal";
    this.status = status;
    this.code = code;
    this.callId = callId;
    this.retryAt = retryAt;
  }
  /**
   * The provider is out of free capacity or rate-limited for now: wait and retry
   * later. The alternatives (blocked, tag caps) are ours to fix, not to wait out.
   */
  get temporary(): boolean {
    // Not `not_free`: that means a charge already happened despite the $0 ceiling,
    // so the cost guard failed and no call may be repeated.
    return ["route_max_cost", "provider_capacity", "insufficient_balance", "rate_limited", "trial_allowance_reached", "platform_daily_cap_reached", "tag_budget_unavailable"].includes(this.code)
      || (this.status === 429 && this.code !== "tag_blocked");
  }
  /**
   * A call that must be free would now be charged, and nothing says when that
   * changes: the provider's free allowance is gone. Waiting won't fix it.
   */
  get noFreeAllowance(): boolean {
    return this.code === "route_max_cost" && this.retryAt === null;
  }
  /** A short wait (a rate-limit window, or treg briefly unable to check a budget), not an empty allowance to back off from. */
  get brief(): boolean {
    return this.code === "rate_limited" || this.code === "tag_budget_unavailable";
  }
}

function retryAtFrom(res: Response, body: unknown, now = Date.now()): number | null {
  const after = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(after) && after > 0) return now + after * 1000;
  // Relayed provider headers: seconds until reset (Crustdata "43"), or an epoch in s or ms.
  const reset = Number(res.headers.get("X-RateLimit-Reset") ?? res.headers.get("X-RateLimit-Reset-Minute"));
  if (Number.isFinite(reset) && reset > 0) {
    const at = reset < 1e6 ? now + reset * 1000 : reset < 1e11 ? reset * 1000 : reset;
    if (at > now) return at;
  }
  const resets = (body as { resets_at?: unknown } | null)?.resets_at;
  const t = typeof resets === "string" ? Date.parse(resets) : typeof resets === "number" ? (resets < 1e12 ? resets * 1000 : resets) : NaN;
  return Number.isFinite(t) && t > now ? t : null;
}

export function formatMeta(meta: TregMeta): string {
  const pairs = Object.entries(meta);
  if (pairs.length > META_MAX_PAIRS) throw new Error(`treg meta allows at most ${META_MAX_PAIRS} tags, got ${pairs.length}`);
  return pairs
    .map(([k, val]) => {
      if (!META_KEY.test(k)) throw new Error(`treg meta key "${k}" must match [a-z0-9_]{1,32}`);
      if (!val || val.length > META_MAX_VALUE || /[@,=]/.test(val)) {
        throw new Error(`treg meta value for "${k}" must be 1-${META_MAX_VALUE} chars without "@", "," or "="`);
      }
      return `${k}=${val}`;
    })
    .join(", ");
}

/** treg errors that mean "do not retry, tell the caller": its own refusals, not a provider's. */
const REFUSAL_CODES = new Set([
  "insufficient_balance",
  "route_max_cost",
  "tag_blocked",
  "tag_spend_cap_reached",
  "tag_call_cap_reached",
  "tag_budget_unavailable",
  "platform_daily_cap_reached",
  "provider_capacity",
  "trial_allowance_reached",
]);

/**
 * Whether this deployment may spend real treg money. Only the dev and prod
 * configs set TREG_PAID_CALLS=on: the local stack, CI and scripts stay at $0,
 * so the only paid calls are ones a real user starts inside the app.
 */
export function paidCallsAllowed(): boolean {
  return process.env.TREG_PAID_CALLS === "on";
}

export async function tregCall(opts: {
  token: string;
  /** Catalog endpoint id, e.g. `hunter.people.email.find`. */
  endpoint: string;
  query?: Record<string, string>;
  /** JSON body; switches the call to POST. */
  body?: unknown;
  meta: TregMeta;
  /**
   * The call must cost nothing. Sends a $0 ceiling, so treg refuses (402)
   * anything that would bill, including the paid overflow relay, and throws
   * if a response still reports a charge.
   */
  free?: boolean;
  idempotencyKey?: string;
  /** Hard per-call ceiling in USD (`X-Treg-Route-Max-Cost`); treg refuses with 402 above it. */
  maxCostUsd?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Abort a call that hangs; Convex actions are killed at 10 minutes. Default 60 s. */
  timeoutMs?: number;
  /** Persist billing headers before body reads or HTTP error handling can throw. */
  onResponse?: (receipt: TregReceipt) => Promise<void>;
}): Promise<TregResult> {
  // A call with no $0 ceiling could bill (treg's default ceiling is $1 a call): refuse it before sending.
  if (!opts.free && opts.maxCostUsd !== 0 && !paidCallsAllowed()) {
    throw new TregRefusal(402, "paid_calls_off", `Paid data calls are switched off on this deployment (${opts.endpoint}).`, null);
  }
  const url = new URL(`/call/${opts.endpoint}`, opts.baseUrl ?? TREG_BASE_URL);
  for (const [k, val] of Object.entries(opts.query ?? {})) url.searchParams.set(k, val);
  const headers: Record<string, string> = { "X-Treg-Token": opts.token, "X-Treg-Meta": formatMeta(opts.meta) };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const maxCost = opts.free ? 0 : opts.maxCostUsd;
  if (maxCost !== undefined) headers["X-Treg-Route-Max-Cost"] = String(maxCost);
  const init: RequestInit = { method: "GET", headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.method = "POST";
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try { res = await (opts.fetchImpl ?? fetch)(url.toString(), init); }
  catch (error) { throw new TregTransportError(error); }
  const callId = res.headers.get("X-Treg-Call-Id");
  const cost = res.headers.get("X-Treg-Cost-Micro");
  const costMicro = cost === null ? null : Number(cost);
  await opts.onResponse?.({ status: res.status, callId, costMicro });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON provider body: relay it as text.
  }

  // treg's own refusals carry `X-Treg-Error: 1`; a provider's 4xx does not.
  // They are FastAPI errors, so the documented `{error, message}` arrives under `detail`.
  if (res.headers.get("X-Treg-Error")) {
    const raw = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
    const err = (raw && typeof raw === "object" ? raw : { message: typeof raw === "string" ? raw : undefined }) as {
      error?: string;
      message?: string;
    };
    const code = err.error ?? `http_${res.status}`;
    // A known refusal, or a status that is one; a generic 503 is an outage, retried like any error.
    // A rejected token is a deployment problem, not a call failure: say so plainly to the person who pressed the button.
    if (res.status === 401) {
      throw new ConvexError("Data search is unavailable: the data provider rejected this deployment's credentials (TREG_TOKEN). An admin needs to update the token.");
    }
    if (REFUSAL_CODES.has(code) || [402, 403, 429].includes(res.status)) {
      throw new TregRefusal(res.status, code, err.message ?? `treg refused the call (${code})`, callId, retryAtFrom(res, raw));
    }
    throw new Error(`treg ${opts.endpoint} failed: HTTP ${res.status} ${code} ${(err.message ?? "").slice(0, 200)}`);
  }

  // The provider's own rate limit, relayed: a wait, not an answer.
  if (res.status === 429) {
    throw new TregRefusal(429, "rate_limited", `${opts.endpoint} is rate-limited`, callId, retryAtFrom(res, body));
  }
  if (opts.free && costMicro) {
    throw new TregRefusal(res.status, "not_free", `treg charged ${costMicro} micro-USD for ${opts.endpoint}, which must be free`, callId);
  }
  return {
    status: res.status,
    body,
    callId,
    costMicro,
    replay: res.headers.get("X-Treg-Idempotent-Replay") === "true",
    rateRemaining: res.headers.has("X-RateLimit-Remaining") ? Number(res.headers.get("X-RateLimit-Remaining")) : null,
  };
}
