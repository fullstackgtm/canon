"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cn, getErrorMessage } from "@/lib/utils";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import { ArrowLeft, ChevronDown, ChevronRight, Radar, ScanSearch } from "lucide-react";

/**
 * One market map: competitor capture status, evidence-verified classification
 * readings (verbatim quotes), and the per-run derived views (fronts, axes)
 * persisted by convex/marketActions.ts.
 */

type Detail = NonNullable<FunctionReturnType<typeof api.market.get>>;
type RunRow = Detail["runs"][number];

const FRONT_CLASSES: Record<string, string> = {
  owned: "bg-primary/15 text-primary",
  contested: "bg-warning/15 text-warning",
  saturated: "bg-destructive/15 text-destructive",
  open: "border border-primary/40 text-primary",
  vacant: "bg-muted text-muted-foreground",
};

const INTENSITY_CLASSES: Record<string, string> = {
  loud: "bg-primary/15 text-primary",
  quiet: "bg-warning/15 text-warning",
  absent: "bg-muted text-muted-foreground",
  unobservable: "border border-border text-muted-foreground",
};

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {label}
    </span>
  );
}

function RunProgress({ run }: { run: RunRow }) {
  const progress = run.progress;
  return (
    <div className="mb-6 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-primary">
          {run.kind} run in progress
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{run.runLabel}</span>
      </div>
      {progress && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          {progress.stage && (
            <span>
              stage {String((progress.stageIndex ?? 0) + 1)}/{String(progress.stageCount ?? "?")} ·{" "}
              <span className="text-foreground">{progress.stage}</span>
            </span>
          )}
          {progress.itemsDone !== undefined && (
            <span>
              {progress.itemsDone}
              {progress.itemsTotal !== undefined ? `/${progress.itemsTotal}` : ""} items
            </span>
          )}
          {progress.note && <span className="truncate">{progress.note}</span>}
        </div>
      )}
    </div>
  );
}

