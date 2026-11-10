"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Columns2, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import type { ViewAction } from "@/components/dashboard/view-frame";
import { cn, getErrorMessage } from "@/lib/utils";
import { ReportChart } from "./report-chart";
import { ReportTable } from "./report-table";
import { info, usePresented, useReportDescriptions, type RunResult } from "./use-report";
import { pickHandler, ReportRecords, type RecordsPick } from "./report-records";

type Dashboard = FunctionReturnType<typeof api.dashboards.list>[number];
type Tile = Dashboard["tiles"][number];
const control = "border border-border bg-background px-2 py-1 text-xs";

export type DashboardPatch = { name?: string; shared?: boolean; tiles?: Tile[] };

/** Core and module dashboards share the grid and its editing controls. */
export function DashboardBoard({ dashboard, canChange, back, controls, onRemoved, names, update, remove, reportHref, tileBody, empty }: {
  dashboard: Dashboard; canChange: boolean; back: ViewAction; controls: ReactNode; onRemoved: () => void;
  names: ReadonlyMap<string, string>; update: (patch: DashboardPatch) => Promise<unknown>; remove: () => Promise<unknown>;
  reportHref: (id: Id<"reports">) => string | null; tileBody: (id: Id<"reports">) => ReactNode; empty: ReactNode;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const save = (patch: DashboardPatch) => update(patch).then(() => true, (e) => { void toast.error(getErrorMessage(e)); return false; });
  const tiles = dashboard.tiles;
  const move = (i: number, by: number) => {
    const next = [...tiles];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void save({ tiles: next });
  };
  const actions: ViewAction[] = [back, ...(canChange ? [
    { id: "dashboard-rename", label: "Rename", onClick: () => setRenaming(dashboard.name) },
    { id: "dashboard-share", label: dashboard.shared ? "Make private" : "Share", onClick: () => void save({ shared: !dashboard.shared }).then((saved) => saved && toast.success(dashboard.shared ? "Now private" : "Shared with the workspace")) },
    confirming
      ? { id: "dashboard-delete", label: "Delete for good", icon: <Trash2 className="size-3.5" />, onClick: () => void remove().then(onRemoved).catch((e) => void toast.error(getErrorMessage(e))) }
      : { id: "dashboard-delete", label: "Delete", icon: <Trash2 className="size-3.5" />, onClick: () => setConfirming(true) },
  ] : [])];
  return (
    <ViewFrame title={dashboard.name} description={dashboard.shared ? "Shared with the workspace." : "Private to its owner."} actions={actions}
      controls={<div className="flex flex-wrap items-center gap-3 text-xs">
        {controls}
        {renaming !== null && (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save({ name: renaming }).then((saved) => { if (saved) setRenaming(null); }); }}>
            <input aria-label="Dashboard name" autoFocus className={cn(control, "text-sm")} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
            <button type="submit" className="border border-border px-2 py-1 text-xs">Rename</button>
            <button type="button" onClick={() => setRenaming(null)} className="text-muted-foreground">Cancel</button>
          </form>
        )}
      </div>}>
      {tiles.length === 0 ? (
        empty
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {tiles.map((t, i) => (
            <section key={`${t.reportId}-${i}`} className={cn("operator-panel min-w-0 p-4", t.wide && "md:col-span-2")}>
              <div className="mb-3 flex items-center gap-2">
                {reportHref(t.reportId) ? <Link href={reportHref(t.reportId)!} className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline">{names.get(t.reportId) ?? "Report"}</Link> : <span className="min-w-0 flex-1 text-sm">{names.get(t.reportId) ?? "Report unavailable"}</span>}
                {canChange && (
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 hover:text-foreground disabled:opacity-30"><ArrowLeft className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label="Move later" disabled={i === tiles.length - 1} onClick={() => move(i, 1)} className="p-1 hover:text-foreground disabled:opacity-30"><ArrowRight className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={t.wide ? "Make narrow" : "Make wide"} aria-pressed={t.wide} onClick={() => void save({ tiles: tiles.map((x, j) => (j === i ? { ...x, wide: !x.wide } : x)) })} className="hidden p-1 hover:text-foreground md:block"><Columns2 className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label="Remove from dashboard" onClick={() => void save({ tiles: tiles.filter((_, j) => j !== i) })} className="p-1 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                  </span>
                )}
              </div>
              {tileBody(t.reportId)}
            </section>
          ))}
        </div>
      )}
    </ViewFrame>
  );
}

export function Board(props: { dashboard: Dashboard; canChange: boolean; back: ViewAction; controls: ReactNode; onRemoved: () => void }) {
  const reports = useQuery(api.reports.list);
  const update = useMutation(api.dashboards.update);
  const remove = useMutation(api.dashboards.remove);
  return <DashboardBoard {...props} names={new Map((reports ?? []).map((r) => [r._id as string, r.name]))}
    update={(patch) => update({ dashboardId: props.dashboard._id, ...patch })} remove={() => remove({ dashboardId: props.dashboard._id })}
    reportHref={(id) => `/dashboard/reports?report=${id}`} tileBody={(id) => <TileBody reportId={id} />}
    empty={<p className="text-sm text-muted-foreground">Nothing pinned yet. Open a saved report in <Link href="/dashboard/reports" className="underline">Reports</Link> and pin it here.</p>} />;
}

/** One pinned report, run when the tile shows. */
function TileBody({ reportId }: { reportId: Id<"reports"> }) {
  const run = useAction(api.reports.run);
  const [answer, setAnswer] = useState<{ result?: RunResult; error?: string }>({});
  useEffect(() => {
    let live = true;
    run({ reportId }).then((result) => live && setAnswer({ result })).catch((e) => live && setAnswer({ error: getErrorMessage(e) }));
    return () => { live = false; };
  }, [reportId, run]);
  const p = usePresented(answer.result ?? null);
  const { desc } = useReportDescriptions(answer.result?.spec ?? null);
  const [pick, setPick] = useState<RecordsPick | null>(null);
  const fieldOf = (name: string) => info(desc, name);
  if (answer.error) return <p className="text-xs text-muted-foreground">This report is not available: {answer.error}</p>;
  if (!p || !answer.result) return <LoadingRows count={2} />;
  if (answer.result.spec.chart === "table") return <ReportTable p={p} />;
  return (
    <>
      <ReportChart p={p} kind={answer.result.spec.chart} onPick={pickHandler(answer.result.spec, p, fieldOf, setPick)} />
      <ReportRecords spec={answer.result.spec} pick={pick} fieldOf={fieldOf} onClose={() => setPick(null)} />
    </>
  );
}
