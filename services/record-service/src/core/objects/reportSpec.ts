// GENERATED from convex/lib/objects/reportSpec.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * Reports (CP9): what an aggregate over one object's records may ask for, and
 * what it means. A report is a list request's filters, up to three group keys
 * (a field of the object, or of the record one of its lookups points at) and
 * up to five measures, answered as groups, subtotals and a grand total.
 *
 * The record service compiles a validated request to one GROUPING SETS query
 * over its projection (services/record-service/src/aggregate.ts); the fake
 * record client evaluates the same request in memory with
 * `aggregateRowsInMemory`. Both validate with `compileAggregateRequest`.
 *
 * Pure: no database access, no Node-only imports. The record service imports
 * a generated copy (scripts/sync-object-core.ts).
 */
import { cellOf, compileListRequest, listColumns, ListRequestError, matchesFilter, matchesScope, type CompiledFilter, type CompiledScope, type ListColumn, type ListFilter, type ListRow, type OwnerScope, type ProjectedThrough, type Scalar } from "./listSpec.ts";
import { resolveObjectDef, type FieldDef, type ResolvedObjectDef } from "./registry.ts";

export const GROUP_BY_MAX = 3;
export const MEASURES_MAX = 5;
/** Groups (and subtotals) a response carries, in key order; past it the response is `truncated`. Totals always count every row. */
export const GROUPS_MAX = 500;

export const REPORT_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];
export const MEASURE_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type MeasureFn = (typeof MEASURE_FNS)[number];

/** A group key: `field` of the object, or with `via`, of the record its lookup `via` points at. A date groups by `bucket` (month by default). */
export type ReportGroup = { field: string; via?: string; bucket?: ReportBucket };
/** `weight` (1.35.0): a field each value is multiplied by, as a weighted pipeline sums amount × probability (a fraction). */
export type ReportMeasure = { fn: MeasureFn; field?: string; weight?: string };
/** `scope` (CP14, 1.29.0) narrows the counted records to what the caller sees, as a list's scope does. */
export type AggregateRequest = { filter?: readonly ListFilter[]; groupBy?: readonly ReportGroup[]; measures: readonly ReportMeasure[]; scope?: OwnerScope };

/** One group: its key values (a date bucket is the `YYYY-MM-DD` it starts on) and one value per measure. */
export type AggregateGroup = { keys: (Scalar | null)[]; values: (number | null)[] };
/**
 * `groups` holds every key combination, `subtotals` (two or three group keys)
 * one per combination of every key but the last (a matrix's rows), `total` the
 * measures over every matching row. Groups are in key order, empty keys last.
 */
export type AggregateResponse = { groups: AggregateGroup[]; subtotals: AggregateGroup[]; total: (number | null)[]; rows: number; truncated: boolean; projectedThrough: ProjectedThrough };

/** A contact's primary company: the register's `accountId`, not a registry field. */
export const CONTACT_COMPANY_VIA = "accountId";

/**
 * Activities, a report-only object: every note, task, call and meeting as one
 * set, with its `type` (which of the four) and its owner, so a report can count
 * activities by owner and type. Nothing is stored under it.
 */
export const ACTIVITY_OBJECT = "activity";
export const ACTIVITY_TYPES = ["note", "task", "call", "meeting"] as const;
export const activityReportDef = (): ResolvedObjectDef => resolveObjectDef({
  apiName: ACTIVITY_OBJECT, label: "Activity", pluralLabel: "Activities", residency: "onDemand", storage: "ledger", titleField: "type",
  fields: [
    { apiName: "type", label: "Type", type: "picklist", options: [["note", "Note"], ["task", "Task"], ["call", "Call"], ["meeting", "Meeting"]].map(([value, label]) => ({ value, label, active: true })) },
    { apiName: "ownerId", label: "Owner", type: "user" },
    { apiName: "createdAt", label: "Created", type: "datetime", system: true },
    { apiName: "updatedAt", label: "Last modified", type: "datetime", system: true },
  ],
} as never);

/** A relation a report can follow: a lookup of the object (or a contact's company) and the object it points at. */
export type ReportRelation = { via: string; object: string; label: string };

export function relationsOf(object: string, def: ResolvedObjectDef): ReportRelation[] {
  const out: ReportRelation[] = [];
  if (object === "contact") out.push({ via: CONTACT_COMPANY_VIA, object: "account", label: "Company" });
  for (const f of def.fields) {
    if (f.type === "lookup" && f.archivedAt === undefined && !f.system) out.push({ via: f.apiName, object: f.lookupTo, label: f.label });
  }
  return out;
}

/** How a group key reads its column: as the value, or bucketed from a calendar day or an instant (ms since epoch, UTC). */
export type KeyKind = "value" | "day" | "instant";

