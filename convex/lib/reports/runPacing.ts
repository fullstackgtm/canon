import { ConvexError } from "convex/values";
import { asListError } from "../../objects";
import { atLeastVersion, type RecordClient } from "../recordClient";
import type { ViewFilter } from "../objects/validators";
import type { ListFilter } from "../objects/listSpec";
import type { ReportBucket } from "../objects/reportSpec";
import { cohorts, dayOf, periodOf, shiftPeriod, PACING_COMPARE_MAX, type Grain, type Period } from "./pacing";
import type { Roster } from "../../targets";

const DAY_BUCKET = "1.32.0";
const NO_MATCHING_OWNER = "__none__";
export type PacingSource = { object: string; date: string; dateType: "date" | "datetime"; amount: string; filter: ListFilter[] };
export type PacingPlan = { year: number; fyStart?: number; total: number; coverage: number; repMonths: Record<string, number[]>; teamMonths: Record<string, number[]> };
export type PacingArgs = { grain: Grain; compare: number | "yoy"; split?: string; filter: ViewFilter[]; teamIds?: string[] };

export type PacingSeries = { period: string; key: string | null; daily: number[] };
export type PacingResult = {
  today: string;
  /** The month (1-12) the fiscal year starts in, which quarters and years follow. */
  fyStart: number;
  periods: Period[];
  /** The periods the chart compares, newest first; the rest feed the historical pace. */
  shown: string[];
  series: PacingSeries[];
  /** True when a period was read by week instead of by day. */
  approximate: boolean;
  teamNames: Record<string, string>;
  /**
   * The plan sets targets by team and rep only. With filters on other fields, `share` is the part of the last twelve
   * months they kept, and `splitShare` each split value's part, so a target can be estimated for them.
   */
  share: number | null;
  splitShare: Record<string, number> | null;
};

