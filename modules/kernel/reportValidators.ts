/**
 * The Convex validators of Canon's report language (reportLanguage.ts): a list filter as a view stores it, and a
 * saved report. Canon's tables store them (convex/lib/objects/validators.ts), and a manifest's shipped reports are
 * checked against `reportSpec`.
 */
import { v, type Infer } from "convex/values";
import { FILTER_OPS, MEASURE_FNS, REPORT_BUCKETS, REPORT_CHARTS } from "./reportLanguage.ts";

const filterScalar = v.union(v.string(), v.number(), v.boolean());

export const listFilter = v.object({
  field: v.string(),
  op: v.union(...FILTER_OPS.map((op) => v.literal(op))),
  value: v.optional(v.union(filterScalar, v.array(filterScalar))),
});

/** A saved report (CP9): an object's filters as a list view stores them, its group keys and measures (convex/lib/objects/reportSpec.ts), and how it is drawn. */
export const reportSpec = v.object({
  object: v.string(),
  filter: v.array(listFilter),
  groupBy: v.array(v.object({
    field: v.string(),
    /** A lookup of the object (or a contact's `accountId`): the key reads the related record's field. */
    via: v.optional(v.string()),
    bucket: v.optional(v.union(...REPORT_BUCKETS.map((b) => v.literal(b)))),
  })),
  /**
   * What each group adds up to: `fn` over `field`, or `pctTrue`, the share of rows where a yes/no `field` is true.
   * `label` names it ("Pipeline"); `where` filters the rows only this metric reads (open deals for Pipeline), as
   * convex/lib/objects/metricSplit.ts answers it.
   */
  measures: v.array(v.object({
    fn: v.union(...[...MEASURE_FNS, "pctTrue" as const].map((f) => v.literal(f))),
    field: v.optional(v.string()),
    label: v.optional(v.string()),
    where: v.optional(v.array(listFilter)),
    /** Shown beside its total over the period just before the report's date range (src/lib/period-compare.ts). */
    compare: v.optional(v.literal("prev")),
  })),
  chart: v.union(...REPORT_CHARTS.map((c) => v.literal(c))),
  /** Whose records it reads, for whoever opens it: the viewer's own, or their team's (src/lib/report-scope.ts). */
  whose: v.optional(v.union(v.literal("me"), v.literal("team"))),
  /**
   * How a chart draws its values: `stacked` columns or areas, and per value (in order) its `axes` (`right`: a second
   * axis, a percent beside money) and `types` (a column chart's value drawn as a line over the bars).
   */
  display: v.optional(v.object({
    stacked: v.optional(v.boolean()),
    axes: v.optional(v.array(v.union(v.literal("left"), v.literal("right")))),
    types: v.optional(v.array(v.union(v.literal("bar"), v.literal("line")))),
    /** Per value: shown as its share of the total, a percent ("% of Reps"). */
    shares: v.optional(v.array(v.boolean())),
    /**
     * Its look, as Looker Studio's Style tab: a `palette` of the theme's hues, data `labels` on the marks, the
     * `legend`'s place, `grid` lines, and for a table `rowNumbers` and a `heatmap` of its metrics.
     */
    palette: v.optional(v.union(v.literal("canon"), v.literal("greens"), v.literal("cool"), v.literal("warm"))),
    labels: v.optional(v.boolean()),
    legend: v.optional(v.union(v.literal("top"), v.literal("bottom"), v.literal("none"))),
    grid: v.optional(v.boolean()),
    rowNumbers: v.optional(v.boolean()),
    heatmap: v.optional(v.boolean()),
  })),
});
export type ReportSpec = Infer<typeof reportSpec>;

/** A list filter as Convex carries it: a value is a scalar or a list of them. */
export type ViewFilter = Infer<typeof listFilter>;
