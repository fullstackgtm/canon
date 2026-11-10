/**
 * Targets, entered top down: one number for the year, split into teams and
 * then reps, each rep's share spread over the months by seasonality and ramp.
 * Any team or rep amount can be locked; its siblings rebalance so every level
 * still adds up to the one above it. Every level rolls up from the reps, so a
 * month, a quarter, a team or a rep reads the same plan. Pure.
 */
import { dayOf, monthStart, type Period } from "./pacing.ts";

export type Team = { id: string; name: string };
/** `start` is the day they started (ramp counts from its month); `rampMonths` is how long until full productivity. */
export type Rep = { id: string; name: string; team: string; start?: string; rampMonths?: number };

export type SplitMethod = "even" | "history" | "custom" | "capacity";

export type PlanInput = {
  /** A fiscal year; its months (0-11) start in month `fyStart` (1-12), January when absent. */
  year: number;
  fyStart?: number;
  total: number;
  /** How the year spreads over its months: even, like last year, or custom weights (12). */
  months: { method: "even" | "history" | "custom"; custom?: number[] };
  teams: { method: "even" | "history" | "custom"; custom?: Record<string, number>; locks?: Record<string, number> };
  /** `quarters` sets a rep's four quarters outright (their year is the sum, locked); the months inside follow. */
  reps: { method: "even" | "history" | "capacity"; locks?: Record<string, number>; quarters?: Record<string, number[]> };
  /** Last year's actuals: by month (12), by team and by rep. */
  history: { months: readonly number[]; teams: Record<string, number>; reps: Record<string, number> };
  teamList: readonly Team[];
  repList: readonly Rep[];
};

export type Plan = {
  year: number;
  fyStart?: number;
  total: number;
  /** The month weights the year was spread by, summing to 1. */
  seasonality: number[];
  teams: Record<string, number>;
  reps: Record<string, number>;
  /** Each rep's target by month (12). */
  repMonths: Record<string, number[]>;
  teamMonths: Record<string, number[]>;
  /** The company's target by month, rolled up from the teams. */
  months: number[];
  /**
   * Levels whose locks do not fit what they hold (`level` is "teams" or a team id): `by` > 0 when the locked amounts
   * exceed it by that much, `by` < 0 when every part is locked and -`by` is left unplaced. A plan with any is not saved.
   */
  misfits: { level: "teams" | string; by: number }[];
};

/**
 * Splits `total` into whole units: a locked key keeps its amount, the rest shares what is left by weight (evenly
 * when every weight is 0). Amounts sum exactly to `total` unless the locks alone exceed it.
 */
export function allocate(total: number, weights: Record<string, number>, locks: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  const free = Object.keys(weights).filter((k) => locks[k] === undefined);
  let left = total;
  for (const k of Object.keys(weights)) {
    if (locks[k] !== undefined) {
      out[k] = Math.round(locks[k]);
      left -= out[k];
    }
  }
  left = Math.max(0, Math.round(left));
  const sum = free.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  const raw = free.map((k) => ({ k, v: sum > 0 ? (left * Math.max(0, weights[k])) / sum : left / free.length }));
  let rest = left - raw.reduce((s, r) => s + Math.floor(r.v), 0);
  // Largest remainder: the units rounding lost go to the parts that lost the most.
  for (const r of [...raw].sort((a, b) => (b.v % 1) - (a.v % 1))) {
    out[r.k] = Math.floor(r.v) + (rest > 0 ? 1 : 0);
    rest--;
  }
  return out;
}

/** How productive a rep is in month `m` (0-11) of fiscal `year`: 0 before they start, rising to 1 over their ramp. */
export function productivity(rep: Rep, year: number, m: number, fyStart = 1): number {
  if (!rep.start) return 1;
  const [y, mm] = rep.start.split("-").map(Number);
  const [cy, cm] = monthStart(year, m, fyStart).split("-").map(Number);
  const k = (cy - y) * 12 + (cm - mm);
  if (k < 0) return 0;
  const ramp = rep.rampMonths ?? 0;
  return ramp <= 0 ? 1 : Math.min(1, (k + 1) / (ramp + 1));
}

