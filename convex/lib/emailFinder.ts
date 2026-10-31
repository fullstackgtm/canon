import { paidCallsAllowed, tregCall, type TregMeta, type TregReceipt } from "./treg.ts";

/** Work email for one contact, on demand (when a rep acts on the contact). */
export type EmailResult = {
  email: string | null;
  status: "found" | "not_found";
  provider: "treg:hunter" | "treg:getleadsio" | "treg:millionverifier" | "treg:bounceban" | "deepline";
  /** USD millionths treg charged. */
  costMicro: number;
  /** `X-Treg-Call-Id`, to reconcile against treg's usage/by-tag ledger. */
  callId?: string;
};

/** A full name as first name and the rest, or null when it is one word: email finders need both. */
export function splitFullName(fullName: string): { first: string; last: string } | null {
  const [first, ...rest] = fullName.trim().split(/\s+/);
  return first && rest.length ? { first, last: rest.join(" ") } : null;
}

export const EMAIL_PATTERNS = ["first.last", "flast", "first", "firstlast", "firstl", "first_last", "last"] as const;
export type EmailPattern = typeof EMAIL_PATTERNS[number];
export type VerifiedEmail = { email: string | null; emailStatus: "valid" | "catch_all" | "invalid" | "not_checked"; provider: EmailResult["provider"]; callId?: string; /** A Hunter hit: it spent a slot of the monthly allowance. */ paid?: boolean };
const namePart = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");
export function emailGuesses(fullName: string, domain: string, known?: string) {
  const name = splitFullName(fullName);
  if (!name) return [];
  const first = namePart(name.first), last = namePart(name.last);
  if (!first || !last) return [];
  const local: Record<EmailPattern, string> = { "first.last": `${first}.${last}`, flast: `${first[0]}${last}`, first, firstlast: `${first}${last}`, firstl: `${first}${last[0]}`, first_last: `${first}_${last}`, last };
  const patterns = [...new Set([...(EMAIL_PATTERNS.includes(known as EmailPattern) ? [known as EmailPattern] : []), ...EMAIL_PATTERNS])];
  return patterns.map((pattern) => ({ pattern, email: `${local[pattern]}@${domain}` }));
}

export async function guessAndVerifyEmail(opts: {
  fullName: string; domain: string; knownPattern?: string;
  verify: (email: string, catchAll: boolean) => Promise<VerifiedEmail>;
  find: () => Promise<string | null>;
  learn: (pattern: EmailPattern) => Promise<void>;
}): Promise<VerifiedEmail> {
  const guesses = emailGuesses(opts.fullName, opts.domain, opts.knownPattern);
  let catchAll = false;
  for (const guess of guesses) {
    let result = await opts.verify(guess.email, false);
    if (result.emailStatus === "catch_all") { catchAll = true; result = await opts.verify(guess.email, true); }
    if (result.emailStatus === "valid") { await opts.learn(guess.pattern); return { ...result, email: guess.email }; }
  }
  const found = await opts.find();
  if (found) {
    let result = await opts.verify(found, false);
    if (result.emailStatus === "catch_all") { catchAll = true; result = await opts.verify(found, true); }
    if (result.emailStatus === "valid") {
      const pattern = guesses.find((g) => g.email === found)?.pattern;
      if (pattern) await opts.learn(pattern);
      return { ...result, email: found };
    }
  }
  return { email: null, emailStatus: catchAll ? "catch_all" : "invalid", provider: "treg:millionverifier" };
}

