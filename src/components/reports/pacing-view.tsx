"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { PacingArgs, PacingPlan, PacingResult } from "../../../convex/lib/reports/runPacing";
import type { PacingSource } from "../../../modules/kernel/manifest";
import type { FunctionReturnType } from "convex/server";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { listColumns } from "../../../convex/lib/objects/listSpec";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { dayColumnsOf, expandDayFilters } from "../../../convex/lib/objects/views";
import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { PACING_COMPARE_MAX, dayOf, fiscalMonth, fiscalYearName, historicalShape, targetLine, type Grain, type Period, type TargetShape } from "../../../modules/kernel/pacing";
import { parseAmount, targetFor, type Plan } from "../../../modules/kernel/targets";
import { LoadingRows } from "@/components/dashboard";
import { useUrlState } from "@/lib/url-state";
import { cn, getErrorMessage } from "@/lib/utils";
import { FilterBar, isComplete } from "../records/filter-bar";
import type { TeamMember } from "../records/fields";
import { money, PacingChart, SERIES, type ChartSeries } from "./pacing-chart";

type Pacing = PacingResult;
type PlanDoc = PacingPlan;
export type Roster = FunctionReturnType<typeof api.targets.get>["roster"];

const NO_FILTERS: ViewFilter[] = [];

/** A saved plan as targetFor reads it: the company's months are its teams' months added up. */
export function planOf(doc: PlanDoc): Plan {
  const months = Array.from({ length: 12 }, (_, m) => Object.values(doc.teamMonths).reduce((s, t) => s + (t[m] ?? 0), 0));
  return { year: doc.year, fyStart: doc.fyStart, total: doc.total, seasonality: [], teams: {}, reps: {}, repMonths: doc.repMonths, teamMonths: doc.teamMonths, months, misfits: [] };
}

/** Daily amounts as a running total; days after `through` (the current period's today) are null. */
function running(daily: readonly number[], through: number | null): (number | null)[] {
  let run = 0;
  return daily.map((v, i) => {
    run += v;
    return through !== null && i > through ? null : run;
  });
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 border border-border px-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="bg-transparent text-foreground outline-none">
        {options.map(([v, l]) => <option key={v} value={v} className="bg-background">{l}</option>)}
      </select>
    </label>
  );
}

function Multi({ label, values, chosen, onChange }: { label: string; values: readonly { id: string; name: string }[]; chosen: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const name = (id: string) => values.find((v) => v.id === id)?.name ?? "Unknown";
  const shown = chosen.length === 0 ? "All" : chosen.length <= 2 ? chosen.map(name).join(", ") : `${chosen.length} chosen`;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn("inline-flex items-center gap-1.5 border px-2 py-1 text-xs", chosen.length ? "border-foreground/60" : "border-border")}>
        <span className="text-muted-foreground">{label}</span> {shown} <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-72 min-w-48 overflow-y-auto border border-border bg-popover p-1 shadow-lg">
          {values.map((v) => (
            <label key={v.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-muted">
              <input type="checkbox" checked={chosen.includes(v.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, v.id] : chosen.filter((c) => c !== v.id))} />
              {v.name}
            </label>
          ))}
          {chosen.length > 0 && <button type="button" onClick={() => onChange([])} className="w-full px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground">Clear</button>}
        </div>
      )}
    </div>
  );
}

type ExplorerProps = { plans: Record<number, PlanDoc | null>; roster: Roster; meId: string; meRole: string };
type ExplorerSource = PacingSource & { object: string; fields?: readonly string[] };
const CANON_PACING: readonly ExplorerSource[] = [
  { id: "booked", label: "Bookings", collection: "canon.deals", object: "deal", date: "closeDate", amount: "amount", filter: [{ field: "isWon", op: "eq", value: true }] },
  { id: "created", label: "Pipeline created", collection: "canon.deals", object: "deal", date: "createdAt", amount: "amount", coverage: true },
];
export function PacingView(props: ExplorerProps) {
  const run = useAction(api.reportPacing.run);
  return <PacingExplorer {...props} sources={CANON_PACING} run={(args) => run({ ...args, measure: args.measure === "created" ? "created" : "booked" })} />;
}

