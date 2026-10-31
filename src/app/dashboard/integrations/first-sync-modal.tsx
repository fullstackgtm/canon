"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { ProgressChip, StageTimeline } from "@/components/dashboard";
import { CRM_SYNC_STAGES } from "../../../../engine/src/progress";
import { cn } from "@/lib/utils";

/** After the first OAuth connect of a CRM: live progress, then how many fixes Canon found. Shown once per run. */
export function FirstSyncModal() {
  const workspace = useQuery(api.integrations.context);
  const syncRuns = workspace?.syncRuns;
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());

  const candidate = syncRuns?.find((run) => {
    if ((run.provider !== "hubspot" && run.provider !== "salesforce") || run.trigger !== "oauth") return false;
    return run.status === "in_progress" || Boolean(run.finishedAt);
  });
  const candidateProvider =
    candidate?.provider === "hubspot" || candidate?.provider === "salesforce" ? candidate.provider : null;
  const hasPriorFinishedRun = useQuery(
    api.integrations.hasFinishedSyncRunBefore,
    candidate && candidateProvider ? { provider: candidateProvider, startedAt: candidate.startedAt } : "skip",
  );
  const run = hasPriorFinishedRun === false ? candidate : undefined;
  const summary = useQuery(
    api.opportunities.summaryForProvider,
    run && (run.provider === "hubspot" || run.provider === "salesforce") ? { provider: run.provider } : "skip",
  );
  const storageKey = run ? `fsgtm:first-sync:${run.provider}:${run._id}` : null;
  const show = Boolean(
    run &&
      storageKey &&
      !dismissedKeys.has(storageKey) &&
      (typeof window === "undefined" || window.localStorage.getItem(storageKey) !== "dismissed"),
  );
  if (!show || !run) return null;

  const displayName =
    run.provider === "hubspot" ? (workspace?.hubspot?.displayName ?? "HubSpot") : (workspace?.salesforce?.displayName ?? "Salesforce");
  const openCount = summary?.totalOpen ?? 0;
  const categoryCount = new Set((summary?.categories ?? []).map((item) => item.rule)).size;
  const failed = run.status === "error";

  function dismiss() {
    if (!storageKey) return;
    window.localStorage.setItem(storageKey, "dismissed");
    setDismissedKeys((prev) => new Set(prev).add(storageKey));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6 backdrop-blur">
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className={cn("eyebrow", failed ? "text-destructive" : "text-primary")}>
          {failed ? "CRM sync failed" : "CRM connected"}
        </div>
        <h1 className="mt-3 text-3xl font-bold">
          {failed ? `${displayName} needs another sync attempt` : `Analyzing ${displayName} for opportunities`}
        </h1>
        {failed && <p className="mt-3 text-muted-foreground">The connection is saved. Fix the error below, then sync again.</p>}
        <div className="mt-6 rounded-xl border border-border bg-background/60 p-4">
          {run.status === "in_progress" ? (
            <>
              <ProgressChip status={run.status} progress={run.progress} startedAt={run.startedAt} />
              <div className="mt-4"><StageTimeline progress={run.progress} stages={CRM_SYNC_STAGES} /></div>
            </>
          ) : failed ? (
            <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">First sync did not complete.</div>
                <p className="mt-1 text-destructive/90">
                  {run.error ?? "Retry the sync after checking scopes, permissions, and provider availability."}
                </p>
              </div>
            </div>
          ) : summary === undefined ? (
            <div className="h-16 animate-pulse rounded-lg bg-muted" />
          ) : openCount > 0 ? (
            <div>
              <div className="text-4xl font-bold">{openCount}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                fix opportunities from {displayName} across {categoryCount} categories.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Sync complete. Your {displayName} accounts are ready to explore.</p>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button onClick={dismiss} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted">Dismiss</button>
          <button
            onClick={() => {
              dismiss();
              window.location.href = "/dashboard/accounts";
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Explore accounts
          </button>
        </div>
      </div>
    </div>
  );
}
