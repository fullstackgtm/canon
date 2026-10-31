"use client";

import { groupRuns, RUN_KINDS, type RunInterval, type RunKind } from "@/lib/run-chart";

const COLORS = ["#6366f1", "#06b6d4", "#a855f7", "#f59e0b", "#ec4899", "#22c55e", "#3b82f6", "#14b8a6"];

export function RunChart({ rows, interval, labels }: {
  rows: readonly { at: number; kind: RunKind }[];
  interval: RunInterval;
  labels: Record<RunKind, string>;
}) {
  const buckets = groupRuns(rows, interval);
  const maximum = Math.max(1, ...buckets.map(({ counts }) => RUN_KINDS.reduce((sum, kind) => sum + counts[kind], 0)));
  const width = Math.max(640, buckets.length * 120);
  const label = (at: number) => new Date(at).toISOString().slice(0, interval === "hourly" ? 13 : interval === "monthly" ? 7 : 10).replace("T", " ") + (interval === "hourly" ? ":00" : "");
  return (
    <section aria-label="Runs by type" className="mb-6 rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-medium">Runs by type</h2>
      <p className="text-xs text-muted-foreground">UTC · periods with activity only · weeks start Monday</p>
      <div className="overflow-x-auto">
        <svg role="img" aria-label={`${interval} run counts by type`} viewBox={`0 0 ${width} 240`} style={{ minWidth: width }} className="h-60 w-full">
          <text x="0" y="15" fill="currentColor" fontSize="11">{maximum} runs</text>
          <line x1="0" x2={width} y1="200" y2="200" stroke="currentColor" opacity="0.2" />
          {buckets.map(({ at, counts }, index) => {
            let offset = 0;
            const x = index * (width / buckets.length) + 30;
            return <g key={at}>
              {RUN_KINDS.map((kind, i) => {
                const height = counts[kind] / maximum * 170;
                offset += height;
                return counts[kind] ? <rect key={kind} x={x} y={200 - offset} width="35" height={height} fill={COLORS[i]}>
                  <title>{`${label(at)} UTC · ${labels[kind]}: ${counts[kind]}`}</title>
                </rect> : null;
              })}
              <text x={x + 17} y="220" textAnchor="middle" fill="currentColor" fontSize="10">{label(at)}</text>
            </g>;
          })}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {RUN_KINDS.filter((kind) => rows.some((row) => row.kind === kind)).map((kind) => <span key={kind} className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: COLORS[RUN_KINDS.indexOf(kind)] }} />{labels[kind]}
        </span>)}
      </div>
    </section>
  );
}
