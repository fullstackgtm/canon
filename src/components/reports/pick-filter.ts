/**
 * What a clicked chart mark stands for, as a list request: the report's own filters and the value of each group key
 * the mark carries (a stage, an owner, a close month), so the records panel lists exactly the records behind the
 * number. Pure, so the builder, the dashboard tiles and the tests share it.
 */
import type { ReportBucket } from "../../../convex/lib/objects/reportSpec";
import type { ReportSpec } from "../../../convex/lib/objects/validators";

/** A list filter as a report or a list request carries it. */
export type ListFilter = ReportSpec["filter"][number];

/** How a group key's field filters: a date compares YYYY-MM-DD days, a datetime epoch milliseconds, anything else its value. */
export type KeyKind = "day" | "instant" | "value";

/** The kind of a key field, from its type (and a formula's result type); the register's created and modified times are datetimes. */
export function keyKindOf(field: string, type: string | undefined, returns?: string): KeyKind {
  if (field === "createdAt" || field === "updatedAt") return "instant";
  const t = type === "formula" ? returns : type;
  return t === "date" ? "day" : t === "datetime" ? "instant" : "value";
}

/** The first day after the bucket that starts on `day` (YYYY-MM-DD, UTC, as the record service buckets). */
export function bucketEnd(day: string, bucket: ReportBucket): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (bucket === "day") t.setUTCDate(t.getUTCDate() + 1);
  else if (bucket === "week") t.setUTCDate(t.getUTCDate() + 7);
  else if (bucket === "month") t.setUTCMonth(t.getUTCMonth() + 1);
  else if (bucket === "quarter") t.setUTCMonth(t.getUTCMonth() + 3);
  else t.setUTCFullYear(t.getUTCFullYear() + 1);
  return t.toISOString().slice(0, 10);
}

const utcMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The filters that keep one key's value: empty for "No …", the bucket's range for a date, else equality. */
export function keyFilters(field: string, kind: KeyKind, bucket: ReportBucket | undefined, value: unknown): ListFilter[] {
  if (value === null || value === undefined) return [{ field, op: "empty" }];
  if (kind !== "value" && typeof value === "string") {
    const end = bucketEnd(value, bucket ?? "month");
    return kind === "day"
      ? [{ field, op: "gte", value }, { field, op: "lt", value: end }]
      : [{ field, op: "gte", value: utcMs(value) }, { field, op: "lt", value: utcMs(end) }];
  }
  return [{ field, op: "eq", value: value as ListFilter["value"] }];
}

/**
 * The list filters for a mark: the report's filters, then each picked key's. Null when a picked key reads a related
 * record (`via`), since a list filters its object's own fields only; the chart then offers no click.
 */
export function pickFilters(spec: Pick<ReportSpec, "filter" | "groupBy">, kinds: readonly KeyKind[], keys: readonly unknown[]): ListFilter[] | null {
  if (spec.groupBy.slice(0, keys.length).some((g) => g.via)) return null;
  return [...spec.filter, ...keys.flatMap((k, i) => keyFilters(spec.groupBy[i].field, kinds[i] ?? "value", spec.groupBy[i].bucket, k))];
}
