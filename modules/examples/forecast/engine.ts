/**
 * The Forecast module's engine (docs/module-plans/forecast.md §6): pure functions over the deals, members, calls and
 * history a call reads. No clock but the `now` it is given, money in minor units (cents), exact. Golden-tested
 * against §12 in tests/forecastEngine.test.ts.
 */

/** A deal as the module reads it (`reads.deals`). Amounts are minor units. */
export type Deal = {
  id: string; name?: string; amount?: number | null; closeDate?: string | null; stage?: string | null;
  forecastCategory?: string | null; isClosed?: boolean; isWon?: boolean; ownerId?: string | null; nextStep?: string | null;
};
/** Where a deal stands for the forecast. `lost` only where a move or flow needs it; numbers count it as `omit`. */
export type Category = "won" | "commit" | "best_case" | "pipeline" | "omit";
export type Standing = Category | "lost";

/** Canon's deal category as the forecast buckets it: won, commit, best case, pipeline; closed lost and omit count nowhere. */
export function categoryOf(d: Deal): Category {
  if (d.isWon || d.forecastCategory === "closed_won") return "won";
  if (d.isClosed || d.forecastCategory === "closed_lost" || d.forecastCategory === "omit") return "omit";
  if (d.forecastCategory === "commit" || d.forecastCategory === "best_case") return d.forecastCategory;
  return "pipeline";
}
/** categoryOf, with a closed deal that wasn't won as `lost`. */
export const standingOf = (d: Deal): Standing => (d.isClosed && !d.isWon && d.forecastCategory !== "closed_won" ? "lost" : categoryOf(d));
const RANK: Record<Standing, number> = { lost: -1, omit: 0, pipeline: 1, best_case: 2, commit: 3, won: 4 };

export type Numbers = { won: number; commit: number; bestCase: number; pipeline: number; openCount: number };
const zero = (): Numbers => ({ won: 0, commit: 0, bestCase: 0, pipeline: 0, openCount: 0 });
const add = (a: Numbers, b: Numbers): Numbers => ({ won: a.won + b.won, commit: a.commit + b.commit, bestCase: a.bestCase + b.bestCase, pipeline: a.pipeline + b.pipeline, openCount: a.openCount + b.openCount });

/**
 * Each member's own system numbers from in-period deals, cumulative as in Clari and Salesforce: Commit = won + commit,
 * Best case = Commit + best case. Pipeline is its own. A deal no member owns counts under `null` (the "Unassigned" row).
 */
export function systemNumbers(deals: readonly Deal[], members: readonly string[]): Map<string | null, Numbers> {
  const out = new Map<string | null, Numbers>(members.map((m) => [m, zero()]));
  for (const d of deals) {
    const owner = d.ownerId && out.has(d.ownerId) ? d.ownerId : null;
    const n = out.get(owner) ?? zero();
    const amount = d.amount ?? 0, c = categoryOf(d);
    if (c === "won") { n.won += amount; n.commit += amount; n.bestCase += amount; }
    else if (c === "commit") { n.commit += amount; n.bestCase += amount; n.openCount += 1; }
    else if (c === "best_case") { n.bestCase += amount; n.openCount += 1; }
    else if (c === "pipeline") { n.pipeline += amount; n.openCount += 1; }
    out.set(owner, n);
  }
  return out;
}

export type Member = { id: string; name?: string; managerId?: string | null };
export type Team = { id: string; managerId?: string | null; memberIds: readonly string[] };
/**
 * Each member's parent: their `managerId`, else the manager of the first team (by the order given) that lists them.
 * A cycle is refused with the members on it named, since a wrong tree gives wrong numbers silently.
 */
export function tree(members: readonly Member[], teams: readonly Team[]): Map<string, string | null> {
  const ids = new Set(members.map((m) => m.id));
  const parent = new Map<string, string | null>();
  for (const m of members) {
    let p = m.managerId && ids.has(m.managerId) ? m.managerId : null;
    if (!p) p = teams.find((t) => t.memberIds.includes(m.id) && t.managerId && t.managerId !== m.id && ids.has(t.managerId))?.managerId ?? null;
    parent.set(m.id, p);
  }
  for (const m of members) {
    const seen: string[] = [];
    for (let at: string | null = m.id; at; at = parent.get(at) ?? null) {
      if (seen.includes(at)) {
        const names = seen.slice(seen.indexOf(at)).map((id) => members.find((x) => x.id === id)?.name ?? id);
        throw new Error(`The manager chain loops: ${names.join(" → ")} → ${names[0]}. Fix it in Settings > Team.`);
      }
      seen.push(at);
    }
  }
  return parent;
}

