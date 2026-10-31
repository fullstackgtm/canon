import { api } from "../../../../../../convex/_generated/api";
import { publicGtmApi, readJsonBody } from "../../../gtm/_lib";
import {
  newCliToken,
  plainConvexClient,
  rateLimit,
  sha256,
  tooManyRequests,
} from "../../_lib";

export const POST = publicGtmApi(async (request) => {
  if (!rateLimit(request, 60)) return tooManyRequests();

  const body = await readJsonBody(request);
  const deviceCode = typeof body.deviceCode === "string" ? body.deviceCode : null;
  if (!deviceCode) {
    return Response.json({ error: "deviceCode is required" }, { status: 400 });
  }

  const client = plainConvexClient();
  const deviceCodeHash = sha256(deviceCode);
  const { status } = await client.mutation(api.cliAuth.poll, { deviceCodeHash });
  if (status !== "approved") {
    return Response.json({ status });
  }

  const cliToken = newCliToken();
  try {
    await client.mutation(api.cliAuth.claim, {
      deviceCodeHash,
      tokenHash: sha256(cliToken),
    });
  } catch {
    // The request was concurrently claimed, expired, or revoked between the
    // poll and the claim. Report the current state rather than handing back
    // a token that was never persisted.
    const { status: latest } = await client.mutation(api.cliAuth.poll, { deviceCodeHash });
    return Response.json({ status: latest === "approved" ? "expired" : latest });
  }
  return Response.json({ status: "approved", cliToken });
});
