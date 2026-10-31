/**
 * When a free provider refuses (allowance used up) or rate-limits, how long
 * to pause it. A named reset wins; otherwise 15 min, doubling with each pause
 * episode that follows without a success, never more than 6 h (treg's own
 * ceiling on a vendor-stated reset). Refusals inside a running pause belong
 * to that episode: they don't add strikes. Strikes from a pause that ended more
 * than MAX_PAUSE_MS ago are forgotten: an old episode says nothing about today.
 */
export const FIRST_PAUSE_MS = 15 * 60 * 1000;
export const MAX_PAUSE_MS = 6 * 60 * 60 * 1000;

/**
 * The pause reason's prefix when a free provider would now charge (TregRefusal.noFreeAllowance):
 * tasks that find it skip their search instead of waiting for a reset nobody named.
 */
export const NO_FREE_ALLOWANCE = "no_free_allowance";

/** A rate limit that names no reset: a per-minute window, so a minute. */
export const RATE_LIMIT_PAUSE_MS = 60 * 1000;

export function nextPause(
  row: { pausedUntil: number; strikes: number } | null,
  now: number,
  retryAt?: number,
  rateLimited = false,
): { pausedUntil: number; strikes: number; changed: boolean } {
  if (row && row.pausedUntil > now) {
    // Same episode: no new strike, but a later reset the provider names extends it for everyone.
    const pausedUntil = Math.max(row.pausedUntil, Math.min(retryAt ?? 0, now + MAX_PAUSE_MS));
    return { pausedUntil, strikes: row.strikes, changed: pausedUntil > row.pausedUntil };
  }
  const prior = row && now - row.pausedUntil <= MAX_PAUSE_MS ? row.strikes : 0;
  // A rate limit is a short window, not an empty allowance: no strike, no doubling.
  if (rateLimited) return { pausedUntil: Math.min(retryAt ?? now + RATE_LIMIT_PAUSE_MS, now + MAX_PAUSE_MS), strikes: prior, changed: true };
  const strikes = prior + 1;
  const guess = Math.min(FIRST_PAUSE_MS * 2 ** (strikes - 1), MAX_PAUSE_MS);
  return { pausedUntil: Math.min(retryAt ?? now + guess, now + MAX_PAUSE_MS), strikes, changed: true };
}

/**
 * Calls a minute we allow ourselves per rate-limited provider, below what it
 * reported (observed 2026-10-06), shared by every job. QuickEnrich states no
 * limit: 120 is twice the rate dev ran without a 429 (2026-10-09). Providers
 * not listed are paced only by refusals.
 */
export const CALLS_PER_MIN: Record<string, number> = { crustdata: 25, companyenrich: 100, quickenrich: 120 };

/** Reserve the next `count` call slots: the first slot's time, and where the following reservation starts. */
export function nextSlot(nextSlotAt: number | undefined, now: number, perMin: number, count = 1): { at: number; next: number; intervalMs: number } {
  const at = Math.max(now, nextSlotAt ?? 0);
  const intervalMs = Math.ceil(60_000 / perMin);
  return { at, next: at + count * intervalMs, intervalMs };
}
