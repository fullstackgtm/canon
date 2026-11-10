/** The Revenue page's open pipeline: the deals not closed, and their amount (cents). A pipeline-by-stage report must add up to it. */
export function openPipelineOf(deals: readonly { isClosed: boolean; amount?: number | null }[]): { count: number; amount: number } {
  const open = deals.filter((d) => !d.isClosed);
  return { count: open.length, amount: open.reduce((sum, d) => sum + (d.amount ?? 0), 0) };
}

/** The open forecast categories the Revenue page and the pipeline route show, in order; omitted deals count for nothing. */
const FORECAST_ROWS = [
  { key: "commit", label: "Commit" },
  { key: "best_case", label: "Best Case" },
  { key: "pipeline", label: "Pipeline" },
  { key: "omit", label: "Omitted" },
] as const;

/**
 * Open deals by forecast category, each category weighted by the workspace's forecast.model weights. These weigh by
 * category; the server's forecast (convex/forecasting.ts) weighs each deal by its probability.
 */
export function forecastRows(
  deals: readonly { isClosed: boolean; forecastCategory?: string | null; amount?: number | null }[],
  weights: { commit: number; best_case: number; pipeline: number },
) {
  const open = deals.filter((d) => !d.isClosed);
  return FORECAST_ROWS.map((row) => {
    const weight = row.key === "omit" ? 0 : weights[row.key];
    const inCategory = open.filter((d) => (d.forecastCategory ?? "pipeline") === row.key);
    const amount = inCategory.reduce((sum, d) => sum + (d.amount ?? 0), 0);
    return { ...row, weight, count: inCategory.length, amount, weighted: Math.round(amount * weight) };
  });
}
