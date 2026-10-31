import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const modelId = url.searchParams.get("modelId");
  const typedModelId = modelId as Id<"leadScoringModels"> | null;

  const [models, scores, routingRules] = await Promise.all([
    client.query(api.leadScoring.listModels, {}),
    client.query(api.leadScoring.listScores, {
      modelId: typedModelId ?? undefined,
    }),
    client.query(api.leadScoring.listRoutingRules, {}),
  ]);
  return Response.json({ models, scores, routingRules });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromCrm");
  if (actionError) return actionError;

  const result = await client.action(api.leadScoring.generateFromCrm, {});
  return Response.json({ result });
});
