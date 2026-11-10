/**
 * Pace HubSpot reads so concurrent ones stay inside the portal's rolling window instead of discovering it with 429s.
 * HubSpot reports the window on each response (`X-HubSpot-RateLimit-Max`, `-Remaining`, `-Interval-Milliseconds`;
 * search responses omit them). While a fresh observation is within the window's last 10% (at least five calls), the
 * next request waits for the window to reset. Stale observations never block. The same rule QuotaQueue's HubSpot sync
 * uses (convex/lib/syncApiBudget.ts there).
 *
 * Pure apart from timers: no Node-only imports (Convex default runtime).
 */

export type HubspotRateLimitObservation = { max: number; remaining: number; intervalMs: number; observedAt: number };

type HeaderReader = { get(name: string): string | null };

/** HubSpot's rolling-window headers, or undefined when a response has none (search) or they do not parse. */
export function parseHubspotRateLimit(headers: HeaderReader, now: number): HubspotRateLimitObservation | undefined {
  const max = Number(headers.get("X-HubSpot-RateLimit-Max"));
  const remaining = Number(headers.get("X-HubSpot-RateLimit-Remaining"));
  const intervalMs = Number(headers.get("X-HubSpot-RateLimit-Interval-Milliseconds"));
  if (!(max > 0) || !(remaining >= 0) || !(intervalMs > 0) || headers.get("X-HubSpot-RateLimit-Remaining") === null) return undefined;
  return { max, remaining, intervalMs, observedAt: now };
}

/** How long to wait before the next request: until the window resets while it is within its last 10%, else 0. */
export function hubspotRateLimitDelayMs(state: HubspotRateLimitObservation | undefined, now: number): number {
  if (!state) return 0;
  const resetAt = state.observedAt + state.intervalMs;
  if (now >= resetAt) return 0;
  const reserve = Math.max(5, Math.ceil(state.max * 0.1));
  return state.remaining <= reserve ? resetAt - now + 100 : 0;
}

/** A semaphore: `run` starts `task` once fewer than `max` started tasks are still running. */
export function concurrencyLimit(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Map `items` through `fn`, at most `max` at a time, keeping their order. After a failure no further item starts, and
 * the call rejects only once the items already running have settled: a caller that sees the error knows nothing of
 * this call is still writing.
 */
export async function mapLimit<T, R>(items: readonly T[], max: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, max), items.length) }, worker));
  if (failure) throw failure.error;
  return out;
}

export type HubspotPacer = {
  /** Send one request through the pacer: at most `maxConcurrent` in flight, each waiting out a nearly spent window. */
  send(request: () => Promise<Response>): Promise<Response>;
  /** The window HubSpot last reported, if any. */
  observed(): HubspotRateLimitObservation | undefined;
};

/** One pacer per client: its requests share the in-flight cap and the latest window observation. */
export function createHubspotPacer(o: { maxConcurrent?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): HubspotPacer {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const run = concurrencyLimit(o.maxConcurrent ?? 4);
  let window: HubspotRateLimitObservation | undefined;
  return {
    send: (request) => run(async () => {
      const delay = hubspotRateLimitDelayMs(window, now());
      if (delay > 0) await sleep(delay);
      const res = await request();
      const seen = parseHubspotRateLimit(res.headers, now());
      if (seen) window = seen;
      return res;
    }),
    observed: () => window,
  };
}
