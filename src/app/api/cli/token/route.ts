import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";

export const POST = publicGtmApi(async (request) => {
  const cliToken = bearerToken(request);
  // Self-registered agent tokens share the fsgtm_ prefix family but are a
  // lower tier: public reads only. Teach the upgrade path instead of letting
  // them fall through to a confusing "invalid CLI token" 401.
  const rejection = agentTokenRejection(cliToken, request);
  if (rejection) return rejection;
  if (!cliToken?.startsWith("fsgtm_")) {
    return Response.json({ error: "Missing CLI token" }, { status: 401 });
  }
  const body = await readJsonBody(request);
  const provider =
    body.provider === "hubspot" || body.provider === "salesforce" ? body.provider : null;
  if (!provider) {
    return Response.json({ error: "Unsupported provider" }, { status: 400 });
  }

  try {
    const client = plainConvexClient();
    const connection = await client.action(api.cliAuthActions.mintProviderToken, {
      cliToken,
      provider,
    });
    return Response.json(connection);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});
