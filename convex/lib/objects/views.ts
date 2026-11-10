/**
 * What a list view (CP2b) does around `objects.list` and `objects.bulk`:
 * group a selection by shard, run each shard's saves one at a time with
 * retries, and know when the projection has caught up with a save.
 *
 * Pure: no database access, no Node-only imports. The UI and tests share it.
 */
import { shardOf } from "./write.ts";
import { compileListRequest, ListRequestError, listColumns, type ListFilter, type ListSort, type ProjectedThrough } from "./listSpec.ts";
import type { ResolvedObjectDef } from "./registry.ts";

export const VIEW_COLUMNS_MAX = 40;

/**
 * Records one `objects.bulk` call saves. A list view groups its selection by
 * shard and sends each shard's ids in calls of at most this many, so
 * concurrent calls never contend on one shard head (docs/cp0-object-layer.md, Risks).
 */
export const BULK_MAX = 25;

/** A saved view's spec (validators.ts viewSpec). */
export type ViewSpecShape = { filter: readonly ListFilter[]; sort?: ListSort; columns: readonly string[]; layout: "table" | "board"; groupBy?: string };

/**
 * Why a list could not serve a view spec, or null when it can. A saved view never opens to an error.
 * `displayColumns` are columns the list shows without sending them to the record query (contact AI
 * fields): a view may name them, but may not filter or sort by them.
 */
export function viewSpecProblem(def: ResolvedObjectDef, spec: ViewSpecShape, displayColumns: ReadonlySet<string> = new Set()): string | null {
  try {
    // Validated with UTC days; any time zone gives the same shape. A board column adds its own predicate.
    const filter = expandDayFilters(spec.filter, dayColumnsOf(def), (y, m, d) => Date.UTC(y, m - 1, d));
    const column = spec.layout === "board" && spec.groupBy ? [{ field: spec.groupBy, op: "empty" as const }] : [];
    compileListRequest(def, { filter: [...filter, ...column], ...(spec.sort ? { sort: spec.sort } : {}) });
  } catch (e) {
    if (e instanceof ListRequestError) return e.message;
    throw e;
  }
  const columns = listColumns(def);
  if (spec.columns.length > VIEW_COLUMNS_MAX) return `A view shows at most ${VIEW_COLUMNS_MAX} columns`;
  const unknown = spec.columns.find((c) => !columns.has(c) && !displayColumns.has(c));
  if (unknown !== undefined) return `unknown column ${unknown}`;
  if (spec.layout === "board") {
    const field = spec.groupBy ? def.byApiName.get(spec.groupBy) : undefined;
    if (!field || field.type !== "picklist") return "A board groups by a picklist field";
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