export function PacingExplorer({ plans, roster, meId, meRole, sources, run }: ExplorerProps & { sources: readonly ExplorerSource[]; run: (args: PacingArgs & { measure: string }) => Promise<PacingResult> }) {
  const [url, setUrl] = useUrlState({ m: "booked", g: "quarter", c: "3", s: "", tm: "plan", ts: "historical", pc: "" });
  const source = sources.find((s) => s.id === url.m) ?? sources[0];
  const measure = source.id;
  const ownFields = useMemo(() => new Set(sources.flatMap((s) => [s.date, ...(s.filter ?? []).map((f) => f.field)])), [sources]);
  const grain = (["month", "quarter", "year"].includes(url.g) ? url.g : "quarter") as Grain;
  const shape = (["historical", "linear", "flat"].includes(url.ts) ? url.ts : "historical") as TargetShape;
  // A rep opens on their own numbers; anyone can widen it.
  const [owners, setOwners] = useState<string[]>(() => (meRole === "rep" ? [meId] : []));
  const [teams, setTeams] = useState<string[]>([]);
  const [extra, setExtra] = useState<ViewFilter[]>(NO_FILTERS);
  const [moreOpen, setMoreOpen] = useState(false);
  const [fixed, setFixed] = useState("");

  const description = useQuery(api.objects.describe, { object: source.object });
  const desc = useMemo(() => description && source.fields ? { ...description, fields: description.fields.filter((f) => source.fields!.includes(f.apiName)) } : description, [description, source.fields]);
  const hasOwner = desc?.fields.some((f) => f.apiName === "ownerId") ?? false;
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const def = useMemo(() => (desc ? indexObjectDef(desc as unknown as ObjectDef) : null), [desc]);
  const columns = useMemo(() => new Map([...(def ? listColumns(def) : [])].filter(([k]) => !ownFields.has(k))), [def, ownFields]);
  const dayColumns = useMemo(() => (def ? dayColumnsOf(def) : new Set<string>()), [def]);
  const splitFields = (desc?.fields ?? []).filter((f) => (f.type === "picklist" || f.type === "user") && !ownFields.has(f.apiName) && f.apiName !== "crmOwnerId");
  const split = splitFields.some((f) => f.apiName === url.s) || hasOwner && url.s === "team" ? url.s : "";
  // The breakdown under the chart needs a split even when the chart shows periods: by team, or by rep inside one team.
  const breakdown = split || (hasOwner ? teams.length === 1 || roster.teams.length <= 1 ? "ownerId" : "team" : "");

  const extraFilters = useMemo(() => expandDayFilters(extra.filter((f) => isComplete(f) && columns.has(f.field)), dayColumns), [extra, columns, dayColumns]);
  const args = useMemo(() => ({
    measure, grain, compare: url.c === "yoy" ? ("yoy" as const) : Math.min(PACING_COMPARE_MAX, Math.max(0, Number(url.c) || 0)),
    split: breakdown,
    filter: [...(hasOwner && owners.length ? [{ field: "ownerId", op: "in" as const, value: owners }] : []), ...extraFilters],
    teamIds: hasOwner ? teams : [],
  }), [measure, grain, url.c, breakdown, owners, extraFilters, teams, hasOwner]);
  const [answer, setAnswer] = useState<{ key: string; result?: Pacing; error?: string }>({ key: "" });
  const key = JSON.stringify(args);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      run(args).then((result) => live && setAnswer({ key, result })).catch((e) => live && setAnswer((a) => ({ key, result: a.result, error: getErrorMessage(e) })));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = answer.result;
  const loading = answer.key !== key;

  if (!res) return answer.error ? <p className="text-sm text-destructive">{answer.error}</p> : <LoadingRows count={4} />;

  const period = new Map(res.periods.map((p) => [p.key, p]));
  const now = period.get(res.shown[0])!;
  const todayIdx = dayOf(res.today, now);
  const planFor = (p: Period) => plans[fiscalMonth(p.start, res.fyStart).fy];
  const lineOf = (p: Period, daily: number[]) => running(daily, p.key === now.key ? todayIdx : null);
  const whole = new Map(res.series.filter((s) => s.key === null).map((s) => [s.period, s.daily]));
  // The four periods before this one, which the action always reads.
  const prior = res.periods.filter((p) => p.start < now.start && whole.has(p.key)).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 4);
  const curve = historicalShape(prior.map((p) => lineOf(p, whole.get(p.key)!)));

  const names = new Map((team ?? []).map((m) => [m._id, m.name]));
  const field = desc?.fields.find((f) => f.apiName === breakdown);
  const labelOf = (k: string) => {
    // Split by team, a deal with no owner counts toward no team at all (the plan's "No team" is reps on none).
    if (breakdown === "team") return k === "" ? "No owner" : res.teamNames[k] ?? "Unknown team";
    if (k === "") return `No ${(field?.label ?? "value").toLowerCase()}`;
    if (breakdown === "ownerId" || field?.type === "user") return names.get(k) ?? "Unknown user";
    return (field && "options" in field ? field.options?.find((o) => o.value === k)?.label : undefined) ?? k;
  };

  // Targets: the plan's, for the teams and reps in view, times coverage for pipeline, scaled for filters it does not plan.
  const fixedCents = (parseAmount(fixed) ?? 0) * 100;
  const targetOf = (p: Period, cut: { teams?: string[]; reps?: string[] } | null, scale: number | null): number | null => {
    if (url.tm === "none" || (url.tm === "plan" && !cut)) return null;
    if (url.tm === "fixed") return fixedCents > 0 ? fixedCents : null;
    const doc = planFor(p);
    if (!doc) return null;
    const base = targetFor(planOf(doc), p, cut ?? {});
    return base === null ? null : base * (source.coverage ? doc.coverage : 1) * (scale ?? 1);
  };
  const viewCut = hasOwner ? { teams, reps: owners } : {};
  const teamOfRep = new Map(roster.reps.map((r) => [r.id, r.team]));
  /** The plan's cut for one split value: the view's teams and reps narrowed to it; null when it has no target (no owner). */
  const cutFor = (k: string): { teams?: string[]; reps?: string[] } | null => {
    if (k === "" && (breakdown === "team" || breakdown === "ownerId")) return null;
    if (breakdown === "ownerId") return { teams, reps: [k] };
    if (breakdown !== "team") return viewCut;
    // A team's target counts only the chosen owners on that team, as its actuals do.
    const reps = owners.filter((o) => teamOfRep.get(o) === k);
    return owners.length ? (reps.length ? { teams: [k], reps } : null) : { teams: [k] };
  };
  const scaleFor = (k: string) => (breakdown === "team" || breakdown === "ownerId" ? res.share : res.splitShare?.[k] ?? 0);
  // Planned teams and reps in view show even before they book anything: zero against their pace.
  const planned = url.tm !== "plan" || !planFor(now) ? []
    : breakdown === "team" ? roster.teams.filter((t) => (!teams.length || teams.includes(t.id)) && (!owners.length || owners.some((o) => teamOfRep.get(o) === t.id))).map((t) => t.id)
      : breakdown === "ownerId" ? roster.reps.filter((r) => (!owners.length || owners.includes(r.id)) && (!teams.length || teams.includes(r.team))).map((r) => r.id) : [];
  const splitRows = [
    ...res.series.filter((s) => s.key !== null),
    ...planned.filter((k) => !res.series.some((s) => s.key === k)).map((k) => ({ period: now.key, key: k, daily: new Array<number>(now.days).fill(0) })),
  ];
  const estimated = res.share !== null;

  const perSeries = Boolean(split) || url.pc === "1";
  const series: ChartSeries[] = split
    ? splitRows.map((s, i) => {
      const k = s.key!;
      return { id: k, label: labelOf(k), color: SERIES[i % SERIES.length], period: now, line: lineOf(now, s.daily), target: targetOf(now, cutFor(k), scaleFor(k)), current: true };
    })
    : res.shown.map((key, i) => {
      const p = period.get(key)!;
      return { id: key, label: p.label, color: SERIES[i], period: p, line: lineOf(p, whole.get(key) ?? []), target: targetOf(p, viewCut, res.share), current: i === 0 };
    });

  const nowLine = lineOf(now, whole.get(now.key) ?? []);
  const got = nowLine[todayIdx] ?? 0;
  const target = targetOf(now, viewCut, res.share);
  const expected = target === null ? null : targetLine(target, now.days, shape === "flat" ? "linear" : shape, curve)[todayIdx];
  const frac = (todayIdx + 1) / now.days;
  // Early in a period a projection is noise: wait for a quarter of it, and for past periods to have moved.
  const landing = frac >= 0.25 && curve(frac) > 0.05 ? got / curve(frac) : null;
  const what = source.label.toLowerCase();

  const pick = (k: string) => {
    if (breakdown === "team") setTeams([k]);
    else if (breakdown === "ownerId") setOwners([k]);
    else setExtra((f) => [...f.filter((x) => x.field !== breakdown), k === "" ? { field: breakdown, op: "empty" } : { field: breakdown, op: "in", value: [k] }]);
    if (split) setUrl({ s: "" });
  };

  return (
    <div className={cn("space-y-5 transition-opacity", loading && "opacity-70")}>
      <div className="space-y-1">
        <p className="max-w-4xl font-display text-2xl leading-snug text-foreground/90">
          {now.label}: {money(got)} {what}
          {target !== null && target > 0 && <> of {money(target)} ({Math.round((got / target) * 100)}%)</>}.
          {expected !== null && target !== null && target > 0 && <> Pace says {money(expected)} by today, so you are <span className={got >= expected ? "text-primary" : "text-warning"}>{money(Math.abs(got - expected))} {got >= expected ? "ahead" : "behind"}</span>.</>}
        </p>
        <p className="text-sm text-muted-foreground">
          Day {todayIdx + 1} of {now.days}, {now.days - todayIdx - 1} days left.
          {landing !== null && <> If this {grain} follows the last {prior.length}, it lands near {money(landing)}{target ? <> ({Math.round((landing / target) * 100)}% of target)</> : null}.</>}
          {url.tm === "plan" && !planFor(now) && <> No targets for {fiscalYearName(fiscalMonth(now.start, res.fyStart).fy, res.fyStart)} yet.</>}
          {estimated && url.tm === "plan" && " The target is estimated: the plan sets targets by team and rep, so other filters get their share of the last twelve months."}
          {res.approximate && " Some of this is read by week, not by day."}
        </p>
        {answer.error && <p className="text-sm text-destructive">{answer.error}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex border border-border text-xs">
            {sources.map((s) => <button key={s.id} type="button" aria-pressed={measure === s.id} onClick={() => setUrl({ m: s.id, s: "" })} className={cn("px-2 py-1", measure === s.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>{s.label}</button>)}
          </span>
          <Select label="Period" value={grain} onChange={(g) => setUrl({ g })} options={[["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]]} />
          <Select label="Compare with" value={url.c} onChange={(c) => setUrl({ c })} options={[["0", "Nothing"], ["1", "Last period"], ["3", "Last 3 periods"], ["5", "Last 5 periods"], ["yoy", "Same period last year"]]} />
          <Select label="Split by" value={split} onChange={(s) => setUrl({ s })} options={[["", "Period"], ...(hasOwner ? [["team", "Team"] as const] : []), ...splitFields.map((f) => [f.apiName, f.label] as const)]} />
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
          <Select label="Target" value={url.tm} onChange={(tm) => setUrl({ tm })} options={[["plan", "From the plan"], ["fixed", "A fixed amount"], ["none", "None"]]} />
          {url.tm === "fixed" && <input aria-label="Target amount" placeholder="1.5M" value={fixed} onChange={(e) => setFixed(e.target.value)} className="w-24 border border-border bg-background px-2 py-1 text-xs" />}
          {url.tm !== "none" && <Select label="Drawn as" value={shape} onChange={(ts) => setUrl({ ts })} options={[["historical", "Pace like past periods"], ["linear", "Straight pace"], ["flat", "Flat line"]]} />}
          {url.tm !== "none" && !split && (
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={url.pc === "1"} onChange={(e) => setUrl({ pc: e.target.checked ? "1" : "" })} /> Each period’s own target</label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasOwner && roster.teams.length > 1 && <Multi label="Team" values={roster.teams} chosen={teams} onChange={setTeams} />}
          {hasOwner && <Multi label="Owner" values={roster.reps.map((r) => ({ id: r.id, name: r.name }))} chosen={owners} onChange={setOwners} />}
          <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} className={cn("inline-flex items-center gap-1.5 border px-2 py-1 text-xs", extraFilters.length ? "border-foreground/60" : "border-border")}>
            <SlidersHorizontal className="h-3 w-3" /> {extraFilters.length ? `${extra.filter(isComplete).length} more filter${extra.filter(isComplete).length === 1 ? "" : "s"}` : "More filters"}
          </button>
          {(owners.length > 0 || teams.length > 0 || extra.length > 0) && <button type="button" onClick={() => { setOwners([]); setTeams([]); setExtra(NO_FILTERS); }} className="text-xs text-muted-foreground underline">Clear filters</button>}
        </div>
        {moreOpen && desc && (
          <div className="border border-border p-3">
            <FilterBar filters={extra} columns={columns} dayColumns={dayColumns} canAdd={extraFilters.length < 14} resetKey={0} fields={desc.fields.filter((f) => !ownFields.has(f.apiName))} team={team} onChange={setExtra} />
          </div>
        )}
      </div>

      <section className="operator-panel p-4">
        <PacingChart series={series} shape={shape} curve={curve} perSeries={perSeries} grain={grain} today={todayIdx} />
      </section>

      <Breakdown
        title={`${now.label} by ${breakdown === "team" ? "team" : breakdown === "ownerId" ? "owner" : (field?.label ?? breakdown).toLowerCase()}`}
        rows={splitRows.map((s) => {
          const k = s.key!;
          const t = targetOf(now, cutFor(k), scaleFor(k));
          return {
            id: k, name: labelOf(k), got: lineOf(now, s.daily)[todayIdx] ?? 0, target: t,
            pace: t === null ? null : targetLine(t, now.days, shape === "flat" ? "linear" : shape, curve)[todayIdx],
          };
        }).sort((a, b) => (b.target ?? b.got) - (a.target ?? a.got))}
        onPick={pick}
      />
    </div>
  );
}

/** The current period broken down, each row against its own target and pace; picking one narrows the page to it. */
function Breakdown({ title, rows, onPick }: { title: string; rows: { id: string; name: string; got: number; target: number | null; pace: number | null }[]; onPick: (id: string) => void }) {
  if (!rows.length) return null;
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.got, r.target ?? 0)));
  return (
    <section className="space-y-2">
      <h2 className="text-base text-foreground">{title}</h2>
      <div className="divide-y divide-border/60 border-y border-border">
        {rows.map(({ id, name, got, target, pace }) => {
          const ahead = pace === null || got >= pace;
          return (
            <button key={id} type="button" onClick={() => onPick(id)} className="grid w-full grid-cols-[minmax(0,9rem)_5.5rem_1fr] items-center gap-3 px-2 py-2.5 text-left hover:bg-muted/40 md:grid-cols-[minmax(0,11rem)_6rem_1fr_14rem] md:gap-4">
              <span className="truncate text-sm text-foreground">{name}</span>
              <span className="text-right font-display text-lg tabular-nums">{money(got)}</span>
              <span className="relative h-3 bg-muted-foreground/15">
                {target !== null && <span className="absolute inset-y-0 left-0 border-r border-muted-foreground/60" style={{ width: `${(target / scale) * 100}%` }} />}
                <span className={cn("absolute inset-y-0 left-0", ahead ? "bg-primary" : "bg-warning")} style={{ width: `${(got / scale) * 100}%` }} />
                {pace !== null && <span className="absolute -inset-y-1 w-0.5 bg-foreground" style={{ left: `${Math.min(100, (pace / scale) * 100)}%` }} />}
              </span>
              <span className="col-span-3 text-xs text-muted-foreground md:col-span-1">
                {target === null || target === 0 ? "No target" : <>{Math.round((got / target) * 100)}% of {money(target)} · <span className={ahead ? "text-primary" : "text-warning"}>{money(Math.abs(got - (pace ?? 0)))} {ahead ? "ahead" : "behind"}</span></>}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">The bar is what is in so far, the thin mark is where pace says it should be today, and the faint end is the target. Pick a row to narrow the page to it.</p>
    </section>
  );
}