export type Submission = { member: string; call: number; upside?: number | null };
export type Adjustment = { by: string; member: string; field: "call" | "upside"; to: number; at?: number };
export type RollupRow = Numbers & {
  member: string; parent: string | null; target: number;
  /** The member's own call, if they submitted. */
  call: number | null;
  /** Their call as their manager sees it: the manager's latest adjustment, else their own. */
  adjustedCall: number | null; adjusted: boolean;
  /** The sum of their direct reports' calls after this member's adjustments (Adjust rollup), and before (Team rollup). */
  reportsCall: number; reportsCallUnadjusted: number;
  gap: number; coverage: number | null; commitShare: number | null;
};

/** The adjustment `by` made to `member`'s `field`, latest first. */
function adjustmentOf(adjs: readonly Adjustment[], by: string | null, member: string, field: "call" | "upside") {
  if (!by) return null;
  const mine = adjs.filter((a) => a.by === by && a.member === member && a.field === field);
  return mine.length ? mine.reduce((a, b) => ((b.at ?? 0) >= (a.at ?? 0) ? b : a)) : null;
}

/**
 * Every member's rollup for one week: their subtree's system numbers and targets, their call, their reports' calls
 * after their own adjustments, gap to go (target − won), coverage (call ÷ target) and commit share (commit ÷ call).
 */
export function rollup(parent: ReadonlyMap<string, string | null>, numbers: ReadonlyMap<string | null, Numbers>, submissions: readonly Submission[], adjustments: readonly Adjustment[], targets: ReadonlyMap<string, number>): Map<string, RollupRow> {
  const children = new Map<string, string[]>();
  for (const [m, p] of parent) if (p) children.set(p, [...(children.get(p) ?? []), m]);
  const callOf = new Map(submissions.map((s) => [s.member, s.call]));
  const out = new Map<string, RollupRow>();
  const visit = (m: string): RollupRow => {
    const done = out.get(m);
    if (done) return done;
    const kids = (children.get(m) ?? []).map(visit);
    const own = numbers.get(m) ?? zero();
    const sum = kids.reduce((a, k) => add(a, k), own);
    const target = kids.reduce((n, k) => n + k.target, targets.get(m) ?? 0);
    const call = callOf.has(m) ? callOf.get(m)! : null;
    const adj = adjustmentOf(adjustments, parent.get(m) ?? null, m, "call");
    const reportsCall = kids.reduce((n, k) => n + (k.adjustedCall ?? 0), 0);
    const reportsCallUnadjusted = kids.reduce((n, k) => n + (k.call ?? 0), 0);
    const row: RollupRow = {
      ...sum, member: m, parent: parent.get(m) ?? null, target, call,
      adjustedCall: adj ? adj.to : call, adjusted: adj !== null, reportsCall, reportsCallUnadjusted,
      gap: target - sum.won, coverage: call !== null && target > 0 ? call / target : null, commitShare: call ? sum.commit / call : null,
    };
    out.set(m, row);
    return row;
  };
  for (const m of parent.keys()) visit(m);
  return out;
}

/** A deal at two times, and every close date it held in between, in order (deals.changesBetween). */
export type DealChange = { id: string; before: Deal | null; after: Deal | null; closeDates?: readonly string[] };
export type Period = { start: string; end: string };
const inPeriod = (d: Deal | null, p: Period) => !!d && !!d.closeDate && d.closeDate >= p.start && d.closeDate <= p.end;
/** In the period's amount: open or won deals closing in it. */
const counts = (d: Deal | null, p: Period): d is Deal => inPeriod(d, p) && standingOf(d!) !== "lost" && standingOf(d!) !== "omit";

export type MoveBucket = "new" | "moved_in" | "increased" | "decreased" | "slipped" | "moved_out" | "lost";
export type Moves = {
  start: number; end: number;
  buckets: Record<MoveBucket, { amount: number; deals: Array<{ id: string; amount: number }> }>;
  /** Won in the window: it stays in the period's amount, so it isn't a step. */
  won: { amount: number; deals: Array<{ id: string; amount: number }> };
  /** A close date moved earlier, staying in the period. */
  pulledIn: Array<{ id: string; from: string; to: string }>;
  categoryMoves: Array<{ id: string; from: Standing; to: Standing; amount: number }>;
};

/**
 * What moved in the period's amount between two snapshots: each deal in it at either end falls in one step, and
 * start + the signed steps = end, checked. Category moves list every deal whose standing changed.
 */
