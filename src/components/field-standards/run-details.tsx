"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useMutation } from "convex/react";
import { Loader2, RotateCw, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { COLUMN_OBJECTS, DECISION_LABEL, type DecisionKind } from "../../../convex/lib/consolidate";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { num, outcomeText, shownValue, small, statusText, type Consolidation, type PreviewSection, type Run, attributeLabel, storedText } from "./shared";

const KIND_ORDER: DecisionKind[] = ["fill", "change", "agree", "kept", "protected", "salesforceOwned", "missingOption", "noSource"];
const KIND_TONE: Partial<Record<DecisionKind, string>> = { fill: "text-primary", change: "text-warning", missingOption: "text-destructive" };

type AnyRun = Run | Consolidation["history"][number];
export type RunAction = "undo" | "resume" | "retry";

/** What a run can do next: undo what it wrote, resume a stopped apply or undo, or retry its failed writes. */
export function runActions(run: AnyRun) {
  const failed = run.status === "applied" ? (run.applied?.failed ?? 0) : run.status === "undone" ? (run.undone?.failed ?? 0) : 0;
  return {
    failed,
    canUndo: run.status === "applied" && (run.applied?.applied ?? 0) > 0,
    canResume: run.status === "failed" && (run.failedDuring === "apply" || run.failedDuring === "undo"),
  };
}

/** Undo, resume or retry a run after a confirm; `busy` names the run being started. */
export function useRunAction(c: Consolidation) {
  const applyRun = useMutation(api.fieldConsolidations.applyRun);
  const undoRun = useMutation(api.fieldConsolidations.undoRun);
  const [busy, setBusy] = useState<string | null>(null);
  const writing = c.history.some((r) => r.status === "applying" || r.status === "undoing");

  async function act(run: AnyRun, kind: RunAction) {
    const { failed } = runActions(run);
    const message = kind === "undo"
      ? `Put back the ${num(run.applied?.applied ?? 0)} values this run wrote? A record changed since is left alone.`
      : kind === "retry"
        ? `Try the ${num(failed)} failed writes again? Each record is still checked first.`
        : `Continue the ${run.failedDuring === "undo" ? "undo" : "apply"} from where it stopped?`;
    if (!window.confirm(message)) return;
    setBusy(run._id);
    try {
      if (kind === "undo" || run.failedDuring === "undo" || (kind === "retry" && run.status === "undone")) await undoRun({ id: c._id, runId: run._id });
      else await applyRun({ id: c._id, runId: run._id });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return { act, busy, writing };
}

/**
 * The run in full, in a drawer: per destination the counts, biggest changes, fills by value and samples; earlier runs
 * with their undo, retry and resume; and plans an earlier version created. `focus` scrolls to one destination.
 */
export function RunDetails({ c, open, focus, onClose }: { c: Consolidation; open: boolean; focus: string | null; onClose: () => void }) {
  const run = c.run;
  useEffect(() => {
    if (!open || !focus) return;
    const timer = setTimeout(() => document.getElementById(`run-section-${focus}`)?.scrollIntoView({ block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [open, focus]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{c.concept.charAt(0).toUpperCase() + c.concept.slice(1)}: run details</SheetTitle>
          <SheetDescription>
            {statusText(c.status)}.
            {run && run.status !== "previewing" && ` Previewed ${new Date(run.createdAt).toLocaleString()}.`}
            {run?.csvRows != null && ` The CSV lists ${num(run.csvRows)} records that don't already agree.`}
            {run?.stored && attributeLabel(c) && ` Saved in Canon as ${attributeLabel(c)}: ${storedText(run.stored)}.`}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 p-4">
          {run && run.status !== "previewing" && run.sections.map((s) => <SectionView key={s.column.key} s={s} />)}
          {(!run || run.status === "previewing") && <p className="text-sm text-muted-foreground">No finished preview yet.</p>}
          {run && (run.applied || run.undone || run.status === "failed") && (
            <DetailBlock title="This run">
              <RunRow c={c} run={run} />
            </DetailBlock>
          )}
          <History c={c} />
          <Plans c={c} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailBlock({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A run's outcome in one or two lines, with its undo, resume or retry. */
function RunRow({ c, run }: { c: Consolidation; run: AnyRun }) {
  const { act, busy, writing } = useRunAction(c);
  const { failed, canUndo, canResume } = runActions(run);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
      <div className="grid gap-0.5">
        {run.applied && <span>Applied{run.appliedAt ? ` ${new Date(run.appliedAt).toLocaleString()}` : ""}: {outcomeText(run.applied, "written")}.</span>}
        {run.undone && <span>Undo{run.undoneAt ? ` ${new Date(run.undoneAt).toLocaleString()}` : ""}: {outcomeText(run.undone, "put back")}.</span>}
        {run.status === "failed" && <span className="text-destructive">Stopped{run.failedDuring ? ` during the ${run.failedDuring}` : ""}: {run.error}</span>}
      </div>
      <span className="flex gap-1">
        {canResume && (
          <button type="button" onClick={() => void act(run, "resume")} disabled={busy !== null || writing} className={small}>
            <RotateCw className="h-3 w-3" />
            Resume
          </button>
        )}
        {failed > 0 && (
          <button type="button" onClick={() => void act(run, "retry")} disabled={busy !== null || writing} className={small}>
            <RotateCw className="h-3 w-3" />
            Retry {num(failed)} failed
          </button>
        )}
        {canUndo && (
          <button type="button" onClick={() => void act(run, "undo")} disabled={busy !== null || writing} className={small}>
            {busy === run._id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
            Undo this run
          </button>
        )}
      </span>
    </div>
  );
}

function History({ c }: { c: Consolidation }) {
  const earlier = c.history.filter((r) => r._id !== c.run?._id);
  if (!earlier.length) return null;
  return (
    <DetailBlock title="Earlier runs">
      <ul className="divide-y divide-border/60">
        {earlier.map((r) => (
          <li key={r._id} className="grid gap-1 py-2">
            <span className="text-xs text-muted-foreground">
              Previewed {new Date(r.createdAt).toLocaleString()} · {num(r.writes)} changes · {r.status}
            </span>
            <RunRow c={c} run={r} />
          </li>
        ))}
      </ul>
    </DetailBlock>
  );
}

function labeler(s: PreviewSection) {
  const labelOf = new Map(s.column.options.map((o) => [o.value, o.label]));
  return (value: string | null) => (value === null ? "" : shownValue(value, s.measure ?? "category", labelOf));
}

function SectionView({ s }: { s: PreviewSection }) {
  const [kind, setKind] = useState<DecisionKind>(s.counts.change ? "change" : "fill");
  const label = labeler(s);
  const meta = COLUMN_OBJECTS[s.object];
  const samples = s.samples.filter((r) => r.kind === kind);
  const quantity = s.measure === "quantity";
  // A quantity has no options to miss, and protects no values.
  const kinds = quantity ? KIND_ORDER.filter((k) => k !== "missingOption" && k !== "protected") : KIND_ORDER;
  return (
    <DetailBlock id={`run-section-${s.column.key}`} title={`${meta.label}: ${s.column.label}${s.mode === "shadow" ? " (shadow: shown, not written)" : ""}`}>
      <p className="mb-2 text-xs text-muted-foreground">
        {num(s.read)} records read{s.total ? ` of ${num(s.total)}` : ""}
        {s.capped && " (stopped at the read limit; apply, then preview again for the rest)"}.{" "}
        {s.mode === "shadow" ? "Shadow: these are the differences only; nothing is written." : `Writes go to ${meta.system === "hubspot" ? "HubSpot" : "Salesforce"}.`}
        {s.counts.salesforceOwned > 0 && ` ${num(s.counts.salesforceOwned)} linked to Salesforce: fixed there and synced here.`}
      </p>
      <dl className="mb-3 grid grid-cols-4 gap-1">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            title={DECISION_LABEL[k]}
            className={cn("min-w-0 border px-1.5 py-1 text-left", kind === k ? "border-primary" : "border-border hover:bg-muted/50")}
          >
            <dt className="truncate text-[10px] text-muted-foreground">{DECISION_LABEL[k]}</dt>
            <dd className={cn("text-sm font-medium tabular-nums", KIND_TONE[k])}>{num(s.counts[k])}</dd>
          </button>
        ))}
      </dl>
      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <h4 className="mb-1 font-medium text-muted-foreground">{quantity ? "Largest changes" : "Biggest changes"}</h4>
          {s.changes.length === 0 ? (
            <p className="text-muted-foreground">None{s.counts.kept ? `: ${num(s.counts.kept)} disagreeing values kept (blanks only)` : ""}.</p>
          ) : (
            <ul>
              {s.changes.slice(0, 8).map((ch, i) => (
                <li key={`${ch.from}>${ch.to}>${i}`} className="flex justify-between gap-2 border-b border-border/60 py-0.5">
                  <span className="truncate">
                    {label(ch.from)} → <span className="font-medium">{label(ch.to)}</span>
                  </span>
                  {!quantity && <span className="tabular-nums">{num(ch.count)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-1 font-medium text-muted-foreground">{quantity ? "Fills by size" : "Fills by value"}</h4>
          {s.fills.length === 0 ? (
            <p className="text-muted-foreground">No blanks to fill.</p>
          ) : (
            <ul>
              {s.fills.slice(0, 8).map((f) => (
                <li key={f.to} className="flex justify-between gap-2 border-b border-border/60 py-0.5">
                  <span className="truncate">{label(f.to)}</span>
                  <span className="tabular-nums">{num(f.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h4 className="mb-1 mt-3 text-xs font-medium text-muted-foreground">Sample: {DECISION_LABEL[kind]}</h4>
      {samples.length === 0 ? (
        <p className="text-xs text-muted-foreground">No samples for this outcome.</p>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="w-[30%] py-1 pr-2 font-medium">Record</th>
              <th className="py-1 pr-2 font-medium">Now</th>
              <th className="py-1 pr-2 font-medium">Proposed</th>
              <th className="w-[34%] py-1 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((r) => (
              <tr key={r.id} className="border-b border-border/60 align-top">
                <td className="truncate py-1 pr-2" title={r.id}>{r.name ?? r.id}</td>
                <td className="truncate py-1 pr-2">{label(r.current) || <span className="text-muted-foreground">blank</span>}</td>
                <td className="truncate py-1 pr-2 font-medium">{label(r.proposed) || "—"}</td>
                <td className="py-1">
                  {r.column ? (
                    <>
                      {quantity && r.raw?.includes(": ") ? r.raw : <>{r.column}: &quot;{r.raw}&quot;</>}
                      {r.confidence !== null && r.confidence < 1 && <span className="ml-1 text-muted-foreground">({Math.round(r.confidence * 100)}%)</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailBlock>
  );
}

/** Patch plans an earlier version of this page created, before runs applied as one unit. */
function Plans({ c }: { c: Consolidation }) {
  const undo = useAction(api.fieldConsolidationActions.createUndoPlan);
  const [busy, setBusy] = useState<string | null>(null);
  if (!c.plans?.length) return null;

  async function undoPlan(patchPlanId: Id<"patchPlans">) {
    if (!window.confirm("Create a plan that puts back every value this plan wrote? It needs approval like any plan.")) return;
    setBusy(patchPlanId);
    try {
      const result = await undo({ id: c._id, patchPlanId });
      toast.success(`Undo plan created with ${num(result.operations)} writes. Review it on the patch plans page.`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DetailBlock title="Plans from an earlier version">
      <p className="mb-1 text-xs text-muted-foreground">Approve and apply each on the patch plans page. Undo creates a reverse plan.</p>
      <ul className="divide-y divide-border/60 text-xs">
        {c.plans.map((p) => (
          <li key={p.patchPlanId} className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span>
              {p.kind === "undo" ? "Undo" : "Fill and fix"} · {p.provider === "hubspot" ? "HubSpot" : "Salesforce"} · {num(p.operations)} writes ·{" "}
              {new Date(p.createdAt).toLocaleDateString()}
            </span>
            <span className="flex gap-1">
              <Link href={`/dashboard/patch-plans?plan=${p.patchPlanId}`} className={small}>
                Review
              </Link>
              {p.kind === "apply" && (
                <button type="button" onClick={() => void undoPlan(p.patchPlanId)} disabled={busy !== null} className={small}>
                  {busy === p.patchPlanId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                  Undo
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </DetailBlock>
  );
}
