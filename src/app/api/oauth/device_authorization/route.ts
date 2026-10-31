import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi } from "../../gtm/_lib.ts";
import {
  newDeviceCode,
  newUserCode,
  plainConvexClient,
  rateLimit,
  sha256,
  tooManyRequests,
} from "../../cli/_lib.ts";
import { siteBase } from "../../agents/_lib.ts";
import {
  DEVICE_FLOW_EXPIRES_IN_SECONDS,
  DEVICE_FLOW_INTERVAL_SECONDS,
  readOauthBody,
} from "../_lib.ts";

export const dynamic = "force-dynamic";

/**
 * RFC 8628 §3.1–3.2 device authorization endpoint, mapped onto the existing
 * cliAuth pairing: the user_code must be approved by a signed-in org
 * admin/manager at /activate before the token endpoint will ever succeed.
 * No client registration is required (public clients, auth method "none");
 * an optional client_id is surfaced to the approver as the requester label.
 */
export const POST = publicGtmApi(async (request) => {
  if (!rateLimit(request, 10)) return tooManyRequests();

  const body = await readOauthBody(request);
  const requesterLabel =
    body.client_id?.slice(0, 120) ||
    request.headers.get("user-agent")?.slice(0, 120) ||
    undefined;

  const deviceCode = newDeviceCode();
  const userCode = newUserCode();
  const client = plainConvexClient();
  const { expiresInSeconds } = await client.mutation(api.cliAuth.start, {
    deviceCodeHash: sha256(deviceCode),
    userCode,
    requesterLabel,
    ttlSeconds: DEVICE_FLOW_EXPIRES_IN_SECONDS,
  });

  const base = siteBase(request);
  return Response.json(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/activate`,
      verification_uri_complete: `${base}/activate?code=${encodeURIComponent(userCode)}`,
      expires_in: expiresInSeconds,
      interval: DEVICE_FLOW_INTERVAL_SECONDS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
