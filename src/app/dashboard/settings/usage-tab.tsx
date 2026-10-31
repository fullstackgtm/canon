"use client";

import { useQuery } from "convex/react";
import { Gauge } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";

const usd = (micro: number) =>
  (micro / 1_000_000).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const utcDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** What this workspace's metered work cost this UTC month. Admins and managers. */
export function UsageTab() {
  const usage = useQuery(api.usage.summary);

  if (usage === undefined) return <LoadingRows count={3} height="h-24" />;
  if (usage === null) {
    return <p className="text-sm text-muted-foreground">Only admins and managers can see usage.</p>;
  }

  const pct = Math.min(100, Math.round((usage.paidEmailHits / usage.paidEmailAllowance) * 100));

  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Paid email hits</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Finding a work email tries free sources first. Only a hit from the paid source counts here.
        </p>
        <div className="mt-4 flex items-baseline justify-between">
          <span className="text-2xl font-bold">
            {usage.paidEmailHits} <span className="text-base font-normal text-muted-foreground">of {usage.paidEmailAllowance}</span>
          </span>
          <span className="text-xs text-muted-foreground">Resets {utcDate(usage.resetsAt)} (UTC)</span>
        </div>
        <div className="mt-2 h-2 bg-muted" role="progressbar" aria-valuenow={usage.paidEmailHits} aria-valuemax={usage.paidEmailAllowance}>
          <div className="h-2 bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Lookups today: {usage.emailLookupsToday} of {usage.emailLookupsPerDay}.
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Provider spend this month</h2>
          <span className="text-2xl font-bold">{usd(usage.totalMicro)}</span>
        </div>
        {usage.categories.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing metered yet this month.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="py-1">Category</th>
                <th className="py-1 text-right">Calls</th>
                <th className="py-1 text-right">Hits</th>
                <th className="py-1 text-right">Spend</th>
              </tr>
            </thead>
            <tbody>
              {usage.categories.map((c) => (
                <tr key={c.feature} className="border-t border-border">
                  <td className="py-2">{c.label}</td>
                  <td className="py-2 text-right tabular-nums">{c.calls}</td>
                  <td className="py-2 text-right tabular-nums">{c.hits}</td>
                  <td className="py-2 text-right tabular-nums">{usd(c.costMicro)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Free sources show $0.00. Spend is what the data provider billed, at cost.</p>
      </section>

      <p className="text-sm text-muted-foreground">
        Agent inference runs on your own ChatGPT plan, so it does not appear here and never uses Canon credits.
      </p>
    </div>
  );
}
