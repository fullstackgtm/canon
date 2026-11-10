"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { Plus, Save, Share2, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { FILTERS_MAX, listColumns } from "../../../convex/lib/objects/listSpec";
import { indexObjectDef, type ObjectDef, type ResolvedObjectDef } from "../../../convex/lib/objects/registry";
import { GROUP_BY_MAX, groupableField, MEASURES_MAX, measurableField, relationsOf } from "../../../convex/lib/objects/reportSpec";
import { REPORT_BUCKETS, type MeasureFn, type ReportBucket, REPORT_CHARTS, type ReportChart as ChartKind } from "../../../modules/kernel/reportLanguage";
import { collapseDayFilters, dayColumnsOf, expandDayFilters } from "../../../convex/lib/objects/views";
import type { ReportSpec, ViewFilter } from "../../../modules/kernel/reportValidators";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import type { ViewAction } from "@/components/dashboard/view-frame";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";
import { FilterBar, isComplete } from "../records/filter-bar";
import type { ObjectDescription, TeamMember } from "../records/fields";
import { needsLoad, type Loaded } from "./present";
import { info, usePresented, useReportDescriptions, type RunResult } from "./use-report";
import { pickHandler, ReportRecords, type RecordsPick } from "./report-records";
import { ReportChart } from "./report-chart";
import { ReportTable } from "./report-table";
import { StageHistoryView } from "./stage-history";
import { SelectField } from "@/components/ui/select";

const control = "border border-border bg-background px-2 py-1 text-xs";
const STANDARD = [
  ["deal", "Deals"], ["account", "Companies"], ["contact", "People"], ["lead", "Leads"],
  ["activity", "Activities"], ["task", "Tasks"], ["call", "Calls"], ["meeting", "Meetings"], ["note", "Notes"], ["product", "Products"],
] as const;
const CHART_LABEL: Record<ChartKind, string> = { table: "Table", bar: "Bar", column: "Column", line: "Line", area: "Area", pie: "Pie", number: "Number" };
const FN_LABEL: Record<MeasureFn, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Min", max: "Max" };

type SavedReport = FunctionReturnType<typeof api.reports.list>[number];

/** A new report on `object`: deals by stage with their amount, else a count by the first picklist. */
function defaultSpec(object: string, def: ResolvedObjectDef | null): ReportSpec {
  if (object === "deal") return { object, filter: [], groupBy: [{ field: "stage" }], measures: [{ fn: "sum", field: "amount" }, { fn: "count" }], chart: "bar" };
  const picklist = def?.fields.find((f) => f.type === "picklist" && f.archivedAt === undefined);
  return { object, filter: [], groupBy: picklist ? [{ field: picklist.apiName }] : [], measures: [{ fn: "count" }], chart: picklist ? "bar" : "number" };
}

const defOf = (d: ObjectDescription | null | undefined) => (d ? indexObjectDef(d as unknown as ObjectDef) : null);

/** Fields a key or measure can read: the list's columns, without the register's `createdAt` (it reads as last modified) and lookups (follow them instead). */
function groupChoices(desc: ObjectDescription, def: ResolvedObjectDef) {
  return [...listColumns(def).keys()]
    .filter((n) => groupableField(def, n) && !(desc.register && n === "createdAt") && def.byApiName.get(n)?.type !== "lookup" && !def.byApiName.get(n)?.hidden)
    .map((n) => ({ name: n, label: n === "recordTitle" ? "Name" : def.byApiName.get(n)?.label ?? (n === "createdAt" ? "Created" : n === "updatedAt" ? "Last modified" : n) }));
}

const isDateField = (def: ResolvedObjectDef | null, name: string) => {
  const f = def?.byApiName.get(name);
  return name === "createdAt" || name === "updatedAt" || f?.type === "date" || f?.type === "datetime" || (f?.type === "formula" && (f.returns === "date" || f.returns === "datetime"));
};

