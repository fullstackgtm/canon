/** A population job's progress, as the tray and the Runs tab draw it. */
export type JobPhase = {
  key: string;
  label: string;
  status: "pending" | "processing" | "completed" | "failed";
  count?: number;
  done?: number;
  total?: number;
  note?: string;
};

/** The single phase of jobs started before per-provider counters. */
export const PHASE_LABEL = "Find accounts and buyers in your market";

const PROVIDER_LABELS: Record<string, string> = {
  leadsforge: "Leadsforge people search", quickenrich: "QuickEnrich people search", accounts: "Named accounts", names: "Company names",
  icypeas: "Icypeas (paid)", prospeo: "Prospeo (paid)", crustdata: "Crustdata (paid)",
};

/**
 * The job's progress as one bar per provider: calls done of calls expected
 * (queued calls, or more when a QuickEnrich search's total says it has more
 * pages to go; a search that splits adds calls), people found, and any wait. Jobs started
 * before per-provider counters keep the single "find" phase. `final` settles
 * every bar when the job ends.
 */
export function phasesOf(c: Record<string, number>, now: number, final?: "completed" | "failed", total?: number): JobPhase[] {
  const providers = ["leadsforge", "quickenrich", "accounts", "icypeas", "prospeo", "crustdata"].filter((p) => c[`pending_${p}`] !== undefined || c[`done_${p}`] !== undefined);
  if (!providers.length) {
    // A job started before per-provider counters still counts all its calls: one bar for them.
    const bar = c.pending !== undefined ? { done: c.tasks ?? 0, total: (c.tasks ?? 0) + Math.max(0, c.pending) } : {};
    return [{ key: "find", label: PHASE_LABEL, status: final ?? "processing", count: total ?? c.people ?? 0, ...bar }];
  }
  const time = (at: number) => new Date(at).toISOString().slice(11, 16);
  const phases: JobPhase[] = providers.map((p) => {
    const done = c[`done_${p}`] ?? 0;
    const pending = c[`pending_${p}`] ?? 0;
    const expected = final ? pending : Math.max(pending, c[`expect_${p}`] ?? 0);
    const wait = c[`wait_${p}`] ?? 0;
    const failed = c[`failed_${p}`] ?? 0;
    const skipped = c[`skipped_${p}`] ?? 0;
    // Failed calls count as done (nothing more will run), so the bar can't read success from pending alone.
    const settled = failed > 0 && failed >= done ? "failed" : "completed";
    const status = final ? (pending > 0 && final === "failed" ? "failed" : settled) : pending === 0 ? settled : wait > now ? "pending" : "processing";
    return {
      key: p, label: PROVIDER_LABELS[p] ?? p, status, done, total: done + expected,
      ...(p !== "accounts" ? { count: c[`people_${p}`] ?? 0 } : {}),
      ...(status === "pending" && c.waiting_credits ? { note: "Out of credits: buy more in Settings → Billing & usage to continue" }
        : status === "pending" ? { note: `Paused by ${p} until ${time(wait)} UTC` }
        : final && c.capped ? { note: `Stopped at its credit cap ($${((c.cap_micro ?? 0) / 1e6).toFixed(2)})` }
        : final && pending > 0 && c.stoppedByUser ? { note: `Stopped: ${pending.toLocaleString("en-US")} not run` }
        : skipped ? { note: `Free allowance used up: ${skipped.toLocaleString("en-US")} skipped` }
        : failed ? { note: `${failed.toLocaleString("en-US")} ${failed === 1 ? "call" : "calls"} failed` } : {}),
    };
  });
  if (c.namesQueued) {
    const done = Math.min(c.names ?? 0, c.namesQueued);
    const running = !final && c.namesWorker === 1;
    // The name worker waits on its resolvers and marks that wait as "name lookup", not per resolver.
    const wait = c["wait_name_lookup"] ?? 0;
    const status = running ? (wait > now ? "pending" : "processing") : final === "failed" && done < c.namesQueued ? "failed" : "completed";
    phases.push({
      key: "names", label: PROVIDER_LABELS.names, status, done, total: c.namesQueued,
      ...(c.namesAbandoned ? { note: "Gave up on the rest: lookups kept failing" } : status === "pending" ? { note: `Paused by the name lookups until ${time(wait)} UTC` } : {}),
    });
  }
  return phases;
}
