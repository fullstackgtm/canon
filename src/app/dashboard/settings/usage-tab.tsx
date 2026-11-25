"use client";

import { useQuery } from "convex/react";
import { Gauge } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";

const utcDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** This UTC month's data lookup activity for the workspace. Admins and managers. */
export function UsageTab() {
  const usage = useQuery(api.usage.summary);

  if (usage === undefined) return <LoadingRows count={2} height="h-24" />;
  if (usage === null) {
    return <p className="text-sm text-muted-foreground">Only admins and managers can see usage.</p>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Data lookups this month</h2>
          </div>
          <span className="text-xs text-muted-foreground">Resets {utcDate(usage.resetsAt)} (UTC)</span>
        </div>
        {usage.categories.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No data lookups yet this month.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th className="py-1">Category</th>
                <th className="py-1 text-right">Calls</th>
                <th className="py-1 text-right">Hits</th>
              </tr>
            </thead>
            <tbody>
              {usage.categories.map((c) => (
                <tr key={c.feature} className="border-t border-border">
                  <td className="py-2">{c.label}</td>
                  <td className="py-2 text-right tabular-nums">{c.calls}</td>
                  <td className="py-2 text-right tabular-nums">{c.hits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Email lookups today: {usage.emailLookupsToday} of {usage.emailLookupsPerDay}.
        </p>
      </section>

      <p className="text-sm text-muted-foreground">
        AI research on your own ChatGPT plan uses no Canon credits. Research runs on Canon&rsquo;s
        hosted model (when no ChatGPT plan is connected) use credits from your workspace balance.
      </p>
    </div>
  );
}
