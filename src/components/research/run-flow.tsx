"use client";

import { FlowCanvas, FlowRows, type FlowNode, type FlowTone } from "@/components/flow/flow-canvas";

type Step = { kind: "read"; url: string; ok: boolean; snippet?: boolean } | { kind: "search"; query: string; pages: number } | { kind: "model"; action: string };
type Trace = {
  id: string; label: string; status: "answered" | "unknown" | "no_evidence" | "rejected" | "error";
  value?: string | number | boolean; quote?: string; sourceUrl?: string; reason?: string; steps: Step[]; ms: number; calls: number; model: string;
};

const OUTCOME: Record<Trace["status"], { title: string; tone: FlowTone }> = {
  answered: { title: "Answered", tone: "done" },
  unknown: { title: "Unknown", tone: "neutral" },
  no_evidence: { title: "No evidence", tone: "neutral" },
  rejected: { title: "Rejected by the gate", tone: "exit" },
  error: { title: "Failed", tone: "failed" },
};

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/**
 * A research run as a flow: the run, a branch per record it researched, each branch the searches and pages it read
 * in order (the model's own choices between them left out), ending in what the record came to.
 */
export function runNodes(title: string, traces: readonly Trace[]): FlowNode[] {
  const answered = traces.filter((t) => t.status === "answered").length;
  const nodes: FlowNode[] = [{ id: "run", row: 0, title, tone: "active", metric: `${answered}/${traces.length}`,
    card: <FlowRows rows={[["Records", String(traces.length)], ["Answered", String(answered)]]} /> }];
  traces.forEach((t, row) => {
    const outcome = OUTCOME[t.status];
    nodes.push({ id: t.id, parent: "run", row, title: t.label, tone: outcome.tone, metric: `${(t.ms / 1000).toFixed(1)}s`,
      card: <FlowRows rows={[["Steps", String(t.steps.filter((s) => s.kind !== "model").length)], ["Calls", String(t.calls)]]} />,
      detail: <FlowRows rows={[["Model", t.model], ["Model calls", String(t.calls)], ["Time", `${(t.ms / 1000).toFixed(1)}s`]]} /> });
    let parent = t.id;
    t.steps.forEach((s, i) => {
      if (s.kind === "model") return;
      const id = `${t.id}:${i}`;
      nodes.push(s.kind === "search"
        ? { id, parent, row: 0, action: "search", title: s.query, tone: "done", metric: `${s.pages} pages`, card: <p className="line-clamp-2">Searched “{s.query}”</p> }
        : { id, parent, row: 0, action: "read", title: host(s.url), tone: s.ok ? "done" : "failed", metric: s.ok ? (s.snippet ? "snippet" : undefined) : "failed",
          card: <p className="truncate">{s.url}</p>,
          detail: <a href={s.url} target="_blank" rel="noreferrer" className="break-all underline">{s.url}</a> });
      parent = id;
    });
    nodes.push({ id: `${t.id}:outcome`, parent, row: 0, action: "result", title: outcome.title, tone: outcome.tone,
      metric: t.value !== undefined ? String(t.value) : undefined,
      card: <p className="line-clamp-2">{t.quote ?? t.reason ?? ""}</p>,
      detail: <div className="space-y-2">
        {t.value !== undefined && <p className="font-medium">{String(t.value)}</p>}
        {t.quote && <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">{t.quote}</blockquote>}
        {t.sourceUrl && <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="block break-all underline">{t.sourceUrl}</a>}
        {t.reason && <p className="text-muted-foreground">{t.reason}</p>}
      </div> });
  });
  return nodes;
}

/** The canvas for one research run's traces. Read only: a run is a record of what happened. */
export function RunFlow({ runId, title, traces }: { runId: string; title: string; traces: readonly Trace[] }) {
  return <FlowCanvas scenario={{ id: `research-run-${runId}`, title, nodes: runNodes(title, traces) }} height={480} outline empty="No records traced yet." />;
}
