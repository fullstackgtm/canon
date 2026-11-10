import type { ReportSpec } from "../../modules/kernel/reportValidators";
import type { ReportChart } from "../../modules/kernel/reportLanguage";
import { chartFit } from "./chart-fit.ts";

/** A chart as the picker offers it: Canon's chart kind and how it draws (stacked, a line over columns). */
export type ChartVariant = { id: string; group: string; label: string; chart: ReportChart; stacked?: boolean; combo?: boolean };

/** The charts a report can be drawn as, in the picker's sections (as Looker Studio lays its own out). */
export const CHART_VARIANTS: readonly ChartVariant[] = [
  { id: "table", group: "Table", label: "Table", chart: "table" },
  { id: "number", group: "Scorecard", label: "Scorecard", chart: "number" },
  { id: "column", group: "Bar", label: "Columns", chart: "column" },
  { id: "column-stacked", group: "Bar", label: "Stacked columns", chart: "column", stacked: true },
  { id: "bar", group: "Bar", label: "Bars", chart: "bar" },
  { id: "line", group: "Line", label: "Line", chart: "line" },
  { id: "combo", group: "Line", label: "Columns and line", chart: "column", combo: true },
  { id: "area", group: "Area", label: "Area", chart: "area" },
  { id: "area-stacked", group: "Area", label: "Stacked area", chart: "area", stacked: true },
  { id: "pie", group: "Pie", label: "Pie", chart: "pie" },
];

type Shape = Pick<ReportSpec, "chart" | "groupBy" | "measures" | "display">;

/** The variant a report is drawn as now. */
export function variantOf(spec: Shape): ChartVariant {
  const d = spec.display ?? {};
  const combo = spec.chart === "column" && (d.types ?? []).includes("line");
  const stacked = (spec.chart === "column" || spec.chart === "area") && d.stacked === true;
  return CHART_VARIANTS.find((v) => v.chart === spec.chart && !!v.combo === combo && !!v.stacked === (stacked && !combo)) ?? CHART_VARIANTS[0];
}

/** Why a variant can't draw the report, or undefined when it can. */
export function variantWhy(spec: Shape, v: ChartVariant): string | undefined {
  const why = chartFit(spec).why[v.chart];
  if (why) return why;
  if (v.combo && (spec.measures.length < 2 || spec.groupBy.length > 1)) return "needs two metrics and one dimension";
  return undefined;
}

/** The spec drawn as `v`: its chart, stacking, and (for columns and line) its second metric as the line. */
export function withVariant(spec: Shape, v: ChartVariant): Pick<ReportSpec, "chart" | "display"> {
  const d = { ...(spec.display ?? {}) };
  if (v.chart === "column" || v.chart === "area") d.stacked = v.stacked === true;
  if (v.chart === "column") d.types = v.combo ? spec.measures.map((_, i) => (i === 0 ? "bar" : "line")) : undefined;
  if (d.types === undefined) delete d.types;
  return { chart: v.chart, display: d };
}