export async function runPacing(client: RecordClient, orgId: string, source: PacingSource, args: PacingArgs, fyStart: number, roster: Roster, today = new Date().toISOString().slice(0, 10)): Promise<PacingResult> {
  if (typeof args.compare === "number" && (!Number.isInteger(args.compare) || args.compare < 0 || args.compare > PACING_COMPARE_MAX)) throw new ConvexError(`Compare with 0 to ${PACING_COMPARE_MAX} periods`);
  if (args.filter.some((f) => f.field === source.date || source.filter.some((own) => own.field === f.field))) throw new ConvexError("Pacing sets its dates and source filters itself");
  const grain: Grain = args.grain;
  const now = periodOf(today, grain, fyStart);
  const back = (n: number) => shiftPeriod(now, grain, -n, fyStart);
  const shown = args.compare === "yoy" ? [now, back(grain === "month" ? 12 : grain === "quarter" ? 4 : 1)] : cohorts(today, grain, args.compare + 1, fyStart);
  const periods = [...new Map([...shown, ...[1, 2, 3, 4].map(back)].map((p) => [p.key, p])).values()];

  const filter: ListFilter[] = [...source.filter, ...args.filter];
  if (args.teamIds?.length) {
    const owners = roster.reps.filter((r) => args.teamIds!.includes(r.team)).map((r) => r.id);
    filter.push(owners.length ? { field: "ownerId", op: "in", value: owners } : { field: "ownerId", op: "eq", value: NO_MATCHING_OWNER });
  }

  const byDay = atLeastVersion(await client.contractVersion(), DAY_BUCKET);
  let approximate = !byDay;
  const splitField = args.split === "team" ? "ownerId" : args.split;

  const read = async (p: Period, field?: string) => {
    const res = await periodAmounts(client, orgId, source, p, filter, field, byDay ? "day" : "week");
    if (!res.truncated || !byDay) return res;
    approximate = true;
    return await periodAmounts(client, orgId, source, p, filter, field, "week");
  };
  const targetFilters = filter.filter((f) => f.field === "ownerId" || source.filter.some((own) => own.field === f.field));
  const extraFilters = filter.length > targetFilters.length;
  const planned = !splitField || splitField === "ownerId";
  const rollingYear: Period = { key: "last-12", label: "Last 12 months", start: new Date(Date.parse(`${today}T00:00:00Z`) - 364 * 86_400_000).toISOString().slice(0, 10), days: 365 };
  const totalOf = async (f: ListFilter[], field?: string) => {
    const res = await asListError(() => client.aggregate(orgId, source.object, { filter: [...f, ...datesOf(source, rollingYear)], groupBy: field ? [{ field }] : [], measures: [{ fn: "sum", field: source.amount }] }));
    return { total: res.total[0] ?? 0, by: new Map(res.groups.map((g) => [g.keys[0] === null ? "" : String(g.keys[0]), g.values[0] ?? 0])) };
  };
  const [whole, split, base, kept, bySplit] = await Promise.all([
    Promise.all(periods.map(async (p) => ({ p, rows: (await read(p)).rows }))),
    splitField ? read(now, splitField) : Promise.resolve(null),
    extraFilters || !planned ? totalOf(targetFilters) : Promise.resolve(null),
    extraFilters ? totalOf(filter) : Promise.resolve(null),
    !planned ? totalOf(filter, splitField) : Promise.resolve(null),
  ]);
  const series: PacingSeries[] = whole.map(({ p, rows }) => ({ period: p.key, key: null, daily: rows.get(null) ?? new Array(p.days).fill(0) }));
  if (split) {
    const team = new Map(roster?.reps.map((r) => [r.id, r.team]) ?? []);
    const teamOf = (owner: string | null) => owner === null ? null : team.get(owner) ?? null;
    const folded = new Map<string | null, number[]>();
    for (const [k, daily] of split.rows) {
      const key = args.split === "team" ? teamOf(k) : k;
      const into = folded.get(key) ?? new Array(now.days).fill(0);
      daily.forEach((v, i) => (into[i] += v));
      folded.set(key, into);
    }
    for (const [key, daily] of folded) series.push({ period: now.key, key: key ?? "", daily });
  }
  return {
    today, fyStart, periods, shown: shown.map((p) => p.key), series, approximate,
    teamNames: Object.fromEntries((roster?.teams ?? []).map((t) => [t.id, t.name])),
    share: base && kept ? (base.total ? kept.total / base.total : 0) : null,
    splitShare: base && bySplit ? Object.fromEntries([...bySplit.by].map(([k, v]) => [k, base.total ? v / base.total : 0])) : null,
  };
}

function datesOf(source: PacingSource, p: Period): ListFilter[] {
  const start = Date.parse(`${p.start}T00:00:00Z`);
  const end = start + p.days * 86_400_000;
  if (source.dateType === "datetime") return [{ field: source.date, op: "gte", value: start }, { field: source.date, op: "lt", value: end }];
  return [{ field: source.date, op: "gte", value: p.start }, { field: source.date, op: "lte", value: new Date(end - 86_400_000).toISOString().slice(0, 10) }];
}

async function periodAmounts(client: RecordClient, orgId: string, source: PacingSource, p: Period, filter: ListFilter[], field: string | undefined, bucket: ReportBucket) {
  const res = await asListError(() => client.aggregate(orgId, source.object, {
    filter: [...filter, ...datesOf(source, p)],
    groupBy: [{ field: source.date, bucket }, ...(field ? [{ field }] : [])],
    measures: [{ fn: "sum", field: source.amount }],
  }));
  const rows = new Map<string | null, number[]>();
  for (const g of res.groups) {
    const key = field ? (g.keys[1] === null ? null : String(g.keys[1])) : null;
    const daily = rows.get(key) ?? new Array<number>(p.days).fill(0);
    const firstDayInPeriod = Math.max(0, dayOf(String(g.keys[0]), p));
    daily[firstDayInPeriod] += g.values[0] ?? 0;
    rows.set(key, daily);
  }
  return { rows, truncated: res.truncated };
}
