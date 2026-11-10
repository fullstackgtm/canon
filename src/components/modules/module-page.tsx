"use client";

import { integrationNeeds } from "../../../convex/lib/integrationsAvailable.ts";

import { SequenceLaunchReview } from "./sequence-launch-review";
import { HierarchyAdd, HierarchyLabel, ModuleInlineInput, ModuleRecordEditor, rowChoices, type EditorAccess } from "./module-editors";
import { ModuleCsvImport } from "./module-csv-import";
import { hierarchyRows, visibleHierarchy, type EditorCall } from "../../../modules/kernel/editor";

import { Component, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { runModuleOp } from "@/lib/module-op";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, GripVertical, MoreHorizontal, Paperclip, Plus, Printer, RefreshCw, Search, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2, Upload, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePageCallLoads, type Loaded, type PageLoads } from "./page-call-loads";
import type { ActionRef, ActionWhen, CallResult, Column, ColumnTone, ComponentName, ExportMembers, TableChipWhen, ExportFormat, FieldOptions, FormField, FormExpr, InitialExpr, KpiExtras, KpiItem, Node, PageExpr, PageWhen, FormPrefill, RowChoices, TableKeys, Text, ToneName } from "../../../modules/kernel/manifest";
import { blockedId, formArguments, eachItems, expandColumns, nodeShows, rowsOfValue } from "../../../modules/kernel/document";
import { coreOf, mapFieldSpecAt, withFieldChoices, mustTick, startWithin, type FieldSpec, type Widget } from "../../../modules/kernel/schema";
import { LoadingRows } from "@/components/dashboard";
import { DateInput } from "@/components/ui/date-input";
import { MultiSelect } from "@/components/ui/multi-select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { moduleCallCache } from "@/lib/module-call-cache";
import { columnText, fillPath, fiscalYearLabel, fiscalYearOf, formatValue, renderFilled, renderText, rowWhenHolds, valueAt, type Doc, type TextScope } from "../../../modules/kernel/text";
import { arrange, choicesOf, queryFromState, stateFromQuery, total, totalText, type Kind, type Shown, type TableState } from "../../../modules/kernel/rows";
import { FieldsEditor, FormEnvProvider, draftsFor, fromDraft, human, setField, withInherited, type Draft, type FormFieldInfo } from "./module-form";
import { ModulePacing } from "./module-pacing";
import { ModuleDashboards } from "./module-dashboards";
import { FlowCanvas, FlowRows, type FlowNode, type FlowTone } from "@/components/flow/flow-canvas";
import { ModuleChart, ModuleReport, ModuleTree, canonHref, canonRecordOf, type Palette, type ReportEnv, type RowsEnv } from "./module-report";
import { ShareLinks } from "./share-links";
import { DateRangeInput } from "./date-range-input";
import { CallContact } from "@/components/crm/call-contact";
import { DialerConsole } from "@/components/crm/dialer-console";
import { jsonQueryValue, parsePeopleFilter, peopleListHref } from "@/lib/people-list";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { listColumns } from "../../../convex/lib/objects/listSpec";
import { collapseDayFilters, dayColumnsOf } from "../../../convex/lib/objects/views";
import { ModuleOutbox, SendPreview } from "./module-outbox";
import { rowChoicesOf } from "../../../modules/kernel/rowChoices";
import { parseDateRange } from "../../../modules/kernel/dateRange";
import { ModuleProse } from "./module-prose";
import { IcpViewer } from "@/components/icps/icp-viewer";
import { ModuleSetMap } from "./module-set-map";
import { focusQuery, focusedKey } from "../../../modules/kernel/setMap";
import { plainConvexMessage } from "../../lib/convexErrorText";

type View = Exclude<NonNullable<FunctionReturnType<typeof api.modules.page>>, { upgrading: unknown }>;
type Ready = View & { page: NonNullable<View["page"]> };
type OpInfo = Ready["ops"][string];
type FieldInfo = OpInfo["fields"][number];
type TransitionInfo = Ready["machines"][string]["transitions"][string];
type OpRef = Extract<ActionRef, { op: string }>;
type TransitionRef = Extract<ActionRef, { transition: string }>;
type CallRef = Extract<ActionRef, { call: string }>;
type ExportRef = Extract<ActionRef, { export: string }>;
type CanonRef = Extract<ActionRef, { canon: string }>;
type PdfRef = Extract<ActionRef, { pdf: string }>;
type MenuRef = Extract<ActionRef, { menu: string }>;
/** A row of a call's value: its fields as `data`, its key its `key` or `id` field (else its place). Not a doc. */
type Row = Doc & { call?: true };
/** Whether the server judged an action on a call's row: the doc it names (its version and state), and why it can't run now. */
type Judged = { reason: string | null; version: number | null; state: string | null; missing: boolean; data?: Record<string, unknown> };
type Event = NonNullable<Ready["events"][string]>[number];

const btn = "inline-flex items-center gap-1 whitespace-nowrap border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90");
/**
 * What every component renders with: the page, its text scope, how to run an action, how to read a page value, and
 * the values the page's calls returned, by call.
 */
type Ctx = {
  editor: EditorAccess;
  view: Ready; text: TextScope; run: (a: ActionRef, row?: Doc, judged?: Record<string, Judged>, format?: ExportFormat, rowLink?: string) => void; base: string; value: (x: PageExpr | undefined) => string | undefined;
  results: Record<string, unknown>; setResult: (call: string, value: unknown) => void;
  /** The URL's parameters, and how to change some of them (null removes one) without leaving the page. */
  query: Readonly<Record<string, string>>; setQuery: (changes: Record<string, string | null>) => void;
  rowHover: Record<string, string | null>; hoverRow: (param: string, key: string | null) => void;
  /** Read more rows of a list binding. */
  more: (bind: string) => void;
  /** A value a form or an action takes from the page: a page value, a field of a bound doc or of the row, or today. */
  formValue: (e: FormExpr, row?: Doc) => unknown;
  /** What the server judged of the actions on a call's rows, by `judgeId`: set by the table that shows them. */
  judged?: Record<string, Judged>;
  /** The values of the calls the page loads on open, by binding (undefined while one runs), and how to run one again. */
  loaded: Record<string, Loaded>; reload: (bind: string) => void;
  /** Run every call the page loaded again, after writes elsewhere on it. */
  reloadAll: () => Promise<boolean>;
  /** What the page's reports and charts read with: the module, its members, each reported collection's palette. */
  reportEnv: ReportEnv;
  /** Open a page of the dashboard. */
  go: (href: string) => void;
};
/** An action waiting on Canon's confirm dialog. */
type Confirming = { title: string; description?: string; confirmLabel?: string; destructive?: boolean; run: () => Promise<void> };
/** The pages (by workspace, person, module and path) whose `persist` parameters this tab has taken back once. */
const RESTORED = new Set<string>();

/** The doc an action acts on: the doc its `target` binds, else the table row it sits in. */
const targetOf = (a: ActionRef, ctx: Ctx, row?: Doc): Doc | undefined => ("target" in a && a.target ? ((ctx.view.data[a.target] as Doc | null) ?? undefined) : row);
const transitionOf = (a: TransitionRef, ctx: Ctx): TransitionInfo | undefined => ctx.view.machines[a.machine]?.transitions[a.transition];
/**
 * Whether an action's `when` holds on a doc's (or a row's) fields: a value among `in`, a field set or not, or a member
 * field naming the person (`me: true`) or not (`me: false`).
 */
const whenHolds = (w: ActionWhen, data: Record<string, unknown>, me: string | null) => {
  const v = data[w.field];
  if ("me" in w) return (!!me && (Array.isArray(v) ? v : [v]).includes(me)) === w.me;
  return "set" in w ? (v !== undefined && v !== null && v !== "") === w.set : w.in.includes((v ?? null) as never);
};
/** A page value an action's `when` tests: a URL parameter (or its default), a route parameter, or a bound doc's field. */
function pageValueOf(w: PageWhen, ctx: Ctx): unknown {
  const pv = w.page;
  if ("query" in pv) { const q = ctx.query[pv.query]; return q !== undefined && q !== "" ? q : pv.default ?? null; }
  if ("route" in pv) return (ctx.view.params as Record<string, string>)[pv.route] ?? null;
  const doc = ctx.view.data[pv.bind] as Doc | null | undefined;
  return doc ? (pv.field === "key" ? doc.key : doc.data[pv.field] ?? null) : null;
}
/** Today's year, month (`YYYY-MM`) or date, as the person's browser has it. */
const nowAs = (what: "year" | "month" | "date") => (what === "year" ? new Date().getFullYear() : what === "month" ? today().slice(0, 7) : today());
/** Two values compared as numbers when both read as numbers (a `?year=` against this year), else as text (dates). */
const compare = (a: unknown, b: unknown) => {
  const x = Number(a), y = Number(b);
  return a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(String(b));
};
/** Whether an action's `when` on a page value holds: among `in`, set, or at least or at most a value. */
function pageWhenHolds(w: PageWhen, ctx: Ctx): boolean {
  const v = pageValueOf(w, ctx);
  if ("in" in w) return w.in.some((x) => String(x ?? "") === String(v ?? ""));
  if ("set" in w) return (v !== undefined && v !== null && v !== "") === w.set;
  if (v === null || v === undefined || v === "") return false;
  const bound = "gte" in w ? w.gte : w.lte;
  const to = bound !== null && typeof bound === "object" ? nowAs(bound.now) : bound;
  return "gte" in w ? compare(v, to) >= 0 : compare(v, to) <= 0;
}
/** Whether an action's `when` holds: on a page value, or on its doc's (its row's or target's) fields. */
function condHolds(w: ActionWhen | PageWhen, ctx: Ctx, doc?: Doc): boolean {
  if ("page" in w) return pageWhenHolds(w, ctx);
  return !!doc && whenHolds(w, doc.data, ctx.view.userId);
}
const isCallRow = (row?: Doc): row is Row => !!row && (row as Row).call === true;
/**
 * Whether the server judges an action on a row: any write on a call's row, and on a list's row one whose `key` names
 * another doc (Hold on another collection's doc): its version, state and guards are that doc's, not the row's.
 */
const judgedOn = (a: ActionRef, row?: Doc): row is Doc => !!row && (isCallRow(row) ? "transition" in a || "op" in a : ("transition" in a || "op" in a) && "key" in a && a.key !== undefined);
/** The key of the doc an action on a call's row names (`key`, a row field), as text, or null. */
const rowDocKey = (a: ActionRef, ctx: Ctx, row: Doc): string | null => {
  const k = "key" in a && a.key !== undefined ? ctx.formValue(a.key, row) : undefined;
  return typeof k === "string" && k ? k : typeof k === "number" ? String(k) : null;
};
/** The id the server's judgement of an action on a call's row goes by. */
const judgeId = (a: ActionRef, ctx: Ctx, row: Doc) => `${row.key}|${"transition" in a ? `t:${a.machine}.${a.transition}` : "op" in a ? `op:${a.op}` : ""}|${rowDocKey(a, ctx, row) ?? ""}`;
/**
 * Whether the caller sees an action: an op their role runs, or a transition their role runs from the doc's current
 * state; with `blocked: "hide"`, only while no guard the server judged on it fails (no "Reset" to a step ahead).
 */
function offered(a: ActionRef, ctx: Ctx, row?: Doc): boolean {
  if (!offeredAtAll(a, ctx, row)) return false;
  return !("blocked" in a && a.blocked === "hide" && !ctx.view.preview && blockedReason(a, ctx, row) !== null);
}
function offeredAtAll(a: ActionRef, ctx: Ctx, row?: Doc): boolean {
  if (a.when && !condHolds(a.when, ctx, targetOf(a, ctx, row))) return false;
  if ("menu" in a) return a.items.some((x) => offered(x, ctx, row));
  // View as: an admin's, of another member (the server checks both again).
  if ("viewAs" in a) { const who = ctx.formValue(a.viewAs, row); return ctx.view.role === "admin" && typeof who === "string" && who !== "" && who !== ctx.view.userId; }
  if ("navigate" in a || "print" in a || "pdf" in a) return true;
  if ("canon" in a) return canonTarget(a, ctx, row) !== null;
  if ("export" in a) return Object.hasOwn(ctx.view.exports, a.export);
  if ("csvImport" in a) { const x = ctx.view.csvImports?.[a.csvImport]; return !!x && !!ctx.view.calls[x.call]?.allowed; }
  if ("call" in a) return !!ctx.view.calls[a.call]?.allowed;
  if (judgedOn(a, row) && ("op" in a ? a.key !== undefined : true)) {
    // On a call's row the server judged the doc it names: one the caller can't read, or not in a `from` state, hides it.
    const j = ctx.judged?.[judgeId(a, ctx, row)];
    if ("op" in a) return !!ctx.view.ops[a.op]?.allowed && !!j && !j.missing;
    const t = transitionOf(a, ctx);
    return !!t?.allowed && !!j && !j.missing && t.from.includes(j.state ?? "");
  }
  if ("op" in a) return !!ctx.view.ops[a.op]?.allowed;
  const t = transitionOf(a, ctx);
  const doc = targetOf(a, ctx, row);
  return !!t?.allowed && !!doc && t.from.includes(doc.data[ctx.view.machines[a.machine].field] as string);
}
/** Where a Canon link goes: its page, or the record of the deal (by its join), company or person the bound doc's ref names. */
function canonTarget(a: CanonRef, ctx: Ctx, row?: Doc): string | null {
  const doc = a.bind ? (ctx.view.data[a.bind] as Doc | null | undefined) : undefined;
  return withQuery(canonHref(a.canon, doc ? canonRecordOf(a.canon, doc, a.ref) : undefined), a.query, row ? { ...ctx.text, row } : ctx.text);
}
function canonPath(v: unknown): string | null {
  return typeof v === "string" && /^\/dashboard(?:\/[\w.~%-]+)*\/?(?:\?[\w.~%&=+-]*)?$/.test(v) ? v : null;
}
function webUrl(v: unknown): { href: string; host: string } | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? { href: u.href, host: u.hostname.replace(/^www\./, "") } : null;
  } catch { return null; }
}
/** A Canon page's URL with its `query`, each a text over the page and the row; an empty one is left out. */
function withQuery(href: string | null, query: Record<string, string> | undefined, scope: TextScope): string | null {
  if (!href || !query) return href;
  const qs = new URLSearchParams(Object.entries(query).flatMap(([k, t]) => { const v = renderText(t, scope); return v ? [[k, v]] : []; })).toString();
  return qs ? `${href}?${qs}` : href;
}
/** Whether an action writes: an op, a transition, or a call whose manifest lists a collection it writes. */
const writes = (a: ActionRef, ctx: Ctx) => "op" in a || "transition" in a || ("call" in a && !ctx.view.calls[a.call]?.readOnly);
/**
 * Why an offered action can't run now, as the server judged it for the page: a transition's or an op's guard on its
 * doc, or a set create's guard on its parent. The button shows disabled with it; the server checks again on click.
 */
function blockedReason(a: ActionRef, ctx: Ctx, row?: Doc): string | null {
  // An admin viewing as a member sees the member's page with every write off, and why (the server refuses them too).
  if (ctx.view.preview && writes(a, ctx)) return ctx.view.preview;
  if (judgedOn(a, row)) return ctx.judged?.[judgeId(a, ctx, row)]?.reason ?? null;
  const blocked = ctx.view.blocked as Record<string, Record<string, string>>;
  if ("transition" in a) { const doc = targetOf(a, ctx, row); return doc ? blocked[doc.key]?.[blockedId("t", `${a.machine}.${a.transition}`, a.fixed)] ?? null : null; }
  if (!("op" in a)) return null;
  if (ctx.view.ops[a.op]?.kind !== "create") { const doc = targetOf(a, ctx, row); return doc ? blocked[doc.key]?.[blockedId("op", a.op, a.fixed)] ?? null : null; }
  const parent = ctx.value(a.parent);
  return parent ? blocked[`parent:${parent}`]?.[blockedId("op", a.op, a.fixed)] ?? null : null;
}

/**
 * A module's page (docs/modules.md, "Pages"): data from the manifest that Canon renders with its own components.
 * The module endpoints check the caller again on the server for every read and write:
 * a role or `when` here only decides what shows.
 */
export function ModulePage({ module, path, query: given, embedded, fallback, frame }: {
  module: string; path: string[]; query?: Record<string, string>; embedded?: boolean;
  fallback?: ReactNode; frame?: (children: ReactNode) => ReactNode;
}) {
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  // A panel on Canon's record page (ModulePanels) gives its own parameters: the record, never the host page's URL.
  const query = given ?? Object.fromEntries(search.entries());
  // "Show more" per list binding, kept while the person stays on this page.
  const [limits, setLimits] = useState<Record<string, number>>({});
  // Writes waiting on a job's keys (`wait`), kept outside the page so one that opened another page still says its toast.
  const waits = useSyncExternalStore(WAITS.subscribe, WAITS.get, WAITS.get);
  const live = useQuery(api.modules.page, { module, path, query, limits });
  // A changed URL parameter or limit reads again; the page keeps showing what it read until then.
  const [last, setLast] = useState(live);
  if (live !== undefined && live !== last) setLast(live);
  const view = useRecordRefs(embedded ? live : live ?? last);
  // A page's `persist` parameters: opened with none of them in its URL, it first takes the ones this person last left
  // (kept in the browser by <Persist>), before any component sets its own default (a stepper's this year).
  const persist = view && "page" in view && view.page ? ((view.page as { persist?: string[] | null }).persist ?? null) : null;
  const persistId = view && "page" in view && view.page && persist?.length ? `${(view as Ready).orgId}:${(view as Ready).userId ?? ""}:${(view as Ready).module.slug}:${(view as Ready).page.path}` : null;
  let pendingRestore: Record<string, string> | null = null;
  if (persistId && persist && !RESTORED.has(persistId) && typeof window !== "undefined") {
    let saved: Record<string, unknown> | null = null;
    try { saved = JSON.parse(window.localStorage.getItem(`canon.module.page:${persistId}`) ?? "null") as Record<string, unknown> | null; } catch { saved = null; }
    const back = saved && persist.every((p) => !query[p]) ? Object.fromEntries(persist.flatMap((p) => (typeof saved![p] === "string" && saved![p] ? [[p, saved![p] as string]] : []))) : {};
    if (Object.keys(back).length) pendingRestore = back; else RESTORED.add(persistId);
  }
  useEffect(() => {
    if (!pendingRestore || !persistId) return;
    RESTORED.add(persistId);
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(pendingRestore)) next.set(k, v);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  });
  if (pendingRestore) return fallback ?? <div className="view-frame"><div className="view-frame-content"><LoadingRows count={4} /></div></div>;
  if (view === undefined) return fallback ?? <div className="view-frame"><div className="view-frame-content"><LoadingRows count={4} /></div></div>;
  if (view === null) return fallback ?? <Missing text="This module isn't on in this workspace. An admin or manager turns it on on the Customization page." />;
  if ("upgrading" in view && view.upgrading) return fallback ?? <Missing text={`${view.upgrading.title} is finishing its upgrade to v${view.upgrading.version}. It opens again in a moment.`} />;
  const failed = (view as { failed?: { message: string; text: string | null; heading?: string | null; actions?: Way[]; back: Way } }).failed;
  if (failed) return fallback ?? <Fallback message={failed.message} text={failed.text} heading={failed.heading ?? null} actions={failed.actions ?? []} back={failed.back} />;
  const gone = (view as { missing?: { text: string | null; heading?: string | null; actions?: Way[]; back: Way } }).missing;
  if (gone) return fallback ?? <NotFound text={gone.text} heading={gone.heading ?? null} actions={gone.actions ?? []} back={gone.back} />;
  if ("runtimeAvailable" in view && !view.runtimeAvailable) return fallback ?? <Missing text={integrationNeeds("recipeRuntime")} />;
  if (view.page === null) return fallback ?? <Missing text={`${view.module.title} has no such page for you.`} href={view.module.nav?.href ?? "/dashboard"} />;
  const setQuery = (changes: Record<string, string | null>) => {
    if (embedded) return;
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const more = (bind: string) => setLimits((l) => ({ ...l, [bind]: Math.min(1000, ((view as Ready).lists[bind]?.limit ?? 50) * 4) }));
  const fb = (view as Ready).page.fallback as { text?: string; heading?: string; actions?: Array<{ label: string; path: string }>; back: { label: string; path: string } } | null;
  const href = (path: string) => `/dashboard/m/${view.module.slug}/${fillPath(path, view.params as Record<string, string>)}`;
  const back = fb ? { label: fb.back.label, href: href(fb.back.path) } : { label: `Back to ${view.module.title}`, href: view.module.nav?.href ?? "/dashboard" };
  return (
    <>
      <PageBoundary key={pathname} fallback={fallback} back={back} text={fb?.text ?? null} heading={fb?.heading ?? null} actions={(fb?.actions ?? []).map((x) => ({ label: x.label, href: href(x.path) }))}>
        <Page view={view as Ready} query={query} setQuery={setQuery} more={more} addWait={WAITS.add} embedded={embedded === true} fallback={fallback} frame={frame} />
      </PageBoundary>
      {waits.map((w) => <JobWaiter key={w.id} w={w} live={view.page && w.module === (view as Ready).module.slug ? (view as Ready).data : undefined} done={() => WAITS.remove(w.id)} />)}
      {!!(view as Ready).page.persist?.length && <Persist id={`${view.orgId}:${view.userId ?? ""}:${view.module.slug}:${(view as Ready).page.path}`} params={(view as Ready).page.persist!} query={query} />}
    </>
  );
}

/**
 * A page's `persist` parameters (docs/modules.md, "Pages"), kept per workspace, person, module and page in the browser
 * on every change; ModulePage takes them back when the page opens with none of them in its URL.
 */
function Persist({ id, params, query }: { id: string; params: readonly string[]; query: Record<string, string> }) {
  const key = `canon.module.page:${id}`;
  const now = JSON.stringify(Object.fromEntries(params.map((p) => [p, query[p] ?? null])));
  useEffect(() => {
    try { window.localStorage.setItem(key, now); } catch { /* a full or blocked storage keeps nothing */ }
  }, [key, now]);
  return null;
}

/**
 * What a page shows when it can't be drawn (docs/modules.md, "Pages"): why, the page's own words if it declares a
 * `fallback`, a link back and Try again.
 */
/** A link a fallback offers: its label and where it goes. */
type Way = { label: string; href: string };
function Fallback({ message, text, heading, actions = [], back, retry }: { message: string; text: string | null; heading?: string | null; actions?: readonly Way[]; back: Way; retry?: () => void }) {
  const router = useRouter();
  return (
    <div className="view-frame"><div className="view-frame-content">
      <div role="alert" className="max-w-2xl space-y-3 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-sm">
        <p className="font-medium">{heading ?? "This page couldn't be shown."}</p>
        {text && <p>{text}</p>}
        <p className="text-muted-foreground">{message}</p>
        <div className="flex flex-wrap gap-2">
          <Link className={btn} href={back.href}><ChevronLeft className="size-3.5" />{back.label}</Link>
          <button type="button" className={btn} onClick={() => (retry ? retry() : router.refresh())}><RefreshCw className="size-3.5" />Try again</button>
          {actions.map((x) => <Link key={x.href} className={btn} href={x.href}>{x.label}</Link>)}
        </div>
      </div>
    </div></div>
  );
}

/** A component that fails while the page draws shows the page's fallback, not a blank dashboard. */
class PageBoundary extends Component<{ back: Way; text: string | null; heading: string | null; actions: readonly Way[]; children: ReactNode; fallback?: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: getErrorMessage(e) }; }
  render() {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return <Fallback message={this.state.error} text={this.props.text} heading={this.props.heading} actions={this.props.actions} back={this.props.back} retry={() => this.setState({ error: null })} />;
  }
}

/** A record page whose doc isn't there, or isn't the caller's to read (the server doesn't say which): one state for every module page. */
function NotFound({ text, heading, actions = [], back }: { text: string | null; heading?: string | null; actions?: readonly Way[]; back: Way }) {
  return (
    <div className="view-frame"><div className="view-frame-content">
      <div role="status" className="max-w-2xl space-y-3 border-l-2 border-border bg-muted/40 px-4 py-3 text-sm">
        <p className="font-medium">{heading ?? "Not found"}</p>
        <p className="text-muted-foreground">{text ?? "This record doesn't exist, or it isn't yours to see."}</p>
        <div className="flex flex-wrap gap-2">
          <Link className={btn} href={back.href}><ChevronLeft className="size-3.5" />{back.label}</Link>
          {actions.map((x) => <Link key={x.href} className={btn} href={x.href}>{x.label}</Link>)}
        </div>
      </div>
    </div></div>
  );
}

type Joined = Record<string, unknown> | null;
type RecordTo = "companies" | "people";
type RecordRow = Record<string, unknown> & { id: string; label: string };
const joinedOf = (view: unknown): Joined[] => {
  const data = view && typeof view === "object" && "data" in view ? ((view as { data?: Record<string, unknown> }).data ?? {}) : {};
  return Object.values(data).flatMap((b) => (Array.isArray(b) ? b : b ? [b] : [])).flatMap((d) => Object.values(((d as { joined?: Record<string, Joined> }).joined) ?? {}));
};

/**
 * The page with the companies and people it names read as the caller (api.modules.records), which the page's query
 * can't read: each ref's name, a joined company's or person's granted fields (a join carries only its id and
 * `recordRef`), and a joined deal's company name (`companyRef`). One the caller can't see stays unnamed.
 */
function useRecordRefs<T>(view: T): T {
  const read = useAction(api.modules.records);
  const [loaded, setLoaded] = useState<{ view: T; rows: Record<RecordTo, Record<string, RecordRow | null>> } | null>(null);
  const rows: Record<RecordTo, Record<string, RecordRow | null>> = useMemo(() => loaded && loaded.view === view ? loaded.rows : { companies: {}, people: {} }, [loaded, view]);
  const moduleSlug = view && typeof view === "object" && "module" in view ? (view as { module?: { slug?: string } }).module?.slug ?? "" : "";
  const named = view && typeof view === "object" && "recordRefs" in view ? ((view as { recordRefs?: Record<RecordTo, string[]> }).recordRefs ?? null) : null;
  const ids: Record<RecordTo, string[]> = {
    companies: [...new Set([...(named?.companies ?? []), ...joinedOf(view).flatMap((j) => (typeof j?.companyRef === "string" ? [j.companyRef] : []))])].sort(),
    people: [...new Set(named?.people ?? [])].sort(),
  };
  useEffect(() => {
    if (!moduleSlug) return;
    let live = true;
    for (const to of ["companies", "people"] as const) {
      const want = ids[to];
      for (let i = 0; i < want.length; i += 500) {
        const some = want.slice(i, i + 500);
        read({ module: moduleSlug, to, ids: some })
          .then((got) => { if (live) setLoaded((cur) => {
            const prior = cur?.view === view ? cur.rows : { companies: {}, people: {} };
            return { view, rows: { ...prior, [to]: { ...prior[to], ...Object.fromEntries(some.map((id) => [id, null])), ...Object.fromEntries(got.map((r) => [r.id, r])) } } };
          }); })
          .catch(() => undefined);
      }
    }
    return () => { live = false; };
  }, [read, view, moduleSlug]); // eslint-disable-line react-hooks/exhaustive-deps
  const any = ids.companies.length + ids.people.length > 0;
  return useMemo(() => {
    if (!any || !view || typeof view !== "object" || !("data" in view)) return view;
    const fill = (j: Joined): Joined => {
      if (j && (j.recordRef === "companies" || j.recordRef === "people")) { const r = rows[j.recordRef][String(j.id)]; return r ? { ...r, name: r.label } : null; }
      return j && typeof j.companyRef === "string" ? { ...j, companyName: rows.companies[j.companyRef]?.label ?? null } : j;
    };
    const doc = (d: unknown) => {
      const joined = (d as { joined?: Record<string, Joined> } | null)?.joined;
      return joined ? { ...(d as object), joined: Object.fromEntries(Object.entries(joined).map(([k, j]) => [k, fill(j)])) } : d;
    };
    const v = view as { data: Record<string, unknown>; refLabels?: Record<string, string> };
    const labels = Object.fromEntries((["companies", "people"] as const).flatMap((to) => Object.values(rows[to]).flatMap((r) => (r ? [[r.id, r.label]] : []))));
    return { ...view, refLabels: { ...(v.refLabels ?? {}), ...labels }, data: Object.fromEntries(Object.entries(v.data).map(([b, x]) => [b, Array.isArray(x) ? x.map(doc) : x ? doc(x) : x])) };
  }, [view, rows, any]);
}

function Missing({ text, href }: { text: string; href?: string }) {
  return (
    <div className="view-frame"><div className="view-frame-content">
      <p className="text-sm text-muted-foreground">{text}</p>
      {href && <Link className={cn(btn, "mt-3")} href={href}>Open the module</Link>}
    </div></div>
  );
}

function useModuleOp() {
  const client = useConvex();
  return useMemo(() => (args: FunctionArgs<typeof api.modules.op>) => runModuleOp(client, args), [client]);
}

function formValueOf(data: Ready["data"], loadedDocs: Record<string, Doc>, value: Ctx["value"]): Ctx["formValue"] {
  const binds = { ...data, ...loadedDocs };
  return (e: FormExpr, row?: Doc): unknown => {
    if (e !== null && typeof e === "object" && "bind" in e) {
      const doc = binds[e.bind] as Doc | null | undefined;
      return doc && "data" in doc ? (e.field === "key" ? doc.key : doc.data[e.field]) : undefined;
    }
    if (e !== null && typeof e === "object" && "row" in e) return row ? (e.row === "key" ? row.key : valueAt(row, e.row)) : undefined;
    if (e !== null && typeof e === "object" && "today" in e) return today();
    return e !== null && typeof e === "object" ? value(e) : e;
  };
}

