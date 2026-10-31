"use client";

import { useState } from "react";

/** The most rows one background refresh re-reads (records.list caps a page at 200). */
export const REFRESH_WINDOW_MAX = 200;

/** How many rows a background refresh should re-read so the loaded window stays in place. */
export const refreshLimit = (loaded: number, pageSize = 50) => Math.min(Math.max(loaded, pageSize), REFRESH_WINDOW_MAX);

/**
 * Fold a re-read of the first rows into what is loaded, so a list takes new
 * records in place instead of collapsing to its first page. Rows the re-read
 * window no longer covers stay after it, and so does their cursor; otherwise
 * the fresh cursor wins.
 */
export function refreshRows<T extends { id: string }>(
  current: readonly T[] | null,
  fresh: readonly T[],
  cursors: { current: string | null; fresh: string | null },
): { rows: T[]; cursor: string | null } {
  if (!current || current.length <= fresh.length || current.length <= REFRESH_WINDOW_MAX) {
    return { rows: [...fresh], cursor: cursors.fresh };
  }
  const seen = new Set(fresh.map((row) => row.id));
  return { rows: [...fresh, ...current.filter((row) => !seen.has(row.id))], cursor: cursors.current };
}

/**
 * The last complete result of a set of subscriptions, overlaid with whatever
 * has arrived since. A re-keyed subscription is briefly undefined; without
 * this, every cell it feeds blanks out until it resolves.
 */
export function useKeepSettled<T extends object>(partial: T, settled: boolean): T | undefined {
  const [last, setLast] = useState<{ key: string; value: T }>();
  if (settled) {
    const key = JSON.stringify(partial);
    if (last?.key !== key) setLast({ key, value: partial });
    return partial;
  }
  return last ? { ...last.value, ...partial } : undefined;
}
