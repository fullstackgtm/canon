/**
 * The run watch: after each page of a research run, decide from its counts whether it is going
 * nowhere and should stop. A record researched without an answer is skipped by later runs for 30
 * days (researchAgents.RETRY_AFTER_MS), so a run whose question doesn't work should stop early
 * rather than mark its whole scope as tried. Pure; a probe is never watched (it exists to measure).
 */

export const WATCH_RULES = ["failing", "no_answers"] as const;
export type WatchRule = (typeof WATCH_RULES)[number];
export type WatchStop = { rule: WatchRule; message: string };

/** Records that must all fail, before any is researched, to stop a run. */
export const WATCH_FAILURES = 5;
/** Records researched without a single answer that stop a run. */
export const WATCH_NO_ANSWERS = 20;

export function watchRun(c: { done: number; answered: number; inferred: number; errors: number }, lastError?: string): WatchStop | null {
  if (c.done === 0 && c.errors >= WATCH_FAILURES) {
    return { rule: "failing", message: `The first ${c.errors} records all failed${lastError ? ` (last: ${lastError})` : ""}. Fix that, then run again.` };
  }
  if (c.done >= WATCH_NO_ANSWERS && c.answered + c.inferred === 0) {
    return {
      rule: "no_answers",
      message: `${c.done} records researched and none answered, so the run stopped before marking the rest as tried for 30 days. Reword the question, or try it on a sample first.`,
    };
  }
  return null;
}
