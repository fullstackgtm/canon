import { api } from "../../../../convex/_generated/api.js";
import { bearerToken, plainConvexClient, rateLimit, sha256 } from "../cli/_lib.ts";
import { isAgentToken, siteBase } from "../agents/_lib.ts";

/**
 * Auth gate for the Tier-1 public read endpoints (/api/public/*).
 *
 * These endpoints require a valid self-registered agent token — that is the
 * point of registration: reads are self-serve but attributable and revocable,
 * never anonymous. Scope checks are default-deny (the token must carry the
 * exact scope), and a 401 teaches the caller how to register (RFC 6750
 * WWW-Authenticate plus a register_uri hint in the body).
 */

export type AgentRegistrationInfo = {
  name: string;
  scopes: string[];
  expiresAt: number;
};

type GateResult = { registration: AgentRegistrationInfo } | { response: Response };

function unauthorized(request: Request, description: string): Response {
  const base = siteBase(request);
  return Response.json(
    {
      error: "unauthorized",
      message: `${description}. Register (free, instant) with POST ${base}/api/agents/register {"name", "operator_contact", "platform"?} to receive a read-only bearer token.`,
      register_uri: `${base}/api/agents/register`,
      docs_url: `${base}/auth.md`,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate":
          `Bearer realm="fullstackgtm-public", error="invalid_token", ` +
          `error_description="${description}", ` +
          `resource_metadata="${base}/.well-known/oauth-protected-resource", ` +
          `register_uri="${base}/api/agents/register"`,
      },
    },
  );
}

export async function requireAgentScope(
  request: Request,
  scope: string,
): Promise<GateResult> {
  if (!rateLimit(request, 60)) {
    return {
      response: Response.json(
        { error: "rate_limited", message: "Too many requests; retry shortly." },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    };
  }

  const token = bearerToken(request);
  if (!token) {
    return { response: unauthorized(request, "Missing bearer token") };
  }
  if (!isAgentToken(token)) {
    // Wrong credential type for this surface: Clerk sessions and broker
    // tokens have their own (org-scoped) surfaces; the public tier is keyed
    // to agent registrations so access stays attributable per agent.
    return {
      response: unauthorized(request, "This endpoint takes a self-registered fsgtm_agent_ token"),
    };
  }

  const client = plainConvexClient();
  const registration = await client.mutation(api.agentAuth.validate, {
    tokenHash: sha256(token),
  });
  if (!registration) {
    return {
      response: unauthorized(request, "Unknown, expired, or revoked agent token"),
    };
  }

  if (!registration.scopes.includes(scope)) {
    // Default-deny: a valid token without the exact scope gets a 403, never a
    // silent pass. (Today all agent tokens carry both read scopes; this guard
    // is what keeps that an explicit grant rather than an assumption.)
    return {
      response: Response.json(
        {
          error: "insufficient_scope",
          message: `This endpoint requires the "${scope}" scope.`,
          scopes: registration.scopes,
        },
        {
          status: 403,
          headers: {
            "WWW-Authenticate": `Bearer realm="fullstackgtm-public", error="insufficient_scope", scope="${scope}"`,
          },
        },
      ),
    };
  }

  return { registration };
}
