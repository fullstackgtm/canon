import { api } from "../../../../../../convex/_generated/api";
import { publicGtmApi, readJsonBody } from "../../../gtm/_lib";
import {
  clientIp,
  newDeviceCode,
  newUserCode,
  authBrokerClient,
  rateLimit,
  sha256,
  tooManyRequests,
} from "../../_lib";

export const POST = publicGtmApi(async (request) => {
  if (!rateLimit(request, "/api/cli/auth/start", 10)) return tooManyRequests();

  const body = await readJsonBody(request);
  const requesterLabel =
    typeof body.requesterLabel === "string" ? body.requesterLabel : undefined;

  const deviceCode = newDeviceCode();
  const userCode = newUserCode();
  const client = authBrokerClient();
  const { expiresInSeconds } = await client.action(api.cliAuth.startFromServer, {
    registrationIpHash: sha256(clientIp(request)),
    deviceCodeHash: sha256(deviceCode),
    userCode,
    requesterLabel,
  });

  // Use the configured public origin so an internal proxy URL cannot send
  // the operator to an unreachable approval link.
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
    new URL(request.url).origin;
  return Response.json({
    deviceCode,
    userCode,
    verificationUrl: `${base}/dashboard/cli-auth?code=${encodeURIComponent(userCode)}`,
    expiresInSeconds,
    intervalSeconds: 3,
  });
});
