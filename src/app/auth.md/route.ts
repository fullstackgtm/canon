/**
 * Human/agent-readable auth pointer for canoncrm.com (Cloudflare
 * Agent Readiness `auth.md` convention). Machine-readable counterparts:
 * /.well-known/oauth-protected-resource (RFC 9728) and
 * /.well-known/oauth-authorization-server (RFC 8414).
 */
import {
  AGENT_REVOCATION_CONTACT,
  clerkIssuer,
  protectedResourceMetadata,
} from "../.well-known/_lib.ts";

export function GET() {
  const metadata = protectedResourceMetadata();
  const resource = metadata.resource;
  const issuer = clerkIssuer();

  const body = `# Authentication: ${resource}

Two tiers, on purpose: **reads are self-serve, anything touching an
organization's CRM data always has a human in the loop.**

## Tier 1 — self-registered agents (public reads)

Any agent can register itself and immediately get a read-only token:

\`\`\`
POST ${resource}/api/agents/register
{"name": "my-agent", "operator_contact": "you@example.com", "platform": "openai"}
\`\`\`

\`type\` is optional; \`"anonymous"\` is the only identity type supported
(auth.md spec) and is the default. The 201 response contains a
\`fsgtm_agent_…\` bearer token (shown once, 90-day expiry) scoped to
\`read:evals\`, plus a one-time \`claim_token\`. The bearer token works ONLY on:

- \`GET ${resource}/api/public/leaderboard\` — CRM-Ops Bench results

Registration is rate-limited (5/day per address, 3 active per operator
contact). Tokens are revocable at any time; contact ${AGENT_REVOCATION_CONTACT}.
Agent tokens are rejected on every organization-scoped route — no exceptions.

### Claiming an anonymous registration (auth.md claim ceremony)

A signed-in user can bind an anonymous registration to their account:

\`\`\`
POST ${resource}/api/agents/claim   (requires a signed-in user — Clerk session/JWT)
{"claim_token": "fsgtm_claim_…"}
\`\`\`

Claiming records ownership — the registration becomes visible and revocable
from that account. What claiming does NOT do: it never changes the agent
token's scopes and never grants organization data access. A claimed agent
token is exactly as limited as an unclaimed one; org access always requires
the human-approved pairing below. Re-claiming with the same user is
idempotent; a claim token already claimed by another user returns 409.

## Tier 2 — human-approved pairing (organization access)

- **CLI / agent pairing**: run \`fullstackgtm login --via ${resource}\` — a
  device-flow pairing that a signed-in operator must approve in the dashboard
  before a broker token is issued. Tokens are never granted automatically.
- **Standard RFC 8628 device flow** (same approval, standards-shaped):
  \`POST ${resource}/api/oauth/device_authorization\`, send the user to
  ${resource}/activate, then poll \`POST ${resource}/api/oauth/token\` with
  \`grant_type=urn:ietf:params:oauth:grant-type:device_code\`.
- **Humans**: sign in at ${resource}/sign-in (Clerk).
- **API requests**: send \`Authorization: Bearer <token>\` (header only).

## Machine-readable discovery

- **Resource metadata (RFC 9728)**: ${resource}/.well-known/oauth-protected-resource
- **Agent issuer metadata (RFC 8414, incl. \`agent_auth\`)**: ${resource}/.well-known/oauth-authorization-server
- **OIDC issuer (humans, Clerk)**: ${issuer}/.well-known/openid-configuration
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
