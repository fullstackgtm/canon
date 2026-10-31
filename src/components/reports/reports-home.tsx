"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, Plus, Share2, Target } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import { useUrlState } from "@/lib/url-state";
import { getErrorMessage } from "@/lib/utils";
import { Board } from "./dashboard-view";
import { money } from "./pacing-chart";
import { fiscalYearName } from "../../../convex/lib/reports/pacing";
import { PacingView } from "./pacing-view";

/** The year's targets live in Settings (docs/module-plans/reports.md, "Targets stay platform data"). */
const TARGETS_HREF = "/dashboard/settings/targets";

const FIXED_PAGES = [
  { name: "Revenue and forecast", href: "/dashboard/revenue" },
  { name: "Customer health", href: "/dashboard/health" },
  { name: "Stage history and time in stage", href: "/dashboard/reports?view=stages" },
];

/**
 * Reports: pacing against targets first; dashboards, saved reports and the fixed pages behind one menu, so the page
 * never splits into a second navigator. `?d=` opens a dashboard; `?view=targets`, the old address of the targets editor, opens it in Settings.
 */
export function ReportsHome() {
  const [url, setUrl] = useUrlState({ d: "", view: "" });
  const router = useRouter();
  const current = useQuery(api.targets.get, {});
  const previous = useQuery(api.targets.get, current ? { year: current.year - 1 } : "skip");
  const me = useQuery(api.users.me);
  const dashboards = useQuery(api.dashboards.list);
  const ensureDefaults = useMutation(api.templates.ensureDefaults);
  const seeding = useRef(false);
  // Canon's reports and dashboards are default-on recipe templates, installed the first time anyone opens Reports.
  // The installer checks each template, so one dashboard already installed from Recipes doesn't hold back the rest.
  useEffect(() => {
    if (url.view === "targets") router.replace(TARGETS_HREF);
  }, [url.view, router]);
  useEffect(() => {
    if (seeding.current || dashboards === undefined) return;
    seeding.current = true;
    ensureDefaults({}).catch((e) => void toast.error(getErrorMessage(e)));
  }, [dashboards, ensureDefaults]);

  const back = { id: "reports-back", label: "Reports", icon: <ArrowLeft className="size-3.5" />, onClick: () => setUrl({ d: "" }) };
  const allReports = <AllReports dashboards={dashboards ?? []} onOpen={(d) => setUrl({ d })} />;
  if (current === undefined || previous === undefined || !me) return <ViewFrame title="Reports"><LoadingRows count={4} /></ViewFrame>;
  const { year, fyStart } = current;
  const yearName = fiscalYearName(year, fyStart);
  const board = url.d ? dashboards?.find((d) => d._id === url.d) : null;

  if (url.d) {
    return board ? <Board key={board._id} dashboard={board} canChange={board.mine || me.role === "admin"} back={back} controls={allReports} onRemoved={() => setUrl({ d: "" })} />
      : <ViewFrame title="Dashboard" actions={[back]} controls={allReports}>
        {dashboards === undefined ? <LoadingRows count={3} /> : <p className="text-sm text-muted-foreground">That dashboard is no longer available.</p>}
      </ViewFrame>;
  }

  return (
    <ViewFrame
      title="Reports" description="Bookings pacing against this year's targets."
      actions={current.canEdit || current.plan ? [{
        id: "reports-targets", label: current.canEdit ? (current.plan ? "Edit targets" : "Set targets") : "See targets",
        icon: <Target className="size-3.5" />, primary: current.canEdit, onClick: () => router.push(TARGETS_HREF),
      }] : []}
      controls={<div className="flex flex-wrap items-center gap-3 text-xs">
        {allReports}
        <span className="text-muted-foreground">{current.plan ? `${yearName} target ${money(current.plan.total)}` : `No targets for ${yearName}`}</span>
      </div>}
    >
      <PacingView plans={{ [year]: current.plan, [year - 1]: previous.plan }} roster={current.roster} meId={me._id} meRole={me.role} />
    </ViewFrame>
  );
}

type DashboardRow = { _id: string; name: string; shared: boolean };

/** Every other way into reports: dashboards (and a new one), saved reports and the fixed pages. */
function AllReports({ dashboards, onOpen }: { dashboards: readonly DashboardRow[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const reports = useQuery(api.reports.list, open ? {} : "skip");
  const create = useMutation(api.dashboards.create);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const go = (id: string) => { onOpen(id); setOpen(false); };
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 border border-border px-2 py-1 text-xs hover:border-foreground/50">
        All reports <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-80 overflow-y-auto border border-border bg-popover p-2 text-sm shadow-lg">
          <div className="px-2 pt-1 text-xs text-muted-foreground">Dashboards</div>
          {dashboards.map((d) => (
            <button key={d._id} type="button" onClick={() => go(d._id)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted">
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {d.shared && <Share2 aria-label="Shared" className="h-3 w-3 shrink-0 text-muted-foreground" />}
            </button>
          ))}
          {naming === null ? (
            <button type="button" onClick={() => setNaming("")} className="flex w-full items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"><Plus className="h-3 w-3" /> New dashboard</button>
          ) : (
            <form className="flex gap-1 px-2 py-1" onSubmit={(e) => {
              e.preventDefault();
              create({ name: naming, shared: false }).then((id) => { setNaming(null); go(id); }).catch((err) => void toast.error(getErrorMessage(err)));
            }}>
              <input aria-label="New dashboard name" autoFocus placeholder="Dashboard name" className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-xs" value={naming} onChange={(e) => setNaming(e.target.value)} />
              <button type="submit" className="border border-primary px-2 text-xs">Add</button>
            </form>
          )}
          <div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">Saved reports</div>
          {reports === undefined ? <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div> : reports.map((r) => (
            <Link key={r._id} href={`/dashboard/reports?report=${r._id}`} className="block truncate px-2 py-1 hover:bg-muted">{r.name}</Link>
          ))}
          <Link href="/dashboard/reports" className="flex items-center gap-1 px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus className="h-3 w-3" /> New report</Link>
          <div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted-foreground">Pages</div>
          {FIXED_PAGES.map((p) => <Link key={p.href} href={p.href} className="block px-2 py-1 hover:bg-muted">{p.name}</Link>)}
        </div>
      )}
    </div>
  );
}
