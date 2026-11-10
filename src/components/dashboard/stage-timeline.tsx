import { cn } from "@/lib/utils";
import type { LiveProgress } from "./progress-chip";

const numberFormat = new Intl.NumberFormat();

/**
 * Compact horizontal stage checklist for an in-flight run, driven by the
 * shared stage registries (CRM_SYNC_STAGES / CALL_SYNC_STAGES — the SAME
 * stages the CLI checklist renders): done ✓ (mint), current ▸ with an items
 * counter, pending · (dim). Mono labels, Switchyard tones.
 */
export function StageTimeline({
  stages,
  progress,
  className,
}: {
  stages: readonly string[];
  progress?: LiveProgress | null;
  className?: string;
}) {
  const currentIndex =
    progress?.stageIndex !== undefined
      ? progress.stageIndex
      : progress?.stage
        ? stages.indexOf(progress.stage)
        : -1;
  const items =
    progress?.itemsDone !== undefined
      ? progress.itemsTotal !== undefined
        ? `${numberFormat.format(progress.itemsDone)}/${numberFormat.format(progress.itemsTotal)}`
        : numberFormat.format(progress.itemsDone)
      : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tracking-wide",
        className,
      )}
    >
      {stages.map((stage, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        return (
          <span
            key={stage}
            className={cn(
              "inline-flex items-center gap-1",
              done && "text-primary",
              current && "text-foreground",
              !done && !current && "text-muted-foreground/50",
            )}
          >
            <span aria-hidden className={cn(current && "text-primary")}>
              {done ? "✓" : current ? "▸" : "·"}
            </span>
            {stage}
            {current && items ? (
              <span className="text-muted-foreground">{items}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