export function moves(changes: readonly DealChange[], period: Period): Moves {
  const buckets = Object.fromEntries((["new", "moved_in", "increased", "decreased", "slipped", "moved_out", "lost"] as const).map((b) => [b, { amount: 0, deals: [] as Array<{ id: string; amount: number }> }])) as Moves["buckets"];
  const put = (b: MoveBucket, id: string, amount: number) => { buckets[b].amount += amount; buckets[b].deals.push({ id, amount }); };
  const out: Moves = { start: 0, end: 0, buckets, won: { amount: 0, deals: [] }, pulledIn: [], categoryMoves: [] };
  for (const c of changes) {
    const was = counts(c.before, period) ? c.before : null, is = counts(c.after, period) ? c.after : null;
    const a0 = was?.amount ?? 0, a1 = is?.amount ?? 0;
    out.start += a0; out.end += a1;
    if (was && is) {
      if (a1 > a0) put("increased", c.id, a1 - a0);
      if (a1 < a0) put("decreased", c.id, a1 - a0);
      if (c.before!.closeDate! > c.after!.closeDate!) out.pulledIn.push({ id: c.id, from: c.before!.closeDate!, to: c.after!.closeDate! });
    } else if (was) {
      if (c.after && standingOf(c.after) === "lost") put("lost", c.id, -a0);
      else if (c.after && inPeriod(c.after, period)) put("lost", c.id, -a0);
      else if (c.after && c.after.closeDate && c.after.closeDate > period.end) put("slipped", c.id, -a0);
      else put("moved_out", c.id, -a0);
    } else if (is) put(c.before ? "moved_in" : "new", c.id, a1);
    if (c.before && c.after && (inPeriod(c.before, period) || inPeriod(c.after, period))) {
      const from = standingOf(c.before), to = standingOf(c.after);
      if (from !== to) out.categoryMoves.push({ id: c.id, from, to, amount: to === "lost" ? (c.before.amount ?? 0) : (c.after.amount ?? 0) });
      if (to === "won" && from !== "won" && is) { out.won.amount += a1; out.won.deals.push({ id: c.id, amount: a1 }); }
    }
  }
  const steps = Object.values(buckets).reduce((n, b) => n + b.amount, 0);
  if (out.start + steps !== out.end) throw new Error(`What moved doesn't add up: ${out.start} + ${steps} ≠ ${out.end}.`);
  return out;
}

export type FlowEnd = "won" | "upgraded" | "downgraded" | "idle" | "slipped" | "lost";
export type Flow = {
  from: Category; start: { amount: number; deals: number };
  ends: Record<FlowEnd, { amount: number; deals: string[] }>;
  into: Array<{ id: string; from: Standing | "new"; amount: number }>;
};

/** Where the deals of one category in the period at the start went by the end, and which deals came into it. */
export function flow(changes: readonly DealChange[], period: Period, from: Category): Flow {
  const ends = Object.fromEntries((["won", "upgraded", "downgraded", "idle", "slipped", "lost"] as const).map((e) => [e, { amount: 0, deals: [] as string[] }])) as Flow["ends"];
  const out: Flow = { from, start: { amount: 0, deals: 0 }, ends, into: [] };
  for (const c of changes) {
    const startIn = counts(c.before, period) && categoryOf(c.before!) === from;
    if (startIn) {
      const amount = c.before!.amount ?? 0;
      out.start.amount += amount; out.start.deals += 1;
      const to = c.after ? standingOf(c.after) : "lost";
      const end: FlowEnd = to === "lost" ? "lost" : !inPeriod(c.after, period) ? "slipped" : to === "won" && from !== "won" ? "won"
        : RANK[to] > RANK[from] ? "upgraded" : RANK[to] < RANK[from] ? "downgraded" : "idle";
      ends[end].amount += amount; ends[end].deals.push(c.id);
    } else if (counts(c.after, period) && categoryOf(c.after!) === from) {
      out.into.push({ id: c.id, from: c.before ? standingOf(c.before) : "new", amount: c.after!.amount ?? 0 });
    }
  }
  return out;
}

