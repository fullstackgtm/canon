"use client";

import { StatusBadge } from "./status-badge";
import type { GtmReadiness, GtmReadinessRow } from "@/lib/gtm-client";

function sortedReadinessRows(readiness: GtmReadiness, limit: number) {
  return Object.values(readiness.nouns)
    .filter((row) => row.relevant || row.required)
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        Number(a.configured) - Number(b.configured) ||
        a.noun.localeCompare(b.noun),
    )
    .slice(0, limit);
}

function formatLabel(value: string) {
  return value.replaceAll("_", " ");
}

function readinessStatus(row: GtmReadinessRow) {
  if (row.configured) return "ok";
  if (row.required) return "warning";
  return "info";
}

export function GtmReadinessPanel({
  readiness,
  limit = 8,
}: {
  readiness: GtmReadiness;
  limit?: number;
}) {
  const rows = sortedReadinessRows(readiness, limit);
  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">GTM operating readiness</h2>
        </div>
        <div className="text-sm text-muted-foreground">
          {readiness.summary.configured}/{readiness.summary.relevant} relevant configured
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div key={row.noun} className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium capitalize text-foreground">{formatLabel(row.noun)}</span>
              <StatusBadge status={readinessStatus(row)} label={formatLabel(row.lifecycle)} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {row.nextActions[0] ?? "Ready for review"}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
