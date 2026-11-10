import { api } from "../../../../../convex/_generated/api";
import { gtmApi } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
  const [hubspot, salesforce, callProviders, syncRuns] = await Promise.all([
    client.query(api.hubspot.getConnection, {}),
    client.query(api.salesforce.getConnection, {}),
    client.query(api.callProviders.listConnections, {}),
    client.query(api.integrations.listSyncRuns, { limit: safeLimit }),
  ]);

  return Response.json({ hubspot, salesforce, callProviders, syncRuns });
});
