"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { Terminal } from "lucide-react";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ProgressChip, ViewFrame } from "@/components/dashboard";
import { RunChart } from "@/components/run-chart";
import type { RunInterval } from "@/lib/run-chart";
import { JobPhaseBars } from "@/components/job-phase-bars";
import { cn, getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { formatDuration as fmtDuration } from "@/lib/format-duration";
import { SelectField } from "@/components/ui/select";

// success-shaped → mint; intermediary → amber; failure-shaped → red.
const STATUS_STYLES: Record<string, string> = {
  success: "bg-primary/15 text-primary",
  applied: "bg-primary/15 text-primary",
  partial: "bg-warning/15 text-warning",
  in_progress: "bg-warning/15 text-warning",
  previewed: "bg-warning/15 text-warning",
  approved: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  failed: "bg-destructive/15 text-destructive",
  rejected: "bg-destructive/15 text-destructive",
};

const KIND_LABELS: Record<Exclude<KindFilter, "all">, string> = {
  cli: "CLI",
  evidence: "Evidence",
  lead: "Lead preview",
  sync: "Sync",
  plan: "Plan",
  health: "Health",
  records: "Records",
  research: "Research",
};

type KindFilter = "all" | "cli" | "evidence" | "lead" | "sync" | "plan" | "health" | "records" | "research";

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const RESULT_COLUMNS = ["Calls", "Companies", "People", "Signals"] as const;
const RESULT_PHASES: Record<string, readonly string[]> = {
  people: ["find", "leadsforge", "quickenrich", "icypeas", "prospeo", "crustdata"],
  accounts: ["accounts"],
  companyNames: ["names"],
};

function fmtCounts(counts: unknown, kind: KindFilter) {
  const columns: Record<string, string> = {
    calls: "Calls",
    accounts: "Companies",
    companies: "Companies",
    companyNames: "Companies",
    contacts: "People",
    people: "People",
    signals: "Signals",
    ...(kind === "evidence" ? { fresh: "Signals", retained: "Signals" } : {}),
  };
  if (!counts || typeof counts !== "object") return [];
  return Object.entries(counts as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== "object")
    .map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
      const value =
        typeof v === "number" && /cost|spend|usd/i.test(k)
          ? `$${v.toFixed(2)}`
          : typeof v === "number" ? v.toLocaleString("en-US") : String(v);
      return { key: k, label, value, column: columns[k] };
    });
}

function useRunHistory(source: "artifacts" | "cli" | "sync" | "audit" | "health" | "jobs" | "research") {
  const history = usePaginatedQuery(api.activity.feed, { source }, { initialNumItems: 50 });
  const { status, loadMore } = history;
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(50);
  }, [status, loadMore]);
  return history;
}

