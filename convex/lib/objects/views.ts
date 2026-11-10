/**
 * What a list view (CP2b) does around `objects.list` and `objects.bulk`:
 * group a selection by shard, run each shard's saves one at a time with
 * retries, and know when the projection has caught up with a save.
 *
 * Pure: no database access, no Node-only imports. The UI and tests share it.
 */
import { shardOf } from "./write.ts";
import { compileListRequest, ListRequestError, listColumns, type ListFilter, type ListSort, type ProjectedThrough, type Scalar } from "./listSpec.ts";
import { bucketEnd, groupKeyKind, type AggregateResponse } from "./reportSpec.ts";
import { REPORT_BUCKETS, type ReportBucket } from "../../../modules/kernel/reportLanguage.ts";
import type { ResolvedObjectDef } from "./registry.ts";
import { calendarKind, daysFilter } from "./calendar.ts";

export const VIEW_COLUMNS_MAX = 40;

/**
 * Records one `objects.bulk` call saves. A list view groups its selection by
 * shard and sends each shard's ids in calls of at most this many, so
 * concurrent calls never contend on one shard head (docs/cp0-object-layer.md, Risks).
 */
export const BULK_MAX = 25;

/** What a view groups its records by: a field, and for a date the report language's bucket (month by default). */
export type ViewGroup = { field: string; bucket?: ReportBucket };

/** A saved view's spec (validators.ts viewSpec). `groupBy` is a board's picklist from before `group` existed. */
export type ViewSpecShape = { filter: readonly ListFilter[]; sort?: ListSort; columns: readonly string[]; layout: "table" | "board" | "calendar"; groupBy?: string; group?: ViewGroup; calendar?: { field: string } };

/** The grouping a view shows: its `group`, or an older board's `groupBy`. A table saved with a board's `groupBy` stays ungrouped. */
export function viewGroupOf(spec: Pick<ViewSpecShape, "layout" | "groupBy" | "group">): ViewGroup | null {
  if (spec.group) return spec.group;
  return spec.layout === "board" && spec.groupBy ? { field: spec.groupBy } : null;
}

/**
 * A spec as a view is saved from now on: its grouping in `group` only. An older board's `groupBy` becomes its
 * `group`; a table's leftover `groupBy`, which never grouped it, is dropped. Stored views keep validating either way.
 */
export function normalizeViewSpec<S extends Pick<ViewSpecShape, "layout" | "groupBy" | "group">>(spec: S): Omit<S, "groupBy"> {
  const rest = Object.fromEntries(Object.entries(spec).filter(([k]) => k !== "groupBy")) as Omit<S, "groupBy">;
  const group = viewGroupOf(spec);
  return group ? { ...rest, group } : rest;
}

/**
 * Field types a board makes columns of: a closed set of values in a defined order (a picklist's options, the
 * workspace's members, yes and no). A lookup is not one: its values are any record, with no order to lay out.
 */
export const BOARD_FIELD_TYPES: readonly string[] = ["picklist", "user", "checkbox"];

type BoardField = { type: string; label: string; options?: ReadonlyArray<{ value: string; label: string; active: boolean }> };
type Member = { _id: string; name: string; isActive?: boolean };

/** One board column: the group key it holds (null for records with no value), its label, and whether a card can be dropped into it. */
export type BoardColumnOf = { key: Scalar | null; label: string; accepts: boolean };

/**
 * A board's columns, in the field's own order: every picklist option (an inactive one holds its records but takes
 * no drops), every active member for a user field (in the given order), yes then no, then "No <field>" (a yes/no field's "Not set"). A key the
 * records hold that is none of these (a removed option, a former member) gets a column after them that takes no
 * drops, so no record drops off the board.
 */