export function MapDetail({ mapId, onBack }: { mapId: Id<"marketMaps">; onBack: () => void }) {
  const detail = useQuery(api.market.get, { mapId });
  const runCapture = useAction(api.marketActions.runCapture);
  const runClassify = useAction(api.marketActions.runClassify);

  const [busy, setBusy] = useState<"capture" | "classify" | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function handleRun(kind: "capture" | "classify") {
    if (busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === "capture") {
        const result = await runCapture({ mapId });
        setNotice({
          kind: "success",
          message: `Captured ${result.pages} page(s)${result.failed > 0 ? ` — ${result.failed} failed/empty` : ""} (${result.runLabel}).`,
        });
      } else {
        const result = await runClassify({ mapId });
        if ("skipped" in result) {
          setNotice({ kind: "error", message: `Classify skipped: ${result.skipped}` });
        } else {
          setNotice({
            kind: "success",
            message: `${result.observations} verified observation(s) via ${result.model}${result.taxonomyProposed ? " — claim taxonomy proposed and saved to the map" : ""}.`,
          });
        }
      }
    } catch (error) {
      setNotice({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  if (detail === undefined) {
    return (
      <ViewFrame title="Market Map">
        <LoadingRows count={6} />
      </ViewFrame>
    );
  }
  if (detail === null) {
    return (
      <ViewFrame title="Market Map" actions={[{ id: "market-back", label: "All maps", onClick: onBack, icon: <ArrowLeft className="size-3.5" /> }]}>
        <p className="mt-6 text-sm text-muted-foreground">Map not found.</p>
      </ViewFrame>
    );
  }

  const { map, captures, classifications, runs } = detail;
  const activeRun = runs.find((run) => run.status === "in_progress");
  const latestClassifyRun = runs.find((run) => run.kind === "classify" && run.status === "success");
  const fronts = latestClassifyRun?.fronts ?? [];
  const axes = latestClassifyRun?.axes as
    | {
        pc1?: { loadings?: Array<{ claimId: string; loading: number }>; scores?: Array<{ vendorId: string; score: number }> };
        pc2?: { loadings?: Array<{ claimId: string; loading: number }>; scores?: Array<{ vendorId: string; score: number }> };
      }
    | undefined;

  const capturesByDomain = new Map<string, typeof captures>();
  for (const capture of captures) {
    const bucket = capturesByDomain.get(capture.competitorDomain) ?? [];
    bucket.push(capture);
    capturesByDomain.set(capture.competitorDomain, bucket);
  }
  const classificationByDomain = new Map(
    classifications.map((row) => [row.competitorDomain, row]),
  );

  return (
    <ViewFrame title={map.name}
      description={`${map.category} · ${map.competitors.length} competitors · ${map.claims?.length ?? 0} claims${map.lastCaptureAt ? ` · captured ${new Date(map.lastCaptureAt).toLocaleString()}` : ""}`}
      actions={[
        { id: "market-back", label: "All maps", onClick: onBack, icon: <ArrowLeft className="size-3.5" /> },
        { id: "market-capture", label: busy === "capture" ? "Capturing…" : "Run capture", onClick: () => void handleRun("capture"), disabled: busy !== null || activeRun !== undefined, icon: <ScanSearch className="size-3.5" /> },
        { id: "market-classify", label: busy === "classify" ? "Classifying…" : "Run classify", onClick: () => void handleRun("classify"), disabled: busy !== null || activeRun !== undefined || !map.lastCaptureRunLabel, icon: <Radar className="size-3.5" />, primary: true },
      ]}>

      {notice && (
        <div
          className={cn(
            "mb-6 rounded-lg border px-4 py-3 text-sm",
            notice.kind === "success"
              ? "border-primary/40 bg-primary/15 text-primary"
              : "border-destructive/40 bg-destructive/15 text-destructive",
          )}
        >
          {notice.message}
        </div>
      )}

      {activeRun && <RunProgress run={activeRun} />}

      {/* Fronts — the derived claim states from the latest classify run. */}
      {fronts.length > 0 && (
        <div className="mb-8">
          <p className="eyebrow text-muted-foreground mb-3">
            Fronts · {latestClassifyRun?.runLabel}
          </p>
          <div className="flex flex-wrap gap-2">
            {fronts.map((front) => (
              <div
                key={front.claimId}
                className="flex items-center gap-2 border border-border/70 bg-card px-2.5 py-1.5"
              >
                <Badge label={front.state} className={FRONT_CLASSES[front.state] ?? "bg-muted text-muted-foreground"} />
                <span className="font-mono text-xs">{front.claimId}</span>
                {front.state === "owned" && front.loudVendorIds[0] && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    → {front.loudVendorIds[0]}
                  </span>
                )}
              </div>
            ))}
          </div>
          {(latestClassifyRun?.frontDrift?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-0.5">
              {latestClassifyRun!.frontDrift!.map((drift) => (
                <p key={drift.claimId} className="font-mono text-xs text-warning">
                  CHANGED {drift.claimId}: {drift.before} → {drift.after}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Competitors: capture status + classification readings w/ verbatim evidence. */}
      <p className="eyebrow text-muted-foreground mb-3">Competitors</p>
      <div className="mb-8 divide-y divide-border/70 border-t border-border/70">
        {map.competitors.map((competitor) => {
          const pages = capturesByDomain.get(competitor.domain) ?? [];
          const captured = pages.filter((page) => page.captureHash);
          const row = classificationByDomain.get(competitor.domain);
          const loud = row?.readings.filter((r) => r.intensity === "loud").length ?? 0;
          const quiet = row?.readings.filter((r) => r.intensity === "quiet").length ?? 0;
          const isOpen = expanded === competitor.domain;
          return (
            <div key={competitor.domain} className="py-3">
              <button
                onClick={() => setExpanded(isOpen ? null : competitor.domain)}
                className="flex w-full items-center justify-between gap-4 text-left"
                disabled={!row}
              >
                <div className="flex min-w-0 items-center gap-3">
                  {row ? (
                    isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  <span className="font-medium">{competitor.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {competitor.domain}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-4 font-mono text-xs text-muted-foreground">
                  <span>
                    {pages.length === 0
                      ? "not captured"
                      : `${captured.length}/${pages.length} pages`}
                  </span>
                  {pages[0] && <span>{new Date(pages[0].capturedAt).toLocaleDateString()}</span>}
                  {row && (
                    <span>
                      <span className="text-primary">{loud} loud</span> ·{" "}
                      <span className="text-warning">{quiet} quiet</span>
                    </span>
                  )}
                </div>
              </button>

              {isOpen && row && (
                <div className="mt-3 space-y-3 pl-7">
                  {row.readings.map((reading) => (
                    <div key={reading.claimId}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          label={reading.intensity}
                          className={INTENSITY_CLASSES[reading.intensity] ?? "bg-muted text-muted-foreground"}
                        />
                        <span className="font-mono text-xs">{reading.claimId}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {reading.confidence}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{reading.reason}</p>
                      {reading.evidence.map((item, index) => (
                        <blockquote
                          key={index}
                          className="mt-1.5 border-l-2 border-primary/40 pl-3"
                        >
                          <p className="font-mono text-xs">&ldquo;{item.quote}&rdquo;</p>
                          <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                            <span className="truncate">{item.url}</span>
                            {item.verified && <span className="text-primary">verified</span>}
                          </p>
                        </blockquote>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Axes — PCA over the vendor × claim matrix from the latest classify run. */}
      {axes?.pc1 && (
        <div className="mb-8">
          <p className="eyebrow text-muted-foreground mb-3">
            Strategic axes (PCA) · {latestClassifyRun?.runLabel}
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {(["pc1", "pc2"] as const).map((key) => {
              const pc = axes[key];
              if (!pc?.loadings) return null;
              const ordered = [...pc.loadings].sort((a, b) => a.loading - b.loading);
              const poles = [...ordered.slice(0, 2), ...ordered.slice(-2)];
              return (
                <div key={key} className="border border-border/70 bg-card p-4">
                  <p className="mb-2 text-xs font-medium">{key}</p>
                  <div className="space-y-1">
                    {poles.map((entry) => (
                      <div key={entry.claimId} className="flex items-center justify-between font-mono text-xs">
                        <span className="truncate">{entry.claimId}</span>
                        <span className={entry.loading >= 0 ? "text-primary" : "text-warning"}>
                          {entry.loading >= 0 ? "+" : ""}
                          {entry.loading.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {pc.scores && (
                    <p className="mt-3 border-t border-border/70 pt-2 font-mono text-[11px] text-muted-foreground">
                      {[...pc.scores]
                        .sort((a, b) => a.score - b.score)
                        .map((entry) => `${entry.vendorId} ${entry.score >= 0 ? "+" : ""}${entry.score.toFixed(2)}`)
                        .join("  ·  ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent runs */}
      {runs.length > 0 && (
        <div>
          <p className="eyebrow text-muted-foreground mb-3">Recent runs</p>
          <div className="divide-y divide-border/70 border-t border-border/70">
            {runs.map((run) => (
              <div key={run._id} className="flex items-center justify-between py-2.5 font-mono text-xs">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge
                    label={run.status}
                    className={
                      run.status === "success"
                        ? "bg-primary/15 text-primary"
                        : run.status === "error"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-warning/15 text-warning"
                    }
                  />
                  <span className="text-muted-foreground">{run.kind}</span>
                  <span className="truncate">{run.runLabel}</span>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-muted-foreground">
                  {run.counts !== undefined && run.counts !== null && (
                    <span className="hidden sm:inline">
                      {Object.entries(run.counts as Record<string, unknown>)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ")}
                    </span>
                  )}
                  {run.error && (
                    <span className="max-w-64 truncate text-destructive" title={run.error}>
                      {run.error}
                    </span>
                  )}
                  <span>{new Date(run.startedAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </ViewFrame>
  );
}
