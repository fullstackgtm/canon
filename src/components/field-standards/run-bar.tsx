"use client";

import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { CheckCircle2, Download, Eye, Loader2, PanelRight, RotateCw, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { JobProgress } from "./job-progress";
import { runActions, useRunAction, type RunAction } from "./run-details";
import { num, primary, small, statusText, type Consolidation } from "./shared";

const compact = "px-3 py-1.5";

/**
 * One line under the diagram: where the run stands in plain words, the one action that moves it on, the CSV and the
 * details drawer. Previewing reads every record and writes nothing; applying writes exactly what the preview showed.
 */
export function RunBar({ c, onDetails }: { c: Consolidation; onDetails: () => void }) {
  const runPreview = useAction(api.fieldConsolidationActions.preview);
  const applyRun = useMutation(api.fieldConsolidations.applyRun);
  const { act, busy: acting, writing } = useRunAction(c);
  const [previewing, setPreviewing] = useState(false);
  const s = c.status;
  const run = c.run;
  const locked = previewing || writing || acting !== null || s.state === "previewing" || s.state === "applying" || s.state === "undoing";

  async function preview() {
    setPreviewing(true);
    try {
      await runPreview({ id: c._id });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function apply() {
    if (!run) return;
    const systems = [...new Set(run.sections.map((x) => (x.system === "hubspot" ? "HubSpot" : "Salesforce")))].join(" and ");
    if (!window.confirm(`Write ${num(run.writes)} changes to ${systems}? Each record is checked first: one changed since this preview is left alone. You can undo the whole run afterwards.`)) return;
    try {
      await applyRun({ id: c._id, runId: run._id });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  const previewButton = (label: string, main: boolean) => (
    <button type="button" onClick={() => void preview()} disabled={locked} className={main ? cn(primary, compact) : small}>
      {previewing ? <Loader2 className={main ? "h-4 w-4 animate-spin" : "h-3 w-3 animate-spin"} /> : <Eye className={main ? "h-4 w-4" : "h-3 w-3"} />}
      {label}
    </button>
  );
  const runButton = (kind: RunAction, label: string) =>
    run && (
      <button type="button" onClick={() => void act(run, kind)} disabled={locked} className={cn(primary, compact)}>
        {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : kind === "undo" ? <Undo2 className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
        {label}
      </button>
    );

  let progress: ReactNode = null;
  if (previewing || s.state === "previewing") progress = <JobProgress c={c} task="preview" busy={previewing} inline />;
  else if (s.state === "applying") progress = <JobProgress c={c} task="apply" busy={false} inline />;
  else if (s.state === "undoing") progress = <JobProgress c={c} task="undo" busy={false} inline />;

  const actions = run ? runActions(run) : null;
  let action: ReactNode = null;
  switch (s.state) {
    case "readyToPreview":
      action = previewButton(s.changedSince ? "Preview again" : "Preview", true);
      break;
    case "readyToApply":
      action = s.writes ? (
        <>
          {previewButton("Preview again", false)}
          <button type="button" onClick={() => void apply()} disabled={locked} className={cn(primary, compact)}>
            <CheckCircle2 className="h-4 w-4" />
            Apply {num(s.writes)} {s.writes === 1 ? "change" : "changes"}
          </button>
        </>
      ) : previewButton("Preview again", true);
      break;
    case "applied":
      action = (
        <>
          {previewButton("Preview again", false)}
          {actions?.failed ? runButton("retry", `Retry ${num(actions.failed)} failed`) : actions?.canUndo ? runButton("undo", "Undo this run") : null}
        </>
      );
      break;
    case "undone":
      action = actions?.failed ? (
        <>
          {previewButton("Preview again", false)}
          {runButton("retry", `Retry ${num(actions.failed)} failed`)}
        </>
      ) : previewButton("Preview again", true);
      break;
    case "stopped":
      action = s.during === "apply" || s.during === "undo" ? runButton("resume", "Resume") : s.during === "preview" ? previewButton("Preview again", true) : null;
      break;
  }

  const hasDetails = Boolean(run) || c.history.length > 0 || (c.plans?.length ?? 0) > 0;
  return (
    <div id="run" className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border border-border bg-card px-3 py-2 text-sm">
      <span className={cn("min-w-0 flex-1", s.state === "stopped" && "text-destructive", s.state === "readyToPreview" && s.changedSince && "text-warning")}>
        {progress ?? (s.state === "chooseStandard" ? "Define the field and choose its destinations, then preview what a run would write." : statusText(s))}
      </span>
      {run?.csvUrl && run.status !== "previewing" && (
        <a href={run.csvUrl} download={`${c.concept}-${new Date(run.createdAt).toISOString().slice(0, 10)}.csv`} className={small}>
          <Download className="h-3 w-3" />
          CSV
        </a>
      )}
      {hasDetails && (
        <button type="button" onClick={onDetails} className={small}>
          <PanelRight className="h-3 w-3" />
          Details
        </button>
      )}
      {action}
    </div>
  );
}
