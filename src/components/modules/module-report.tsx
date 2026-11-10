"use client";

/**
 * A module page's reports, charts and trees (docs/modules.md, "Reports and charts"). A report reads through
 * api.modules.report, which answers over every doc of its collection the caller reads (the record service's
 * projection, scoped on the server); it is drawn with Canon's own report table and charts (components/reports).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDown, ChevronRight, Download, GripVertical, Save, Share2, Trash2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { FILTERS_MAX, listColumns } from "../../../convex/lib/objects/listSpec";
import { bucketStart, MEASURES_MAX, type AggregateGroup } from "../../../convex/lib/objects/reportSpec";
import type { ReportBucket, ReportChart as ChartKind } from "../../../modules/kernel/reportLanguage";
import { moduleReportDef } from "../../../convex/lib/objects/moduleReport";
import { collapseDayFilters, dayColumnsOf, expandDayFilters } from "../../../convex/lib/objects/views";
import type { ReportSpec, ViewFilter } from "../../../modules/kernel/reportValidators";
import type { CANON_PAGES, Node, ReportKey, ReportShape } from "../../../modules/kernel/manifest";
import { expandSources, isMeasure, recordObjectName, unfilterable, type ReportField } from "../../../modules/kernel/reports";
import { valueAt, type Doc, type TextScope } from "../../../modules/kernel/text";
import { present, type FieldInfo, type Presented } from "@/components/reports/present";
import { ReportChart, WaterfallChart, type ChartPick, type Tone } from "@/components/reports/report-chart";
import { waterfall, waterfallFigure } from "@/lib/waterfall";
import { ReportTable, sortPresented, type ReportSort } from "@/components/reports/report-table";
import { serializeCsvRows } from "@/lib/csv-export";
import { DateRangeInput } from "./date-range-input";
import { xlsx, type CellKind } from "../../../modules/kernel/xlsx";
import { FilterBar, isComplete } from "@/components/records/filter-bar";
import { recordHref } from "@/components/records/record-target";
import type { FieldDescription } from "@/components/records/fields";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField } from "@/components/ui/select";
import { chartFit } from "@/lib/chart-fit";
import { scopeOwners } from "@/lib/report-scope";
import { pickHandler, ReportRecords, type RecordsPick } from "@/components/reports/report-records";
import { rangeText } from "@/lib/date-range-text";
import { foldTop } from "@/lib/fold-top";
import { change, previousPeriod } from "@/lib/period-compare";
import { metricName, presetMetrics, suggestedMetrics, whereText, type Preset } from "@/lib/metric-names";
import { MetricChip } from "./metric-chip";
import { heat, PALETTES, PALETTE_LABEL, ranges, type PaletteName } from "@/lib/chart-style";
import { moveAt, moveKey, type KeyList } from "@/lib/report-layout";
import { FieldPicker } from "./field-picker";
import { ChartPicker } from "./chart-picker";
import { variantOf, variantWhy, withVariant } from "@/lib/chart-variants";
import { reportSentence } from "@/lib/report-sentence";
import { ModulePinControl } from "./module-pin-control";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

type Run = FunctionReturnType<typeof api.modules.report>;
type Of<C extends Node["c"]> = Extract<Node, { c: C }>;
export type Palette = { fields: ReportField[]; none: boolean; title?: string };
export type ReportEnv = { module: string; dashboards?: string | null; readOnly?: boolean; members: ReadonlyArray<{ id: string; name: string }>; palette: Readonly<Record<string, Palette>>; query: Readonly<Record<string, string>>; setQuery: (c: Record<string, string | null>) => void; fiscalYearStartMonth?: number };

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const eyebrow = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
/** A row of the inspector's lists: a dimension or a value with its controls. */
const item = "flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm";
/** One option of a two-way toggle (Down / Across, Left / Right). */
const seg = (on: boolean) => cn("px-1.5 py-0.5 disabled:opacity-40", on ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground");
const CHARTS: Array<{ value: ChartKind; label: string }> = [
  { value: "table", label: "Table" }, { value: "bar", label: "Bars" }, { value: "column", label: "Columns" }, { value: "line", label: "Line" }, { value: "area", label: "Area" },
  { value: "pie", label: "Pie" }, { value: "number", label: "Number" },
];

const keyOf = (k: ReportKey) => (typeof k === "string" ? { field: k } : { field: k.field, ...(k.bucket ? { bucket: k.bucket } : {}) });
/** The spec a report or a chart opens with: its rows then its columns as group keys, its values (a count when none). */
export function specOf(shape: ReportShape, chart: ChartKind = "table"): ReportSpec {
  return {
    object: shape.collection, filter: [], chart,
    groupBy: [...(shape.rows ?? []), ...(shape.columns ?? [])].map(keyOf),
    measures: (shape.values ?? [{ fn: "count" as const }]).map((v) => ({ fn: v.fn, ...(v.field ? { field: v.field } : {}) })),
  };
}

/** A result as Canon's report table and charts read it: each key's and measure's label and type, members by name. */
function presentRun(run: Run, members: ReportEnv["members"], records = "records"): Presented {
  const byName = new Map<string, FieldInfo>(run.fields.map((f) => [f.name, { label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}) }]));
  byName.set("createdAt", { label: "Created", type: "datetime" });
  byName.set("updatedAt", { label: "Last modified", type: "datetime" });
  const p = present(run.spec, run, run.spec.groupBy.map((g) => byName.get(g.field)), run.spec.measures.map((m) => (m.field ? byName.get(m.field) : undefined)), members.map((m) => ({ _id: m.id, name: m.name })));
  // Metrics read in plain words ("Total amount", "Number of deals"), as the builder names them.
  const named = { ...p, measureLabels: run.spec.measures.map((m) => metricName(m, byName.get(m.field ?? "")?.label ?? m.field ?? "", records)) };
  return shared(leadPaired(named), run.spec.display?.shares);
}

/**
 * Values shown as their share of the total (`display.shares`, per value): each group's and subtotal's over the grand
 * total of that value, as a percent ("% of Reps"). A value whose total is 0 or none shows none.
 */
function shared(p: Presented, shares: readonly boolean[] | undefined): Presented {
  if (!shares?.some(Boolean)) return p;
  const over = (values: readonly (number | null)[]) => values.map((v, i) => (!shares[i] ? v : v === null || !p.total[i] ? null : v / p.total[i]!));
  const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  return {
    ...p,
    measureLabels: p.measureLabels.map((l, i) => (shares[i] ? `% of ${l}` : l)),
    groups: p.groups.map((g) => ({ ...g, values: over(g.values) })),
    subtotals: p.subtotals.map((g) => ({ ...g, values: over(g.values) })),
    total: p.total.map((v, i) => (shares[i] && v ? 1 : v)),
    format: (i, v) => (shares[i] ? pct(v) : p.format(i, v)),
    formatCompact: (i, v) => (shares[i] ? pct(v) : p.formatCompact(i, v)),
    additive: shares[0] ? true : p.additive,
  };
}

/**
 * Three keys read as two: the first two paired ("Ana · Done") down a matrix's rows or a chart's axis, the third across
 * its columns or stacked as its series. The service's subtotals are already per pair.
 */
function leadPaired(p: Presented): Presented {
  if (p.keyLabels.length !== 3) return p;
  const pair = (g: Presented["groups"][number]) => ({ keys: [JSON.stringify(g.keys.slice(0, 2)), ...g.keys.slice(2)], labels: [g.labels.slice(0, 2).join(" · "), ...g.labels.slice(2)], values: g.values });
  return { ...p, keyLabels: [p.keyLabels.slice(0, 2).join(" · "), p.keyLabels[2]], groups: p.groups.map(pair), subtotals: p.subtotals.map(pair) };
}