/** Whether a number column holds instants: the system timestamps, datetime fields, and formulas that give one. */
const isInstant = (col: ListColumn, field: FieldDef | undefined) =>
  col.column === "created_at" || col.column === "updated_at" || field?.type === "datetime" || (field?.type === "formula" && field.returns === "datetime");

function keyKindOf(col: ListColumn, field: FieldDef | undefined): KeyKind | null {
  if (col.kind === "text") return col.column === "id" ? null : "value";
  if (col.kind === "checkbox") return "value";
  if (col.kind === "date") return "day";
  if (col.kind === "number" && isInstant(col, field)) return "instant";
  if (col.kind === "number" && col.fieldId === "fit") return "value";
  return null;
}

/** Whether a field can be a group key or a measure, for builders that offer only what a report accepts. */
export function groupableField(def: ResolvedObjectDef, name: string): boolean {
  const col = listColumns(def).get(name);
  return Boolean(col && keyKindOf(col, def.byApiName.get(name)));
}
export function measurableField(def: ResolvedObjectDef, name: string): boolean {
  const col = listColumns(def).get(name);
  return Boolean(col && col.kind === "number" && !isInstant(col, def.byApiName.get(name)));
}

export type CompiledGroup = {
  /** The object whose column the key reads: the report's own, or the relation's. */
  object: string;
  col: ListColumn;
  kind: KeyKind;
  bucket: ReportBucket | null;
  /** The relation followed, and the column of the report's object that holds the related record's id. */
  via: { name: string; col: ListColumn | typeof CONTACT_COMPANY_VIA } | null;
};
export type CompiledMeasure = { fn: MeasureFn; col: ListColumn | null; weight: ListColumn | null };
export type CompiledAggregate = { object: string; filters: CompiledFilter[]; scope: CompiledScope | null; groups: CompiledGroup[]; measures: CompiledMeasure[] };

/**
 * Validate an aggregate request against the object's list definition. `defOf`
 * gives the list definition of a related object (the register's for accounts
 * and contacts). Throws ListRequestError on anything it cannot serve.
 */