export function boardColumns(field: BoardField, members: readonly Member[], seen: ReadonlyArray<Scalar | null> = []): BoardColumnOf[] {
  const defined: BoardColumnOf[] =
    field.type === "picklist" ? (field.options ?? []).map((o) => ({ key: o.value, label: o.active ? o.label : `${o.label} (inactive)`, accepts: o.active }))
    : field.type === "user" ? members.filter((m) => m.isActive !== false).map((m) => ({ key: m._id, label: m.name, accepts: true }))
    : field.type === "checkbox" ? [{ key: true, label: "Yes", accepts: true }, { key: false, label: "No", accepts: true }]
    : [];
  const known = new Set(defined.map((c) => JSON.stringify(c.key)));
  const others = [...new Set(seen.filter((k): k is Scalar => k !== null && !known.has(JSON.stringify(k))))];
  const otherLabel = (key: Scalar) => {
    if (field.type !== "user") return String(key);
    const member = members.find((m) => m._id === key);
    return member ? `${member.name} (inactive)` : "Former member";
  };
  return [...defined, ...others.map((key) => ({ key, label: otherLabel(key), accepts: false })), { key: null, label: field.type === "checkbox" ? "Not set" : `No ${field.label.toLowerCase()}`, accepts: true }];
}

/** The field a grouped list sums per group beside the count, where the app already sums one: a deal's amount (cents). */
export const GROUP_SUM_FIELD: Readonly<Record<string, string>> = { deal: "amount" };

/** Groups a grouped list shows, of the GROUPS_MAX an aggregate returns; past them it asks for a narrower filter. */
export const VIEW_GROUPS_MAX = 100;

/** A grouped list's groups: each key's count (and sum, in cents), in key order with the empty key last. */
export type GroupsResponse = {
  groups: Array<{ key: Scalar | null; count: number; sum: number | null }>;
  /** Records in every group, and their sum. */
  rows: number;
  sum: number | null;
  /** The field summed, or null when only counted. */
  summed: string | null;
  /** More groups than VIEW_GROUPS_MAX matched. */
  truncated: boolean;
  projectedThrough: ProjectedThrough;
};

/** An aggregate over one group key (count, then the sum when `summed`) as a grouped list's groups. */
export function groupsOf(res: AggregateResponse, summed: string | null): GroupsResponse {
  return {
    groups: res.groups.slice(0, VIEW_GROUPS_MAX).map((g) => ({ key: g.keys[0] ?? null, count: g.values[0] ?? 0, sum: summed ? g.values[1] ?? null : null })),
    rows: res.rows,
    sum: summed ? res.total[1] ?? null : null,
    summed,
    truncated: res.truncated || res.groups.length > VIEW_GROUPS_MAX,
    projectedThrough: res.projectedThrough,
  };
}

/**
 * The filters that select one group's records: the group's key (null for the
 * records with none) as the aggregate computed it. A bucketed date is a range
 * from its first day to the next bucket's; an instant's buckets are UTC days,
 * as the aggregate's are, so a group's rows are exactly the ones it counted.
 */
export function groupFilter(def: ResolvedObjectDef, group: ViewGroup, key: Scalar | null): Array<ListFilter & { value?: Scalar }> {
  const kind = groupKeyKind(def, group.field);
  if (!kind) throw new ListRequestError(`${group.field} cannot be grouped by`);
  if (key === null) return [{ field: group.field, op: "empty" }];
  if (kind === "value") return [{ field: group.field, op: "eq", value: key }];
  const start = String(key);
  const end = bucketEnd(start, group.bucket ?? "month");
  const at = (day: string) => (kind === "day" ? day : Date.parse(`${day}T00:00:00Z`));
  return [{ field: group.field, op: "gte", value: at(start) }, { field: group.field, op: "lt", value: at(end) }];
}

/**
 * Why a list could not serve a view spec, or null when it can. A saved view never opens to an error.
 * `displayColumns` are columns the list shows without sending them to the record query (contact AI
 * fields): a view may name them, but may not filter or sort by them.
 */
