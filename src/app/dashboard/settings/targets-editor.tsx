"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft, Check, Lock, Unlock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { buildPlan, parseAmount, parseTargets, planInput, type PlanChoices } from "../../../../modules/kernel/targets";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import { cn, getErrorMessage } from "@/lib/utils";
import { money } from "@/components/reports/pacing-chart";
import { fiscalYearName } from "../../../../modules/kernel/pacing";
import type { Roster } from "../../../../convex/targets";

const CALENDAR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type History = { months: number[]; reps: Record<string, number>; truncated: boolean };

/** An amount typed in dollars ("1.2M", "$450,000"), shown and stored in cents. */
function AmountCell({ value, locked, onSet, onUnlock, big, readOnly }: { value: number; locked: boolean; onSet: (cents: number) => void; onUnlock: () => void; big?: boolean; readOnly?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  if (readOnly) return <span className={cn("tabular-nums", big && "font-display text-2xl")}>{money(value)}</span>;
  const commit = () => {
    const n = text === null ? null : parseAmount(text);
    if (n !== null && n * 100 !== value) onSet(n * 100);
    setText(null);
  };
  return (
    <span className="inline-flex items-center justify-end gap-1">
      <input
        aria-label="Amount" value={text ?? money(value)} onFocus={() => setText(String(Math.round(value / 100)))} onChange={(e) => setText(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={cn("w-24 border bg-transparent px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-foreground", locked ? "border-foreground/50" : "border-transparent hover:border-border", big && "w-36 font-display text-2xl")}
      />
      {!big && (
        <button type="button" aria-label={locked ? "Unlock: let it rebalance" : "Lock this amount"} title={locked ? "Locked: click to let it rebalance" : "Lock this amount"} onClick={locked ? onUnlock : () => onSet(value)} className={cn("p-0.5", locked ? "text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground")}>
          {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
        </button>
      )}
    </span>
  );
}

function Select<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-1.5 border border-border px-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as T)} className="bg-transparent text-foreground outline-none">
        {options.map(([v, l]) => <option key={v} value={v} className="bg-background">{l}</option>)}
      </select>
    </label>
  );
}

const defaults = (year: number, last: number): PlanChoices => ({
  year, total: Math.max(10_000_00, Math.round((last * 1.1) / 10_000_00) * 10_000_00), coverage: 3,
  months: { method: "history" }, teams: { method: "history" }, reps: { method: "history" },
});

