import { siteUrl } from "../../lib/siteUrl.ts";
/**
 * OAuth discovery metadata for canoncrm.com.
 *
 * Two documents, both truthful to what is actually implemented:
 *
 * - RFC 9728 protected-resource metadata: this app is a protected resource
 *   whose authorization servers are (1) Clerk — humans and dashboard
 *   sessions — and (2) the app itself, which issues agent credentials.
 *
 * - RFC 8414 authorization-server metadata for the app-as-issuer: agent
 *   self-registration (registration_endpoint → scoped read-only tokens) and
 *   the RFC 8628 device flow (device_authorization_endpoint + token_endpoint
 *   → human-approved org broker tokens). No authorization endpoint exists —
 *   there are no redirect-based flows — so response_types_supported is
 *   truthfully empty. The `agent_auth` block follows the WorkOS convention
 *   so agent platforms can discover self-registration.
 *
 * `scopes_supported` on the resource document: the issuer OIDC scopes (what
 * a Clerk client requests) plus the agent read scopes, which ARE enforced
 * per-scope on /api/public/* (default-deny; see src/app/api/public/_lib.ts).
 */

// Production Clerk issuer, verified via the pk_live_ publishable key and the
// issuer's /.well-known/openid-configuration. CLERK_JWT_ISSUER_DOMAIN (same
// value the app and Convex use for JWT verification) overrides this per env.
const DEFAULT_AUTHORIZATION_SERVER = "https://clerk.fullstackgtm.com";

export const AGENT_SCOPES = ["read:evals"];
export const AGENT_REVOCATION_CONTACT = "ryan@fullstackgtm.com";

function normalizeOrigin(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || fallback;
}

export function appOrigin(): string {
  return siteUrl();
}

export function clerkIssuer(): string {
  return normalizeOrigin(
    process.env.CLERK_JWT_ISSUER_DOMAIN,
    DEFAULT_AUTHORIZATION_SERVER,
  );
}

export function protectedResourceMetadata() {
  return {
    resource: appOrigin(),
    // Clerk (humans/orgs) plus the app itself (agent registration + device
    // flow). Order matters to nobody per RFC 9728, but Clerk stays first as
    // the primary issuer for interactive use.
    authorization_servers: [clerkIssuer(), appOrigin()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", ...AGENT_SCOPES],
    resource_documentation: `${appOrigin()}/llms.txt`,
  };
}

export function authorizationServerMetadata() {
  const issuer = appOrigin();
  return {
    issuer,
    // Tier 1 — self-serve, read-only: POST {name, operator_contact,
    // platform?} → scoped fsgtm_agent_ bearer token. Not OIDC Dynamic Client
    // Registration; it registers an agent credential directly.
    registration_endpoint: `${issuer}/api/agents/register`,
    // Tier 2 — RFC 8628 device flow onto the human-approved pairing: the
    // token endpoint only ever succeeds after an org admin approves the
    // user_code in the dashboard.
    device_authorization_endpoint: `${issuer}/api/oauth/device_authorization`,
    token_endpoint: `${issuer}/api/oauth/token`,
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
    // No authorization endpoint / redirect flows exist on this issuer.
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...AGENT_SCOPES],
    service_documentation: `${issuer}/auth.md`,
    // WorkOS auth.md agent_auth convention: how agents self-register and who
    // to contact about a credential. Everything listed is implemented — one
    // complete registration method, the spec's "anonymous" identity type:
    // POST {type:"anonymous", ...} to identity_endpoint returns a bearer
    // credential plus a claim_token, and a signed-in user can later bind
    // (claim) the registration at claim_endpoint. We deliberately do NOT
    // advertise identity_assertion, service_auth, or events_endpoint — those
    // are not implemented. Claiming binds ownership only; it never widens
    // the token's scopes (org access stays behind the human-approved
    // pairing/device flow above).
    agent_auth: {
      // Per the auth.md spec, `skill` is the URL of the AUTH.md file that
      // teaches an agent this service's registration/auth flows.
      skill: `${issuer}/auth.md`,
      register_uri: `${issuer}/api/agents/register`,
      claim_uri: `${issuer}/api/agents/claim`,
      identity_types_supported: ["anonymous"],
      identity_endpoint: `${issuer}/api/agents/register`,
      claim_endpoint: `${issuer}/api/agents/claim`,
      // Per-method config: validators expect the method's credential types
      // and claim URI nested under the identity-type key.
      anonymous: {
        credential_types_supported: ["bearer_token"],
        registration_uri: `${issuer}/api/agents/register`,
        claim_uri: `${issuer}/api/agents/claim`,
      },
      credential_types_supported: ["bearer_token"],
      registration_scopes: [...AGENT_SCOPES],
      revocation_contact: AGENT_REVOCATION_CONTACT,
      documentation: `${issuer}/auth.md`,
    },
  };
}