const byKey = <T,>(keys: readonly string[], f: (k: string) => T) => Object.fromEntries(keys.map((k) => [k, f(k)]));
const sumOf = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** A saved plan's choices (convex/lib/reports/validators.ts targetPlanChoices). */
export type PlanChoices = {
  year: number;
  total: number;
  coverage: number;
  months: PlanInput["months"];
  teams: PlanInput["teams"];
  reps: PlanInput["reps"] & { profiles?: Record<string, { start?: string; rampMonths?: number }> };
};
export type Roster = { teams: readonly Team[]; reps: readonly { id: string; name: string; team: string }[] };

/** What buildPlan splits: the choices, over today's roster, against last year's bookings by month and rep. */
export function planInput(c: PlanChoices, roster: Roster, history: { months: readonly number[]; reps: Record<string, number> }, fyStart = 1): PlanInput {
  const teams: Record<string, number> = {};
  for (const r of roster.reps) teams[r.team] = (teams[r.team] ?? 0) + (history.reps[r.id] ?? 0);
  return {
    year: c.year, fyStart, total: c.total, months: c.months, teams: c.teams,
    reps: { method: c.reps.method, locks: c.reps.locks, quarters: c.reps.quarters },
    history: { months: history.months, teams, reps: history.reps },
    teamList: roster.teams,
    repList: roster.reps.map((r) => ({ id: r.id, name: r.name, team: r.team, ...c.reps.profiles?.[r.id] })),
  };
}

export function buildPlan(input: PlanInput): Plan {
  const { year, fyStart = 1, total, history } = input;
  const mw = input.months.method === "custom" && input.months.custom?.length === 12 ? [...input.months.custom]
    : input.months.method === "history" && sumOf(history.months) > 0 ? [...history.months] : new Array(12).fill(1);
  const seasonality = mw.map((w) => w / sumOf(mw));
  const misfits: Plan["misfits"] = [];

  const teamIds = input.teamList.map((t) => t.id);
  const teamWeights = byKey(teamIds, (id) => input.teams.method === "custom" ? input.teams.custom?.[id] ?? 0 : input.teams.method === "history" ? history.teams[id] ?? 0 : 1);
  const teamLocks = input.teams.locks ?? {};
  const lockedTeams = sumOf(Object.values(teamLocks));
  if (lockedTeams > total) misfits.push({ level: "teams", by: lockedTeams - total });
  else if (teamIds.length && teamIds.every((id) => teamLocks[id] !== undefined) && lockedTeams < total) misfits.push({ level: "teams", by: lockedTeams - total });
  const teams = allocate(total, teamWeights, teamLocks);

  // A rep's capacity: the share of the year's seasonal weight they are productive for.
  const capacity = (r: Rep) => seasonality.reduce((s, w, m) => s + w * productivity(r, year, m, fyStart), 0);
  const reps: Record<string, number> = {};
  const repMonths: Record<string, number[]> = {};
  const teamMonths: Record<string, number[]> = {};
  const quarters = input.reps.quarters ?? {};
  const repLocks = { ...(input.reps.locks ?? {}), ...Object.fromEntries(Object.entries(quarters).map(([id, q]) => [id, sumOf(q)])) };
  for (const t of input.teamList) {
    const members = input.repList.filter((r) => r.team === t.id);
    const known = members.filter((r) => (history.reps[r.id] ?? 0) > 0);
    const avg = known.length ? sumOf(known.map((r) => history.reps[r.id])) / known.length : 1;
    const weight = (r: Rep) => input.reps.method === "even" ? 1 : input.reps.method === "capacity" ? capacity(r)
      // A rep with no history counts as the team's average, scaled by how much of the year they can sell.
      : (history.reps[r.id] ?? 0) > 0 ? history.reps[r.id] : avg * capacity(r);
    const locks = Object.fromEntries(members.filter((r) => repLocks[r.id] !== undefined).map((r) => [r.id, repLocks[r.id]]));
    const lockedReps = sumOf(Object.values(locks));
    if (lockedReps > teams[t.id]) misfits.push({ level: t.id, by: lockedReps - teams[t.id] });
    else if (members.length && members.every((r) => locks[r.id] !== undefined) && lockedReps < teams[t.id]) misfits.push({ level: t.id, by: lockedReps - teams[t.id] });
    Object.assign(reps, allocate(teams[t.id], byKey(members.map((r) => r.id), (id) => weight(members.find((r) => r.id === id)!)), locks));
    for (const r of members) {
      const ramped = seasonality.map((w, m) => w * productivity(r, year, m, fyStart));
      const spread = (amount: number, months: number[]) => {
        const split = allocate(amount, byKey(months.map(String), (m) => ramped[Number(m)]));
        return months.map((m) => split[String(m)]);
      };
      const q = quarters[r.id];
      repMonths[r.id] = q?.length === 4 ? [0, 1, 2, 3].flatMap((i) => spread(q[i], [i * 3, i * 3 + 1, i * 3 + 2])) : spread(reps[r.id], ramped.map((_, m) => m));
    }
    teamMonths[t.id] = members.length
      ? seasonality.map((_, m) => sumOf(members.map((r) => repMonths[r.id][m])))
      : (() => { const s = allocate(teams[t.id], byKey(seasonality.map((_, m) => String(m)), (m) => seasonality[Number(m)])); return seasonality.map((_, m) => s[String(m)]); })();
  }
  const months = seasonality.map((_, m) => sumOf(teamIds.map((id) => teamMonths[id][m])));
  return { year, fyStart, total, seasonality, teams, reps, repMonths, teamMonths, months, misfits };
}