export function compileAggregateRequest(
  object: string, def: ResolvedObjectDef, req: AggregateRequest, defOf: (object: string) => ResolvedObjectDef | undefined,
): CompiledAggregate {
  const { filters, scope } = compileListRequest(def, { filter: req.filter ?? [], limit: 1, ...(req.scope ? { scope: req.scope } : {}) });
  const columns = listColumns(def);
  const groupBy = req.groupBy ?? [];
  if (groupBy.length > GROUP_BY_MAX) throw new ListRequestError(`at most ${GROUP_BY_MAX} group keys`);
  const relations = new Map(relationsOf(object, def).map((r) => [r.via, r]));
  const groups = groupBy.map((g): CompiledGroup => {
    let target = def;
    let targetObject = object;
    let via: CompiledGroup["via"] = null;
    if (g.via !== undefined) {
      const rel = relations.get(g.via);
      if (!rel) throw new ListRequestError(`${g.via} is not a relation of ${object}`);
      const related = defOf(rel.object);
      if (!related) throw new ListRequestError(`unknown object ${rel.object}`);
      target = related;
      targetObject = rel.object;
      via = { name: g.via, col: g.via === CONTACT_COMPANY_VIA && object === "contact" ? CONTACT_COMPANY_VIA : columns.get(g.via)! };
    }
    const col = listColumns(target).get(g.field);
    if (!col) throw new ListRequestError(`unknown field ${g.field}`);
    const kind = keyKindOf(col, target.byApiName.get(g.field));
    if (!kind) throw new ListRequestError(`${g.field} cannot be grouped by`);
    if (g.bucket !== undefined && !(REPORT_BUCKETS as readonly string[]).includes(g.bucket)) throw new ListRequestError(`bucket must be one of ${REPORT_BUCKETS.join(", ")}`);
    if (g.bucket !== undefined && kind === "value") throw new ListRequestError(`${g.field} is not a date`);
    return { object: targetObject, col, kind, bucket: kind === "value" ? null : g.bucket ?? "month", via };
  });
  if (req.measures.length < 1 || req.measures.length > MEASURES_MAX) throw new ListRequestError(`1 to ${MEASURES_MAX} measures`);
  const measures = req.measures.map((m): CompiledMeasure => {
    if (!(MEASURE_FNS as readonly string[]).includes(m.fn)) throw new ListRequestError(`measure must be one of ${MEASURE_FNS.join(", ")}`);
    if (m.fn === "count") {
      if (m.field !== undefined || m.weight !== undefined) throw new ListRequestError("count takes no field");
      return { fn: "count", col: null, weight: null };
    }
    const col = m.field === undefined ? undefined : columns.get(m.field);
    if (!col || !measurableField(def, m.field!)) throw new ListRequestError(`${m.fn} needs a number or currency field`);
    const weight = m.weight === undefined ? null : columns.get(m.weight);
    if (weight === undefined || (weight && !measurableField(def, m.weight!))) throw new ListRequestError(`${m.fn} is weighted by a number field`);
    return { fn: m.fn, col, weight };
  });
  return { object, filters, scope, groups, measures };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The first day of the bucket `day` (YYYY-MM-DD) falls in: ISO weeks start on Monday, as DuckDB's date_trunc. */
export function bucketStart(day: string, bucket: ReportBucket): string {
  const [y, m, d] = day.split("-").map(Number);
  if (bucket === "day") return `${y}-${pad(m)}-${pad(d)}`;
  if (bucket === "month") return `${y}-${pad(m)}-01`;
  if (bucket === "quarter") return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
  if (bucket === "year") return `${y}-01-01`;
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return ymd(date);
}

function keyOf(cell: unknown, g: CompiledGroup): Scalar | null {
  if (cell === null || cell === undefined || Array.isArray(cell)) return null;
  if (g.kind === "value") return cell === "" ? null : (cell as Scalar);
  const day = g.kind === "day" ? String(cell) : ymd(new Date(Number(cell)));
  return bucketStart(day, g.bucket!);
}

function compareKeys(a: readonly (Scalar | null)[], b: readonly (Scalar | null)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

type Acc = { keys: (Scalar | null)[]; n: number; m: { sum: number; count: number; min: number | null; max: number | null }[] };

const newAcc = (keys: (Scalar | null)[], measures: number): Acc =>
  ({ keys, n: 0, m: Array.from({ length: measures }, () => ({ sum: 0, count: 0, min: null, max: null })) });

function valuesOf(acc: Acc, measures: readonly CompiledMeasure[]): (number | null)[] {
  return measures.map((m, i) => {
    const s = acc.m[i];
    switch (m.fn) {
      case "count": return acc.n;
      case "sum": return s.count ? s.sum : null;
      case "avg": return s.count ? s.sum / s.count : null;
      case "min": return s.min;
      case "max": return s.max;
    }
  });
}

/**
 * A report over list rows, as the record service's SQL computes it. `rows` are
 * the object's rows (any status: only active ones count); `related` gives a
 * related object's rows by id.
 */
export function aggregateRowsInMemory(
  q: CompiledAggregate, rows: readonly (ListRow & { accountId?: string })[], related: (object: string) => ReadonlyMap<string, ListRow>, projectedThrough: ProjectedThrough,
): AggregateResponse {
  const matched = rows.filter((r) => r.object === q.object && r.status === "active" && matchesScope(r, q.scope) && q.filters.every((f) => matchesFilter(r, f)));
  const leaves = new Map<string, Acc>();
  const subtotals = new Map<string, Acc>();
  const total = newAcc([], q.measures.length);
  const add = (acc: Acc, row: ListRow) => {
    acc.n++;
    q.measures.forEach((m, i) => {
      if (!m.col) return;
      const raw = cellOf(row, m.col);
      const w = m.weight ? cellOf(row, m.weight) : 1;
      if (typeof raw !== "number" || typeof w !== "number") return;
      const v = raw * w;
      const s = acc.m[i];
      s.sum += v;
      s.count++;
      s.min = s.min === null ? v : Math.min(s.min, v);
      s.max = s.max === null ? v : Math.max(s.max, v);
    });
  };
  for (const row of matched) {
    const keys = q.groups.map((g) => {
      if (!g.via) return keyOf(cellOf(row, g.col), g);
      const id = g.via.col === CONTACT_COMPANY_VIA ? row.accountId || null : cellOf(row, g.via.col);
      const target = typeof id === "string" ? related(g.object).get(id) : undefined;
      return target && target.status === "active" ? keyOf(cellOf(target, g.col), g) : null;
    });
    add(total, row);
    if (!keys.length) continue;
    const at = (map: Map<string, Acc>, k: (Scalar | null)[]) => {
      const id = JSON.stringify(k);
      let acc = map.get(id);
      if (!acc) map.set(id, (acc = newAcc(k, q.measures.length)));
      return acc;
    };
    add(at(leaves, keys), row);
    if (keys.length > 1) add(at(subtotals, keys.slice(0, -1)), row);
  }
  const ordered = (map: Map<string, Acc>) => [...map.values()].sort((a, b) => compareKeys(a.keys, b.keys));
  const leafList = ordered(leaves);
  const subList = ordered(subtotals);
  return {
    groups: leafList.slice(0, GROUPS_MAX).map((a) => ({ keys: a.keys, values: valuesOf(a, q.measures) })),
    subtotals: subList.slice(0, GROUPS_MAX).map((a) => ({ keys: a.keys, values: valuesOf(a, q.measures) })),
    total: valuesOf(total, q.measures),
    rows: matched.length,
    truncated: leafList.length > GROUPS_MAX || subList.length > GROUPS_MAX,
    projectedThrough,
  };
}
