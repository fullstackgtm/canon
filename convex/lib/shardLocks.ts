/**
 * A sync's locks on its org's ledger shards. A write that appends to the ledger takes the shard head of each record
 * it writes (lib/objects/write.ts shardOf, convex/objects.ts nextSeq), so two writes conflict exactly when they share a
 * shard: a batch of new records spread over every shard runs alone, while batches of records grouped by shard run at
 * once, one per group, without a conflict to retry.
 *
 * Each write waits for the writes before it on any of its shards, in the order they were asked for; a write that names
 * no shards (it may take any) waits for every one. Ordering is all a lock gives: a write that takes a shard it did not
 * name still runs, and Convex's own conflict check keeps it correct.
 *
 * Pure: no database access, no Node-only imports.
 */
export function shardLocks(count: number) {
  // Settles once the last write asked for on each shard has; never rejects, so one failed write holds no shard.
  const tails: Promise<void>[] = Array.from({ length: count }, () => Promise.resolve());
  return function run<T>(shards: readonly number[] | null, task: () => Promise<T>): Promise<T> {
    const held = shards ? [...new Set(shards.map((s) => s % count))] : tails.map((_, i) => i);
    const result = Promise.all(held.map((s) => tails[s])).then(task);
    const settled = result.then(() => undefined, () => undefined);
    for (const s of held) tails[s] = settled;
    return result;
  };
}
