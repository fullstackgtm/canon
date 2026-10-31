"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { Fragment, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronRight, Pencil, Play, RefreshCw, ShieldCheck, Sparkles, Square, Trash2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EmptyState, LoadingRows, StatusBadge, ViewFrame } from "@/components/dashboard";
import { AgentOwnerLine } from "@/components/agents/agent-owner-line";
import { AiFieldDialog } from "@/components/research/ai-field-dialog";
import { RunPreviewDialog, formatUsd, type ContactScopeArg } from "@/components/research/run-preview-dialog";
import { quoteAndSource } from "@/components/research/ai-cell";
import { JevDistribution, ProbeVerdictLine } from "@/components/research/probe-verdict";
import { PiRunLive } from "@/components/research/pi-run-live";
import { isFactualField } from "../../../../convex/lib/research/agentLoop";
import { CADENCE_DAYS, REFRESH_CADENCES, estimateRun, type RefreshCadence } from "../../../../convex/lib/research/runPlan";
import { cn, getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { SelectField } from "@/components/ui/select";
import type { FactValue } from "../../../../convex/lib/canon/policy";

type Field = NonNullable<ReturnType<typeof useQuery<typeof api.researchAgents.list>>>["agents"][number];
type Run = NonNullable<Field["latestRun"]>;

/** A Jev pick: a classify option's key, or "true"/"false" for a yes/no field. */
const showPick = (choice: string, field: Field) => (field.kind === "classify" ? show(choice, field) : choice === "true" ? "Yes" : choice === "false" ? "No" : choice);

const show = (v: FactValue, field: Field) => {
  if (v === null) return "—";
  if (typeof v === "object") return v.map((s) => `${s.userId} · ${s.percentage}% ${s.kind}`).join("; ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return field.options?.find((o) => o.key === v)?.label ?? String(v);
};

export default function FieldsPage() {
  const data = useQuery(api.researchAgents.list);
  const [open, setOpen] = useState(false);
  return (
    <ViewFrame title="AI fields" actions={[{ id: "fields-new", label: "New field", onClick: () => setOpen(true), primary: true }]}>
      <AiFieldDialog open={open} onOpenChange={setOpen} />
      {data === undefined ? (
        <LoadingRows />
      ) : data.agents.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No AI fields yet"
          description="Ask a question once, answer it for every account or contact: who a company sells to, which insurers a clinic takes, what persona a buyer is."
          action={{ label: "New field", onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="overflow-x-auto border border-border">
          <table aria-label="AI fields" className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-muted/40 text-xs font-medium text-muted-foreground">
              <tr>
                {["Field", "Type", "Applies to", "Owner", "Review", "Refresh", "Latest run", "Actions"].map((label) => (
                  <th key={label} scope="col" className="px-3 py-2 font-normal">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.agents.map((f) => (
                <FieldRow key={f.id} field={f} canEditGate={data.canEditGate} canRefresh={data.canRefresh} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ViewFrame>
  );
}

function FieldRow({ field, canEditGate, canRefresh }: { field: Field; canEditGate: boolean; canRefresh: boolean }) {
  const names = useObjectLabels();
  const startRun = useMutation(api.researchAgents.startRun);
  const cancelRun = useMutation(api.researchAgents.cancelRun);
  const remove = useMutation(api.researchAgents.remove);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const [showAnswers, setShowAnswers] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const run = field.latestRun;
  const running = run?.status === "running";
  const paused = field.agent.status !== "active";

  const contacts = field.entityType === "contact";

  async function start(_slug: string, scope: ContactScopeArg | undefined, capCredits: number | undefined) {
    const cap = capCredits === undefined ? {} : { capCredits };
    try {
      const res = await startRun(contacts ? { slug: field.slug, contacts: scope, ...cap } : { slug: field.slug, filter: {}, ...cap });
      if (res.refused) toast.error(res.refused);
      else toast.success(contacts ? `Researching “${field.label}” on your contacts` : `Researching “${field.label}” on your best-fit accounts`);
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }

  return (
    <Fragment>
      <tr id={field.slug} className="border-t border-border align-top">
        <th scope="row" className="max-w-72 px-3 py-3 font-normal">
          <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((s) => !s)} className="flex items-start gap-1.5 text-left font-medium hover:text-primary">
            {expanded ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
            <span className="break-words">{field.label}<span className="mt-1 block text-xs font-normal text-muted-foreground">Details & settings</span></span>
          </button>
          {field.recipe && (
            <Link href="/dashboard/customization" className="mt-1 block pl-5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              From {field.recipe.title} · v{field.recipe.version}
            </Link>
          )}
        </th>
        <td className="px-3 py-3 text-xs">{field.kind === "classify" ? "Classify" : `Question · ${field.answerType ?? "text"}`}</td>
        <td className="px-3 py-3 text-xs">{contacts ? names("contact")!.pluralLabel : names("account")!.pluralLabel}</td>
        <td className="px-3 py-3 text-xs">
          {field.agent.owner?.name ?? "unknown"}
          <div className={cn("mt-1", paused ? "text-destructive" : "text-muted-foreground")} title={field.agent.message ?? undefined}>{field.agent.status}</div>
        </td>
        <td className="px-3 py-3 text-xs">{field.autoAcceptMinConfidence === null ? "Manual review" : `Auto-accept ≥ ${field.autoAcceptMinConfidence.toFixed(2)}`}</td>
        <td className="px-3 py-3 text-xs">
          {field.refresh.cadence === null ? "Off" : field.refresh.cadence === "weekly" ? "Weekly" : "Monthly"}
          {field.refresh.hold && <div className="mt-1 text-destructive" title={field.refresh.hold.message}>Paused</div>}
        </td>
        <td className="px-3 py-3 text-xs">
          {run ? <><StatusBadge status={run.status} /><div className="mt-1 text-muted-foreground">{run.answered} answered{run.errors > 0 && <span className="text-destructive"> · {run.errors} errors</span>}</div></> : <span className="text-muted-foreground">Not run yet</span>}
        </td>
        <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          {running ? (
            <button type="button" onClick={() => void cancelRun({ runId: run!.id as Id<"researchRuns"> })} className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs hover:border-primary">
              <Square className="size-3" /> Stop
            </button>
          ) : (
            <button type="button" disabled={paused} title={field.agent.message ?? undefined} onClick={() => setPreviewing(true)} className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
              <Play className="size-3" /> Run
            </button>
          )}
          {canRefresh && (
            <button type="button" aria-label={`Edit ${field.label}`} disabled={running} title={running ? "Stop the run to edit this field" : undefined} onClick={() => setEditing(true)} className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
              <Pencil className="size-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Delete ${field.label}`}
            onClick={() => {
              if (confirm(`Delete “${field.label}”? Answers already recorded stay in the ledger.`)) {
                void remove({ slug: field.slug }).catch((e) => toast.error(getErrorMessage(e)));
              }
            }}
            className="p-1.5 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
        {editing && <AiFieldDialog open onOpenChange={setEditing} field={field} />}
        <RunPreviewDialog target={previewing ? { slug: field.slug, label: field.label, entityType: field.entityType } : null} filter={{}} onClose={() => setPreviewing(false)} onStart={start} />
        </td>
      </tr>
      {expanded && <tr id={detailsId} className="border-t border-border bg-muted/20">
        <td colSpan={8} className="px-4 py-3">
          <code className="break-all text-[11px] text-muted-foreground">{field.attribute}</code>
          <p className="mt-1 text-sm text-muted-foreground">{field.question}</p>
          {field.options && (
            <div className="mt-2 flex flex-wrap gap-1">
              {field.options.map((o) => (
                <span key={o.key} title={o.description} className="bg-muted px-1.5 py-0.5 text-xs">{o.label}</span>
              ))}
            </div>
          )}
          <GateLine field={field} canEdit={canEditGate} />
          <AgentOwnerLine agent={field.agent} />
          <RefreshLine field={field} canEdit={canRefresh} />
          <p className="mt-2 text-xs text-muted-foreground">
            {contacts ? (
              <>Run researches up to 100 contacts that don&apos;t have an answer yet: all contacts or a saved view. To research chosen contacts,
              select them on <Link href="/dashboard/contacts" className="underline underline-offset-2">{names("contact")!.pluralLabel}</Link> and run from there.</>
            ) : (
              <>Run researches up to 100 of your best-fit accounts that don&apos;t have an answer yet. To research one segment, drill
              into it on <Link href="/dashboard/accounts" className="underline underline-offset-2">Accounts</Link> and run from there.</>
            )}
          </p>
          {run && <RunLine run={run} field={field} />}
          <button type="button" aria-expanded={showAnswers} onClick={() => setShowAnswers((s) => !s)} className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {showAnswers ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Answers
          </button>
          {showAnswers && <Answers field={field} />}
        </td>
      </tr>}
    </Fragment>
  );
}

function GateLine({ field, canEdit }: { field: Field; canEdit: boolean }) {
  const setAutoAccept = useMutation(api.researchAgents.setAutoAccept);
  const on = field.autoAcceptMinConfidence !== null;
  const set = (min: number | null) => void setAutoAccept({ slug: field.slug, minConfidence: min }).catch((e) => toast.error(getErrorMessage(e)));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ShieldCheck className="size-3.5" />
      {on ? (
        <span>
          Auto-accepts an answer when Jev scores it ≥ {field.autoAcceptMinConfidence!.toFixed(2)} (its check of a quote, or its read for an answer it inferred); the rest
          wait in <Link href="/dashboard/facts" className="underline underline-offset-2">Fact Review</Link>. Lowering this also accepts waiting answers that now clear it.
        </span>
      ) : (
        <span>Every answer waits in <Link href="/dashboard/facts" className="underline underline-offset-2">Fact Review</Link>.</span>
      )}
      {canEdit && (
        <span className="flex items-center gap-1">
          {on && (
            <SelectField
              aria-label="Auto-accept threshold"
              value={String(field.autoAcceptMinConfidence!)}
              onValueChange={(v) => set(Number(v))}
              options={[0.6, 0.7, 0.8, 0.9, 0.95].map((t) => ({ value: String(t), label: t.toFixed(2) }))}
            />
          )}
          <button type="button" onClick={() => set(on ? null : 0.8)} className="underline underline-offset-2 hover:text-foreground">
            {on ? "Review every answer" : "Turn on auto-accept"}
          </button>
        </span>
      )}
    </div>
  );
}

const dateOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Scheduled refresh: Off, Weekly or Monthly. Re-asks only answers older than the cadence, on the agent owner's plan. */
function RefreshLine({ field, canEdit }: { field: Field; canEdit: boolean }) {
  const setRefresh = useMutation(api.researchAgents.setRefresh);
  const { cadence, nextAt, hold } = field.refresh;
  const est = estimateRun({ inScope: Infinity, autoAccept: field.autoAcceptMinConfidence !== null, factual: isFactualField({ ...field, answerType: field.answerType ?? undefined }), jevReads: field.kind === "classify" || field.answerType === "boolean" });
  return (
    <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <RefreshCw className="size-3.5" />
        <span>Refresh:</span>
        {canEdit ? (
          <SelectField
            aria-label="Refresh cadence"
            value={cadence ?? "off"}
            onValueChange={(v) => void setRefresh({ slug: field.slug, cadence: v === "off" ? null : (v as RefreshCadence) }).catch((err) => toast.error(getErrorMessage(err)))}
            options={[{ value: "off", label: "Off" }, ...REFRESH_CADENCES.map((c) => ({ value: c, label: c === "weekly" ? "Weekly" : "Monthly" }))]}
          />
        ) : (
          <span>{cadence ? (cadence === "weekly" ? "Weekly" : "Monthly") : "Off"}</span>
        )}
        {cadence && !hold && nextAt && <span>next {dateOf(nextAt)}</span>}
      </div>
      {cadence && (
        <p className="pl-5">
          Re-asks answers older than {CADENCE_DAYS[cadence]} days, up to {est.cap} per refresh, on {field.agent.owner?.name ?? "the owner"}&apos;s ChatGPT plan.
          Canon pays for Jev checks ({formatUsd(est.jevUsdMax)} per refresh){est.extractionCallsMax > 0 && ` and up to ${est.extractionCallsMax} Clairic extraction requests (estimated ${formatUsd(est.extractionUsdMax)})`}.
        </p>
      )}
      {cadence && hold && (
        <p className="pl-5 text-destructive">Refresh paused: {hold.message}{nextAt ? ` Checked again ${dateOf(nextAt)}.` : ""}</p>
      )}
    </div>
  );
}

function RunLine({ run, field }: { run: Run; field: Field }) {
  const traces = useQuery(api.researchAgents.traces, { runId: run.id });
  const [open, setOpen] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const pct = run.planned ? Math.round(((run.done + run.errors) / run.planned) * 100) : 0;
  return (
    <div className="mt-3 border-t border-border pt-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <StatusBadge status={run.status} />
        {run.scheduled && <span>scheduled refresh</span>}
        {run.probe && <span>sample of {run.planned || "…"}</span>}
        {run.status === "running" && !run.scheduled && run.planned > 0 && <span>{pct}% of {run.planned}</span>}
        <span><b className="font-medium text-foreground">{run.answered}</b> answered</span>
        <span>{run.unknown} unknown</span>
        <span>{run.noEvidence} without evidence</span>
        {run.inferred > 0 && <span><b className="font-medium text-foreground">{run.inferred}</b> inferred by Jev</span>}
        {run.errors > 0 && <span className="text-destructive">{run.errors} errors</span>}
        {run.skipped > 0 && <span>{run.skipped} skipped (answered, or tried in the last 30 days)</span>}
        <span>{run.pagesRead} pages read · {run.llmCalls} model calls</span>
        {/* Research on a ChatGPT plan is free, so credits show only once a run spent some. */}
        {run.credits.spent > 0 && (
          <span>{run.credits.spent.toLocaleString()}{run.credits.cap !== null ? ` of ${run.credits.cap.toLocaleString()}` : ""} credits</span>
        )}
        {run.done + run.errors > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="underline underline-offset-2 hover:text-foreground">
            {open ? "hide records" : "how each record went"}
          </button>
        )}
        {!!run.sample?.length && (
          <button type="button" onClick={() => setSampleOpen((o) => !o)} className="underline underline-offset-2 hover:text-foreground">
            {sampleOpen ? "hide sample" : "see sample"}
          </button>
        )}
      </div>
      <RunAttributionLine attribution={runAttribution(traces)} />
      {run.runtime === "pi" && <PiRunLive runId={run.id} running={run.status === "running"} />}
      {run.verdict && <ProbeVerdictLine verdict={run.verdict} show={(v) => show(v, field)} className="mt-1" />}
      {run.verdict?.jev && <JevDistribution jev={run.verdict.jev} show={(c) => showPick(c, field)} className="mt-2" />}
      {run.error && <p className="mt-1 text-destructive">{run.error}</p>}
      {run.stop && (
        <p className={cn("mt-1", run.stop.rule === "cap" ? "text-foreground" : "text-destructive")}>
          {run.stop.rule === "failing" || run.stop.rule === "no_answers" ? `Stopped early: ${run.stop.message}` : run.stop.message}
        </p>
      )}
      {sampleOpen && run.sample && (
        <ul className="mt-2 grid gap-1.5 text-muted-foreground">
          {run.sample.map((r) => (
            <li key={r.recordId}>
              <span className="text-foreground">{r.label}</span> ·{" "}
              {!r.status ? "not yet researched"
                : r.status === "answered" ? <><b className="font-medium text-foreground">{show(r.value ?? null, field)}</b>{r.quote && <span>: “{r.quote}”</span>}</>
                : <>{r.status.replace("_", " ")}{r.value !== undefined ? ` (${show(r.value, field)})` : ""}{r.reason ? `: ${r.reason}` : ""}</>}
              {r.jev && <span> · Jev: {showPick(r.jev.choice, field)} ({r.jev.confidence.toFixed(2)}){r.inferred ? ", proposed as the answer" : ""}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && <RunRecords traces={traces} field={field} />}
    </div>
  );
}

type Trace = NonNullable<ReturnType<typeof useQuery<typeof api.researchAgents.traces>>>[number];

type RecordedModel =
  | { kind: "clairic"; navigator: string | null }
  | { kind: "research"; name: string }
  | { kind: "unrecorded" };

function recordedModel(raw: string): RecordedModel {
  if (!raw.trim()) return { kind: "unrecorded" };
  if (raw === "@cf/cloudflare/clairic") return { kind: "clairic", navigator: null };
  const match = /^@cf\/cloudflare\/clairic; navigator=([^;\r\n]+)$/.exec(raw);
  if (match && match[0] === raw && match[1].trim()) return { kind: "clairic", navigator: match[1] };
  return { kind: "research", name: raw };
}

type RunAttribution = { kind: "loading" | "unavailable" } | { kind: "recorded"; text: string };

function runAttribution(traces: readonly Trace[] | undefined): RunAttribution {
  if (traces === undefined) return { kind: "loading" };
  const models = [...new Set(traces.map((t) => t.model.trim() ? t.model : ""))].map(recordedModel);
  if (!models.length || models.every((m) => m.kind === "unrecorded")) return { kind: "unavailable" };
  const model = models[0];
  if (models.length === 1) {
    if (model.kind === "clairic") return { kind: "recorded", text: `Extraction model: Clairic${model.navigator ? ` · Navigation model: ${model.navigator}` : ""}` };
    if (model.kind === "research") return { kind: "recorded", text: `Research model: ${model.name}` };
  }
  const labels = models.map((m) => m.kind === "clairic"
    ? `Clairic (extraction${m.navigator ? `; navigation: ${m.navigator}` : ""})`
    : m.kind === "research" ? `${m.name} (research)` : "unrecorded");
  return { kind: "recorded", text: `Recorded models: ${labels.join(", ")}` };
}

function RunAttributionLine({ attribution }: { attribution: RunAttribution }) {
  return (
    <div className="mt-2 break-words text-muted-foreground">
      <p>Latest run · {attribution.kind === "recorded" ? attribution.text : attribution.kind === "loading" ? "Loading model provenance…" : "Model provenance unavailable."}</p>
      {attribution.kind === "recorded" && <p className="text-[11px]">From available record traces</p>}
      {attribution.kind === "unavailable" && <p className="text-[11px]">No record details are available; they may be missing or outside your access.</p>}
    </div>
  );
}

function traceSourceText(trace: Trace): string {
  if (trace.inferred) return trace.status === "rejected" ? "Candidate inferred by Jev" : "Answer inferred by Jev";
  const model = recordedModel(trace.model);
  if (model.kind === "clairic") return trace.status === "answered" ? "Extracted by Clairic" : "Extraction model: Clairic";
  return model.kind === "research" ? `Research model: ${model.name}` : "Model provenance unavailable";
}

/** Every record a run researched: what it came to, and on click each page, search and model choice in order. */
function RunRecords({ traces, field }: { traces: readonly Trace[] | undefined; field: Field }) {
  const [shown, setShown] = useState<string | null>(null);
  if (traces === undefined) return <LoadingRows />;
  if (!traces.length) return <p className="mt-2 text-muted-foreground">No record details are available; they may be missing or outside your access.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-muted-foreground">
      {traces.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => setShown((s) => (s === t.id ? null : t.id))} aria-expanded={shown === t.id} className="flex items-start gap-1 text-left hover:text-foreground">
            {shown === t.id ? <ChevronDown className="mt-0.5 size-3 shrink-0" /> : <ChevronRight className="mt-0.5 size-3 shrink-0" />}
            <span>
              <span className="text-foreground">{t.label}</span> · {outcomeText(t, field)}
              <span className="mt-0.5 block text-[11px]" title={t.model}>{traceSourceText(t)}</span>
            </span>
          </button>
          {shown === t.id && (
            <div className="mb-2 ml-4 mt-1 border-l border-border pl-3">
              <ol className="grid gap-0.5">
                {t.steps.map((s, i) => <li key={i} className="break-all">{stepText(s, t)}</li>)}
              </ol>
              <p className="mt-1 font-mono text-[10px]">{t.model} · prompt {t.promptVersion} · {t.calls} model call{t.calls === 1 ? "" : "s"} · {(t.ms / 1000).toFixed(1)}s</p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function outcomeText(t: Trace, field: Field): string {
  if (t.status === "rejected") return `rejected by the write gate${t.reason ? `: ${t.reason}` : ""}`;
  if (t.inferred && t.jev) return `${showPick(t.jev.choice, field)}, inferred by Jev (${t.jev.confidence.toFixed(2)})`;
  if (t.status === "answered") return `${t.value === undefined ? "—" : show(t.value, field)}${t.quote ? `: “${t.quote}”` : ""}`;
  return `${t.status.replace("_", " ")}${t.reason ? `: ${t.reason}` : ""}`;
}

function stepText(s: Trace["steps"][number], trace: Trace): string {
  if (s.kind === "search") return `Searched “${s.query}”, ${s.pages} result${s.pages === 1 ? "" : "s"} read`;
  if (s.kind === "model") {
    const clairic = recordedModel(trace.model).kind === "clairic";
    if (s.action === "answer") return clairic ? `Clairic extracted ${trace.status === "answered" && !trace.inferred ? "the answer" : "a candidate answer"}` : "Model answered";
    return `${clairic ? "Navigator" : "Model"} asked to ${s.action === "read" ? "read more pages" : "search the web"}`;
  }
  return `${s.ok ? (s.snippet ? "Search result" : "Read") : "Couldn't read"} ${s.url}`;
}

type AnswerRow = NonNullable<ReturnType<typeof useQuery<typeof api.researchAgents.answers>>>[number];

/** The field's answers on the records the viewer sees: the live query, or for a viewer who sees only some, the action that admits them (CP14). */
function useFieldAnswers(field: Field): AnswerRow[] | undefined {
  const live = useQuery(api.researchAgents.answers, { slug: field.slug, limit: 50 });
  const read = useAction(api.researchAgents.answersScoped);
  const [scoped, setScoped] = useState<{ slug: string; rows: AnswerRow[] }>();
  const refresh = field.latestRun?.updatedAt ?? 0;
  useEffect(() => {
    if (live !== null) return;
    let on = true;
    read({ slug: field.slug, limit: 50 }).then((rows) => { if (on) setScoped({ slug: field.slug, rows }); }).catch((error: unknown) => console.warn("AI answers:", error));
    return () => { on = false; };
  }, [live, field.slug, refresh, read]);
  return live === null ? (scoped?.slug === field.slug ? scoped.rows : undefined) : live;
}

function Answers({ field }: { field: Field }) {
  const rows = useFieldAnswers(field);
  if (rows === undefined) return <LoadingRows />;
  if (!rows.length) return <p className="mt-2 text-xs text-muted-foreground">No answers yet. Run the field to research accounts.</p>;
  return (
    <table className="mt-2 w-full text-sm">
      <caption className="caption-top pb-1 text-left text-xs text-muted-foreground">Answers may include earlier runs.</caption>
      <thead className="text-left text-xs font-medium text-muted-foreground">
        <tr><th className="py-1 pr-3 font-normal">{field.entityType === "contact" ? "Contact" : "Account"}</th><th className="py-1 pr-3 font-normal">Answer</th><th className="py-1 pr-3 font-normal">Status</th><th className="py-1 font-normal">Evidence</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const { quote, url } = quoteAndSource(r.evidence);
          return (
            <tr key={r.factId} className="border-t border-border align-top">
              <td className="py-2 pr-3">{r.account ?? "—"}</td>
              <td className="py-2 pr-3 font-medium">{show(r.value, field)}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={r.status} />
                {r.verification !== null && <div className="mt-0.5 text-[11px] text-muted-foreground">{r.verifiedBy === "read" ? "Inferred by Jev · confidence" : "Quote checked by Jev"} {r.verification.toFixed(2)}</div>}
              </td>
              <td className={cn("py-2 text-xs text-muted-foreground")}>
                {quote && <blockquote className="whitespace-pre-line border-l-2 pl-2">{quote}</blockquote>}
                {url && (
                  <a href={url} target="_blank" rel="noreferrer noopener" className="mt-1 block truncate underline underline-offset-2 hover:text-foreground">
                    {url}
                  </a>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
