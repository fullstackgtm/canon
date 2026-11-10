"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { FORECAST_CATEGORIES, type ForecastCategory, type Pipeline } from "../../../../convex/lib/pipelines";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { FlowCanvas, FlowRows, FlowSwitch, type FlowNode } from "@/components/flow/flow-canvas";

const CATEGORY_LABELS: Record<ForecastCategory, string> = {
  omit: "Omitted", pipeline: "Pipeline", best_case: "Best case", commit: "Commit", closed_won: "Closed won", closed_lost: "Closed lost",
};
type DraftStage = { value: string | null; label: string; probability: number; forecastCategory: ForecastCategory };
type Draft = { pipelineId: Id<"dealPipelines"> | "default" | null; name: string; stages: DraftStage[] };

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const targetOf = (p: Pipeline): Draft["pipelineId"] => (p.id ? (p.id as Id<"dealPipelines">) : "default");

const CLOSED = new Set<ForecastCategory>(["closed_won", "closed_lost"]);

/**
 * A pipeline as a flow: open stages in order, and each closed stage (won or lost) a branch off the last open one, so
 * the canvas shows where deals exit.
 */
function pipelineNodes(stages: ReadonlyArray<DraftStage>, edit?: { set: (i: number, patch: Partial<DraftStage>) => void; move: (i: number, by: number) => void }): FlowNode[] {
  const open = stages.filter((s) => !CLOSED.has(s.forecastCategory));
  const closed = stages.filter((s) => CLOSED.has(s.forecastCategory));
  const id = (s: (typeof stages)[number]) => s.value ?? `new-${stages.indexOf(s)}`;
  const node = (s: (typeof stages)[number], parent: string | undefined, row: number, action: string | undefined): FlowNode => ({
    id: id(s), parent, row, action, title: s.label || "Untitled stage", metric: `${s.probability}%`,
    tone: s.forecastCategory === "closed_won" ? "done" : s.forecastCategory === "closed_lost" ? "failed" : s.forecastCategory === "omit" ? "neutral" : "planned",
    card: <FlowRows rows={[["Forecast", CATEGORY_LABELS[s.forecastCategory]]]} />,
    detail: edit ? <StageFields stage={s} i={stages.indexOf(s)} last={stages.length - 1} edit={edit} />
      : <FlowRows rows={[["Probability", `${s.probability}%`], ["Forecast", CATEGORY_LABELS[s.forecastCategory]], ["Order", String(stages.indexOf(s) + 1)]]} />,
  });
  const last = open.at(-1);
  return [
    ...open.map((s, i) => node(s, i > 0 ? id(open[i - 1]) : undefined, 0, i > 0 ? "advance" : undefined)),
    ...closed.map((s, i) => node(s, last ? id(last) : undefined, i, last ? (s.forecastCategory === "closed_won" ? "won" : "lost") : undefined)),
  ];
}

/** One draft stage's fields, in its canvas pane. */
function StageFields({ stage, i, last, edit }: { stage: DraftStage; i: number; last: number; edit: NonNullable<Parameters<typeof pipelineNodes>[1]> }) {
  return <div className="space-y-2">
    <label className="block text-xs text-muted-foreground">Stage name
      <input aria-label="Stage name" value={stage.label} onChange={(e) => edit.set(i, { label: e.target.value })} className={`${input} mt-0.5 w-full text-foreground`} /></label>
    <label className="block text-xs text-muted-foreground">Probability %
      <input aria-label="Probability" type="number" min={0} max={100} value={stage.probability} onChange={(e) => edit.set(i, { probability: Number(e.target.value) })} className={`${input} mt-0.5 w-20 text-foreground`} /></label>
    <div className="text-xs text-muted-foreground">Forecast category
      <SelectField aria-label="Forecast category" value={stage.forecastCategory} onValueChange={(v) => edit.set(i, { forecastCategory: v as ForecastCategory })}
        options={FORECAST_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} /></div>
    <div className="flex gap-1">
      <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => edit.move(i, -1)} className={btn}><ArrowUp className="h-3 w-3" /></button>
      <button type="button" aria-label="Move later" disabled={i === last} onClick={() => edit.move(i, 1)} className={btn}><ArrowDown className="h-3 w-3" /></button>
    </div>
  </div>;
}

