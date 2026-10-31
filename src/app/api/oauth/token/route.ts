import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi } from "../../gtm/_lib.ts";
import {
  newCliToken,
  plainConvexClient,
  rateLimit,
  sha256,
  tooManyRequests,
} from "../../cli/_lib.ts";
import {
  DEVICE_CODE_GRANT,
  oauthError,
  pollTooFast,
  readOauthBody,
} from "../_lib.ts";

export const dynamic = "force-dynamic";

// Matches cliAuth's TOKEN_TTL_MS (90 days) — the broker token the claim mints.
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * RFC 8628 §3.4–3.5 token endpoint for the device-code grant. Success means
 * a human approved the pairing in the dashboard; the access token returned is
 * the SAME broker token the legacy CLI pairing issues (`fsgtm_` prefix,
 * org-scoped, revocable at /dashboard/cli-auth). Errors use the RFC shapes:
 * authorization_pending / slow_down / expired_token / access_denied.
 */
export const POST = publicGtmApi(async (request) => {
  if (!rateLimit(request, 60)) return tooManyRequests();

  const body = await readOauthBody(request);
  if (body.grant_type !== DEVICE_CODE_GRANT) {
    return oauthError(
      "unsupported_grant_type",
      `grant_type must be ${DEVICE_CODE_GRANT}`,
    );
  }
  const deviceCode = body.device_code;
  if (!deviceCode) {
    return oauthError("invalid_request", "device_code is required");
  }

  const deviceCodeHash = sha256(deviceCode);
  if (pollTooFast(deviceCodeHash)) {
    return oauthError(
      "slow_down",
      "Polling faster than the advertised interval; increase your poll interval by 5 seconds",
    );
  }

  const client = plainConvexClient();
  const { status } = await client.mutation(api.cliAuth.poll, { deviceCodeHash });
  if (status === "pending") {
    return oauthError(
      "authorization_pending",
      "The operator has not approved the code yet; keep polling at the advertised interval",
    );
  }
  if (status === "denied") {
    return oauthError("access_denied", "The operator denied this pairing request");
  }
  if (status === "claimed") {
    return oauthError("invalid_grant", "This device code was already redeemed");
  }
  if (status !== "approved") {
    return oauthError(
      "expired_token",
      "This device code is expired or unknown; start a new device authorization",
    );
  }

  const accessToken = newCliToken();
  try {
    await client.mutation(api.cliAuth.claim, {
      deviceCodeHash,
      tokenHash: sha256(accessToken),
    });
  } catch {
    // Concurrently claimed/expired between poll and claim — never hand back
    // a token that was not persisted. (Same guard as /api/cli/auth/poll.)
    return oauthError(
      "expired_token",
      "This device code expired or was redeemed concurrently; start a new device authorization",
    );
  }

  return Response.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
});
