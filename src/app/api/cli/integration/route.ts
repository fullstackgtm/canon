import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";

/**
 * A paired CLI registers its local CRM connection here (broker-token auth, same
 * as /api/cli/run). The org/user are resolved server-side from the token; the
 * hosted app then shows the integration and can sync on its own. Only the
 * genuine auth failure maps to 401 — see invalidCliTokenResponse.
 */
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
  if (body.provider !== "hubspot" || typeof body.token !== "string" || !body.token) {
    return Response.json({ error: "provider and token are required" }, { status: 400 });
  }
  try {
    const client = plainConvexClient();
    const result = await client.action(api.cliIntegrationActions.connectFromCli, {
      cliToken,
      provider: "hubspot",
      token: body.token,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});
