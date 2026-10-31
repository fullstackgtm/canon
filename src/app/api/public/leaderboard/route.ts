import { crmOpsLeaderboard } from "../../../../data/crmOpsLeaderboard.ts";
import { publicGtmApi } from "../../gtm/_lib.ts";
import { requireAgentScope } from "../_lib.ts";

export const dynamic = "force-dynamic";

/**
 * CRM-Ops Bench summary for registered agents (scope: read:evals). Served
 * from a committed artifact recomputed from the raw runs.jsonl — see
 * scripts/generate-agent-leaderboard.ts for provenance and regeneration.
 */
export const GET = publicGtmApi(async (request) => {
  const gate = await requireAgentScope(request, "read:evals");
  if ("response" in gate) return gate.response;

  return Response.json(crmOpsLeaderboard, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
});