/** Both on-demand email and company people use this waterfall; provider finders stay last. */
export async function findVerifiedWorkEmail(opts: {
  token: string; fullName: string; domain: string; meta: TregMeta; knownPattern?: string;
  learn: (pattern: EmailPattern) => Promise<void>;
  allowFreeFinder: () => Promise<boolean>; allowPaidFinder: () => Promise<boolean>;
  receipt: (endpoint: string, receipt: TregReceipt, hit?: boolean) => Promise<void>;
  baseUrl?: string; fetchImpl?: typeof fetch;
}): Promise<VerifiedEmail> {
  if (!paidCallsAllowed()) return { email: null, emailStatus: "not_checked", provider: "treg:millionverifier" };
  const deadline = Date.now() + 45_000;
  const timeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Email lookup time budget reached.");
    return Math.min(20_000, remaining);
  };
  let hunterEmail: string | null = null;
  const result = await guessAndVerifyEmail({ ...opts,
    verify: async (email, catchAll) => {
      const endpoint = catchAll ? "bounceban.people.email.verify" : "millionverifier.people.email.verify";
      const res = await tregCall({ ...opts, endpoint, query: catchAll ? { email } : { email, timeout: "5" }, timeoutMs: timeout(), maxCostUsd: catchAll ? 0.004 : 0.00178, onResponse: (r) => opts.receipt(endpoint, r) });
      if (res.status !== 200) throw new Error("Email verification unavailable.");
      const body = res.body as { result?: string; status?: string; is_accept_all?: boolean };
      const valid = catchAll ? body.status === "success" && body.result === "deliverable" : body.result === "ok";
      return { email: valid ? email : null, emailStatus: valid ? "valid" : body.result === "catch_all" || body.is_accept_all || (catchAll && body.status === "verifying") ? "catch_all" : "invalid", provider: catchAll ? "treg:bounceban" : "treg:millionverifier", ...(res.callId ? { callId: res.callId } : {}) };
    },
    find: async () => {
      if (await opts.allowFreeFinder()) {
        try {
          const found = await findWorkEmailViaGetleads({ ...opts, timeoutMs: timeout() });
          await opts.receipt(GETLEADS_EMAIL_ENDPOINT, { status: 200, callId: found.callId ?? null, costMicro: found.costMicro }, Boolean(found.email));
          if (found.email) return found.email;
        } catch { /* The paid finder can still answer a free-source outage. */ }
      }
      if (!await opts.allowPaidFinder()) return null;
      const found = await findWorkEmailViaTreg({ ...opts, timeoutMs: timeout() });
      hunterEmail = found.email;
      await opts.receipt(TREG_EMAIL_ENDPOINT, { status: 200, callId: found.callId ?? null, costMicro: found.costMicro }, Boolean(found.email));
      return found.email;
    },
  });
  return result.email && result.email === hunterEmail ? { ...result, provider: "treg:hunter", paid: true } : result;
}

export const TREG_EMAIL_ENDPOINT = "hunter.people.email.find";

/**
 * The same lookup through treg.to's Hunter endpoint (1 Hunter credit, billed
 * by treg in USD only when an email is found). `meta` must carry
 * `customer=<orgId>` so treg attributes the spend to the workspace.
 */
export async function findWorkEmailViaTreg(opts: {
  token: string;
  fullName: string;
  domain: string;
  meta: TregMeta;
  idempotencyKey?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<EmailResult> {
  const res = await tregCall({
    token: opts.token,
    endpoint: TREG_EMAIL_ENDPOINT,
    query: { full_name: opts.fullName, domain: opts.domain },
    meta: opts.meta,
    idempotencyKey: opts.idempotencyKey,
    timeoutMs: opts.timeoutMs,
    // One Hunter search credit is a few cents; refuse anything far above that.
    maxCostUsd: 0.25,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
  });
  const meter = { provider: "treg:hunter" as const, costMicro: res.costMicro ?? 0, ...(res.callId ? { callId: res.callId } : {}) };
  // Hunter answers a miss with 404 or with `data.email: null`; both are free.
  if (res.status === 404) return { email: null, status: "not_found", ...meter };
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`treg Hunter email lookup failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  const data = (res.body as { data?: { email?: unknown; verification?: { status?: string } | null } } | null)?.data;
  const raw = typeof data?.email === "string" && data.email.includes("@") ? data.email.toLowerCase() : null;
  const email = raw && data?.verification?.status !== "invalid" ? raw : null;
  return { email, status: email ? "found" : "not_found", ...meter };
}

export const GETLEADS_EMAIL_ENDPOINT = "getleadsio.people.enrich.from_person";

/**
 * The same lookup through getleadsio's person enrich: name + domain -> work
 * email. treg bills it at $0 (sent with a $0 ceiling), though each hit spends
 * one of treg's own getleadsio credits, so callers cap it per day.
 */
export async function findWorkEmailViaGetleads(opts: {
  token: string;
  fullName: string;
  domain: string;
  meta: TregMeta;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EmailResult> {
  const name = splitFullName(opts.fullName);
  const meter = { provider: "treg:getleadsio" as const, costMicro: 0 };
  if (!name) return { email: null, status: "not_found", ...meter };
  const res = await tregCall({
    token: opts.token,
    endpoint: GETLEADS_EMAIL_ENDPOINT,
    body: { items: [{ first_name: name.first, last_name: name.last, email_domain: opts.domain }] },
    meta: opts.meta,
    free: true,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  if (res.status !== 200) throw new Error(`getleadsio email lookup failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  const hit = (res.body as { results?: Array<{ success?: boolean; email?: unknown }> } | null)?.results?.[0];
  const email = hit?.success && typeof hit.email === "string" && hit.email.includes("@") ? hit.email.toLowerCase() : null;
  return { email, status: email ? "found" : "not_found", ...meter, ...(res.callId ? { callId: res.callId } : {}) };
}
