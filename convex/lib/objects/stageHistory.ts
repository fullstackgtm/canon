/**
 * Stage history and time in stage (CP9), from the ledger. A deal's stream is
 * folded entry by entry, as the projection folds it, and every change of the
 * projected stage opens a visit. A deal's history starts when Canon first saw
 * it: an imported deal's earlier stages, before its first snapshot, are not in
 * the ledger. Pure, so the action and the tests read one definition.
 */
import { fold, project, type FoldState, type LedgerEntry } from "./fold.ts";
import type { ResolvedObjectDef } from "./registry.ts";

/** One stay in a stage: when the deal entered it, and when it left (null while it is still there). */
export type StageVisit = { stage: string | null; enteredAt: number; leftAt: number | null };

/** A deal's stage visits, oldest first. `entries` are its stream's, in version order. A deleted deal has none. */
export function stageVisits(def: ResolvedObjectDef, entries: readonly LedgerEntry[]): StageVisit[] {
  const stageId = def.byApiName.get("stage")?.fieldId;
  if (!stageId) return [];
  let state: FoldState | null = null;
  const visits: StageVisit[] = [];
  for (const e of entries) {
    state = fold(state, e);
    const raw = project(def, state).values[stageId];
    const stage = typeof raw === "string" && raw ? raw : null;
    const last = visits[visits.length - 1];
    // A deal saved before its stage is set has no stage yet, not a stay in "no stage"; clearing a stage later is one.
    if (last ? last.stage === stage : stage === null) continue;
    if (last) last.leftAt = e.observedAt;
    visits.push({ stage, enteredAt: e.observedAt, leftAt: null });
  }
  return state && state.lifecycle.status === "active" ? visits : [];
}

const DAY = 86_400_000;

/** Per stage: how many deals entered it, how long finished stays lasted, and the deals in it now and for how long. */
export type StageRow = { stage: string | null; entered: number; left: number; avgDays: number | null; medianDays: number | null; current: number; currentAvgDays: number | null };
export type StageHistoryReport = {
  stages: StageRow[];
  /** Entries into each stage per month (the month's first day, UTC), oldest first. */
  byMonth: { month: string; stage: string | null; entered: number }[];
  deals: number;
  /** Whether the ledger had more deal entries than one run reads; the report covers the oldest of them. */
  partial: boolean;
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const monthOf = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

export function stageHistoryReport(deals: readonly StageVisit[][], now: number, partial = false): StageHistoryReport {
  const rows = new Map<string, { stage: string | null; done: number[]; open: number[]; entered: number }>();
  const months = new Map<string, { month: string; stage: string | null; entered: number }>();
  for (const visits of deals) {
    for (const v of visits) {
      const key = JSON.stringify(v.stage);
      const row = rows.get(key) ?? { stage: v.stage, done: [], open: [], entered: 0 };
      row.entered++;
      if (v.leftAt === null) row.open.push((now - v.enteredAt) / DAY);
      else row.done.push((v.leftAt - v.enteredAt) / DAY);
      rows.set(key, row);
      const mk = `${monthOf(v.enteredAt)}|${key}`;
      const m = months.get(mk) ?? { month: monthOf(v.enteredAt), stage: v.stage, entered: 0 };
      m.entered++;
      months.set(mk, m);
    }
  }
  return {
    stages: [...rows.values()].map((r) => ({ stage: r.stage, entered: r.entered, left: r.done.length, avgDays: avg(r.done), medianDays: median(r.done), current: r.open.length, currentAvgDays: avg(r.open) })),
    byMonth: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
    deals: deals.filter((v) => v.length).length,
    partial,
  };
}
