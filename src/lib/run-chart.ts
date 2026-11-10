export const RUN_KINDS = ["cli", "evidence", "lead", "sync", "plan", "health", "records", "research"] as const;
export type RunKind = typeof RUN_KINDS[number];
export type RunInterval = "hourly" | "daily" | "weekly" | "monthly";

export function groupRuns(rows: readonly { at: number; kind: RunKind }[], interval: RunInterval) {
  const buckets = new Map<number, Record<RunKind, number>>();
  for (const row of rows) {
    const date = new Date(row.at);
    date.setUTCMinutes(0, 0, 0);
    if (interval !== "hourly") date.setUTCHours(0);
    if (interval === "weekly") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    if (interval === "monthly") date.setUTCDate(1);
    const at = date.getTime();
    const counts = buckets.get(at) ?? { cli: 0, evidence: 0, lead: 0, sync: 0, plan: 0, health: 0, records: 0, research: 0 };
    counts[row.kind]++;
    buckets.set(at, counts);
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([at, counts]) => ({ at, counts }));
}