export type RiskRule = "no_activity" | "overdue" | "stalled" | "pushed" | "amount_down" | "category_down" | "single_threaded" | "no_next_step";
export type Risk = { rule: RiskRule; severity: "high" | "medium" | "low"; evidence: string };
export type RiskSettings = { noActivityDays: number; stalledDays: Record<string, number>; pushesFlag: number; amountDropPct: number; minContacts: number };
export const DEFAULT_RISK_SETTINGS: RiskSettings = { noActivityDays: 14, stalledDays: {}, pushesFlag: 2, amountDropPct: 0.1, minContacts: 2 };
/** One version of a deal in its history window, oldest first: when it started and its fields then. */
export type Version = { at: number; amount?: number | null; closeDate?: string | null; forecastCategory?: string | null; stage?: string | null; isClosed?: boolean; isWon?: boolean };
export type ActivityRef = { at: number; personId?: string | null };

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Whole currency units with separators, as evidence quotes them: $200,000. */
export const dollars = (minor: number) => `${minor < 0 ? "−" : ""}$${Math.round(Math.abs(minor) / 100).toLocaleString("en-US")}`;

/**
 * A deal's risk flags from its history window (oldest version first), its activities and settings, each with evidence
 * built only from the values read, so it can be checked verbatim. Closed deals have none.
 */
export function risksOf(deal: Deal, history: readonly Version[], activities: readonly ActivityRef[], settings: RiskSettings, now: number): Risk[] {
  if (deal.isClosed || deal.isWon) return [];
  const out: Risk[] = [];
  const today = isoDay(now);
  const last = activities.reduce<number | null>((m, a) => (m === null || a.at > m ? a.at : m), null);
  if (last === null) out.push({ rule: "no_activity", severity: "medium", evidence: "No activity logged on this deal." });
  else if (now - last >= settings.noActivityDays * DAY) out.push({ rule: "no_activity", severity: "medium", evidence: `No activity since ${isoDay(last)} (${Math.floor((now - last) / DAY)} days)` });
  if (deal.closeDate && deal.closeDate < today) out.push({ rule: "overdue", severity: "high", evidence: `Close date ${deal.closeDate} has passed` });
  const stalled = deal.stage ? settings.stalledDays[deal.stage] : undefined;
  if (stalled !== undefined && history.length) {
    let since = history[history.length - 1].at;
    for (let i = history.length - 1; i > 0 && history[i - 1].stage === deal.stage; i--) since = history[i - 1].at;
    const days = Math.floor((now - since) / DAY);
    if (days >= stalled) out.push({ rule: "stalled", severity: "medium", evidence: `In ${deal.stage} for ${days} days` });
  }
  // Every close date the deal held, in order, without repeats: a push is a later date than the one before.
  const dates = history.map((v) => v.closeDate).filter((x): x is string => !!x).filter((x, i, a) => i === 0 || a[i - 1] !== x);
  const pushes = dates.filter((x, i) => i > 0 && x > dates[i - 1]).length;
  if (pushes >= settings.pushesFlag) out.push({ rule: "pushed", severity: "high", evidence: `Close date moved ${dates.join(" → ")}` });
  const amounts = history.map((v) => v.amount).filter((x): x is number => typeof x === "number");
  const peak = amounts.length ? Math.max(...amounts) : null, now$ = deal.amount ?? null;
  if (peak !== null && now$ !== null && peak > 0 && (peak - now$) / peak >= settings.amountDropPct - 1e-12) {
    out.push({ rule: "amount_down", severity: "medium", evidence: `Amount ${dollars(peak)} → ${dollars(now$)} (−${Math.round(((peak - now$) / peak) * 100)}%)` });
  }
  // Only samples that hold a category: an amount or close date alone would read as pipeline.
  const cats = history.filter((v) => v.forecastCategory != null || v.isClosed !== undefined).map((v) => categoryOf({ id: deal.id, ...v }));
  const top = cats.reduce<Category | null>((m, c) => (m === null || RANK[c] > RANK[m] ? c : m), null);
  const cur = categoryOf(deal);
  if (top && RANK[cur] < RANK[top]) out.push({ rule: "category_down", severity: "high", evidence: `Category moved down from ${top} to ${cur}` });
  const contacts = new Set(activities.map((a) => a.personId).filter(Boolean)).size;
  if (contacts < settings.minContacts) out.push({ rule: "single_threaded", severity: "medium", evidence: contacts ? "Only one contact engaged" : "No contacts engaged" });
  // Only when the deal's next step was read: a module not granted it can't tell an empty one from an unread one.
  if ("nextStep" in deal && !deal.nextStep?.trim()) out.push({ rule: "no_next_step", severity: "low", evidence: "No next step" });
  return out;
}

/** A member's call at a week against what closed: error = call − actual, accuracy = 1 − |error| ÷ actual. */
export function accuracyOf(call: number, actual: number) {
  const error = call - actual;
  return { call, actual, error, accuracy: actual > 0 ? 1 - Math.abs(error) / actual : null };
}
