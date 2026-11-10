/**
 * Write rows from an action through a mutation in batches, a few at a time. A batch that fails on a write conflict
 * (another transaction kept changing what it read) or on one of Convex's per-transaction limits is split in half and
 * each half retried, down to single rows; any other error, or a single row that still fails, is thrown. A mutation is
 * atomic, so a failed batch wrote nothing and retrying it cannot write a row twice.
 *
 * Ledger saves on one shard serialize (convex/objects.ts nextSeq), so concurrency speeds up batches that are mostly
 * unchanged rows (a repeat sync), not batches of new records; it stays low so conflicts stay rare.
 */
import { mapLimit } from "../../engine/src/connectors/hubspotPacing.ts";
import { chunk } from "./collections.ts";

const RETRYABLE = /changed while this mutation was being run|too many (reads|writes|documents|bytes)|too large|timed out|writes per second/i;

export const isRetryableWriteError = (error: unknown) => RETRYABLE.test(error instanceof Error ? error.message : String(error));

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit `batch`, splitting it on a retryable failure. `submit` may return the rows it left for another transaction
 * (a party sync past its read budget); they are submitted the same way until none are left.
 */
export async function writeSplitting<T>(batch: T[], submit: (rows: T[]) => Promise<T[] | void>): Promise<void> {
  let left: T[] | void;
  try {
    left = await submit(batch);
  } catch (error) {
    if (!isRetryableWriteError(error)) throw error;
    if (batch.length === 1) {
      // One row that conflicted gets one more try after the competing transaction has had time to finish.
      await pause(250);
      left = await submit(batch);
    } else {
      const half = Math.ceil(batch.length / 2);
      await writeSplitting(batch.slice(0, half), submit);
      await writeSplitting(batch.slice(half), submit);
      return;
    }
  }
  if (left?.length) await writeSplitting(left, submit);
}

/**
 * Chunks of about `size` rows that never part rows of one `keyOf` (a record's history facts, which append to one
 * stream and would conflict across concurrent batches). Rows of a key must be adjacent.
 */
export function chunkKeeping<T>(rows: readonly T[], size: number, keyOf: (row: T) => string): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  for (const [i, row] of rows.entries()) {
    if (current.length >= size && keyOf(row) !== keyOf(rows[i - 1])) {
      out.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) out.push(current);
  return out;
}

/** Submit `rows` in batches of `size` (keeping each `keyOf` together), at most `concurrency` at once (see the module comment). */
export async function writeInBatches<T>(rows: readonly T[], o: { size: number; concurrency?: number; keyOf?: (row: T) => string; submit: (rows: T[]) => Promise<T[] | void> }): Promise<void> {
  const batches = o.keyOf ? chunkKeeping(rows, o.size, o.keyOf) : chunk([...rows], o.size);
  await mapLimit(batches, o.concurrency ?? 1, (batch) => writeSplitting(batch, o.submit));
}
