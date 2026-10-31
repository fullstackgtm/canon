// Background activity tray helpers (ported from QuotaQueue's src/lib/background-activity.ts).
import type { BackgroundActivityEntry, BackgroundActivityStatus } from "../../convex/activity";

export type { BackgroundActivityEntry, BackgroundActivityStatus };

export function isActiveBackgroundActivity(entry: Pick<BackgroundActivityEntry, "status">): boolean {
  return entry.status === "pending" || entry.status === "processing";
}

export function partitionBackgroundActivity(activity: readonly BackgroundActivityEntry[]) {
  const active: BackgroundActivityEntry[] = [];
  const recent: BackgroundActivityEntry[] = [];
  for (const entry of activity) (isActiveBackgroundActivity(entry) ? active : recent).push(entry);
  return { active, recent };
}

export function backgroundActivityLabel(activeCount: number): string {
  return activeCount > 0
    ? `${activeCount} background ${activeCount === 1 ? "job" : "jobs"} in progress`
    : "View background activity";
}

export function formatRelativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
