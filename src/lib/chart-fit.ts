import type { ReportSpec } from "../../modules/kernel/reportValidators";
import type { ReportChart } from "../../modules/kernel/reportLanguage";

/**
 * Which charts can draw a report, and the one that reads it best. A chart that can't draw it says why: a chart needs a
 * dimension to draw along, and a pie a count or a sum (parts of a whole). Dates read best as columns, other groups as
 * bars, and a report with no dimension as a number.
 */
export function chartFit(spec: Pick<ReportSpec, "groupBy" | "measures">): { suggested: ReportChart; why: Partial<Record<ReportChart, string>> } {
  const why: Partial<Record<ReportChart, string>> = {};
  if (!spec.groupBy.length) {
    for (const c of ["bar", "column", "line", "area", "pie"] as const) why[c] = "add a dimension";
    return { suggested: "number", why };
  }
  const fn = spec.measures[0]?.fn ?? "count";
  if (fn !== "count" && fn !== "sum") why.pie = "needs a count or a sum";
  return { suggested: spec.groupBy[0].bucket ? "column" : "bar", why };
}