/**
 * The target for `p` (a month, quarter or year), for the chosen teams and reps (none chosen means all). Null when the
 * plan does not cover the period or none of the chosen teams and reps. A rep filter wins over a team filter: the reps are the finer cut.
 */
export function targetFor(plan: Plan, p: Period, filter: { teams?: readonly string[]; reps?: readonly string[] } = {}): number | null {
  const months = Array.from({ length: 12 }, (_, m) => m).filter((m) => dayOf(monthStart(plan.year, m, plan.fyStart), p) >= 0);
  if (!months.length) return null;
  const rows = filter.reps?.length ? filter.reps.map((id) => plan.repMonths[id]).filter(Boolean)
    : filter.teams?.length ? filter.teams.map((id) => plan.teamMonths[id]).filter(Boolean) : [plan.months];
  // Reps or teams the plan never split into (no owner, someone added since) have no target, not a target of 0.
  if (!rows.length) return null;
  return sumOf(rows.map((r) => sumOf(months.map((m) => r[m]))));
}

/** An amount as people type it: "1200000", "$1,200,000", "1.2M", "450k". Null when it is not one. */
export function parseAmount(text: string): number | null {
  const m = /^\$?([\d.,]+)([kKmM]?)$/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Bottom-up numbers pasted from a spreadsheet: one row per rep or team, its name first and its amount last
 * ("Maya Chen<TAB>$1,200,000" or "Enterprise, 2.4M"), or a rep's four quarters (and an optional total) after the name. Names match case-insensitively, on the full name or a unique
 * first name. Returns the amounts by id and the rows it could not place.
 */
export function parseTargets(text: string, named: readonly { id: string; name: string }[]): { amounts: Record<string, number>; quarters: Record<string, number[]>; unmatched: string[] } {
  const amounts: Record<string, number> = {};
  const quarters: Record<string, number[]> = {};
  const unmatched: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    // A spreadsheet row: the first cell names it and its last number is the amount (a Total column). Typed text:
    // a name, then an amount.
    const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
    const pair = cells.length > 1 ? [cells[0], [...cells].reverse().find((c) => /\d/.test(c)) ?? ""]
      : /^(.+?)\s*[,;:]?\s*(\$?\s*\d[\d.,]*\s*[kKmM]?)$/.exec(line)?.slice(1, 3) ?? ["", ""];
    const amount = parseAmount(pair[1]);
    if (!pair[0] || amount === null) { unmatched.push(line); continue; }
    const name = pair[0].toLowerCase();
    const full = named.filter((n) => n.name.toLowerCase() === name);
    const first = named.filter((n) => n.name.toLowerCase().split(" ")[0] === name);
    const hit = full.length === 1 ? full[0] : first.length === 1 ? first[0] : null;
    if (!hit) { unmatched.push(line); continue; }
    amounts[hit.id] = amount;
    // Four or five amounts after the name are Q1 to Q4 (and a total): the rep's quarters, summing to their year.
    const nums = cells.slice(1).map(parseAmount);
    if ((nums.length === 4 || nums.length === 5) && nums.every((n) => n !== null)) {
      quarters[hit.id] = (nums as number[]).slice(0, 4);
      amounts[hit.id] = sumOf(quarters[hit.id]);
    }
  }
  return { amounts, quarters, unmatched };
}