function Page({ view, query, setQuery, more, addWait, embedded, fallback, frame }: { fallback?: ReactNode; frame?: (children: ReactNode) => ReactNode; view: Ready; query: Record<string, string>; setQuery: Ctx["setQuery"]; more: Ctx["more"]; addWait: (w: Waiting) => void; embedded?: boolean }) {
  const router = useRouter();
  const op = useModuleOp();
  const move = useMutation(api.modules.transition);
  const runCall = useAction(api.modules.call);
  const startPreview = useMutation(api.permissions.startPreview);
  // What the workspace calls its deal stages and types, for `|stage` and `|dealType`.
  const dealDesc = useQuery(api.objects.describe, { object: "deal" });
  const optionsOfField = (api: string) => { const f = dealDesc?.fields.find((x) => x.apiName === api); return f && "options" in f ? Object.fromEntries(f.options.map((o) => [o.value, o.label])) : {}; };
  const dealLabels = { stage: optionsOfField("stage"), dealType: optionsOfField("dealType") };
  // A joined Canon deal's stage and type read as the workspace names them, as a module field's labels do.
  view = { ...view, labels: Object.fromEntries(Object.entries(view.labels).map(([b, l]) => [b, { ...(l as object), ...Object.fromEntries(((view.dealJoins as Record<string, string[]> | undefined)?.[b] ?? []).flatMap((j) => [[`${j}.stage`, dealLabels.stage], [`${j}.dealType`, dealLabels.dealType]])) }])) as typeof view.labels };
  const [dialog, setDialog] = useState<{ ref: OpRef; row?: Doc; from?: Doc } | null>(null);
  const [moving, setMoving] = useState<{ ref: TransitionRef; doc: Doc; fields: FieldInfo[]; fixed: Record<string, unknown>; initial?: Record<string, unknown>; choices?: Choice[]; from?: { row?: Doc; rowLink?: string } } | null>(null);
  const [calling, setCalling] = useState<{ ref: CallRef; row?: Doc } | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [exporting, setExporting] = useState<{ ref: ExportRef; format: ExportFormat; row?: Doc } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const runExport = useAction(api.modules.exportFile);
  const runPdf = useAction(api.modules.pagePdf);
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [rowHover, setRowHover] = useState<Record<string, string | null>>({});
  const waitFor = (a: ActionRef, row?: Doc, result?: unknown) => {
    const w = "wait" in a ? a.wait : undefined;
    if (!w) return;
    const prefixOf = (p: readonly FormExpr[] | undefined) => { const got = (p ?? []).map((x) => ctx.formValue(x, row)); return got.some((x) => x === undefined || x === null || x === "") ? null : got.map(String); };
    const prefix = prefixOf(w.keyPrefix);
    const follow = (w.follow ?? []).map((f) => ({ job: f.job, prefix: prefixOf(f.keyPrefix) }));
    if (!prefix || follow.some((f) => !f.prefix)) return;
    addWait({
      id: Date.now() + Math.random(), module: view.module.slug, job: w.job, prefix, follow: follow.map((f) => ({ job: f.job, prefix: f.prefix! })), toast: w.toast, scope: ctx.text, row, result, at: Date.now(),
      action: waitId(view.module.slug, a, row), busy: w.busy ? renderText(w.busy, row ? { ...ctx.text, row } : ctx.text) : null,
    });
  };
  const setResult = (call: string, value: unknown) => setResults((r) => { const next = { ...r }; if (value === undefined) delete next[call]; else next[call] = value; return next; });
  const base = `/dashboard/m/${view.module.slug}`;
  // Members who left still read by name (a past rep on a statement).
  const members = new Map([...(view.inactive ?? []), ...view.members].map((m) => [m.id, m.name]));
  const { loads, loaded, runLoad } = usePageCallLoads(`${view.orgId}:${view.userId ?? ""}`, view.module.slug,
    view.loads as PageLoads, runCall, fallback !== undefined);
  const refresh = useRef<symbol | null>(null);
  useEffect(() => () => { refresh.current = null; }, [loads]);
  const reload = (bind: string) => runLoad(bind, true);
  const drawn = useRef<Record<string, { call: string; args: Record<string, unknown> }>>({});
  const reloadAll = (): Promise<boolean> => {
    moduleCallCache.invalidate();
    const request = Symbol();
    refresh.current = request;
    const pending = Object.keys(loads).map((bind) => runLoad(bind, true));
    for (const [at, d] of Object.entries(drawn.current)) {
      pending.push(runCall({ module: view.module.slug, call: d.call, args: d.args }).then((out) => {
        if (refresh.current !== request) return false;
        setResults((r) => (Object.hasOwn(r, at) ? { ...r, [at]: out.value } : r));
        return true;
      }, () => false));
    }
    return Promise.all(pending).then((settled) => refresh.current === request && settled.every(Boolean));
  };
  // A transition the page runs when it opens (`onOpen`): once per doc version, only while the server says it may run.
  const onOpen = view.page.onOpen as { machine: string; transition: string; target: string; ready: boolean } | null;
  const opened = useRef("");
  const openDoc = onOpen ? (view.data[onOpen.target] as Doc | null | undefined) : null;
  const openKey = onOpen?.ready && openDoc ? `${view.module.slug}:${onOpen.machine}.${onOpen.transition}:${openDoc.key}:${openDoc.version}` : "";
  useEffect(() => {
    if (!openKey || opened.current === openKey || !onOpen || !openDoc) return;
    opened.current = openKey;
    // A second tab that moved it first leaves this one stale: nothing to say.
    void move({ module: view.module.slug, machine: onOpen.machine, name: onOpen.transition, key: openDoc.key, expect: openDoc.version }).catch(() => undefined);
  }, [openKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A loaded value reads in text as a bound doc does: `{$<bind>.<field>}`.
  const loadedDocs = Object.fromEntries(Object.entries(loaded).flatMap(([b, l]) => (l.value !== undefined ? [[b, { key: "", version: 0, owner: null, data: (typeof l.value === "object" && l.value !== null ? l.value : { value: l.value }) as Record<string, unknown> }]] : [])));
  // `{$query.<name>}` reads the URL's parameters; a list read short counts as "50+".
  const short = new Set(Object.entries(view.lists as Record<string, { complete: boolean }>).flatMap(([b, l]) => (l.complete ? [] : [b])));
  // `{$notifications.unread}`: the caller's unread notifications from this module (a rep's "3 unread messages").
  const text: TextScope = { dealLabels, binds: { ...view.data, ...loadedDocs, query: { key: "", version: 0, owner: null, data: query }, notifications: { key: "", version: 0, owner: null, data: view.notifications } }, members, currency: view.currency, decimals: view.decimals, labels: view.labels, refs: view.refLabels, formats: view.formats as Record<string, Record<string, string>>, files: view.files, short, fiscalYearStartMonth: view.fiscalYearStartMonth };
  const params = view.params as Record<string, string>;

  const value = (x: PageExpr | undefined): string | undefined => (x === undefined || x === null ? undefined : typeof x !== "object" ? String(x) : "route" in x ? params[x.route]
    : "query" in x ? (query[x.query] || (x.default === undefined || x.default === null ? undefined : String(x.default))) : view.userId ?? undefined);

  const formValue = formValueOf(view.data, loadedDocs, value);
  /** An export downloaded as a file: CSV, or an Excel workbook. */
  async function download(ref: ExportRef, filled: Record<string, unknown>, format: ExportFormat, row?: Doc) {
    const fixed = formArguments(ref.args ?? {}, (x) => formValue(x, row));
    const out = await runExport({ module: view.module.slug, export: ref.export, args: { ...fixed, ...filled }, format, ...(format === "pdf" ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) });
    save(out.base64, out.contentType, out.filename);
    toast.success(doneText(ref, ctx, row, `${view.exports[ref.export]?.label ?? "Export"}: ${out.rows} ${out.rows === 1 ? "row" : "rows"}`, { rows: out.rows }));
  }
  /** The page as a PDF Canon renders on its server, as the caller reads it now (its URL's parameters too). */
  async function printPdf(ref: PdfRef) {
    // The PDF opens in a tab of its own, as a statement does: the tab opens now, while the click counts as the person's.
    const tab = window.open("", "_blank");
    const out = await runPdf({ module: view.module.slug, path: (view.page.path.split("/").map((s) => (s.startsWith(":") ? params[s.slice(1)] ?? "" : s))), query, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(ref.filename ? { filename: ref.filename } : {}) }).catch((e: unknown) => { tab?.close(); throw e; });
    if (!tab) return save(out.base64, out.contentType, out.filename);
    const bytes = Uint8Array.from(atob(out.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: out.contentType }));
    tab.location.href = url;
    tab.document.title = out.filename;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  /**
   * Run a transition; with `then`, open the doc its effects created (a Duplicate's copy) on the page `then` names, else
   * the row's link (`rowLink`) or this page, `:key` the new doc's and the other `:params` from the row or the route.
   */
  async function transition(ref: TransitionRef, doc: Doc, args: Record<string, unknown>, from?: { row?: Doc; rowLink?: string }) {
    const info = view.machines[ref.machine].transitions[ref.transition];
    const input = { module: view.module.slug, machine: ref.machine, name: ref.transition, key: doc.key, expect: doc.version, args };
    // One that records where the person runs it goes through Canon's web server, which reads and signs it.
    const out = info.evidence?.length ? await withEvidence(input) : await move(input);
    reloadAll();
    // Its toast may say what the move left on the doc (`{$doc.<field>}`): "Shared with 4 reps".
    const after: Doc | undefined = "data" in out && out.data ? { key: out.key, version: out.version, owner: null, data: out.data as Record<string, unknown> } : undefined;
    toast.success("proposed" in out ? `${info.label}: sent for approval` : doneText(ref, ctx, from?.row, `${info.label}: done`, undefined, after));
    if (!("proposed" in out)) waitFor(ref, from?.row);
    // `then: { path }`: a page to open once it has run (My plan, after a plan is accepted); the toast goes with it.
    if (typeof ref.then === "object" && ref.then.created === undefined) {
      if (!("proposed" in out)) router.push(`${base}/${fillPath(ref.then.path, { ...(from?.row ? linkValues(ctx, from.row) : params), key: doc.key })}`);
      return;
    }
    const created = "created" in out ? out.created : undefined;
    if (ref.then === undefined || !created) return;
    const then = typeof ref.then === "string" ? { created: true as const, path: ref.then } : ref.then;
    const key = then.created === true || then.created === undefined ? Object.values(created)[0] : created[then.created];
    const path = then.path ?? from?.rowLink ?? view.page.path;
    if (key) router.push(`${base}/${fillPath(path, { ...(from?.row ? linkValues(ctx, from.row) : params), key })}`);
  }
  /** The arguments a call action fixes that have a value on this page (and its row). */
  const fixedArgs = (ref: CallRef, row?: Doc) => formArguments(ref.args ?? {}, (x) => formValue(x, row));
  /** A call's arguments: the ones its action fixes, then the ones the person fills in. */
  async function call(ref: CallRef, filled: Record<string, unknown>, row?: Doc) {
    const info = view.calls[ref.call];
    const fixed = fixedArgs(ref, row);
    const out = await runCall({ module: view.module.slug, call: ref.call, args: { ...fixed, ...filled } });
    // A call that declares how its value shows draws it on the page, under its button (or its row); another says it in the toast.
    if (info.result && out.value !== undefined) {
      setResult(resultKey(ref.call, row), out.value);
      if (info.readOnly) drawn.current[resultKey(ref.call, row)] = { call: ref.call, args: { ...fixed, ...filled } };
    }
    const shown = !info.result && (typeof out.value === "string" || typeof out.value === "number") ? `: ${out.value}` : "";
    toast.success(out.proposed.length ? `${info.label}: done, ${out.proposed.length} sent for approval` : doneText(ref, ctx, row, `${info.label}: done${shown}`, out.value));
    // A call that wrote reads the page's loaded values and the read-only ones drawn on it again: Revert's table (#65).
    if (!info.readOnly) { reloadAll(); waitFor(ref, row, out.value); }
    // `then`: the page its value names, `:key` and the other params from the value's fields (the draft it made).
    if (ref.then && out.value !== null && typeof out.value === "object") {
      const values = Object.fromEntries(Object.entries(out.value as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" ? [[k, String(v)]] : [])));
      if (values.key) router.push(`${base}/${fillPath(ref.then, { ...params, ...values })}`);
    }
  }
  /** A delete asks first, in Canon's dialog. */
  function remove(ref: OpRef, target: { key: string; version: number }, row?: Doc) {
    const label = view.ops[ref.op].label;
    // Its own words over the row when it has them: 'Remove "Avery" from the plan?'.
    const words = wordsOf(ref, ctx, row);
    setConfirming({
      title: words.title ?? `${label}?`, description: words.description, confirmLabel: words.submit ?? label, destructive: true,
      run: async () => {
        await op({ module: view.module.slug, op: ref.op, key: target.key, expect: target.version });
        reloadAll();
        toast.success(doneText(ref, ctx, row, `${label}: done`));
        waitFor(ref, row);
      },
    });
  }
  /**
   * The doc an action writes: its row, the doc its `target` binds, or on a call's row the doc its `key` names, at the
   * version the server judged it (what the write expects).
   */
  const docFor = (a: ActionRef, row?: Doc, judged?: Record<string, Judged>): Doc | null => {
    if (judgedOn(a, row)) {
      const key = rowDocKey(a, ctx, row);
      const j = judged?.[judgeId(a, ctx, row)];
      return key && j?.version !== null && j?.version !== undefined ? { key, version: j.version, owner: null, data: j.data ?? {} } : null;
    }
    return ("target" in a && a.target ? ((view.data[a.target] as Doc | null) ?? null) : row ?? null);
  };
  const run = (a: ActionRef, row?: Doc, judged?: Record<string, Judged>, format?: ExportFormat, rowLink?: string) => {
    if ("menu" in a) return;
    if ("viewAs" in a) {
      // Canon's own "view as" (Settings > Permissions), then the page as that member sees it.
      const who = String(ctx.formValue(a.viewAs, row) ?? "");
      const to = a.path ? navigateHref({ navigate: a.path, label: a.label }, ctx, row) : null;
      return void startPreview({ asUserId: who as Id<"users"> }).then(() => {
        toast.success(`Viewing as ${members.get(who) ?? "the member"}: actions are off until you exit`);
        if (to) router.push(to);
      }, (e) => toast.error(getErrorMessage(e)));
    }
    if ("navigate" in a) return router.push(navigateHref(a, ctx, row));
    if ("print" in a) return window.print();
    if ("pdf" in a) return void printPdf(a).then(() => toast.success(a.toast ? renderText(a.toast, ctx.text) || `${a.pdf}: opened` : `${a.pdf}: opened`), (e) => toast.error(getErrorMessage(e)));
    if ("canon" in a) { const to = canonTarget(a, ctx, row); if (to) router.push(to); return; }
    if ("csvImport" in a) {
      if (view.preview) return void toast.error(view.preview);
      if (view.csvImports?.[a.csvImport]) setImporting(a.csvImport);
      return;
    }
    if ("export" in a) {
      const info = view.exports[a.export];
      if (!info) return;
      const as = format ?? a.formats?.[0] ?? "csv";
      if (a.members || a.picks?.length || info.fields.some((f) => !Object.hasOwn(a.args ?? {}, f.field) || formValue((a.args ?? {})[f.field], row) === undefined)) return setExporting({ ref: a, format: as, row });
      return void download(a, {}, as, row).catch((e) => toast.error(getErrorMessage(e)));
    }
    if ("call" in a) {
      const info = view.calls[a.call];
      if (!info) return;
      // An argument the action fixes from a URL parameter the link didn't give is asked for, as one it doesn't fix; a
      // call with a `confirm` (its own, or the action's) asks first.
      if (a.confirm || info.confirm || info.fields.some((f) => !Object.hasOwn(fixedArgs(a, row), f.field))) return setCalling({ ref: a, row });
      return void call(a, {}, row).catch((e) => toast.error(getErrorMessage(e)));
    }
    if ("transition" in a) {
      const doc = docFor(a, row, judged);
      const info = view.machines[a.machine]?.transitions[a.transition];
      if (!doc || !info) return;
      // The action's own fields (which arguments its dialog asks for, and their labels) and the ones the page fixes.
      const fixed = Object.fromEntries(Object.entries(a.fixed ?? {}).flatMap(([k, x]) => { const v = formValue(x, row); return v === undefined || v === null ? [] : [[k, v]]; }));
      const fields = a.fields
        ? a.fields.flatMap((f) => { const at = info.fields.find((x) => x.field === f.field); return at && !f.rows ? [pageField({ ...at, label: f.label, ...(f.widget ? { widget: f.widget } : {}) }, f, ctx, row)] : []; })
        : info.fields.filter((f) => !Object.hasOwn(fixed, f.field));
      // A per-row choice: one select per row of a list the page binds (each rep's acceptance at publish).
      const choices = (a.fields ?? []).flatMap((f) => { const at = info.fields.find((x) => x.field === f.field); return f.rows && at ? [{ field: f.field, label: f.label, rows: f.rows, spec: at.spec as FieldSpec | null }] : []; });
      const from = { row, rowLink };
      // What its dialog's fields start from: a page value, the row's, or a text over them ("{$row.name} (Copy)").
      const initial = Object.fromEntries(Object.entries(a.initial ?? {}).flatMap(([k, x]) => { const v = initialValue(x, ctx, row); return v === undefined || v === null ? [] : [[k, v]]; }));
      if (fields.length || choices.length || info.confirm || info.sends || view.module.id === "@canon/sequences" && a.machine === "sequence" && a.transition === "launch") return setMoving({ ref: a, doc, fields, fixed, initial, choices, from });
      return void transition(a, doc, fixed, from).catch((e) => toast.error(getErrorMessage(e)));
    }
    const target = isCallRow(row) || a.key !== undefined ? (a.key !== undefined ? docFor(a, row, judged) : null) : docFor(a, row);
    if (view.ops[a.op].kind === "delete") { if (target) remove(a, target, row); return; }
    // On a call's row an update names its doc by key; a create takes its values from the row.
    setDialog({ ref: a, row: target ?? undefined, from: row });
  };
  const reportEnv: ReportEnv = { module: view.module.slug, dashboards: view.dashboards, readOnly: !!view.preview, members: view.members, palette: view.reports as Record<string, Palette>, query, setQuery, fiscalYearStartMonth: view.fiscalYearStartMonth };
  const editor: EditorAccess = {
    allowed: (ref) => !!view.calls[ref.call]?.allowed && !view.preview,
    invoke: async (ref: EditorCall, row: Doc, inputs: Record<string, unknown>) => {
      const info = view.calls[ref.call];
      if (!info?.allowed || !info.readOnly && view.preview) throw new Error(view.preview || "This call is unavailable.");
      const args = { ...formArguments(ref.args ?? {}, (x) => formValue(x, row)), ...inputs };
      const out = await runCall({ module: view.module.slug, call: ref.call, args });
      if (!info.readOnly && !await reloadAll()) throw new Error("Saved, but the page could not reload. Reload before editing again.");
      return out.value;
    },
  };
  const ctx: Ctx = { editor, view, text, run, base, value, results, setResult, query, setQuery, more, formValue, loaded, reload, reloadAll, reportEnv, rowHover, hoverRow: (param, key) => setRowHover((prev) => prev[param] === key ? prev : { ...prev, [param]: key }), go: (href) => router.push(href) };
  // An op dialog's own fields, with their labels, help and options (a plan picked by its name).
  const dialogShape = dialog?.ref.fields?.flatMap((f) => { const at = view.ops[dialog.ref.op].fields.find((x) => x.field === f.field); const scope = dialog.from ?? dialog.row; return at ? [pageField({ ...at, label: renderText(f.label, scope ? { ...ctx.text, row: scope } : ctx.text), ...(f.widget ? { widget: f.widget } : {}) }, f, ctx, scope)] : []; });

  // A leading header is the page's frame header; the module's tabs and the rest sit in the frame's content. Several
  // leading headers, each with its `when`, are one header's variants: the first that shows is the frame's (the plan's
  // name over a plan's period, the period's name over the whole period), and the others are left out.
  const body = view.page.body as Node[];
  const lead = body.findIndex((n) => n.c !== "header");
  const leading = lead < 0 ? body.length : lead;
  const head = body.slice(0, leading).find((n) => shows(n, ctx)) ?? null;
  const activeTab = view.tabs.find((t) => t.path === view.page.path)?.path
    ?? [...view.tabs].sort((a, b) => b.path.length - a.path.length).find((t) => view.page.path.startsWith(`${t.path}/`))?.path;
  if (fallback !== undefined && (!body.some((n) => shows(n, ctx)) || Object.keys(loads).some((b) => !loaded[b] || loaded[b].busy || loaded[b].error))) return <>{fallback}</>;
  const content = (
    <FormEnvProvider value={{ module: view.module.slug, members: view.members, inactive: view.inactive, refLabels: view.refLabels, files: view.files, collectionLabels: view.collectionLabels, text }}>
    <div className={embedded ? "grid gap-3" : "view-frame print-document"}>
      {head && !embedded && RENDERERS.header(head as Of<"header">, ctx)}
      <div className={embedded ? "grid gap-3" : "view-frame-content"}>
        {head && !embedded && <div className="mb-4 empty:hidden"><Results items={(head as Of<"header">).actions ?? []} ctx={ctx} /></div>}
        {view.tabs.length > 1 && !embedded && (
          <nav aria-label={view.module.title} className="mb-5 flex gap-4 border-b border-border text-sm print:hidden">
            {view.tabs.map((t) => {
              // A page under a tab (a plan's own page under Plans) keeps that tab open.
              const active = t.path === activeTab;
              return <Link key={t.path} href={`${base}/${t.path}`} aria-current={active ? "page" : undefined} className={cn("-mb-px border-b-2 px-1 pb-2", active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{renderText(t.label, ctx.text)}</Link>;
            })}
          </nav>
        )}
        <LoadErrors loaded={loaded} retry={reloadAll} />
        <Nodes nodes={leading ? body.slice(leading) : body} ctx={ctx} />
      </div>
      {dialog && (
        <OpDialog key={`${dialog.ref.op}:${dialog.row?.key ?? ""}`} view={view} refName={dialog.ref.op} row={dialog.row} given={prefill(dialog.ref, ctx, dialog.from)} words={wordsOf(dialog.ref, ctx, dialog.from ?? dialog.row)}
          shape={dialogShape}
          onClose={() => setDialog(null)}
          onSubmit={async ({ data, unset }) => {
            const info = view.ops[dialog.ref.op];
            const out = await op({
              module: view.module.slug, op: dialog.ref.op, data, ...(unset.length ? { unset } : {}),
              ...(info.kind === "update" && dialog.row ? { key: dialog.row.key, expect: dialog.row.version } : {}),
              ...(info.kind === "create" && info.setOf ? { parentKey: value(dialog.ref.parent) } : {}),
            });
            setDialog(null);
            reloadAll();
            // Its toast reads what was submitted as `{$doc.<field>}`, a field picked from options by its label: "Assigned to {$doc.plan}".
            const picked = Object.fromEntries(Object.entries(data).map(([k, v]) => { const f = dialogShape?.find((x) => x.field === k) as { labels?: Record<string, string> } | undefined; return [k, f?.labels?.[String(v)] ?? v]; }));
            const sent: Doc = { key: "key" in out ? out.key : dialog.row?.key ?? "", version: 0, owner: null, data: { ...(dialog.row?.data ?? {}), ...picked } };
            toast.success("proposed" in out ? `${info.label}: sent for approval` : doneText(dialog.ref, ctx, dialog.from, `${info.label}: saved`, undefined, sent));
            if (!("proposed" in out)) waitFor(dialog.ref, dialog.from);
            if (dialog.ref.then && "key" in out) router.push(`${base}/${fillPath(dialog.ref.then, { ...params, key: out.key })}`);
          }} />
      )}
      {calling && (
        <ArgsDialog key={`call:${calling.ref.call}`} title={wordsOf(calling.ref, ctx, calling.row).title ?? actionLabel(calling.ref, ctx, calling.row)} badge={wordsOf(calling.ref, ctx, calling.row).badge}
          description={wordsOf(calling.ref, ctx, calling.row).description ?? calling.ref.confirm ?? view.calls[calling.ref.call].confirm} submit={wordsOf(calling.ref, ctx, calling.row).submit ?? actionLabel(calling.ref, ctx, calling.row)}
          fields={view.calls[calling.ref.call].fields.filter((f) => !Object.hasOwn(fixedArgs(calling.ref, calling.row), f.field)).map((f) => {
            // The action's own words for a field: its label, help, placeholder, and options from a binding (the plan's reps).
            const given = calling.ref.fields?.find((x) => x.field === f.field);
            return given ? pageField({ ...f, label: renderText(given.label, calling.row ? { ...ctx.text, row: calling.row } : ctx.text) || f.label, ...(given.widget ? { widget: given.widget } : {}) }, given, ctx, calling.row) : f;
          })}
          initial={Object.fromEntries(Object.entries(calling.ref.initial ?? {}).map(([k, x]) => [k, initialValue(x, ctx, calling.row)]))}
          context={fixedArgs(calling.ref, calling.row)}
          onClose={() => setCalling(null)}
          onSubmit={async (args) => { await call(calling.ref, args, calling.row); setCalling(null); }} />
      )}
      {confirming && <ConfirmDialog title={confirming.title} description={confirming.description} confirmLabel={confirming.confirmLabel} destructive={confirming.destructive} onConfirm={confirming.run} onClose={() => setConfirming(null)} />}
      {importing && view.csvImports?.[importing] && (
        <ModuleCsvImport key={`import:${importing}`} shape={view.csvImports[importing]} onClose={() => setImporting(null)}
          run={async (rows) => { await runCall({ module: view.module.slug, call: view.csvImports![importing]!.call, args: { rows } }); }}
          onImported={(count) => { toast.success(`${view.csvImports![importing]!.label}: ${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"} imported`); reloadAll(); }} />
      )}
      {(exporting?.ref.members || exporting?.ref.picks?.length) && (
        <ExportDialog key={`export:${exporting.ref.export}`} ctx={ctx} a={exporting.ref} members={exporting.ref.members} start={exporting.format} words={wordsOf(exporting.ref, ctx, exporting.row)}
          title={exporting.ref.label ?? view.exports[exporting.ref.export].label}
          fields={view.exports[exporting.ref.export].fields.filter((f) => f.field !== exporting.ref.members?.arg && !exporting.ref.picks?.some((p) => p.arg === f.field) && formValue((exporting.ref.args ?? {})[f.field], exporting.row) === undefined)}
          onClose={() => setExporting(null)}
          onSubmit={async (args, format) => { await download(exporting.ref, args, format, exporting.row); setExporting(null); }} />
      )}
      {exporting && !exporting.ref.members && !exporting.ref.picks?.length && (
        <ArgsDialog key={`export:${exporting.ref.export}`} title={wordsOf(exporting.ref, ctx, exporting.row).title ?? exporting.ref.label ?? view.exports[exporting.ref.export].label}
          description={wordsOf(exporting.ref, ctx, exporting.row).description} submit={wordsOf(exporting.ref, ctx, exporting.row).submit ?? exporting.ref.label ?? view.exports[exporting.ref.export].label}
          fields={view.exports[exporting.ref.export].fields.filter((f) => formValue((exporting.ref.args ?? {})[f.field], exporting.row) === undefined)}
          onClose={() => setExporting(null)}
          onSubmit={async (args) => { await download(exporting.ref, args, exporting.format, exporting.row); setExporting(null); }} />
      )}
      {moving && view.module.id === "@canon/sequences" && moving.ref.machine === "sequence" && moving.ref.transition === "launch" ? (
        <SequenceLaunchReview module={view.module.slug} sequenceKey={moving.doc.key} onClose={() => setMoving(null)}
          onApprove={async (token) => { await transition(moving.ref, moving.doc, { ...moving.fixed, __variableReview: token }, moving.from); setMoving(null); }} />
      ) : moving && (
        <TransitionDialog key={`${moving.ref.machine}.${moving.ref.transition}:${moving.doc.key}`} info={view.machines[moving.ref.machine].transitions[moving.ref.transition]} fields={moving.fields} choices={moving.choices ?? []} ctx={ctx} context={moving.fixed} initial={moving.initial ?? {}}
          preview={view.machines[moving.ref.machine].transitions[moving.ref.transition].sends ? <SendPreview module={view.module.slug} machine={moving.ref.machine} transition={moving.ref.transition} docKey={moving.doc.key} args={moving.fixed} /> : undefined}
          words={wordsOf(moving.ref, ctx, moving.from?.row ?? (moving.ref.target ? undefined : moving.doc))}
          onClose={() => setMoving(null)}
          onSubmit={async (args) => { await transition(moving.ref, moving.doc, { ...moving.fixed, ...args }, moving.from); setMoving(null); }} />
      )}
    </div>
    </FormEnvProvider>
  );
  return frame ? frame(content) : content;
}

/**
 * The page's loaded calls that failed, said once at the top with Try again, not once per section that reads them: each
 * message once, in the module's words. The sections show they have nothing.
 */
function LoadErrors({ loaded, retry }: { loaded: Record<string, Loaded>; retry: () => void }) {
  const messages = [...new Set(Object.values(loaded).flatMap((l) => (l.error ? [plainConvexMessage(l.error)] : [])))];
  if (!messages.length) return null;
  const busy = Object.values(loaded).some((l) => l.busy);
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 border-l-2 border-destructive bg-destructive/10 px-4 py-3 text-sm">
      <div className="space-y-1"><p className="font-medium">Part of this page couldn&apos;t load.</p>{messages.map((m) => <p key={m}>{m}</p>)}</div>
      <button type="button" className={btn} disabled={busy} onClick={retry}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} />Try again</button>
    </div>
  );
}
/** An error as a person reads it: Convex's request and server wrapping left out. */
const NOT_LOADED = "Not loaded. See above.";

function Nodes({ nodes, ctx }: { nodes: Node[]; ctx: Ctx }) {
  return <>{nodes.filter((n) => shows(n, ctx)).map((n, i) => <div key={i} className="mb-6">{RENDERERS[n.c](n as never, ctx)}</div>)}</>;
}

/**
 * Whether a node's `when` holds: a bound doc's field (or a loaded call's value's, or the caller's unread notifications)
 * among values or set, or a list empty. Cosmetic, as roles are.
 */
const shows = (n: Node, ctx: Ctx): boolean => nodeShows(n.when, ctx.text.binds);

type Of<C extends ComponentName> = Extract<Node, { c: C }>;
/** The component vocabulary: each name a module page may use, and the Canon component that draws it. */
const RENDERERS: { [C in ComponentName]: (n: Of<C>, ctx: Ctx) => ReactNode } = {
  prose: (n, ctx) => <ModuleProse text={renderText(n.text, ctx.text)} />,
  header: (n, ctx) => (
    <header className="view-frame-header">
      <div className="view-frame-title-row">
        <h1 className="view-frame-identity font-display text-2xl font-semibold">{renderText(n.title, ctx.text) || ctx.view.module.title}</h1>
        {!!n.actions?.length && <div className="view-frame-actions" role="group"><Actions items={n.actions} ctx={ctx} /></div>}
      </div>
      {n.subtitle && <p className="view-frame-description max-w-[72ch] text-sm text-muted-foreground">{renderText(n.subtitle, ctx.text)}</p>}
    </header>
  ),
  actions: (n, ctx) => {
    // The transition the page runs when it opens isn't a button on it.
    const auto = ctx.view.page.onOpen as { machine: string; transition: string } | null;
    const items: readonly ActionRef[] = n.items ?? Object.keys(ctx.view.machines[n.machine!]?.transitions ?? {}).filter((t) => !(auto?.machine === n.machine && auto?.transition === t)).map((t) => ({ transition: t, machine: n.machine!, target: n.target }));
    return <div><div className="flex flex-wrap gap-2"><Actions items={items} ctx={ctx} /></div><Results items={items} ctx={ctx} /></div>;
  },
  empty: (n, ctx) => (
    <div className="border-y border-border/70 bg-muted/25 p-6 text-center">
      <p className="mx-auto max-w-2xl text-sm text-muted-foreground">{renderText(n.text, ctx.text)}</p>
      {n.action && <div className="mt-3 flex justify-center"><Actions items={[n.action]} ctx={ctx} /></div>}
    </div>
  ),
  tabs: (n, ctx) => {
    // A tabs node with a `param` opens the tab the URL names (`?view=`), and names the one the person opens.
    const id = (t: { id?: string }, i: number) => t.id ?? String(i);
    const named = n.param ? ctx.query[n.param] : undefined;
    const open = named && n.tabs.some((t, i) => id(t, i) === named) ? named : id(n.tabs[0], 0);
    return (
      <Tabs {...(n.param ? { value: open, onValueChange: (v: string) => ctx.setQuery({ [n.param!]: v === id(n.tabs[0], 0) ? null : v }) } : { defaultValue: "0" })}>
        <TabsList variant="line">{n.tabs.map((t, i) => <TabsTrigger key={i} value={n.param ? id(t, i) : String(i)}>{renderText(t.label, ctx.text)}</TabsTrigger>)}</TabsList>
        {n.tabs.map((t, i) => <TabsContent key={i} value={n.param ? id(t, i) : String(i)} className="pt-4"><Nodes nodes={t.body as Node[]} ctx={ctx} /></TabsContent>)}
      </Tabs>
    );
  },
  table: (n, ctx) => <Table n={n} ctx={ctx} />,
  recordEditor: (n, ctx) => {
    const value = ctx.loaded[n.from]?.value;
    if (value === undefined) return <p className="text-sm text-muted-foreground">{ctx.loaded[n.from]?.error ? NOT_LOADED : "Loading…"}</p>;
    const rows = callRowsOf(value, n.rows), key = focusedKey(rows.map((r) => r.key), n.selection, ctx.query);
    const row = rows.find((r) => r.key === key);
    return row ? <ModuleRecordEditor key={row.key} n={n} row={row} title={n.title ? renderText(n.title, { ...ctx.text, row }) : undefined} options={(value as Record<string, unknown>)[n.options]} access={ctx.editor} /> : null;
  },
  setMap: (n, ctx) => {
    const value = ctx.loaded[n.from]?.value;
    if (value === undefined) return <p className="text-sm text-muted-foreground">{ctx.loaded[n.from]?.error ? NOT_LOADED : "Loading…"}</p>;
    return <ModuleSetMap icp={ctx.view.module.id === "@canon/icps"} showQuery={ctx.view.role === "admin"} n={n} value={value} query={ctx.query} setQuery={ctx.setQuery} hovered={ctx.rowHover[n.selection.param] ?? null}
      hover={(key) => ctx.hoverRow(n.selection.param, key)} text={(row, t) => renderText(t, row ? { ...ctx.text, row: { key: row.key, version: 0, owner: null, data: row } } : ctx.text)} />;
  },
  form: (n, ctx) => <InlineForm n={n} ctx={ctx} />,
  banner: (n, ctx) => (
    <div role="status" className={cn("flex flex-wrap items-center justify-between gap-3 border-l-2 px-4 py-3 text-sm", TONES[n.tone])}>
      <p className="max-w-[72ch]">{renderText(n.text, ctx.text)}{n.list ? ` ${eachRows(ctx, n.list.from, n.list.rows).map((r) => renderText(n.list!.label, rowScope(ctx, n.list!.from, r))).filter(Boolean).join(", ")}` : ""}</p>
      {!!n.actions?.length && <div className="flex gap-2"><Actions items={n.actions} ctx={ctx} /></div>}
    </div>
  ),
  statusSteps: (n, ctx) => <StatusSteps n={n} ctx={ctx} />,
  timeline: (n, ctx) => <Timeline n={n} ctx={ctx} />,
  queue: (n, ctx) => <Queue n={n} ctx={ctx} />,
  jobStatus: (n, ctx) => <JobStatus n={n} ctx={ctx} />,
  detail: (n, ctx) => (
    <dl className={cn("grid gap-x-6 gap-y-3 border border-border bg-card p-4 text-sm", n.columns === 2 ? "sm:grid-cols-2" : n.columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3")}>
      {n.items.map((x, i) => (
        <div key={i} className={cn("min-w-0", x.span === 2 && "sm:col-span-2")}>
          <dt className="text-xs font-medium text-muted-foreground">{renderText(x.label, ctx.text)}</dt>
          <dd className="mt-0.5 break-words tabular-nums">{fileIn(x.value, ctx) ?? (renderText(x.value, ctx.text) || <span className="text-muted-foreground">None</span>)}</dd>
        </div>
      ))}
    </dl>
  ),
  kpis: (n, ctx) => <Kpis items={n.items} ctx={ctx} />,
  thread: (n, ctx) => <Thread n={n} ctx={ctx} />,
  approvalChain: (n, ctx) => <ApprovalChain n={n} ctx={ctx} />,
  periodNav: (n, ctx) => <PeriodNav n={n} ctx={ctx} />,
  shareLinks: (n, ctx) => {
    const doc = ctx.view.data[n.from] as Doc | null;
    return doc ? <ShareLinks module={ctx.view.module.slug} share={n.share} recordKey={doc.key} disabled={!!ctx.view.preview} /> : null;
  },
  integrity: (n, ctx) => <IntegrityBadge n={n} ctx={ctx} />,
  callResult: (n, ctx) => <LoadedResult n={n} ctx={ctx} />,
  bulkStatus: (n, ctx) => <BulkStatus n={n} ctx={ctx} />,
  outbox: (n, ctx) => {
    // Every row of the module, or the rows one bound doc caused.
    const doc = n.from === "module" ? null : (ctx.view.data[n.from] as Doc | null);
    if (n.from !== "module" && !doc) return null;
    const about = doc ? `${(ctx.view.collections as Record<string, string>)[n.from]}/${doc.key}` : undefined;
    return <ModuleOutbox module={ctx.view.module.slug} about={about} states={n.states} actions={n.actions} empty={n.empty ? renderText(n.empty, ctx.text) : undefined} />;
  },
  pacing: (n, ctx) => <ModulePacing n={n} module={ctx.reportEnv.module} />,
  dashboards: (n, ctx) => <ModuleDashboards title={n.title} env={ctx.reportEnv} />,
  report: (n, ctx) => <ModuleReport n={n} env={ctx.reportEnv} />,
  dateRange: (n, ctx) => <PageDateRange n={n} ctx={ctx} />,
  chart: (n, ctx) => (
    <ModuleChart n={n.title?.includes("{$") ? { ...n, title: renderText(n.title, ctx.text) } : n} env={ctx.reportEnv} rows={n.from ? rowsFor(ctx, n.from, n.rows) : null}
      totals={n.kind === "waterfall" && n.from ? waterfallTotals(ctx, n.from, n.start, n.end) : undefined}
      // `link`: a click on a bar opens a page, its `{$point.x}` and `{$point.series}` the bar's (each URL-encoded).
      onPick={n.link ? (at) => ctx.go(`${ctx.base}/${n.link!.replace(/\{\$point\.(x|series)\}/g, (_m, k: string) => encodeURIComponent(String((k === "x" ? at.x : at.series) ?? "")))}`) : undefined} />
  ),
  stepper: (n, ctx) => <Stepper n={n} ctx={ctx} />,
  wizard: (n, ctx) => <Wizard n={n} ctx={ctx} />,
  grid: (n, ctx) => <Grid n={n} ctx={ctx} />,
  transcript: (n, ctx) => <Transcript n={n} ctx={ctx} />,
  phone: (n, ctx) => "record" in n ? <RecordPhone n={n} ctx={ctx} /> : <PhoneList n={n} ctx={ctx} />,
  flow: (n, ctx) => <ModuleFlow n={n} ctx={ctx} />,
  tree: (n, ctx) => {
    const rows = rowsFor(ctx, n.from, n.rows);
    if (!rows) return <p className="text-sm text-muted-foreground">{ctx.loaded[n.from]?.error ? NOT_LOADED : "Loading…"}</p>;
    return <ModuleTree n={n} rows={rows.rows} text={(row, t) => renderText(t, { ...ctx.text, row, rowLabels: ctx.view.labels[n.from] })}
      href={(row) => (n.link ? `${ctx.base}/${fillPath(n.link, linkValues(ctx, row))}` : n.canonLink ? withQuery(canonHref(n.canonLink.canon), n.canonLink.query, { ...ctx.text, row }) : null)} />;
  },
};

const FLOW_TONES = new Set<FlowTone>(["done", "active", "planned", "failed", "exit", "neutral"]);

/** A `flow` component: its rows as FlowCanvas nodes, chained in order when it names no `parent`. */
function ModuleFlow({ n, ctx }: { n: Of<"flow">; ctx: Ctx }) {
  const rows = rowsFor(ctx, n.from, n.rows);
  if (!rows) return <p className="text-sm text-muted-foreground">{ctx.loaded[n.from]?.error ? NOT_LOADED : "Loading…"}</p>;
  const text = (row: Doc, t: string | undefined) => (t === undefined ? "" : renderText(t, { ...ctx.text, row, rowLabels: ctx.view.labels[n.from] }));
  const idOf = (doc: Doc) => String((n.id ? valueAt(doc, n.id) : undefined) ?? doc.key);
  const ids = new Set(rows.rows.map(idOf));
  const nodes: FlowNode[] = rows.rows.map((doc, i) => {
    const parentAt = n.parent === undefined ? (i > 0 ? idOf(rows.rows[i - 1]) : undefined) : valueAt(doc, n.parent);
    const parent = typeof parentAt === "string" && ids.has(parentAt) && parentAt !== idOf(doc) ? parentAt : undefined;
    const tone = text(doc, n.tone) as FlowTone;
    const details = (n.details ?? []).map((d) => [d.label, text(doc, d.value)] as const).filter(([, v]) => v !== "");
    return {
      id: idOf(doc), parent, row: i, title: text(doc, n.title) || "Untitled", action: text(doc, n.action) || undefined, metric: text(doc, n.metric) || undefined,
      tone: FLOW_TONES.has(tone) ? tone : "planned", card: n.card ? <p className="line-clamp-3">{text(doc, n.card)}</p> : undefined,
      detail: details.length ? <FlowRows rows={details} /> : undefined,
    };
  });
  return <FlowCanvas scenario={{ id: `module-${ctx.base}-${n.from}`, title: "Flow", nodes }} height={340} empty={n.empty ?? "Nothing to show."} />;
}

/**
 * The rows a chart or a tree draws: a list binding's docs, or the list in a loaded call's value (`rows`, a field of
 * it, or the value), each as a doc whose data is the row. Null while the call runs.
 */
function rowsFor(ctx: Ctx, bind: string, field?: string): RowsEnv | null {
  const kinds = ((ctx.view.kinds as Record<string, Record<string, string>>)[bind] ?? {});
  const labels = (ctx.view.labels[bind] ?? {}) as Record<string, Record<string, string>>;
  if (!Object.hasOwn(ctx.view.loads as object, bind)) {
    return { rows: rowsOf(ctx, bind), complete: listOf(ctx, bind)?.complete !== false, kinds, labels, refs: ctx.view.refLabels as Record<string, string> };
  }
  const value = ctx.loaded[bind]?.value;
  if (value === undefined) return null;
  const list = field && typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : value;
  const rows = (Array.isArray(list) ? list : []).map((r, i): Doc => ({ key: String((r as Record<string, unknown>)?.id ?? i), version: 0, owner: null, data: (typeof r === "object" && r !== null ? r : { value: r }) as Record<string, unknown> }));
  // A call's row values are what they say: a member's id draws as their name, a date by its bucket.
  const fields = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r.data)))];
  return { rows, complete: true, kinds: inferKinds(rows, fields, ctx.text.members), labels: {}, refs: {} };
}

/**
 * A waterfall's start and end, fields of its call's value; none (no chart) until the call loads a numeric start. An
 * absent end comes from the steps.
 */
function waterfallTotals(ctx: Ctx, bind: string, start?: string, end?: string): { start: number; end: unknown } | undefined {
  const value = ctx.loaded[bind]?.value;
  if (typeof value !== "object" || value === null || !start) return undefined;
  const v = value as Record<string, unknown>;
  return typeof v[start] === "number" && Number.isFinite(v[start]) ? { start: v[start] as number, end: end ? v[end] : undefined } : undefined;
}

type ListInfo = { complete: boolean; limit: number; countError: string | null };
const listOf = (ctx: Ctx, bind: string) => (ctx.view.lists as Record<string, ListInfo>)[bind];
const rowsOf = (ctx: Ctx, bind: string) => (ctx.view.data[bind] as Doc[] | undefined) ?? [];

/** Figures from the page: a text, a list's total of a row value, or how many rows it holds; none over a short list. */
function Kpis({ items, ctx }: { items: readonly KpiItem[]; ctx: Ctx }) {
  const figure = (x: KpiItem): string => {
    if ("value" in x) return renderText(x.value, ctx.text);
    const from = "total" in x ? x.total.from : x.count;
    if (listOf(ctx, from)?.complete === false) return "";
    if ("count" in x) return rowsOf(ctx, from).length.toLocaleString();
    return formatValue(total(rowsOf(ctx, from), x.total.sum), x.total.format ?? "number", ctx.text);
  };
  return (
    <dl className="grid grid-cols-2 divide-x divide-border border border-border bg-card sm:grid-cols-4">
      {items.map((x, i) => <Figure key={i} label={renderText(x.label, ctx.text)} value={figure(x)} extras={x} scope={ctx.text} />)}
    </dl>
  );
}

/** A text that reads as a number: "$1,200.50", "85%" and "-3" do. NaN otherwise. */
const asNumber = (t: string) => (t.trim() === "" ? NaN : Number(t.replace(/[\s,$%€£]/g, "")));
/** The tone a figure's `tone` gives it: the first case its value meets (`in` as text, `gte` and `lte` as numbers). */
function figureTone(tone: KpiExtras["tone"], scope: TextScope): ToneName | null {
  if (!tone) return null;
  const v = renderText(tone.by, scope), n = asNumber(v);
  const hit = tone.cases.find((k) => ("in" in k ? k.in.some((x) => String(x ?? "") === v) : "gte" in k ? n >= k.gte : "lte" in k ? n <= k.lte : true));
  return hit?.tone ?? null;
}
/** One figure: its label, its value in its tone, an arrow by its trend's sign with the trend's text, and a line under it. */
function Figure({ label, value, extras, scope }: { label: string; value: string; extras: KpiExtras; scope: TextScope }) {
  const tone = figureTone(extras.tone, scope);
  const trend = extras.trend ? renderText(extras.trend, scope) : "";
  const dir = trend ? Math.sign(asNumber(trend)) : NaN;
  const hint = extras.hint ? renderText(extras.hint, scope) : "";
  return (
    <div className="px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span data-tone={tone ?? undefined} className={cn("font-display text-xl font-semibold tabular-nums", tone && TEXT_TONES[tone])}>{value || "—"}</span>
        {trend && (
          <span className={cn("text-xs tabular-nums", dir > 0 ? "text-primary" : dir < 0 ? "text-destructive" : "text-muted-foreground")} aria-label={`${dir > 0 ? "Up" : dir < 0 ? "Down" : "Level"} ${trend}`}>
            <span aria-hidden>{dir > 0 ? "▲" : dir < 0 ? "▼" : "▬"}</span> {trend}
          </span>
        )}
      </dd>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type TranscriptLine = { segment: number; speaker: string | null; side: "rep" | "customer" | "unknown"; startSec: number | null; endSec: number | null; text: string };
type Mark = { segment: number; start: number; end: number; tone: ToneName; label: string };
const MARK_TONES: Record<ToneName, string> = {
  info: "bg-muted", neutral: "bg-muted", success: "bg-primary/15", warn: "bg-amber-500/20", danger: "bg-destructive/15", ai: "bg-provenance-tint/50",
};
const SIDES = { rep: "Rep", customer: "Customer", unknown: "" } as const;
/** Seconds as m:ss, or h:mm:ss past an hour. */
const clock = (sec: number) => {
  const t = Math.max(0, Math.floor(sec));
  const [h, m, x] = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

/** The ranges a transcript's highlights mark: each row (or each item of its `list`) names a line, and a range of it. */
function marksOf(n: Of<"transcript">, ctx: Ctx, lines: readonly TranscriptLine[]): Mark[] {
  const at = new Map(lines.map((l) => [l.segment, l]));
  const out: Mark[] = [];
  for (const h of n.highlights ?? []) {
    for (const row of rowsOf(ctx, h.from)) {
      const items = h.list === undefined ? [row.data] : (Array.isArray(valueAt(row, h.list)) ? (valueAt(row, h.list) as unknown[]) : []).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
      for (const item of items) {
        const line = at.get(Number(item[h.segment]));
        if (!line) continue;
        const num = (k?: string) => (k !== undefined && typeof item[k] === "number" ? (item[k] as number) : undefined);
        const start = Math.max(0, Math.min(line.text.length, num(h.start) ?? 0));
        const end = Math.max(start, Math.min(line.text.length, num(h.end) ?? line.text.length));
        const tone = h.tone === undefined ? "warn" : typeof h.tone === "string" ? h.tone : h.tone.cases.find((k) => toneCaseHolds(k, item[(h.tone as { by: string }).by]))?.tone ?? "warn";
        out.push({ segment: line.segment, start, end, tone, label: renderText(h.label, { ...ctx.text, row }) });
      }
    }
  }
  return out;
}

/** One line's text with its marked ranges: overlaps take the first mark that covers them. */
function MarkedText({ text, marks }: { text: string; marks: readonly Mark[] }) {
  if (!marks.length) return <>{text}</>;
  const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.start, m.end])])].sort((a, b) => a - b);
  return <>{cuts.slice(0, -1).map((from, i) => {
    const to = cuts[i + 1];
    const mark = marks.find((m) => m.start <= from && m.end >= to && m.end > m.start);
    const piece = text.slice(from, to);
    return mark ? <mark key={i} title={mark.label} className={cn("rounded-none px-0.5 text-foreground", MARK_TONES[mark.tone])}>{piece}</mark> : <Fragment key={i}>{piece}</Fragment>;
  })}</>;
}

