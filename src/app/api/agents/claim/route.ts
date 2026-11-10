import { ConvexError } from "convex/values";
import { api } from "../../../../../convex/_generated/api.js";
import { gtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { sha256 } from "../../cli/_lib.ts";
import { siteBase } from "../_lib.ts";

export const dynamic = "force-dynamic";

/**
 * auth.md claim ceremony: a SIGNED-IN USER binds an anonymous agent
 * registration to their account by presenting the claim_token from the
 * registration response.
 *
 * This route is deliberately NOT in src/publicPaths.ts — it sits behind the
 * Clerk session gate, and the caller's Clerk credential is forwarded to
 * Convex (the gtmApi idiom every org-scoped route uses), where
 * agentAuth.claim resolves the user. This is the "user authenticates" step
 * of the ceremony: agents cannot claim themselves — gtmApi also rejects
 * `fsgtm_agent_` bearer tokens outright with the teaching 403.
 *
 * SECURITY LINE — claiming is an ownership binding, never an access upgrade.
 * It stamps claimedByUserId/claimedByOrgId/claimedAt on the registration and
 * nothing else: the agent's bearer token keeps its fixed read-only scopes
 * and is still rejected on every org-scoped route. Organization data access
 * continues to require the human-approved pairing/device flow.
 */
export const POST = gtmApi(async ({ request, client }) => {
  const body = await readJsonBody(request);
  const claimToken =
    typeof body.claim_token === "string" ? body.claim_token.trim() : "";
  const base = siteBase(request);

  if (!claimToken) {
    return Response.json(
      {
        error: "invalid_request",
        message:
          'claim_token is required: the "fsgtm_claim_..." value returned by ' +
          `POST ${base}/api/agents/register. Details: ${base}/auth.md`,
      },
      { status: 400 },
    );
  }

  try {
    const claimed = await client.mutation(api.agentAuth.claim, {
      claimTokenHash: sha256(claimToken),
    });
    return Response.json({
      claimed: true,
      already_claimed: claimed.alreadyClaimed,
      agent: {
        name: claimed.name,
        scopes: claimed.scopes,
        expires_at: new Date(claimed.expiresAt).toISOString(),
      },
      claimed_at: new Date(claimed.claimedAt).toISOString(),
      // State the security line where agents will actually read it.
      note:
        "Claiming binds ownership only. The agent token keeps its read-only " +
        "scopes and still cannot access organization data — that requires " +
        `the human-approved pairing described at ${base}/auth.md`,
    });
  } catch (error) {
    const data = error instanceof ConvexError ? error.data : undefined;
    if (data && typeof data === "object" && "code" in data) {
      const { code, message } = data as { code: string; message?: string };
      if (code === "not_authenticated") {
        return Response.json(
          {
            error: "unauthorized",
            message:
              message ??
              "Claiming an agent registration requires a signed-in user",
            sign_in: `${base}/sign-in`,
          },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer realm="fullstackgtm", error="invalid_token"',
            },
          },
        );
      }
      if (code === "not_found") {
        return Response.json(
          {
            error: "not_found",
            message: message ?? "Unknown, revoked, or expired claim token",
          },
          { status: 404 },
        );
      }
      if (code === "conflict") {
        return Response.json(
          {
            error: "conflict",
            message:
              message ??
              "This agent registration has already been claimed by another user",
          },
          { status: 409 },
        );
      }
      if (code === "invalid_request") {
        return Response.json(
          { error: "invalid_request", message: message ?? "Invalid claim request" },
          { status: 400 },
        );
      }
    }
    throw error;
  }
});
