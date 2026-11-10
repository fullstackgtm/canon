"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Download, ExternalLink, KanbanSquare, List, TrendingUp } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { CsvImport } from "@/components/records/csv-import";
import { CallSuggestions } from "@/components/crm/call-suggestions";
import { DealGapScan } from "@/components/crm/deal-gaps";
import { DealCreateDialog } from "@/components/records/deal-create";
import { RecordLink, RecordQuickView } from "@/components/records/record-context";
import { useLookupTitles } from "@/components/records/lookup-field";
import { DEAL_FILTER_DEFAULTS, DEAL_STATUSES, isDefaultDealFilter, matchesDealStatus } from "@/lib/deal-filter";
import { toast } from "@/lib/toast";
import { useUrlState } from "@/lib/url-state";
import { cn, formatCurrency } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { ReportChart, stackedSeries, type SeriesStyle } from "@/components/reports/report-chart";
import { bucketLabel, type Presented } from "@/components/reports/present";
import { stageOf } from "../../../../convex/lib/pipelines";
import { DateRangeInput } from "@/components/modules/date-range-input";
import { base64, xlsx } from "../../../../modules/kernel/xlsx";

/** A module badge's tone, as a module page's badges show it. */
const MODULE_BADGE_TONES: Record<string, string> = {
  info: "border-border bg-muted text-foreground", success: "border-primary bg-primary/10 text-primary", danger: "border-destructive bg-destructive/10 text-destructive",
  warn: "border-amber-600 bg-amber-500/10 text-amber-800 dark:text-amber-300", neutral: "border-border bg-card text-muted-foreground",
};

/** Rows the list shows before "Load more". */
const PAGE = 50;
/** Rows each group shows when the list is grouped, and how many more each "Show more" adds (QuotaQueue's deals list). */
const GROUP_PAGE = 5;
/** Columns a header sorts by, and how each compares. */
const SORTS = ["name", "account", "amount", "stage", "closeDate", "owner"] as const;
type SortKey = (typeof SORTS)[number];
const GROUPS = [
  { value: "", label: "No grouping" }, { value: "owner", label: "Group by owner" }, { value: "stage", label: "Group by stage" },
  { value: "type", label: "Group by deal type" }, { value: "pipeline", label: "Group by pipeline" }, { value: "month", label: "Group by close month" },
];
const LIST_DEFAULTS = { ...DEAL_FILTER_DEFAULTS, sort: "closeDate", owner: "", type: "", pipeline: "", stage: "", group: "", from: "", to: "", range: "", split: "", grain: "" };
/**
 * What the chart's bars split by: nothing (`none`), or the listed deals' owner, stage, type or account. With no `split`
 * in the URL, the one the person last picked here, else stage.
 */