/** A Canon call's transcript, which Canon read as the caller: speakers by side, times, marked ranges and line actions. */
function Transcript({ n, ctx }: { n: Of<"transcript">; ctx: Ctx }) {
  const raw = ctx.formValue(n.call);
  const id = typeof raw === "string" ? raw : "";
  const got = id ? (ctx.view.transcripts as Record<string, { state: string; title?: string; call?: { title: string; at: string | null; durationSeconds: number | null; timed: boolean }; lines?: TranscriptLine[] }>)[id] : undefined;
  if (!id || !got || got.state === "none") return <p className="text-sm text-muted-foreground">{renderText(n.empty ?? (id ? "No transcript you can read for this call." : "No call picked yet."), ctx.text)}</p>;
  if (got.state === "tooLong" || !got.call || !got.lines) return <p className="text-sm text-muted-foreground">{got.title}: the transcript runs past 5,000 lines, too long to show here.</p>;
  const lines = got.lines;
  const marks = marksOf(n, ctx, lines);
  const marked = [...new Map(marks.map((m) => [m.segment, m])).values()].sort((a, b) => a.segment - b.segment);
  const go = (segment: number) => document.getElementById(`line-${segment}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const actions = n.lineActions ?? [];
  return (
    <section className="max-w-4xl space-y-3" aria-label={`Transcript: ${got.call.title}`}>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{got.call.title}</span>
        {got.call.at ? ` · ${got.call.at.slice(0, 10)}` : ""}{got.call.durationSeconds ? ` · ${clock(got.call.durationSeconds)}` : ""} · {lines.length} lines{got.call.timed ? "" : " · no timings"}
      </p>
      {marked.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Marked lines">
          {marked.map((m) => (
            <button key={m.segment} type="button" role="listitem" onClick={() => go(m.segment)} className={cn("border border-border px-2 py-0.5 text-xs hover:bg-muted", MARK_TONES[m.tone])}>
              {lines.find((l) => l.segment === m.segment)?.startSec != null ? `${clock(lines.find((l) => l.segment === m.segment)!.startSec!)} ` : ""}{m.label}
            </button>
          ))}
        </div>
      )}
      <ol className="max-h-[70vh] divide-y divide-border/60 overflow-y-auto border border-border bg-card">
        {lines.map((l) => {
          const mine = marks.filter((m) => m.segment === l.segment);
          const row: Doc = { key: `line-${l.segment}`, version: 0, owner: null, data: l as unknown as Record<string, unknown> };
          return (
            <li key={l.segment} id={`line-${l.segment}`} className={cn("group grid grid-cols-[3.5rem_1fr_auto] gap-3 px-3 py-2 text-sm", mine.length > 0 && "bg-muted/30")}>
              <span className="pt-0.5 text-xs tabular-nums text-muted-foreground">{l.startSec !== null ? clock(l.startSec) : ""}</span>
              <div className="min-w-0">
                <p className="text-xs">
                  <span className="font-medium">{l.speaker ?? "Unknown speaker"}</span>
                  {SIDES[l.side] && <span className={cn("ml-1.5", l.side === "rep" ? "text-primary" : "text-muted-foreground")}>{SIDES[l.side]}</span>}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words"><MarkedText text={l.text} marks={mine} /></p>
              </div>
              {actions.length > 0 && <div className="flex items-start gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"><Actions items={actions} ctx={ctx} row={row} /></div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RecordPhone({ n, ctx }: { n: Extract<Of<"phone">, { record: unknown }>; ctx: Ctx }) {
  const id = ctx.value(n.record);
  const person = callRowsOf(ctx.loaded[n.from]?.value).find((r) => r.key === id);
  if (!id) return null;
  const value = person ? valueAt(person, n.phone) : null;
  const phone = typeof value === "string" && /\d/.test(value) ? value.trim() : null;
  return <CallContact key={id} contactId={id} phone={phone} embedded />;
}

/**
 * Canon's dialer working a list of the page's rows (DialerConsole): the next person is the first row this session hasn't
 * dialed since the list was loaded. The rows' phones only pick who is next; Canon reads each person's own number and checks it when it dials.
 */
function PhoneList({ n, ctx }: { n: Exclude<Of<"phone">, { record: unknown }>; ctx: Ctx }) {
  const overview = useQuery(api.dialer.overview);
  const dialContacts = useAction(api.dialerActions.dialContacts);
  const sinceValue = n.since === undefined ? undefined : ctx.formValue(n.since);
  const since = typeof sinceValue === "number" ? sinceValue : 0;
  const called = new Set((overview?.called ?? []).filter((c) => c.at >= since).map((c) => c.contactId));
  const rows = rowsOf(ctx, n.from).filter((r) => {
    const id = valueAt(r, n.person);
    return typeof id === "string" && id && !called.has(id);
  });
  const candidates = rows.slice(0, 500).map((r) => ({ contactId: String(valueAt(r, n.person)), phone: String(valueAt(r, n.phone) ?? "") }));
  const text = (t: Text | undefined, row?: Doc) => (t === undefined ? undefined : renderText(t, row ? { ...ctx.text, row } : ctx.text));
  const campaignId = n.campaign ? ctx.formValue(n.campaign.id) : undefined;
  const campaign = n.campaign && typeof campaignId === "string" && campaignId ? { audienceId: campaignId, name: text(n.campaign.name) ?? "" } : undefined;
  const pick = useQuery(api.dialer.nextOfList, overview?.session ? { candidates, ...(campaign ? { campaign } : {}), ...(since ? { since } : {}) } : "skip");
  const selected = (pick?.contactIds ?? []).flatMap((id) => candidates.filter((c) => c.contactId === id));
  const first = rows.find((r) => valueAt(r, n.person) === selected[0]?.contactId);
  const dial = () => dialContacts({
    candidates: selected,
    ...(campaign ? { campaign } : {}),
    ...(since ? { since } : {}),
  });
  return (
    <DialerConsole
      next={first ? { contactId: String(valueAt(first, n.person)), name: String(valueAt(first, n.name) ?? "") || "Unnamed", detail: text(n.detail, first) ?? String(valueAt(first, n.phone) ?? "") } : null}
      remaining={rows.length}
      dialCount={selected.length}
      dial={dial}
      nextActions={first && n.skip ? <Actions items={[n.skip]} ctx={ctx} row={first} /> : undefined}
      idle={rows.length ? (pick?.held ? `${pick.held === 1 ? "1 person is" : `${pick.held} people are`} held by calling hours or your do-not-call list.` : "Checking who is callable…") : text(n.empty) ?? "Nobody left to call."}
    />
  );
}

/** Messages on a doc, oldest first, with who wrote each and when, and a box to add one. */
function Thread({ n, ctx }: { n: Of<"thread">; ctx: Ctx }) {
  const op = useModuleOp();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = [...rowsOf(ctx, n.from)].sort((a, b) => Number(valueAt(a, n.at ?? "createdAt") ?? 0) - Number(valueAt(b, n.at ?? "createdAt") ?? 0));
  const post = n.post;
  const info = post ? ctx.view.ops[post.op] : undefined;
  // In a row's expansion it posts under the row's doc.
  const parent = post ? ("row" in Object(post.parent) ? (ctx.formValue(post.parent as { row: string }, ctx.text.row as Doc | undefined) as string | undefined) : ctx.value(post.parent as PageExpr)) : undefined;
  // The message field's `maxLength`: the box takes no more, and counts down near it.
  const spec = post ? (info?.fields.find((f) => f.field === post.field)?.spec as FieldSpec | null | undefined) : null;
  const core = spec ? coreOf(spec.fieldType) : null;
  const maxLength = core?.type === "string" ? core.maxLength : undefined;
  const blocked = ctx.view.preview ?? (post && parent ? (ctx.view.blocked as Record<string, Record<string, string>>)[`parent:${parent}`]?.[`op:${post.op}`] ?? null : null);
  async function send() {
    if (!post || !draft.trim()) return;
    setBusy(true);
    try {
      await op({ module: ctx.view.module.slug, op: post.op, parentKey: parent, data: { [post.field]: draft.trim() } });
      setDraft("");
    } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }
  const short = listOf(ctx, n.from)?.complete === false;
  return (
    <div className="max-w-3xl space-y-3">
      {short && <p role="status" className="flex items-center gap-2 border-l-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-xs">Showing the first {listOf(ctx, n.from).limit} messages.<button type="button" className={btn} onClick={() => ctx.more(n.from)}>Show more</button></p>}
      {!rows.length ? <p className="text-sm text-muted-foreground">{renderText(n.empty ?? "No messages yet.", ctx.text)}</p> : (
        <ol className="space-y-3">
          {rows.map((row) => {
            const author = n.author ? valueAt(row, n.author) : undefined;
            const memberAuthor = n.author && (ctx.view.kinds as Record<string, Record<string, Kind>>)[n.from]?.[n.author] === "user";
            // `tags`: words after the author's name by their role in the workspace, "(Rep)".
            const role = author ? ctx.view.members.find((m) => m.id === author)?.role : undefined;
            const tag = role ? n.tags?.[role as keyof NonNullable<typeof n.tags>] : undefined;
            return (
              <li key={row.key} className="border-l-2 border-border pl-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  {author ? <span className="font-medium text-foreground">{memberAuthor ? formatValue(author, "user", ctx.text) : String(author)}</span> : null}{tag ? <span className="text-muted-foreground"> ({tag})</span> : null}{author ? " · " : ""}{formatValue(valueAt(row, n.at ?? "createdAt"), "time", ctx.text)}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap">{String(valueAt(row, n.body) ?? "")}</p>
              </li>
            );
          })}
        </ol>
      )}
      {post && info?.allowed && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
          <textarea aria-label={post.label ?? info.label} placeholder={post.placeholder ? renderFilled(post.placeholder, ctx.text) || undefined : undefined} className="h-20 w-full border border-border bg-background px-2 py-1.5 text-sm" maxLength={maxLength} value={draft} disabled={busy || blocked !== null} onChange={(e) => setDraft(e.target.value)} />
          {maxLength !== undefined && draft.length >= maxLength * 0.8 && <p className="text-right text-xs text-muted-foreground tabular-nums">{draft.length} / {maxLength}</p>}
          <button type="submit" className={primary} disabled={busy || blocked !== null || !draft.trim()}>{post.button ?? post.label ?? info.label}</button>
        </form>
      )}
    </div>
  );
}

/** Steps in order, each with its approver, its state and when it was decided; done ones ticked, failed ones crossed. */
function ApprovalChain({ n, ctx: page }: { n: Of<"approvalChain">; ctx: Ctx }) {
  const rows = [...rowsOf(page, n.from)];
  // A step's action on another doc (`key`: Reset to this step on the chain's instance) is judged by the server, as a table's.
  const ctx = useJudged(n.actions ?? [], rows, page, false);
  if (n.order) rows.sort((a, b) => { const x = valueAt(a, n.order!), y = valueAt(b, n.order!); return typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true }); });
  if (!rows.length) return <p className="text-sm text-muted-foreground">{renderText(n.empty ?? "No steps.", ctx.text)}</p>;
  return (
    <ol aria-label="Approval steps" className="max-w-3xl divide-y divide-border border border-border bg-card">
      {rows.map((row, i) => {
        const scope = rowScope(ctx, n.from, row);
        const derived = n.progress ? progressOf(n.progress, row, ctx) : null;
        const state = derived ?? valueAt(row, n.state!);
        const done = derived ? derived === "done" : n.done?.includes(state as never), failed = derived ? derived === "failed" : n.failed?.includes(state as never);
        const at = n.at ? valueAt(row, n.at) : undefined;
        const note = n.note ? renderText(n.note, scope) : "";
        return (
          <li key={row.key} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
            <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center border text-xs tabular-nums", done ? "border-primary bg-primary text-primary-foreground" : failed ? "border-destructive text-destructive" : "border-border text-muted-foreground")}>
              {done ? <Check className="size-3.5" /> : failed ? <X className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{renderText(n.title, scope)}</span>
              <span className="block text-xs text-muted-foreground">
                {n.approver ? `${formatValue(valueAt(row, n.approver), "user", ctx.text) || "No approver"} · ` : ""}{derived ? PROGRESS[derived] : renderText(`{$row.${n.state}}`, scope)}{at !== undefined && at !== null && at !== "" ? ` · ${formatValue(at, "time", ctx.text)}` : ""}
              </span>
              {note && <span className="mt-1 block text-xs">{note}</span>}
            </span>
            {!!n.actions?.length && <span className="inline-flex gap-1 print:hidden"><Actions items={n.actions} ctx={ctx} row={row} /></span>}
          </li>
        );
      })}
    </ol>
  );
}

const PROGRESS = { done: "Done", current: "Current", waiting: "Waiting", failed: "Stopped" } as const;
/** A step's state from where the doc its steps belong to stands: before its current position done, at it current, after it waiting. */
function progressOf(p: NonNullable<Of<"approvalChain">["progress"]>, row: Doc, ctx: Ctx): keyof typeof PROGRESS {
  const doc = ctx.view.data[p.of] as Doc | null | undefined;
  const at = doc?.data[p.at], by = valueAt(row, p.by);
  const holds = (w: { field: string; in: readonly unknown[] } | undefined) => !!w && !!doc && w.in.includes((doc.data[w.field] ?? null) as never);
  if (holds(p.complete)) return "done";
  if (typeof at !== "number" || typeof by !== "number") return "waiting";
  if (by < at) return "done";
  if (by > at) return "waiting";
  return holds(p.failed) ? "failed" : "current";
}

/** Previous and next over an ordered list, around the doc the page is on. */
function PeriodNav({ n, ctx }: { n: Of<"periodNav">; ctx: Ctx }) {
  const rows = [...rowsOf(ctx, n.from)];
  if (n.sort) rows.sort((a, b) => String(valueAt(a, n.sort!) ?? "").localeCompare(String(valueAt(b, n.sort!) ?? ""), undefined, { numeric: true }));
  const current = ctx.formValue(n.current);
  const at = rows.findIndex((r) => r.key === current);
  if (at < 0) return null;
  const go = (row: Doc | undefined, dir: "prev" | "next") => {
    if (!row) return <span className={cn(btn, "pointer-events-none opacity-40")} aria-disabled>{dir === "prev" ? <ChevronLeft className="size-3.5" /> : null}{dir === "prev" ? "Previous" : "Next"}{dir === "next" ? <ChevronRight className="size-3.5" /> : null}</span>;
    const label = renderText(n.label, rowScope(ctx, n.from, row));
    return (
      <Link className={btn} href={`${ctx.base}/${fillPath(n.link, linkValues(ctx, row))}`} aria-label={`${dir === "prev" ? "Previous" : "Next"}: ${label}`}>
        {dir === "prev" && <ChevronLeft className="size-3.5" />}{label}{dir === "next" && <ChevronRight className="size-3.5" />}
      </Link>
    );
  };
  return (
    <nav aria-label="Periods" className="flex items-center gap-2 text-sm print:hidden">
      {go(rows[at - 1], "prev")}
      <span className="px-2 font-medium tabular-nums">{renderText(n.label, rowScope(ctx, n.from, rows[at]))}</span>
      {go(rows[at + 1], "next")}
      <span className="text-xs text-muted-foreground tabular-nums">{at + 1} of {rows.length}</span>
    </nav>
  );
}

/** Whether a sealed doc still matches its seal, as the server recomputed it for this page. */
function IntegrityBadge({ n, ctx }: { n: Of<"integrity">; ctx: Ctx }) {
  const v = (ctx.view.integrity as Record<string, { state: "intact" | "changed" | "unsealed"; seal: string | null } | null>)[n.from];
  if (!v) return null;
  const short = v.seal ? `${v.seal.slice(0, 15)}…` : null;
  const look = v.state === "intact"
    ? { icon: <ShieldCheck className="size-4 shrink-0 text-primary" />, text: "Sealed. It matches what was sealed.", cls: "border-primary bg-primary/5" }
    : v.state === "changed"
      ? { icon: <ShieldAlert className="size-4 shrink-0 text-destructive" />, text: "Changed since it was sealed. What it covers no longer matches its seal.", cls: "border-destructive bg-destructive/10" }
      : { icon: <ShieldQuestion className="size-4 shrink-0 text-muted-foreground" />, text: "Not sealed.", cls: "border-border bg-muted/40" };
  return (
    <p role="status" data-integrity={v.state} className={cn("flex flex-wrap items-center gap-2 border-l-2 px-3 py-2 text-xs", look.cls)}>
      {look.icon}<span className="font-medium">{look.text}</span>{short && <span className="font-mono text-muted-foreground" title={v.seal ?? undefined}>{short}</span>}
    </p>
  );
}

const TONES = {
  info: "border-border bg-muted/40",
  success: "border-primary bg-primary/5",
  warn: "border-amber-600 bg-amber-500/10",
  danger: "border-destructive bg-destructive/10",
  // What an AI step filled: Canon's provenance colour (docs/ui-style.md), never a status.
  ai: "border-provenance bg-provenance-tint/30",
} as const;
/** A column's tone as a badge, and as the text's color (docs/modules.md, "Tables, queues and status"). */
const BADGE_TONES = { ...TONES, success: "border-primary bg-primary/10 text-primary", danger: "border-destructive bg-destructive/10 text-destructive", warn: "border-amber-600 bg-amber-500/10 text-amber-800 dark:text-amber-300", neutral: "border-border bg-card", ai: "border-provenance bg-provenance-tint/30 text-provenance" } as const;
const TEXT_TONES = { info: "text-muted-foreground", success: "text-primary", warn: "text-amber-700 dark:text-amber-300", danger: "text-destructive", neutral: "", ai: "text-provenance" } as const;

/** A machine's states in order: those before the doc's current state done, the current one marked. */
function StatusSteps({ n, ctx }: { n: Of<"statusSteps">; ctx: Ctx }) {
  const doc = ctx.view.data[n.from] as Doc | null;
  const machine = ctx.view.machines[n.machine];
  if (!doc || !machine) return null;
  const steps = n.steps ?? machine.states;
  const current = steps.indexOf(doc.data[machine.field] as string);
  // The states the doc has been in, from its history: a machine that skips a state doesn't show it done.
  const visited = (ctx.view.visited as Record<string, string[]>)[n.from];
  const done = (s: string, i: number) => i !== current && (visited ? visited.includes(s) : i < current);
  return (
    <ol aria-label="Status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="h-px w-6 bg-border" />}
          <span className={cn("inline-flex items-center gap-1 border px-2 py-0.5", i === current ? "border-foreground font-medium text-foreground" : done(s, i) ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground")}>
            {done(s, i) && <Check className="size-3" />}{machine.stateLabels?.[s] ?? human(s)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** What one audit row says happened: a transition, a proposal waiting on a person, or an op's write. */
function eventText(e: Event, ctx: Ctx): string {
  const [machine, name] = e.verb.split(".");
  const transition = ctx.view.machines[machine]?.transitions[name]?.label;
  // A state reads as the machine's label for it ("Under review"), not its name.
  const state = (x: string | undefined | null) => ctx.view.machines[machine]?.stateLabels?.[x ?? ""] ?? human(x ?? "");
  if (e.kind === "transition") return e.from === e.to ? transition ?? e.verb : `${transition ?? e.verb}: ${state(e.from)} → ${state(e.to)}`;
  if (e.kind === "propose") return `Proposed ${transition ?? ctx.view.ops[e.verb]?.label ?? e.verb}, waiting for approval`;
  if (e.kind === "create") return e.cause ? `Created by ${transition ?? e.verb}` : "Created";
  if (e.kind === "delete") return "Deleted";
  if (e.kind === "event") return e.reason ?? "Note";
  const by = e.cause?.startsWith("call ") ? ctx.view.calls[e.cause.slice(5)]?.label : undefined;
  if (by) return `${by}: ${e.fields.map(human).join(", ").toLowerCase()}`;
  return `${ctx.view.ops[e.verb]?.label ?? e.verb}: ${e.fields.map(human).join(", ").toLowerCase()}`;
}

/** A doc's audit trail, newest first: who did what, when, with what reason. */
function Timeline({ n, ctx }: { n: Of<"timeline">; ctx: Ctx }) {
  const events = ctx.view.events[n.of];
  if (!events) return null;
  if (!events.length) return <p className="text-sm text-muted-foreground">Nothing has happened to this yet.</p>;
  return (
    <ol className="space-y-3 border-l border-border pl-4">
      {events.map((e, i) => {
        const who = e.actor.kind === "system" ? "System" : e.actor.kind === "visitor" ? "Unverified visitor" : ctx.text.members.get(e.actor.userId) ?? "A former member";
        // A `reason` argument that is a choice shows its label ("Wrong amount"), not its value.
        const [mn, tn] = e.verb.split(".");
        const reasonLabels = ctx.view.machines[mn]?.transitions[tn]?.fields.find((f) => f.field === "reason")?.labels as Record<string, string> | null | undefined;
        const arg = typeof e.args?.reason === "string" ? (reasonLabels?.[e.args.reason] ?? (reasonLabels ? human(e.args.reason) : e.args.reason)) : null;
        const note = e.kind === "event" ? null : e.reason ?? arg;
        return (
          <li key={i} className="text-sm">
            <p><span className="font-medium">{eventText(e, ctx)}</span></p>
            <p className="text-xs text-muted-foreground">
              {e.actor.kind === "agent" ? `${who}'s agent (${e.actor.client})` : who} · {new Date(e.at).toLocaleString()}
              {e.proposal && (e.kind === "propose" ? <> · <Link className="underline" href={`/dashboard/patch-plans?plan=${e.proposal}`}>Review</Link></> : " · approved proposal")}
            </p>
            {note && <p className="mt-0.5 text-xs">{note}</p>}
            {e.evidence && <p className="mt-0.5 text-xs text-muted-foreground">Signed from {[e.evidence.ip, e.evidence.userAgent].filter(Boolean).join(" · ")}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** A file the server handed back as base64, saved under its name. */
function save(b64: string, type: string, filename: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Today's date as the person's browser has it, `YYYY-MM-DD`. */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** A transition that records where the person ran it, through Canon's web server (src/app/api/modules/transition). */
async function withEvidence(input: { module: string; machine: string; name: string; key: string; expect: number; args: Record<string, unknown> }) {
  const res = await fetch("/api/modules/transition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const out = (await res.json().catch(() => ({ error: "That didn't run. Try again." }))) as { error?: string } & ({ key: string; version: number; state: string } | { proposed: string });
  if (!res.ok || out.error) throw new Error(out.error ?? "That didn't run. Try again.");
  return out;
}
/** An export's formats as a menu. */
function ExportMenu({ label, aria, formats, onPick }: { label: string; aria?: string; formats: readonly ExportFormat[]; onPick: (f: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const names: Record<ExportFormat, string> = { csv: "CSV (.csv)", xlsx: "Excel (.xlsx)", pdf: "PDF (.pdf)" };
  return (
    <span className="relative inline-flex">
      <button type="button" className={btn} aria-haspopup="menu" aria-expanded={open} aria-label={aria} onClick={() => setOpen((o) => !o)}><Download className="size-3.5" />{label}<ChevronDown className="size-3" /></button>
      {open && (
        <span role="menu" className="absolute top-full right-0 z-20 mt-1 flex min-w-36 flex-col border border-border bg-popover py-1 text-xs shadow-sm">
          {formats.map((f) => <button key={f} type="button" role="menuitem" className="px-3 py-1.5 text-left hover:bg-muted" onClick={() => { setOpen(false); onPick(f); }}>{names[f]}</button>)}
        </span>
      )}
    </span>
  );
}

/** An action's label, its `{$...}` filled from the page and the row it sits on: "Recalculate {$period.year}". */
function actionLabel(a: ActionRef, ctx: Ctx, row?: Doc) {
  const fill = (t: string) => renderText(t, row ? { ...ctx.text, row } : ctx.text);
  if ("navigate" in a) return fill(a.label);
  if ("print" in a) return a.print;
  if ("pdf" in a) return a.pdf;
  if ("menu" in a) return fill(a.menu);
  if ("viewAs" in a) return fill(a.label);
  if ("canon" in a) return a.label;
  if ("export" in a) return a.label ?? ctx.view.exports[a.export]?.label ?? a.export;
  if ("csvImport" in a) return a.label ?? ctx.view.csvImports?.[a.csvImport]?.label ?? a.csvImport;
  if ("call" in a) return fill(a.label ?? ctx.view.calls[a.call]?.label ?? a.call);
  if ("transition" in a) return fill(a.label ?? transitionOf(a, ctx)?.label ?? a.transition);
  return fill(a.label ?? ctx.view.ops[a.op]?.label ?? a.op);
}
/** What a screen reader says for an action's button: its `aria`, filled as its label is from the page and the row. */
function ariaOf(a: ActionRef, ctx: Ctx, row?: Doc): string | undefined {
  return "aria" in a && a.aria ? renderText(a.aria, row ? { ...ctx.text, row } : ctx.text) : undefined;
}
/**
 * Where a navigate action goes: its path's `{$...}` filled as text is (each value URL-encoded), then its `:params` from
 * the row, else the doc `target` binds, else the route; with `report`, the report builder there opens with that shape.
 */
function navigateHref(a: Extract<ActionRef, { navigate: string }>, ctx: Ctx, row?: Doc): string {
  const scope = row ? { ...ctx.text, row } : ctx.text;
  const filled = a.navigate.replace(/\{\$[^}]+\}/g, (m) => encodeURIComponent(renderText(m, scope)));
  const target = a.target ? (ctx.view.data[a.target] as Doc | null | undefined) : undefined;
  const path = fillPath(filled, { ...(ctx.view.params as Record<string, string>), ...(target ? linkValues(ctx, target) : {}), ...(row ? linkValues(ctx, row) : {}) });
  if (!a.report) return `${ctx.base}/${path}`;
  const { id, ...shape } = a.report;
  return `${ctx.base}/${path}${path.includes("?") ? "&" : "?"}${encodeURIComponent(`${id}.config`)}=${encodeURIComponent(JSON.stringify(shape))}`;
}
/**
 * Whether a navigate action opens the page the person is on: its path is this page's, and each URL parameter it sets
 * holds that value now. A strip of section links (Plans, Metric inputs, SPIF campaigns) marks the open one.
 */
function current(a: ActionRef, ctx: Ctx, row?: Doc): boolean {
  if (!("navigate" in a) || row || a.report) return false;
  const [path, qs = ""] = navigateHref(a, ctx).split("?");
  const here = `${ctx.base}/${fillPath(ctx.view.page.path, ctx.view.params as Record<string, string>)}`;
  return decodeURIComponent(path) === decodeURIComponent(here) && [...new URLSearchParams(qs).entries()].every(([k, v]) => (ctx.query[k] ?? "") === v);
}
/** Row actions shown as buttons before the rest fold into a More menu. */
const ROW_BUTTONS = 3;
/**
 * The actions the caller may run: an op their role can't run, or a transition not open from the doc's state, doesn't
 * show. On a row, past ROW_BUTTONS of them the rest sit in a More menu, so a row stays one line.
 */
function Actions({ items, ctx, row }: { items: readonly ActionRef[]; ctx: Ctx; row?: Doc }) {
  // A write whose `wait` still lasts says its `busy` text, disabled with a spinner: "Recalculating FY2027".
  const waits = useSyncExternalStore(WAITS.subscribe, WAITS.get, WAITS.get);
  const busyOf = (a: ActionRef) => { if (!("wait" in a) || !a.wait?.busy) return null; const id = waitId(ctx.view.module.slug, a, row); return waits.find((w) => w.action === id)?.busy ?? null; };
  const offeredHere = items.filter((a) => offered(a, ctx, row));
  const fold = row !== undefined && offeredHere.length > ROW_BUTTONS + 1;
  const shown = fold ? offeredHere.slice(0, ROW_BUTTONS) : offeredHere;
  const rest = fold ? offeredHere.slice(ROW_BUTTONS) : [];
  return <>{shown.map((a, i) => {
    const kind = "op" in a ? ctx.view.ops[a.op].kind : null;
    const why = blockedReason(a, ctx, row);
    const busy = busyOf(a);
    const button = (
      <button key={i} type="button" className={cn(kind === "create" && !row ? primary : btn, current(a, ctx, row) && "border-foreground bg-muted font-semibold")} disabled={why !== null || busy !== null} aria-busy={busy !== null || undefined} aria-current={current(a, ctx, row) ? "page" : undefined} aria-label={ariaOf(a, ctx, row)} aria-describedby={why ? `why-${i}` : undefined} onClick={() => ctx.run(a, row, ctx.judged)}>
        {busy !== null ? <><RefreshCw className="size-3.5 animate-spin" />{busy}</> : <>{kind === "create" && <Plus className="size-3.5" />}{kind === "delete" && <Trash2 className="size-3.5" />}{("print" in a || "pdf" in a) && <Printer className="size-3.5" />}{"export" in a && <Download className="size-3.5" />}{"csvImport" in a && <Upload className="size-3.5" />}{actionLabel(a, ctx, row)}</>}
      </button>
    );
    // An export offered in more than one format is a menu of them; a menu holds several actions under one button.
    // An export with members to pick asks its format in its dialog, as cards.
    if ("export" in a && (a.formats?.length ?? 0) > 1 && !a.members) return <ExportMenu key={i} label={actionLabel(a, ctx, row)} aria={ariaOf(a, ctx, row)} formats={a.formats!} onPick={(f) => ctx.run(a, row, ctx.judged, f)} />;
    if ("menu" in a) return <ActionMenu key={i} a={a} ctx={ctx} row={row} />;
    // A disabled button gets no hover in some browsers: the reason sits on a wrapper, and is read out with the button.
    return why === null ? button : <span key={i} title={why} className="inline-flex">{button}<span id={`why-${i}`} className="sr-only">{why}</span></span>;
  })}{rest.length > 0 && <MoreMenu items={rest} ctx={ctx} row={row} />}</>;
}

const FORMAT_NAMES: Record<ExportFormat, string> = { csv: "CSV", xlsx: "Excel", pdf: "PDF" };
/**
 * A menu of actions under one button (docs/modules.md, "Actions"): each the caller is offered, an export once per format
 * ("Statements (CSV)", "Statements (Excel)"), a PDF, a sealed payroll file; one whose guard fails now is disabled with why.
 */
function ActionMenu({ a, ctx, row }: { a: MenuRef; ctx: Ctx; row?: Doc }) {
  const [open, setOpen] = useState(false);
  type Entry = { x: MenuRef["items"][number]; f: ExportFormat | undefined; label: string; rule?: boolean };
  const entries = a.items.filter((x) => offered(x, ctx, row)).flatMap((x): Entry[] => ("export" in x && (x.formats?.length ?? 0) > 1 && !x.members
    ? x.formats!.map((f, k) => ({ x, f, label: `${actionLabel(x, ctx, row)} (${FORMAT_NAMES[f]})`, rule: k === 0 && x.separator }))
    : [{ x, f: undefined as ExportFormat | undefined, label: actionLabel(x, ctx, row), rule: x.separator }]));
  return (
    <span className="relative inline-flex" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false); }}>
      <button type="button" className={btn} aria-haspopup="menu" aria-expanded={open} aria-label={ariaOf(a, ctx, row)} onClick={() => setOpen((o) => !o)}><Download className="size-3.5" />{actionLabel(a, ctx, row)}<ChevronDown className="size-3" /></button>
      {open && (
        <span role="menu" className="absolute top-full right-0 z-20 mt-1 flex min-w-48 flex-col border border-border bg-popover py-1 text-left text-xs shadow-sm">
          {entries.map(({ x, f, label, rule }, i) => {
            const why = blockedReason(x, ctx, row);
            const line = x.line ? renderText(x.line, row ? { ...ctx.text, row } : ctx.text) : "";
            return (
              <Fragment key={i}>
                {rule && i > 0 && <span role="separator" className="my-1 border-t border-border" />}
                <button type="button" role="menuitem" disabled={why !== null} title={why ?? undefined} aria-label={ariaOf(x, ctx, row)} className="px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                  onClick={() => { setOpen(false); ctx.run(x, row, ctx.judged, f); }}>{label}{line && <span className="block text-[11px] text-muted-foreground">{line}</span>}{why && <span className="block text-[11px] text-muted-foreground">{why}</span>}</button>
              </Fragment>
            );
          })}
        </span>
      )}
    </span>
  );
}

/** A row's actions past the first few, as a menu: each disabled with its reason when its guard fails now. */
function MoreMenu({ items, ctx, row }: { items: readonly ActionRef[]; ctx: Ctx; row?: Doc }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false); }}>
      <button type="button" className={btn} aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen((o) => !o)}><MoreHorizontal className="size-3.5" />More</button>
      {open && (
        <span role="menu" className="absolute top-full right-0 z-20 mt-1 flex min-w-44 flex-col border border-border bg-popover py-1 text-left text-xs shadow-sm">
          {items.map((a, i) => {
            const why = blockedReason(a, ctx, row);
            return (
              <button key={i} type="button" role="menuitem" disabled={why !== null} title={why ?? undefined} aria-label={ariaOf(a, ctx, row)} className="px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                onClick={() => { setOpen(false); ctx.run(a, row, ctx.judged); }}>{actionLabel(a, ctx, row)}{why && <span className="block text-[11px] text-muted-foreground">{why}</span>}</button>
            );
          })}
        </span>
      )}
    </span>
  );
}

