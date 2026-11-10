/**
 * Metrics with their own filter (`where`: Pipeline is the amount of open deals, Won revenue the amount of won ones)
 * and rates (`pctTrue`: Win rate is the share of closed deals that are won). An aggregate answers measures over one
 * set of rows, so a report with either is split into one aggregate per distinct `where`, each the report's own filters
 * plus that `where`, and their answers are put back together group by group. A rate is two counts: the rows where its
 * field is true, over the rows its `where` admits.
 *
 * Pure: no database access, no Node-only imports.
 */
import { ListRequestError } from "./listSpec.ts";
import type { AggregateResponse, MeasureFn, ReportMeasure } from "./reportSpec.ts";
import type { ReportSpec } from "./validators.ts";

type Measure = ReportSpec["measures"][number];
type Filter = ReportSpec["filter"][number];
/** Where a measure's answer is read: a measure of one part, or a rate's two counts. */
type Ref = { part: number; at: number; over?: { part: number; at: number } };

export const METRIC_WHERE_MAX = 3;

/** Whether a report has a metric an aggregate can't answer by itself. */
export const needsSplit = (spec: Pick<ReportSpec, "measures">) => spec.measures.some((m) => m.fn === "pctTrue" || (m.where?.length ?? 0) > 0);

/**
 * A report as the plain aggregates that answer it, and how to read each metric's answer back from theirs. Throws a
 * plain Error on a metric it can't serve (the caller reports it).
 */
export function splitReport(spec: ReportSpec): { parts: ReportSpec[]; refs: Ref[] } {
  const parts: Array<{ where: Filter[]; measures: Array<{ fn: MeasureFn; field?: string }> }> = [];
  const partOf = (where: readonly Filter[]) => {
    const key = JSON.stringify(where);
    let i = parts.findIndex((p) => JSON.stringify(p.where) === key);
    if (i < 0) i = parts.push({ where: [...where], measures: [] }) - 1;
    return i;
  };
  const measureIn = (part: number, m: { fn: MeasureFn; field?: string }) => {
    const ms = parts[part].measures;
    const key = JSON.stringify(m);
    const at = ms.findIndex((x) => JSON.stringify(x) === key);
    return at >= 0 ? at : ms.push(m) - 1;
  };
  const refs = spec.measures.map((m: Measure): Ref => {
    const where = m.where ?? [];
    if (where.length > METRIC_WHERE_MAX) throw new Error(`a metric filters on at most ${METRIC_WHERE_MAX} fields`);
    if (m.fn === "pctTrue") {
      if (!m.field) throw new Error("a rate needs a yes/no field");
      const over = partOf(where);
      const of = partOf([...where, { field: m.field, op: "eq", value: true }]);
      return { part: of, at: measureIn(of, { fn: "count" }), over: { part: over, at: measureIn(over, { fn: "count" }) } };
    }
    const part = partOf(where);
    return { part, at: measureIn(part, m.fn === "count" ? { fn: "count" } : { fn: m.fn, ...(m.field ? { field: m.field } : {}) }) };
  });
  return {
    parts: parts.map((p) => ({ object: spec.object, filter: [...spec.filter, ...p.where], groupBy: spec.groupBy, measures: p.measures, chart: "table" as const })),
    refs,
  };
}

/** The parts' answers as one: every group any part has, in the first answer's order, each metric read from its part. */
export function joinParts(spec: Pick<ReportSpec, "measures">, refs: readonly Ref[], runs: readonly AggregateResponse[]): AggregateResponse {
  const valueOf = (byKey: Map<string, (number | null)[]>[], key: string, ref: Ref, fn: Measure["fn"]): number | null => {
    const read = (r: { part: number; at: number }) => byKey[r.part].get(key)?.[r.at] ?? null;
    if (ref.over) {
      const of = read(ref) ?? 0;
      const over = read(ref.over);
      return over ? of / over : null;
    }
    const v = read(ref);
    return v === null && fn === "count" ? 0 : v;
  };
  const merge = (pick: (r: AggregateResponse) => AggregateResponse["groups"]) => {
    const byKey = runs.map((r) => new Map(pick(r).map((g) => [JSON.stringify(g.keys), g.values])));
    const order: AggregateResponse["groups"][number]["keys"][] = [];
    const seen = new Set<string>();
    for (const r of runs) for (const g of pick(r)) { const k = JSON.stringify(g.keys); if (!seen.has(k)) { seen.add(k); order.push(g.keys); } }
    return order.map((keys) => { const k = JSON.stringify(keys); return { keys, values: refs.map((ref, i) => valueOf(byKey, k, ref, spec.measures[i].fn)) }; });
  };
  const totals = runs.map((r) => new Map([["", r.total]]));
  return {
    groups: merge((r) => r.groups),
    subtotals: merge((r) => r.subtotals),
    total: refs.map((ref, i) => valueOf(totals, "", ref, spec.measures[i].fn)),
    rows: Math.max(0, ...runs.map((r) => r.rows)),
    truncated: runs.some((r) => r.truncated),
    projectedThrough: runs[0]?.projectedThrough ?? {},
  };
}

/**
 * A report's metrics as an aggregate takes them. A metric with its own filter or a rate runs only split
 * (runMetrics in convex/modules.ts): anywhere else it is refused with the reason.
 */
export function plainMeasures(measures: ReportSpec["measures"]): ReportMeasure[] {
  return measures.map((m) => {
    if (m.fn === "pctTrue" || (m.where?.length ?? 0) > 0) throw new ListRequestError("a metric with its own filter, or a rate, runs only in a module report");
    return { fn: m.fn, ...(m.field !== undefined ? { field: m.field } : {}) };
  });
}

/** A spec with its metrics as an aggregate takes them (see plainMeasures). */
export const plainSpec = <S extends Pick<ReportSpec, "measures">>(spec: S): Omit<S, "measures"> & { measures: ReportMeasure[] } => ({ ...spec, measures: plainMeasures(spec.measures) });
