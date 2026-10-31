import { api } from "../../../../../convex/_generated/api";
import { forecastRows } from "../../../../lib/revenue";
import { gtmApi } from "../_lib";

export const dynamic = "force-dynamic";

function daysUntil(date: string) {
  const target = new Date(`${date}T00:00:00Z`).getTime();
  const today = new Date();
  const current = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.ceil((target - current) / 86_400_000);
}

export const GET = gtmApi(async ({ client }) => {
  const [deals, forecast] = await Promise.all([
    client.query(api.deals.list, {}),
    client.query(api.forecasting.getCurrentForecast, {}),
  ]);
  const openDeals = deals.filter((deal) => !deal.isClosed);
  const categories = forecastRows(openDeals, forecast.model.weights);
  const totalPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
  const weighted = categories.reduce((sum, row) => sum + row.weighted, 0);
  const target = forecast?.targetAmount ?? 0;
  const pastDue = openDeals.filter((deal) => daysUntil(deal.closeDate) < 0);
  const next30 = openDeals.filter((deal) => {
    const days = daysUntil(deal.closeDate);
    return days >= 0 && days <= 30;
  });

  return Response.json({
    summary: {
      totalPipeline,
      weighted,
      target,
      coverage: target > 0 ? totalPipeline / target : 0,
      pastDueAmount: pastDue.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
      pastDueCount: pastDue.length,
      next30Amount: next30.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
      next30Count: next30.length,
    },
    categories,
    deals: openDeals,
  });
});
