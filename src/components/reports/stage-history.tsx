"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";
import { getErrorMessage } from "@/lib/utils";
import { present, type FieldInfo } from "./present";
import { ReportChart } from "./report-chart";

type Report = FunctionReturnType<typeof api.stageHistory.run>;
const DAYS: FieldInfo = { label: "Days in stage", type: "number" };
const days = (d: number | null) => (d === null ? "-" : d < 1 ? "< 1" : d.toLocaleString("en-US", { maximumFractionDigits: 1 }));

/** Stage history and time in stage, from the ledger (convex/stageHistory.ts). The page frame carries its title. */
export function StageHistoryView() {
  const run = useAction(api.stageHistory.run);
  const desc = useQuery(api.objects.describe, { object: "deal" });
  const [answer, setAnswer] = useState<{ report?: Report; error?: string }>({});
  useEffect(() => {
    let live = true;
    run({}).then((report) => live && setAnswer({ report })).catch((e) => live && setAnswer({ error: getErrorMessage(e) }));
    return () => { live = false; };
  }, [run]);
  const stage = desc?.fields.find((f) => f.apiName === "stage") as FieldInfo | undefined;
  const r = answer.report;
  const charts = useMemo(() => {
    if (!r || !stage) return null;
    const timeIn = present(
      { groupBy: [{ field: "stage" }], measures: [{ fn: "avg", field: "days" }] },
      { groups: r.stages.map((s) => ({ keys: [s.stage], values: [s.avgDays] })), subtotals: [], total: [null], rows: r.deals, truncated: false },
      [stage], [DAYS],
    );
    const entered = present(
      { groupBy: [{ field: "month", bucket: "month" }, { field: "stage" }], measures: [{ fn: "count" }] },
      {
        groups: r.byMonth.map((m) => ({ keys: [m.month, m.stage], values: [m.entered] })),
        subtotals: [...new Set(r.byMonth.map((m) => m.month))].map((month) => ({ keys: [month], values: [r.byMonth.filter((m) => m.month === month).reduce((s, m) => s + m.entered, 0)] })),
        total: [r.byMonth.reduce((s, m) => s + m.entered, 0)], rows: r.deals, truncated: false,
      },
      [{ label: "Month", type: "date" }, stage], [undefined],
    );
    return { timeIn, entered };
  }, [r, stage]);
  if (answer.error) return <p className="text-sm text-destructive">{answer.error}</p>;
  if (!r || !charts) return <LoadingRows count={4} />;
  const rows = charts.timeIn.groups.map((g) => ({ label: g.labels[0], row: r.stages.find((s) => s.stage === g.keys[0])! }));
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {r.deals.toLocaleString("en-US")} deals. Time in stage counts finished stays; deals still in a stage are counted separately.
        {r.partial && " This workspace has more deal history than one run reads, so this covers the oldest of it."}
      </p>
      {r.deals === 0 ? <p className="text-sm text-muted-foreground">No deal has a stage history yet.</p> : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section className="operator-panel min-w-0 p-4"><ReportChart p={charts.timeIn} kind="bar" /></section>
            <section className="operator-panel min-w-0 p-4"><ReportChart p={charts.entered} kind="line" /></section>
          </div>
          <section className="operator-panel overflow-x-auto py-2">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-muted-foreground">
                  {["Stage", "Entered", "Moved on", "Average days", "Median days", "In stage now", "Average days so far"].map((h, i) => <th key={h} className={i ? "px-3 py-2 text-right font-normal" : "px-3 py-2 font-normal"}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ label, row }) => (
                  <tr key={label} className="border-t border-border/60 tabular-nums">
                    <td className="px-3 py-1.5 text-foreground">{label}</td>
                    {[row.entered.toLocaleString("en-US"), row.left.toLocaleString("en-US"), days(row.avgDays), days(row.medianDays), row.current.toLocaleString("en-US"), days(row.currentAvgDays)].map((c, i) => <td key={i} className="px-3 py-1.5 text-right">{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
