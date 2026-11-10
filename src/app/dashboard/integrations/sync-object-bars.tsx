"use client";

import type { LiveProgress } from "@/components/dashboard";
import { formatTimeLeft, movingObjects, objectSecondsLeft, syncSecondsLeft, type ObjectProgress } from "../../../../convex/lib/syncObjectProgress";

// Each CRM's own names for the synced objects: HubSpot's companies and deals are Salesforce's accounts and opportunities.
export const OBJECT_LABEL: Record<"hubspot" | "salesforce", Record<string, string>> = {
  hubspot: { accounts: "Companies", contacts: "Contacts", deals: "Deals" },
  salesforce: { accounts: "Accounts", contacts: "Contacts", deals: "Opportunities" },
};
const numberFormat = new Intl.NumberFormat();

/**
 * The run's progress for its chip beside the bars: the objects syncing now, and no counts of its own. The counts are
 * the bars', from the objects' snapshot; the run's own progress is written at other times and would disagree with them.
 * Its heartbeat still says when the run stalled.
 */
export function chipProgress(
  progress: LiveProgress | null | undefined,
  objects: ObjectProgress[] | null | undefined,
  provider: "hubspot" | "salesforce",
): LiveProgress | null | undefined {
  if (!progress || !objects?.length) return progress;
  const stage = movingObjects(objects).map((o) => (OBJECT_LABEL[provider][o] ?? o).toLowerCase()).join(", ");
  return { heartbeatAt: progress.heartbeatAt, ...(stage ? { stage } : { note: "finishing" }) };
}

/**
 * A running sync's progress per object (integrationSyncRuns.objects): a bar of records done out of the total for
 * each, its time left at its own write rate, and the whole sync's time left. Objects sync side by side, so more than
 * one bar can move at once; contacts and deals wait for accounts before they write.
 */
export function SyncObjectBars({ objects, provider, className }: { objects?: ObjectProgress[] | null; provider: "hubspot" | "salesforce"; className?: string }) {
  if (!objects?.length) return null;
  const labels = OBJECT_LABEL[provider];
  const total = formatTimeLeft(syncSecondsLeft(objects));
  const companies = objects.find((o) => o.object === "accounts");
  return (
    <div className={className}>
      <div className="space-y-2">
        {objects.map((o) => {
          const pct = o.finished ? 100 : o.total ? Math.min(100, Math.round((o.done / o.total) * 100)) : 0;
          const waiting = !o.finished && o.done === 0 && o.object !== "accounts" && companies && !companies.finished;
          const left = waiting ? `waits for ${labels.accounts.toLowerCase()}` : o.finished ? "done" : (formatTimeLeft(objectSecondsLeft(o)) ?? "estimating…");
          const label = labels[o.object] ?? o.object;
          return (
            <div key={o.object}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="font-medium">{label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {numberFormat.format(o.done)}
                  {o.total !== undefined ? ` / ${numberFormat.format(o.total)}` : ""} · {left}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} progress`}>
                <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {total && <p className="mt-2 text-xs text-muted-foreground">Whole sync: {total}</p>}
    </div>
  );
}
