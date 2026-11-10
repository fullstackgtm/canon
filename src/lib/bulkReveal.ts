/** Bulk "Find emails": the cost preview, and a run that stops at the monthly paid-hit allowance. */

export type RevealTarget = { id: string; accountId: string; email?: string | null; emailStatus?: string | null };

/** The outcome of one lookup, as `records.findEmail` returns it. */
export type RevealOutcome =
  | { status: "found" | "not_found" | "already_has_email"; paid?: boolean }
  | { status: "limit_reached"; message?: string };

export type RevealPreview = {
  selected: number;
  /** Contacts the run will look up. */
  lookups: RevealTarget[];
  alreadyHaveEmail: number;
  /** Looked up before and not found: skipped so a repeat run does not pay twice. */
  recentlyLookedUp: number;
  /** The most paid hits the run can use: free routes go first, so it is often fewer. */
  maxPaidHits: number;
  remainingAllowance: number;
  /** Contacts the allowance cannot cover if every lookup needed a paid hit. */
  overAllowance: number;
};

export function previewReveal(selected: RevealTarget[], remainingAllowance: number): RevealPreview {
  const alreadyHaveEmail = selected.filter((c) => c.email).length;
  const recentlyLookedUp = selected.filter((c) => !c.email && c.emailStatus).length;
  const lookups = selected.filter((c) => !c.email && !c.emailStatus);
  return {
    selected: selected.length,
    lookups,
    alreadyHaveEmail,
    recentlyLookedUp,
    maxPaidHits: Math.min(lookups.length, remainingAllowance),
    remainingAllowance,
    overAllowance: Math.max(0, lookups.length - remainingAllowance),
  };
}

export type RevealReport = {
  found: number;
  notFound: number;
  /** Not looked up: the allowance or a daily limit was reached, or the contact already had an email. */
  skipped: number;
  failed: number;
  paidHits: number;
  stoppedBy: "allowance" | "limit" | null;
};

/**
 * Looks up `targets` with at most `concurrency` calls in flight. A new lookup
 * starts only while paid hits used plus lookups in flight stay under
 * `allowance`: any in-flight call might turn out to be a paid hit, so the run
 * can never spend more than the allowance, and it slows to one call at a time
 * as it nears it. Once a call reports a limit, or the allowance is spent, the
 * rest are skipped.
 */
export async function runReveal(
  targets: RevealTarget[],
  opts: { allowance: number; concurrency: number; find: (target: RevealTarget) => Promise<RevealOutcome>; onProgress?: (done: number, total: number) => void },
): Promise<RevealReport> {
  const report: RevealReport = { found: 0, notFound: 0, skipped: 0, failed: 0, paidHits: 0, stoppedBy: null };
  let next = 0;
  let inFlight = 0;
  let done = 0;
  const tick = () => opts.onProgress?.(++done, targets.length);

  async function worker() {
    while (next < targets.length && report.stoppedBy === null) {
      if (report.paidHits + inFlight >= opts.allowance) {
        if (inFlight === 0) {
          report.stoppedBy = "allowance";
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const target = targets[next++];
      inFlight += 1;
      try {
        const outcome = await opts.find(target);
        if (outcome.status === "found") report.found += 1;
        else if (outcome.status === "not_found") report.notFound += 1;
        else report.skipped += 1;
        if (outcome.status === "limit_reached") report.stoppedBy = "limit";
        else if (outcome.paid) report.paidHits += 1;
      } catch {
        report.failed += 1;
      } finally {
        inFlight -= 1;
        tick();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  report.skipped += targets.length - next;
  return report;
}