const SPLITS = [
  { value: "none", label: "No split" }, { value: "owner", label: "Split by owner" }, { value: "stage", label: "Split by stage" },
  { value: "type", label: "Split by deal type" }, { value: "account", label: "Split by account" },
];
const DEFAULT_SPLIT = "stage";
/** How long each of the chart's bars is: a calendar month (the default), quarter or year. */
const GRAINS = [{ value: "", label: "Month" }, { value: "quarter", label: "Quarter" }, { value: "year", label: "Year" }];
const GRAIN_MONTHS: Record<string, number> = { "": 1, quarter: 3, year: 12 };
/** The first day of the period a close date falls in, at a grain of `months` months (1, 3 or 12). */
function periodStart(day: string, months: number): string {
  const [y, m] = day.split("-").map(Number);
  const first = months === 12 ? 1 : Math.floor((m - 1) / months) * months + 1;
  return `${y}-${String(first).padStart(2, "0")}-01`;
}
/** The first day of the period after the one starting on `start`. */
function nextPeriod(start: string, months: number): string {
  const [y, m] = start.split("-").map(Number);
  const at = y * 12 + (m - 1) + months;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}-01`;
}
const periodLabel = (start: string, grain: string) => (grain === "year" ? start.slice(0, 4) : bucketLabel(start, grain === "quarter" ? "quarter" : "month"));
/** The close-date range a person last chose here, kept in their browser per workspace member. */
const rangeKey = (userId: string) => `canon.deals.closeRange:${userId}`;
/** The chart's Split by a person last picked here, kept in their browser per workspace member. */
const splitKey = (userId: string) => `canon.deals.split:${userId}`;

/** A file the browser saves under its name. */
function saveFile(bytes: Uint8Array | string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A deal amount in whole units ("$60,000"): cents on a deal are noise in a list. Exports keep the exact amount. */
function formatWhole(cents: number, currency = "USD"): string {
  const as = (code: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: code, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(cents / 100);
  try { return as(currency); } catch { return formatCurrency(cents, currency); }
}

/** One total per currency: summing EUR into USD would be a made-up number. */
function totalOf(deals: ReadonlyArray<{ amount?: number; currency: string }>): string {
  const totals = new Map<string, number>();
  for (const d of deals) if (d.amount !== undefined) totals.set(d.currency, (totals.get(d.currency) ?? 0) + d.amount);
  return totals.size ? [...totals].map(([currency, cents]) => formatWhole(cents, currency)).join(" · ") : formatWhole(0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * A close date as it reads in the list: "Nov 15" when every date in view is this year; else with the year, "Nov 15,
 * 2026" on a wide screen and "Nov 15 '26" on a narrow one.
 */
function CloseDate({ day, withYear }: { day: string; withYear: boolean }) {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return <>{day}</>;
  if (!withYear) return <>{MONTHS[m - 1]} {d}</>;
  return <>
    <span className="hidden min-[1280px]:inline">{MONTHS[m - 1]} {d}, {y}</span>
    <span className="min-[1280px]:hidden">{MONTHS[m - 1]} {d} &rsquo;{String(y).slice(2)}</span>
  </>;
}

/**
 * The one key the chart and the Stage column share (the --stage-* tokens in globals.css): open stages take muted,
 * separated hues that step darker along the pipeline, so green stays won's alone and no stage wears a reserved colour.
 * Lost and "No stage" take the pale stones.
 */
const STAGE_OPEN = [1, 2, 3, 4, 5, 6].map((n) => `var(--stage-${n})`);
const STAGE_WON = "var(--stage-won)";
const STAGE_LOST = "var(--stage-lost)";
const STAGE_NONE = "var(--stage-none)";

/** A cell's side padding: tighter below 1280px so a 1024px screen fits the owner's name whole. */
const CELL_X = "px-2 xl:px-3";
/** The chart's "Hide chart" choice, kept in the browser. */
const CHART_COLLAPSED_KEY = "canon.deals.chart.collapsed";
/** A row's quick view and CRM link: shown on row hover or keyboard focus, on devices that can hover; always on touch. */
const ROW_ICON = "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 focus-visible:opacity-100";

export default function DealsPage() {
  return (
    <Suspense fallback={<div className="p-4 sm:p-8"><LoadingRows /></div>}>
      <DealsView />
    </Suspense>
  );
}

function DealsView() {
  const plural = useObjectLabels()("deal")!.pluralLabel;
  const [state, setState] = useUrlState(LIST_DEFAULTS);
  const fiscalStart = useQuery(api.organizations.context)?.organization?.fiscalYearStartMonth ?? 1;
  const [exportOpen, setExportOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  // Grouped: the rows each group shows, by grouping, so another grouping starts each group at its first page again.
  const [groupShown, setGroupShown] = useState<{ by: string; n: Record<string, number> }>({ by: "", n: {} });
  const pipelines = useQuery(api.pipelines.list);
  const deals = useQuery(api.deals.list);
  // Badges the workspace's modules put on deals (Override, Held), read as the viewer reads each module's docs.
  const contributed = useQuery(api.modules.contributions, { page: "deals" });
  const badgesOf = (id: string) => (contributed ?? []).flatMap((m) => (m.badges?.[id] ?? []).map((b) => ({ ...b, module: m.title })));
  const desc = useQuery(api.objects.describe, { object: "deal" });
  const companyField = desc?.fields.filter((f) => f.apiName === "companyId") ?? [];
  const companyNames = useLookupTitles(companyField, deals?.map((d) => ({ values: { companyId: d.companyId } })));
  const [creating, setCreating] = useState(false);
  const canCreate = Boolean(desc?.canCreate);
  const canArchive = Boolean(desc?.canDelete);
  const stageField = desc?.fields.find((f) => f.apiName === "stage");
  const stageLabel = (value: string) => (stageField && "options" in stageField ? stageField.options.find((o) => o.value === value)?.label : undefined) ?? value;
  const typeField = desc?.fields.find((f) => f.apiName === "dealType");
  const typeOptions = typeField && "options" in typeField ? typeField.options : [];
  const typeLabel = (value: string) => typeOptions.find((o) => o.value === value)?.label ?? value;
  const companyOf = (d: NonNullable<typeof deals>[number]) => (d.company.kind === "stored" ? companyNames[d.company.companyId] : d.accountName) ?? "";
  const stageText = (d: NonNullable<typeof deals>[number]) => (d.isClosed ? (d.isWon ? "Closed won" : "Closed lost") : d.stage ? stageLabel(d.stage) : "");
  // Each stage's swatch, by the text the chart's split and the Stage column show.
  const stageStyles = useMemo(() => {
    const out = new Map<string, { color: string; order: number }>();
    const open = [...new Set((pipelines ?? []).flatMap((p) => p.stages.filter((st) => st.forecastCategory !== "closed_won" && st.forecastCategory !== "closed_lost").map((st) => stageLabel(st.value))))];
    // One token per stage while they last; a longer pipeline spreads its stages over the six, still in order.
    open.forEach((label, i) => out.set(label, { color: STAGE_OPEN[open.length <= STAGE_OPEN.length ? i : Math.floor((i * STAGE_OPEN.length) / open.length)], order: i }));
    out.set("Closed won", { color: STAGE_WON, order: open.length });
    out.set("Closed lost", { color: STAGE_LOST, order: open.length + 1 });
    out.set("No stage", { color: STAGE_NONE, order: open.length + 2 });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelines, desc]);
  const [chartCollapsed, setChartCollapsed] = useState(false);
  useEffect(() => {
    try {
      // Read the browser preference after mount so hydration matches the server.
      setChartCollapsed(window.localStorage.getItem(CHART_COLLAPSED_KEY) === "true");
    } catch { /* Storage may be disabled; keep the default for this visit. */ }
  }, []);
  const toggleChart = () => {
    const next = !chartCollapsed;
    setChartCollapsed(next);
    try { window.localStorage.setItem(CHART_COLLAPSED_KEY, String(next)); } catch { /* The toggle still works without storage. */ }
  };
  const pipelineOf = (d: NonNullable<typeof deals>[number]) => (pipelines && d.stage ? stageOf(pipelines, d.stage)?.pipeline.name : undefined) ?? "No pipeline";
  const owners = useMemo(() => [...new Map((deals ?? []).map((d) => [d.primaryRepId ?? "", d.primaryRepName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [deals]);
  // The close-date range persists per person: opened with no from/to, the page takes the range they last chose.
  const me = useQuery(api.users.me);
  const restore = useRef<{ checked: boolean; pending: { from: string; to: string } | null }>({ checked: false, pending: null });
  useEffect(() => {
    if (!me?._id) return;
    const key = rangeKey(me._id);
    if (!restore.current.checked) {
      restore.current.checked = true;
      if (!state.from && !state.to) {
        let saved: { from?: string; to?: string; range?: string } | null = null;
        try { saved = JSON.parse(window.localStorage.getItem(key) ?? "null"); } catch { saved = null; }
        if (saved && (saved.from || saved.to)) {
          restore.current.pending = { from: saved.from ?? "", to: saved.to ?? "" };
          setState({ from: saved.from ?? "", to: saved.to ?? "", range: saved.range ?? "" });
          return;
        }
      }
    }
    // Until the restored range reaches the URL, the empty one isn't the person's choice.
    const pending = restore.current.pending;
    if (pending) { if (pending.from !== state.from || pending.to !== state.to) return; restore.current.pending = null; }
    try {
      if (state.from || state.to) window.localStorage.setItem(key, JSON.stringify({ from: state.from, to: state.to, range: state.range }));
      else window.localStorage.removeItem(key);
    } catch { /* a full or blocked storage keeps nothing */ }
  }, [me?._id, state.from, state.to, state.range, setState]);
  // Split by persists per person too: no `split` in the URL reads the one they last picked, else stage.
  const [savedSplit, setSavedSplit] = useState<string | null>(null);
  useEffect(() => {
    if (!me?._id) return;
    try { setSavedSplit(window.localStorage.getItem(splitKey(me._id))); } catch { setSavedSplit(null); }
  }, [me?._id]);
  const split = SPLITS.some((x) => x.value === state.split) ? state.split : SPLITS.some((x) => x.value === savedSplit) ? savedSplit! : DEFAULT_SPLIT;
  const pickSplit = (value: string) => {
    setState({ split: value });
    setSavedSplit(value);
    if (me?._id) try { window.localStorage.setItem(splitKey(me._id), value); } catch { /* a full or blocked storage keeps nothing */ }
  };
  // Split by stage, the chart takes the Stage column's swatches in pipeline order.
  const stageStyle = useMemo((): SeriesStyle | undefined => (split === "stage" ? (key) => stageStyles.get(String(key)) : undefined), [split, stageStyles]);
  // The stages a Stage filter offers: the picked pipeline's, else every pipeline's (named by pipeline when there are several).
  const stageChoices = useMemo(() => (pipelines ?? []).filter((p) => !state.pipeline || p.name === state.pipeline)
    .flatMap((p) => p.stages.map((st) => ({ value: st.value, label: (pipelines?.length ?? 0) > 1 && !state.pipeline ? `${p.name} · ${st.label}` : st.label }))), [pipelines, state.pipeline]);
  const sortKey = (state.sort.replace(/^-/, "") as SortKey);
  const descending = state.sort.startsWith("-");

  const rows = useMemo(() => {
    if (!deals) return null;
    const q = (state.q ?? "").trim().toLowerCase();
    const by: Record<SortKey, (d: NonNullable<typeof deals>[number]) => string | number> = {
      name: (d) => d.name.toLowerCase(), account: (d) => companyOf(d).toLowerCase(), amount: (d) => d.amount ?? -Infinity,
      stage: (d) => stageText(d).toLowerCase(), closeDate: (d) => d.closeDate, owner: (d) => d.primaryRepName.toLowerCase(),
    };
    const key = by[SORTS.includes(sortKey) ? sortKey : "closeDate"];
    return deals
      .filter((d) => {
        if (!matchesDealStatus(state.status, d)) return false;
        if (state.owner && (d.primaryRepId ?? "") !== state.owner) return false;
        if (state.type && d.dealType !== state.type) return false;
        if (state.pipeline && pipelineOf(d) !== state.pipeline) return false;
        if (state.stage && (d.stage ?? "") !== state.stage) return false;
        // A close-date range (a pay period, "last quarter"): deals closing from `from` through `to`.
        if (state.from && d.closeDate < state.from) return false;
        if (state.to && d.closeDate > state.to) return false;
        return !q || d.name.toLowerCase().includes(q) || companyOf(d).toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const x = key(a), y = key(b);
        const c = x < y ? -1 : x > y ? 1 : a.closeDate.localeCompare(b.closeDate);
        return descending ? -c : c;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, companyNames, pipelines, state.status, state.q, state.owner, state.type, state.pipeline, state.stage, state.from, state.to, sortKey, descending]);

  // Grouped, the groups come in name order (close months in date order), each keeping the sort inside it.
  const groupOf = useMemo(() => {
    const by: Record<string, (d: NonNullable<typeof deals>[number]) => string> = {
      owner: (d) => d.primaryRepName, stage: (d) => stageText(d) || "No stage", type: (d) => typeLabel(d.dealType),
      pipeline: pipelineOf, month: (d) => d.closeDate.slice(0, 7),
    };
    return by[state.group];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.group, pipelines, desc]);
  const ordered = useMemo(() => {
    if (!rows || !groupOf) return rows;
    const groups = new Map<string, typeof rows>();
    for (const d of rows) groups.set(groupOf(d), [...(groups.get(groupOf(d)) ?? []), d]);
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, ds]) => ds);
  }, [rows, groupOf]);
  const groupDeals = useMemo(() => {
    const out = new Map<string, NonNullable<typeof rows>>();
    if (groupOf) for (const d of rows ?? []) out.set(groupOf(d), [...(out.get(groupOf(d)) ?? []), d]);
    return out;
  }, [rows, groupOf]);
  const groupName = (g: string) => (state.group === "month" ? bucketLabel(`${g}-01`, "month") : g);

  const totalText = totalOf(rows ?? []);
  // Deal value over time: the listed deals' amounts by close month, quarter or year (the first currency's, when they mix).
  const chart = useMemo((): Presented | null => {
    if (!rows?.length) return null;
    const currency = rows.find((d) => d.amount !== undefined)?.currency ?? "USD";
    const span = GRAIN_MONTHS[state.grain] ?? 1;
    const grainName = state.grain === "year" ? "Close year" : state.grain === "quarter" ? "Close quarter" : "Close month";
    const byPeriod = new Map<string, number>();
    for (const d of rows) if (d.amount !== undefined && d.currency === currency) { const k = periodStart(d.closeDate, span); byPeriod.set(k, (byPeriod.get(k) ?? 0) + d.amount); }
    // Split by: each period's bar stacked by the deals' owner, stage, type or account.
    const splitOf: ((d: NonNullable<typeof rows>[number]) => string) | null = split === "owner" ? (d) => d.primaryRepName || "Unassigned"
      : split === "stage" ? (d) => stageText(d) || "No stage" : split === "type" ? (d) => typeLabel(d.dealType) || "No type"
      : split === "account" ? (d) => companyOf(d) || "No account" : null;
    const bySplit = new Map<string, number>();
    if (splitOf) for (const d of rows) if (d.amount !== undefined && d.currency === currency) { const k = `${periodStart(d.closeDate, span)}\u0000${splitOf(d)}`; bySplit.set(k, (bySplit.get(k) ?? 0) + d.amount); }
    // Every period from the first to the last (36 at most), so a period with nothing shows as nothing.
    const keys = [...byPeriod.keys()].sort();
    const periods: Array<[string, number]> = [];
    for (let at = keys[0]; at && at <= keys[keys.length - 1] && periods.length < 36; at = nextPeriod(at, span)) periods.push([at, byPeriod.get(at) ?? 0]);
    const money = (_: number, v: number | null) => (v === null ? "" : formatCurrency(v, currency));
    const formatCompact = (_: number, v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(v / 100);
    if (splitOf) {
      const parts = [...new Set([...bySplit.keys()].map((k) => k.split("\u0000")[1]))].sort();
      const groups = periods.flatMap(([p]) => parts.flatMap((part) => { const v = bySplit.get(`${p}\u0000${part}`); return v === undefined ? [] : [{ keys: [p, part], labels: [periodLabel(p, state.grain), part], values: [v] }]; }));
      return {
        keyLabels: [grainName, SPLITS.find((x) => x.value === split)!.label.replace("Split by ", "").replace(/^./, (c) => c.toUpperCase())], measureLabels: [`Amount (${currency})`],
        groups, subtotals: periods.map(([p, v]) => ({ keys: [p], labels: [periodLabel(p, state.grain)], values: [v] })),
        total: [periods.reduce((n, [, v]) => n + v, 0)], rows: groups.length, truncated: false, additive: true, whole: false, format: money, formatCompact,
      };
    }
    return {
      keyLabels: [grainName], measureLabels: [`Amount (${currency})`],
      groups: periods.map(([p, v]) => ({ keys: [p], labels: [periodLabel(p, state.grain)], values: [v] })),
      subtotals: [], total: [periods.reduce((n, [, v]) => n + v, 0)], rows: periods.length, truncated: false, additive: true, whole: false, format: money, formatCompact,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, split, state.grain, companyNames]);
  // Split by stage, the stages the chart draws (the smallest fold into Other past six) in pipeline order with their
  // swatches, for the title row's legend; Other goes last in the chart's own gray.
  const stageLegend = useMemo(() => {
    if (split !== "stage" || !chart || chart.keyLabels.length < 2) return null;
    const drawn = stackedSeries(chart);
    return drawn.map((s) => s.other
      ? { label: s.label, color: s.color, order: Number.MAX_SAFE_INTEGER }
      : { label: s.label, color: stageStyles.get(s.label)?.color ?? STAGE_NONE, order: stageStyles.get(s.label)?.order ?? Number.MAX_SAFE_INTEGER - 1 })
      .sort((a, b) => a.order - b.order);
  }, [split, chart, stageStyles]);
  /** The listed deals, as filtered and sorted, as a file: CSV or an Excel workbook. */
  const exportRows = (format: "csv" | "xlsx") => {
    const header = ["Deal", "Account", "Amount", "Currency", "Stage", "Close date", "Owner", "Deal type"];
    const body = (ordered ?? []).map((d) => [d.name, companyOf(d), d.amount === undefined ? "" : (d.amount / 100).toFixed(2), d.currency, stageText(d), d.closeDate, d.primaryRepName, typeLabel(d.dealType)]);
    const name = `${plural.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
    if (format === "csv") saveFile([header, ...body].map((r) => r.map(csvCell).join(",")).join("\n"), "text/csv", `${name}.csv`);
    else saveFile(Uint8Array.from(atob(base64(xlsx(plural, header, body, ["text", "text", "money", "text", "text", "date", "text", "text"]))), (c) => c.charCodeAt(0)), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `${name}.xlsx`);
    toast.success(`Exported ${body.length} ${body.length === 1 ? "deal" : plural.toLowerCase()}`);
  };
  // Grouped, each group pages on its own: its first rows, then more on a click on its own "Show more".
  const groupLimit = (g: string) => (groupShown.by === state.group ? groupShown.n[g] : undefined) ?? GROUP_PAGE;
  const visible = groupOf
    ? (() => { const seen = new Map<string, number>(); return (ordered ?? []).filter((d) => { const g = groupOf(d); const n = seen.get(g) ?? 0; seen.set(g, n + 1); return n < groupLimit(g); }); })()
    : (ordered ?? []).slice(0, shown);
  const datesWithYear = visible.some((d) => Number(d.closeDate.slice(0, 4)) !== new Date().getFullYear());
  const footer = useRef<HTMLDivElement>(null);
  const tableBox = useRef<HTMLDivElement>(null);
  const [rowsBeneath, setRowsBeneath] = useState(false);
  useEffect(() => {
    const scroller = footer.current?.closest<HTMLElement>("#main") ?? null;
    // Rows run on beneath the pinned footer when the table's bottom is below the footer's.
    const check = () => {
      const f = footer.current?.getBoundingClientRect(), t = tableBox.current?.getBoundingClientRect();
      setRowsBeneath(Boolean(f && t && t.bottom > f.top + 1));
      if (scroller && footer.current) scroller.style.scrollPaddingBottom = `${footer.current.offsetHeight}px`;
    };
    check();
    document.addEventListener("scroll", check, true);
    window.addEventListener("resize", check);
    return () => {
      document.removeEventListener("scroll", check, true);
      window.removeEventListener("resize", check);
      if (scroller) scroller.style.scrollPaddingBottom = "";
    };
  }, [visible.length, chartCollapsed]);
  const showMore = (g: string) => setGroupShown((was) => ({ by: state.group, n: { ...(was.by === state.group ? was.n : {}), [g]: groupLimit(g) + GROUP_PAGE } }));
  const sortBy = (key: SortKey) => setState({ sort: sortKey === key && !descending ? `-${key}` : key });
  // Every header keeps a fixed slot right of its label: the active sort's arrow in ink, a muted ↕ on hover or focus.
  const SortHeader = ({ k, label, end }: { k: SortKey; label: string; end?: boolean }) => (
    <th className={cn("whitespace-nowrap py-1.5", CELL_X, end && "text-right")} aria-sort={sortKey === k ? (descending ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => sortBy(k)}
        className="group/sort -mx-1 inline-flex items-center gap-1 px-1 py-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {label}
        <span aria-hidden className="inline-flex w-3 justify-center">
          {sortKey !== k ? <ArrowUpDown className="h-3 w-3 opacity-0 group-hover/sort:opacity-50 group-focus-visible/sort:opacity-50" />
            : descending ? <ArrowDown className="h-3 w-3 text-foreground" /> : <ArrowUp className="h-3 w-3 text-foreground" />}
        </span>
        {sortKey !== k && <span className="sr-only">, sortable</span>}
      </button>
    </th>
  );

  return (
    <ViewFrame title={plural} actions={[
      ...(canCreate ? [{ id: "deals-new", label: "New deal", onClick: () => setCreating(true), primary: true }] : []),
    ]} secondaryActions={<>
      <span className="relative inline-flex" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExportOpen(false); }}>
        <button type="button" className="view-action" aria-haspopup="menu" aria-expanded={exportOpen} disabled={!rows?.length} onClick={() => setExportOpen((o) => !o)}><Download className="h-3.5 w-3.5" />Export<ChevronDown className="h-3 w-3" /></button>
        {exportOpen && (
          <span role="menu" className="absolute top-full right-0 z-20 mt-1 flex min-w-40 flex-col border border-border bg-popover py-1 text-xs shadow-sm">
            <button type="button" role="menuitem" className="px-3 py-1.5 text-left hover:bg-muted" onClick={() => { setExportOpen(false); exportRows("csv"); }}>CSV (.csv)</button>
            <button type="button" role="menuitem" className="px-3 py-1.5 text-left hover:bg-muted" onClick={() => { setExportOpen(false); exportRows("xlsx"); }}>Excel (.xlsx)</button>
          </span>
        )}
      </span>
      {canCreate && <CsvImport object="deal" label="deals" className="view-action" />}
    </>} filterReset={{ onClick: () => setState({ ...DEAL_FILTER_DEFAULTS, owner: "", type: "", pipeline: "", stage: "", group: "", from: "", to: "", range: "", grain: "" }), disabled: isDefaultDealFilter(state) && !state.owner && !state.type && !state.pipeline && !state.stage && !state.group && !state.from && !state.to && !state.grain }} controls={<div className="flex flex-col gap-2">
        {/* Status and search share a row with the bar's trailing actions (Board, Archived, Clear filters); the filters sit below. */}
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Deal status" className="flex h-8 border border-border text-xs">
            {DEAL_STATUSES.map((s) => (
              <button
                key={s.key}
                role="radio"
                aria-checked={state.status === s.key}
                onClick={() => setState({ status: s.key })}
                className={cn("h-full px-2.5", state.status === s.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {s.label}
              </button>
            ))}
          </div>
          <input
            aria-label="Search deals"
            value={state.q ?? ""}
            onChange={(event) => setState({ q: event.target.value })}
            placeholder="Search deal or account"
            className="h-8 w-40 border border-border bg-background px-2.5 text-xs placeholder:text-muted-foreground"
          />
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {/* The view: this list or the board, as a segmented control like the status one, the current view filled. */}
            <span role="group" aria-label="View" className="flex h-8 border border-border text-xs">
              {/* The current view is muted, not green: green stays for primary actions. */}
              <span aria-current="page" className="flex h-full items-center gap-1.5 border-r border-border bg-muted px-2.5 font-medium text-foreground"><List aria-hidden className="h-3.5 w-3.5" />List</span>
              <Link href="/dashboard/records/deal?layout=board" className="flex h-full items-center gap-1.5 px-2.5 text-muted-foreground hover:text-foreground">
                <KanbanSquare aria-hidden className="h-3.5 w-3.5" />Board
              </Link>
            </span>
            {canArchive && (
              <Link href="/dashboard/records/deal?bin=1" className="view-action">
                <Archive className="h-3.5 w-3.5" /> Archived
              </Link>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SelectField aria-label="Filter by owner" value={state.owner} onValueChange={(v) => { setState({ owner: v }); setShown(PAGE); }}
            options={[{ value: "", label: "All owners" }, ...owners.map(([id, name]) => ({ value: id, label: id ? name : "Unassigned" }))]} />
          <SelectField aria-label="Filter by deal type" value={state.type} onValueChange={(v) => { setState({ type: v }); setShown(PAGE); }}
            options={[{ value: "", label: "All types" }, ...typeOptions.map((o) => ({ value: o.value, label: o.label }))]} />
          {(pipelines?.length ?? 0) > 1 && (
            <SelectField aria-label="Filter by pipeline" value={state.pipeline} onValueChange={(v) => { setState({ pipeline: v, stage: "" }); setShown(PAGE); }}
              options={[{ value: "", label: "All pipelines" }, ...pipelines!.map((p) => ({ value: p.name, label: p.name }))]} />
          )}
          {stageChoices.length > 0 && (
            <SelectField aria-label="Filter by stage" value={state.stage} onValueChange={(v) => { setState({ stage: v }); setShown(PAGE); }}
              options={[{ value: "", label: "All stages" }, ...stageChoices]} />
          )}
          <DateRangeInput label="Close date" fiscalYearStartMonth={fiscalStart} value={state.from || state.to ? { from: state.from || null, to: state.to || null, label: state.range || undefined } : null}
            onChange={(r) => { setState({ from: r?.from ?? "", to: r?.to ?? "", range: r?.label ?? "" }); setShown(PAGE); }} />
          <SelectField aria-label="Group by" value={state.group} onValueChange={(v) => setState({ group: v })} options={GROUPS.filter((g) => g.value !== "pipeline" || (pipelines?.length ?? 0) > 1)} />
        </div>
      </div>}>
      <CallSuggestions className="mb-2" />

      {rows === null ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={TrendingUp}
          title={deals?.length ? "No deals match" : "No deals yet"}
          description={deals?.length ? "Change the status or clear the search." : "Create a deal here, or import deals from HubSpot or Salesforce."}
          action={deals?.length || !canCreate ? undefined : { label: "New deal", onClick: () => setCreating(true) }}
        />
      ) : (
        <>
          {chart && ((chart.subtotals.length || chart.groups.length) > 1 || state.grain !== "") && (
            <section aria-label="Deal value over time" className="mb-3 border border-border px-3 py-1.5">
              {/* Title and legend wrap together (the legend onto its own line when both don't fit); the controls stay right. */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
                <h2 className="flex shrink-0 items-center gap-2 text-xs">
                  <button type="button" aria-expanded={!chartCollapsed} aria-controls="deals-chart" onClick={toggleChart}
                    className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                    {chartCollapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
                    {chartCollapsed ? "Show chart" : "Hide chart"}
                  </button>
                  <span className="whitespace-nowrap font-medium text-foreground">
                    {chart.measureLabels[0].replace(/^Amount/, "Deal value")} by {chart.keyLabels[0].toLowerCase()}
                  </span>
                </h2>
                {/* Split by stage, the legend sits in the title row (the stages' own tokens), so the panel stays short. */}
                {stageLegend && !chartCollapsed && (
                  <ul aria-label="Stages" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {stageLegend.map((st) => (
                      <li key={st.label} className="flex items-center gap-1.5"><span aria-hidden className="size-3 shrink-0" style={{ background: st.color }} />{st.label}</li>
                    ))}
                  </ul>
                )}
                </div>
                {!chartCollapsed && (
                  <span className="flex items-center gap-2">
                    <SelectField aria-label="Time grain" value={state.grain} onValueChange={(v) => setState({ grain: v })} options={GRAINS} />
                    <SelectField aria-label="Split by" value={split} onValueChange={pickSplit} options={SPLITS} />
                  </span>
                )}
              </div>
              <div id="deals-chart" hidden={chartCollapsed} className="mt-1">
                {!chartCollapsed && <ReportChart p={chart} kind="column" height={150} tightAxis caption={false} seriesStyle={stageStyle} maxBarWidth={72}
                  display={split !== "none" ? { stacked: true, labels: true, ...(stageLegend ? { legend: "none" as const } : {}) } : { labels: true }} />}
              </div>
            </section>
          )}
          <div ref={tableBox} className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <SortHeader k="name" label="Deal" />
                  <SortHeader k="account" label="Account" />
                  <SortHeader k="amount" label="Amount" end />
                  <SortHeader k="stage" label="Stage" />
                  <SortHeader k="closeDate" label="Close date" />
                  <SortHeader k="owner" label="Owner" />
                </tr>
              </thead>
              <tbody>
                {visible.map((d, i) => [
                  ...(groupOf && (i === 0 || groupOf(visible[i - 1]) !== groupOf(d)) ? [
                    <tr key={`group:${groupOf(d)}`} className="border-t border-border bg-muted/40" data-group={groupOf(d)}>
                      <th colSpan={2} scope="colgroup" className="px-3 py-1.5 text-left text-xs font-medium">
                        {groupName(groupOf(d))} <span className="font-normal text-muted-foreground">· {groupDeals.get(groupOf(d))?.length ?? 0} {groupDeals.get(groupOf(d))?.length === 1 ? "deal" : "deals"}</span>
                      </th>
                      <td className="px-3 py-1.5 text-right text-xs font-medium tabular-nums">{totalOf(groupDeals.get(groupOf(d)) ?? [])}</td>
                      <td colSpan={3} />
                    </tr>,
                  ] : []),
                  <tr key={d._id} className="group border-t border-border">
                    {/* One line with an ellipsis; the full name is the link's title. On row hover or focus it reads as a link. */}
                    <td className={cn("w-[36%] max-w-0 py-2 record-name", CELL_X)}>
                      <div className="flex min-w-0 items-center gap-1">
                        {d.streamId ? (
                          <>
                            <RecordLink object="deal" id={d.streamId} title={d.name} className="line-clamp-2 min-w-0 underline-offset-2 hover:underline group-hover:underline focus-visible:underline">
                              {d.name}
                            </RecordLink>
                            <RecordQuickView object="deal" id={d.streamId} label={d.name} className={ROW_ICON} />
                          </>
                        ) : <span className="line-clamp-2 min-w-0" title={d.name}>{d.name}</span>}
                        {d.crmUrl && (
                          <a href={d.crmUrl} target="_blank" rel="noreferrer" aria-label="Open in CRM" className={cn("ml-0.5 shrink-0 text-muted-foreground hover:text-foreground", ROW_ICON)}>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {badgesOf(d._id).map((b) => (
                          <span key={`${b.module}:${b.label}`} title={`From ${b.module}`} data-module-badge={b.label}
                            className={cn("ml-1 shrink-0 border px-1.5 py-0.5 text-[11px] font-medium", MODULE_BADGE_TONES[b.tone ?? "neutral"] ?? MODULE_BADGE_TONES.neutral)}>{b.label}</span>
                        ))}
                      </div>
                    </td>
                    {/* Account gives its width to the deal name: one line, the full text in the title. */}
                    <td className={cn("w-[16%] max-w-0 truncate py-2", CELL_X)} title={companyOf(d) || undefined}>
                      {d.company.kind === "stored" ? (
                        <RecordLink className="hover:underline" object="account" id={d.company.companyId}>
                          {companyNames[d.company.companyId] ?? "…"}
                        </RecordLink>
                      ) : d.accountDomain ? (
                        <Link className="hover:underline" href={`/dashboard/accounts?q=${encodeURIComponent(d.accountDomain)}`}>
                          {d.accountName ?? d.accountDomain}
                        </Link>
                      ) : (
                        d.accountName ?? <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={cn("whitespace-nowrap py-2 text-right tabular-nums", CELL_X)}>
                      {d.amount === undefined ? <span className="text-muted-foreground">—</span> : formatWhole(d.amount, d.currency)}
                    </td>
                    <td className={cn("py-2", CELL_X)}>
                      {/* A badge, not a control: a soft fill tinted from the stage's token, no border, its swatch kept. */}
                      {stageText(d) ? (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap px-1 py-px text-xs text-foreground"
                          style={{ background: `color-mix(in srgb, ${stageStyles.get(stageText(d))?.color ?? STAGE_NONE} 16%, var(--background))` }}>
                          <span aria-hidden className="size-2.5 shrink-0" style={{ background: stageStyles.get(stageText(d))?.color ?? STAGE_NONE }} />
                          {stageText(d)}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className={cn("whitespace-nowrap py-2 tabular-nums", CELL_X)} title={d.closeDate}><CloseDate day={d.closeDate} withYear={datesWithYear} /></td>
                    <td className={cn("whitespace-nowrap py-2", CELL_X)}>{d.primaryRepName}</td>
                  </tr>,
                  ...(() => {
                    // The group's last shown row: its hidden rows, if any, a click away.
                    if (!groupOf || (i + 1 < visible.length && groupOf(visible[i + 1]) === groupOf(d))) return [];
                    const g = groupOf(d), left = (groupDeals.get(g)?.length ?? 0) - groupLimit(g);
                    return left > 0 ? [
                      <tr key={`more:${g}`} className="border-t border-border">
                        <td colSpan={6} className="px-3 py-1.5 text-xs">
                          <button type="button" className="font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={() => showMore(g)}>
                            Show {Math.min(GROUP_PAGE, left)} more of {left} in {groupName(g)}
                          </button>
                        </td>
                      </tr>,
                    ] : [];
                  })(),
                ])}
              </tbody>
            </table>
          </div>
          {/*
            Pinned to the bottom so the count, total and action stay in view. The page's scroll area keeps a bottom padding
            of the footer's height, so focus and the scroll's end never leave a row under it; while rows run on beneath
            it, a top border and shadow mark the edge.
          */}
          <div ref={footer} className={cn("sticky bottom-0 flex flex-wrap items-center gap-3 border border-t-0 border-border bg-card px-3 py-2 text-xs", rowsBeneath && "border-t border-t-foreground/25 shadow-[0_-8px_10px_-6px_rgb(0_0_0/0.22)]")}>
            <span role="status" className="flex items-center gap-3">
              <span className="tabular-nums text-muted-foreground">
                {visible.length < rows.length ? `${visible.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "deal" : "deals"} · <span className="font-medium text-foreground">Total {totalText}</span>
              </span>
            </span>
            {!groupOf && visible.length < rows.length && (
              <button type="button" className="border border-border px-2 py-1 font-medium hover:bg-muted" onClick={() => setShown((n) => n + PAGE)}>
                Load {Math.min(PAGE, rows.length - visible.length)} more
              </button>
            )}
            <span className="ml-auto"><DealGapScan /></span>
          </div>
          {deals && deals.length >= 200 && (
            <p className="mt-2 text-xs text-muted-foreground">Showing the 200 most recent deals.</p>
          )}
        </>
      )}
      {desc && canCreate && (
        <DealCreateDialog
          desc={desc}
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void toast.success("Created deal");
          }}
        />
      )}

    </ViewFrame>
  );
}
