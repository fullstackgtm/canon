import { api } from "../../../../../../convex/_generated/api";
import { publicGtmApi, readJsonBody } from "../../../gtm/_lib";
import {
  newDeviceCode,
  newUserCode,
  plainConvexClient,
  rateLimit,
  sha256,
  tooManyRequests,
} from "../../_lib";

export const POST = publicGtmApi(async (request) => {
  if (!rateLimit(request, 10)) return tooManyRequests();

  const body = await readJsonBody(request);
  const provider =
    body.provider === "hubspot" || body.provider === "salesforce" ? body.provider : null;
  if (!provider) {
    return Response.json({ error: "Unsupported provider" }, { status: 400 });
  }
  const requesterLabel =
    typeof body.requesterLabel === "string" ? body.requesterLabel : undefined;

  const deviceCode = newDeviceCode();
  const userCode = newUserCode();
  const client = plainConvexClient();
  const { expiresInSeconds } = await client.mutation(api.cliAuth.start, {
    deviceCodeHash: sha256(deviceCode),
    userCode,
    requesterLabel,
    provider,
  });

  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || new URL(request.url).origin;
  return Response.json({
    deviceCode,
    userCode,
    verificationUrl: `${base}/oauth/${provider}?code=${encodeURIComponent(userCode)}`,
    expiresInSeconds,
    intervalSeconds: 3,
  });
});
