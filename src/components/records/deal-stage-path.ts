import { stageOf, stageOutcome, type Pipeline } from "../../../convex/lib/pipelines.ts";

type StageStep = {
  value: string;
  label: string;
  active: boolean;
  selected: boolean;
  passed: boolean;
  lost: boolean;
  note?: string;
};

export function dealStagePath(pipelines: readonly Pipeline[], value?: string) {
  const current = value === undefined ? null : stageOf(pipelines, value);
  const pipeline = current?.pipeline ?? pipelines.find((p) => p.isDefault);
  const stages = pipeline?.stages ?? [];
  const open: StageStep[] = [];
  const closed: StageStep[] = [];
  const showsProgress = current?.stage.active && !stageOutcome(current.stage).isClosed;
  const currentIndex = current ? stages.indexOf(current.stage) : -1;

  for (const [index, stage] of stages.entries()) {
    const selected = stage.value === value;
    if (!stage.active && !selected) continue;

    const outcome = stageOutcome(stage);
    const step = {
      value: stage.value,
      label: stage.label,
      active: stage.active,
      selected,
      passed: Boolean(showsProgress && index < currentIndex && !outcome.isClosed),
      lost: selected && outcome.forecastCategory === "closed_lost",
      note: stage.active ? undefined : "Inactive",
    };
    (outcome.isClosed ? closed : open).push(step);
  }

  if (value && !current) {
    open.push({ value, label: value, active: false, selected: true, passed: false, lost: false, note: "Not in this pipeline" });
  }
  return { pipelineName: pipeline?.name, steps: [...open, ...closed] };
}
