import { randomBytes } from "node:crypto";
import { clientIp, sha256 } from "../cli/_lib.ts";

/**
 * Tier-1 agent self-registration helpers.
 *
 * The tier model in one place:
 *   - `fsgtm_agent_` tokens (minted here, self-serve): public read endpoints
 *     under /api/public/* ONLY. Never org-scoped, never tenant data.
 *   - `fsgtm_` broker tokens (human-approved pairing, convex/cliAuth.ts):
 *     org-scoped CLI/API access.
 *   - Clerk sessions/JWTs: the dashboard and /api/gtm/*.
 *
 * Everything below exists to keep that boundary crisp: distinct token prefix,
 * default-deny scope checks, and a teaching rejection wherever an agent token
 * shows up on an org-scoped surface.
 */

export const AGENT_TOKEN_PREFIX = "fsgtm_agent_";

export function newAgentToken() {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/**
 * auth.md identity types this issuer implements. "anonymous" is the only
 * one: register with no user identity, get a claim_token, and a signed-in
 * user may later bind (claim) the registration at /api/agents/claim.
 */
export const AGENT_IDENTITY_TYPES = ["anonymous"];

/**
 * One-time claim token (auth.md claim ceremony). Distinct prefix so it can
 * never be confused with — or used as — a bearer token; like bearer tokens
 * it is shown once and only its SHA-256 hash is stored.
 */
export const AGENT_CLAIM_TOKEN_PREFIX = "fsgtm_claim_";

export function newAgentClaimToken() {
  return `${AGENT_CLAIM_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function isAgentToken(token: string | null | undefined): token is string {
  return Boolean(token?.startsWith(AGENT_TOKEN_PREFIX));
}

/**
 * Salted hash of the caller IP for durable registration rate limiting. The
 * raw IP is never stored or sent to Convex. Set FSGTM_AGENT_IP_SALT in
 * production so the hash isn't brute-forceable from the (small) IPv4 space;
 * the fallback keeps the limiter working when unset.
 */
export function hashClientIp(request: Request) {
  const salt = process.env.FSGTM_AGENT_IP_SALT ?? "fsgtm-agent-registration-v1";
  return sha256(`${salt}:${clientIp(request)}`);
}

/** Public base URL — same proxy-aware fallback the CLI pairing route uses. */
export function siteBase(request: Request) {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
    new URL(request.url).origin
  );
}

/**
 * Default-deny enforcement for org-scoped surfaces: a self-registered agent
 * token is rejected with a teaching error that names the upgrade path
 * (human-approved pairing), instead of a bare 401 that reads like a typo.
 * Returns null for every other credential so existing token types keep
 * exactly today's behavior.
 */
export function agentTokenRejection(
  token: string | null | undefined,
  request: Request,
): Response | null {
  if (!isAgentToken(token)) return null;
  const base = siteBase(request);
  return Response.json(
    {
      error: "insufficient_scope",
      message:
        "Self-registered agent tokens are read-only and only valid on the public endpoints (/api/public/leaderboard). Organization CRM data requires a human-approved pairing: run `fullstackgtm login --via " +
        base +
        "` and have an org admin approve the code at " +
        base +
        "/activate. Details: " +
        base +
        "/auth.md",
      register_uri: `${base}/api/agents/register`,
      pairing_uri: `${base}/activate`,
      docs_url: `${base}/auth.md`,
    },
    {
      status: 403,
      headers: {
        "WWW-Authenticate": `Bearer realm="fullstackgtm", error="insufficient_scope", error_description="agent tokens cannot access organization data"`,
      },
    },
  );
}