/**
 * A link to the file a text names, when the text is one file field of a bound doc or the row (`{$visit.photo}`):
 * its name, opening a download link the server hands only to a reader of the doc. Null for any other text.
 */
function fileIn(t: string, ctx: Ctx, rowBind?: string, row?: Doc): ReactNode | null {
  const m = /^\{\$([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9_]*)(?:\|file)?\}$/.exec(t.trim());
  if (!m) return null;
  const bind = m[1] === "row" ? rowBind : m[1];
  const doc = m[1] === "row" ? row : (ctx.view.data[m[1]] as Doc | null | undefined);
  const collection = bind ? (ctx.view.collections as Record<string, string>)[bind] : undefined;
  if (!bind || !doc || !collection || (ctx.view.formats as Record<string, Record<string, string>>)[bind]?.[m[2]] !== "file") return null;
  const id = doc.data[m[2]];
  if (typeof id !== "string") return <span className="text-muted-foreground">None</span>;
  const info = ctx.view.files[id];
  return <span className="inline-flex flex-col gap-1"><FileLink module={ctx.view.module.slug} collection={collection} docKey={doc.key} file={id} name={info?.name ?? "A file"} />{info?.buyer && <span className="text-xs text-muted-foreground">{info.buyer.label} ({info.buyer.verified ? "verified" : "unverified"}) · not scanned</span>}</span>;
}
/** A file's name; a click asks the server for its download link (only a reader of the doc gets one) and opens it. */
function FileLink({ module, collection, docKey, file, name }: { module: string; collection: string; docKey: string; file: string; name: string }) {
  const convex = useConvex();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="inline-flex items-center gap-1 text-left hover:underline disabled:opacity-50" disabled={busy} onClick={async () => {
      // A tab opened now, while the click counts as the person's, then sent to the link: a popup blocker lets it through.
      const tab = window.open("", "_blank");
      if (tab) tab.opener = null;
      setBusy(true);
      try {
        const got = await convex.query(api.modules.fileUrl, { module, collection, key: docKey, file });
        if (!got) { tab?.close(); toast.error("You can't download that file."); }
        else if (tab) tab.location.href = got.url;
        else window.location.assign(got.url);
      } catch (e) { tab?.close(); toast.error(getErrorMessage(e)); } finally { setBusy(false); }
    }}><Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />{name}</button>
  );
}