/** Deal pipelines: name, ordered stages, and each stage's probability and forecast category. Admins and managers. */
export function PipelinesTab() {
  const pipelines = useQuery(api.pipelines.list);
  const save = useMutation(api.pipelines.save);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  if (pipelines === undefined) return <LoadingRows count={2} height="h-24" />;
  if (pipelines === null) return null;

  const setStage = (i: number, patch: Partial<DraftStage>) =>
    setDraft((d) => d && { ...d, stages: d.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, by: number) =>
    setDraft((d) => {
      if (!d) return d;
      const stages = [...d.stages];
      [stages[i], stages[i + by]] = [stages[i + by], stages[i]];
      return { ...d, stages };
    });

  async function submit() {
    if (!draft) return;
    setBusy(true);
    try {
      await save(draft);
      setDraft(null);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const editor = draft && (
    <section className="space-y-3 border border-primary bg-card p-4">
      <input aria-label="Pipeline name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Pipeline name" className={`${input} w-64 font-medium`} />
      <FlowSwitch id="pipeline-editor" canvas={<FlowCanvas scenario={{ id: "pipeline-draft", title: draft.name || "Pipeline", nodes: pipelineNodes(draft.stages, { set: setStage, move }) }} height={340} empty="Add a stage." />} list={
      <table className="w-full text-sm">
        <thead className="text-left text-xs font-medium text-muted-foreground">
          <tr><th className="py-1">Stage</th><th className="py-1">Probability %</th><th className="py-1">Forecast category</th><th /></tr>
        </thead>
        <tbody>
          {draft.stages.map((s, i) => (
            <tr key={s.value ?? `new-${i}`}>
              <td className="py-1 pr-2"><input aria-label="Stage name" value={s.label} onChange={(e) => setStage(i, { label: e.target.value })} className={`${input} w-full`} /></td>
              <td className="py-1 pr-2"><input aria-label="Probability" type="number" min={0} max={100} value={s.probability} onChange={(e) => setStage(i, { probability: Number(e.target.value) })} className={`${input} w-20`} /></td>
              <td className="py-1 pr-2">
                <SelectField aria-label="Forecast category" value={s.forecastCategory} onValueChange={(v) => setStage(i, { forecastCategory: v as ForecastCategory })}
                  options={FORECAST_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
              </td>
              <td className="whitespace-nowrap py-1">
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className={btn}><ArrowUp className="h-3 w-3" /></button>
                <button type="button" aria-label="Move down" disabled={i === draft.stages.length - 1} onClick={() => move(i, 1)} className={btn}><ArrowDown className="h-3 w-3" /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>} />
      <div className="flex gap-2">
        <button type="button" onClick={() => setDraft({ ...draft, stages: [...draft.stages, { value: null, label: "", probability: 10, forecastCategory: "pipeline" }] })} className={btn}>Add stage</button>
        <span className="flex-1" />
        <button type="button" onClick={() => setDraft(null)} className={btn}>Cancel</button>
        <button type="button" disabled={busy} onClick={() => void submit()} className="bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40">Save</button>
      </div>
    </section>
  );

  return (
    <div className="max-w-5xl space-y-4">
      {pipelines.map((p) =>
        draft && draft.pipelineId === targetOf(p) ? <div key={p.id ?? "default"}>{editor}</div> : (
          <section key={p.id ?? "default"} className="border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-medium">{p.name}{p.isDefault && <span className="ml-2 text-xs text-muted-foreground">Default</span>}</h2>
              <button type="button" disabled={Boolean(draft)} onClick={() => setDraft({ pipelineId: targetOf(p), name: p.name, stages: p.stages.map(({ value, label, probability, forecastCategory }) => ({ value, label, probability, forecastCategory })) })} className={btn}>Edit</button>
            </div>
            <FlowSwitch id="pipelines" canvas={<FlowCanvas scenario={{ id: `pipeline-${p.id ?? "default"}`, title: p.name, nodes: pipelineNodes(p.stages) }} height={300} />} list={
              <ol className="flex flex-wrap gap-1 text-xs">
                {p.stages.map((s) => <li key={s.value} className="border border-border px-2 py-0.5">{s.label} <span className="text-muted-foreground">{s.probability}% · {CATEGORY_LABELS[s.forecastCategory]}</span></li>)}
              </ol>} />
          </section>
        ),
      )}
      {draft?.pipelineId === null ? editor : (
        <button type="button" disabled={Boolean(draft)} onClick={() => setDraft({ pipelineId: null, name: "", stages: [{ value: null, label: "", probability: 10, forecastCategory: "pipeline" }] })} className={btn}>New pipeline</button>
      )}
    </div>
  );
}
