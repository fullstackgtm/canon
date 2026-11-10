"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { DashboardBoard } from "@/components/reports/dashboard-view";
import { SelectField } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/utils";
import { ModuleSavedReportTile, type ReportEnv } from "./module-report";

const control = "border border-border bg-background px-2 py-1 text-sm";

export function ModuleDashboards({ title = "Dashboards", env }: { title?: string; env: ReportEnv }) {
  const boards = useQuery(api.modules.dashboards, { module: env.module });
  const reports = useQuery(api.modules.savedReports, { module: env.module });
  const save = useMutation(api.modules.saveDashboard);
  const remove = useMutation(api.modules.removeDashboard);
  const [name, setName] = useState<string | null>(null);
  const id = env.query.d;
  const active = boards?.find((d) => d._id === id);
  const open = (id: string | null) => env.setQuery({ d: id });
  const picker = <SelectField aria-label="Dashboard" value={active?._id ?? ""} onValueChange={(id) => open(id || null)} options={[
    { value: "", label: "All dashboards" }, ...(boards ?? []).map((d) => ({ value: d._id, label: `${d.name}${d.shared ? " · shared" : ""}` })),
  ]} />;
  if (!boards || !reports) return <p className="text-sm text-muted-foreground">Loading dashboards…</p>;
  if (active) return <DashboardBoard key={active._id} dashboard={active} canChange={active.canChange && !env.readOnly}
    back={{ id: "all-dashboards", label: "All dashboards", onClick: () => open(null) }} controls={picker} onRemoved={() => open(null)}
    names={new Map(reports.map((r) => [r._id, r.name]))}
    update={(patch) => save({ module: env.module, dashboardId: active._id, ...patch })} remove={() => remove({ module: env.module, dashboardId: active._id })}
    reportHref={(id) => { const r = reports.find((r) => r._id === id); return r?.path ? `/dashboard/m/${env.module}/${r.path}?${r.report}.saved=${id}` : null; }}
    tileBody={(id) => { const r = reports.find((r) => r._id === id); return <ModuleSavedReportTile key={`${id}:${r?.updatedAt}`} report={r} env={env} />; }}
    empty={<p className="text-sm text-muted-foreground">Nothing pinned yet. Open a saved report in this module and choose Pin to dashboard.</p>} />;
  return <section className="space-y-4" aria-label={title}>
    <div className="flex flex-wrap items-center gap-3"><h2 className="flex-1 font-display text-lg">{title}</h2><button className={control} disabled={env.readOnly} onClick={() => setName("")}>New dashboard</button></div>
    {id && <p className="text-sm text-muted-foreground">This dashboard is not available.</p>}
    {name !== null && <form className="flex items-center gap-2" onSubmit={(e) => {
      e.preventDefault();
      void save({ module: env.module, name }).then((id) => { setName(null); open(id); }).catch((e) => toast.error(getErrorMessage(e)));
    }}><input aria-label="Dashboard name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className={control} /><button type="submit" className={control} disabled={env.readOnly}>Create</button><button type="button" onClick={() => setName(null)}>Cancel</button></form>}
    {boards.length === 0 ? <p className="text-sm text-muted-foreground">No dashboards yet. Pin a saved report or create a dashboard.</p> : <ul className="divide-y divide-border border border-border">{boards.map((d) => <li key={d._id}>
      <Link href={`?d=${d._id}`} onClick={(e) => { e.preventDefault(); open(d._id); }} className="flex items-center justify-between p-3 hover:bg-muted"><span>{d.name}</span><span className="text-xs text-muted-foreground">{d.tiles.length} {d.tiles.length === 1 ? "tile" : "tiles"} · {d.shared ? "Shared" : "Private"}</span></Link>
    </li>)}</ul>}
  </section>;
}