/** The text scope of one row of a list binding: its labels and its fields' own formats. */
const rowScope = (ctx: Ctx, bind: string, row: Doc): TextScope => ({ ...ctx.text, row, rowLabels: ctx.view.labels[bind], rowFormats: (ctx.view.formats as Record<string, Record<string, string>>)[bind] });
/** How a binding's row values show, for search, filters and sections. */
const shownFor = (ctx: Ctx, bind: string): Shown => ({
  labels: ctx.view.labels[bind], members: ctx.text.members, refs: ctx.view.refLabels, currency: ctx.view.currency, decimals: ctx.view.decimals, files: ctx.view.files,
  kinds: (ctx.view.kinds as Record<string, Record<string, Kind>>)[bind],
});
/** The text a row's link fills: its key, its fields' values, and the route's parameters. */
const linkValues = (ctx: Ctx, row: Doc): Record<string, string> => ({
  ...(ctx.view.params as Record<string, string>),
  ...Object.fromEntries(Object.entries(row.data).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" ? [[k, String(v)]] : []))),
  key: row.key,
});

/**
 * A list (docs/modules.md, "Tables"): its rows' columns, with joined refs and counts the server read, a search box,
 * filter chips, sorting by a column, sections with their totals, row links and row actions. Only over a binding read
 * whole: a list with more rows than it read says so and offers more, never a short sort or total.
 */
type TableLike = { from: string; columns: readonly Column[]; rows?: string; empty?: Text } & TableKeys;
/** A call's value as table rows (`rows`, a field of it, or the value): each a row, not a doc. */
const callRowsOf = (value: unknown, field?: string): Row[] =>
  rowsOfValue(value, field).map((d) => ({ ...d, call: true as const }));
/** What a call's row values are, for its filters: a member, a date, true/false, a number, else text, as the values say. */
function inferKinds(rows: readonly Doc[], fields: readonly string[], members: ReadonlyMap<string, string>): Record<string, Kind> {
  return Object.fromEntries(fields.map((f) => {
    const vs = rows.map((r) => valueAt(r, f)).filter((v) => v !== undefined && v !== null && v !== "");
    const all = (test: (v: unknown) => boolean) => vs.length > 0 && vs.every(test);
    return [f, all((v) => typeof v === "string" && members.has(v)) ? "user" : all((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) ? "date"
      : all((v) => typeof v === "boolean") ? "bool" : all((v) => typeof v === "number") ? "number" : "text"];
  }));
}

/**
 * What the server judged of the actions on rows that name their doc (docs/modules.md, "Tables, queues and status"): on a
 * call's rows every write, on a list's rows (a table's, an approval chain's) those whose `key` names another doc. Each
 * doc as the caller reads it, its version, its state and why the action can't run now; `ctx.judged` carries them.
 */
function useJudged(actions: readonly ActionRef[], rows: readonly Doc[], ctx: Ctx, callRows: boolean): Ctx {
  type Check = { id: string; transition?: { machine: string; name: string; key: string; args?: Record<string, unknown> }; op?: { name: string; key?: string; parentKey?: string; data?: Record<string, unknown> } };
  const judgedActions = actions.filter((a) => callRows || ("key" in a && a.key !== undefined));
  const checks: Check[] = judgedActions.length ? rows.slice(0, 200).flatMap((row) => judgedActions.flatMap((a): Check[] => {
    if (a.when && !condHolds(a.when, ctx, targetOf(a, ctx, row))) return [];
    const id = judgeId(a, ctx, row);
    const key = rowDocKey(a, ctx, row);
    // A transition is judged with the arguments it fixes (the step a chain's row names), as its button would run.
    if ("transition" in a) {
      const args = prefill({ fixed: a.fixed }, ctx, row).fixed;
      return key ? [{ id, transition: { machine: a.machine, name: a.transition, key, ...(Object.keys(args).length ? { args } : {}) } }] : [];
    }
    if (!("op" in a)) return [];
    const kind = ctx.view.ops[a.op]?.kind;
    if (kind !== "create") return key ? [{ id, op: { name: a.op, key } }] : [];
    // Judged on what the action fixes: a guard on a field its dialog asks for waits for the submit (#547).
    const { fixed } = prefill({ fixed: a.fixed }, ctx, row);
    const parent = ctx.value(a.parent);
    return [{ id, op: { name: a.op, data: fixed, ...(parent ? { parentKey: parent } : {}) } }];
  })) : [];
  const judged = useQuery(api.modules.judge, checks.length ? { module: ctx.view.module.slug, checks: checks.slice(0, 400) } : "skip");
  return judgedActions.length ? { ...ctx, judged: judged ?? {} } : ctx;
}

/**
 * A table over a list binding's docs or a call's rows (docs/modules.md, "Tables, queues and status"): the same
 * search, filters, sort, sections, totals, links and row actions either way. On a call's rows, an action that writes
 * names its doc by a row field, and the server judges each one (its doc's state and guards) before it shows.
 */
function Table({ n: declared, ctx, given }: { n: TableLike; ctx: Ctx; given?: Row[] }) {
  // An `each` column is one column per item: a fiscal year's months in fiscal order, or a binding's rows.
  const n: TableLike = declared.columns.some((c) => c.each) ? { ...declared, columns: expandColumns(declared.columns, (each) => eachItems(each, (from, field) => eachRows(ctx, from, field), "fiscalMonths" in each && each.fiscalMonths !== null ? ctx.formValue(each.fiscalMonths) : null, ctx.view.fiscalYearStartMonth), ctx.text) } : declared;
  const [treeClosed, setTreeClosed] = useState<Set<string>>(new Set());
  const [treeDrop, setTreeDrop] = useState<string | null>(null);
  const hierarchy = n.hierarchy;
  const loadedCall = Object.hasOwn(ctx.view.loads as object, n.from);
  const loaded = loadedCall ? ctx.loaded[n.from] : undefined;
  const callRows = given !== undefined || loadedCall;
  const read: Doc[] = given ?? (loadedCall ? (loaded?.value === undefined ? [] : callRowsOf(loaded.value, n.rows)) : ((ctx.view.data[n.from] as Doc[] | undefined) ?? []));
  // A table people reorder shows its rows in the order its field holds (a stop's position).
  const orderBy = n.reorder?.by;
  const rows = orderBy ? [...read].sort((a, b) => Number(valueAt(a, orderBy) ?? Infinity) - Number(valueAt(b, orderBy) ?? Infinity)) : read;
  if (hierarchy) hierarchyRows(rows, hierarchy);
  const list = callRows ? undefined : (ctx.view.lists as Record<string, { complete: boolean; limit: number; countError: string | null }>)[n.from];
  const actions = n.rowActions ?? [];
  const focused = n.focus ? focusedKey(rows.map((r) => r.key), n.focus, ctx.query) : null;
  const focusRow = (key: string) => { if (n.focus) ctx.setQuery(focusQuery(n.focus, key)); };
  const focusEvents = (row: Doc) => n.focus ? {
    onMouseEnter: () => ctx.hoverRow(n.focus!.param, row.key), onMouseLeave: () => ctx.hoverRow(n.focus!.param, null),
    onFocus: () => ctx.hoverRow(n.focus!.param, row.key), onBlur: () => ctx.hoverRow(n.focus!.param, null),
    onClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("button,a,input,textarea,select")) focusRow(row.key); },
  } : {};
  const shown: Shown = callRows ? { ...shownFor(ctx, n.from), labels: undefined, kinds: inferKinds(rows, [...(n.filters ?? []).map((f) => f.field), ...(n.group ? [n.group.by] : []), ...(n.search ?? [])], ctx.text.members) } : shownFor(ctx, n.from);
  ctx = useJudged([...actions, ...(n.select?.actions ?? [])], rows, ctx, callRows);
  // A row's transition that opens the doc it created opens it where the row links, unless it names a page.
  if (n.rowLink) { const outer = ctx.run, link = n.rowLink; ctx = { ...ctx, run: (a, row, j, f, l) => outer(a, row, j, f, l ?? link) }; }
  // Rows picked for the table's `select` actions, by key: each picked row's action runs on its own, checked as one would.
  // With `select.param`, the picked keys live in the URL, where the page's bindings read them.
  const [pickedLocal, setPickedLocal] = useState<Set<string>>(new Set());
  const param = n.select?.param;
  const picked = param ? new Set((ctx.query[param] ?? "").split(",").filter(Boolean)) : pickedLocal;
  const setPicked = (next: Set<string>) => (param ? ctx.setQuery({ [param]: next.size ? [...next].join(",") : null }) : setPickedLocal(next));
  const selecting = !!(n.select?.actions.length || n.select?.edit || param);
  const filterFields = (n.filters ?? []).map((f) => f.field);
  // State lives in the URL under the table's id (a link opens it as it was), else on the page.
  const [local, setLocal] = useState<TableState>(() => stateFromQuery(undefined, {}));
  const state = n.id ? stateFromQuery(n.id, ctx.query) : local;
  const setState = (next: TableState) => (n.id ? ctx.setQuery(queryFromState(n.id, next, filterFields)) : setLocal(next));
  const [closed, setClosed] = useState<Set<string> | null>(null);
  const [showing, setShowing] = useState(n.pageSize ?? 50);
  // `group.pageSize`: grouped, each group shows its own first rows and pages on its own; by group key.
  const [sectionShown, setSectionShown] = useState<Record<string, number>>({});
  const complete = list?.complete !== false;
  // A chip (one at a time) and a chosen grouping, in the URL under the table's id like its sort, else on the page.
  const [localExtra, setLocalExtra] = useState<{ chip: string; groupBy: string }>({ chip: "", groupBy: "" });
  const extra = n.id ? { chip: ctx.query[`${n.id}.chip`] ?? "", groupBy: ctx.query[`${n.id}.groupBy`] ?? "" } : localExtra;
  const setExtra = (next: Partial<typeof extra>) => (n.id ? ctx.setQuery({ ...("chip" in next ? { [`${n.id}.chip`]: next.chip || null } : {}), ...("groupBy" in next ? { [`${n.id}.groupBy`]: next.groupBy || null } : {}) }) : setLocalExtra({ ...localExtra, ...next }));
  const holds = (w: TableChipWhen, row: Doc) => {
    const v = valueAt(row, w.field);
    if ("me" in w || "gte" in w) return rowWhenHolds(w, row, ctx.view.userId);
    if ("set" in w) return (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) === w.set;
    return (Array.isArray(v) ? v : [v]).some((x) => w.in.some((y) => String(y ?? "") === String(x ?? "")));
  };
  const chip = n.chips?.[Number(extra.chip) - 1] ?? null;
  const chipped = chip ? rows.filter((r) => holds(chip.when, r)) : rows;
  // The section the person picked (`groupBy`), else the table's own `group`; "none" sections nothing.
  const picked0 = n.groupBy?.find((g) => g.by === extra.groupBy);
  const group = extra.groupBy === "none" ? undefined : picked0 ? { by: picked0.by } : n.group;
  const spec = { ...n, group };
  const tools = Boolean(n.search?.length || n.filters?.length || n.chips?.length || n.groupBy?.length);
  // A search also matches what the row's cells say: a joined name ({$row.plan.name}), a member's.
  const cellText = (row: Doc) => n.columns.map((c) => renderText(columnText(c, row, ctx.view.userId), rowScope(ctx, n.from, row))).join(" ");
  const sections0 = complete ? arrange(chipped, spec, state, shown, n.search?.length ? cellText : undefined) : [{ key: "", label: "", rows }];
  const treeParent = (row: Doc) => { const parent = hierarchy ? valueAt(row, hierarchy.parent) : null; return parent === null || parent === undefined || parent === "" ? null : String(parent); };
  const sections = hierarchy ? sections0.map((section) => ({ ...section, rows: visibleHierarchy(section.rows, treeParent, treeClosed) })) : sections0;
  const chipCount = (w: TableChipWhen | null) => (complete ? arrange(w ? rows.filter((r) => holds(w, r)) : rows, { ...spec, group: undefined }, state, shown, n.search?.length ? cellText : undefined).reduce((k, x) => k + x.rows.length, 0) : 0);
  const needs = (row: Doc) => !!n.attention && holds(n.attention, row);
  // Drag to reorder (`reorder`): only over every row as the list holds them, never a sorted, filtered or sectioned view.
  const runReorder = useAction(api.modules.call);
  const [dragKey, setDragKeyState] = useState<string | null>(null);
  // The row being dragged, read by the drop at once (a second drop event before the page redraws does nothing).
  const dragging = useRef<string | null>(null);
  const setDragKey = (k: string | null) => { dragging.current = k; setDragKeyState(k); };
  const canDrag = !!n.reorder && complete && !state.sort && !n.sort && !state.q && !Object.values(state.filters).some((v) => v.length) && !chip && !group && ctx.view.calls[n.reorder.call]?.allowed && !ctx.view.preview;
  const dropOn = (target: Doc) => {
    const moving = dragging.current;
    if (!n.reorder || moving === null || moving === target.key) return setDragKey(null);
    const keys = rows.map((r) => r.key).filter((k) => k !== moving);
    keys.splice(keys.indexOf(target.key) + (rows.findIndex((r) => r.key === moving) < rows.findIndex((r) => r.key === target.key) ? 1 : 0), 0, moving);
    setDragKey(null);
    const fixed = Object.fromEntries(Object.entries(n.reorder.args ?? {}).flatMap(([k, x]) => { const v = ctx.formValue(x); return v === undefined || v === null ? [] : [[k, v]]; }));
    void runReorder({ module: ctx.view.module.slug, call: n.reorder.call, args: { ...fixed, [n.reorder.arg ?? "keys"]: keys } })
      .then(() => { ctx.reloadAll(); toast.success("Order saved"); }, (e) => toast.error(getErrorMessage(e)));
  };
  const hierarchyMove = hierarchy?.move;
  const movable = (row: Doc) => !!hierarchyMove && ctx.editor.allowed(hierarchyMove) && rowChoices(row, hierarchyMove.targets).length > 0;
  const treeDropAllowed = (row: Doc) => {
    const source = rows.find((r) => r.key === dragging.current);
    return !!hierarchyMove && !!source && movable(source) && rowChoices(source, hierarchyMove.targets).some((o) => o.value === row.key);
  };
  const dropTree = (target: Doc) => {
    const source = rows.find((r) => r.key === dragging.current);
    const allowed = treeDropAllowed(target);
    setDragKey(null); setTreeDrop(null);
    if (!source || !hierarchyMove) return;
    if (!allowed) { toast.error("Choose one of this row's available move targets."); return; }
    void ctx.editor.invoke(hierarchyMove, source, { [hierarchyMove.arg]: target.key }).catch((e) => toast.error(getErrorMessage(e)));
  };
  const closingBranches = (row: Doc, next?: Doc): Doc[] => {
    if (!hierarchy) return [];
    const minimum = next ? Number(valueAt(next, hierarchy.depth)) : 0;
    const result: Doc[] = [];
    let current: Doc | undefined = row;
    while (current && Number(valueAt(current, hierarchy.depth)) >= minimum) {
      result.push(current);
      const parent = treeParent(current);
      current = parent ? rows.find((r) => r.key === parent) : undefined;
    }
    return result;
  };
  const matched = sections.reduce((k, x) => k + x.rows.length, 0);
  const isClosed = (k: string) => (closed ?? (group?.collapsed ? new Set(sections.map((x) => x.key)) : new Set<string>())).has(k);
  const toggle = (k: string) => setClosed((c) => { const base = c ?? (group?.collapsed ? new Set(sections.map((x) => x.key)) : new Set<string>()); const next = new Set(base); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  const totals = n.columns.some((c) => c.total);
  const sumCell = (rs: readonly Doc[], c: (typeof n.columns)[number]) => (c.total ? totalText(rs, c.total, ctx.text) : "");
  /** A section header's cell: the column's `group` text over the section's first row, else its total. */
  const headCell = (rs: readonly Doc[], c: (typeof n.columns)[number]) => (c.group !== undefined ? (rs[0] ? renderText(c.group, rowScope(ctx, n.from, rs[0])) : "") : sumCell(rs, c));
  const sortBy = (c: (typeof n.columns)[number]) => {
    if (!c.sort || !complete) return;
    const cur = state.sort ?? (n.sort ? { by: n.sort.by, dir: n.sort.dir ?? "asc" } : null);
    setState({ ...state, sort: cur?.by === c.sort && cur.dir === "asc" ? { by: c.sort, dir: "desc" } : { by: c.sort, dir: "asc" } });
  };
  const sorted = state.sort ?? (n.sort ? { by: n.sort.by, dir: n.sort.dir ?? "asc" } : null);
  /**
   * A filter's choices: the values the rows hold, then every other value it may hold: a list's choice field's schema
   * values, or on a call's rows the list its value's `options` field names (every stage).
   */
  const filterOptions = (f: NonNullable<TableLike["filters"]>[number]) => {
    const held = choicesOf(rows, f.field, shown);
    const value = loaded?.value ?? ctx.loaded[n.from]?.value;
    const more: unknown[] = f.options !== undefined
      ? [((value !== null && typeof value === "object" ? (value as Record<string, unknown>)[f.options] : undefined) ?? [])].flat()
      : callRows ? [] : (((ctx.view.choices as Record<string, Record<string, string[]>>)[n.from] ?? {})[f.field] ?? []);
    const labels = (shown.labels as Record<string, Record<string, string>> | undefined)?.[f.field];
    const extra = more.flatMap((x) => {
      const v = x !== null && typeof x === "object" ? String((x as { value?: unknown }).value ?? "") : String(x ?? "");
      const label = x !== null && typeof x === "object" ? String((x as { label?: unknown }).label ?? v) : labels?.[v] ?? v;
      return v && !held.some((h) => h.value === v) ? [{ value: v, label }] : [];
    });
    return [...held, ...extra].sort((a, b) => (a.value === "" ? 1 : b.value === "" ? -1 : a.label.localeCompare(b.label)));
  };

  // Rows whose `expand` column is open, by column and row: the column's components draw under the row.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const flip = (id: string) => setExpanded((x) => { const next = new Set(x); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const cell = (row: Doc, c: (typeof n.columns)[number], i: number) => (c.when && !rowWhenHolds(c.when, row, ctx.view.userId) ? null : barred(row, c, around(row, c, toned(row, c, c.avatars ? (c.link || (i === 0 && n.rowLink)
    // A linked avatars cell (the row's link, or the column's) shows its text as the link beside the initials.
    ? <span className="inline-flex items-center gap-2"><Avatars ids={membersAt(row, c.avatars)} ctx={ctx} />{cellBody(row, c, i)}</span>
    : <Avatars ids={membersAt(row, c.avatars)} ctx={ctx} />)
    : c.popover ? <ItemsPopover c={c} row={row} scope={rowScope(ctx, n.from, row)} text={cellBody(row, c, i)} />
    : c.expand ? <ExpandToggle open={expanded.has(`${i}|${row.key}`)} onClick={() => flip(`${i}|${row.key}`)} text={cellBody(row, c, i)} label={c.expand.label ? renderText(c.expand.label, rowScope(ctx, n.from, row)) : "Details"} />
    : cellBody(row, c, i)))));
  /** A column's `bar`: a 3px bar under the cell, as full as its fraction, in its tone (Canon's primary by default). */
  const barred = (row: Doc, c: (typeof n.columns)[number], body: ReactNode): ReactNode => {
    if (!c.bar) return body;
    const v = valueAt(row, c.bar.value);
    if (typeof v !== "number" || !Number.isFinite(v)) return body;
    const hit = c.bar.tone?.cases.find((k) => toneCaseHolds(k, valueAt(row, c.bar!.tone!.by)));
    return (
      <span className="inline-flex min-w-16 flex-col gap-1">
        {body}
        <span aria-hidden className="block h-[3px] w-full bg-muted"><span data-tone={hit?.tone} className={cn("block h-full", BAR_TONES[hit?.tone ?? "success"])} style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} /></span>
      </span>
    );
  };
  /** A cell's hover text (`tooltip`) and its copy button (`copy`), each over the row. */
  const around = (row: Doc, c: (typeof n.columns)[number], body: ReactNode): ReactNode => {
    if (!c.tooltip && !c.copy) return body;
    const scope = rowScope(ctx, n.from, row);
    const tip = c.tooltip ? renderText(c.tooltip, scope) : "";
    const copy = c.copy ? renderText(c.copy, scope) : "";
    return (
      <span className="group/cell inline-flex items-center gap-1">
        {tip ? <span title={tip} className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2">{body}</span> : body}
        {copy && <CopyButton text={copy} />}
      </span>
    );
  };
  const cellBody = (row: Doc, c: (typeof n.columns)[number], i: number) => {
    if (c.edit && ctx.editor.allowed(c.edit)) return <ModuleInlineInput edit={c.edit} row={row} access={ctx.editor} label={renderText(c.label, ctx.text)} />;
    if (c.definition) {
      if (ctx.view.module.id === "@canon/icps") return <IcpViewer className="min-w-[280px] max-w-lg" query={String(valueAt(row, c.definition.query.field) ?? "")} kind={row.data.kind === "Persona" ? "persona" : row.data.kind === "Segment" ? "segment" : "icp"}
        showQuery={ctx.view.role === "admin"} queryEditor={<ModuleInlineInput edit={c.definition.query} row={row} access={ctx.editor} label={`${String(row.data.name ?? row.key)} query`} />} />;
      if (ctx.query[c.definition.param] !== "query") { const text = String(valueAt(row, c.definition.sentence) ?? ""); return <span className="line-clamp-2" title={text}>{text}</span>; }
      return <ModuleInlineInput edit={c.definition.query} row={row} access={ctx.editor} label={`${String(row.data.name ?? row.key)} query`} />;
    }
    const value = columnText(c, row, ctx.view.userId);
    const file = fileIn(value, ctx, n.from, row);
    if (file) return file;
    // A column's `empty`: what the cell says when its text comes out empty ("Ongoing").
    const text = renderText(value, rowScope(ctx, n.from, row)) || (c.empty ? renderText(c.empty, rowScope(ctx, n.from, row)) : "");
    if (i === 0 && n.focus) return <><button type="button" className="text-left font-medium hover:underline print:hidden" aria-pressed={focused === row.key} onClick={() => focusRow(row.key)}>{text || row.key}</button><span className="hidden print:inline">{text || row.key}</span></>;
    if (typeof c.link === "object" && "canon" in c.link) {
      const to = withQuery(canonHref(c.link.canon, canonRecordOf(c.link.canon, row, c.link.ref)), c.link.query, rowScope(ctx, n.from, row));
      return to ? <Link className="hover:underline" href={to}>{text}</Link> : text;
    }
    if (typeof c.link === "object" && "path" in c.link) {
      const to = canonPath(valueAt(row, c.link.path));
      return to ? <Link className="hover:underline" href={to}>{text}</Link> : text;
    }
    if (typeof c.link === "object" && "url" in c.link) {
      const url = webUrl(valueAt(row, c.link.url));
      return url ? <a className="inline-flex items-center gap-1 hover:underline" href={url.href} target="_blank" rel="noopener noreferrer">{text || url.host}<ExternalLink className="size-3" aria-hidden /></a> : text;
    }
    if (typeof c.link === "object") {
      const rec = valueAt(row, `${c.link.record}.recordId`);
      return typeof rec === "string" ? <Link className="hover:underline" href={`/dashboard/records/deal/${encodeURIComponent(rec)}`}>{text}</Link> : text;
    }
    if (typeof c.link === "string") {
      // A link whose row has no value for one of its params (a deal with no planned visit) isn't a link.
      const values = linkValues(ctx, row);
      if ([...c.link.matchAll(/:([a-zA-Z][a-zA-Z0-9]*)/g)].some((x) => !values[x[1]])) return text;
      return <Link className="hover:underline" href={`${ctx.base}/${fillPath(c.link, values)}`}>{text || row.key}</Link>;
    }
    if (i === 0 && n.rowLink) return <Link className="font-medium hover:underline" href={`${ctx.base}/${fillPath(n.rowLink, linkValues(ctx, row))}`}>{text || row.key}</Link>;
    return text;
  };
  /** A column's tone on a row: the first case its row value meets, as a badge or the text's color. */
  const toned = (row: Doc, c: (typeof n.columns)[number], body: ReactNode): ReactNode => {
    if (!c.tone) return body;
    const v = valueAt(row, c.tone.by);
    const hit = c.tone.cases.find((k) => toneCaseHolds(k, v));
    if (!hit) return body;
    return c.tone.badge ? <span data-tone={hit.tone} className={cn("inline-flex items-center border px-1.5 py-0.5 text-xs font-medium", BADGE_TONES[hit.tone])}>{body}</span> : <span data-tone={hit.tone} className={TEXT_TONES[hit.tone]}>{body}</span>;
  };
  /** The calls that ran on a row and drew their value: under it, across the table, with Clear. */
  const rowResults = (row: Doc) => [...new Set(actions.flatMap((a) => ("call" in a && ctx.results[resultKey(a.call, row)] !== undefined ? [a.call] : [])))];
  const width = n.columns.length + (actions.length > 0 ? 1 : 0) + (selecting ? 1 : 0);
  if (loadedCall && loaded?.value === undefined && !given) return <p className="text-sm text-muted-foreground">{loaded?.error ? NOT_LOADED : "Loading…"}</p>;
  const openRows = sections.reduce((k, sec) => k + (!group || !complete || !isClosed(sec.key) ? sec.rows.length : 0), 0);
  // The rows each open section shows: up to `showing` across the table, or with `group.pageSize`, up to each group's own.
  const perGroup = group && complete && group === n.group ? n.group?.pageSize : undefined;
  const sectionLimit = (key: string) => sectionShown[key] ?? perGroup ?? 0;
  const visibleOf = new Map<string, Doc[]>();
  if (perGroup) for (const sec of sections) visibleOf.set(sec.key, isClosed(sec.key) ? [] : sec.rows.slice(0, sectionLimit(sec.key)));
  else sections.reduce((left, sec) => { const v = !group || !complete || !isClosed(sec.key) ? sec.rows.slice(0, Math.max(0, left)) : []; visibleOf.set(sec.key, v); return left - v.length; }, showing);
  const hiddenOf = (sec: { key: string; rows: Doc[] }) => sec.rows.length - (visibleOf.get(sec.key)?.length ?? 0);
  const moreInGroups = perGroup ? sections.some((sec) => !isClosed(sec.key) && hiddenOf(sec) > 0) : false;
  const showMoreIn = (keys: string[]) => setSectionShown((was) => ({ ...was, ...Object.fromEntries(keys.map((k) => [k, (was[k] ?? perGroup!) + perGroup!])) }));
  const visibleRows = [...visibleOf.values()].flat();
  const pickedRows = rows.filter((r) => picked.has(r.key));
  return (
    <div className="space-y-2">
      {n.columns.filter((c) => c.definition && ctx.view.module.id !== "@canon/icps").map((c, i) => <div key={i} role="group" aria-label="Definition view" className="flex gap-1 print:hidden">{["sentence", "query"].map((mode) => <button key={mode} type="button" aria-pressed={(ctx.query[c.definition!.param] === "query" ? "query" : "sentence") === mode} onClick={() => ctx.setQuery({ [c.definition!.param]: mode })} className={cn(btn, (ctx.query[c.definition!.param] === "query" ? "query" : "sentence") === mode && "bg-muted")}>{mode === "query" ? "Query" : "Sentence"}</button>)}</div>)}
      {selecting && pickedRows.length > 0 && <PickedBar n={n} ctx={ctx} rows={pickedRows} callRows={callRows} clear={() => setPicked(new Set())} />}
      {tools && complete && (
        <div className="flex flex-wrap items-center gap-2">
          {!!n.search?.length && (
            <label className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
              <input type="search" aria-label="Search" placeholder="Search" value={state.q} onChange={(e) => setState({ ...state, q: e.target.value })}
                className="h-7 w-52 border border-border bg-background pr-2 pl-7 text-xs" />
            </label>
          )}
          {(n.filters ?? []).map((f) => (shown.kinds?.[f.field] === "date"
            ? <DateFilter key={f.field} label={renderText(f.label, ctx.text)} value={state.filters[f.field]?.[0] ?? ""} onChange={(v) => setState({ ...state, filters: { ...state.filters, [f.field]: v ? [v] : [] } })} />
            : <MultiSelect key={f.field} label={renderText(f.label, ctx.text)} emptyLabel={`${renderText(f.label, ctx.text)}: any`} options={filterOptions(f)} value={state.filters[f.field] ?? []}
                onChange={(v) => setState({ ...state, filters: { ...state.filters, [f.field]: v } })} />))}
          {(state.q || Object.values(state.filters).some((v) => v.length)) && (
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setState({ ...state, q: "", filters: {} })}>Clear</button>
          )}
          {!!n.groupBy?.length && (
            <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">Group by
              <select aria-label="Group by" className="h-7 border border-border bg-background px-1 text-xs text-foreground" value={extra.groupBy || (n.group ? "" : "none")} onChange={(e) => setExtra({ groupBy: e.target.value })}>
                {n.group ? <option value="">{n.groupBy.find((g) => g.by === n.group!.by) ? renderText(n.groupBy.find((g) => g.by === n.group!.by)!.label, ctx.text) : "Default"}</option> : null}
                <option value="none">No grouping</option>
                {n.groupBy.filter((g) => g.by !== n.group?.by).map((g) => <option key={g.by} value={g.by}>{renderText(g.label, ctx.text)}</option>)}
              </select>
            </label>
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{n.summary ? `${matched} shown · ${chipped.filter(needs).length} need attention · ${rows.length} total` : matched === rows.length ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}` : `${matched} of ${rows.length}`}</span>
          {!!n.chips?.length && (
            <span role="group" aria-label="Show" className="flex basis-full flex-wrap gap-1">
              {[{ label: "All", when: null as TableChipWhen | null, id: "" }, ...n.chips.map((c, k) => ({ label: renderText(c.label, ctx.text), when: c.when as TableChipWhen | null, id: String(k + 1) }))].map((c) => (
                <button key={c.id || "all"} type="button" aria-pressed={extra.chip === c.id} onClick={() => setExtra({ chip: c.id })}
                  className={cn("border px-2 py-0.5 text-xs tabular-nums", extra.chip === c.id ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted")}>{c.label} · {chipCount(c.when)}</button>
              ))}
            </span>
          )}
        </div>
      )}
      {!complete && (
        <p role="status" className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-xs">
          <span>{list.limit >= 1000 ? "This list has more than 1,000 rows, the most a page reads. Narrow its view to sort, filter or total it." : `Showing the first ${list.limit} rows. Sorting, filters and totals need them all.`}</span>
          {list.limit < 1000 && <button type="button" className={btn} onClick={() => ctx.more(n.from)}>Show more</button>}
        </p>
      )}
      {list?.countError && <p role="status" className="text-xs text-muted-foreground">{list.countError}</p>}
      {!rows.length ? <p className="border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">{renderText(n.empty ?? "Nothing here yet.", ctx.text)}</p>
        : !matched ? (
          <div className="border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            <p>{n.emptyFiltered ? renderText(n.emptyFiltered, ctx.text) : "No rows match."}</p>
            {(state.q || Object.values(state.filters).some((v) => v.length) || chip) && (
              <button type="button" className={cn(btn, "mt-2")} onClick={() => { setState({ ...state, q: "", filters: {} }); if (chip) setExtra({ chip: "" }); }}>Clear filters</button>
            )}
          </div>
        ) : (<>
      {n.cards && (
        // At a phone's width, each row a card: its first column as the title, the rest as labels and values, then its actions.
        <ul aria-label="Rows" className="space-y-2 sm:hidden">
          {visibleRows.map((row) => (
            <li key={row.key} {...focusEvents(row)} className={cn("space-y-2 border border-border bg-card p-3 text-sm", focused === row.key && "border-primary bg-primary/5")}>
              <div className="flex items-start gap-2 font-medium">{needs(row) && <span aria-label="Needs attention" className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-amber-600" />}{cell(row, n.columns[0], 0)}</div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {/* A card leaves out what says nothing on its row (a tier's header row has no month figures). */}
                {n.columns.slice(1).map((c, i) => (!c.avatars && !c.expand && !c.popover && !c.empty && !renderText(columnText(c, row, ctx.view.userId), rowScope(ctx, n.from, row)) ? null : (
                  <div key={i} className="min-w-0"><dt className="text-[11px] text-muted-foreground">{renderText(c.label, ctx.text)}</dt><dd className="break-words tabular-nums">{cell(row, c, i + 1)}</dd></div>
                )))}
              </dl>
              {n.columns.flatMap((c, i) => (c.expand && expanded.has(`${i}|${row.key}`) ? [<div key={`expand:${i}`} className="border-t border-border pt-2"><RowExpansion expand={c.expand} row={row} ctx={ctx} /></div>] : []))}
              {actions.length > 0 && <div className="flex flex-wrap gap-1 pt-1"><Actions items={actions} ctx={ctx} row={row} /></div>}
            </li>
          ))}
          {totals && complete && <li className="flex flex-wrap gap-x-4 border border-border bg-muted/40 p-3 text-xs font-medium">{n.columns.filter((c) => c.total).map((c, i) => <span key={i}>{renderText(c.label, ctx.text)}: {sumCell(sections.flatMap((x) => x.rows), c)}</span>)}</li>}
        </ul>
      )}
      <div className={cn("overflow-x-auto border border-border bg-card", n.cards && "hidden sm:block")}>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border">{selecting && (
            <th className="w-8 px-3 py-2 print:hidden">
              <input type="checkbox" aria-label="Pick every row shown" checked={visibleRows.length > 0 && visibleRows.every((r) => picked.has(r.key))}
                onChange={(e) => setPicked(e.target.checked ? new Set([...picked, ...visibleRows.map((r) => r.key)]) : new Set([...picked].filter((k) => !visibleRows.some((r) => r.key === k))))} />
            </th>
          )}{n.columns.map((c, i) => {
            const dir = sorted && c.sort && sorted.by === c.sort ? sorted.dir : null;
            return (
              <th key={i} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined} className={cn("px-3 py-2 text-left text-xs font-medium text-muted-foreground", c.align === "end" && "text-right")}>
                <ColumnHeader c={c} ctx={ctx} dir={dir} onSort={c.sort && complete ? () => sortBy(c) : undefined} />
              </th>
            );
          })}{actions.length > 0 && <th />}</tr></thead>
          {sections.map((sec) => {
            const open = !group || !complete || !isClosed(sec.key);
            const visible = visibleOf.get(sec.key) ?? [];
            return (
              <tbody key={sec.key}>
                {group && complete && (
                  <tr className="border-b border-border bg-muted/40">
                    {selecting && <td className="print:hidden" />}
                    {n.columns.map((c, i) => (i === 0 ? (
                      <th key={i} scope="rowgroup" className="px-3 py-1.5 text-left text-xs font-medium">
                        <button type="button" aria-expanded={open} className="inline-flex items-center gap-1" onClick={() => toggle(sec.key)}>
                          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{sec.label}<span className="font-normal text-muted-foreground tabular-nums"> · {sec.rows.length}{c.group !== undefined && sec.rows[0] ? ` · ${renderText(c.group, rowScope(ctx, n.from, sec.rows[0]))}` : ""}</span>
                        </button>
                        {group === n.group && n.group?.link && sec.rows[0] && <Link className="ml-2 font-normal text-muted-foreground underline hover:text-foreground" href={`${ctx.base}/${fillPath(n.group!.link!, linkValues(ctx, sec.rows[0]))}`} aria-label={`Open ${sec.label}`}>Open</Link>}
                      </th>
                    ) : <td key={i} className={cn("px-3 py-1.5 text-xs font-medium", c.align === "end" && "text-right tabular-nums")}>{headCell(sec.rows, c)}</td>))}
                    {actions.length > 0 && <td />}
                  </tr>
                )}
                {visible.map((row, rowIndex) => (
                  <Fragment key={row.key}>
                  <tr {...focusEvents(row)} className={cn("border-b border-border last:border-b-0 hover:bg-muted/40", picked.has(row.key) && "bg-muted/30", focused === row.key && "bg-primary/5 shadow-[inset_2px_0_var(--primary)]", dragKey === row.key && "opacity-50", hierarchy && valueAt(row, hierarchy.muted) === true && "opacity-60", treeDrop === row.key && "outline outline-primary")}
                    {...(hierarchyMove && ctx.editor.allowed(hierarchyMove) ? {
                      onDragOver: (e: React.DragEvent) => { if (dragging.current !== null) { e.preventDefault(); setTreeDrop(treeDropAllowed(row) ? row.key : null); } },
                      onDragLeave: () => setTreeDrop(null), onDrop: (e: React.DragEvent) => { e.preventDefault(); dropTree(row); },
                    } : {})}
                    {...(canDrag ? { onDragOver: (e: React.DragEvent) => { if (dragKey !== null) e.preventDefault(); }, onDrop: (e: React.DragEvent) => { e.preventDefault(); dropOn(row); } } : {})}>
                    {selecting && <td className="w-8 px-3 py-2 print:hidden"><input type="checkbox" aria-label={`Pick ${renderText(n.columns[0]?.value ?? "", rowScope(ctx, n.from, row)) || row.key}`} checked={picked.has(row.key)} onChange={(e) => { const next = new Set(picked); if (e.target.checked) next.add(row.key); else next.delete(row.key); setPicked(next); }} /></td>}
                    {n.columns.map((c, i) => <td key={i} className={cn("px-3 py-2", c.align === "end" && "text-right tabular-nums")}>{i === 0 && canDrag && <span draggable title="Drag to reorder" aria-hidden className="mr-1 inline-flex cursor-grab align-middle text-muted-foreground active:cursor-grabbing" onDragStart={(e) => { setDragKey(row.key); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragKey(null)}><GripVertical className="size-3.5" /></span>}{i === 0 && needs(row) && <span aria-label="Needs attention" title="Needs attention" className="mr-1.5 inline-block size-1.5 rounded-full bg-amber-600 align-middle" />}{i === 0 && hierarchy ? <HierarchyLabel hierarchy={hierarchy} row={row} hasChildren={rows.some((r) => treeParent(r) === row.key) || !!hierarchy.add && ctx.editor.allowed(hierarchy.add) && rowChoices(row, hierarchy.add.choices).length > 0} closed={treeClosed.has(row.key)} toggle={() => setTreeClosed((was) => { const next = new Set(was); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })} draggable={movable(row)} dragStart={(e) => { setDragKey(row.key); e.dataTransfer.effectAllowed = "move"; }} dragEnd={() => { setDragKey(null); setTreeDrop(null); }}>{cell(row, c, i)}</HierarchyLabel> : cell(row, c, i)}</td>)}
                    {actions.length > 0 && <td className="px-3 py-2 text-right"><span className="inline-flex justify-end gap-1"><Actions items={actions} ctx={ctx} row={row} /></span></td>}
                  </tr>
                  {n.columns.flatMap((c, i) => (c.expand && expanded.has(`${i}|${row.key}`) ? [
                    <tr key={`expand:${i}`} className="border-b border-border bg-muted/20"><td colSpan={width} className="px-3 py-3">
                      <RowExpansion expand={c.expand} row={row} ctx={ctx} />
                    </td></tr>,
                  ] : []))}
                  {rowResults(row).map((c) => (
                    <tr key={`result:${c}`} className="border-b border-border bg-muted/20"><td colSpan={width} className="px-3 pb-3">
                      <CallResultView call={c} value={ctx.results[resultKey(c, row)]} ctx={ctx} at={resultKey(c, row)} />
                    </td></tr>
                  ))}
                  {hierarchy?.add && closingBranches(row, visible[rowIndex + 1]).filter((branch) => !treeClosed.has(branch.key) && ctx.editor.allowed(hierarchy.add!) && rowChoices(branch, hierarchy.add!.choices).length > 0).map((branch) => <tr key={`add:${branch.key}`} className="border-b border-dashed border-border print:hidden"><td colSpan={width} className="px-3 py-1"><HierarchyAdd h={hierarchy} row={branch} access={ctx.editor} select={focusRow} /></td></tr>)}
                  </Fragment>
                ))}
                {perGroup && open && hiddenOf(sec) > 0 && (
                  <tr className="border-b border-border"><td colSpan={width} className="px-3 py-1.5 text-xs">
                    <button type="button" className="font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={() => showMoreIn([sec.key])}>Show {Math.min(perGroup, hiddenOf(sec))} more of {hiddenOf(sec)} in {sec.label}</button>
                  </td></tr>
                )}
              </tbody>
            );
          })}
          {totals && complete && (
            <tfoot><tr className="border-t border-border">
              {selecting && <td className="print:hidden" />}
              {n.columns.map((c, i) => <td key={i} className={cn("px-3 py-2 text-xs font-medium", c.align === "end" && "text-right tabular-nums")}>{i === 0 ? "Total" : sumCell(sections.flatMap((x) => x.rows), c)}</td>)}
              {actions.length > 0 && <td />}
            </tr></tfoot>
          )}
        </table>
      </div>
      {/* Under the table and the phone's cards alike. */}
      {/* Grouped with a per-group page, a phone's cards have no group rows: there every group shows more at once. */}
      {moreInGroups && <div className="border border-border bg-card px-3 py-2 text-center sm:hidden"><button type="button" className={btn} onClick={() => showMoreIn(sections.filter((sec) => hiddenOf(sec) > 0).map((sec) => sec.key))}>Show {perGroup} more in each group</button></div>}
      {!perGroup && openRows > showing && <div className="border border-border bg-card px-3 py-2 text-center"><button type="button" className={btn} onClick={() => setShowing((k) => k + (n.pageSize ?? 50))}>Show {Math.min(n.pageSize ?? 50, openRows - showing)} more of {openRows - showing}</button></div>}
      {n.totalBar && totals && complete && (
        // Stays at the foot of the window while the table shows: the label and each total column's sum over the rows shown.
        <div role="status" aria-label={renderText(n.totalBar.label, ctx.text)} className="sticky bottom-0 z-10 flex flex-wrap items-baseline gap-x-6 gap-y-1 border border-border bg-card/95 px-4 py-2 text-sm shadow-sm backdrop-blur print:static">
          <span className="font-medium">{renderText(n.totalBar.label, ctx.text)}</span>
          {n.columns.filter((c) => c.total).map((c, i) => <span key={i} className="text-xs text-muted-foreground">{renderText(c.label, ctx.text)} <span className="font-display text-base font-semibold text-foreground tabular-nums">{sumCell(sections.flatMap((x) => x.rows), c)}</span></span>)}
        </div>
      )}
      </>)}
    </div>
  );
}

/** Whether a tone case holds on a value: among `in` (as text), at least `gte`, at most `lte`, or always. */
const toneCaseHolds = (k: ColumnTone["cases"][number], v: unknown) => ("in" in k ? k.in.some((x) => String(x ?? "") === String(v ?? "")) : "gte" in k ? typeof v === "number" && v >= k.gte : "lte" in k ? typeof v === "number" && v <= k.lte : true);
const BAR_TONES: Record<ToneName, string> = { info: "bg-muted-foreground", success: "bg-primary", warn: "bg-amber-600", danger: "bg-destructive", neutral: "bg-foreground/40", ai: "bg-provenance" };

/** A cell whose text opens a list of the row's items (`popover`): "Applied to 2 of 4 reps", then the reps. */
function ItemsPopover({ c, row, scope, text }: { c: Column; row: Doc; scope: TextScope; text: ReactNode }) {
  const [open, setOpen] = useState(false);
  const p = c.popover!;
  const raw = valueAt(row, p.items);
  const items = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map((x) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>) : { value: x }));
  const title = p.title ? renderText(p.title, scope) : "";
  return (
    <span className="relative inline-flex" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false); }}>
      <button type="button" aria-expanded={open} aria-haspopup="dialog" className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => setOpen((o) => !o)}>{text}</button>
      {open && (
        <span role="dialog" aria-label={title || undefined} className="absolute top-full left-0 z-20 mt-1 min-w-48 border border-border bg-popover py-1 text-xs shadow-sm">
          {title && <span className="block px-3 py-1 font-medium text-muted-foreground">{title}</span>}
          {items.length ? <ul>{items.map((x, i) => <li key={i} className="px-3 py-1">{renderText(p.label, { ...scope, binds: { ...scope.binds, item: { key: String(i), version: 0, owner: null, data: x } } }) || "—"}</li>)}</ul>
            : <span className="block px-3 py-1 text-muted-foreground">None</span>}
        </span>
      )}
    </span>
  );
}

/** A cell that opens its row's `expand` under it: its text, else the label, with a chevron. */
function ExpandToggle({ open, onClick, text, label }: { open: boolean; onClick: () => void; text: ReactNode; label: string }) {
  return (
    <button type="button" aria-expanded={open} className="inline-flex items-center gap-1 text-left hover:underline" onClick={onClick}>
      {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}{text || label}
    </button>
  );
}

/**
 * A row's `expand` (docs/modules.md, "Tables, queues and status"): its views read for that row (`{ row }` arguments),
 * live, as the caller reads them, then its components drawn as the page's are, with `{$row...}` the expanded row.
 */
function RowExpansion({ expand, row, ctx }: { expand: NonNullable<Column["expand"]>; row: Doc; ctx: Ctx }) {
  const binds = Object.entries(expand.bind ?? {});
  return <ExpansionReads binds={binds} at={0} got={{}} row={row} ctx={ctx} body={expand.body} />;
}
/** Reads an expansion's views one hook each (their number is fixed by the manifest), then draws its body. */
function ExpansionReads({ binds, at, got, row, ctx, body }: { binds: Array<[string, { view: string; args?: Record<string, FormExpr> }]>; at: number; got: Record<string, unknown>; row: Doc; ctx: Ctx; body: readonly Node[] }) {
  const b = binds[at];
  const args = b ? Object.fromEntries(Object.entries(b[1].args ?? {}).flatMap(([k, x]) => { const v = ctx.formValue(x, row); return v === undefined || v === null ? [] : [[k, v as string]]; })) : {};
  const read = useQuery(api.modules.view, b ? { module: ctx.view.module.slug, view: b[1].view, args } : "skip");
  if (b) {
    if (read === undefined) return <LoadingRows count={2} />;
    return <ExpansionReads binds={binds} at={at + 1} got={{ ...got, [b[0]]: read }} row={row} ctx={ctx} body={body} />;
  }
  const lists = Object.fromEntries(Object.entries(got).flatMap(([k, v]) => (Array.isArray(v) ? [[k, { complete: true, limit: v.length, countError: null }]] : [])));
  const inner: Ctx = {
    ...ctx,
    view: { ...ctx.view, data: { ...ctx.view.data, ...got }, lists: { ...(ctx.view.lists as object), ...lists } } as Ready,
    text: { ...ctx.text, row, binds: { ...ctx.text.binds, ...got } },
  };
  return <div className="space-y-3"><Nodes nodes={body as Node[]} ctx={inner} /></div>;
}

/** The rows an `each` column repeats over: a list binding's docs, or a loaded call's value (or its field). */
const eachRows = (ctx: Ctx, from: string, field?: string): Doc[] =>
  Object.hasOwn(ctx.view.loads as object, from) ? rowsOfValue(ctx.loaded[from]?.value, field) : ((ctx.view.data[from] as Doc[] | undefined) ?? []);

/** A column's header: its label (a text over the page), a link its `headerLink` opens, and the sort a click runs. */
function ColumnHeader({ c, ctx, dir, onSort }: { c: Column; ctx: Ctx; dir: "asc" | "desc" | null; onSort?: () => void }) {
  const label = renderText(c.label, ctx.text);
  // A header link whose values come out empty (a month with no period) isn't a link: its label stays.
  const empties = c.headerLink ? [...c.headerLink.matchAll(/\{\$[^}]+\}/g)].some((m) => renderText(m[0], ctx.text) === "") : false;
  const href = c.headerLink && !empties ? `${ctx.base}/${fillPath(renderText(c.headerLink, ctx.text), ctx.view.params as Record<string, string>)}` : null;
  const arrow = dir && <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>;
  if (href) {
    return (
      <span className="inline-flex items-center gap-1">
        <Link className="underline decoration-dotted underline-offset-2 hover:text-foreground" href={href}>{label}</Link>
        {onSort && <button type="button" className="hover:text-foreground" aria-label={`Sort by ${label}`} onClick={onSort}>{arrow ?? <span aria-hidden>↕</span>}</button>}
      </span>
    );
  }
  return onSort ? <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={onSort}>{label}{arrow}</button> : <>{label}</>;
}

/**
 * The rows a table's `select` picked, and its actions over them: each row's run on its own, through the same checks as
 * its button (the doc's state and guards, the version the page read), one after another. A row the action isn't
 * offered on, or whose guard refuses it now, is skipped and counted; one the server refuses is named with why.
 */
function PickedBar({ n, ctx, rows, callRows, clear }: { n: TableLike; ctx: Ctx; rows: Doc[]; callRows: boolean; clear: () => void }) {
  const move = useMutation(api.modules.transition);
  const op = useModuleOp();
  const runCall = useAction(api.modules.call);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ a: ActionRef; fields: FieldInfo[]; description: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [editing, setEditing] = useState(false);
  const items = n.select?.actions ?? [];
  const edit = n.select?.edit;
  const docOf = (a: ActionRef, row: Doc): Doc | null => {
    if (!judgedOn(a, row)) return row;
    const key = rowDocKey(a, ctx, row), j = ctx.judged?.[judgeId(a, ctx, row)];
    return key && j?.version !== null && j?.version !== undefined ? { key, version: j.version, owner: null, data: {} } : null;
  };
  async function runAll(a: ActionRef, args: Record<string, unknown>) {
    const label = actionLabel(a, ctx);
    setBusy(label);
    let done = 0, skipped = 0;
    const refused: string[] = [];
    for (const row of rows) {
      if (!offered(a, ctx, row) || blockedReason(a, ctx, row) !== null) { skipped++; continue; }
      const doc = docOf(a, row);
      try {
        if ("transition" in a && doc) {
          const fixed = Object.fromEntries(Object.entries(a.fixed ?? {}).flatMap(([k, x]) => { const v = ctx.formValue(x, row); return v === undefined || v === null ? [] : [[k, v]]; }));
          await move({ module: ctx.view.module.slug, machine: a.machine, name: a.transition, key: doc.key, expect: doc.version, args: { ...fixed, ...args } });
        } else if ("op" in a && doc) await op({ module: ctx.view.module.slug, op: a.op, key: doc.key, expect: doc.version });
        else if ("call" in a) {
          const fixed = Object.fromEntries(Object.entries(a.args ?? {}).flatMap(([k, x]) => { const v = ctx.formValue(x, row); return v === undefined || v === null ? [] : [[k, v]]; }));
          await runCall({ module: ctx.view.module.slug, call: a.call, args: { ...fixed, ...args } });
        } else { skipped++; continue; }
        done++;
      } catch (e) { refused.push(`${renderText(n.columns[0]?.value ?? "", rowScope(ctx, n.from, row)) || row.key}: ${getErrorMessage(e)}`); }
    }
    setBusy(null);
    ctx.reloadAll();
    const parts = [`${done} done`, skipped && `${skipped} skipped (not open to it now)`, refused.length && `${refused.length} refused`].filter(Boolean).join(", ");
    if (refused.length) toast.error(`${label}: ${parts}. ${refused.slice(0, 3).join("; ")}`); else toast.success(`${label}: ${parts}`);
    if (!refused.length) clear();
  }
  function start(a: ActionRef) {
    // A transition that takes arguments or asks first asks once, for every picked row; one that records evidence is each person's own.
    if ("transition" in a) {
      const info = ctx.view.machines[a.machine]?.transitions[a.transition];
      if (!info) return;
      if (info.evidence?.length) return toast.error(`${info.label} records where each is signed: run it on each row.`);
      const fields = info.fields.filter((f) => !Object.hasOwn(a.fixed ?? {}, f.field));
      if (fields.length || info.confirm) return setAsking({ a, fields, description: `${info.confirm ? `${info.confirm} ` : ""}For ${rows.length} ${rows.length === 1 ? "row" : "rows"}.` });
    }
    if ("call" in a) {
      const info = ctx.view.calls[a.call];
      const fields = (info?.fields ?? []).filter((f) => !Object.hasOwn(a.args ?? {}, f.field));
      if (fields.length || a.confirm || info?.confirm) return setAsking({ a, fields, description: `${a.confirm ?? info?.confirm ? `${a.confirm ?? info?.confirm} ` : ""}For ${rows.length} ${rows.length === 1 ? "row" : "rows"}.` });
    }
    if ("op" in a) {
      const label = actionLabel(a, ctx);
      return setConfirming({ title: `${label}: ${rows.length} ${rows.length === 1 ? "row" : "rows"}?`, description: "Each row is checked again on its own.", confirmLabel: label, destructive: ctx.view.ops[a.op]?.kind === "delete", run: () => runAll(a, {}) });
    }
    void runAll(a, {});
  }
  return (
    <div role="region" aria-label="Picked rows" className="flex flex-wrap items-center gap-2 border-l-2 border-foreground bg-muted/40 px-3 py-2 text-xs print:hidden">
      <span className="font-medium tabular-nums">{rows.length} picked</span>
      {items.map((a, i) => <button key={i} type="button" className={btn} disabled={busy !== null || (ctx.view.preview !== null && writes(a, ctx))} title={ctx.view.preview !== null && writes(a, ctx) ? ctx.view.preview : undefined} onClick={() => start(a)}>{busy === actionLabel(a, ctx) ? `${actionLabel(a, ctx)}…` : actionLabel(a, ctx)}</button>)}
      {edit && ctx.view.ops[edit.op]?.allowed && <button type="button" className={btn} disabled={ctx.view.preview !== null} onClick={() => setEditing(true)}>{edit.label ? renderText(edit.label, ctx.text) : "Edit"} ({rows.length})</button>}
      <button type="button" className="ml-auto text-muted-foreground underline" onClick={clear}>Clear</button>
      {editing && edit && (callRows
        ? <EditCallRows n={n} ctx={ctx} edit={edit} rows={rows} onClose={() => setEditing(false)} onDone={() => { setEditing(false); clear(); }} />
        : <EditRowsDialog n={n} ctx={ctx} edit={edit} rows={rows} onClose={() => setEditing(false)} onDone={() => { setEditing(false); clear(); }} />)}
      {confirming && <ConfirmDialog title={confirming.title} description={confirming.description} confirmLabel={confirming.confirmLabel} destructive={confirming.destructive} onConfirm={confirming.run} onClose={() => setConfirming(null)} />}
      {asking && <ArgsDialog title={wordsOf(asking.a, ctx).title ?? actionLabel(asking.a, ctx)} description={wordsOf(asking.a, ctx).description ?? asking.description} submit={wordsOf(asking.a, ctx).submit ?? actionLabel(asking.a, ctx)} fields={asking.fields} onClose={() => setAsking(null)} onSubmit={async (args) => { setAsking(null); await runAll(asking.a, args); }} />}
    </div>
  );
}

/**
 * `select.edit` over a call's rows: each row names its doc by `edit.key` (its key by default), which the dialog edits
 * as the caller reads it now, at that doc's version; a row whose doc is gone or not the caller's to edit is left out.
 */
function EditCallRows({ n, ctx, edit, rows, onClose, onDone }: { n: TableLike; ctx: Ctx; edit: NonNullable<NonNullable<TableKeys["select"]>["edit"]>; rows: Doc[]; onClose: () => void; onDone: () => void }) {
  const keyOf = (row: Doc) => { const k = edit.key ? valueAt(row, edit.key) : row.key; return typeof k === "string" && k ? k : null; };
  const checks = rows.flatMap((row, i) => { const key = keyOf(row); return key ? [{ id: String(i), op: { name: edit.op, key } }] : []; });
  const judged = useQuery(api.modules.judge, { module: ctx.view.module.slug, checks });
  // Each doc under its call row's fields (so the row's texts, its name, read as in the table), read once: the dialog
  // edits from these values and saves expecting these versions, so a change meanwhile is refused, never overwritten.
  const [docs, setDocs] = useState<Doc[] | null>(null);
  useEffect(() => {
    if (!judged || docs !== null) return;
    const read = rows.flatMap((row, i): Doc[] => { const j = judged[String(i)], key = keyOf(row); return key && j && !j.missing && j.version !== null && j.data ? [{ ...row, key, version: j.version, data: { ...row.data, ...j.data } }] : []; });
    if (!read.length) { toast.error("None of the rows picked names a doc you can edit."); onClose(); }
    setDocs(read); // eslint-disable-line react-hooks/set-state-in-effect -- the first answer is the snapshot the dialog edits
  }, [judged]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!docs?.length) return null;
  return <EditRowsDialog n={n} ctx={ctx} edit={edit} rows={docs} onClose={onClose} onDone={onDone} />;
}

/**
 * Several docs edited in one table (`select.edit`): a row per picked doc, a column per field, each cell its field's
 * editor starting from the doc, its placeholder a text over the row ("Plan default: $120,000"). Save runs the update on
 * each row that changed, one at a time, each expecting the version the page read; one the server refuses is named.
 */
function EditRowsDialog({ n, ctx, edit, rows, onClose, onDone }: { n: TableLike; ctx: Ctx; edit: NonNullable<NonNullable<TableKeys["select"]>["edit"]>; rows: Doc[]; onClose: () => void; onDone: () => void }) {
  const op = useModuleOp();
  const info = ctx.view.ops[edit.op];
  const colsFor = (row: Doc) => edit.fields.flatMap((f) => { const at = info.fields.find((x) => x.field === f.field); const shown = at && asForm(pageField({ ...at, ...(f.widget ? { widget: f.widget } : {}) }, f, ctx, row), f.label, info.collection); return shown ? [shown] : []; });
  const [start] = useState(() => Object.fromEntries(rows.map((r) => [r.key, draftsFor(colsFor(r), r.data)])));
  const [values, setValues] = useState<Record<string, Record<string, Draft>>>(start);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const changed = rows.filter((r) => JSON.stringify(values[r.key]) !== JSON.stringify(start[r.key]));
  const guard = useDiscardGuard(changed.length > 0, busy, onClose);
  async function save() {
    setBusy(true); setRefused(null);
    const failed: string[] = [];
    let done = 0;
    for (const r of changed) {
      const cols = colsFor(r);
      const { data, unset } = fromForm(cols, values[r.key], {}, r.data);
      const missing = unfilled(cols, data);
      const name = renderText(n.columns[0]?.value ?? "", rowScope(ctx, n.from, r)) || r.key;
      if (missing) { failed.push(`${name}: ${missing}`); continue; }
      try { await op({ module: ctx.view.module.slug, op: edit.op, key: r.key, expect: r.version, data, ...(unset.length ? { unset } : {}) }); done++; }
      catch (e) { failed.push(`${name}: ${getErrorMessage(e)}`); }
    }
    setBusy(false);
    ctx.reloadAll();
    if (failed.length) { setRefused(`${done} saved. ${failed.join(" ")}`); return; }
    toast.success(`${info.label}: ${done} ${done === 1 ? "row" : "rows"} saved`);
    onDone();
  }
  const heads = colsFor(rows[0]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) guard.close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-none sm:max-w-5xl">
        <DialogTitle className="text-base">{edit.label ? renderText(edit.label, ctx.text) : info.label} ({rows.length})</DialogTitle>
        <DialogDescription className="text-xs">Each row saves on its own, checked as editing it alone would be. {changed.length} changed.</DialogDescription>
        <div className="overflow-x-auto border border-border">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border">{[renderText(n.columns[0]?.label ?? "", ctx.text), ...heads.map((h) => h.label)].map((h, i) => <th key={i} className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const cols = colsFor(r);
                return (
                  <tr key={r.key} className="border-b border-border align-top last:border-b-0">
                    <td className="px-2 py-1.5 font-medium">{renderText(n.columns[0]?.value ?? "", rowScope(ctx, n.from, r)) || r.key}</td>
                    {cols.map((c) => (
                      <td key={c.field} className="min-w-36 px-2 py-1.5">
                        <FieldsEditor fields={[{ ...c, label: "" }]} values={values[r.key] ?? {}} context={r.data} idPrefix={`edit-${r.key}`} onChange={(field, d) => setValues((v) => ({ ...v, [r.key]: setField(cols, v[r.key] ?? {}, field, d) }))} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Refused text={refused} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={guard.close} disabled={busy}>Cancel</button>
          <button type="button" className={primary} disabled={busy || !changed.length} onClick={() => void save()}>{busy ? "Saving…" : `Save ${changed.length} ${changed.length === 1 ? "row" : "rows"}`}</button>
        </div>
        {guard.asking}
      </DialogContent>
    </Dialog>
  );
}

/** The members a row value names: a member field, a list of them, or a list of rows' member field (`attendees.person`). */
function membersAt(row: Doc, path: string): unknown {
  const [first, inner] = path.split(".");
  const v = row.data[first];
  if (inner !== undefined && Array.isArray(v)) return v.map((x) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[inner] : undefined));
  return valueAt(row, path);
}

/** Copy a text to the clipboard, beside a cell (a rep's email), shown on the row's hover and on focus. */
function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" aria-label={`Copy ${text}`} title={`Copy ${text}`}
      className="inline-flex size-5 items-center justify-center text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/cell:opacity-100 print:hidden"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${text}`), () => toast.error("Your browser didn't let Canon copy that.")); }}>
      <Copy className="size-3" />
    </button>
  );
}

