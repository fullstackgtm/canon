"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft, CircleDot } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { ProgressChip, StageTimeline, ViewFrame } from "@/components/dashboard";
import { formatDuration as fmtDuration } from "@/lib/format-duration";

const STATUS_STYLES: Record<string, string> = {
  success: "bg-primary/15 text-primary",
  partial: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
  info: "bg-muted text-muted-foreground",
};
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

const CLI_STAGES: Record<string, readonly string[]> = {
  "enrich acquire": ["discovery", "resolution", "plan"],
  apply: ["preflight", "operations", "results"],
};

// HubSpot object-type IDs for record deep-links (contact / company / deal).
const HS_TYPE_ID: Record<string, string> = { contact: "0-1", account: "0-2", deal: "0-3" };

/** Build a source-CRM record URL from the run's deep-link base, or null. */
function recordUrl(
  crm: { provider: string; recordUrlBase: string } | undefined,
  objectType: string,
  objectId: string,
): string | null {
  if (!crm || crm.provider !== "hubspot") return null;
  const typeId = HS_TYPE_ID[objectType];
  if (!typeId) return null;
  return `${crm.recordUrlBase.replace(/\/+$/, "")}/${typeId}/${objectId}`;
}

function fmtValue(key: string, v: unknown): string {
  if (typeof v === "number" && /cost|spend|usd/i.test(key)) return `$${v.toFixed(2)}`;
  return String(v);
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export default function RunDetailPage() {
  const params = useParams();
  const runId = (Array.isArray(params.id) ? params.id[0] : params.id) as Id<"cliRuns">;
  const run = useQuery(api.cliRuns.getRun, { runId });

  return (
    <ViewFrame title={run?.command ?? "Run"} actions={[{ id: "run-back", label: "Runs", href: "/dashboard/runs", icon: <ArrowLeft className="size-3.5" /> }]}>

      {run === undefined ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : run === null ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Run not found, or not in your organization.
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_STYLES[run.status] ?? "bg-muted text-muted-foreground"
              }`}
            >
              {run.status}
            </span>
            {run.profile ? (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{run.profile}</span>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {fmtDuration(run.durationMs)} · {new Date(run.createdAt).toLocaleString()}
            </span>
          </div>

          {run.error ? (
            <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/15 p-4">
              <p className="text-xs font-semibold text-destructive">Error</p>
              <p className="mt-1 font-mono text-sm text-destructive">{run.error}</p>
            </div>
          ) : null}

          {run.status === "in_progress" ? (
            <section className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4" aria-live="polite">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-muted-foreground">
                  Live processing
                </h2>
                <ProgressChip
                  status={run.status}
                  progress={run.progress}
                  startedAt={run.startedAt}
                  verb="Running"
                />
              </div>
              <StageTimeline
                stages={CLI_STAGES[run.command] ?? (run.progress?.stage ? [run.progress.stage] : ["processing"])}
                progress={run.progress}
              />
              <p className="mt-3 font-mono text-xs text-muted-foreground">
                {run.progress?.note ?? "Waiting for the next CLI heartbeat…"}
              </p>
            </section>
          ) : null}

          {run.counts && Object.keys(run.counts as object).length > 0 ? (
            <div className="mb-6">
              <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Result</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {Object.entries(run.counts as Record<string, unknown>)
                  .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
                  .map(([k, v]) => (
                    <div key={k} className="rounded-lg border border-border bg-card p-3">
                      <div className="text-lg font-semibold">{fmtValue(k, v)}</div>
                      <div className="text-xs text-muted-foreground">{humanize(k)}</div>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          {run.findings && run.findings.length > 0 ? (
            <div className="mb-6">
              <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
                Findings ({run.findings.length})
              </h2>
              <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                    <tr className="text-left text-xs font-medium text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Severity</th>
                      <th className="px-3 py-2 font-medium">Object</th>
                      <th className="px-3 py-2 font-medium">Record ID</th>
                      <th className="px-3 py-2 font-medium">Field</th>
                      <th className="px-3 py-2 font-medium">Issue</th>
                      <th className="px-3 py-2 font-medium">Operation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...run.findings]
                      .sort(
                        (a, b) =>
                          (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
                      )
                      .map((f, i) => (
                        <tr key={i} className="border-t border-border/60">
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                                SEVERITY_STYLES[f.severity] ?? "bg-muted text-muted-foreground"
                              }`}
                            >
                              {f.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{f.objectType}</td>
                          <td className="px-3 py-2 font-mono text-xs">
                            {(() => {
                              const url = recordUrl(run.crm, f.objectType, f.objectId);
                              return url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
                                >
                                  {f.objectId}
                                </a>
                              ) : (
                                f.objectId
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                            {f.field ?? "—"}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{f.ruleId}</td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                            {f.operation ?? "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div>
            <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Events</h2>
            {run.events && run.events.length > 0 ? (
              <ol className="relative ml-2 space-y-3 border-l border-border pl-5">
                {run.events.map((e, i) => (
                  <li key={i} className="relative">
                    <CircleDot className="absolute -left-[27px] top-0.5 h-3.5 w-3.5 text-muted-foreground/60" />
                    <div className="flex items-baseline gap-2">
                      <code className="font-mono text-sm font-medium">{e.type}</code>
                      <span className="text-xs text-muted-foreground">+{Math.max(0, e.ts - run.startedAt)}ms</span>
                    </div>
                    {e.detail ? <p className="font-mono text-xs text-muted-foreground">{e.detail}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">No structured events for this run.</p>
            )}
          </div>
        </>
      )}
    </ViewFrame>
  );
}
