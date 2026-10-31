// GENERATED from convex/lib/objects/splits.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
export type SplitAllocation = { userId: string; percentage: number; kind: "revenue" | "overlay" };
export const MAX_SPLITS = 100;

export function percentageBasisPoints(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100 || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, fraction = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function parseSplits(raw: unknown): { ok: true; value: SplitAllocation[] | null } | { ok: false; message: string } {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length > MAX_SPLITS) return { ok: false, message: `Use a list of at most ${MAX_SPLITS} credit splits` };
  const seen = new Set<string>();
  const splits: SplitAllocation[] = [];
  let revenue = 0;
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some((key) => !["userId", "percentage", "kind"].includes(key))
      || typeof row.userId !== "string" || !row.userId.trim() || (row.kind !== "revenue" && row.kind !== "overlay") || typeof row.percentage !== "number") {
      return { ok: false, message: "Each split needs a member, a percentage and revenue or overlay kind" };
    }
    const bp = percentageBasisPoints(row.percentage);
    if (bp === null) return { ok: false, message: "Split percentages must be between 0 and 100 with at most two decimal places" };
    const userId = row.userId.trim();
    const key = `${row.kind}:${userId}`;
    if (seen.has(key)) return { ok: false, message: "A member may appear only once for each split kind" };
    seen.add(key);
    splits.push({ userId, percentage: row.percentage, kind: row.kind });
    if (row.kind === "revenue") revenue += bp;
  }
  if (revenue !== 10000) return { ok: false, message: "Revenue splits must add up to 100%" };
  return { ok: true, value: splits.sort((a, b) => a.kind.localeCompare(b.kind) || a.userId.localeCompare(b.userId)) };
}
