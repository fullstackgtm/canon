/**
 * Lightweight, dependency-free profiler for Convex functions.
 *
 * Why this exists: the Convex dashboard tells you how long a *whole* function
 * took, but not which part of it dominated. This tracer adds that granularity
 * the same way a flame trace does — one labelled span per section — without a
 * schema change, a new dependency, or any behavior change.
 *
 * The PRIMARY signal here is `docs` (documents read), not milliseconds. Convex
 * queries/mutations bottleneck on how many documents they scan, and that count
 * is deterministic and retry-safe. Wall-clock `ms` is captured best-effort as a
 * secondary signal (it can be near-zero on cached reads); never tune on `ms`
 * alone — confirm with `docs`.
 *
 * Each trace emits ONE structured line:
 *   [fsgtm:trace] {"trace":"dashboard.summary","totalDocs":15040,"totalMs":812,"spans":[...]}
 * which is greppable in the Convex dashboard logs and routable as-is through
 * Convex Log Streams to Axiom/Datadog. Note: a cached query does not re-execute,
 * so it emits no trace — every trace you see is a real (uncached) execution.
 *
 * Usage:
 *   const trace = createTracer("dashboard.summary");
 *   const deals = await trace.track("deals", () =>
 *     ctx.db.query("deals").withIndex("by_orgId", q => q.eq("orgId", orgId)).take(5000));
 *   ...
 *   trace.end({ orgId });
 */

export type TraceSpan = {
  /** Section label, e.g. "deals" or "enrich:accounts". */
  label: string;
  /** Documents read in this section (array length, or 1 for a single doc). */
  docs: number;
  /** Best-effort wall-clock for the section. Secondary to `docs`. */
  ms: number;
};

export type TracePayload = {
  trace: string;
  totalDocs: number;
  totalMs: number;
  spans: TraceSpan[];
  [extra: string]: unknown;
};

/**
 * Count the documents a query result represents: arrays count by length, a
 * single document counts as 1, and null/undefined (a miss) counts as 0.
 */
function docCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return result == null ? 0 : 1;
}

export function createTracer(name: string) {
  const startedAt = Date.now();
  const spans: TraceSpan[] = [];

  /**
   * Run a query thunk, recording how many documents it read and how long it
   * took. Returns the thunk's result UNCHANGED — wrapping a call is transparent.
   */
  async function track<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const sectionStart = Date.now();
    const result = await fn();
    spans.push({ label, docs: docCount(result), ms: Date.now() - sectionStart });
    return result;
  }

  /**
   * Record a span manually when the doc count isn't a simple result length
   * (e.g. an enrichment loop that fans out N follow-up reads).
   */
  function record(label: string, docs: number, ms = 0): void {
    spans.push({ label, docs, ms });
  }

  /**
   * Emit the trace line. `extra` adds context (orgId, cap-hit flags, …) to the
   * structured payload. Returns the payload so callers can assert on it in tests.
   */
  function end(extra: Record<string, unknown> = {}): TracePayload {
    const totalDocs = spans.reduce((sum, span) => sum + span.docs, 0);
    const payload: TracePayload = {
      trace: name,
      totalDocs,
      totalMs: Date.now() - startedAt,
      spans,
      ...extra,
    };
    console.log(`[fsgtm:trace] ${JSON.stringify(payload)}`);
    return payload;
  }

  return { track, record, end };
}
