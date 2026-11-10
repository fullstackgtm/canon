"use client";

import { useEffect, useState } from "react";

/**
 * Whether the time `at` (ms since epoch) has passed, flipping on its own when it does.
 * A Convex query only re-runs when its data changes, so a page left open can't learn
 * from it that a run went stale; this timer does. `null` means no deadline.
 */
export function useDeadlinePassed(at: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return at !== null && now >= at;
}
