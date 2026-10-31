import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { plainConvexClient, rateLimit, sha256 } from "../../cli/_lib.ts";
import {
  AGENT_IDENTITY_TYPES,
  hashClientIp,
  newAgentClaimToken,
  newAgentToken,
  siteBase,
} from "../_lib.ts";

export const dynamic = "force-dynamic";

/**
 * Tier-1 agent self-registration (no human in the loop, by design): an agent
 * posts who it is and who operates it, and receives a scoped read-only
 * `fsgtm_agent_` bearer token for the public endpoints. The raw token exists
 * only in this response — Convex stores a SHA-256 hash (cliAuth idiom), and
 * only a salted hash of the caller IP is sent for rate limiting.
 *
 * Org-scoped access is a different tier and is never granted here: that
 * always goes through the human-approved pairing (see /auth.md).
 */
export const POST = publicGtmApi(async (request) => {
  // Edge limiter (per instance, fast-fail); the durable per-day/per-contact
  // limits are enforced in Convex where they survive restarts and replicas.
  if (!rateLimit(request, 10)) {
    return Response.json(
      {
        error: "rate_limited",
        message:
          "Too many registration attempts from this address. Wait a minute and retry — and reuse your token once registered (tokens last 90 days).",
      },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const operatorContact =
    typeof body.operator_contact === "string" ? body.operator_contact.trim() : "";
  const platform = typeof body.platform === "string" ? body.platform.trim() : undefined;

  // auth.md identity_endpoint shape: `type` is optional and "anonymous" is
  // the only identity type this issuer implements (absent = anonymous, so
  // existing callers are unaffected). Anything else gets a teaching error.
  if (body.type !== undefined && body.type !== "anonymous") {
    return Response.json(
      {
        error: "invalid_request",
        message:
          `identity type ${JSON.stringify(body.type)} is not supported. ` +
          `Supported identity types: ${AGENT_IDENTITY_TYPES.join(", ")}. ` +
          `Omit "type" or send {"type": "anonymous"}.`,
        identity_types_supported: AGENT_IDENTITY_TYPES,
      },
      { status: 400 },
    );
  }

  if (!name || name.length > 80) {
    return Response.json(
      { error: "invalid_request", message: "name is required (1-80 characters)" },
      { status: 400 },
    );
  }
  if (!operatorContact) {
    return Response.json(
      {
        error: "invalid_request",
        message:
          "operator_contact is required: an email address where the humans responsible for this agent can be reached",
      },
      { status: 400 },
    );
  }

  const token = newAgentToken();
  // auth.md claim ceremony: a one-time claim token, returned alongside the
  // bearer token so a signed-in user can later bind (claim) this anonymous
  // registration at /api/agents/claim. Stored hashed, like the bearer token.
  const claimToken = newAgentClaimToken();
  const client = plainConvexClient();
  let registration: { expiresAt: number; scopes: string[] };
  try {
    registration = await client.mutation(api.agentAuth.register, {
      name,
      operatorContact,
      platform: platform || undefined,
      tokenHash: sha256(token),
      registrationIpHash: hashClientIp(request),
      claimTokenHash: sha256(claimToken),
    });
  } catch (error) {
    const data = error instanceof ConvexError ? error.data : undefined;
    if (data && typeof data === "object" && "code" in data) {
      const { code, message, retryAfterSeconds } = data as {
        code: string;
        message?: string;
        retryAfterSeconds?: number;
      };
      if (code === "rate_limited") {
        return Response.json(
          {
            error: "rate_limited",
            message: message ?? "Registration rate limit reached; retry later.",
            retry_after_seconds: retryAfterSeconds,
          },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfterSeconds ?? 3600) },
          },
        );
      }
      if (code === "invalid_request") {
        return Response.json(
          { error: "invalid_request", message: message ?? "Invalid registration" },
          { status: 400 },
        );
      }
    }
    throw error;
  }

  const base = siteBase(request);
  return Response.json(
    {
      token,
      token_type: "Bearer",
      expires_at: new Date(registration.expiresAt).toISOString(),
      scopes: registration.scopes,
      // auth.md claim ceremony: hand this to a signed-in user and POST it to
      // claim_endpoint to bind this registration to their account. Claiming
      // records ownership only — it never widens the token's scopes.
      claim_token: claimToken,
      claim_endpoint: `${base}/api/agents/claim`,
      claim_instructions:
        "To bind this anonymous registration to a user account, a signed-in " +
        `user POSTs {"claim_token": "..."} to ${base}/api/agents/claim. ` +
        "Claiming records ownership (making the registration visible and " +
        "revocable from that account) and does NOT change the token's scopes " +
        "or grant organization data access.",
      endpoints: {
        leaderboard: `${base}/api/public/leaderboard`,
      },
      upgrade:
        "Organization CRM access requires a human-approved pairing — see the device flow in " +
        `${base}/.well-known/oauth-authorization-server and ${base}/auth.md`,
      revocation: {
        contact: "ryan@fullstackgtm.com",
        instructions:
          "Email the contact with your registration name and operator_contact to revoke a token; admins can also revoke server-side at any time. Store this token securely — it is shown exactly once.",
      },
      docs_url: `${base}/auth.md`,
    },
    { status: 201 },
  );
});
