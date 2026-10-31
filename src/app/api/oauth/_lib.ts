/**
 * RFC 8628 device-flow plumbing. These endpoints are a standards-shaped
 * front door onto the EXISTING cliAuth pairing machinery: the same pending →
 * human-approves-in-dashboard → claim lifecycle, the same broker token. The
 * legacy /api/cli/auth/* routes remain for CLI back-compat.
 */

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_FLOW_INTERVAL_SECONDS = 5;
export const DEVICE_FLOW_EXPIRES_IN_SECONDS = 900;

/** RFC 6749 §5.2 / RFC 8628 §3.5 error envelope. Always no-store. */
export function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Token requests are form-encoded per RFC; JSON is accepted as a courtesy to
 * agent frameworks that only speak JSON.
 */
export async function readOauthBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await request.text().catch(() => "");
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") out[key] = value;
        }
        return out;
      }
    } catch {
      // fall through to the empty result below
    }
    return {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * RFC 8628 §3.5 slow_down: reject polls faster than the advertised interval.
 * Best-effort and per-instance, same trade-off as the cli/_lib rate limiter —
 * a WAF should back it up; this stops the naive tight-loop client.
 */
const lastPollAt = new Map<string, number>();

export function pollTooFast(
  deviceCodeHash: string,
  intervalSeconds = DEVICE_FLOW_INTERVAL_SECONDS,
  now = Date.now(),
): boolean {
  const last = lastPollAt.get(deviceCodeHash);
  lastPollAt.set(deviceCodeHash, now);
  if (lastPollAt.size > 10_000) {
    for (const [key, at] of lastPollAt) {
      if (at <= now - 3_600_000) lastPollAt.delete(key);
    }
  }
  return last !== undefined && now - last < intervalSeconds * 1000;
}
