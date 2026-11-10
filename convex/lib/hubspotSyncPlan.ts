/**
 * Whether a HubSpot sync reads every record or only those modified since the last one, QuotaQueue's pattern
 * (lib/syncWatermark.ts there). An incremental sync's window starts a little before the last sync started, so a
 * record modified while that sync read, or stamped by a HubSpot clock slightly behind ours, is read again; rewriting
 * it changes nothing. A full sync runs when there is no complete earlier sync to start from, when the last sync did not
 * succeed (records it created before it stopped would read as unchanged and never be counted; a full sync counts
 * every record), when the field mappings changed (records must be read again with the new properties), and at least
 * every FULL_SYNC_EVERY_MS, as the backstop for anything a window missed. A user can also ask for one (Full resync).
 *
 * Pure: no database access, no Node-only imports.
 */
import { fnv64, stableJson } from "./syncUnchanged.ts";

export const FULL_SYNC_EVERY_MS = 6 * 24 * 60 * 60 * 1000;
export const MODIFIED_OVERLAP_MS = 10 * 60 * 1000;

export type HubspotSyncCursors = { modifiedSince?: number; fullSyncAt?: number; mappingsKey?: string; openSince?: number } | null | undefined;

export type HubspotSyncPlan = { mode: "full" } | { mode: "incremental"; since: number };

export function planHubspotSync(cursors: HubspotSyncCursors, o: { hasCounts: boolean; mappingsKey: string; now: number; full?: boolean }): HubspotSyncPlan {
  const c = cursors ?? {};
  if (o.full) return { mode: "full" };
  if (c.modifiedSince === undefined || c.fullSyncAt === undefined || c.openSince !== undefined) return { mode: "full" };
  if (!o.hasCounts || c.mappingsKey !== o.mappingsKey || o.now - c.fullSyncAt >= FULL_SYNC_EVERY_MS) return { mode: "full" };
  return { mode: "incremental", since: c.modifiedSince - MODIFIED_OVERLAP_MS };
}

/** A short stable name for a field mapping configuration: object keys in any order name the same one. */
export function mappingsKey(mappings: unknown): string {
  return fnv64(stableJson(mappings));
}
