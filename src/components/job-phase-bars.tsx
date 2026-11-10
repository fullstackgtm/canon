import { cn } from "@/lib/utils";
import type { BackgroundActivityEntry } from "@/lib/background-activity";

type Phase = NonNullable<BackgroundActivityEntry["phases"]>[number];

const fmt = (n: number) => n.toLocaleString("en-US");

/** One bar per phase that reports done/total (e.g. one per provider in a population). */
export function JobPhaseBars({ phases, className, showCounts = true }: { phases: Phase[]; className?: string; showCounts?: boolean }) {
  const bars = phases.filter((p) => p.total !== undefined);
  if (!bars.length) return null;
  return (
    <span className={cn("grid gap-2", className)}>
      {bars.map((phase) => {
        const total = phase.total ?? 0;
        const done = Math.min(phase.done ?? 0, total);
        const pct = total > 0 ? Math.round((done / total) * 100) : phase.status === "completed" ? 100 : 0;
        return (
          <span key={phase.key} className="grid gap-1 text-[11px]">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate text-muted-foreground", phase.status === "processing" && "font-medium text-foreground", phase.status === "failed" && "text-destructive")}>
                {phase.label}
              </span>
              {showCounts && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {phase.count !== undefined && `${fmt(phase.count)} people · `}
                {fmt(done)}/{fmt(total)}
              </span>}
            </span>
            <span
              role="progressbar"
              aria-label={phase.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="block h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-500",
                  phase.status === "failed" ? "bg-destructive" : phase.status === "pending" ? "bg-warning" : phase.status === "completed" ? "bg-emerald-500" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </span>
            {phase.note && <span className={cn("text-muted-foreground", phase.status === "pending" && "text-warning")}>{phase.note}</span>}
          </span>
        );
      })}
    </span>
  );
}