export function viewSpecProblem(def: ResolvedObjectDef, spec: ViewSpecShape, displayColumns: ReadonlySet<string> = new Set()): string | null {
  const group = viewGroupOf(spec);
  try {
    // Validated with UTC days; any time zone gives the same shape. A group's rows add its own predicate, two for a date.
    const filter = expandDayFilters(spec.filter, dayColumnsOf(def), (y, m, d) => Date.UTC(y, m - 1, d));
    const kind = group ? groupKeyKind(def, group.field) : null;
    if (group && !kind) return `${group.field} cannot be grouped by`;
    if (group?.bucket !== undefined && kind === "value") return `${group.field} is not a date`;
    if (group?.bucket !== undefined && !(REPORT_BUCKETS as readonly string[]).includes(group.bucket)) return `bucket must be one of ${REPORT_BUCKETS.join(", ")}`;
    if (spec.layout === "calendar" && !(spec.calendar && calendarKind(def, spec.calendar.field))) return "A calendar places records by a date or date-time field";
    // A calendar reads its month as two more filters on its field, in place of a group's.
    const own = spec.layout === "calendar" ? daysFilter(spec.calendar!.field, calendarKind(def, spec.calendar!.field)!, "2000-01-01", "2000-02-01", "UTC")
      : group ? groupFilter(def, group, kind === "value" ? null : "2000-01-01") : [];
    compileListRequest(def, { filter: [...filter, ...own], ...(spec.sort ? { sort: spec.sort } : {}) });
  } catch (e) {
    if (e instanceof ListRequestError) return e.message;
    throw e;
  }
  const columns = listColumns(def);
  if (spec.columns.length > VIEW_COLUMNS_MAX) return `A view shows at most ${VIEW_COLUMNS_MAX} columns`;
  const unknown = spec.columns.find((c) => !columns.has(c) && !displayColumns.has(c));
  if (unknown !== undefined) return `unknown column ${unknown}`;
  if (spec.layout === "board") {
    const field = group ? def.byApiName.get(group.field) : undefined;
    if (!field || !BOARD_FIELD_TYPES.includes(field.type) || group?.bucket !== undefined) return "A board groups by a picklist, user or yes/no field";
  }
  return null;
}

/**
 * A selection split into batches of at most `max` ids, each batch inside one
 * shard. Batches of one shard are listed in order; `objects.bulk` saves a
 * batch in one transaction, so a shard's batches must run one after another.
 */
export function batchesByShard<T extends string>(ids: readonly T[], max: number): Map<number, T[][]> {
  const byShard = new Map<number, T[][]>();
  for (const id of new Set(ids)) {
    const shard = shardOf(id);
    const batches = byShard.get(shard) ?? [];
    const last = batches[batches.length - 1];
    if (last && last.length < max) last.push(id);
    else batches.push([id]);
    byShard.set(shard, batches);
  }
  return byShard;
}

export type BulkOutcome<R> = {
  /** Results by id, for every id a batch returned. */
  results: Map<string, R>;
  /** Ids whose batch failed after every retry, with the last error. */
  failed: Map<string, string>;
};

export type BulkOptions = {
  /** Attempts per batch, counting the first. A save can lose Convex's optimistic-concurrency retries on a busy shard head. */
  attempts?: number;
  /** Shards run at once. */
  concurrency?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a bulk change: shards in parallel (up to `concurrency`), each shard's
 * batches in order, a failed batch retried with backoff. A batch's
 * `unprocessed` ids (it hit its read budget) are sent again as the next batch.
 */
export async function runBulk<T extends string, R>(
  ids: readonly T[],
  max: number,
  send: (batch: T[]) => Promise<{ results: Array<{ streamId: T; result: R }>; unprocessed: T[] }>,
  opts: BulkOptions = {},
): Promise<BulkOutcome<R>> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const backoff = opts.backoffMs ?? ((n: number) => 150 * 2 ** n + Math.random() * 100);
  const sleep = opts.sleep ?? defaultSleep;
  const results = new Map<string, R>();
  const failed = new Map<string, string>();
  const queue = [...batchesByShard(ids, max).values()];

  async function runShard(batches: T[][]) {
    const pending = batches.map((b) => [...b]);
    while (pending.length > 0) {
      const batch = pending.shift()!;
      let lastError = "";
      let done = false;
      for (let attempt = 0; attempt < attempts && !done; attempt++) {
        if (attempt > 0) await sleep(backoff(attempt));
        try {
          const out = await send(batch);
          for (const r of out.results) results.set(r.streamId, r.result);
          // An unprocessed id made no progress; resending it alone keeps the loop finite.
          if (out.unprocessed.length > 0 && out.unprocessed.length < batch.length) pending.unshift(out.unprocessed);
          else for (const id of out.unprocessed) failed.set(id, "not processed: the batch ran out of read budget");
          done = true;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (!done) for (const id of batch) failed.set(id, lastError);
    }
  }

  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await runShard(next);
  });
  await Promise.all(workers);
  return { results, failed };
}