/** Members as their initials, overlapping, up to four and "+N"; every name on hover and in a list a click opens. */
function Avatars({ ids, ctx }: { ids: unknown; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const names = [ids].flat().filter((x): x is string => typeof x === "string" && x !== "").map((id) => ctx.text.members.get(id) ?? "A former member");
  if (!names.length) return <span className="text-muted-foreground">None</span>;
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span className="relative inline-flex" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false); }}>
      <button type="button" aria-label={`${names.length} ${names.length === 1 ? "member" : "members"}: ${names.join(", ")}`} title={names.join(", ")} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center -space-x-1.5">
        {names.slice(0, 4).map((name, i) => <span key={i} aria-hidden className="flex size-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-medium text-foreground">{initials(name)}</span>)}
        {names.length > 4 && <span aria-hidden className="flex size-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] text-muted-foreground">+{names.length - 4}</span>}
      </button>
      {open && (
        <ul role="list" className="absolute top-full left-0 z-20 mt-1 min-w-40 border border-border bg-popover py-1 text-xs shadow-sm">
          {names.map((name, i) => <li key={i} className="px-3 py-1">{name}</li>)}
        </ul>
      )}
    </span>
  );
}

/** A date filter: a range, kept as `from..to`. */
function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [from = "", to = ""] = value.split("..");
  const set = (f: string, t: string) => onChange(f || t ? `${f}..${t}` : "");
  return (
    <span role="group" aria-label={label} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <span className="w-28"><DateInput value={from} onChange={(v) => set(v, to)} placeholder="From" /></span>
      <span className="w-28"><DateInput value={to} onChange={(v) => set(from, v)} placeholder="To" /></span>
    </span>
  );
}

/**
 * Several lists as one (docs/modules.md, "Queues"): each source's rows as a kind, a title, a line under it, a date, a
 * link and its actions, newest first.
 */
