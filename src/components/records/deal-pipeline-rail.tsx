import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { stageOf, stageOutcome } from "../../../convex/lib/pipelines";
import { RecordSummary } from "./record-summary";
import { cn } from "@/lib/utils";

export function DealPipelineRail({ stage, title, collapsed }: { stage: string; title: string; collapsed?: boolean }) {
  const pipelines = useQuery(api.pipelines.list);
  const current = pipelines && stageOf(pipelines, stage);
  if (!current) return null;

  const stages = current.pipeline.stages.filter((step) => step.active || step.value === stage);
  const at = stages.indexOf(current.stage);
  const lost = current.stage.forecastCategory === "closed_lost";
  const rail = (
    <ol aria-label={current.pipeline.name} className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-x-1 gap-y-3">
      {stages.map((step, index) => {
        const selected = index === at;
        const passed = index < at && !lost && !stageOutcome(step).isClosed;
        return (
          <li key={step.value} aria-current={selected ? "step" : undefined} className="min-w-0 record-step [overflow-wrap:anywhere]">
            <span aria-hidden className={cn("mb-1.5 block h-1 rounded-full", selected ? "bg-primary" : passed ? "bg-primary/50" : "bg-muted")} />
            {step.label}
          </li>
        );
      })}
    </ol>
  );
  const card = "record-panel record-panel-pad";
  return collapsed ? (
    <details className={card}>
      <RecordSummary>{title}</RecordSummary>
      {rail}
    </details>
  ) : (
    <section aria-label={title} className={card}>
      <h2 className="record-block-heading record-section-title">{title}</h2>
      {rail}
    </section>
  );
}
