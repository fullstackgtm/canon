"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { JobPhaseBars } from "@/components/job-phase-bars";
import { num, type Consolidation } from "./shared";

type Task = NonNullable<Consolidation["job"]>["task"];

const LEAVE_NOTE: Record<Task, string> = {
  suggest: "You can leave this page: suggestions are saved to the map when they finish, and the background tray shows progress.",
  preview: "You can leave this page: the preview is saved when it finishes, and the background tray shows progress.",
  plans: "You can leave this page: the background tray shows progress.",
  apply: "You can leave this page: the writes continue in the background, and the background tray shows progress.",
  undo: "You can leave this page: the writes continue in the background, and the background tray shows progress.",
};

const VERB: Record<Task, string> = { suggest: "Suggesting", preview: "Previewing", plans: "Creating plans", apply: "Applying", undo: "Undoing" };

const elapsed = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);

/**
 * A suggest, preview, apply or undo while it runs: its bars, what it has found so far and how long it has taken. Shown
 * from the click (`busy`) until the job finishes, including after a reload while it still runs. `inline` is one line
 * for the run bar: the verb, the counts and one bar.
 */
export function JobProgress({ c, task, busy, inline = false }: { c: Consolidation; task: Task; busy: boolean; inline?: boolean }) {
  const job = c.job?.task === task && c.job.status === "processing" ? c.job : null;
  // The job the page knew when the button was pressed: until a newer one starts, the run is starting.
  const [previous, setPrevious] = useState<number | null | undefined>(undefined);
  const latest = c.job?.startedAt ?? null;
  useEffect(() => {
    setPrevious(busy ? latest : undefined);
    // Only the press itself records the previous job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const starting = busy && previous !== undefined && latest === previous;
  const [now, setNow] = useState(() => Date.now());
  const shown = Boolean(job) || starting;
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown]);
  if (!shown) return null;
  const seconds = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : null;

  if (inline) {
    const bars = job?.phases.filter((p) => p.total !== undefined) ?? [];
    const total = bars.reduce((s, p) => s + (p.total ?? 0), 0);
    const done = bars.reduce((s, p) => s + Math.min(p.done ?? 0, p.total ?? 0), 0);
    return (
      <span className="inline-flex min-w-0 items-center gap-2" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="truncate font-medium">
          {job ? `${VERB[task]}… ${total ? `${num(done)} of ${num(total)}` : (job.detail ?? "")}` : "Starting…"}
        </span>
        {total > 0 && (
          <span role="progressbar" aria-label={VERB[task]} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="block h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        )}
        {seconds !== null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed(seconds)}</span>}
      </span>
    );
  }

  return (
    <div className="mt-3 grid max-w-xl gap-2 border border-border bg-muted/30 p-3 text-sm" role="status" aria-live="polite">
      <p className="flex items-center gap-2 font-medium">
        <Loader2 className="h-4 w-4 animate-spin" />
        {job ? (job.detail ?? "Working…") : "Starting…"}
        {seconds !== null && <span className="ml-auto text-xs font-normal tabular-nums text-muted-foreground">{elapsed(seconds)}</span>}
      </p>
      {job && <JobPhaseBars phases={job.phases} showCounts />}
      {job?.phases.filter((p) => p.total === undefined).map((p) => (
        <p key={p.key} className="text-xs text-muted-foreground">
          {p.label}{p.note ? `: ${p.note}` : p.status === "processing" ? "…" : ""}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">{LEAVE_NOTE[task]}</p>
    </div>
  );
}
