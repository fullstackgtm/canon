"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { LoadingRows, StatusBadge, ViewFrame } from "@/components/dashboard";
import { FlowSwitch } from "@/components/flow/flow-canvas";
import { RunFlow } from "@/components/research/run-flow";
import { PiRunLive } from "@/components/research/pi-run-live";
import type { Id } from "../../../../../../convex/_generated/dataModel";

export default function ResearchRunPage() {
  const params = useParams<{ id: string }>();
  const data = useQuery(api.activity.research, { runId: params.id });
  return <ViewFrame title={data?.item.title ?? "Research run"} actions={[{ id: "research-back", label: "Runs", href: "/dashboard/runs" }]}>
    {data === undefined ? <LoadingRows /> : data === null ? <p className="text-sm text-muted-foreground">Run not found, or not in your workspace.</p> : <>
      <div className="mb-4 flex items-center gap-3 text-sm"><StatusBadge status={data.item.status} /><span>{data.item.detail}</span></div>
      {data.document.runtime === "pi" && <PiRunLive runId={data.item.id as Id<"researchRuns">} running={data.item.status === "in_progress"} />}
      <dl className="my-4 flex flex-wrap gap-6 text-sm">{Object.entries(data.item.counts as Record<string, number>).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt><dd className="font-medium">{value}</dd></div>)}</dl>
      {data.item.error && <p className="mb-4 text-sm text-destructive">{data.item.error}</p>}
      <p className="mb-4 text-xs text-muted-foreground">{data.document.recordsVisible ? "Answers pass through Canon's write gates. A proposed answer still needs approval." : "Record details are visible to this run's principals and members with full record visibility."}</p>
      <FlowSwitch id="research-run" label="Run view" canvas={<RunFlow runId={data.item.id} title={data.item.title} traces={data.document.records} />} list={
      <div className="divide-y divide-border border border-border">{data.document.records.map((trace) => <details key={trace.id} className="p-3 text-sm" data-trace-id={trace.id}>
        <summary className="cursor-pointer">{trace.label} · {trace.status.replaceAll("_", " ")}{trace.value !== undefined ? ` · ${trace.value}` : ""}</summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          {trace.quote && <blockquote className="border-l-2 border-border pl-3">{trace.quote}</blockquote>}
          {trace.sourceUrl && <a href={trace.sourceUrl} target="_blank" rel="noreferrer" className="block break-all underline">{trace.sourceUrl}</a>}
          {trace.reason && <p>{trace.reason}</p>}
          <ol>{trace.steps.map((step, i) => <li key={i}>{step.kind === "read" ? `${step.ok ? "Read" : "Could not read"} ${step.url}` : step.kind === "search" ? `Searched ${step.query}` : `Model chose ${step.action}`}</li>)}</ol>
          <p className="text-xs">{trace.model} · {trace.calls} model calls · {(trace.ms / 1000).toFixed(1)}s</p>
        </div>
      </details>)}</div>} />
    </>}
  </ViewFrame>;
}
