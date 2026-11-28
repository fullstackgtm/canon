import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { dealStagePath } from "./deal-stage-path";
import { RecordSummary } from "./record-summary";
import { cn } from "@/lib/utils";

export function DealPipelineRail({ stage, title, collapsed }: { stage: string; title: string; collapsed?: boolean }) {
  const pipelines = useQuery(api.pipelines.list);
  if (!pipelines) return null;

  const { pipelineName, steps } = dealStagePath(pipelines, stage);
  if (!steps.length) return null;
  const rail = (
    <ol aria-label={pipelineName} className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-x-1 gap-y-3">
      {steps.map((step) => (
        <li key={step.value} aria-current={step.selected ? "step" : undefined} className="min-w-0 record-step [overflow-wrap:anywhere]">
          <span aria-hidden className={cn("mb-1.5 block h-1 rounded-full", step.lost ? "bg-destructive" : step.selected ? "bg-primary" : step.passed ? "bg-primary/50" : "bg-muted")} />
          {step.label}
          {step.note && <span className="record-meta block text-muted-foreground">{step.note}</span>}
        </li>
      ))}
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
