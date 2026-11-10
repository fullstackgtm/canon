/**
 * A full HubSpot sync reads each large object in a few record-id ranges at once instead of one cursor: a list page is
 * one request of 100 records, so one cursor reads at the speed of HubSpot's replies (~140 ms on dev, ~700 records a
 * second), well under the portal's request window, which the connector's pacer still keeps every read inside.
 *
 * Ranges hold about as many records each, split at the ids search finds at even ranks (ids cluster: a portal's old
 * and new records are far apart). A range starts its list cursor just below its first id. That relies on HubSpot's
 * list cursor being a record id and its pages coming in id order, which its documentation does not promise, so:
 *
 * - A range's first page must start at the range's first record, as search finds it (`firstIdFrom`). One that does
 *   not has written nothing: its ids go to the range before it, still reading (`mergeSlice`), and the portal's next
 *   full syncs read in one cursor.
 * - Every later page must hold ids in order, above the range's start. One that does not fails the sync, as ranges
 *   already written cannot be read again without counting them twice; the next sync reads in one cursor.
 *
 * Pure: no database access, no Node-only imports.
 */

/**
 * One id range of an object: [from, end), its list cursor, whether it has been read to its end, and the records it
 * read. `merged`: its ids went to the range before it. `ended`: a page passed its end (no ids can join it now).
 */
export type SyncSlice = { after: string | null; from?: number; end?: number; done: boolean; read: number; merged?: boolean; ended?: boolean };

/** Ranges an object is read in at most, and the fewest records worth a range of their own. */
export const MAX_SLICES = 4;
export const SLICE_MIN_RECORDS = 2_500;

/** A page that shows HubSpot's list cursor is not a record id in order. */
export class SliceCursorUnsupported extends Error {
  /** On a range's first page, before it wrote anything. */
  readonly firstPage: boolean;
  constructor(message: string, firstPage = false) {
    super(message);
    this.firstPage = firstPage;
  }
}

/** The ranks at which an object of `total` records is split into ranges of about as many records each. */
export function sliceRanks(total: number | undefined): number[] {
  const n = total ? Math.min(MAX_SLICES, Math.floor(total / SLICE_MIN_RECORDS)) : 1;
  return Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.round(((i + 1) * total!) / n));
}

/**
 * The ranges between record ids `bounds` (ascending; each starts a range): the first from the list's start, the last
 * to its end, so records created mid-sync are read. No bounds: one range, the whole list.
 */
export function planSlices(bounds: readonly number[]): SyncSlice[] {
  const starts = bounds.filter((id, i) => Number.isFinite(id) && (i === 0 || id > bounds[i - 1]));
  if (!starts.length) return [{ after: null, done: false, read: 0 }];
  return [undefined, ...starts].map((from, i) => ({
    after: from === undefined ? null : String(from - 1),
    ...(from !== undefined ? { from } : {}),
    ...(i < starts.length ? { end: starts[i] } : {}),
    done: false,
    read: 0,
  }));
}

/**
 * The part of a list page inside `slice`, and the cursor of its next page (null once the range's end is passed).
 * `previousId` is the last id this range read before the page, if any. Throws SliceCursorUnsupported when the page
 * has a row below the range's cursor or out of id order.
 */
export function slicePage<R extends { crmId?: string }>(slice: SyncSlice, page: { rows: R[]; next: string | null }, previousId?: number): { rows: R[]; next: string | null; lastId?: number } {
  // A range's cursor starts one below its first id, so it holds whether HubSpot reads from the cursor's id or past it.
  const floor = slice.from === undefined ? -Infinity : slice.from - 1;
  let last = previousId ?? -Infinity;
  for (const row of page.rows) {
    const id = Number(row.crmId);
    if (!Number.isFinite(id) || id < floor || id <= last) throw new SliceCursorUnsupported(`HubSpot's list cursor read record ${row.crmId} out of id order`);
    last = id;
  }
  const rows = page.rows.filter((r) => (slice.from === undefined || Number(r.crmId) >= slice.from) && (slice.end === undefined || Number(r.crmId) < slice.end));
  const passedEnd = slice.end !== undefined && page.rows.some((r) => Number(r.crmId) >= slice.end!);
  return { rows, next: passedEnd ? null : page.next, ...(Number.isFinite(last) ? { lastId: last } : {}) };
}

/**
 * Read a range's page at `after` from the list (`list`), kept to the range (slicePage), and note when it passes the
 * range's end. Its first page must start at the range's first record (`firstIdFrom`, by search): a list cursor that is
 * a position, not an id, lands elsewhere. A refused first page counts the same.
 */
export async function readSlicePage<R extends { crmId?: string }>(
  slice: SyncSlice,
  after: string | null,
  o: { list: (after: string | null) => Promise<{ rows: R[]; next: string | null }>; firstIdFrom: (from: number) => Promise<number | undefined>; previousId?: number },
): Promise<{ rows: R[]; next: string | null; lastId?: number }> {
  const first = slice.from !== undefined && after === String(slice.from - 1);
  const listed = await o.list(after).catch((error) => {
    if (first) throw new SliceCursorUnsupported(error instanceof Error ? error.message : String(error), true);
    throw error;
  });
  if (first) {
    const expected = await o.firstIdFrom(slice.from!);
    const inRange = expected !== undefined && (slice.end === undefined || expected < slice.end);
    const got = listed.rows.find((r) => Number(r.crmId) >= slice.from!)?.crmId;
    if (inRange ? Number(got) !== expected : got !== undefined && (slice.end === undefined || Number(got) < slice.end)) {
      throw new SliceCursorUnsupported(`HubSpot's list cursor ${after} read record ${got ?? "none"} first, not ${inRange ? expected : "none"}`, true);
    }
  }
  // Kept to the range's end as it is now, and marked ended in the same turn: no merge can extend the end in between.
  try {
    const page = slicePage(slice, listed, o.previousId);
    if (page.next === null) slice.ended = true;
    return page;
  } catch (error) {
    if (first && error instanceof SliceCursorUnsupported) throw new SliceCursorUnsupported(error.message, true);
    throw error;
  }
}

/**
 * Give a range whose first page failed (and so wrote nothing) to the range before it, which reads on through its ids.
 * False when that range already passed its end: its ids cannot be read without starting the list again.
 */
export function mergeSlice(slices: SyncSlice[], failed: SyncSlice): boolean {
  const i = slices.indexOf(failed);
  const before = slices.slice(0, i).reverse().find((s) => !s.merged);
  if (!before || before.done || before.ended) return false;
  if (failed.end === undefined) delete before.end;
  else before.end = failed.end;
  failed.merged = true;
  failed.done = true;
  return true;
}
