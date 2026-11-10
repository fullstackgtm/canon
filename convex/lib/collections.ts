/**
 * Split rows into fixed-size chunks. Sync actions batch their upsert
 * mutation calls with this: each upserted row costs ~2 document ops
 * (indexed lookup + patch/insert), and a single Convex mutation is capped at
 * 4096 reads — one call with a whole CRM's contacts blows the limit.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function indexById<T extends { _id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row._id, row] as const));
}

export function countBy<T, K extends string>(rows: T[], key: (row: T) => K | undefined | null) {
  const counts = new Map<K, number>();
  for (const row of rows) {
    const value = key(row);
    if (value == null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
