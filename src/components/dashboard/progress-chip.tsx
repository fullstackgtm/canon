"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Live heartbeat payload persisted on sync/CLI run rows — the shared progress
 * vocabulary (engine/src/progress.ts), same shape as
 * integrationSyncRuns.progress / cliRuns.progress.
 */
export type LiveProgress = {
  stage?: string;
  stageIndex?: number;
  stageCount?: number;
  itemsDone?: number;
  itemsTotal?: number;
  note?: string;
  heartbeatAt: number;
};

/** heartbeatAt older than this = the run has stalled (amber). */
const STALL_AFTER_MS = 120_000;

const numberFormat = new Intl.NumberFormat();

function fmt(n: number): string {
  return numberFormat.format(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * Compact live-status chip for an in-flight run: pulsing mint dot + a line
 * built from the heartbeat snapshot ("Syncing · contacts 1,200/4,800",
 * "in progress · 2m"). Flips amber ("stalled 3m", static dot) when the last
 * heartbeat is older than 120s. Renders nothing unless status is
 * "in_progress". Re-derives elapsed/stalled every 15s so it stays honest even
 * without new heartbeats.
 */
export function ProgressChip({
  status,
  progress,
  startedAt,
  verb = "Syncing",
  className,
}: {
  status: string;
  progress?: LiveProgress | null;
  startedAt?: number;
  /** Leading word when a stage is known (e.g. "Syncing", "Running"). */
  verb?: string;
  className?: string;
}) {
  // A ticking clock so "· 2m" and stall detection advance between heartbeats.
  // The clock LIVES in state (render stays pure — no Date.now() in render);
  // the initial 0 renders one tick without elapsed/stall until the effect
  // fires, which is imperceptible at a 15s cadence.
  const [now, setNow] = useState(0);
  useEffect(() => {
    // First update is async (a 0-delay timeout) — the react-compiler rules
    // forbid both Date.now() in render and synchronous setState in effects.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  if (status !== "in_progress") return null;

  const stallKnown = now > 0;
  const stalled = stallKnown && progress ? now - progress.heartbeatAt > STALL_AFTER_MS : false;

  let text: string;
  if (stalled && progress) {
    text = `stalled ${fmtElapsed(now - progress.heartbeatAt)}`;
  } else if (progress?.stage) {
    const items =
      progress.itemsDone !== undefined
        ? progress.itemsTotal !== undefined
          ? ` ${fmt(progress.itemsDone)}/${fmt(progress.itemsTotal)}`
          : ` ${fmt(progress.itemsDone)}`
        : "";
    text = `${verb} · ${progress.stage}${items}`;
  } else if (progress?.note) {
    text = `${verb} · ${progress.note}`;
  } else if (startedAt !== undefined && stallKnown) {
    text = `in progress · ${fmtElapsed(now - startedAt)}`;
  } else {
    text = "in progress";
  }

  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px] tracking-wide",
        stalled ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary",
        className,
      )}
      title={
        progress
          ? `last heartbeat ${fmtElapsed(now - progress.heartbeatAt)} ago`
          : undefined
      }
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          stalled ? "bg-warning" : "animate-pulse bg-primary",
        )}
      />
      {text}
    </span>
  );
}