export function ReportBuilder() {
  const names = useObjectLabels();
  const [url, setUrl] = useUrlState({ report: "", view: "" });
  const reports = useQuery(api.reports.list);
  const customObjects = useQuery(api.customObjects.list);
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const me = useQuery(api.users.me);
  const active = reports?.find((r) => r._id === url.report) ?? null;
  const [spec, setSpec] = useState<ReportSpec>(() => defaultSpec("deal", null));
  const [dirty, setDirty] = useState(false);
  /** The filter bar's rows while edited; null shows the spec's filters, by whole day. */
  const [filters, setFilters] = useState<ViewFilter[] | null>(null);
  const [filterLoads, setFilterLoads] = useState(0);

  const { desc, def, relations, keyDescs } = useReportDescriptions(spec);

  // Opening a saved report loads its spec; "New report" starts from the default. Adjusted while rendering, not in an effect.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const load = needsLoad(loaded, url.report, active, dirty);
  if (load) {
    setLoaded(load);
    setSpec(active ? active.spec : defaultSpec(spec.object, null));
    setDirty(false);
    setFilters(null);
    setFilterLoads((n) => n + 1);
  }
  useEffect(() => {
    if (reports && url.report && !active) {
      void toast.info("That report is no longer available");
      setUrl({ report: "" });
    }
  }, [reports, url.report, active, setUrl]);

  const columns = useMemo(() => {
    const all = new Map(def ? listColumns(def) : []);
    if (desc?.register) all.delete("createdAt");
    return all;
  }, [def, desc?.register]);
  const dayColumns = useMemo(() => (def ? dayColumnsOf(def) : new Set<string>()), [def]);
  // The filter bar edits whole days; the spec stores the list request's filters, as a saved view does.
  const shownFilters = filters ?? collapseDayFilters(spec.filter, dayColumns);

  const edit = (patch: Partial<ReportSpec>) => {
    setSpec((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  };
  const editFilters = (next: ViewFilter[]) => {
    setFilters(next);
    edit({ filter: expandDayFilters(next.filter((f) => isComplete(f) && columns.has(f.field)), dayColumns) });
  };

  const run = useAction(api.reports.run);
  /** The last answer, and the spec it answers; while the spec differs, the previous answer stays on screen, dimmed. */
  const [answer, setAnswer] = useState<{ key: string; result?: RunResult; error?: string }>({ key: "" });
  const generation = useRef(0);
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    if (!def || def.apiName !== spec.object) return;
    const g = ++generation.current;
    const t = setTimeout(() => {
      run({ spec })
        .then((result) => { if (g === generation.current) setAnswer({ key: specKey, result }); })
        .catch((e) => { if (g === generation.current) setAnswer((cur) => ({ key: specKey, result: cur.result, error: getErrorMessage(e) })); });
    }, 250);
    return () => clearTimeout(t);
  }, [specKey, def]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = answer.result ?? null;
  const error = answer.key === specKey ? answer.error ?? "" : "";
  const loading = answer.key !== specKey;

  const presented = usePresented(result);
  // A click on a chart mark lists the records behind it.
  const [pick, setPick] = useState<RecordsPick | null>(null);
  const fieldOf = (name: string) => info(desc, name);
  const stages = url.view === "stages";
  const header = useReportHeader({
    spec, active: stages ? null : active, dirty, canChange: Boolean(active && (active.mine || me?.role === "admin")),
    onSaved: (id) => { setDirty(false); if (id !== undefined) setUrl({ report: id }); },
  });
  const newReport = { id: "report-new", label: "New report", icon: <Plus className="size-3.5" />, onClick: () => setUrl({ report: "", view: "" }) };

  return (
    <ViewFrame
      title={stages ? "Stage history and time in stage" : active ? active.name : "New report"}
      description={stages ? "From the ledger: every change of stage on your deals since Canon first saw each one."
        : [active?.recipe && `From customization ${active.recipe.id} v${active.recipe.version}.`, active && dirty && "Edited, not saved."].filter(Boolean).join(" ") || (active ? undefined : "Pick what to count and how to group it, then save it to share or pin.")}
      actions={stages ? [newReport] : [newReport, ...header.actions]}
      secondaryActions={stages ? undefined : header.pin}
      controls={stages ? undefined : header.form}
    >
    <div className="flex flex-col gap-6 lg:flex-row">
      <SavedList reports={reports} activeId={stages ? null : active?._id ?? null} stages={stages} onStages={() => setUrl({ report: "", view: "stages" })} onOpen={(id) => setUrl({ report: id, view: "" })} />
      {stages ? <div className="min-w-0 flex-1"><StageHistoryView /></div> : (
      <div className="min-w-0 flex-1 space-y-4">
        <section className="operator-panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="eyebrow text-muted-foreground">Report on</span>
            <SelectField
              aria-label="Object" value={spec.object}
              onValueChange={(v) => { setSpec(defaultSpec(v, null)); setFilters(null); setFilterLoads((n) => n + 1); setDirty(true); }}
              options={[
                ...STANDARD.map(([v, l]) => ({ value: v, label: names(v)?.pluralLabel ?? l })),
                ...(customObjects ?? []).filter((o) => !o.archived).map((o) => ({ value: o.apiName, label: o.pluralLabel })),
              ]}
            />
          </div>
          {desc && def ? (
            <>
              <FilterBar filters={shownFilters} columns={columns} dayColumns={dayColumns} canAdd={FILTERS_MAX - spec.filter.length >= 2} resetKey={filterLoads} fields={desc.fields} team={team} onChange={editFilters} />
              <GroupEditor spec={spec} desc={desc} def={def} relations={relations} keyDescs={keyDescs} onChange={(groupBy) => edit({ groupBy })} />
              <MeasureEditor spec={spec} desc={desc} def={def} onChange={(measures) => edit({ measures })} />
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="eyebrow mr-2 text-muted-foreground" title="A chart draws the first measure">Show as</span>
                {REPORT_CHARTS.map((c) => (
                  <button key={c} type="button" onClick={() => edit({ chart: c })} aria-pressed={spec.chart === c}
                    className={cn("border px-2 py-1", spec.chart === c ? "border-primary text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                    {CHART_LABEL[c]}
                  </button>
                ))}
              </div>
            </>
          ) : desc === null ? <p className="text-sm text-muted-foreground">That object is not available.</p> : <LoadingRows count={2} />}
        </section>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {presented ? (
          <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
            {spec.chart !== "table" && <section className="operator-panel p-4"><ReportChart p={presented} kind={result!.spec.chart} onPick={pickHandler(result!.spec, presented, fieldOf, setPick)} /></section>}
            <section className="operator-panel py-2"><ReportTable p={presented} /></section>
          </div>
        ) : !error && <LoadingRows count={3} />}
      </div>
      )}
    </div>
    {result && <ReportRecords spec={result.spec} pick={pick} fieldOf={fieldOf} onClose={() => setPick(null)} />}
    </ViewFrame>
  );
}

function SavedList({ reports, activeId, stages, onStages, onOpen }: {
  reports: SavedReport[] | undefined; activeId: string | null; stages: boolean; onStages: () => void; onOpen: (id: string) => void;
}) {
  return (
    <aside aria-label="Saved reports" className="w-full shrink-0 space-y-2 lg:w-56">
      <button type="button" onClick={onStages} className={cn("flex w-full items-center px-2 py-1 text-left text-sm", stages ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
        Stage history and time in stage
      </button>
      {reports === undefined ? <LoadingRows count={2} /> : reports.length === 0 ? (
        <p className="text-xs text-muted-foreground">No saved reports yet.</p>
      ) : (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto lg:max-h-none">
          {reports.map((r) => (
            <li key={r._id}>
              <button type="button" onClick={() => onOpen(r._id)} className={cn("flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm", r._id === activeId ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {r.shared && <Share2 aria-label="Shared" className="h-3 w-3 shrink-0" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** The report's page actions (save, rename, share, delete), its pin control, and the naming form they open under the header. */
function useReportHeader({ spec, active, dirty, canChange, onSaved }: { spec: ReportSpec; active: SavedReport | null; dirty: boolean; canChange: boolean; onSaved: (id?: string) => void }) {
  const create = useMutation(api.reports.create);
  const update = useMutation(api.reports.update);
  const remove = useMutation(api.reports.remove);
  const [naming, setNaming] = useState<{ name: string; shared: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      void toast.success(done);
    } catch (e) {
      void toast.error(getErrorMessage(e));
      throw e;
    }
  };
  const id = active?._id as Id<"reports"> | undefined;
  const saveAsNew = () => { setRenaming(null); setNaming({ name: active ? `${active.name} (copy)` : "", shared: false }); };
  const actions: ViewAction[] = active && id ? [
    ...(canChange ? [
      { id: "report-rename", label: "Rename", onClick: () => { setNaming(null); setRenaming(active.name); } },
      { id: "report-share", label: active.shared ? "Make private" : "Share", onClick: () => void act(() => update({ reportId: id, shared: !active.shared }), active.shared ? "Now private" : "Shared with the workspace") },
      confirming
        ? { id: "report-delete", label: "Delete for good", icon: <Trash2 className="size-3.5" />, onClick: () => void act(() => remove({ reportId: id }), "Report deleted").then(() => { setConfirming(false); onSaved(""); }) }
        : { id: "report-delete", label: "Delete", icon: <Trash2 className="size-3.5" />, onClick: () => setConfirming(true) },
    ] : []),
    { id: "report-save-as", label: "Save as new", primary: !canChange, icon: <Save className="size-3.5" />, onClick: saveAsNew },
    ...(canChange ? [{ id: "report-save", label: "Save", primary: true, icon: <Save className="size-3.5" />, disabled: !dirty, onClick: () => void act(() => update({ reportId: id, spec }), "Saved").then(() => onSaved()) }] : []),
  ] : [{ id: "report-save-new", label: "Save report", primary: true, icon: <Save className="size-3.5" />, onClick: saveAsNew }];

  const form = renaming !== null && id ? (
    <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); void act(() => update({ reportId: id, name: renaming }), "Renamed").then(() => setRenaming(null)); }}>
      <input aria-label="Report name" autoFocus className={cn(control, "text-sm")} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
      <button type="submit" className="border border-primary px-2 py-1">Rename</button>
      <button type="button" onClick={() => setRenaming(null)} className="text-muted-foreground">Cancel</button>
    </form>
  ) : naming ? (
    <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => {
      e.preventDefault();
      void act(async () => onSaved(await create({ name: naming.name, shared: naming.shared, spec })), "Report saved").then(() => setNaming(null));
    }}>
      <input aria-label="New report name" autoFocus placeholder="Report name" className={cn(control, "text-sm")} value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} />
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={naming.shared} onChange={(e) => setNaming({ ...naming, shared: e.target.checked })} /> Share with workspace</label>
      <button type="submit" className="border border-primary px-2 py-1">Save</button>
      <button type="button" onClick={() => setNaming(null)} className="text-muted-foreground">Cancel</button>
    </form>
  ) : null;

  return { actions, form, pin: active ? <PinControl key={active._id} reportId={active._id as Id<"reports">} /> : null };
}

function GroupEditor({ spec, desc, def, relations, keyDescs, onChange }: {
  spec: ReportSpec; desc: ObjectDescription; def: ResolvedObjectDef; relations: ReturnType<typeof relationsOf>;
  keyDescs: readonly (ObjectDescription | null | undefined)[]; onChange: (g: ReportSpec["groupBy"]) => void;
}) {
  const set = (i: number, g: ReportSpec["groupBy"][number]) => onChange(spec.groupBy.map((x, j) => (j === i ? g : x)));
  const own = groupChoices(desc, def);
  return (
    <div className="flex flex-col gap-2 text-xs">
      {spec.groupBy.map((g, i) => {
        const d = keyDescs[i];
        const kdef = defOf(d);
        const choices = d && kdef ? groupChoices(d, kdef) : [];
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="eyebrow w-20 text-muted-foreground">{i === 0 ? "Group by" : "Then by"}</span>
            <SelectField aria-label={`Group ${i + 1} source`} value={g.via ?? ""} onValueChange={(v) => {
              const via = v || undefined;
              set(i, via ? { field: "recordTitle", via } : { field: own[0]?.name ?? "recordTitle" });
            }}
              options={[{ value: "", label: desc.label }, ...relations.map((r) => ({ value: r.via, label: r.label }))]} />
            <SelectField aria-label={`Group ${i + 1} field`} value={g.field} onValueChange={(v) => set(i, { field: v, ...(g.via ? { via: g.via } : {}) })}
              options={[
                ...(choices.some((c) => c.name === g.field) ? [] : [{ value: g.field, label: g.field }]),
                ...choices.map((c) => ({ value: c.name, label: c.label })),
              ]} />
            {isDateField(kdef, g.field) && (
              <SelectField aria-label={`Group ${i + 1} bucket`} value={g.bucket ?? "month"} onValueChange={(v) => set(i, { ...g, bucket: v as ReportBucket })}
                options={REPORT_BUCKETS.map((b) => ({ value: b, label: `by ${b}` }))} />
            )}
            <button type="button" aria-label="Remove group" onClick={() => onChange(spec.groupBy.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
        );
      })}
      {spec.groupBy.length < GROUP_BY_MAX && own.length > 0 && (
        <button type="button" onClick={() => onChange([...spec.groupBy, { field: own.find((c) => !spec.groupBy.some((g) => !g.via && g.field === c.name))?.name ?? own[0].name }])}
          className="inline-flex w-fit items-center gap-1 border border-dashed border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <Plus className="h-3 w-3" /> Add grouping
        </button>
      )}
    </div>
  );
}

function MeasureEditor({ spec, desc, def, onChange }: { spec: ReportSpec; desc: ObjectDescription; def: ResolvedObjectDef; onChange: (m: ReportSpec["measures"]) => void }) {
  const numbers = [...listColumns(def).keys()].filter((n) => measurableField(def, n)).map((n) => ({ name: n, label: desc.fields.find((f) => f.apiName === n)?.label ?? n }));
  const set = (i: number, m: ReportSpec["measures"][number]) => onChange(spec.measures.map((x, j) => (j === i ? m : x)));
  return (
    <div className="flex flex-col gap-2 text-xs">
      {spec.measures.map((m, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="eyebrow w-20 text-muted-foreground">{i === 0 ? "Measure" : "And"}</span>
          <SelectField aria-label={`Measure ${i + 1}`} value={m.fn} onValueChange={(v) => {
            const fn = v as MeasureFn;
            set(i, fn === "count" ? { fn } : { fn, field: m.field ?? numbers[0]?.name });
          }}
            options={(Object.keys(FN_LABEL) as MeasureFn[]).filter((fn) => fn === "count" || numbers.length).map((fn) => ({ value: fn, label: FN_LABEL[fn] }))} />
          {m.fn !== "count" && (
            <SelectField aria-label={`Measure ${i + 1} field`} value={m.field ?? ""} onValueChange={(v) => set(i, { fn: m.fn, field: v })}
              options={numbers.map((n) => ({ value: n.name, label: n.label }))} />
          )}
          {spec.measures.length > 1 && <button type="button" aria-label="Remove measure" onClick={() => onChange(spec.measures.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
        </div>
      ))}
      {spec.measures.length < MEASURES_MAX && (
        <button type="button" onClick={() => onChange([...spec.measures, numbers[0] ? { fn: "sum", field: numbers[0].name } : { fn: "count" }])}
          className="inline-flex w-fit items-center gap-1 border border-dashed border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <Plus className="h-3 w-3" /> Add measure
        </button>
      )}
    </div>
  );
}

/** Pin the saved report's chart to one of the caller's dashboards, or to a new one. */
function PinControl({ reportId }: { reportId: Id<"reports"> }) {
  const dashboards = useQuery(api.dashboards.list);
  const pin = useMutation(api.dashboards.pin);
  const [naming, setNaming] = useState<string | null>(null);
  const mine = (dashboards ?? []).filter((d) => d.mine);
  const done = (id: string, name: string) => toast.success(`Pinned to ${name}`, { action: { label: "Open", onClick: () => { window.location.href = `/dashboard/dashboards?d=${id}`; } } });
  if (naming !== null) {
    return (
      <form className="flex items-center gap-1" onSubmit={(e) => {
        e.preventDefault();
        pin({ reportId, name: naming }).then((id) => { setNaming(null); done(id, naming); }).catch((err) => void toast.error(getErrorMessage(err)));
      }}>
        <input aria-label="New dashboard name" autoFocus placeholder="Dashboard name" className={control} value={naming} onChange={(e) => setNaming(e.target.value)} />
        <button type="submit" className="border border-primary px-2 py-1">Pin</button>
        <button type="button" onClick={() => setNaming(null)} className="text-muted-foreground">Cancel</button>
      </form>
    );
  }
  return (
    <SelectField aria-label="Pin to dashboard" value="" onValueChange={(v) => {
      if (v === "new") return setNaming("");
      const d = mine.find((x) => x._id === v);
      if (d) pin({ reportId, dashboardId: d._id }).then(() => done(d._id, d.name)).catch((err) => void toast.error(getErrorMessage(err)));
    }}
      options={[
        { value: "", label: "Pin…" },
        ...mine.map((d) => ({ value: d._id, label: d.name })),
        { value: "new", label: "New dashboard…" },
      ]} />
  );
}