export function TargetsEditor({ year, fyStart, saved, roster, canEdit, onDone }: { year: number; fyStart: number; saved: PlanChoices | null; roster: Roster; canEdit: boolean; onDone: () => void }) {
  // The fiscal year's months in order: its first is the month it starts in.
  const monthNames = CALENDAR.map((_, i) => CALENDAR[(i + fyStart - 1) % 12]);
  const name = (fy: number) => fiscalYearName(fy, fyStart);
  const loadHistory = useAction(api.targets.history);
  const setTargets = useAction(api.targets.set);
  const [history, setHistory] = useState<History | null>(null);
  const [choices, setChoices] = useState<PlanChoices | null>(saved);
  const [months, setMonths] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasted, setPasted] = useState<string | null>(null);
  const [profileOf, setProfileOf] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    loadHistory({ year: year - 1 }).then((h) => {
      setHistory(h);
      setChoices((c) => c ?? defaults(year, h.months.reduce((s, x) => s + x, 0)));
    }).catch((e) => void toast.error(getErrorMessage(e)));
  }, [loadHistory, year]);
  const plan = useMemo(() => (choices && history ? buildPlan(planInput(choices, roster, history, fyStart)) : null), [choices, history, roster, fyStart]);
  const frame = (children: ReactNode, save?: { run: () => void; disabled: boolean; saving: boolean }) => (
    <ViewFrame
      title={`Targets for ${name(year)}`}
      description={canEdit ? "Set one number for the year. Canon splits it into teams, reps, quarters and months; lock any number you already know and the rest rebalance." : "Your workspace's plan for the year. Admins and managers set it."}
      actions={[
        { id: "targets-back", label: canEdit ? "Cancel" : "Back to Settings", icon: <ArrowLeft className="size-3.5" />, onClick: onDone },
        ...(canEdit ? [{ id: "targets-save", label: save?.saving ? "Saving…" : "Save targets", icon: <Check className="size-3.5" />, primary: true, disabled: !save || save.disabled, onClick: () => save?.run() }] : []),
      ]}
    >{children}</ViewFrame>
  );
  if (!choices || !history || !plan) return frame(<LoadingRows count={5} />);

  const last = history.months.reduce((s, x) => s + x, 0);
  const lastByTeam = (id: string) => roster.reps.filter((r) => r.team === id).reduce((s, r) => s + (history.reps[r.id] ?? 0), 0);
  const cols = months ? monthNames.map((m, i) => ({ label: m, idx: [i] })) : [0, 1, 2, 3].map((q) => ({ label: `Q${q + 1}`, idx: [q * 3, q * 3 + 1, q * 3 + 2] }));
  const at = (vals: readonly number[], idx: number[]) => idx.reduce((s, i) => s + (vals[i] ?? 0), 0);
  const set = (f: (c: PlanChoices) => PlanChoices) => setChoices((c) => (c ? f(c) : c));
  const setLock = (level: "teams" | "reps", id: string, cents: number | null) => set((c) => {
    const locks = { ...(c[level].locks ?? {}) };
    if (cents === null) delete locks[id]; else locks[id] = cents;
    // A rep's typed year replaces quarters pasted for them.
    const quarters = level === "reps" && c.reps.quarters?.[id] ? Object.fromEntries(Object.entries(c.reps.quarters).filter(([k]) => k !== id)) : c.reps.quarters;
    return level === "reps" ? { ...c, reps: { ...c.reps, locks, quarters } } : { ...c, teams: { ...c.teams, locks } };
  });
  const profile = (id: string) => choices.reps.profiles?.[id];
  const setProfile = (id: string, p: { start?: string; rampMonths?: number } | null) => set((c) => {
    const profiles = { ...(c.reps.profiles ?? {}) };
    if (p) profiles[id] = p; else delete profiles[id];
    return { ...c, reps: { ...c.reps, profiles } };
  });
  const save = async () => {
    setSaving(true);
    try {
      await setTargets(choices);
      toast.success(`Targets for ${name(year)} saved`);
      onDone();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const ro = !canEdit;

  return frame(
    <div className="space-y-6">

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-2">
          <div className="text-sm text-foreground">Bookings target for the year</div>
          <AmountCell big readOnly={ro} value={choices.total} locked={false} onSet={(n) => set((c) => ({ ...c, total: n }))} onUnlock={() => {}} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {name(year - 1)} booked {money(last)}{last > 0 && <>, so this is {choices.total >= last ? "+" : "−"}{Math.abs(Math.round((choices.total / last - 1) * 100))}%</>}
            {canEdit && last > 0 && [1.1, 1.2, 1.3].map((g) => <button key={g} type="button" onClick={() => set((c) => ({ ...c, total: Math.round((last * g) / 10_000_00) * 10_000_00 }))} className="border border-border px-1.5 py-0.5 hover:text-foreground">+{Math.round((g - 1) * 100)}%</button>)}
          </div>
          {history.truncated && <p className="text-xs text-warning">Last year has more reps than one report reads, so its split is partial.</p>}
          <label className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
            Pipeline created target is
            <input type="number" step={0.5} min={0.5} max={20} disabled={ro} value={choices.coverage} onChange={(e) => set((c) => ({ ...c, coverage: Number(e.target.value) || 1 }))} className="w-14 border border-border bg-background px-1.5 py-0.5 text-foreground" />
            × bookings ({money(choices.total * choices.coverage)})
          </label>
        </div>
        <div className="space-y-3 text-sm">
          <Select disabled={ro} label="Spread over the year" value={choices.months.method}
            onChange={(m) => set((c) => ({ ...c, months: { method: m, custom: m === "custom" ? c.months.custom ?? plan.seasonality.map((s) => Math.round(s * 1000) / 10) : c.months.custom } }))}
            options={[["history", "Like last year"], ["even", "Evenly"], ["custom", "My own split"]]} />
          <div className="flex h-16 items-end gap-1">
            {plan.seasonality.map((s, m) => (
              <div key={m} className="flex flex-1 flex-col items-center gap-1">
                {choices.months.method === "custom" && canEdit
                  ? <input aria-label={`${monthNames[m]} weight`} value={choices.months.custom?.[m] ?? 0} onChange={(e) => set((c) => ({ ...c, months: { ...c.months, custom: (c.months.custom ?? new Array(12).fill(0)).map((x, j) => (j === m ? Math.max(0, Number(e.target.value) || 0) : x)) } }))} className="w-full border border-border bg-background px-0.5 text-center text-[11px]" />
                  : <span className="w-full bg-primary/60" style={{ height: Math.max(2, (s / Math.max(...plan.seasonality, 1e-9)) * 40) }} title={`${monthNames[m]}: ${Math.round(s * 1000) / 10}%`} />}
                <span className="text-[11px] text-muted-foreground">{monthNames[m][0]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Select disabled={ro} label="Split into teams" value={choices.teams.method === "custom" ? "history" : choices.teams.method} onChange={(m) => set((c) => ({ ...c, teams: { ...c.teams, method: m } }))} options={[["history", "Like last year"], ["even", "Evenly"]]} />
          <Select disabled={ro} label="Split teams into reps" value={choices.reps.method} onChange={(m) => set((c) => ({ ...c, reps: { ...c.reps, method: m } }))} options={[["history", "Like last year"], ["capacity", "By capacity"], ["even", "Evenly"]]} />
          <p className="text-xs text-muted-foreground">Either way, a rep who starts mid-year or is ramping gets a smaller, later target. Like last year, a new rep counts as their team’s average.</p>
        </div>
      </div>

      {plan.misfits.map((o) => (
        <p key={o.level} className="text-sm text-warning">
          {o.by > 0
            ? <>Locked amounts in {o.level === "teams" ? "the teams" : roster.teams.find((t) => t.id === o.level)?.name} exceed what it holds by {money(o.by)}. Unlock one or raise the total.</>
            : <>Every amount in {o.level === "teams" ? "the teams" : roster.teams.find((t) => t.id === o.level)?.name} is locked, leaving {money(-o.by)} unplaced. Unlock one or lower the total.</>}
        </p>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2 text-left font-normal">Team and rep</th>
              {cols.map((c) => <th key={c.label} className="py-2 pr-2 text-right font-normal">{c.label}</th>)}
              <th className="py-2 pr-6 text-right font-normal">Year</th>
              <th className="py-2 text-right font-normal">{name(year - 1)}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-2 text-foreground">Company</td>
              {cols.map((c) => <td key={c.label} className="py-2 pr-2 text-right tabular-nums">{money(at(plan.months, c.idx))}</td>)}
              <td className="py-2 pr-6 text-right tabular-nums text-foreground">{money(plan.total)}</td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">{money(last)}</td>
            </tr>
            {roster.teams.map((t) => [
              <tr key={t.id} className="border-b border-border/60 bg-muted/30">
                <td className="py-1.5 text-foreground">{t.name}</td>
                {cols.map((c) => <td key={c.label} className="py-1.5 pr-2 text-right tabular-nums">{money(at(plan.teamMonths[t.id] ?? [], c.idx))}</td>)}
                <td className="py-1.5 text-right"><AmountCell readOnly={ro} value={plan.teams[t.id] ?? 0} locked={choices.teams.locks?.[t.id] !== undefined} onSet={(n) => setLock("teams", t.id, n)} onUnlock={() => setLock("teams", t.id, null)} /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{money(lastByTeam(t.id))}</td>
              </tr>,
              ...roster.reps.filter((r) => r.team === t.id).map((r) => {
                const p = profile(r.id);
                return (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 pl-5">
                      <span className="text-foreground/90">{r.name}</span>
                      {profileOf === r.id && canEdit ? (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs">
                          <input type="month" aria-label="Start month" value={p?.start?.slice(0, 7) ?? ""} onChange={(e) => setProfile(r.id, { ...p, start: e.target.value ? `${e.target.value}-01` : undefined })} className="border border-border bg-background px-1" />
                          <input type="number" min={0} max={24} aria-label="Ramp months" value={p?.rampMonths ?? 0} onChange={(e) => setProfile(r.id, { ...p, rampMonths: Math.max(0, Number(e.target.value) || 0) })} className="w-12 border border-border bg-background px-1" /> mo ramp
                          <button type="button" onClick={() => setProfileOf(null)} className="ml-1 underline">Done</button>
                        </span>
                      ) : (
                        <button type="button" disabled={ro} onClick={() => setProfileOf(r.id)} className="ml-2 text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground">
                          {p?.start ? `starts ${CALENDAR[Number(p.start.slice(5, 7)) - 1]} ${p.start.slice(0, 4)}${p.rampMonths ? ` · ${p.rampMonths}-month ramp` : ""}` : canEdit ? "set start and ramp" : ""}
                        </button>
                      )}
                      {choices.reps.quarters?.[r.id] && <span className="ml-2 text-xs text-muted-foreground">quarters pasted</span>}
                    </td>
                    {cols.map((c) => <td key={c.label} className="py-1.5 pr-2 text-right tabular-nums text-foreground/80">{money(at(plan.repMonths[r.id] ?? [], c.idx))}</td>)}
                    <td className="py-1.5 text-right"><AmountCell readOnly={ro} value={plan.reps[r.id] ?? 0} locked={choices.reps.locks?.[r.id] !== undefined || Boolean(choices.reps.quarters?.[r.id])} onSet={(n) => setLock("reps", r.id, n)} onUnlock={() => setLock("reps", r.id, null)} /></td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{money(history.reps[r.id] ?? 0)}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <button type="button" onClick={() => setMonths((m) => !m)} className="underline">{months ? "Show quarters" : "Show months"}</button>
          {canEdit && <span>Type a year amount to lock it. Unlocked numbers rebalance so every level adds up.</span>}
        </div>
      </div>

      {canEdit && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="text-sm text-foreground">Paste numbers you already have</div>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} placeholder={"Copy rows from a spreadsheet: a name, then an amount, or four quarters and a total.\nMaya Chen\t$1,100,000\nJordan Patel\t200k\t250k\t300k\t350k\t1.1M\nEnterprise, 2.2M"} className="w-full border border-border bg-background p-2 font-mono text-xs outline-none focus:border-foreground/50" />
            <button type="button" disabled={!paste.trim()} onClick={() => {
              const reps = parseTargets(paste, roster.reps);
              const teams = parseTargets(reps.unmatched.join("\n"), roster.teams);
              const cents = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v * 100]));
              const quarters = Object.fromEntries(Object.entries(reps.quarters).map(([k, q]) => [k, q.map((v) => v * 100)]));
              set((c) => ({
                ...c,
                teams: { ...c.teams, locks: { ...(c.teams.locks ?? {}), ...cents(teams.amounts) } },
                reps: { ...c.reps, locks: { ...(c.reps.locks ?? {}), ...cents(reps.amounts) }, quarters: { ...(c.reps.quarters ?? {}), ...quarters } },
              }));
              const n = Object.keys(reps.amounts).length + Object.keys(teams.amounts).length;
              setPasted(`Locked ${n} number${n === 1 ? "" : "s"}.${teams.unmatched.length ? ` Could not place: ${teams.unmatched.join("; ")}` : ""}`);
            }} className="border border-border px-2 py-1 text-xs disabled:opacity-50">Apply</button>
            {pasted && <p className="text-xs text-muted-foreground">{pasted}</p>}
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="text-foreground">Where these go</div>
            <p>Reports reads this plan for any month, quarter, team or rep, so a filtered chart always has its own target line. Other fields, like deal type, get their share of the last twelve months, marked as estimated.</p>
          </div>
        </div>
      )}
    </div>,
    { run: () => void save(), disabled: saving || plan.misfits.length > 0, saving },
  );
}