/** Run a report whenever its spec changes. A failed or initializing projection has no displayed counts. */
function useReportRun(module: string, spec: ReportSpec | null, reportId?: Id<"reports">) {
  const run = useAction(api.modules.report);
  const retryReports = useMutation(api.modules.retryReports);
  const [answer, setAnswer] = useState<{ key: string; result?: Run; error?: string; syncing?: boolean }>({ key: "" });
  const key = JSON.stringify([module, spec, reportId]);
  const failed = (e: unknown) => {
    const error = getErrorMessage(e);
    return { key, error, syncing: error.includes("report projection") };
  };
  const generation = useRef(0);
  useEffect(() => {
    if (!spec) return;
    const g = ++generation.current;
    const t = setTimeout(() => {
      run({ module, ...(reportId ? { reportId } : { spec }) })
        .then((result) => { if (g === generation.current) setAnswer({ key, result }); })
        .catch((e) => { if (g === generation.current) setAnswer(failed(e)); });
    }, 200);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Docs still on their way to the record service: ask again until the answer has them all.
  const behind = answer.key === key && (answer.result?.behind === true || answer.syncing === true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!behind || !spec) return;
    const g = generation.current;
    const t = setTimeout(() => { run({ module, ...(reportId ? { reportId } : { spec }) }).then((result) => { if (g === generation.current) setAnswer({ key, result }); }).catch((e) => { if (g === generation.current) setAnswer(failed(e)); }).finally(() => setTick((x) => x + 1)); }, 2000);
    return () => clearTimeout(t);
  }, [behind, key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { result: answer.key === key ? answer.result ?? null : null, error: answer.key === key ? answer.error ?? "" : "", loading: answer.key !== key, retry: answer.key === key && answer.syncing && spec && !spec.object.startsWith("canon.") ? () => retryReports({ module, collection: spec.object }) : undefined };
}

/**
 * Two keys as a matrix: the first down the rows, the second across, each cell its measures; totals along both. A click
 * on a column's header sorts the rows by that column's first value (highest first, then lowest), on the corner by name.
 */
function PivotTable({ p: shown, fns, rowNumbers, heatmap }: { p: Presented; fns: readonly string[]; rowNumbers?: boolean; heatmap?: boolean }) {
  const p = { ...shown, measureFns: fns };
  // The heatmap tints a cell by its first metric's place among every cell's.
  const span = heatmap ? ranges(p.groups.map((g) => [g.values[0]]), 1)[0] : null;
  const [order, setOrder] = useState<{ col: string | null; dir: "asc" | "desc" } | null>(null);
  const cols: Array<{ k: string; label: string }> = [];
  for (const g of p.groups) { const k = JSON.stringify(g.keys[1]); if (!cols.some((c) => c.k === k)) cols.push({ k, label: g.labels[1] }); }
  const cell = (values: readonly (number | null)[] | undefined) => (values ? values.map((v, i) => <div key={i} className={i ? "text-xs text-muted-foreground" : ""}>{p.format(i, v)}</div>) : <span className="text-muted-foreground">-</span>);
  const tint = (values: readonly (number | null)[] | undefined) => (span && values ? { background: `rgb(46 130 89 / ${heat(values[0], span.min, span.max)})` } : undefined);
  // A column's total adds up only a count or a sum; an average, min or max of groups isn't the column's, so none shows.
  const columnTotal = (k: string) => p.measureFns.map((fn, i) => {
    if (fn !== "count" && fn !== "sum") return null;
    return p.groups.filter((g) => JSON.stringify(g.keys[1]) === k).map((g) => g.values[i]).reduce<number | null>((s, v) => (v === null ? s : (s ?? 0) + v), null);
  });
  const at = (k0: string, k: string) => p.groups.find((g) => JSON.stringify(g.keys[0]) === k0 && JSON.stringify(g.keys[1]) === k)?.values;
  const rowsShown = order === null ? p.subtotals : [...p.subtotals].sort((a, b) => {
    const sign = order.dir === "asc" ? 1 : -1;
    if (order.col === null) return a.labels[0].localeCompare(b.labels[0]) * sign;
    const va = (order.col === "#total" ? a.values : at(JSON.stringify(a.keys[0]), order.col))?.[0] ?? null;
    const vb = (order.col === "#total" ? b.values : at(JSON.stringify(b.keys[0]), order.col))?.[0] ?? null;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * sign;
  });
  const sortBy = (col: string | null) => setOrder((o) => {
    const first = col === null ? "asc" : "desc";
    return o?.col !== col ? { col, dir: first } : o.dir === first ? { col, dir: first === "asc" ? "desc" : "asc" } : null;
  });
  const mark = (col: string | null) => (order?.col === col ? (order.dir === "asc" ? " ↑" : " ↓") : "");
  const aria = (col: string | null) => (order?.col === col ? (order.dir === "asc" ? "ascending" : "descending") : undefined);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-muted-foreground">
            {rowNumbers && <th className="w-10 px-2 py-2 font-normal" aria-label="Row" />}
            <th className="px-3 py-2 font-normal" aria-sort={aria(null)}><button type="button" className="hover:text-foreground" onClick={() => sortBy(null)}>{p.keyLabels[0]} \ {p.keyLabels[1]}{mark(null)}</button></th>
            {cols.map((c) => <th key={c.k} className="px-3 py-2 text-right font-normal" aria-sort={aria(c.k)}><button type="button" className="hover:text-foreground" onClick={() => sortBy(c.k)}>{c.label}{mark(c.k)}</button></th>)}
            <th className="px-3 py-2 text-right font-normal" aria-sort={aria("#total")}><button type="button" className="hover:text-foreground" onClick={() => sortBy("#total")}>Total{mark("#total")}</button></th>
          </tr>
        </thead>
        <tbody>
          {rowsShown.map((s, r) => {
            const k0 = JSON.stringify(s.keys[0]);
            return (
              <tr key={k0} className="border-t border-border/60">
                {rowNumbers && <td className="w-10 px-2 py-1.5 text-right text-xs text-muted-foreground tabular-nums">{r + 1}</td>}
                <td className="px-3 py-1.5">{s.labels[0]}</td>
                {cols.map((c) => <td key={c.k} className="px-3 py-1.5 text-right tabular-nums" style={tint(at(k0, c.k))}>{cell(at(k0, c.k))}</td>)}
                <td className="px-3 py-1.5 text-right font-medium tabular-nums">{cell(s.values)}</td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-border font-semibold">
            {rowNumbers && <td />}
            <td className="px-3 py-2">Total</td>
            {cols.map((c) => <td key={c.k} className="px-3 py-2 text-right tabular-nums">{cell(columnTotal(c.k))}</td>)}
            <td className="px-3 py-2 text-right tabular-nums">{cell(p.total)}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-3 pt-2 text-xs text-muted-foreground">{p.measureLabels.join(" · ")}{p.truncated ? " (showing top groups). The totals count every doc." : ""}</p>
    </div>
  );
}

/** A field picked to add. */
type Dragged = { kind: "dimension" | "measure"; name: string; fn?: "count" | "sum" | "avg" | "min" | "max"; preset?: Preset };
/** Charts that draw several values side by side, each on its axis: a second axis and a value as a line over columns. */
const AXES_CHARTS: readonly ChartKind[] = ["column", "line", "area"];
const isDateType = (type: string | undefined) => type === "date" || type === "datetime";
/** A palette's dimensions in sections a person scans: people, time, what a ref names, then the rest. */
function sectionsOf(dims: readonly ReportField[]): Array<{ label: string; fields: ReportField[] }> {
  const people = dims.filter((f) => f.type === "user" || f.join?.to === "users" || f.ref?.to === "users");
  const time = dims.filter((f) => !people.includes(f) && isDateType(f.type));
  const related = dims.filter((f) => !people.includes(f) && !time.includes(f) && (f.join || f.ref || f.related));
  const rest = dims.filter((f) => !people.includes(f) && !time.includes(f) && !related.includes(f));
  return [{ label: "People", fields: people }, { label: "Time", fields: time }, { label: "Related", fields: related }, { label: "Fields", fields: rest }].filter((s) => s.fields.length);
}
/** A date filter's value: a day as text for a date field, a time in ms (the day's start, or its end) for a time. */
const dayValue = (type: string, day: string, end: boolean) => (type === "datetime" ? Date.parse(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}Z`) : day);
const dayOf = (v: unknown) => (typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);

/**
 * A report builder over one or several collections: a live preview (a one-line sentence of the report, axis and value
 * pills, the chart and a table with totals) beside an inspector. Its Data tab picks the source, adds that source's
 * dimensions and measures (in sections: people, time, related, fields), lays each dimension down the rows or across the
 * columns, and holds the filters and a date range in presets or words; its Chart tab picks the chart (bars, columns side
 * by side or stacked, lines, areas, a second axis). A report reads one source. A person saves versions of it, theirs or
 * shared with the workspace; the URL names the one open (`?<id>.saved=`), so a link reopens it.
 */
export function ModuleReport({ n, env }: { n: Of<"report">; env: ReportEnv }) {
  // `canon.*` is every Canon object the module reports on in this workspace, each with its palette.
  const sources = useMemo(() => expandSources([n.collection, ...(n.sources ?? [])], Object.keys(env.palette)).filter((c) => env.palette[c]), [n.collection, n.sources, env.palette]);
  // A link may open the report with a shape of its own (`?<id>.config=`, a chart's Explore): it starts there instead.
  const configRaw = env.query[`${n.id}.config`] ?? "";
  const config = useMemo(() => linkedShape(configRaw), [configRaw]);
  const declared = useMemo(() => (config ? { ...n, rows: config.rows, columns: config.columns, values: config.values ?? n.values } : n), [n, config]);
  const initial = useMemo((): ReportSpec => {
    const d = n.display;
    const display = d ? { ...(d.stacked !== undefined ? { stacked: d.stacked } : {}), ...(d.axes ? { axes: [...d.axes] } : {}), ...(d.types ? { types: [...d.types] } : {}), ...(d.shares ? { shares: [...d.shares] } : {}) } : undefined;
    return { ...specOf(declared, config?.chart ?? n.chart ?? "table"), ...(display ? { display } : {}) };
  }, [declared, config, n.chart, n.display]);
  const [spec, setSpec] = useState<ReportSpec>(initial);
  const [columnsAt, setColumnsAt] = useState<number>((declared.columns ?? []).length ? (declared.rows ?? []).length : -1);
  const [filters, setFilters] = useState<ViewFilter[] | null>(null);
  const [filterLoads, setFilterLoads] = useState(0);
  const [dirty, setDirty] = useState(false);
  const param = `${n.id}.saved`;
  const legacyId = ["reports", "@canon/reports"].includes(env.module) && n.id === "deals" ? env.query.report : undefined;
  const savedId = env.query[param] ?? legacyId ?? "";
  useEffect(() => {
    if (legacyId) env.setQuery({ [param]: env.query[param] ?? legacyId, report: null });
  }, [legacyId, param, env]);
  const saved = useQuery(api.modules.savedReports, { module: env.module, report: n.id });
  const active = saved?.find((r) => r._id === savedId) ?? null;
  // Opening a saved version loads its spec; leaving one returns to the report as declared. Unsaved edits to the open
  // one stay until it is left (a save elsewhere doesn't discard them).
  const [loaded, setLoaded] = useState("");
  const next = active ? `${active._id}:${JSON.stringify(active.spec)}` : savedId ? "" : `declared:${configRaw}`;
  if (next && next !== loaded && !(dirty && loaded.startsWith(`${savedId}:`))) {
    const s = active ? active.spec : initial;
    setLoaded(next);
    setSpec(s);
    setColumnsAt(active ? (s.groupBy.length >= 2 ? s.groupBy.length - 1 : -1) : (declared.columns ?? []).length ? (declared.rows ?? []).length : -1);
    setFilters(null);
    setFilterLoads((x) => x + 1);
    setDirty(false);
  }

  const palette = env.palette[spec.object];
  // Filters read the doc's own fields; a joined one (a deal's stage) groups but doesn't filter, nor does a weighted amount.
  // The report definition already supplies its name and timestamps as system columns.
  const def = useMemo(() => moduleReportDef(spec.object, (palette?.fields ?? []).filter((f) => !f.join && !unfilterable(f) && f.name !== "recordTitle" && f.name !== "createdAt" && f.name !== "updatedAt")), [spec.object, palette]);
  const columns = useMemo(() => listColumns(def), [def]);
  const dayColumns = useMemo(() => dayColumnsOf(def), [def]);
  // Me · My team · Everyone: the owner field limited to whose records the viewer asked for (report-scope.ts), resolved
  // for whoever opens the report, so a shared "My team" report shows each viewer their own team.
  const me = useQuery(api.users.me);
  const users = useQuery(api.users.list);
  const ownerField = palette?.fields.find((f) => f.name === "ownerId" && f.type === "user")?.name;
  const runSpec = useMemo((): ReportSpec | null => {
    if (!spec.whose || !ownerField) return spec;
    if (!me || !users) return null;
    const owners = scopeOwners(spec.whose, me._id, users.map((u) => ({ _id: u._id, managerId: u.managerId ?? null })));
    return { ...spec, filter: [...spec.filter, { field: ownerField, op: "in", value: owners }] };
  }, [spec, ownerField, me, users]);
  const { result, error, loading, retry } = useReportRun(env.module, palette && !palette.none ? runSpec : null);
  // A deals chart by stage colors won stages green and lost ones gray (report-chart's tone), from the workspace's stages.
  const pipelines = useQuery(api.pipelines.list, spec.object === "canon.deals" && spec.groupBy[0]?.field === "stage" ? {} : "skip");
  const tone = useMemo((): Tone | undefined => {
    if (!pipelines) return undefined;
    const outcome = new Map(pipelines.flatMap((pl) => pl.stages.map((st) => [st.value, st.forecastCategory] as const)));
    return (k) => { const c = typeof k === "string" ? outcome.get(k) : undefined; return c === "closed_won" ? "won" : c === "closed_lost" ? "lost" : c ? "open" : undefined; };
  }, [pipelines]);
  // A click on a bar, slice or point lists the records behind it, where the source is Canon's own records.
  const [pick, setPick] = useState<RecordsPick | null>(null);
  const p = useMemo(() => (result ? presentRun(result, env.members, env.palette[result.spec.object]?.title ?? "records") : null), [result, env.members, env.palette]);
  const save = useMutation(api.modules.saveReport);
  const remove = useMutation(api.modules.removeReport);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState(false);
  // The results table's sort, a header click away; a new shape starts unsorted.
  const [sort, setSort] = useState<ReportSort | null>(null);
  const shapeKey = JSON.stringify([spec.groupBy, spec.measures]);
  const [sortedFor, setSortedFor] = useState(shapeKey);
  if (sortedFor !== shapeKey) { setSortedFor(shapeKey); setSort(null); }
  const sorted = useMemo(() => (p ? sortPresented(p, sort) : null), [p, sort]);
  // A row being dragged in the inspector's lists, and the row it is over (where it lands).
  const [drag, setDrag] = useState<{ list: KeyList | "values"; i: number } | null>(null);
  const [over, setOver] = useState<{ list: KeyList | "values"; i: number } | null>(null);
  // The date range filters one of the source's own dates: the first, unless the person picks another.
  const dateFields = useMemo(() => [...(palette?.fields ?? []).filter((f) => !f.join && !f.related && isDateType(f.type) && f.name !== "createdAt").map((f) => ({ name: f.name, label: f.label, type: f.type })), { name: "createdAt", label: "Created", type: "datetime" }], [palette]);
  const [rangeField, setRangeField] = useState("");
  const range = dateFields.find((f) => f.name === rangeField) ?? dateFields[0];
  // "vs previous period": the report's totals over the period just before its date range (period-compare.ts).
  const today = new Date().toISOString().slice(0, 10);
  const prev = useMemo(() => {
    if (!range || !runSpec || !runSpec.measures.some((m) => m.compare === "prev")) return null;
    const ranged = (f: ViewFilter) => f.field === range.name && (f.op === "gte" || f.op === "lte");
    const from = dayOf(runSpec.filter.find((f) => ranged(f) && f.op === "gte")?.value), to = dayOf(runSpec.filter.find((f) => ranged(f) && f.op === "lte")?.value);
    if (!from || !to) return null;
    const period = previousPeriod(from, to, today);
    const { display: _display, ...rest } = runSpec;
    const filter = [...runSpec.filter.filter((f) => !ranged(f)), { field: range.name, op: "gte" as const, value: dayValue(range.type, period.from, false) }, { field: range.name, op: "lte" as const, value: dayValue(range.type, period.to, true) }];
    return { period, spec: { ...rest, filter, groupBy: [], chart: "table" as const } };
  }, [runSpec, range, today]);
  const prevRun = useReportRun(env.module, palette && !palette.none && prev ? prev.spec : null);
  // A chart of many groups shows the largest and an Other (fold-top.ts); the table keeps every one.
  const chartP = useMemo(() => (p ? foldTop(p, spec.measures.map((m) => m.fn), 10, !!spec.groupBy[0]?.bucket) : null), [p, spec.measures, spec.groupBy]);

  if (!palette) return null;
  if (palette.none && sources.length < 2) return <p className="text-sm text-muted-foreground">You don&apos;t read any {n.title?.toLowerCase() ?? "docs"} this report counts.</p>;
  const fields = palette.fields;
  const fieldOf = (f: string) => fields.find((x) => x.name === f);
  const edit = (next: Partial<ReportSpec>) => { setSpec((s) => ({ ...s, ...next })); setDirty(true); };
  const rows = columnsAt >= 0 ? spec.groupBy.slice(0, columnsAt) : spec.groupBy;
  const cols = columnsAt >= 0 ? spec.groupBy.slice(columnsAt) : [];
  const setKeys = (r: ReportSpec["groupBy"], c: ReportSpec["groupBy"]) => { edit({ groupBy: [...r, ...c] }); setColumnsAt(c.length ? r.length : -1); };
  const dateKey = (name: string) => isDateType(fieldOf(name)?.type ?? (name === "createdAt" || name === "updatedAt" ? "datetime" : ""));
  const keyFor = (name: string) => ({ field: name, ...(dateKey(name) ? { bucket: "month" as ReportBucket } : {}) });
  // The range's filters live in the spec (a saved report keeps them); the filter bar shows the rest.
  const isRange = (f: ViewFilter) => !!range && f.field === range.name && (f.op === "gte" || f.op === "lte");
  const rangeFilters = spec.filter.filter(isRange);
  const otherFilters = spec.filter.filter((f) => !isRange(f));
  const rangeValue = rangeFilters.length ? { from: dayOf(rangeFilters.find((f) => f.op === "gte")?.value), to: dayOf(rangeFilters.find((f) => f.op === "lte")?.value) } : null;
  // A report reads one source, picked under Data source: switching starts the report over on the new one's fields.
  const switchTo = (source: string) => {
    if (source === spec.object) return;
    setSpec((s) => ({ ...s, object: source, filter: [], groupBy: [], measures: [{ fn: "count" }] }));
    setColumnsAt(-1); setFilters(null); setFilterLoads((x) => x + 1); setDirty(true);
  };
  /** Add a field of the report's source: a dimension to the rows (or the columns), a measure to the values. */
  const drop = (to: "rows" | "columns" | "values", d: Dragged) => {
    if (to === "values") {
      const value: ReportSpec["measures"][number] = d.preset ? d.preset : d.kind === "measure" && d.name !== "#count" ? { fn: d.fn ?? "sum", field: d.name } : { fn: "count" as const };
      if (spec.measures.length >= MEASURES_MAX) return toast.error(`A report measures at most ${MEASURES_MAX} values.`);
      return edit({ measures: [...spec.measures, value] });
    }
    if (d.kind !== "dimension") return toast.error("Drop a measure on Values.");
    const r = rows.filter((g) => g.field !== d.name), c = cols.filter((g) => g.field !== d.name);
    // Group by (the rows) holds two dimensions, Split by (the columns) one: a third added splits the report.
    if (to === "columns") return setKeys(r, [keyFor(d.name)]);
    if (r.length >= 2) return c.length ? toast.error("Group by and Split by are full: remove a field to add another.") : setKeys(r, [keyFor(d.name)]);
    setKeys([...r, keyFor(d.name)], c);
  };
  const labelOf = (f: string) => fieldOf(f)?.label ?? (f === "createdAt" ? "Created" : f === "updatedAt" ? "Last modified" : f);
  const shownFilters = filters ?? collapseDayFilters(otherFilters, dayColumns);
  const team = env.members.map((m) => ({ _id: m.id, name: m.name }));
  const display = spec.display ?? {};
  const setDisplay = (d: NonNullable<ReportSpec["display"]>) => edit({ display: { ...display, ...d } });
  const perValue = AXES_CHARTS.includes(spec.chart) && spec.groupBy.length < 2 && spec.measures.length > 1;
  const moveValue = (i: number, j: number) => {
    if (j < 0 || j >= spec.measures.length || i === j) return;
    // Each per-value list is padded with its default first, so a move never shifts a hole (undefined) into it.
    const move = <T,>(xs: readonly T[], fill: T) => { const out = [...xs]; while (out.length < spec.measures.length) out.push(fill); return moveAt(out, i, j); };
    edit({ measures: moveAt(spec.measures, i, j), ...(spec.display ? { display: { ...spec.display, ...(spec.display.axes ? { axes: move(spec.display.axes, "left" as const) } : {}), ...(spec.display.types ? { types: move(spec.display.types, "bar" as const) } : {}), ...(spec.display.shares ? { shares: move(spec.display.shares, false) } : {}) } } : {}) });
  };
  const removeValue = (i: number) => edit({ measures: spec.measures.filter((_, j) => j !== i), ...(spec.display ? { display: { ...spec.display, ...(spec.display.axes ? { axes: spec.display.axes.filter((_, j) => j !== i) } : {}), ...(spec.display.types ? { types: spec.display.types.filter((_, j) => j !== i) } : {}), ...(spec.display.shares ? { shares: spec.display.shares.filter((_, j) => j !== i) } : {}) } } : {}) });
  const nth = <T,>(xs: readonly T[] | undefined, i: number, v: T, fill: T) => { const out = [...(xs ?? [])]; while (out.length < spec.measures.length) out.push(fill); out[i] = v; return out; };
  // A chart that can't draw the report says why; the one that reads it best is marked.
  const fit = chartFit(spec);
  const filteredBy = [...new Set(spec.filter.map((f) => labelOf(f.field)))];
  const clearFilters = () => { edit({ filter: [] }); setFilters(null); setFilterLoads((x) => x + 1); };
  const building = spec.groupBy.length === 0 && spec.measures.length === 1 && spec.measures[0].fn === "count" && spec.chart !== "number";
  const records = palette.title ?? "records";
  const valueLabel = (m: ReportSpec["measures"][number]) => metricName(m, labelOf(m.field ?? ""), records);
  const keyLabel = (g: ReportSpec["groupBy"][number]) => (g.bucket ? `${labelOf(g.field)} (${g.bucket})` : labelOf(g.field));
  const sentence = reportSentence(spec.measures.map(valueLabel), [...rows, ...cols].map(keyLabel), filteredBy);
  // The records behind a mark: the report as a list of its Canon object, with the first metric's own filter
  // (Pipeline's open deals), opened in a side panel. Other stands for many groups, so it opens nothing.
  const recordObject = spec.object === "canon.deals" ? "deal" : recordObjectName(spec.object);
  const drillSpec = recordObject && runSpec ? { ...runSpec, object: recordObject, filter: [...runSpec.filter, ...(runSpec.measures[0]?.where ?? [])] } : null;
  const fieldInfo = (name: string): FieldInfo | undefined => { const f = fieldOf(name); return f ? ({ label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}) } as FieldInfo) : undefined; };
  const picked = drillSpec && chartP ? pickHandler(drillSpec, chartP, fieldInfo, setPick) : undefined;
  const drillPick: ChartPick | undefined = picked && ((at) => { if (at.x && typeof at.x === "object") return; picked(at); });

  // The report's source's fields to add, in the palette's sections: a dimension goes to the rows, a measure to the values.
  const fieldChoices = palette.none ? [] : (() => {
    const item = (d: Dragged, label: string, group: string) => ({ value: JSON.stringify(d), label, group });
    return [
      ...sectionsOf(fields.filter((f) => !isMeasure(f) || f.ref)).flatMap((sec) => sec.fields.map((f) => item({ kind: "dimension", name: f.name }, f.label, sec.label))),
    ];
  })();
  // The metrics to add: the source's suggested ones first, then any number field, totalled.
  const numberFields = fields.filter((f) => isMeasure(f) && !f.ref);
  const metricOf = (m: { fn: ReportSpec["measures"][number]["fn"]; field?: string }) => metricName(m, labelOf(m.field ?? ""), records);
  const metricChoices = palette.none ? [] : [
    ...presetMetrics(fields).map((m) => ({ value: JSON.stringify({ kind: "measure", name: m.label, preset: m }), label: m.label, group: "Ready metrics" })),
    ...suggestedMetrics(numberFields).map((m) => ({ value: JSON.stringify({ kind: "measure", name: m.field ?? "#count", fn: m.fn }), label: metricOf(m), group: "Suggested" })),
    ...numberFields.map((f) => ({ value: JSON.stringify({ kind: "measure", name: f.name, fn: "sum", from: true }), label: f.label, group: "From a field" })),
  ];
  const addField = (raw: string) => { try { const d = JSON.parse(raw) as Dragged; drop(d.kind === "measure" ? "values" : "rows", d); } catch { /* not a field */ } };
  const drawn = spec.chart !== "table" && spec.chart !== "number";
  // A new report is named for what it reads ("Accounts"); the page's own title only while it reads the page's source.
  const reportTitle = active?.name ?? (spec.object === n.collection ? n.title : palette.title) ?? n.title ?? "Report";
  // Bars label their totals unless turned off; other charts only when turned on (as Looker Studio starts them).
  const labelsOn = spec.chart === "bar" ? display.labels !== false : display.labels === true;
  const setBucket = (field: string, b: ReportBucket) => setKeys(rows.map((g) => (g.field === field ? { ...g, bucket: b } : g)), cols.map((g) => (g.field === field ? { ...g, bucket: b } : g)));
  /** Drop a dragged row where it is over: a value among the values, a dimension in Group by or Split by. */
  const dropAt = (from: { list: KeyList | "values"; i: number }, to: { list: KeyList | "values"; i: number }) => {
    if (from.list === "values" || to.list === "values") return from.list === to.list && moveValue(from.i, to.i);
    const next = moveKey(rows, cols, from as { list: KeyList; i: number }, to as { list: KeyList; i: number });
    if (typeof next === "string") return toast.error(next);
    setKeys(next.group, next.split);
  };
  const same = (a: typeof drag, b: typeof drag) => !!a && !!b && a.list === b.list && a.i === b.i;
  /** A row's drag: the whole row moves; it lands above the row it is dropped on (or in an empty list). */
  const dnd = (list: KeyList | "values", i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); setDrag({ list, i }); },
    onDragEnd: () => { setDrag(null); setOver(null); },
    onDragOver: (e: DragEvent) => { if (!drag || (drag.list === "values") !== (list === "values")) return; e.preventDefault(); if (!same(over, { list, i })) setOver({ list, i }); },
    onDrop: (e: DragEvent) => { e.preventDefault(); if (drag) dropAt(drag, { list, i }); setDrag(null); setOver(null); },
  });
  /** The grip a row is dragged by; with the keyboard, the arrow keys move it up or down its list. */
  const grip = (label: string, list: KeyList | "values", i: number, size: number) => (
    <button type="button" aria-label={`Move ${label}`} title="Drag to move, or use the arrow keys" className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
      onKeyDown={(e) => {
        const by = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        if (!by || i + by < 0 || i + by >= size) return;
        e.preventDefault();
        dropAt({ list, i }, { list, i: i + by });
      }}><GripVertical className="size-3.5" /></button>
  );
  const rowClass = (list: KeyList | "values", i: number) => cn(item, same(drag, { list, i }) && "opacity-40", same(over, { list, i }) && !same(drag, { list, i }) && "border-t-2 border-t-primary");
  const keyRow = (g: ReportSpec["groupBy"][number], list: KeyList, i: number) => (
    <li key={g.field} className={rowClass(list, i)} data-key={g.field} {...dnd(list, i)}>
      {grip(labelOf(g.field), list, i, list === "group" ? rows.length : cols.length)}
      <span className="min-w-0 flex-1 truncate">{labelOf(g.field)}</span>
      {g.bucket && <SelectField size="sm" className="h-6 w-24 text-xs" aria-label={`${labelOf(g.field)} by`} value={g.bucket} onValueChange={(b) => setBucket(g.field, b as ReportBucket)} options={["day", "week", "month", "quarter", "year"].map((b) => ({ value: b, label: b }))} />}
      <button type="button" aria-label={`Remove ${labelOf(g.field)}`} className="text-muted-foreground hover:text-foreground" onClick={() => setKeys(rows.filter((x) => x.field !== g.field), cols.filter((x) => x.field !== g.field))}><X className="size-3.5" /></button>
    </li>
  );
  /** An empty list still takes a drop. */
  const emptyDrop = (list: KeyList, text: string) => (
    <p className={cn("mt-1.5 border border-dashed border-border px-2 py-2 text-xs text-muted-foreground", same(over, { list, i: 0 }) && "border-primary text-foreground")} data-empty-list={list}
      onDragOver={(e) => { if (!drag || drag.list === "values") return; e.preventDefault(); if (!same(over, { list, i: 0 })) setOver({ list, i: 0 }); }}
      onDrop={(e) => { e.preventDefault(); if (drag) dropAt(drag, { list, i: 0 }); setDrag(null); setOver(null); }}>{text}</p>
  );

  async function saveAs(shared: boolean) {
    try {
      if (active && (active.mine || dirty)) {
        await save({ module: env.module, report: n.id, reportId: active._id, spec, ...(shared !== active.shared ? { shared } : {}) });
        toast.success(`Saved ${active.name}`);
      } else {
        if (!name.trim()) return toast.error("Name the report to save it.");
        const id = await save({ module: env.module, report: n.id, name, shared, spec });
        env.setQuery({ [param]: id });
        toast.success(`Saved ${name}`);
        setName("");
      }
      setDirty(false);
    } catch (e) { toast.error(getErrorMessage(e)); }
  }

  if (savedId && saved !== undefined && !active) return <p className="text-sm text-muted-foreground">This saved report is not available.</p>;

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm" aria-label={n.title ?? "Report"}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="font-display text-lg font-semibold">{reportTitle}</h2>
        {active?.shared && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Shared</span>}
        {dirty && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Edited</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SelectField className="w-48" value={savedId} onValueChange={(v) => env.setQuery({ [param]: v || null })}
            options={[{ value: "", label: n.title ? `${n.title} (as built)` : "As built" }, ...(saved ?? []).map((r) => ({ value: r._id, label: `${r.name}${r.shared ? " · shared" : ""}` }))]} />
          {!active && <input className="h-7 w-40 rounded border border-border bg-background px-2 text-xs" placeholder="Name to save as" value={name} onChange={(e) => setName(e.target.value)} />}
          <button type="button" className={btn} onClick={() => void saveAs(active?.shared ?? false)} disabled={!!active && !dirty}><Save className="size-3.5" />Save</button>
          <button type="button" className={cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/90")} onClick={() => void saveAs(true)} disabled={!!active && active.shared && !dirty}><Share2 className="size-3.5" />{active?.shared ? "Save shared" : "Share"}</button>
          {active && env.dashboards && <ModulePinControl reportId={active._id} env={env} />}
          {active?.mine && <button type="button" className={btn} aria-label="Delete saved report" onClick={() => setDeleting(true)}><Trash2 className="size-3.5" /></button>}
          {deleting && active && <ConfirmDialog title={`Delete ${active.name}?`} description="The report goes for everyone it is shared with." confirmLabel="Delete" destructive onClose={() => setDeleting(false)}
            onConfirm={async () => { await remove({ module: env.module, reportId: active._id as Id<"reports"> }); env.setQuery({ [param]: null }); }} />}
        </div>
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 p-4" data-region="preview">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground" data-sentence>{sentence}</p>
            <span className="text-xs text-muted-foreground tabular-nums">
              {loading ? "Updating…" : result ? `${result.rows.toLocaleString("en-US")} ${result.rows === 1 ? "doc" : "docs"} · ${result.ms} ms` : ""}
            </span>
          </div>
          {result?.behind && <p className="mt-1 text-xs text-muted-foreground">Some changes are still reaching this report.</p>}
          {!building && sorted && result && result.rows > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="ml-auto flex gap-1">
                  <button type="button" className={btn} onClick={() => exportReport(sorted, result, reportTitle, "csv")}><Download className="size-3.5" />CSV</button>
                  <button type="button" className={btn} onClick={() => exportReport(sorted, result, reportTitle, "xlsx")}><Download className="size-3.5" />Excel</button>
                </span>
            </div>
          )}
          {error && <div className="mt-3"><ReportError error={error} retry={retry} /></div>}
          {building ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-12 text-center" data-empty="build">
              <p className="font-medium">Build a report</p>
              <p className="mt-1 text-sm text-muted-foreground">Pick a field under Add a field: a dimension groups the report, a measure totals it.</p>
            </div>
          ) : p && sorted && result && result.rows === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-12 text-center" data-empty="none">
              <p className="font-medium">No data</p>
              <p className="mt-1 text-sm text-muted-foreground">{filteredBy.length ? `Nothing you read matches these filters: ${filteredBy.join(", ")}.` : "Nothing you read matches this report yet."}</p>
              {filteredBy.length > 0 && <button type="button" className={cn(btn, "mt-3")} onClick={clearFilters}>Clear filters</button>}
            </div>
          ) : p && sorted && (
            <div className={cn("mt-4 space-y-4 transition-opacity", loading && "opacity-60")}>
              {prev && result && (
                <div className="flex flex-wrap gap-2" data-compare>
                  {spec.measures.map((m, i) => {
                    if (m.compare !== "prev") return null;
                    const ch = change(result.total[i] ?? null, prevRun.result?.total[i] ?? null, m.fn === "pctTrue");
                    return (
                      <div key={i} className="min-w-48 border border-border bg-background px-3 py-2">
                        <div className="text-xs text-muted-foreground">{p.measureLabels[i]}</div>
                        <div className="font-display text-2xl font-semibold tabular-nums">{p.format(i, p.total[i])}</div>
                        <div className="text-xs">
                          {prevRun.loading ? <span className="text-muted-foreground">Comparing…</span> : ch ? <span className={ch.up ? "font-medium text-primary" : "font-medium text-destructive"}>{ch.text}</span> : <span className="text-muted-foreground">No change to show</span>}
                          <span className="text-muted-foreground"> vs {rangeText(prev.period)}{prev.period.partial ? ", same days" : ""}{prevRun.result ? ` (${p.format(i, prevRun.result.total[i] ?? null)})` : ""}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {spec.chart !== "table" && chartP && !fit.why[spec.chart] && <div className="rounded-lg border border-border/70 bg-background p-4"><ReportChart p={chartP} kind={spec.chart} display={spec.display} onPick={drillPick} tone={tone} /></div>}
              <div className="rounded-lg border border-border/70 bg-background">
                {p.keyLabels.length === 2 ? <PivotTable p={sorted} fns={(result?.spec ?? spec).measures.map((m) => m.fn)} rowNumbers={display.rowNumbers} heatmap={display.heatmap} />
                  : <ReportTable p={sorted} sort={sort} onSort={(col) => setSort((s) => nextSort(s, col, col < p.keyLabels.length ? "asc" : "desc"))} rowNumbers={display.rowNumbers} heatmap={display.heatmap} />}
              </div>
              {p.keyLabels.length < 2 && p.truncated && <p className="text-xs text-muted-foreground">Showing the first 500 groups (showing top groups). The totals count every doc.</p>}
            </div>
          )}
        </div>
        <aside className="border-t border-border bg-muted/30 lg:border-t-0 lg:border-l" aria-label="Report settings">
          <Tabs defaultValue="data" className="gap-0">
            <TabsList variant="line" className="w-full justify-start border-b border-border px-3">
              <TabsTrigger value="data">Setup</TabsTrigger>
              <TabsTrigger value="chart">Style</TabsTrigger>
            </TabsList>
            <TabsContent value="data" className="space-y-4 p-3">
              <div>
                <div className={eyebrow}>Chart</div>
                <div className="mt-1.5"><ChartPicker current={variantOf(spec)} suggested={fit.suggested} why={(v) => variantWhy(spec, v)} onPick={(v) => edit(withVariant(spec, v))} /></div>
              </div>
              {sources.length > 1 && (
                <label className="block"><span className={eyebrow}>Data source</span>
                  <SelectField className="mt-1 w-full" aria-label="Data source" value={spec.object} onValueChange={switchTo}
                    options={sources.map((s) => ({ value: s, label: env.palette[s]?.none ? `${env.palette[s]?.title ?? s} (you read none of these)` : env.palette[s]?.title ?? s, disabled: env.palette[s]?.none && s !== spec.object }))} />
                </label>
              )}
              {ownerField && (
                <div>
                  <div className={eyebrow}>Whose records</div>
                  <p className="text-[11px] text-muted-foreground">By each record&apos;s owner. A shared report shows every viewer their own.</p>
                  <div className="mt-1.5 flex overflow-hidden border border-border" role="group" aria-label="Whose records">
                    {([["all", "Everyone"], ["team", "My team"], ["me", "Just me"]] as const).map(([v, l]) => (
                      <button key={v} type="button" aria-pressed={(spec.whose ?? "all") === v} className={cn("flex-1 px-2 py-1.5 text-xs", (spec.whose ?? "all") === v ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground")}
                        onClick={() => { setSpec(({ whose: _was, ...s }) => (v === "me" || v === "team" ? { ...s, whose: v } : s)); setDirty(true); }}>{l}</button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{spec.whose === "me" ? "Only records you own." : spec.whose === "team" ? "Records owned by you and the people on your team." : "Every record you can see."}</p>
                </div>
              )}
              <FieldPicker label="Add a dimension" search="Search fields…" options={fieldChoices} onPick={addField} />
              <div>
                <div className={eyebrow}>Dimension</div>
                <p className="text-[11px] text-muted-foreground">The table&apos;s rows and the chart&apos;s axis.</p>
                {rows.length ? <ul className="mt-1.5 space-y-1">{rows.map((g, i) => keyRow(g, "group", i))}</ul> : emptyDrop("group", "Add a field above, or drag one here.")}
              </div>
              <div>
                <div className={eyebrow}>Breakdown dimension</div>
                <p className="text-[11px] text-muted-foreground">Splits the table into columns and the chart into colors.</p>
                {cols.length ? <ul className="mt-1.5 space-y-1">{cols.map((g, i) => keyRow(g, "split", i))}</ul> : emptyDrop("split", "Drag a dimension here to break the report down by it.")}
              </div>
              <div>
                <div className={eyebrow}>Metric</div>
                <p className="text-[11px] text-muted-foreground">What each group adds up to. Click one to change it.</p>
                <ul className="mt-1.5 space-y-1">
                  {spec.measures.map((m, i) => (
                    <MetricChip key={i} fn={m.fn} label={m.label} where={whereText(m.where, labelOf) || undefined} fieldLabel={labelOf(m.field ?? "")} fieldType={fieldOf(m.field ?? "")?.type} records={records} share={display.shares?.[i] === true}
                      className={cn(same(drag, { list: "values", i }) && "opacity-40", same(over, { list: "values", i }) && !same(drag, { list: "values", i }) && "border-t-2 border-t-primary")}
                      dragProps={{ "data-value": i, ...(spec.measures.length > 1 ? dnd("values", i) : {}) }}
                      grip={spec.measures.length > 1 ? grip(valueLabel(m), "values", i, spec.measures.length) : undefined}
                      onFn={(fn) => edit({ measures: spec.measures.map((x, j) => { if (j !== i) return x; const { label: _named, ...rest } = x; return { ...rest, fn }; }) })}
                      compare={m.compare === "prev"} canCompare={!!rangeValue?.from && !!rangeValue?.to}
                      onShow={(as) => edit({
                        measures: spec.measures.map((x, j) => { if (j !== i) return x; const { compare: _c, ...rest } = x; return as === "prev" ? { ...rest, compare: "prev" as const } : rest; }),
                        display: { ...display, shares: nth(display.shares, i, as === "share", false) },
                      })}
                      onRemove={spec.measures.length > 1 ? () => removeValue(i) : undefined} />
                  ))}
                </ul>
                <div className="mt-1.5"><FieldPicker label="Add a metric" search="Search metrics…" options={metricChoices} onPick={addField} /></div>
              </div>
              <div>
                <div className={eyebrow}>Filter</div>
                <div className="mt-1.5">
                  <FilterBar filters={shownFilters} columns={columns} dayColumns={dayColumns} canAdd={FILTERS_MAX - spec.filter.length >= 2} resetKey={filterLoads}
                    fields={def.fields.filter((f) => !f.system) as unknown as FieldDescription[]} team={team}
                    onChange={(next) => { setFilters(next); edit({ filter: [...rangeFilters, ...expandDayFilters(next.filter((f) => isComplete(f) && columns.has(f.field)), dayColumns)] }); }} />
                </div>
              </div>
              {range && (
                <div>
                  <div className={eyebrow}>Date range</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {dateFields.length > 1 && <SelectField className="h-7 w-full" value={range.name} onValueChange={(f) => { edit({ filter: otherFilters }); setRangeField(f); }} options={dateFields.map((f) => ({ value: f.name, label: f.label }))} />}
                    <DateRangeInput className="w-full" label={range.label} value={rangeValue} fiscalYearStartMonth={env.fiscalYearStartMonth}
                      onChange={(r) => edit({ filter: [...otherFilters, ...(r?.from ? [{ field: range.name, op: "gte" as const, value: dayValue(range.type, r.from, false) }] : []), ...(r?.to ? [{ field: range.name, op: "lte" as const, value: dayValue(range.type, r.to, true) }] : [])] })} />
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="chart" className="space-y-5 p-3">
              <div>
                <div className={eyebrow}>Color</div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5" role="group" aria-label="Palette">
                  {(Object.keys(PALETTES) as PaletteName[]).map((k) => {
                    const on = (display.palette ?? "canon") === k;
                    return (
                      <button key={k} type="button" aria-pressed={on} onClick={() => setDisplay({ palette: k })}
                        className={cn("flex items-center gap-2 border bg-background px-2 py-1.5 text-xs", on ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/30")}>
                        <span className="flex">{PALETTES[k].slice(0, 5).map((c) => <span key={c} className="size-3" style={{ background: c }} />)}</span>
                        {PALETTE_LABEL[k]}
                      </button>
                    );
                  })}
                </div>
              </div>
              {drawn && (
                <div className="space-y-2 text-sm">
                  <div className={eyebrow}>Chart</div>
                  <label className="flex items-center justify-between">Data labels<Switch size="sm" checked={labelsOn} onCheckedChange={(v) => setDisplay({ labels: v })} /></label>
                  <label className="flex items-center justify-between">Gridlines<Switch size="sm" checked={display.grid !== false} onCheckedChange={(v) => setDisplay({ grid: v })} /></label>
                  {(spec.chart === "column" || spec.chart === "area") && (
                    <label className="flex items-center justify-between">Stacked<Switch size="sm" checked={display.stacked === true} onCheckedChange={(v) => setDisplay({ stacked: v })} /></label>
                  )}
                  {spec.chart !== "pie" && (
                    <div className="flex items-center justify-between">Legend
                      <span className="inline-flex overflow-hidden rounded border border-border text-[10px]" role="group" aria-label="Legend">
                        {(["top", "bottom", "none"] as const).map((l) => <button key={l} type="button" aria-pressed={(display.legend ?? "top") === l} className={seg((display.legend ?? "top") === l)} onClick={() => setDisplay({ legend: l })}>{l === "top" ? "Top" : l === "bottom" ? "Bottom" : "None"}</button>)}
                      </span>
                    </div>
                  )}
                </div>
              )}
              <div className="space-y-2 text-sm">
                <div className={eyebrow}>Table</div>
                <label className="flex items-center justify-between">Row numbers<Switch size="sm" checked={display.rowNumbers === true} onCheckedChange={(v) => setDisplay({ rowNumbers: v })} /></label>
                <label className="flex items-center justify-between">Heatmap<Switch size="sm" checked={display.heatmap === true} onCheckedChange={(v) => setDisplay({ heatmap: v })} /></label>
              </div>
              <div className="space-y-3">
                {perValue && spec.measures.map((m, i) => (
                  <div key={i} className="space-y-1.5 border-t border-border pt-3 text-xs">
                    <div className={eyebrow}>{valueLabel(m)}</div>
                    {perValue && (
                      <div className="flex items-center justify-between">Axis
                        <span className="inline-flex overflow-hidden rounded border border-border text-[10px]">
                          {(["left", "right"] as const).map((a) => <button key={a} type="button" aria-pressed={(display.axes?.[i] ?? "left") === a} className={seg((display.axes?.[i] ?? "left") === a)} onClick={() => setDisplay({ axes: nth(display.axes, i, a, "left") })}>{a === "left" ? "Left" : "Right"}</button>)}
                        </span>
                      </div>
                    )}
                    {perValue && spec.chart === "column" && (
                      <div className="flex items-center justify-between">Show as
                        <span className="inline-flex overflow-hidden rounded border border-border text-[10px]">
                          {(["bar", "line"] as const).map((t) => <button key={t} type="button" aria-pressed={(display.types?.[i] ?? "bar") === t} className={seg((display.types?.[i] ?? "bar") === t)} onClick={() => setDisplay({ types: nth(display.types, i, t, "bar") })}>{t === "bar" ? "Bars" : "Line"}</button>)}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
      {drillSpec && <ReportRecords spec={drillSpec} pick={pick} fieldOf={fieldInfo} onClose={() => setPick(null)} />}
    </section>
  );
}
/** A header click: its column the way it reads first (names A to Z, figures highest first), then the other way, then unsorted. */
const nextSort = (s: ReportSort | null, col: number, first: ReportSort["dir"]): ReportSort | null =>
  s?.col !== col ? { col, dir: first } : s.dir === first ? { col, dir: first === "asc" ? "desc" : "asc" } : null;

/**
 * The results as a file, in the order they show: a row per group (its keys as they read, then its values), then the
 * total. Money as units with two decimals, counts and other figures as plain numbers; a cell a spreadsheet would run
 * as a formula stays text (csv-export, xlsx).
 */
function exportReport(p: Presented, run: Run, title: string, format: "csv" | "xlsx") {
  const money = run.spec.measures.map((m) => m.fn !== "count" && run.fields.find((f) => f.name === m.field)?.type === "currency");
  const cell = (i: number, v: number | null) => (v === null ? "" : money[i] ? (v / 100).toFixed(2) : String(Math.round(v * 1e6) / 1e6));
  const header = [...p.keyLabels, ...p.measureLabels];
  // The total row's label sits in the first dimension's column; with no dimension, the row is the totals alone.
  const totalRow = [...(p.keyLabels.length ? ["Total", ...p.keyLabels.slice(1).map(() => "")] : []), ...p.total.map((v, i) => cell(i, v))];
  const rows = [...p.groups.map((g) => [...g.labels, ...g.values.map((v, i) => cell(i, v))]), totalRow];
  const filename = title.replace(/[^a-zA-Z0-9 ._-]+/g, " ").trim() || "report";
  const blob = format === "csv"
    ? new Blob([serializeCsvRows([header, ...rows])], { type: "text/csv" })
    : new Blob([xlsx(title, header, rows, [...p.keyLabels.map(() => "text" as CellKind), ...money.map((m): CellKind => (m ? "money" : "number"))]) as Uint8Array<ArrayBuffer>], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: `${filename}.${format}` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The shape a link opened a report with (`?<id>.config=`): its rows, columns, values and chart, or null when it isn't one. */
function linkedShape(raw: string): { rows?: ReportKey[]; columns?: ReportKey[]; values?: ReportShape["values"]; chart?: ChartKind } | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as Record<string, unknown>;
    const keys = (v: unknown) => (Array.isArray(v) ? (v.filter((k) => typeof k === "string" || (typeof k === "object" && k !== null && typeof (k as { field?: unknown }).field === "string")) as ReportKey[]).slice(0, 2) : undefined);
    const values = Array.isArray(x.values) ? (x.values.filter((v) => typeof v === "object" && v !== null && ["count", "sum", "avg", "min", "max"].includes((v as { fn?: string }).fn ?? "")) as NonNullable<ReportShape["values"]>[number][]).slice(0, MEASURES_MAX) : undefined;
    const chart = CHARTS.some((c) => c.value === x.chart) ? (x.chart as ChartKind) : undefined;
    return { rows: keys(x.rows), columns: keys(x.columns)?.slice(0, 1), values: values?.length ? values : undefined, chart };
  } catch { return null; }
}

/**
 * A chart's bars as the page declares them (docs/modules.md, "Reports and charts"): ordered by their value rather than
 * their label, only the `top` of them, and values shown as a percent (of a fraction), money or a number.
 */
export function shapeChart(p: Presented, n: Pick<Of<"chart">, "order" | "dir" | "top" | "format">): Presented {
  let out = p;
  const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
  if (n.format === "percent") out = { ...out, format: (i, v) => (i === 0 && v !== null ? pct.format(v) : p.format(i, v)), formatCompact: (i, v) => (i === 0 ? pct.format(v) : p.formatCompact(i, v)), whole: false };
  if (n.format === "money") out = { ...out, format: (i, v) => (i === 0 && v !== null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v / 100) : p.format(i, v)), formatCompact: (i, v) => (i === 0 ? `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v / 100)}` : p.formatCompact(i, v)) };
  const two = out.keyLabels.length > 1;
  const byValue = (a: { values: (number | null)[] }, b: { values: (number | null)[] }) => ((b.values[0] ?? -Infinity) - (a.values[0] ?? -Infinity)) * (n.dir === "asc" ? -1 : 1);
  let groups = out.groups, subtotals = out.subtotals;
  if (n.order === "value") { if (two) subtotals = [...subtotals].sort(byValue); else groups = [...groups].sort(byValue); }
  if (n.top !== undefined) {
    if (two) { subtotals = subtotals.slice(0, n.top); const kept = new Set(subtotals.map((x) => JSON.stringify(x.keys[0]))); groups = groups.filter((g) => kept.has(JSON.stringify(g.keys[0]))); }
    else groups = groups.slice(0, n.top);
  }
  return { ...out, groups, subtotals };
}

export function ModuleSavedReportTile({ report, env }: {
  report: FunctionReturnType<typeof api.modules.savedReports>[number] | undefined; env: ReportEnv;
}) {
  const { result, error, retry } = useReportRun(env.module, report?.spec ?? null, report?._id);
  const p = useMemo(() => result ? presentRun(result, env.members, env.palette[result.spec.object]?.title ?? "records") : null, [result, env.members, env.palette]);
  const chartP = useMemo(() => result && p ? foldTop(p, result.spec.measures.map((m) => m.fn), 10, !!result.spec.groupBy[0]?.bucket) : null, [result, p]);
  if (!report) return <p className="text-xs text-muted-foreground">This report is no longer available.</p>;
  if (error) return <ReportError error={error} retry={retry} />;
  if (!result || !p) return <p className="text-xs text-muted-foreground">Loading report…</p>;
  const display = result.spec.display ?? {};
  return <>{result.behind && <p className="text-xs text-muted-foreground">Report is syncing…</p>}{result.spec.chart === "table"
    ? p.keyLabels.length === 2 ? <PivotTable p={p} fns={result.spec.measures.map((m) => m.fn)} rowNumbers={display.rowNumbers} heatmap={display.heatmap} /> : <ReportTable p={p} rowNumbers={display.rowNumbers} heatmap={display.heatmap} />
    : chartP && <ReportChart p={chartP} kind={result.spec.chart} display={display} />}</>;
}

/** A chart's shape for Canon's charts: bars and lines, stacked bars split by a series (a waterfall draws its own). */
const chartKind = (k: Of<"chart">["kind"]): ChartKind => (k === "stacked" ? "bar" : k === "waterfall" ? "column" : k);

/** A chart of a report the page declares: its first value by its dimensions. */
function ReportShapeChart({ n, env }: { n: Of<"chart">; env: ReportEnv }) {
  const palette = env.palette[n.report!.collection];
  const spec = useMemo(() => specOf(n.report!, chartKind(n.kind)), [n]);
  const { result, error, retry } = useReportRun(env.module, palette && !palette.none ? spec : null);
  const p = useMemo(() => (result ? shapeChart(presentRun(result, env.members, env.palette[result.spec.object]?.title ?? "records"), n) : null), [result, env.members, env.palette, n]);
  if (!palette || palette.none) return null;
  return <ChartFrame title={n.title} error={error} retry={retry}>{p ? <ReportChart p={p} kind={chartKind(n.kind)} /> : null}</ChartFrame>;
}

function ReportError({ error, retry }: { error: string; retry?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return <div className="text-sm text-destructive"><p>{error}</p>{retry && <button type="button" className={cn(btn, "mt-2")} disabled={busy} onClick={async () => {
    setBusy(true);
    try { await retry(); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }}>{busy ? "Retrying…" : "Retry sync"}</button>}</div>;
}

function ChartFrame({ title, error, retry, note, children }: { title?: string; error?: string; retry?: () => Promise<unknown>; note?: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-3" aria-label={title ?? "Chart"}>
      {title && <h2 className="mb-2 font-display text-base font-semibold">{title}</h2>}
      {error ? <ReportError error={error} retry={retry} /> : children}
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

/** What a binding's row values are, for a chart's labels. */
export type RowsEnv = { rows: Doc[]; complete: boolean; kinds: Record<string, string>; labels: Record<string, Record<string, string>>; refs: Readonly<Record<string, string>> };

/**
 * A chart of a binding's rows: each row's `y` summed (a count without one) by its `x`, split by its `series`, drawn
 * with Canon's charts. A list read short says so: the chart shows only the rows read.
 */
function RowsChart({ n, env, rows, onPick }: { n: Of<"chart">; env: ReportEnv; rows: RowsEnv; onPick?: ChartPick }) {
  const p = useMemo(() => {
    const keysOf = [n.x!, ...(n.series ? [n.series] : [])];
    const kind = (path: string) => rows.kinds[path];
    const bucket: ReportBucket = n.bucket ?? "month";
    const raw = (row: Doc, path: string): string | number | boolean | null => {
      const v = valueAt(row, path) ?? (path === "key" ? row.key : undefined);
      if (v === undefined || v === null || v === "") return null;
      if (kind(path) === "date") return bucketStart(typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : String(v).slice(0, 10), bucket);
      return typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean);
    };
    const groups = new Map<string, AggregateGroup>(), subs = new Map<string, AggregateGroup>();
    let total = 0;
    for (const row of rows.rows) {
      const y = n.y ? Number(valueAt(row, n.y) ?? 0) || 0 : 1;
      const keys = keysOf.map((k) => raw(row, k));
      total += y;
      const add = (map: Map<string, AggregateGroup>, ks: (string | number | boolean | null)[]) => {
        const id = JSON.stringify(ks);
        const g = map.get(id) ?? { keys: ks, values: [0] };
        g.values = [(g.values[0] ?? 0) + y];
        map.set(id, g);
      };
      add(groups, keys);
      if (keys.length > 1) add(subs, keys.slice(0, 1));
    }
    const info = (path: string): FieldInfo => {
      const label = path.split(".").pop()!.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
      const k = kind(path);
      if (k === "user") return { label, type: "user" };
      if (k === "date") return { label, type: "date" };
      const labels = rows.labels[path] ?? (k === "ref" ? rows.refs : undefined);
      return labels ? { label, type: "picklist", options: Object.entries(labels).map(([value, l]) => ({ value, label: l })) } : { label, type: "text" };
    };
    const sorted = (m: Map<string, AggregateGroup>) => [...m.values()].sort((a, b) => typeof a.keys[0] === "number" && typeof b.keys[0] === "number"
      ? a.keys[0] - b.keys[0] : String(a.keys[0]).localeCompare(String(b.keys[0])));
    const spec = { groupBy: keysOf.map((k) => ({ field: k, ...(kind(k) === "date" ? { bucket } : {}) })), measures: [n.y ? { fn: "sum" as const, field: n.y } : { fn: "count" as const }] };
    return shapeChart(present(spec, { groups: sorted(groups), subtotals: sorted(subs), total: [total], rows: rows.rows.length, truncated: false },
      keysOf.map(info), [n.y ? { label: info(n.y).label, type: rows.kinds[n.y] === "number" && /amount|pipeline|money/i.test(n.y) ? "currency" : "number" } : undefined], env.members.map((m) => ({ _id: m.id, name: m.name }))), n);
  }, [n, rows, env.members]);
  return <ChartFrame title={n.title} note={rows.complete ? undefined : `Drawn from the first ${rows.rows.length} rows only.`}><ReportChart p={p} kind={chartKind(n.kind)} onPick={onPick} /></ChartFrame>;
}

/**
 * A waterfall of a call's value: its `start` field, then each row of `rows` as a signed step (`y`) labeled by `x`, in
 * the call's order, then its `end` field. When the end disagrees with the steps, a note says by how much.
 */
function WaterfallRows({ n, rows, totals, onPick }: { n: Of<"chart">; rows: RowsEnv; totals: { start: unknown; end: unknown }; onPick?: ChartPick }) {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const w = useMemo(() => waterfall(
    { label: n.startLabel ?? "Start", value: num(totals.start) },
    rows.rows.map((r) => ({ label: String(valueAt(r, n.x!) ?? ""), value: num(valueAt(r, n.y!)) })),
    { label: n.endLabel ?? "End", value: totals.end === undefined || totals.end === null ? null : num(totals.end) },
  ), [n, rows, totals.start, totals.end]);
  const full = waterfallFigure(n.format, false), short = waterfallFigure(n.format, true);
  const note = w.gap === null ? undefined : `The steps add up to ${full(w.bars.at(-1)!.to - w.gap)}, but the end is ${full(w.bars.at(-1)!.to)}: ${full(Math.abs(w.gap))} isn't shown as a step.`;
  return (
    <ChartFrame title={n.title} note={note}>
      <WaterfallChart w={w} format={full} compact={short} label={n.title ?? `${w.bars[0].label} to ${w.bars.at(-1)!.label}`}
        onPick={onPick ? (row) => onPick({ x: valueAt(rows.rows[row], n.x!), series: "" }) : undefined} />
    </ChartFrame>
  );
}

/** `onPick`: a click on a bar opens the page the chart's `link` names, filled from the bar (docs/modules.md, "Reports and charts"). */
export function ModuleChart({ n, env, rows, totals, onPick }: { n: Of<"chart">; env: ReportEnv; rows: RowsEnv | null; totals?: { start: unknown; end: unknown }; onPick?: ChartPick }) {
  if (n.kind === "waterfall") return rows && totals ? <WaterfallRows n={n} rows={rows} totals={totals} onPick={onPick} /> : null;
  if (n.report) return <ReportShapeChart n={n} env={env} />;
  return rows ? <RowsChart n={n} env={env} rows={rows} onPick={onPick} /> : null;
}

type TreeRow = { id: string; parent: string | null; doc: Doc };
const ZOOMS = [0.8, 0.9, 1, 1.15, 1.3, 1.5];
/**
 * Rows as a tree, each under the row its `parent` names; a row whose parent isn't among them is a root. Its tools: a
 * search that marks the rows it matches and opens the branches above them, zoom, Expand all and Collapse all, and an
 * inspector a click on a row opens (its `details`, who it reports to, and how many report to it).
 */
export function ModuleTree({ n, rows, text, href }: { n: Of<"tree">; rows: Doc[]; text: (row: Doc, t: string) => string; href: (row: Doc) => string | null }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState("");
  const [zoom, setZoom] = useState(2);
  const [picked, setPicked] = useState<string | null>(null);
  const items: TreeRow[] = rows.map((doc) => {
    const id = n.id ? valueAt(doc, n.id) ?? (n.id === "key" ? doc.key : undefined) : doc.key;
    const parent = valueAt(doc, n.parent);
    return { id: String(id ?? doc.key), parent: typeof parent === "string" && parent ? parent : null, doc };
  });
  const ids = new Set(items.map((r) => r.id));
  const byId = new Map(items.map((r) => [r.id, r]));
  const children = new Map<string | null, TreeRow[]>();
  for (const r of items) {
    const at = r.parent && ids.has(r.parent) && r.parent !== r.id ? r.parent : null;
    children.set(at, [...(children.get(at) ?? []), r]);
  }
  if (!items.length) return <p className="text-sm text-muted-foreground">{n.empty ?? "Nothing to show."}</p>;
  const titleOf = (r: TreeRow) => text(r.doc, n.title);
  // A search matches a row's title or subtitle; every row above a match opens, so each match shows.
  const needle = q.trim().toLowerCase();
  const matches = new Set(needle ? items.filter((r) => `${titleOf(r)} ${n.subtitle ? text(r.doc, n.subtitle) : ""}`.toLowerCase().includes(needle)).map((r) => r.id) : []);
  const above = new Set<string>();
  for (const id of matches) { let at = byId.get(id)?.parent ?? null; const seen = new Set<string>(); while (at && ids.has(at) && !seen.has(at)) { seen.add(at); above.add(at); at = byId.get(at)?.parent ?? null; } }
  const withKids = items.filter((r) => (children.get(r.id) ?? []).length > 0).map((r) => r.id);
  const seen = new Set<string>();
  const branch = (at: string | null, depth: number): ReactNode => (
    <ul className={cn(depth > 0 && "ml-4 border-l border-border pl-3")}>
      {(children.get(at) ?? []).sort((a, b) => titleOf(a).localeCompare(titleOf(b))).map((r) => {
        if (seen.has(r.id)) return null;
        seen.add(r.id);
        const kids = children.get(r.id) ?? [];
        const open = above.has(r.id) || !closed.has(r.id);
        const link = href(r.doc);
        const title = titleOf(r);
        const hit = matches.has(r.id);
        return (
          <li key={r.id} className="py-0.5">
            <div className={cn("flex items-center gap-1.5", hit && "bg-amber-500/15", picked === r.id && "outline outline-1 outline-primary")} data-match={hit || undefined}>
              {kids.length ? (
                <button type="button" aria-label={open ? `Collapse ${title}` : `Expand ${title}`} onClick={() => setClosed((s) => { const x = new Set(s); if (open) x.add(r.id); else x.delete(r.id); return x; })}>
                  {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
              ) : <span className="inline-block size-3.5" />}
              <button type="button" className={cn("font-medium hover:underline", hit && "text-foreground")} onClick={() => setPicked(picked === r.id ? null : r.id)} aria-pressed={picked === r.id}>{title}</button>
              {n.subtitle && <span className="text-xs text-muted-foreground">{text(r.doc, n.subtitle)}</span>}
              {kids.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">· {kids.length}</span>}
              {link && <Link className="text-xs text-muted-foreground underline" href={link} aria-label={`Open ${title}`}>Open</Link>}
            </div>
            {kids.length > 0 && open && branch(r.id, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
  const inspected = picked ? byId.get(picked) ?? null : null;
  const reportsTo = inspected?.parent ? byId.get(inspected.parent) ?? null : null;
  // Everyone under a row, each once: a loop in the data (two rows naming each other) ends where it began.
  const count = (id: string, been = new Set<string>([id])): number => (children.get(id) ?? []).reduce((k, c) => (been.has(c.id) ? k : (been.add(c.id), k + 1 + count(c.id, been))), 0);
  return (
    <section className="border border-border bg-card" aria-label={n.title ? "Tree" : "Tree"}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs print:hidden">
        <label className="relative">
          <span className="sr-only">Search the tree</span>
          <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-48 border border-border bg-background px-2" />
        </label>
        {needle && <span className="text-muted-foreground tabular-nums">{matches.size} {matches.size === 1 ? "match" : "matches"}</span>}
        <span className="ml-auto inline-flex items-center gap-1">
          <button type="button" className={btn} onClick={() => setClosed(new Set())}>Expand all</button>
          <button type="button" className={btn} onClick={() => setClosed(new Set(withKids))}>Collapse all</button>
          <button type="button" className={btn} aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
          <span className="w-10 text-center tabular-nums">{Math.round(ZOOMS[zoom] * 100)}%</span>
          <button type="button" className={btn} aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
        </span>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-[1fr_16rem]">
        <div className="overflow-auto" style={{ fontSize: `${0.875 * ZOOMS[zoom]}rem` }} data-zoom={ZOOMS[zoom]}>{branch(null, 0)}</div>
        {inspected && (
          <aside className="border border-border bg-background p-3 text-sm" aria-label={`About ${titleOf(inspected)}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{titleOf(inspected)}</div>
                {n.subtitle && <div className="text-xs text-muted-foreground">{text(inspected.doc, n.subtitle)}</div>}
              </div>
              <button type="button" aria-label="Close" onClick={() => setPicked(null)}><X className="size-3.5" /></button>
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              {(n.details ?? []).map((d) => <div key={d.label}><dt className="text-muted-foreground">{d.label}</dt><dd>{text(inspected.doc, d.value) || "None"}</dd></div>)}
              <div><dt className="text-muted-foreground">Reports to</dt><dd>{reportsTo ? <button type="button" className="hover:underline" onClick={() => setPicked(reportsTo.id)}>{titleOf(reportsTo)}</button> : "No one here"}</dd></div>
              <div><dt className="text-muted-foreground">Direct reports</dt><dd className="tabular-nums">{(children.get(inspected.id) ?? []).length}</dd></div>
              <div><dt className="text-muted-foreground">Everyone under them</dt><dd className="tabular-nums">{count(inspected.id)}</dd></div>
            </dl>
            {href(inspected.doc) && <Link className={cn(btn, "mt-3")} href={href(inspected.doc)!}>Open</Link>}
          </aside>
        )}
      </div>
    </section>
  );
}

/**
 * A Canon page a module links to (manifest CANON_PAGES): Settings > Team, the deals list, one deal's, company's or
 * person's record, Patch plans (`?plan=` opens a proposal the module made) or the companies list (`?line=` filters it
 * by query lines).
 */
export function canonHref(page: (typeof CANON_PAGES)[number], recordId?: unknown): string | null {
  if (page === "targets") return "/dashboard/settings/targets";
  if (page === "settings") return "/dashboard/settings";
  if (page === "patchPlans") return "/dashboard/patch-plans";
  if (page === "workspace") return "/dashboard/settings/workspace";
  if (page === "team") return "/dashboard/settings/team";
  if (page === "deals") return "/dashboard/deals";
  if (page === "people") return "/dashboard/records/contact";
  if (page === "companies") return "/dashboard/accounts";
  if (typeof recordId !== "string" || !recordId) return null;
  return recordHref(page === "company" ? "account" : page === "person" ? "contact" : "deal", recordId);
}
/**
 * The record a deal, company or person link of `doc` opens: a joined deal's ledger stream (`<ref>.recordId`), or the
 * company or person id its ref holds.
 */
export const canonRecordOf = (page: (typeof CANON_PAGES)[number], doc: Doc, ref: string | undefined): unknown =>
  ref === undefined ? undefined : valueAt(doc, page === "deal" ? `${ref}.recordId` : ref);

export type { TextScope };
