/**
 * A sync's per-object write rate and the time it has left, for the progress bars on the integrations page. The rate
 * is records a second, smoothed across samples so one fast page of unchanged records or one slow page of new ones
 * does not swing the estimate. The time left assumes the objects share one writer (hubspotActions.ts writes one
 * upsert at a time): everything left, at the objects' combined rate.
 *
 * Pure: no database access, no Node-only imports.
 */

export type RateSample = { done: number; at: number };

/** Samples closer together than this say little about a rate. */
export const RATE_MIN_INTERVAL_MS = 2_000;
/** How much each new sample moves the smoothed rate. */
const SMOOTHING = 0.3;

/** The smoothed rate after moving from `prev` to `next`, or `rate` unchanged when they are too close to tell. */
export function nextRate(rate: number | undefined, prev: RateSample, next: RateSample): number | undefined {
  const ms = next.at - prev.at;
  if (ms < RATE_MIN_INTERVAL_MS || next.done < prev.done) return rate;
  const instant = ((next.done - prev.done) * 1000) / ms;
  return rate === undefined ? instant : rate + SMOOTHING * (instant - rate);
}

export type ObjectProgress = { object: string; done: number; total?: number; finished: boolean; perSecond?: number };

/** Seconds an object has left at its own rate, or undefined while it has none (or no total). */
export function objectSecondsLeft(o: ObjectProgress): number | undefined {
  if (o.finished) return 0;
  if (o.total === undefined || !o.perSecond || o.perSecond <= 0) return undefined;
  return Math.max(0, o.total - o.done) / o.perSecond;
}

/** Seconds the whole sync has left: every unfinished object's remaining records at the objects' combined rate. */
export function syncSecondsLeft(objects: readonly ObjectProgress[]): number | undefined {
  const open = objects.filter((o) => !o.finished);
  if (!open.length) return 0;
  if (open.some((o) => o.total === undefined)) return undefined;
  const rate = open.reduce((sum, o) => sum + (o.perSecond ?? 0), 0);
  if (rate <= 0) return undefined;
  return open.reduce((sum, o) => sum + Math.max(0, o.total! - o.done), 0) / rate;
}

/** "about 12 min left", for a number of seconds. */
export function formatTimeLeft(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min left` : `about ${hours} h left`;
}

/** The objects writing now: companies first, then people and deals side by side once companies are in. */
export function movingObjects(objects: readonly ObjectProgress[]): string[] {
  const companies = objects.find((o) => o.object === "accounts");
  return objects.filter((o) => !o.finished && (o.object === "accounts" || !companies || companies.finished)).map((o) => o.object);
}
