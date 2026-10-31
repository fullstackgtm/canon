import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const competitorId = url.searchParams.get("competitorId");
  const typedCompetitorId = competitorId as Id<"competitors"> | null;

  const [stats, competitors, battlecards, winLoss] = await Promise.all([
    client.query(api.competitive.getWinLossStats, {}),
    client.query(api.competitive.listCompetitors, {}),
    client.query(api.competitive.listBattlecards, {
      competitorId: typedCompetitorId ?? undefined,
    }),
    client.query(api.competitive.listWinLoss, {}),
  ]);
  return Response.json({ stats, competitors, battlecards, winLoss });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "generateFromDeals");
  if (actionError) return actionError;

  const result = await client.mutation(api.competitive.generateFromDeals, {});
  return Response.json({ result });
});
