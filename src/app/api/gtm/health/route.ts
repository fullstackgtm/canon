import { api } from "../../../../../convex/_generated/api";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

type Health = "healthy" | "at_risk" | "churning";

function parseHealth(value: string | null): Health | null {
  if (value === "healthy" || value === "at_risk" || value === "churning") {
    return value;
  }
  return null;
}

export const GET = gtmApi(async ({ client, url }) => {
  const health = parseHealth(url.searchParams.get("health"));

  const [configs, stats, scores] = await Promise.all([
    client.query(api.customerHealth.listConfigs, {}),
    client.query(api.customerHealth.getStats, {}),
    health
      ? client.query(api.customerHealth.listByHealth, { health })
      : client.query(api.customerHealth.listScores, {}),
  ]);
  return Response.json({ configs, stats, scores });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromCrm");
  if (actionError) return actionError;

  const result = await client.mutation(api.customerHealth.generateFromCrm, {});
  return Response.json({ result });
});