export default function RunsPage() {
  const artifacts = useRunHistory("artifacts");
  const cli = useRunHistory("cli");
  const sync = useRunHistory("sync");
  const audit = useRunHistory("audit");
  const health = useRunHistory("health");
  const jobs = useRunHistory("jobs");
  const research = useRunHistory("research");
  const loadingHistory = [artifacts, cli, sync, audit, health, jobs, research].some((history) => history.status !== "Exhausted");
  const feed = useMemo(() => [...artifacts.results, ...cli.results, ...sync.results, ...audit.results, ...health.results, ...jobs.results, ...research.results]
    .sort((a, b) => b.at - a.at), [artifacts.results, cli.results, sync.results, audit.results, health.results, jobs.results, research.results]);
  const stopPopulation = useMutation(api.populateActions.stop);
  const [kind, setKind] = useState<KindFilter>("all");
  const [interval, setInterval] = useState<RunInterval>("daily");
  const [page, setPage] = useState(0);
  const [dateRange, setDateRange] = useState("all");
  const [since, setSince] = useState(-Infinity);

  const rows = useMemo(() => {
    return (feed ?? []).filter((item) =>
      (kind === "all" || item.kind === kind) && item.at >= since,
    );
  }, [feed, kind, since]);

  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(currentPage * 25, (currentPage + 1) * 25);

  return (
    <ViewFrame
      title="Runs"
      controls={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1">
            {(["all", "research", "records", "evidence", "lead", "sync", "plan", "health", "cli"] as KindFilter[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => { setKind(item); setPage(0); }}
                aria-pressed={kind === item}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium",
                  kind === item
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {item === "all" ? "All" : KIND_LABELS[item]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">Group by{" "}
              <SelectField aria-label="Group runs by" value={interval} onValueChange={(v) => setInterval(v as RunInterval)}
                options={[
                  { value: "hourly", label: "Hourly" },
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "monthly", label: "Monthly" },
                ]} />
            </label>
            <label className="text-sm">Date range{" "}
              <SelectField aria-label="Run date range" value={dateRange}
                onValueChange={(value) => {
                  setDateRange(value);
                  setSince(value === "all" ? -Infinity : Date.now() - Number(value) * 86_400_000);
                  setPage(0);
                }}
                options={[
                  { value: "all", label: "All activity" },
                  { value: "7", label: "Last 7 days" },
                  { value: "30", label: "Last 30 days" },
                  { value: "90", label: "Last 90 days" },
                ]} />
            </label>
          </div>
        </div>
      }
    >
      <p className="mb-4 text-xs text-muted-foreground">{loadingHistory ? "Loading run history… Chart and totals are partial until loading finishes." : "All recorded activity. Date and type filters apply to the chart and table."}</p>

      {rows.length > 0 && <RunChart rows={rows} interval={interval} labels={KIND_LABELS} />}

      {loadingHistory && rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Loading activity…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <Terminal className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm font-medium">{dateRange === "all" ? "No activity yet" : "No activity in this date range"}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {dateRange !== "all" ? "Try a wider date range or another type filter." : <>Run an agent or a health check, sync a connected CRM, or pair a CLI (
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">fullstackgtm login --via &lt;this app&gt;</code>
            ) — everything shows up here.</>}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">What ran</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                {RESULT_COLUMNS.map((column) => (
                  <th key={column} className="px-4 py-2.5 font-medium">{column}</th>
                ))}
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((item) => {
                const metrics = fmtCounts(item.counts, item.kind);
                const livePhases = item.status === "in_progress"
                  ? item.phases?.filter((p) => p.total !== undefined) ?? []
                  : [];
                const processingPhases = livePhases.filter((p) => p.status === "processing");
                for (const [key, phaseKeys] of Object.entries(RESULT_PHASES)) {
                  const phases = livePhases.filter((p) => phaseKeys.includes(p.key));
                  if (!phases.length) continue;
                  const value = `${phases.reduce((sum, p) => sum + (p.done ?? 0), 0).toLocaleString("en-US")}/${phases.reduce((sum, p) => sum + (p.total ?? 0), 0).toLocaleString("en-US")}`;
                  const metric = metrics.find((m) => m.key === key);
                  if (metric) metric.value = value;
                  else metrics.push(...fmtCounts({ [key]: value }, item.kind));
                }
                return (
                  <tr key={item.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3 align-top">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {KIND_LABELS[item.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="font-mono text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {item.title}
                        </Link>
                      ) : (
                        <span className="font-mono text-[13px] font-medium">{item.title}</span>
                      )}
                      {item.detail && !item.phases?.some((p) => p.total !== undefined) ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {item.detail}
                        </span>
                      ) : null}
                      {metrics.some((m) => !m.column) ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {metrics.filter((m) => !m.column).map((m) => `${m.value} ${m.label}`).join(" · ")}
                        </div>
                      ) : null}
                      {item.error ? (
                        <p className="mt-1 max-w-md truncate text-xs text-destructive" title={item.error}>
                          {item.error}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {processingPhases.length ? (
                        <JobPhaseBars phases={processingPhases} showCounts={false} className="min-w-40 max-w-xs" />
                      ) : item.status === "in_progress" &&
                      (item.kind === "sync" || item.kind === "cli") ? (
                        <ProgressChip
                          status={item.status}
                          progress={item.progress}
                          startedAt={item.startedAt}
                          verb={item.kind === "cli" ? "Running" : "Syncing"}
                        />
                      ) : (
                        <span
                          className={`inline-flex whitespace-nowrap items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            STATUS_STYLES[item.status] ?? "bg-muted text-muted-foreground"
                          }`}
                        >
                          {item.status.replace(/_/g, " ")}
                        </span>
                      )}
                      {item.stoppable ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm("Stop this run? Searches not yet run are cancelled; records already added stay.")) return;
                            stopPopulation({ jobId: item.id as Id<"backgroundJobs"> }).catch((cause) => void toast.error(getErrorMessage(cause)));
                          }}
                          className="mt-1.5 block text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                        >
                          Stop
                        </button>
                      ) : null}
                    </td>
                    {RESULT_COLUMNS.map((column) => (
                      <td key={column} className="px-4 py-3 align-top">
                        {!metrics.some((m) => m.column === column) ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {metrics.filter((m) => m.column === column).map((m) => (
                              <span
                                key={m.label}
                                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                              >
                                <span className="font-medium text-foreground">{m.value}</span>
                                {metrics.filter((metric) => metric.column === column).length > 1 ? m.label : null}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      {item.durationMs !== undefined ? fmtDuration(item.durationMs) : "—"}
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground" title={new Date(item.at).toLocaleString()}>
                      {timeAgo(item.at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <nav aria-label="Run pages" className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40">Previous</button>
            <span>{currentPage * 25 + 1}–{Math.min((currentPage + 1) * 25, rows.length)} of {rows.length} · Page {currentPage + 1} of {pageCount}</span>
            <button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40">Next</button>
          </nav>
        </div>
      )}
    </ViewFrame>
  );
}
