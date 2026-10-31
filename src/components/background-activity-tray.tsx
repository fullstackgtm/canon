"use client";

import Link from "next/link";
import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { CheckCircle2, CircleAlert, Clock3, History, Loader2, LoaderCircle, RefreshCw } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { cn } from "@/lib/utils";
import {
  backgroundActivityLabel,
  formatRelativeTime,
  isActiveBackgroundActivity,
  partitionBackgroundActivity,
  type BackgroundActivityEntry,
  type BackgroundActivityStatus,
} from "@/lib/background-activity";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CustomizeTray } from "@/components/customize/customize-mode";
import { FloatingTrayDock, trayLauncherClassName } from "@/components/floating-tray-dock";
import { BugDropTray } from "@/components/bugdrop-tray";
import { JobPhaseBars } from "@/components/job-phase-bars";

class TrayErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const STATUS_LABELS: Record<BackgroundActivityStatus, string> = {
  pending: "Waiting",
  processing: "In progress",
  completed: "Completed",
  failed: "Needs attention",
};

function StatusIcon({ status }: { status: BackgroundActivityStatus }) {
  if (status === "processing") return <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />;
  if (status === "pending") return <Clock3 className="size-4 text-warning" aria-hidden />;
  if (status === "failed") return <CircleAlert className="size-4 text-destructive" aria-hidden />;
  return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />;
}

function ActivityRow({ entry }: { entry: BackgroundActivityEntry }) {
  const active = isActiveBackgroundActivity(entry);
  return (
    <Link href={entry.href} className="flex gap-3 px-2 py-2.5 transition-colors hover:bg-muted/60">
      <span className="mt-0.5 shrink-0"><StatusIcon status={entry.status} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="truncate text-sm font-medium">{entry.title}</span>
          <span className={cn("shrink-0 text-[11px]", active ? "font-medium text-primary" : "text-muted-foreground", entry.status === "failed" && "text-destructive")}>
            {STATUS_LABELS[entry.status]}
          </span>
        </span>
        {entry.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{entry.detail}</span>}
        {entry.phases?.some((p) => p.total !== undefined) ? (
          <JobPhaseBars phases={entry.phases} className="mt-2" />
        ) : entry.phases && entry.phases.length > 0 && (
          <span className="mt-2 grid gap-1 border-l border-border pl-2">
            {entry.phases.map((phase) => (
              <span key={phase.key} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <StatusIcon status={phase.status} />
                <span className={cn("truncate text-muted-foreground", phase.status === "processing" && "font-medium text-foreground", phase.status === "failed" && "text-destructive")}>
                  {phase.label}
                </span>
                {phase.count !== undefined && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{phase.count.toLocaleString("en-US")}</span>}
              </span>
            ))}
          </span>
        )}
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {active ? "Started" : "Updated"} {formatRelativeTime(entry.completedAt ?? entry.startedAt)}
        </span>
      </span>
    </Link>
  );
}

/** A quiet, global home for long-running work and its recent history (from QuotaQueue). */
function BackgroundActivityTray() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activity = useQuery(api.activity.background, {});
  const { active, recent } = partitionBackgroundActivity(activity ?? []);
  const activeCount = active.length;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openTray = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    // Time to cross the gap between the launcher and the portalled panel.
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={backgroundActivityLabel(activeCount)}
          onMouseEnter={openTray}
          onMouseLeave={scheduleClose}
          onFocus={openTray}
          title={activeCount > 0 ? "Background work in progress" : "Background activity"}
          className={cn(trayLauncherClassName, activeCount > 0 && "border-primary/40 bg-primary/10 text-primary")}
        >
          {activeCount > 0 ? <RefreshCw className="size-5 animate-spin [animation-duration:2s]" aria-hidden /> : <History className="size-5" aria-hidden />}
          {activeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground ring-2 ring-background">
              {activeCount > 9 ? "9+" : activeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={12}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        // Returning focus to the trigger would reopen the tray the pointer just left.
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Background activity</p>
          <p className="text-xs text-muted-foreground">
            {activeCount > 0 ? `${activeCount} ${activeCount === 1 ? "process is" : "processes are"} running on your behalf` : "Nothing is running right now"}
          </p>
        </div>
        <div className="max-h-[min(500px,calc(100vh-9rem))] overflow-y-auto p-2">
          {!activity ? (
            <div className="flex items-center justify-center px-3 py-8"><Loader2 className="size-4 animate-spin" aria-label="Loading activity" /></div>
          ) : activity.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <History className="mx-auto mb-2 size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">No background activity yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Contact sweeps, CRM syncs, inbox reads and CLI runs will appear here.</p>
            </div>
          ) : (
            <>
              {active.length > 0 && (
                <section>
                  <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">In progress</p>
                  {active.map((entry) => <ActivityRow key={entry.id} entry={entry} />)}
                </section>
              )}
              {recent.length > 0 && (
                <section className={cn(active.length > 0 && "mt-2 border-t border-border pt-2")}>
                  <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">Recent</p>
                  {recent.map((entry) => <ActivityRow key={entry.id} entry={entry} />)}
                </section>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Lower-right dock: the operator BugDrop tray and the activity tray. An error in either never takes down the dashboard. */
export function BackgroundActivityDock() {
  return (
    <FloatingTrayDock>
      <TrayErrorBoundary>
        <BugDropTray />
      </TrayErrorBoundary>
      <TrayErrorBoundary>
        <CustomizeTray />
      </TrayErrorBoundary>
      <TrayErrorBoundary>
        <BackgroundActivityTray />
      </TrayErrorBoundary>
    </FloatingTrayDock>
  );
}
