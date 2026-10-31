import { api } from "../../../../../convex/_generated/api";
import { gtmApi } from "../_lib";

export const dynamic = "force-dynamic";

export const GET = gtmApi(async ({ client, url }) => {
  const period = {
    periodStart: url.searchParams.get("periodStart") ?? undefined,
    periodEnd: url.searchParams.get("periodEnd") ?? undefined,
  };
  const [forecast, byRep] = await Promise.all([
    client.query(api.forecasting.getCurrentForecast, period),
    client.query(api.forecasting.getForecastByRep, period),
  ]);
  return Response.json({ periodStart: forecast.periodStart, periodEnd: forecast.periodEnd, forecast, byRep });
});