/** Whether a list response reflects every save in `saves`: each save's shard is projected through its `seq`. */
export function projectedPast(projectedThrough: ProjectedThrough, saves: ReadonlyArray<{ shard: number; seq: number }>): boolean {
  return saves.every((s) => (projectedThrough[String(s.shard)] ?? 0) >= s.seq);
}

/** Ops a day-picked timestamp filter offers: each becomes a range of the viewer's local days. */
export const DAY_OPS = ["eq", "gt", "gte", "lt", "lte", "empty", "notEmpty"] as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * List columns a view filters by calendar day: the timestamps (epoch ms)
 * createdAt, updatedAt and datetime fields. Their filters hold a
 * `YYYY-MM-DD` day, so a shared view means the same days for every viewer.
 */
export function dayColumnsOf(def: ResolvedObjectDef): Set<string> {
  const out = new Set(["createdAt", "updatedAt"]);
  for (const f of def.fields) if (f.type === "datetime" && !f.system) out.add(f.apiName);
  return out;
}

/**
 * The filters a list request carries. A day filter becomes a range of epoch
 * ms in the viewer's time zone (`localMidnight`, injectable for tests), so
 * "is 2026-10-07" matches that whole day and "on or before" includes it. A
 * malformed day passes through, and the list refuses it.
 */
export function expandDayFilters<F extends { field: string; op: string; value?: unknown }>(
  filters: readonly F[],
  dayColumns: ReadonlySet<string>,
  localMidnight: (y: number, m: number, d: number) => number = (y, m, d) => new Date(y, m - 1, d).getTime(),
): F[] {
  return filters.flatMap((f): F[] => {
    const day = dayColumns.has(f.field) && typeof f.value === "string" ? DAY.exec(f.value) : null;
    if (!day) return [f];
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const start = localMidnight(y, m, d);
    // The next midnight, not start + 24h: a day across a DST change is 23 or 25 hours.
    const end = localMidnight(y, m, d + 1);
    switch (f.op) {
      case "eq": return [{ ...f, op: "gte", value: start }, { ...f, op: "lt", value: end }];
      case "gt": return [{ ...f, op: "gte", value: end }];
      case "gte": return [{ ...f, op: "gte", value: start }];
      case "lt": return [{ ...f, op: "lt", value: start }];
      case "lte": return [{ ...f, op: "lt", value: end }];
      default: return [f];
    }
  });
}

/**
 * The inverse for editing: a day column's value at a local midnight back to the
 * day it names, op kept (`gte` midnight is "on or after" that day, `lt` midnight
 * "before" it), so a stored filter loads into the filter bar as dates.
 */
export function collapseDayFilters<F extends { field: string; op: string; value?: unknown }>(filters: readonly F[], dayColumns: ReadonlySet<string>): F[] {
  return filters.map((f) => {
    if (!dayColumns.has(f.field) || typeof f.value !== "number" || (f.op !== "gte" && f.op !== "lt")) return f;
    const at = new Date(f.value);
    if (at.getHours() || at.getMinutes() || at.getSeconds() || at.getMilliseconds()) return f;
    const pad = (n: number) => String(n).padStart(2, "0");
    return { ...f, value: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` };
  });
}
