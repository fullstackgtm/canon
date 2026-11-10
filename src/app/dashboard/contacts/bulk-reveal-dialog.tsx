"use client";

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { previewReveal, runReveal, type RevealOutcome, type RevealReport, type RevealTarget } from "@/lib/bulkReveal";

const CONCURRENCY = 3;

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Cost preview before a bulk email reveal: how many selected contacts need a
 * lookup, the most paid hits that can use, and what is left this month. Free
 * routes run first inside each lookup, so the paid count is a ceiling.
 */
export function BulkRevealDialog({
  targets,
  allowance,
  onClose,
  find,
}: {
  targets: RevealTarget[];
  allowance: { used: number; allowance: number; remaining: number; resetsAt: number } | null | undefined;
  onClose: () => void;
  find: (target: RevealTarget) => Promise<RevealOutcome>;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<(RevealReport & { priorSkipped: number }) | null>(null);
  const preview = useMemo(() => previewReveal(targets, allowance?.remaining ?? 0), [targets, allowance?.remaining]);
  const running = progress !== null && report === null;

  async function start() {
    // Snapshot now: each finished lookup updates the parent's rows, which would shift the live preview counts.
    const priorSkipped = preview.alreadyHaveEmail + preview.recentlyLookedUp;
    setProgress({ done: 0, total: preview.lookups.length });
    const result = await runReveal(preview.lookups, {
      allowance: allowance?.remaining ?? 0,
      concurrency: CONCURRENCY,
      find,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setReport({ ...result, priorSkipped });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Find work emails</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">
          Free sources are tried first. Only a hit from the paid source uses your monthly allowance.
        </DialogDescription>

        {report ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt className="text-muted-foreground">Found</dt><dd className="text-right tabular-nums">{report.found}</dd>
              <dt className="text-muted-foreground">Not found</dt><dd className="text-right tabular-nums">{report.notFound}</dd>
              <dt className="text-muted-foreground">Skipped</dt><dd className="text-right tabular-nums">{report.skipped + report.priorSkipped}</dd>
              {report.failed > 0 && (<><dt className="text-muted-foreground">Failed</dt><dd className="text-right tabular-nums">{report.failed}</dd></>)}
              <dt className="text-muted-foreground">Paid hits used</dt><dd className="text-right tabular-nums">{report.paidHits}</dd>
            </dl>
            {report.stoppedBy && (
              <p className="text-muted-foreground">
                Stopped early: {report.stoppedBy === "allowance" ? "this run reached the paid-hit allowance" : "a lookup limit was reached"}. The remaining contacts were skipped.
              </p>
            )}
            <button onClick={onClose} className="border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">Done</button>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              <dt className="text-muted-foreground">Selected</dt><dd className="text-right tabular-nums">{preview.selected}</dd>
              <dt className="text-muted-foreground">Will be looked up</dt><dd className="text-right tabular-nums">{preview.lookups.length}</dd>
              <dt className="text-muted-foreground">Skipped (already have an email or were looked up)</dt>
              <dd className="text-right tabular-nums">{preview.alreadyHaveEmail + preview.recentlyLookedUp}</dd>
              <dt className="text-muted-foreground">Paid hits this could use, at most</dt><dd className="text-right tabular-nums">{preview.maxPaidHits}</dd>
              <dt className="text-muted-foreground">Allowance left this month</dt>
              <dd className="text-right tabular-nums">{allowance ? `${allowance.remaining} of ${allowance.allowance}` : "…"}</dd>
            </dl>
            {allowance && (
              <p className="text-xs text-muted-foreground">
                The allowance resets on {dateLabel(allowance.resetsAt)} (UTC).
                {preview.overAllowance > 0 && allowance.remaining > 0 && ` If every lookup needs a paid hit, the run stops after ${allowance.remaining} and skips the rest.`}
                {allowance.remaining === 0 && " It is used up, so no lookups will run."}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => void start()}
                disabled={running || preview.lookups.length === 0 || !allowance || allowance.remaining === 0}
                className="inline-flex items-center gap-2 border border-border bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {running && <Loader2 className="h-3 w-3 animate-spin" />}
                {running ? `Finding ${progress?.done ?? 0} of ${progress?.total ?? 0}…` : `Find ${preview.lookups.length} email${preview.lookups.length === 1 ? "" : "s"}`}
              </button>
              {!running && <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
