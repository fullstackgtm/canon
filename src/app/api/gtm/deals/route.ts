import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { gtmApi, readJsonBody, requireAction } from "../_lib";

export const dynamic = "force-dynamic";

type ForecastCategory =
  | "omit"
  | "pipeline"
  | "best_case"
  | "commit"
  | "closed_won"
  | "closed_lost";

function isForecastCategory(value: unknown): value is ForecastCategory {
  return (
    value === "omit" ||
    value === "pipeline" ||
    value === "best_case" ||
    value === "commit" ||
    value === "closed_won" ||
    value === "closed_lost"
  );
}

export const GET = gtmApi(async ({ client }) => {
  const deals = await client.query(api.deals.list, {});
  return Response.json({ deals });
});

export const POST = gtmApi(async ({ client, request }) => {
  const body = await readJsonBody(request);
  const actionError = await requireAction(body, "updateForecast");
  if (actionError) return actionError;
  if (typeof body.dealId !== "string" || !isForecastCategory(body.forecastCategory)) {
    return Response.json(
      { error: "dealId and a valid forecastCategory are required" },
      { status: 400 },
    );
  }

  await client.mutation(api.deals.updateForecast, {
    dealId: body.dealId as Id<"deals">,
    forecastCategory: body.forecastCategory,
  });
  return Response.json({
    dealId: body.dealId,
    forecastCategory: body.forecastCategory,
  });
});
