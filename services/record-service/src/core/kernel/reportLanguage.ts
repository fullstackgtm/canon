// GENERATED from modules/kernel/reportLanguage.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * Canon's report language (docs/modules.md, "Reports and charts"): the filter operators, measure functions, date
 * buckets and charts a list or report is made of, the field types a module report reads, and the names of the
 * objects a report reads beyond the registry's own. Canon's object layer (convex/lib/objects) builds its list and
 * report semantics on these, and a module's manifest is checked against them.
 *
 * Dependency-free: the record service imports a generated copy (scripts/sync-object-core.ts).
 */

export type FilterOp =
  | "eq" | "neq" | "in"
  | "contains" | "startsWith"
  | "gt" | "gte" | "lt" | "lte"
  | "hasAny" | "hasAll"
  | "empty" | "notEmpty";

export const FILTER_OPS: readonly FilterOp[] = ["eq", "neq", "in", "contains", "startsWith", "gt", "gte", "lt", "lte", "hasAny", "hasAll", "empty", "notEmpty"];

export const REPORT_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];
export const MEASURE_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type MeasureFn = (typeof MEASURE_FNS)[number];

/** `bar` draws horizontal bars, `column` vertical ones (side by side, or stacked), `area` a filled line. */
export const REPORT_CHARTS = ["table", "bar", "column", "line", "area", "pie", "number"] as const;
export type ReportChart = (typeof REPORT_CHARTS)[number];

/** A report field's type, as Canon's reports read it. A `picklist` carries the labels of its values. */
export type ModuleFieldType = "text" | "picklist" | "user" | "number" | "currency" | "date" | "datetime" | "checkbox";
export type ModuleReportField = { name: string; label: string; type: ModuleFieldType; options?: readonly { value: string; label: string }[] };

/**
 * Activities, a report-only object: every note, task, call and meeting as one
 * set, with its `type` (which of the four) and its owner, so a report can count
 * activities by owner and type. Nothing is stored under it.
 */
export const ACTIVITY_OBJECT = "activity";

/** `custom_<slug>`: the apiName of an org-defined object, stable like a field's. It is a safe SQL identifier (the projection table is `p_custom_<slug>`). */
export const CUSTOM_OBJECT_API_NAME = /^custom_[a-z][a-z0-9_]{0,39}$/;
export const isCustomObjectName = (name: string): boolean => CUSTOM_OBJECT_API_NAME.test(name);
