import { api } from "../../../../../convex/_generated/api.js";
import { publicGtmApi, readJsonBody } from "../../gtm/_lib.ts";
import { bearerToken, invalidCliTokenResponse, plainConvexClient } from "../_lib.ts";
import { agentTokenRejection } from "../../agents/_lib.ts";

/**
 * Health-history ingest for `backfill runs`: the CLI replays its local
 * health.jsonl timeline (per-audit hygiene scores; no CRM field values) so the
 * hosted Home trend covers the engagement's full history, not just runs after
 * pairing. Broker-token auth like /api/cli/run; deduped server-side on the
 * reading timestamp, so replays are idempotent.
 */
export const POST = publicGtmApi(async (request) => {
  const cliToken = bearerToken(request);
  const rejection = agentTokenRejection(cliToken, request);
  if (rejection) return rejection;
  if (!cliToken?.startsWith("fsgtm_")) {
    return Response.json({ error: "Missing CLI token" }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return Response.json({ error: "entries must be a non-empty array" }, { status: 400 });
  }
  if (body.entries.length > 500) {
    return Response.json({ error: "Send at most 500 entries per request" }, { status: 400 });
  }
  try {
    const client = plainConvexClient();
    const result = await client.action(api.cliRunsActions.recordHealthEntries, {
      cliToken,
      entries: body.entries,
    });
    return Response.json(result);
  } catch (error) {
    const unauthorized = invalidCliTokenResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
});