function Queue({ n, ctx }: { n: Of<"queue">; ctx: Ctx }) {
  const [q, setQ] = useState("");
  // A queue's filter: every row, one source's, or the rows that need the person (a source's `attention`).
  const [only, setOnly] = useState<string>("");
  const items = n.sources.flatMap((src, k) => ((ctx.view.data[src.from] as Doc[] | undefined) ?? []).map((row) => {
    const scope = rowScope(ctx, src.from, row);
    const date = src.date ? valueAt(row, src.date) : undefined;
    return { src, k, row, title: renderText(src.title, scope), subtitle: src.subtitle ? renderText(src.subtitle, scope) : "", date: typeof date === "number" || typeof date === "string" ? date : null };
  }));
  const short = n.sources.filter((src) => (ctx.view.lists as Record<string, { complete: boolean }>)[src.from]?.complete === false);
  const needle = q.trim().toLowerCase();
  const needs = (x: (typeof items)[number]) => !!x.src.attention && rowWhenHolds(x.src.attention, x.row, ctx.view.userId);
  const attention = items.filter(needs).length;
  const shown = items.filter((x) => (!only || (only === "@attention" ? needs(x) : x.src.label === only)) && (!needle || `${x.title} ${x.subtitle} ${x.src.label}`.toLowerCase().includes(needle)))
    .sort((a, b) => (a.date === null || b.date === null ? (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) : String(b.date).localeCompare(String(a.date), undefined, { numeric: true })));
  const when = (d: string | number | null) => (d === null ? "" : typeof d === "number" ? new Date(d).toLocaleDateString() : formatValue(d, "date", ctx.text));
  const labels = [...new Set(n.sources.map((x) => x.label))];
  const chip = (value: string, label: string, count: number) => (
    <button key={value || "all"} type="button" aria-pressed={only === value} onClick={() => setOnly(value)}
      className={cn("border px-2 py-0.5 text-xs tabular-nums", only === value ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted")}>{label} · {count}</button>
  );
  // Sections by source, each with its count, when the queue groups; else one list, newest first.
  const groups = n.group ? labels.map((l) => ({ label: l, rows: shown.filter((x) => x.src.label === l) })).filter((g) => g.rows.length) : [{ label: "", rows: shown }];
  const line = (x: (typeof items)[number]) => (
    <li key={`${x.k}:${x.row.key}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      {!n.group && <span className="w-28 shrink-0 text-xs text-muted-foreground">{x.src.label}</span>}
      {needs(x) && <span aria-label="Needs attention" title="Needs attention" className="size-1.5 shrink-0 rounded-full bg-amber-600" />}
      <span className="min-w-0 flex-1">
        {x.src.link ? <Link className="font-medium hover:underline" href={`${ctx.base}/${fillPath(x.src.link, linkValues(ctx, x.row))}`}>{x.title || x.row.key}</Link> : <span className="font-medium">{x.title}</span>}
        {x.subtitle && <span className="block text-xs text-muted-foreground">{x.subtitle}</span>}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{when(x.date)}</span>
      {!!x.src.actions?.length && <span className="inline-flex gap-1"><Actions items={x.src.actions} ctx={ctx} row={x.row} /></span>}
    </li>
  );
  return (
    <div className="space-y-2">
      {(((n.search ?? true) && items.length > 0) || n.filters) && (
        <div className="flex flex-wrap items-center gap-2">
          {(n.search ?? true) && items.length > 0 && (
            <label className="relative inline-block">
              <Search aria-hidden className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
              <input type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-52 border border-border bg-background pr-2 pl-7 text-xs" />
            </label>
          )}
          {n.filters && (
            <span role="group" aria-label="Filter the queue" className="flex flex-wrap gap-1">
              {chip("", "All", items.length)}
              {n.sources.some((x) => x.attention) && chip("@attention", "Needs attention", attention)}
              {labels.length > 1 && labels.map((l) => chip(l, l, items.filter((x) => x.src.label === l).length))}
            </span>
          )}
        </div>
      )}
      {short.length > 0 && <p role="status" className="border-l-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-xs">{short.map((s) => s.label).join(", ")}: more than the page reads. <button type="button" className="underline" onClick={() => short.forEach((s) => ctx.more(s.from))}>Show more</button></p>}
      {!shown.length ? <p className="border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">{needle || only ? "Nothing matches." : renderText(n.empty ?? "Nothing waiting.", ctx.text)}</p> : groups.map((g) => (
        <section key={g.label} aria-label={g.label || undefined} className="space-y-1">
          {n.group && <h3 className="text-xs font-medium text-muted-foreground">{g.label} <span className="font-normal tabular-nums">· {g.rows.length}</span></h3>}
          <ul className="divide-y divide-border border border-border bg-card">{g.rows.map(line)}</ul>
        </section>
      ))}
    </div>
  );
}

/**
 * A URL parameter stepped with Previous and Next (a `?year=` navigator): its value, or the default (this year), within
 * min and max. The page's bindings read it as any URL parameter.
 */
function Stepper({ n, ctx }: { n: Of<"stepper">; ctx: Ctx }) {
  const fy = ctx.view.fiscalYearStartMonth;
  const fallback = n.default === "thisYear" ? new Date().getFullYear() : n.default === "thisFiscalYear" ? fiscalYearOf(new Date(), fy) : n.default;
  // A fiscal year reads as one: FY2027 when the workspace's year doesn't start in January.
  const name = (v: number) => (n.default === "thisFiscalYear" || n.format === "fy" ? fiscalYearLabel(v, fy) : String(v));
  const raw = Number(ctx.query[n.param]);
  const at = Number.isFinite(raw) && ctx.query[n.param] !== undefined && ctx.query[n.param] !== "" ? raw : fallback;
  const step = n.step ?? 1;
  // The URL always names the value, so the bindings that read it read from the first draw.
  const go = (v: number) => ctx.setQuery({ [n.param]: String(v) });
  const missing = ctx.query[n.param] === undefined || ctx.query[n.param] === "";
  useEffect(() => { if (missing) go(fallback); }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps
  const can = (v: number) => (n.min === undefined || v >= n.min) && (n.max === undefined || v <= n.max);
  return (
    <nav aria-label={n.label ? renderText(n.label, ctx.text) : n.param} className="flex items-center gap-2 text-sm print:hidden">
      {n.label && <span className="text-xs text-muted-foreground">{renderText(n.label, ctx.text)}</span>}
      <button type="button" className={btn} disabled={!can(at - step)} onClick={() => go(at - step)} aria-label={`Previous: ${name(at - step)}`}><ChevronLeft className="size-3.5" />{name(at - step)}</button>
      <span className="px-2 font-medium tabular-nums" aria-current="true">{name(at)}</span>
      <button type="button" className={btn} disabled={!can(at + step)} onClick={() => go(at + step)} aria-label={`Next: ${name(at + step)}`}>{name(at + step)}<ChevronRight className="size-3.5" /></button>
    </nav>
  );
}

/**
 * A date range in two URL parameters the page's bindings read: presets or words ("last 2 quarters"), in the
 * workspace's fiscal year. Without a range in the URL, it starts from its `default` words.
 */
function PageDateRange({ n, ctx }: { n: Of<"dateRange">; ctx: Ctx }) {
  const from = ctx.query[n.from] || null, to = ctx.query[n.to] || null, label = ctx.query[`${n.from}.label`] || undefined;
  // "All time" is a choice too: its label stays in the URL, so the default doesn't come back.
  const missing = !from && !to && !label;
  useEffect(() => {
    if (!missing || !n.default) return;
    const r = parseDateRange(n.default, today(), ctx.view.fiscalYearStartMonth);
    if (r) ctx.setQuery({ [n.from]: r.from, [n.to]: r.to, [`${n.from}.label`]: r.label });
  }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="print:hidden">
      <DateRangeInput label={n.label ? renderText(n.label, ctx.text) : "Dates"} value={missing || (!from && !to) ? null : { from, to, label }} fiscalYearStartMonth={ctx.view.fiscalYearStartMonth}
        onChange={(r) => ctx.setQuery({ [n.from]: r?.from ?? null, [n.to]: r?.to ?? null, [`${n.from}.label`]: r?.label ?? (n.default ? "All time" : null) })} />
    </div>
  );
}

/** A per-row choice in a transition's dialog: the argument, the rows of the list it picks for, and the spec of what it holds. */
type Choice = { field: string; label: string; rows: RowChoices; spec: FieldSpec | null };
function choiceRows(c: Choice, ctx: Ctx) {
  const rows = Object.hasOwn(ctx.view.loads, c.rows.from) ? rowsOfValue(ctx.loaded[c.rows.from]?.value, c.rows.list) : rowsOf(ctx, c.rows.from);
  return rowChoicesOf(c.rows, c.spec, rows, { ...ctx.text, rowLabels: ctx.view.labels[c.rows.from], rowFormats: (ctx.view.formats as Record<string, Record<string, string>>)[c.rows.from] });
}

function ChoiceRows({ c, ctx, value, onChange }: { c: Choice; ctx: Ctx; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = choiceRows(c, ctx);
  if (!rows.length) return <p className="text-xs text-muted-foreground">{c.label}: no rows.</p>;
  return (
    <fieldset className="space-y-1 border border-border/70 p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{c.label}</legend>
      <table className="w-full text-sm"><tbody>
        {rows.map((row) => {
          const selected = row.options.some((o) => o.value === value[row.key]) ? value[row.key] : "";
          return (
            <tr key={row.key} className="border-b border-border/60 last:border-b-0">
              <td className="py-1 pr-3">{row.title}</td>
              <td className="w-56 py-1"><select aria-label={`${c.label}: ${row.title}`} className="w-full border border-border bg-background px-2 py-1 text-sm" value={selected} disabled={!row.options.length} onChange={(e) => onChange({ ...value, [row.key]: e.target.value })}>
                {!selected && <option value="">{row.options.length ? "Choose an option" : "No options available"}</option>}
                {row.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select></td>
            </tr>
          );
        })}
      </tbody></table>
    </fieldset>
  );
}

function choiceStart(c: Choice, ctx: Ctx): Record<string, string> {
  return Object.fromEntries(choiceRows(c, ctx).map((row) => [row.key, row.initial]));
}

function choicesMissing(choices: readonly Choice[], ctx: Ctx, picks: Record<string, Record<string, string>>): string | null {
  for (const c of choices) {
    if (Object.hasOwn(ctx.view.loads, c.rows.from)) {
      const loaded = ctx.loaded[c.rows.from];
      if (!loaded || loaded.busy || loaded.error) return `${c.label}: options are not ready.`;
    }
    for (const row of choiceRows(c, ctx)) if (!row.options.some((o) => o.value === picks[c.field]?.[row.key])) return `${c.label}: choose an option for ${row.title}.`;
  }
  return null;
}

type Status = { waiting: number; running: number; retrying: number; failed: Array<{ key: string; error: string; attempts: number }>; more: boolean; lastRunAt: number | null; feedBehind: number | null };
/** How long ago a time was, in words. */
const ago = (at: number) => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(); };

/** A job's keys under a prefix as one line: up to date, or what waits, runs, retries or stopped, and when jobs last ran. */
function JobStatus({ n, ctx }: { n: Of<"jobStatus">; ctx: Ctx }) {
  const prefix = (n.keyPrefix ?? []).map((x) => {
    if (x !== null && typeof x === "object" && "bind" in x) { const d = ctx.view.data[x.bind] as Doc | null | undefined; return d ? (x.field === "key" ? d.key : d.data[x.field]) ?? null : null; }
    return ctx.value(x as PageExpr) ?? null;
  });
  const st = (ctx.view.statuses as Record<string, Status>)[`${n.job}:${JSON.stringify(prefix)}`];
  if (!st) return null;
  const busy = st.waiting + st.running + st.retrying;
  const parts = [st.running && `${st.running} running`, st.waiting && `${st.waiting} waiting`, st.retrying && `${st.retrying} retrying`, st.failed.length && `${st.failed.length}${st.more ? "+" : ""} stopped`].filter(Boolean);
  const behind = st.feedBehind ? `deal changes ${st.feedBehind} behind` : null;
  const state = parts.length ? parts.join(", ") : behind ? "catching up" : "up to date";
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 px-3 py-2 text-xs", st.failed.length ? "border-destructive bg-destructive/10" : busy || behind ? "border-amber-600 bg-amber-500/10" : "border-primary bg-primary/5")}>
      <span className="font-medium">{n.label ? renderText(n.label, ctx.text) : "Background work"}: {state}{st.more ? "+" : ""}</span>
      {behind && parts.length > 0 && <span>{behind}</span>}
      <span className="text-muted-foreground">{st.lastRunAt ? `Last run ${ago(st.lastRunAt)}` : "Not run yet"}</span>
      {st.failed.map((f) => <span key={f.key} className="basis-full text-destructive">{f.key}: {f.error || `stopped after ${f.attempts} tries`}</span>)}
    </div>
  );
}

/** A field the server described, as a form shows it: the label a page gives it, else its spec's, else its name. */
const asForm = (f: FieldInfo, label?: string | null, collection?: string | null): FormFieldInfo | null =>
  f.widget ? {
    field: f.field, label: label ?? f.label ?? human(f.field), widget: f.widget as Widget, required: f.required, spec: (f.spec ?? null) as FieldSpec | null, help: f.help, choices: f.choices, labels: f.labels,
    collection: collection ?? null, placeholder: f.placeholder ?? null, descriptions: f.descriptions ?? null, badges: (f as { badges?: Record<string, string> | null }).badges ?? null,
  } : null;

/**
 * The values a form writes: each shown field's (a blank optional one left out, and listed in `unset` when the doc
 * held it), then the fixed ones; a variant after the sibling that picks its case.
 */
function fromForm(fields: readonly FormFieldInfo[], values: Record<string, Draft>, fixed: Record<string, unknown>, before?: Record<string, unknown>): { data: Record<string, unknown>; unset: string[] } {
  const data: Record<string, unknown> = { ...fixed };
  const unset: string[] = [];
  const put = (f: FormFieldInfo, v: unknown) => {
    if (v !== undefined) data[f.field] = v;
    else if (before && !f.required && before[f.field] !== undefined) unset.push(f.field);
  };
  for (const f of fields) if (f.widget !== "variant") put(f, fromDraft(f, values[f.field]));
  for (const f of fields) if (f.widget === "variant") put(f, fromDraft(f, values[f.field], { ...(before ?? {}), ...data }));
  // A row field that `inherit`s takes the form's value (an override row's plan is the assignment's).
  return { data: withInherited(fields, data, before ?? {}), unset };
}

/**
 * A form's `fixed` and `initial` values from the page: the route, the caller, a constant, a field of a bound doc or of
 * the row the action sits on, today, or (to start from) a text over them.
 */
function prefill(x: FormPrefill, ctx: Ctx, row?: Doc): { fixed: Record<string, unknown>; initial: Record<string, unknown> } {
  const all = (m: Record<string, InitialExpr> | undefined) => formArguments(m ?? {}, (e) => initialValue(e, ctx, row));
  const fixed = formArguments(x.fixed ?? {}, (e) => e !== null && typeof e === "object" && "json" in e ? jsonQueryValue(ctx.query, e.query) : initialValue(e, ctx, row));
  return { fixed, initial: all(x.initial) };
}
/** A value a form starts from: a text over the page and the row ("{$row.name} (Copy)"), else a form value. */
function initialValue(e: InitialExpr, ctx: Ctx, row?: Doc): unknown {
  if (e !== null && typeof e === "object" && "text" in e) return renderText(e.text, row ? { ...ctx.text, row } : ctx.text);
  return ctx.formValue(e, row);
}
/** The required fields a form left empty, as the refusal it shows before it sends anything: "Signature is required." */
function unfilled(fields: readonly FormFieldInfo[], data: Record<string, unknown>): string | null {
  // A box the field must hold ticked (`true` alone) is unfilled until it is.
  const missing = fields.filter((f) => f.required && (data[f.field] === undefined || data[f.field] === "" || (f.widget === "bool" && !!f.spec && mustTick(f.spec.fieldType) && data[f.field] !== true))).map((f) => f.label);
  return missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.` : null;
}
/** What a write says when it is done: its action's `toast`, filled from the page, the row and a call's value; else `fallback`. */
function doneText(a: ActionRef, ctx: Ctx, row: Doc | undefined, fallback: string, result?: unknown, doc?: Doc): string {
  if (!("toast" in a) || !a.toast) return fallback;
  const binds = { ...ctx.text.binds, ...(result === undefined ? {} : { result: valueDoc(result) }), ...(doc ? { doc } : {}) };
  return renderText(a.toast, { ...ctx.text, binds, ...(row ? { row } : {}) }) || fallback;
}
/** A dialog's own words (`dialog`), each filled over the page and the row: its title, the line under it and its submit. */
type Words = { title?: string; description?: string; submit?: string; badge?: string };
function wordsOf(a: ActionRef, ctx: Ctx, row?: Doc): Words {
  const d = "dialog" in a ? a.dialog : undefined;
  if (!d) return {};
  const scope = row ? { ...ctx.text, row } : ctx.text;
  const fill = (t?: string) => (t ? renderText(t, scope) || undefined : undefined);
  return { title: fill(d.title), description: fill(d.description), submit: fill(d.submit), badge: fill(d.badge) };
}
/** A field a page shows with its own help and placeholder, each a text over the page (and the row): "Plan default: $120,000". */
function pageField<F extends { help?: string | null; placeholder?: string | null; choices?: ReadonlyArray<string | number | boolean> | null }>(f: F, given: Pick<FormField, "help" | "placeholder" | "options" | "optionTargets" | "hide">, ctx: Ctx, row?: Doc): F {
  const scope = row ? { ...ctx.text, row } : ctx.text;
  const picked = given.options ? optionsOf(given.options, ctx, row) : null;
  const original = f as F & { spec?: FieldSpec | null; widget?: Widget };
  let spec = original.spec;
  if (spec && picked) {
    if (coreOf(spec.fieldType).type === "array") spec = withFieldChoices(spec, picked.choices, picked.labels, picked.by);
    else if (picked.by) spec = { ...spec, choicesBy: picked.by };
  }
  for (const target of given.optionTargets ?? []) {
    const options = optionsOf(target.options, ctx, row);
    if (spec) spec = mapFieldSpecAt(spec, target.path.split("."), (field) => withFieldChoices(field, options.choices, options.labels, options.by)) ?? spec;
  }
  const list = spec && coreOf(spec.fieldType).type === "array";
  return {
    ...f,
    ...(spec ? { spec } : {}),
    // `hide`: choices this form leaves out (Add rule without two SPIFF types); the server still takes them.
    ...(given.hide?.length && f.choices ? { choices: f.choices.filter((c) => !given.hide!.some((h) => String(h) === String(c))) } : {}),
    // A help or placeholder whose every value is empty says nothing ("Deal:" for a deal with no company).
    ...(given.help ? { help: renderFilled(given.help, scope) || null } : {}), ...(given.placeholder ? { placeholder: renderFilled(given.placeholder, scope) || null } : {}),
    // Options from a doc: a choice among them, each by its label ("Step 2: Finance review (admin)").
    // On a member field they narrow the member picker (its search and Active/Inactive sections stay): reps not on a plan.
    // `sub` and `badge` show under and beside each option: a member's title and plan count, their role.
    ...(picked ? { ...(original.widget === "user" ? {} : { widget: list ? "list" : "choice" }), choices: picked.choices, labels: picked.labels, ...(given.options!.sub ? { descriptions: picked.subs } : {}), ...(given.options!.badge ? { badges: picked.badges } : {}) } : {}),
  };
}
/**
 * A field's options (docs/modules.md, "Forms and widgets"): the rows of a list binding or a loaded call's value, or the
 * items of the list a bound doc's field holds, each its `value` (a row's key, an item's place from 0) and its label.
 */
function optionsOf(o: FieldOptions, ctx: Ctx, row?: Doc): { choices: Array<string | number>; labels: Record<string, string>; subs: Record<string, string>; badges: Record<string, string>; by?: FieldSpec["choicesBy"] } {
  const bound = Object.hasOwn(ctx.view.loads as object, o.from) ? ctx.loaded[o.from]?.value : ctx.view.data[o.from];
  const source: Array<Record<string, unknown>> = Array.isArray(bound) && !o.list
    ? (bound as Doc[]).map((d) => ({ ...d.data, key: d.key }))
    : (() => {
      const holder = bound && typeof bound === "object" && "data" in (bound as object) ? (bound as Doc) : bound !== undefined && bound !== null ? valueDoc(bound) : null;
      const list = holder ? (o.list ? valueAt(holder, o.list) : holder.data) : null;
      return Array.isArray(list) ? list.map((x) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>) : { value: x })) : [];
    })();
  const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map((x) => x !== null && typeof x === "object" ? x as Record<string, unknown> : { value: x }) : [];
  const groups = o.by ? source.map((group) => ({ key: group[o.by!.key], items: rows(group[o.by!.list]) })) : [];
  const items = o.by ? groups.flatMap((g) => g.items) : source;
  const choices: Array<string | number> = [];
  const labels: Record<string, string> = {}, subs: Record<string, string> = {}, badges: Record<string, string> = {};
  items.forEach((x, i) => {
    const item = { ...x, n: i + 1, index: i };
    const raw = o.value ? valueAt(valueDoc(item), o.value) : Array.isArray(bound) && !o.list ? x.key : i;
    if (typeof raw !== "string" && typeof raw !== "number") return;
    choices.push(raw);
    const scope = { ...ctx.text, binds: { ...ctx.text.binds, item: valueDoc(item) }, ...(row ? { row } : {}) };
    labels[String(raw)] = renderText(o.label, scope) || String(raw);
    // A sub or badge whose every value is empty says nothing (a member with no title).
    const sub = o.sub ? renderFilled(o.sub, scope) : "", badge = o.badge ? renderFilled(o.badge, scope) : "";
    if (sub) subs[String(raw)] = sub;
    if (badge) badges[String(raw)] = badge;
  });
  const groupLabels = o.by ? Object.fromEntries(groups.map((group) => [String(group.key), Object.fromEntries(group.items.flatMap((item, i) => {
    const raw = o.value ? valueAt(valueDoc(item), o.value) : i;
    if (typeof raw !== "string" && typeof raw !== "number") return [];
    return [[String(raw), renderText(o.label, { ...ctx.text, binds: { ...ctx.text.binds, item: valueDoc({ ...item, n: i + 1, index: i }) }, ...(row ? { row } : {}) }) || String(raw)]];
  }))])) : undefined;
  const by = o.by ? { sibling: o.by.sibling, labels: groupLabels, cases: Object.fromEntries(groups.map((g) => [String(g.key), g.items.flatMap((item, i) => {
    const value = o.value ? valueAt(valueDoc(item), o.value) : i;
    return typeof value === "string" || typeof value === "number" ? [value] : [];
  })])) } : undefined;
  return { choices: [...new Set(choices)], labels, subs, badges, ...(by ? { by } : {}) };
}

/** A value as text reads it: an object's fields, else `{ value }`. */
/** A value as a doc: its fields as the doc's, and a `key` field (a call's row naming its doc) as its key. */
const valueDoc = (v: unknown): Doc => {
  const data = (typeof v === "object" && v !== null ? v : { value: v }) as Record<string, unknown>;
  return { key: typeof data.key === "string" ? data.key : "", version: 0, owner: null, data };
};
/** A write waiting on a job's keys under a prefix: its toast, the row it ran on and what a call returned. */
/** The writes waiting on a job, for as long as the tab is open: a page that opens another keeps them (Next remounts it). */
const WAITS = (() => {
  let list: Waiting[] = [];
  const listeners = new Set<() => void>();
  const set = (next: Waiting[]) => { list = next; listeners.forEach((f) => f()); };
  return {
    get: () => list,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    add: (w: Waiting) => set([...list, w]),
    remove: (id: number) => set(list.filter((x) => x.id !== id)),
  };
})();
type Waiting = { id: number; module: string; job: string; prefix: string[]; follow: Array<{ job: string; prefix: string[] }>; toast: string; scope: TextScope; row?: Doc; result?: unknown; at: number; action: string; busy: string | null };
/** Which action (and row) a wait came from, so its button says `wait.busy` while the wait lasts. */
const waitId = (module: string, a: ActionRef, row?: Doc) => `${module}|${row?.key ?? ""}|${JSON.stringify(a)}`;
/**
 * Watches one wait until none of its job's keys waits, runs or retries, then says its toast over the page as the write
 * left it (as the job left it, on the module's page now open), the row, a call's value (`{$result.*}`, "{$result.statements}
 * statements") and `{$job.seconds}`.
 */
function JobWaiter({ w, live, done }: { w: Waiting; live?: Record<string, unknown>; done: () => void }) {
  const p = useQuery(api.modules.jobProgress, { module: w.module, job: w.job, prefix: w.prefix, ...(w.follow.length ? { follow: w.follow } : {}) });
  const said = useRef(false);
  // The distinct keys each job was seen waiting or running on, for `{$job.count}` ("12 statements").
  const seen = useRef<Record<string, Set<string>>>({});
  useEffect(() => {
    if (!p || said.current) return;
    for (const [job, keys] of Object.entries(p.keys ?? {})) for (const k of keys) (seen.current[job] ??= new Set()).add(k);
    if (p.busy > 0) return;
    said.current = true;
    const counts = Object.fromEntries([w.job, ...w.follow.map((f) => f.job)].map((j) => [j, seen.current[j]?.size ?? 0]));
    // `count`: the keys the last job in the chain ran (the work: statements recalculated), each job's by its name too.
    const last = w.follow.length ? w.follow[w.follow.length - 1].job : w.job;
    const job = valueDoc({ seconds: ((Date.now() - w.at) / 1000).toFixed(1), count: counts[last], ...counts });
    // The module's open page's docs as the job left them (the page a `then` opened too): what the job made or wrote,
    // "{$tallies.count} tallies counted", over the docs the write's own page held.
    const binds = { ...w.scope.binds, ...(live ?? {}), job, ...(w.result === undefined ? {} : { result: valueDoc(w.result) }) };
    const text = renderText(w.toast, { ...w.scope, binds, ...(w.row ? { row: w.row } : {}) });
    if (p.failed) toast.error(`${text} ${p.failed} ${p.failed === 1 ? "key" : "keys"} stopped with an error.`);
    else toast.success(text);
    done();
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Where a call's value shows: under its button, or under the row it ran on. */
const resultKey = (call: string, row?: Doc) => (row ? `${call}|${row.key}` : call);

function FormBody({ fields, values, setValues, context, idPrefix }: { fields: readonly FormFieldInfo[]; values: Record<string, Draft>; setValues: (f: (s: Record<string, Draft>) => Record<string, Draft>) => void; context: Record<string, unknown>; idPrefix: string }) {
  return <FieldsEditor fields={fields} values={values} context={context} idPrefix={idPrefix} onChange={(field, d) => setValues((s) => setField(fields, s, field, d))} />;
}

/** A form bound to an op: an update of the doc `from` binds, or a create, with values the page fixes or starts it from. */
function InlineForm({ n, ctx }: { n: Of<"form">; ctx: Ctx }) {
  const op = useModuleOp();
  const info = ctx.view.ops[n.op];
  const doc = n.from ? (ctx.view.data[n.from] as Doc | null) : null;
  const jsonInputs = Object.entries(n.fixed ?? {}).flatMap(([field, e]) => e !== null && typeof e === "object" && "json" in e ? [{ field, query: e.query }] : []);
  const people = useQuery(api.objects.describe, jsonInputs.length ? { object: "contact" } : "skip");
  let given: { fixed: Record<string, unknown>; initial: Record<string, unknown> } = { fixed: {}, initial: {} };
  let queryProblem: string | null = null;
  try { given = prefill(n, ctx); } catch (e) { queryProblem = getErrorMessage(e); }
  const { fixed, initial } = given;
  const fields = n.fields.flatMap((f) => {
    const field = info.fields.find((x) => x.field === f.field);
    const shown = field && asForm(f.widget ? { ...field, widget: f.widget } : field, f.label, info.collection);
    return shown && !Object.hasOwn(fixed, f.field) ? [pageField(shown, f, ctx)] : [];
  });
  const start = () => draftsFor(fields, startWithin(fields, { ...initial, ...(doc?.data ?? {}) }, doc?.data));
  const [values, setValues] = useState<Record<string, Draft>>(start);
  const [seen, setSeen] = useState(doc?.version);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // A newer version of the doc, saved here or elsewhere, resets the form to it.
  if (doc && doc.version !== seen) { setSeen(doc.version); setValues(start()); }
  if (n.from && !doc) return <p className="text-sm text-muted-foreground">This doc doesn&apos;t exist, or you can&apos;t see it.</p>;
  const guardFixed: Record<string, FormExpr> = {};
  for (const [field, e] of Object.entries(n.fixed ?? {})) if (!(e !== null && typeof e === "object" && "json" in e)) guardFixed[field] = e;
  const blocked = blockedReason({ op: n.op, ...(doc ? { target: n.from } : { parent: n.parent }), fixed: guardFixed }, ctx);
  let filterProblem: string | null = queryProblem;
  const summaries: Array<{ field: string; lines: string[]; href: string }> = [];
  if (jsonInputs.length && people === null) filterProblem = "The People fields are unavailable.";
  if (people && !queryProblem) {
    const def = indexObjectDef(people as unknown as ObjectDef);
    const available = new Set(listColumns(def).keys());
    if (people.register) available.delete("createdAt");
    for (const input of jsonInputs) {
      try {
        const filter = parsePeopleFilter(fixed[input.field], def, available);
        const shown = collapseDayFilters(filter, dayColumnsOf(def));
        const labels: Record<string, string> = { eq: "is", neq: "is not", in: "is any of", contains: "contains", startsWith: "starts with", gt: "is after / above", gte: "is on or after / at least", lt: "is before / below", lte: "is on or before / at most", hasAny: "has any of", hasAll: "has all of", empty: "is empty", notEmpty: "is not empty" };
        const lines = shown.map((f) => {
          const label = people.fields.find((x) => x.apiName === f.field)?.label ?? (f.field === "updatedAt" ? "Last modified" : f.field);
          const value = Array.isArray(f.value) ? f.value.join(", ") : typeof f.value === "boolean" ? (f.value ? "Yes" : "No") : String(f.value);
          return `${label} ${labels[f.op]}${f.value === undefined ? "" : ` ${value}`}`;
        });
        const returnTo = `${ctx.base}/${fillPath(ctx.view.page.path, ctx.view.params as Record<string, string>)}`;
        summaries.push({ field: input.field, lines: lines.length ? lines : ["All people"], href: peopleListHref(filter, returnTo) });
      } catch (e) { filterProblem = getErrorMessage(e); }
    }
  }
  const filterLoading = jsonInputs.length > 0 && people === undefined;
  const readOnly = !info.allowed || blocked !== null || filterLoading || filterProblem !== null;

  async function submit() {
    if (readOnly) return;
    setBusy(true);
    try {
      const { data, unset } = fromForm(fields, values, fixed, doc?.data);
      const missing = unfilled(fields, data);
      if (missing) { setRefused(missing); return; }
      const out = await op({ module: ctx.view.module.slug, op: n.op, data, ...(unset.length ? { unset } : {}), ...(doc ? { key: doc.key, expect: doc.version } : {}),
        ...(info.setOf && n.parent !== undefined ? { parentKey: ctx.value(n.parent) } : {}) });
      toast.success("proposed" in out ? `${info.label}: sent for approval` : `${info.label}: saved`);
      setRefused(null);
      if (!doc) setValues(start());
    } catch (e) { setRefused(getErrorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <form className="max-w-3xl space-y-3 border border-border bg-card p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {blocked && <p className="text-xs text-muted-foreground">{blocked}</p>}
      {filterLoading && <p className="text-sm text-muted-foreground">Loading People fields…</p>}
      <Refused text={filterProblem} />
      {summaries.map((s) => (
        <div key={s.field} className="space-y-2 text-sm">
          <p className="font-medium">People matching</p>
          <ul className="list-inside list-disc">{s.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
          <Link className={btn} href={s.href}>Edit filter in People</Link>
        </div>
      ))}
      <fieldset disabled={readOnly || busy} className="space-y-3">
        <FormBody fields={fields} values={values} setValues={setValues} context={{ ...(doc?.data ?? {}), ...fixed }} idPrefix={`form-${n.op}`} />
      </fieldset>
      <Refused text={refused} />
      {!readOnly && <Submit label={n.submit ? renderText(n.submit, ctx.text) : info.label} busy={busy} missing={unfilled(fields, fromForm(fields, values, fixed, doc?.data).data)} />}
    </form>
  );
}

/** An action's op in a dialog: a create, or an update of the row or bound doc it targets, with the action's fixed and initial values. */
function OpDialog({ view, refName, row, given, words, shape, onClose, onSubmit }: { view: Ready; refName: string; row?: Doc; given: { fixed: Record<string, unknown>; initial: Record<string, unknown> }; words: Words; shape?: FieldInfo[]; onClose: () => void; onSubmit: (out: { data: Record<string, unknown>; unset: string[] }) => Promise<void> }) {
  const info = view.ops[refName];
  // The action's own `fields` (their order, labels, placeholders and options), else every field the op writes.
  const fields = (shape ?? info.fields).flatMap((f) => { const shown = asForm(f, shape ? f.label : null, info.collection); return shown && !Object.hasOwn(given.fixed, f.field) ? [shown] : []; });
  const before = info.kind === "update" ? row?.data : undefined;
  const [start] = useState<Record<string, Draft>>(() => {
    const start: Record<string, unknown> = { ...given.initial, ...(before ?? {}) };
    // A create's member field starts as the person creating it.
    if (!before) for (const f of fields) if (f.widget === "user" && start[f.field] === undefined && f.required) start[f.field] = view.userId ?? undefined;
    // A field with options starts among them, never as someone they leave out (a task's owner outside the attendees).
    return draftsFor(fields, startWithin(fields, start, before));
  });
  const [values, setValues] = useState<Record<string, Draft>>(start);
  const [busy, setBusy] = useState(false);
  // What the server refused on submit (a guard judged on the values given), shown in the dialog, which stays open.
  const [refused, setRefused] = useState<string | null>(null);
  // Submit waits for every required field; closing with changes asks first.
  const missing = unfilled(fields, fromForm(fields, values, given.fixed, before).data);
  const guard = useDiscardGuard(JSON.stringify(values) !== JSON.stringify(start), busy, onClose);
  const title = words.title ?? info.label;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) guard.close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-none sm:max-w-2xl">
        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">{title}{words.badge && <DialogBadge text={words.badge} />}</DialogTitle>
        {words.description ? <DialogDescription className="text-xs">{words.description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setRefused(null);
          try {
            const out = fromForm(fields, values, given.fixed, before);
            const missing = unfilled(fields, out.data);
            if (missing) return setRefused(missing);
            await onSubmit(out);
          } catch (err) { setRefused(getErrorMessage(err)); } finally { setBusy(false); }
        }}>
          <FormBody fields={fields} values={values} setValues={setValues} context={{ ...(before ?? {}), ...given.fixed }} idPrefix={`dialog-${refName}`} />
          <Refused text={refused} />
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={guard.close}>Cancel</button>
            <Submit label={words.submit ?? info.label} busy={busy} missing={missing} />
          </div>
        </form>
        {guard.asking}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Closing a dialog whose fields changed asks first ("Discard changes?"): `close` closes at once when nothing changed,
 * else shows `asking`, Canon's confirm, until the person discards or keeps editing.
 */
function useDiscardGuard(dirty: boolean, busy: boolean, onClose: () => void): { close: () => void; asking: ReactNode } {
  const [ask, setAsk] = useState(false);
  return {
    close: () => { if (busy) return; if (dirty) setAsk(true); else onClose(); },
    asking: ask ? <ConfirmDialog title="Discard changes?" description="What you entered here isn't saved." confirmLabel="Discard" destructive onConfirm={onClose} onClose={() => setAsk(false)} /> : null,
  };
}

/** A dialog's or a form's submit: off until every required field holds a value, saying which one doesn't. */
function Submit({ label, busy, missing }: { label: string; busy: boolean; missing: string | null }) {
  return (
    <span title={missing ?? undefined} className="inline-flex">
      <button type="submit" className={primary} disabled={busy || missing !== null} aria-describedby={missing ? "submit-why" : undefined}>{label}</button>
      {missing && <span id="submit-why" className="sr-only">{missing}</span>}
    </span>
  );
}

/**
 * A transition that takes arguments or asks first: its confirm sentence and its argument fields. `context`: the values
 * the action fixes, which a picker scoped to a sibling (a dispute's line under its statement) reads.
 */
function TransitionDialog({ info, fields, choices, ctx, context, initial, words, preview, onClose, onSubmit }: { info: TransitionInfo; fields: readonly FieldInfo[]; choices: readonly Choice[]; ctx: Ctx; context: Record<string, unknown>; initial: Record<string, unknown>; words: Words; preview?: ReactNode; onClose: () => void; onSubmit: (args: Record<string, unknown>) => Promise<void> }) {
  return <ArgsDialog title={words.title ?? info.label} badge={words.badge} description={words.description ?? info.confirm ?? undefined} submit={words.submit ?? info.label} fields={fields} choices={choices} ctx={ctx} context={context} initial={initial} extra={preview} onClose={onClose} onSubmit={onSubmit} />;
}

/**
 * An export's dialog with members to pick (docs/modules.md, "Records, exports and print"): the export's other fields,
 * the members of its roles, searched, with Select all and Clear (every one picked to start), the format as cards, and
 * "Export N <format>".
 */
function ExportDialog({ ctx, a, members, start, words, title, fields: given, onClose, onSubmit }: { ctx: Ctx; a: ExportRef; members?: ExportMembers; start: ExportFormat; words: Words; title: string; fields: readonly FieldInfo[]; onClose: () => void; onSubmit: (args: Record<string, unknown>, format: ExportFormat) => Promise<void> }) {
  // Each list the dialog picks from: the members (of `roles`), then each pick's options; every item picked to start.
  type PickList = { arg: string; label: string; items: Array<{ id: string; name: string }>; countBy?: string };
  const lists: PickList[] = [
    ...(members ? [{ arg: members.arg, label: members.label ? renderText(members.label, ctx.text) : "Members", items: ctx.view.members.filter((m) => !members.roles || members.roles.includes(m.role as never)).map((m) => ({ id: m.id, name: m.name })), countBy: a.count?.member }] : []),
    ...(a.picks ?? []).map((p) => { const o = optionsOf(p.options, ctx); return { arg: p.arg, label: p.label ? renderText(p.label, ctx.text) : human(p.arg), items: o.choices.map((c) => ({ id: String(c), name: o.labels[String(c)] ?? String(c) })), countBy: a.count?.picks?.[p.arg] }; }),
  ];
  const [picked, setPicked] = useState<Record<string, Set<string>>>(() => Object.fromEntries(lists.map((l) => [l.arg, new Set(l.items.map((x) => x.id))])));
  const [q, setQ] = useState<Record<string, string>>({});
  const [format, setFormat] = useState<ExportFormat>(start);
  const fields = given.flatMap((f) => { const shown = asForm(f); return shown ? [shown] : []; });
  const [values, setValues] = useState<Record<string, Draft>>(() => draftsFor(fields, {}));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const formats = a.formats?.length ? a.formats : (["csv"] as const);
  const empty = lists.find((l) => !picked[l.arg]?.size);
  const missing = unfilled(fields, fromForm(fields, values, {}).data) ?? (empty ? `Pick at least one of ${empty.label.toLowerCase()}.` : null);
  const FORMAT_LINES: Record<ExportFormat, string> = { csv: "One file of rows, for any spreadsheet or payroll tool.", xlsx: "An Excel workbook with typed columns.", pdf: "One PDF, each document from a new page, as it prints." };
  // `count`: the rows of its binding per item, and those every list's picks hold on.
  const counted = a.count ? rowsOf(ctx, a.count.from) : [];
  const holds = (r: Doc, l: PickList) => !l.countBy || !!picked[l.arg]?.has(String(valueAt(r, l.countBy) ?? ""));
  // An item's count: its rows that every other list's picks hold on (a rep's statements in the picked periods only).
  const countOf = (l: PickList, id: string) => counted.filter((r) => String(valueAt(r, l.countBy!) ?? "") === id && lists.every((o) => o === l || holds(r, o))).length;
  const inPicks = counted.filter((r) => lists.every((l) => holds(r, l)));
  const set = (arg: string, next: Set<string>) => setPicked((p) => ({ ...p, [arg]: next }));
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto rounded-none", a.count ? "sm:max-w-3xl" : "sm:max-w-2xl")}>
        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">{words.title ?? title}{words.badge && <DialogBadge text={words.badge} />}</DialogTitle>
        {words.description ? <DialogDescription className="text-xs">{words.description}</DialogDescription> : <DialogDescription className="sr-only">{words.title ?? title}</DialogDescription>}
        <form className="grid gap-4 sm:grid-cols-[1fr_auto]" onSubmit={async (e) => {
          e.preventDefault();
          if (missing) return setRefused(missing);
          setBusy(true); setRefused(null);
          try { await onSubmit({ ...fromForm(fields, values, {}).data, ...Object.fromEntries(lists.map((l) => [l.arg, l.items.filter((x) => picked[l.arg]?.has(x.id)).map((x) => x.id)])) }, format); }
          catch (err) { setRefused(getErrorMessage(err)); } finally { setBusy(false); }
        }}>
          <div className="min-w-0 space-y-4">
            {formats.length > 1 && (
              <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="mb-1 text-xs font-medium text-muted-foreground">Format</legend>
                {formats.map((f) => (
                  <label key={f} className={cn("flex cursor-pointer items-start gap-2 border px-3 py-2 text-sm", format === f ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/30")}>
                    <input type="radio" name="export-format" className="mt-1" checked={format === f} onChange={() => setFormat(f)} />
                    <span><span className="block font-medium">{FORMAT_NAMES[f]}</span><span className="block text-xs text-muted-foreground">{FORMAT_LINES[f]}</span></span>
                  </label>
                ))}
              </fieldset>
            )}
            {fields.length > 0 && <FormBody fields={fields} values={values} setValues={setValues} context={{}} idPrefix="export" />}
            {lists.map((l) => {
              const needle = (q[l.arg] ?? "").trim().toLowerCase();
              const shown = l.items.filter((x) => !needle || x.name.toLowerCase().includes(needle));
              const mine = picked[l.arg] ?? new Set<string>();
              return (
                <fieldset key={l.arg} className="space-y-2">
                  <legend className="flex w-full flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span>{l.label} · {mine.size} of {l.items.length} picked</span>
                    <button type="button" className="ml-auto underline" onClick={() => set(l.arg, new Set([...mine, ...shown.map((x) => x.id)]))}>Select all</button>
                    <button type="button" className="underline" onClick={() => set(l.arg, new Set([...mine].filter((id) => !shown.some((x) => x.id === id))))}>Clear</button>
                  </legend>
                  <label className="relative block"><Search aria-hidden className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
                    <input type="search" aria-label={`Search ${l.label.toLowerCase()}`} placeholder="Search" value={q[l.arg] ?? ""} onChange={(e) => setQ((x) => ({ ...x, [l.arg]: e.target.value }))} className="h-8 w-full border border-border bg-background pr-2 pl-7 text-sm" /></label>
                  <ul className="max-h-56 divide-y divide-border overflow-y-auto border border-border">
                    {shown.map((x) => (
                      <li key={x.id}><label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/40">
                        <input type="checkbox" checked={mine.has(x.id)} onChange={(e) => { const next = new Set(mine); if (e.target.checked) next.add(x.id); else next.delete(x.id); set(l.arg, next); }} />
                        <span className="min-w-0 flex-1 truncate">{x.name}</span>
                        {l.countBy && <span className="text-xs text-muted-foreground tabular-nums">{countOf(l, x.id)}</span>}
                      </label></li>
                    ))}
                    {!shown.length && <li className="px-3 py-2 text-xs text-muted-foreground">No one matches.</li>}
                  </ul>
                </fieldset>
              );
            })}
          </div>
          {a.count && (
            <aside aria-label="Export summary" className="h-fit space-y-2 border border-border bg-muted/30 p-3 text-sm sm:w-48">
              <p className="text-xs font-medium text-muted-foreground">Export summary</p>
              <dl className="space-y-1">
                <div className="flex justify-between gap-3"><dt>{renderText(a.count.label, ctx.text)}</dt><dd className="font-medium tabular-nums">{inPicks.length}</dd></div>
                {lists.map((l) => <div key={l.arg} className="flex justify-between gap-3"><dt>{l.label}</dt><dd className="font-medium tabular-nums">{picked[l.arg]?.size ?? 0}</dd></div>)}
              </dl>
            </aside>
          )}
          <div className="space-y-2 sm:col-span-2">
            <Refused text={refused} />
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={onClose} disabled={busy}>Cancel</button>
              <Submit label={words.submit ?? `Export ${a.count ? `${inPicks.length} ` : members ? `${picked[members.arg]?.size ?? 0} ` : ""}${FORMAT_NAMES[format]}`} busy={busy} missing={missing} />
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A create or a call asked in steps (docs/modules.md, "Forms and widgets"): a strip of the steps, each step's fields,
 * Back and Next (Next waits for the step's required fields), a preview card over `{$draft...}`, and the last step's
 * submit. A refusal shows on the step, which stays.
 */
function Wizard({ n, ctx }: { n: Of<"wizard">; ctx: Ctx }) {
  const router = useRouter();
  const op = useModuleOp();
  const runCall = useAction(api.modules.call);
  const source = n.op ? ctx.view.ops[n.op]?.fields ?? [] : ctx.view.calls[n.call!]?.fields ?? [];
  const allowed = n.op ? !!ctx.view.ops[n.op]?.allowed : !!ctx.view.calls[n.call!]?.allowed;
  const { fixed, initial } = prefill(n, ctx);
  const stepFields = n.steps.map((st) => st.fields.flatMap((f) => { const at = source.find((x) => x.field === f.field); const shown = at && asForm(pageField({ ...at, ...(f.widget ? { widget: f.widget } : {}) }, f, ctx), renderText(f.label, ctx.text), n.op ? ctx.view.ops[n.op].collection : null); return shown ? [shown] : []; }));
  const all = stepFields.flat();
  const [values, setValues] = useState<Record<string, Draft>>(() => draftsFor(all, startWithin(all, initial)));
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (!allowed) return null;
  const data = fromForm(all, values, fixed).data;
  const missing = unfilled(stepFields[at] ?? [], data);
  const last = at === n.steps.length - 1;
  const draft = valueDoc(data);
  // `{$draft.<field>}` reads a choice by its label ("In person"), as a doc's field does.
  const draftLabels = Object.fromEntries(all.flatMap((f) => (f.labels ? [[f.field, f.labels]] : [])));
  const scope: TextScope = { ...ctx.text, binds: { ...ctx.text.binds, draft }, labels: { ...ctx.text.labels, draft: draftLabels } };
  async function submit() {
    if (saved || busy) return;
    setBusy(true); setRefused(null);
    let didSave = false;
    const refreshFailure = "Saved, but the latest values could not be refreshed. Reload this page before editing again.";
    try {
      const out = n.op ? await op({ module: ctx.view.module.slug, op: n.op, data }) : await runCall({ module: ctx.view.module.slug, call: n.call!, args: data });
      didSave = true; setSaved(true);
      if (!await ctx.reloadAll()) { setRefused(refreshFailure); return; }
      const label = n.op ? ctx.view.ops[n.op].label : ctx.view.calls[n.call!].label;
      // `toast`: its own words over the page, `{$draft...}` as submitted and `{$result...}` a call's value ("Plan created").
      const own = n.toast ? renderText(n.toast, { ...scope, binds: { ...scope.binds, ...("value" in out ? { result: valueDoc(out.value) } : {}) } }) : "";
      toast.success("proposed" in out && !Array.isArray(out.proposed) ? `${label}: sent for approval` : own || `${label}: done`);
      const key = "key" in out ? out.key : "value" in out && out.value && typeof out.value === "object" ? (out.value as { key?: unknown }).key : undefined;
      if (n.then && typeof key === "string") router.push(`${ctx.base}/${fillPath(n.then, { ...(ctx.view.params as Record<string, string>), key })}`);
      else { setValues(draftsFor(all, startWithin(all, initial))); setAt(0); setSaved(false); }
    } catch (e) { setRefused(didSave ? refreshFailure : getErrorMessage(e)); } finally { setBusy(false); }
  }
  const st = n.steps[at];
  return (
    <div className="grid max-w-5xl gap-4 lg:grid-cols-[1fr_18rem]">
      <form className="space-y-4 border border-border bg-card p-4" onSubmit={(e) => { e.preventDefault(); if (missing) return setRefused(missing); if (last) return submit(); else { setRefused(null); setAt(at + 1); } }}>
        <ol aria-label="Steps" className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
          {n.steps.map((x, i) => (
            <li key={i} aria-current={i === at ? "step" : undefined} className={cn("inline-flex items-center gap-1 border px-2 py-0.5", i === at ? "border-foreground font-medium" : i < at ? "border-border" : "border-dashed border-border text-muted-foreground")}>
              {i < at ? <Check className="size-3" /> : <span className="tabular-nums">{i + 1}</span>}{renderText(x.title, ctx.text)}
            </li>
          ))}
        </ol>
        {st.description && <p className="text-sm text-muted-foreground">{renderText(st.description, ctx.text)}</p>}
        <FormBody fields={stepFields[at]} values={values} setValues={setValues} context={{ ...fixed, ...data }} idPrefix={`wizard-${at}`} />
        <Refused text={refused} />
        <div className="flex justify-between gap-2">
          <button type="button" className={btn} disabled={at === 0 || busy} onClick={() => { setRefused(null); setAt(at - 1); }}><ChevronLeft className="size-3.5" />Back</button>
          {last ? <Submit label={n.submit ? renderText(n.submit, ctx.text) : n.op ? ctx.view.ops[n.op].label : ctx.view.calls[n.call!].label} busy={busy || saved} missing={missing} />
            : <span title={missing ?? undefined} className="inline-flex"><button type="submit" className={primary} disabled={missing !== null}>Next<ChevronRight className="size-3.5" /></button></span>}
        </div>
      </form>
      {n.preview && (
        <aside aria-label="Preview" className="h-fit space-y-2 border border-border bg-muted/30 p-4 text-sm">
          <p className="font-medium">{n.preview.title ? renderText(n.preview.title, scope) : "Preview"}</p>
          <dl className="space-y-1.5">
            {n.preview.items.map((x, i) => <div key={i}><dt className="text-xs text-muted-foreground">{renderText(x.label, scope)}</dt><dd className="tabular-nums">{renderText(x.value, scope) || <span className="text-muted-foreground">Not set</span>}</dd></div>)}
          </dl>
        </aside>
      )}
    </div>
  );
}

/**
 * A spreadsheet of numbers (docs/modules.md, "Forms and widgets"): a row per doc, a column per item, each cell the doc's
 * record field at the item's key. Typing edits a cell; a block pasted from a spreadsheet (tabs and lines) fills from the
 * cell it lands on; Enter moves down. Save runs the update on each doc that changed, expecting the version it read.
 */
function Grid({ n, ctx }: { n: Of<"grid">; ctx: Ctx }) {
  const op = useModuleOp();
  const rows = rowsOf(ctx, n.from);
  const items = eachItems(n.each, (from, field) => eachRows(ctx, from, field), "fiscalMonths" in n.each && n.each.fiscalMonths !== null ? ctx.formValue(n.each.fiscalMonths) : null, ctx.view.fiscalYearStartMonth);
  const widget = n.widget ?? "number";
  const toText = (v: unknown) => (typeof v !== "number" ? "" : widget === "money" ? String(v / 100) : widget === "percent" ? String(Math.round(v * 1e6) / 1e4) : String(v));
  const fromText = (t: string) => { if (t.trim() === "") return undefined; const x = Number(t.replace(/[\s,$%€£]/g, "")); return !Number.isFinite(x) ? NaN : widget === "money" ? Math.round(x * 100) : widget === "percent" ? x / 100 : x; };
  // `cells`: each cell its own doc of another list, found by the row's key and the column's (a quota per rep and month).
  const per = n.cells;
  const cellDocs = per ? rowsOf(ctx, per.from) : [];
  const cellDoc = (r: Doc, k: string) => cellDocs.find((d) => String(valueAt(d, per!.row) ?? "") === r.key && String(valueAt(d, per!.column) ?? "") === k);
  const startOf = (r: Doc) => Object.fromEntries(items.map((it) => [it.key, toText(per ? cellDoc(r, it.key)?.data[n.field] : (r.data[n.field] as Record<string, unknown> | undefined)?.[it.key])]));
  // Edits per row with the version they started from: a live update to a row keeps them, and Save expects that version,
  // so a row changed meanwhile is refused and named rather than overwritten. A row's edits go once it saves, or on Discard.
  // A grid of cell docs expects each cell doc's version as the page read it.
  // A cell doc's version when its edit started, or null: no doc then, so one made meanwhile is refused, not overwritten.
  const [edits, setEdits] = useState<Record<string, { version: number; cells: Record<string, string>; versions?: Record<string, number | null> }>>({});
  const cells = Object.fromEntries(Object.entries(edits).map(([k, e]) => [k, e.cells]));
  const [busy, setBusy] = useState(false);
  const cellOf = (r: Doc, k: string) => cells[r.key]?.[k] ?? startOf(r)[k];
  const changed = rows.filter((r) => items.some((it) => cells[r.key]?.[it.key] !== undefined && cells[r.key][it.key] !== startOf(r)[it.key]));
  const bad = changed.some((r) => items.some((it) => Number.isNaN(fromText(cellOf(r, it.key)) as number)));
  const allowed = !!ctx.view.ops[n.op]?.allowed && !ctx.view.preview && (!n.cells?.create || !!ctx.view.ops[n.cells.create]?.allowed);
  const put = (ri: number, ci: number, t: string) => {
    const r = rows[ri], it = items[ci];
    if (!r || !it) return;
    const doc = per ? cellDoc(r, it.key) : undefined;
    setEdits((e) => ({ ...e, [r.key]: { version: e[r.key]?.version ?? r.version, cells: { ...(e[r.key]?.cells ?? {}), [it.key]: t }, versions: { ...(e[r.key]?.versions ?? {}), ...(e[r.key]?.versions?.[it.key] === undefined ? { [it.key]: doc ? doc.version : null } : {}) } } }));
  };
  // What a row and a column are called, in a cell's aria-label and a refusal: their texts, a member by name, never a raw id.
  const colLabel = (it: { key: string; data: Record<string, unknown> }) => renderText(n.label, { ...ctx.text, binds: { ...ctx.text.binds, col: { key: it.key, version: 0, owner: null, data: it.data } } }) || ctx.text.members.get(it.key) || it.key;
  const rowLabel = (r: Doc) => { const t = renderText(n.title, rowScope(ctx, n.from, r)); return ctx.text.members.get(t) ?? (t || ctx.text.members.get(r.key) || r.key); };
  const paste = (ri: number, ci: number, text: string) => {
    const lines = text.replace(/\r/g, "").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
    lines.forEach((line, dy) => line.split("\t").forEach((t, dx) => put(ri + dy, ci + dx, t.trim())));
  };
  async function save() {
    setBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const r of changed) {
      if (per) {
        // Each changed cell on its own: its doc updated (or its value removed), or a new doc made for an empty cell.
        let ok = true;
        for (const it of items) {
          const t = cellOf(r, it.key);
          if (cells[r.key]?.[it.key] === undefined || t === startOf(r)[it.key]) continue;
          const v = fromText(t), doc = cellDoc(r, it.key), was = edits[r.key]?.versions?.[it.key];
          try {
            if (doc && was === null) throw new Error("someone set this cell meanwhile; Discard to see it");
            if (doc) await op({ module: ctx.view.module.slug, op: n.op, key: doc.key, expect: was ?? doc.version, ...(v === undefined ? { data: {}, unset: [n.field] } : { data: { [n.field]: v } }) });
            else if (v !== undefined && per.create) await op({ module: ctx.view.module.slug, op: per.create, data: { [per.row]: r.key, [per.column]: it.key, [n.field]: v, ...Object.fromEntries(Object.entries(per.fixed ?? {}).flatMap(([k, x]) => { const fv = ctx.formValue(x); return fv === undefined || fv === null ? [] : [[k, fv]]; })) } });
          } catch (e) { ok = false; failed.push(`${rowLabel(r)}, ${colLabel(it)}: ${getErrorMessage(e)}`); }
        }
        if (ok) { done++; setEdits((e) => { const rest = { ...e }; delete rest[r.key]; return rest; }); }
        continue;
      }
      const next: Record<string, number> = { ...((r.data[n.field] as Record<string, number> | undefined) ?? {}) };
      for (const it of items) { const v = fromText(cellOf(r, it.key)); if (v === undefined) delete next[it.key]; else next[it.key] = v as number; }
      try {
        await op({ module: ctx.view.module.slug, op: n.op, key: r.key, expect: edits[r.key]?.version ?? r.version, data: { [n.field]: next } });
        done++;
        setEdits((e) => { const rest = { ...e }; delete rest[r.key]; return rest; });
      }
      catch (e) { failed.push(`${rowLabel(r)}: ${getErrorMessage(e)}`); }
    }
    setBusy(false);
    // As every other write does, a save re-runs the page's loaded calls: a summary under the grid reads the new values.
    if (done) ctx.reloadAll();
    if (failed.length) toast.error(`${done} saved. ${failed.slice(0, 3).join("; ")}`); else toast.success(`${done} ${done === 1 ? "row" : "rows"} saved`);
  }
  const sum = (it: { key: string }) => rows.reduce((k, r) => { const v = fromText(cellOf(r, it.key)); return k + (typeof v === "number" && !Number.isNaN(v) ? v : 0); }, 0);
  const fmt = (v: number) => formatValue(v, widget === "money" ? "money" : widget === "percent" ? "percent" : "number", ctx.text);
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing here yet.</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto border border-border bg-card">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border"><th className="sticky left-0 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground" />
            {items.map((it) => <th key={it.key} className="px-2 py-2 text-right text-xs font-medium text-muted-foreground">{colLabel(it)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key} className="border-b border-border last:border-b-0">
                <th scope="row" className="sticky left-0 bg-card px-3 py-1 text-left font-medium">{rowLabel(r)}</th>
                {items.map((it, ci) => {
                  const t = cellOf(r, it.key);
                  const dirty = cells[r.key]?.[it.key] !== undefined && t !== startOf(r)[it.key];
                  return (
                    <td key={it.key} className="p-0">
                      <input data-cell={`${ri}:${ci}`} aria-label={`${rowLabel(r)}, ${colLabel(it)}`} inputMode="decimal" disabled={!allowed || busy} value={t}
                        className={cn("h-8 w-24 border-0 bg-transparent px-2 text-right tabular-nums outline-none focus:bg-muted/50 focus:ring-1 focus:ring-primary", dirty && "bg-amber-500/10", Number.isNaN(fromText(t) as number) && "text-destructive")}
                        onChange={(e) => put(ri, ci, e.target.value)}
                        onPaste={(e) => { const text = e.clipboardData.getData("text"); if (/[\t\n]/.test(text)) { e.preventDefault(); paste(ri, ci, text); } }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (document.querySelector(`[data-cell="${ri + 1}:${ci}"]`) as HTMLInputElement | null)?.focus(); } }} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {n.total && <tfoot><tr className="border-t border-border"><th className="sticky left-0 bg-card px-3 py-2 text-left text-xs font-medium">Total</th>{items.map((it) => <td key={it.key} className="px-2 py-2 text-right text-xs font-medium tabular-nums">{fmt(sum(it))}</td>)}</tr></tfoot>}
        </table>
      </div>
      {allowed && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {bad && <span className="text-destructive">A cell isn&apos;t a number.</span>}
          <span>{changed.length} {changed.length === 1 ? "row" : "rows"} changed · paste a block from a spreadsheet into any cell</span>
          <button type="button" className={btn} disabled={busy || !changed.length} onClick={() => setEdits({})}>Discard</button>
          <button type="button" className={primary} disabled={busy || !changed.length || bad} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        </div>
      )}
    </div>
  );
}

/** A dialog's badge beside its title: what kind of record it edits ("Override"). */
function DialogBadge({ text }: { text: string }) {
  return <span className="inline-flex items-center border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{text}</span>;
}

/** Why the server refused a dialog's or a form's submit, beside the fields, so the person can change them. */
function Refused({ text }: { text: string | null }) {
  return text ? <p role="alert" className="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-sm">{text}</p> : null;
}

/**
 * A dialog asking for arguments, a transition's or a call's, in the widgets their schema gives them, then running it;
 * a per-row choice as one select per row of its list.
 */
function ArgsDialog({ title, description, submit, badge, fields: given, choices = [], ctx, context = {}, initial = {}, extra, onClose, onSubmit }: { title: string; description?: string | null; badge?: string; submit?: string; fields: readonly FieldInfo[]; choices?: readonly Choice[]; ctx?: Ctx; context?: Record<string, unknown>; initial?: Record<string, unknown>; extra?: ReactNode; onClose: () => void; onSubmit: (args: Record<string, unknown>) => Promise<void> }) {
  const fields = given.flatMap((f) => { const shown = asForm(f); return shown ? [shown] : []; });
  const [start] = useState<Record<string, Draft>>(() => draftsFor(fields, startWithin(fields, initial)));
  const [values, setValues] = useState<Record<string, Draft>>(start);
  const [firstPicks] = useState<Record<string, Record<string, string>>>(() => (ctx ? Object.fromEntries(choices.map((c) => [c.field, choiceStart(c, ctx)])) : {}));
  const [picks, setPicks] = useState(firstPicks);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const missing = unfilled(fields, fromForm(fields, values, {}).data) ?? (ctx ? choicesMissing(choices, ctx, picks) : null);
  const guard = useDiscardGuard(JSON.stringify(values) !== JSON.stringify(start) || JSON.stringify(picks) !== JSON.stringify(firstPicks), busy, onClose);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) guard.close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-none">
        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">{title}{badge && <DialogBadge text={badge} />}</DialogTitle>
        {description ? <DialogDescription className="text-xs">{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setRefused(null);
          try {
            const out = fromForm(fields, values, {});
            const missing = unfilled(fields, out.data) ?? (ctx ? choicesMissing(choices, ctx, picks) : null);
            if (missing) return setRefused(missing);
            // A nested `inherit` field takes the action's fixed values too (the doc a transition moves, a call's fixed args).
            await onSubmit({ ...withInherited(fields, out.data, context), ...picks });
          } catch (err) { setRefused(getErrorMessage(err)); } finally { setBusy(false); }
        }}>
          <FormBody fields={fields} values={values} setValues={setValues} context={context} idPrefix={`args-${title}`} />
          {ctx && choices.map((c) => <ChoiceRows key={c.field} c={c} ctx={ctx} value={picks[c.field] ?? {}} onChange={(v) => setPicks((p) => ({ ...p, [c.field]: v }))} />)}
          {extra}
          <Refused text={refused} />
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={guard.close}>Cancel</button>
            <Submit label={submit ?? title} busy={busy} missing={missing} />
          </div>
        </form>
        {guard.asking}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a call returned, as its manifest's `result` shows it, under the button that ran it: a table of rows, a row of
 * figures, or a message.
 */
function CallResultView({ call, value, ctx, loaded, at }: { call: string; value: unknown; ctx: Ctx; loaded?: boolean; at?: string }) {
  const info = ctx.view.calls[call];
  const r = info?.result as CallResult | null | undefined;
  if (!info || !r) return null;
  // A value the page loaded stays: it has Refresh, not Clear. One a row's action drew sits under that row (`at`).
  const close = loaded ? null : <button type="button" className="text-xs text-muted-foreground underline" onClick={() => ctx.setResult(at ?? call, undefined)}>Clear</button>;
  if (r.kind === "message") return <div role="status" className="mt-3 flex items-start justify-between gap-3 border-l-2 border-border bg-muted/40 px-4 py-3 text-sm"><p>{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</p>{close}</div>;
  const asDoc = (data: unknown, i = 0): Doc => ({ key: String(i), version: 0, data: (typeof data === "object" && data !== null ? data : { value: data }) as Record<string, unknown>, owner: null });
  if (r.kind === "kpis") {
    const scope = { ...ctx.text, binds: { ...ctx.text.binds, result: asDoc(value) } };
    return (
      <div role="status" className="mt-3 border border-border bg-card">
        <dl className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4">
          {r.items.map((x, i) => <Figure key={i} label={x.label} value={renderText(x.value, scope)} extras={x} scope={scope} />)}
        </dl>
        {close && <div className="flex justify-end border-t border-border px-3 py-1.5">{close}</div>}
      </div>
    );
  }
  const rows = callRowsOf(value, r.rows);
  // The value's rows as a table, with the same search, filters, sort, sections, totals, links and row actions as any.
  return (
    <div role="status" className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{info.label}: {rows.length} {rows.length === 1 ? "row" : "rows"}</span>{close}</div>
      {/* Its texts read the value as `{$result.<field>}`, as a figures result's do: an empty table says why. */}
      <Table n={{ ...r, from: `@${at ?? call}` }} ctx={{ ...ctx, text: { ...ctx.text, binds: { ...ctx.text.binds, result: asDoc(value) } } }} given={rows} />
    </div>
  );
}

/** A call's value the page loaded on open, as its `result` draws it, with Refresh. */
function LoadedResult({ n, ctx }: { n: Of<"callResult">; ctx: Ctx }) {
  const l = ctx.loaded[n.from];
  const load = (ctx.view.loads as Record<string, { call: string; args: Record<string, unknown> | null }>)[n.from];
  if (!load) return null;
  const info = ctx.view.calls[load.call];
  const refresh = <button type="button" className={btn} disabled={l?.busy || !load.args} onClick={() => ctx.reload(n.from)}><RefreshCw className={cn("size-3.5", l?.busy && "animate-spin")} />Refresh</button>;
  const head = <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{n.label ? renderText(n.label, ctx.text) : info?.label}</h2><span className="print:hidden">{refresh}</span></div>;
  if (!load.args) return <div className="space-y-2">{head}<p className="text-sm text-muted-foreground">Nothing to show here yet.</p></div>;
  if (l?.error) return <div className="space-y-2">{head}<p className="text-sm text-muted-foreground">{NOT_LOADED}</p></div>;
  if (!l || l.value === undefined) return <div className="space-y-2">{head}<LoadingRows count={2} /></div>;
  return <div className="space-y-2">{head}<CallResultView call={load.call} value={l.value} ctx={ctx} loaded /></div>;
}

type BulkView = { machine: string; via: string; label: string; state: "moving" | "stopped"; refused: Array<{ key: string; title: string; message: string }>; count: number; error: string | null; canRetry: boolean };
/** The bulk moves the doc waits on: moving, or stopped with the docs that refused, each linked, and Retry. */
function BulkStatus({ n, ctx }: { n: Of<"bulkStatus">; ctx: Ctx }) {
  const retry = useMutation(api.modules.retryBulk);
  const [busy, setBusy] = useState(false);
  const doc = ctx.view.data[n.from] as Doc | null;
  const list = ((ctx.view.bulks as Record<string, BulkView[]>)[n.from] ?? []);
  if (!doc || !list.length) return null;
  return (
    <div className="space-y-2">
      {list.map((b) => (
        <div key={`${b.machine}.${b.via}`} role="status" aria-live="polite" className={cn("space-y-1 border-l-2 px-3 py-2 text-xs", b.state === "stopped" ? "border-destructive bg-destructive/10" : "border-amber-600 bg-amber-500/10")}>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{n.label ? renderText(n.label, ctx.text) : b.label}: {b.state === "moving" ? "moving its docs" : `stopped. ${b.count} ${b.count === 1 ? "doc" : "docs"} refused to move, so this waits here until ${b.count === 1 ? "it moves" : "they move"}.`}</span>
            {b.canRetry && (
              <button type="button" className={btn} disabled={busy} onClick={async () => {
                setBusy(true);
                try { await retry({ module: ctx.view.module.slug, machine: b.machine, transition: b.via, key: doc.key }); toast.success(`${b.label}: retrying`); }
                catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
              }}><RefreshCw className="size-3.5" />Retry</button>
            )}
          </p>
          {b.refused.length > 0 && (
            <ul className="space-y-0.5">
              {b.refused.map((r) => (
                <li key={r.key}>
                  {n.link ? <Link className="font-medium underline" href={`${ctx.base}/${fillPath(n.link, { ...(ctx.view.params as Record<string, string>), key: r.key })}`}>{r.title}</Link> : <span className="font-medium">{r.title}</span>}: {r.message}
                </li>
              ))}
              {b.count > b.refused.length && <li className="text-muted-foreground">and {b.count - b.refused.length} more</li>}
            </ul>
          )}
          {b.error && <p className="text-destructive">{b.error}</p>}
        </div>
      ))}
    </div>
  );
}

/** The results of the calls among `items` that ran on this page. */
function Results({ items, ctx }: { items: readonly ActionRef[]; ctx: Ctx }) {
  const calls = [...new Set(items.flatMap((a) => ("call" in a && ctx.results[a.call] !== undefined ? [a.call] : [])))];
  return <>{calls.map((c) => <CallResultView key={c} call={c} value={ctx.results[c]} ctx={ctx} />)}</>;
}
