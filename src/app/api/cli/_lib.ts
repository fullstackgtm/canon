import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";

/**
 * CLI broker endpoints are unauthenticated by design (RFC 8628-style device
 * flow): the secrets ARE the credentials. Device codes are high-entropy and
 * hashed at rest; approval requires an authenticated dashboard session.
 */
export function plainConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function newDeviceCode() {
  return randomBytes(32).toString("hex");
}

export function newCliToken() {
  return `fsgtm_${randomBytes(32).toString("hex")}`;
}

// Unambiguous alphabet (no 0/O/1/I) for the human-facing pairing code.
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newUserCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += USER_CODE_ALPHABET[bytes[index] % USER_CODE_ALPHABET.length];
    if (index === 3) code += "-";
  }
  return code;
}

export function bearerToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Best-effort per-IP sliding-window limiter for the public device-flow
 * endpoints. In-memory and per-instance — a real deployment should also have
 * a WAF/edge limit — but it removes the trivial single-client flood and is
 * scoped per IP so one abusive client can't lock out everyone (the previous
 * global counter could). Returns true when the request is allowed.
 */
const ipHits = new Map<string, number[]>();

export function rateLimit(request: Request, limit = 30, windowMs = 60_000): boolean {
  const key = clientIp(request);
  const now = Date.now();
  const hits = (ipHits.get(key) ?? []).filter((time) => time > now - windowMs);
  if (hits.length >= limit) {
    ipHits.set(key, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(key, hits);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (ipHits.size > 10_000) {
    for (const [ip, times] of ipHits) {
      if (times.every((time) => time <= now - windowMs)) ipHits.delete(ip);
    }
  }
  return true;
}

export function tooManyRequests() {
  return Response.json({ error: "Too many requests" }, { status: 429 });
}

/** The one auth failure recordRun/mintProviderToken raise via ConvexError. */
export const INVALID_CLI_TOKEN = "Invalid or revoked CLI token";

/**
 * Map ONLY the genuine broker-token auth failure to a 401. Any other error — an
 * undeployed/missing Convex function, a backend outage, a downstream mutation or
 * provider bug — must surface honestly (return null → caller rethrows → 500 with
 * the real message) instead of masquerading as a bad token and sending operators
 * chasing phantom auth issues.
 */
export function invalidCliTokenResponse(error: unknown): Response | null {
  const data = error instanceof ConvexError ? error.data : undefined;
  return data === INVALID_CLI_TOKEN
    ? Response.json({ error: INVALID_CLI_TOKEN }, { status: 401 })
    : null;
}
