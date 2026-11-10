/**
 * Forecast (docs/module-plans/forecast.md): each person's call for the period, rolled up their manager chain beside
 * Canon's own numbers from the deals closing in it. The arithmetic is engine.ts, golden-tested; this file reads,
 * shapes and writes. Periods are the workspace's fiscal quarters (the kit's pacing.ts, bundled).
 */
import type { CallContext, CallFunctions, Intent, ReadDoc, RecordChange } from "../../kernel/calls.ts";
import { lastDay, periodOf, shiftPeriod } from "../../kernel/pacing.ts";
import { accuracyOf, categoryOf, DEFAULT_RISK_SETTINGS, dollars, flow, moves, risksOf, rollup, standingOf, systemNumbers, tree, type Adjustment, type Deal, type DealChange, type Member, type Submission, type Team, type Version } from "./engine.ts";

type Settings = { cadenceDay: number };
const DEFAULTS: Settings = { cadenceDay: 1 };
const settingsOf = (doc: ReadDoc | null | undefined): Settings => ({ ...DEFAULTS, ...((doc?.data ?? {}) as Partial<Settings>) });
const today = (ctx: CallContext) => new Date(ctx.now).toISOString().slice(0, 10);

/** The week a day falls in, named by its first day: the last `cadenceDay` (1 Monday … 7 Sunday) on or before it. */
export function weekOf(day: string, cadenceDay: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const iso = ((d.getUTCDay() + 6) % 7) + 1;
  d.setUTCDate(d.getUTCDate() - ((iso - cadenceDay + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/** A fiscal quarter as a period doc's data: its key ("2026-Q4"), label, first and last day. */
function quarterOf(day: string, fyStart: number) {
  const p = periodOf(day, "quarter", fyStart);
  return { period: p.key, label: p.label, start: p.start, end: lastDay(p) };
}

type Row = ReturnType<typeof rollup> extends Map<string, infer R> ? R : never;
/** Where a member's row sits: the period and week it is for, whether it is a report of the reader, and their submission's key. */
type Place = { period: string; week: string; rootId: string; callerId: string; parent: ReadonlyMap<string, string | null> };
/** A member's row as the Team page shows it: their rollup, their name and whether they have submitted this week. */
function shape(r: Row, names: Map<string, string>, submitted: Set<string>, reports: number, at: Place) {
  return {
    // Only the caller's own direct reports take the caller's adjustment: rollup applies a parent's to its children.
    period: at.period, week: at.week, person: true, isReport: at.parent.get(r.member) === at.callerId, subKey: `${at.period}|${at.week}|${r.member}`, callValue: r.call ?? 0,
    member: r.member, name: names.get(r.member) ?? r.member, won: r.won, commit: r.commit, bestCase: r.bestCase, pipeline: r.pipeline,
    openCount: r.openCount, target: r.target, call: r.call, adjustedCall: r.adjustedCall, adjusted: r.adjusted,
    reportsCall: r.reportsCall, reportsCallUnadjusted: r.reportsCallUnadjusted, gap: r.gap, coverage: r.coverage,
    status: submitted.has(r.member) ? "submitted" : "due", statusLabel: submitted.has(r.member) ? "Submitted" : "Update required", reports, hasReports: reports > 0,
  };
}

/**
 * A period's week as the Team page and the weekly freeze read it: the tree, Canon's numbers from the period's deals,
 * this week's submitted calls after the managers' adjustments, and each member's target for the quarter's three months.
 */
function weekOfPeriod(ctx: CallContext, reads: Record<string, unknown>, period: ReadDoc) {
  const settings = settingsOf(reads.settings as ReadDoc | null);
  const week = weekOf(today(ctx), settings.cadenceDay);
  const users = reads.users as Array<Member & { isActive?: boolean }>;
  const parent = tree(users, (reads.teams as Team[]) ?? []);
  const names = new Map(users.map((u) => [u.id, u.name ?? u.id]));
  const numbers = systemNumbers(reads.deals as Deal[], users.map((u) => u.id));
  const thisWeek = (reads.subs as ReadDoc[]).filter((x) => x.data.week === week && x.data.status === "submitted");
  const subs: Submission[] = thisWeek.map((x) => ({ member: String(x.data.member), call: Number(x.data.call), upside: (x.data.upside as number | undefined) ?? null }));
  const adjs: Adjustment[] = (reads.adjs as ReadDoc[]).filter((a) => a.data.week === week).map((a) => ({ by: String(a.data.by), member: String(a.data.member), field: "call", to: Number(a.data.to), at: a.updatedAt }));
  const targets = new Map<string, number>();
  const plan = (reads.plan as Array<{ fyStart?: number; repMonths?: Record<string, number[]> }> | undefined)?.[0];
  if (plan?.repMonths) {
    const fy = plan.fyStart ?? 1, [, m0] = String(period.data.start).split("-").map(Number);
    const first = (m0 - fy + 12) % 12;
    for (const [rep, months] of Object.entries(plan.repMonths)) targets.set(rep, (months[first] ?? 0) + (months[first + 1] ?? 0) + (months[first + 2] ?? 0));
  }
  const rows = rollup(parent, numbers, subs, adjs, targets);
  return { settings, week, users, parent, names, numbers, rows, submitted: new Set(subs.map((x) => x.member)) };
}

/** A deal's people as Insights lists them: on the deal, and how many of them activity has named. */
function onDeal(team: Array<{ id: string; name?: string | null; title?: string | null; role?: string | null }>, acts: Array<{ at?: number | null; personId?: string | null }>) {
  const last = new Map<string, number>();
  for (const a of acts) if (a.personId && typeof a.at === "number" && a.at > (last.get(a.personId) ?? -Infinity)) last.set(a.personId, a.at);
  const rows = team.map((p) => ({ id: p.id, name: p.name ?? "", title: p.title ?? null, role: p.role ? p.role.replace(/_/g, " ") : null, lastAt: last.get(p.id) ?? null }));
  return { team: rows, onDeal: rows.length, engaged: rows.filter((r) => r.lastAt !== null).length };
}

export const calls: CallFunctions = {
  /**
   * Keep the current and next fiscal quarters open, and the `current` period doc naming the quarter today is in, which
   * every page reads when its URL names no period.
   */
  openPeriods(ctx, reads) {
    const fyStart = ctx.workspace?.fiscalYearStartMonth || 1;
    const day = today(ctx);
    const now = quarterOf(day, fyStart);
    const next = quarterOf(shiftPeriod(periodOf(day, "quarter", fyStart), "quarter", 1, fyStart).start, fyStart);
    const have = new Map((reads.periods as ReadDoc[]).map((p) => [p.key, p]));
    const intents: Intent[] = [];
    for (const q of [now, next]) {
      if (!have.has(q.period)) intents.push({ op: "put", collection: "periods", key: q.period, data: { ...q, grain: "quarter", status: "open" }, expect: [{ collection: "periods", key: q.period, version: null }] });
    }
    const cur = have.get("current");
    // Rewritten when the quarter turns, or when it predates its `alias` mark (1.3.0), which keeps it out of the period lists.
    if (!cur || cur.data.period !== now.period || cur.data.alias !== true) {
      intents.push({ op: "put", collection: "periods", key: "current", data: { ...now, grain: "quarter", status: "open", alias: true }, expect: [{ collection: "periods", key: "current", version: cur?.version ?? null }] });
    }
    return { intents };
  },

  /**
   * The Team page: the caller (or the member drilled into) and each direct report, with Canon's numbers from the
   * period's deals, their calls this week after the caller's adjustments, and their targets.
   */
  team(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) return { value: { rows: [], root: null, period: null } };
    const { week, parent, names, numbers, rows, submitted } = weekOfPeriod(ctx, reads, period);
    const rootId = typeof ctx.args.member === "string" && ctx.args.member && rows.has(ctx.args.member) ? ctx.args.member : ctx.caller.userId;
    const root = rows.get(rootId);
    if (!root) return { value: { rows: [], root: null, period: period.data, week } };
    const kids = [...parent].filter(([, p]) => p === rootId).map(([m]) => m);
    const count = (m: string) => [...parent.values()].filter((p) => p === m).length;
    const at: Place = { period: String(period.data.period), week, rootId, callerId: ctx.caller.userId, parent };
    const top = shape(root, names, submitted, kids.length, at);
    const list = [top, ...kids.map((k) => shape(rows.get(k)!, names, submitted, count(k), at))];
    // Deals no member owns count at the top of the tree, as their own row and in its totals, so the company's number is
    // whole (plan risk 2); a manager lower down doesn't own them.
    const unowned = numbers.get(null);
    if (unowned && (unowned.won || unowned.bestCase || unowned.pipeline) && !parent.get(rootId)) {
      for (const f of ["won", "commit", "bestCase", "pipeline", "openCount"] as const) top[f] += unowned[f];
      top.gap = top.target - top.won;
      list.push({ ...top, ...unowned, member: "unassigned", name: "Unassigned (no Canon owner)", target: 0, call: null, adjustedCall: null, adjusted: false,
        reportsCall: 0, reportsCallUnadjusted: 0, gap: 0, coverage: null, status: "none", statusLabel: "Not forecast", reports: 0, hasReports: false, isReport: false, person: false, callValue: 0 });
    }
    return { value: { period: period.data, week, root: top, rows: list } };
  },

  /** My forecast: the caller's own numbers, this week's call and their deals in the period by category. */
  mine(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) return { value: { deals: [], period: null } };
    const settings = settingsOf(reads.settings as ReadDoc | null);
    const week = weekOf(today(ctx), settings.cadenceDay);
    const me = ctx.caller.userId;
    const deals = (reads.deals as Deal[]).filter((d) => d.closeDate && d.closeDate >= String(period.data.start) && d.closeDate <= String(period.data.end));
    const n = systemNumbers(deals, [me]).get(me)!;
    const sub = (reads.subs as ReadDoc[]).find((s) => s.data.week === week && s.data.member === me);
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted" };
    return { value: {
      period: period.data, week, ...n,
      call: sub?.data.status === "submitted" ? Number(sub.data.call) : null, upside: sub?.data.upside ?? null, note: sub?.data.note ?? null,
      status: sub?.data.status === "submitted" ? "submitted" : "due", statusLabel: sub?.data.status === "submitted" ? "Submitted" : "Update required",
      deals: deals.map((d) => ({ id: d.id, name: d.name ?? "", amount: d.amount ?? 0, closeDate: d.closeDate, stage: d.stage ?? null, category: label[categoryOf(d)], open: !d.isClosed && !d.isWon })),
    } };
  },

  /** Save and submit the caller's call for this week of the period: the system numbers it rests on are frozen with it. */
  saveCall(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) throw new Error("Pick a period first.");
    const call = Number(ctx.args.call);
    if (!Number.isFinite(call) || call < 0) throw new Error("Give your call as an amount.");
    const settings = settingsOf(reads.settings as ReadDoc | null);
    const week = weekOf(today(ctx), settings.cadenceDay);
    const me = ctx.caller.userId;
    const key = `${period.data.period}|${week}|${me}`;
    const existing = (reads.subs as ReadDoc[]).find((s) => s.key === key);
    const deals = (reads.deals as Deal[]).filter((d) => d.closeDate && d.closeDate >= String(period.data.start) && d.closeDate <= String(period.data.end));
    const system = systemNumbers(deals, [me]).get(me)!;
    const data = {
      period: period.data.period, week, member: me, call, ...(ctx.args.upside != null ? { upside: Number(ctx.args.upside) } : {}),
      ...(typeof ctx.args.note === "string" && ctx.args.note ? { note: ctx.args.note } : {}), system, submittedAt: ctx.now,
    };
    const expect = [{ collection: "submissions", key, version: existing?.version ?? null }];
    const intents: Intent[] = [{ op: "put", collection: "submissions", key, data, expect }];
    if (existing?.data.status !== "submitted") intents.push({ op: "transition", machine: "submission", name: "submit", key });
    return { intents, value: { call, week } };
  },

  /**
   * Every open deal assessed again, daily: on install (the watches see only later changes) and as time alone turns a
   * deal overdue or quiet.
   */
  riskSweep(_ctx, reads) {
    const open = (reads.deals as Deal[]).filter((d) => !d.isClosed && !d.isWon);
    return { intents: open.map((d): Intent => ({ op: "dirty", job: "risk", key: d.id })) };
  },
  /** The deal feed: a deal whose forecast fields changed is assessed again. */
  onDeals(ctx) {
    const keys = new Set((ctx.args.changes as RecordChange[]).map((c) => c.id));
    return { intents: [...keys].map((key): Intent => ({ op: "dirty", job: "risk", key })) };
  },
  /** The activity feed: the deals an activity is about are assessed again (no activity, contacts engaged). */
  onActivities(ctx) {
    const keys = new Set((ctx.args.changes as RecordChange[]).flatMap((c) => c.targets?.deals ?? []));
    return { intents: [...keys].map((key): Intent => ({ op: "dirty", job: "risk", key })) };
  },

  /**
   * The risk job: each deal's flags from its last 90 days (deals.changesBetween: the close dates it held, its amount and
   * category then and now) and its activities, with evidence built from those values only (engine risksOf). A flag that
   * fires opens its doc, or reopens a dismissed one whose evidence is new; a cleared open flag goes.
   */
  assess(ctx, reads) {
    const keys = ctx.args.keys as string[];
    const deals = new Map((reads.deals as Deal[]).map((d) => [d.id, d]));
    const changes = new Map((reads.changes as Array<DealChange & { closeDates?: string[]; amounts?: number[]; categories?: string[] }>).map((c) => [c.id, c]));
    const acts = reads.acts as Array<{ dealId?: string | null; at?: number | null; personId?: string | null }>;
    const existing = reads.existing as ReadDoc[];
    const since = ctx.now - 90 * 86_400_000;
    const byKey: Record<string, Intent[]> = {};
    for (const id of keys) {
      const deal = deals.get(id);
      const out: Intent[] = (byKey[id] = []);
      const change = changes.get(id);
      const before = change?.before ?? deal ?? null, after = deal ?? null;
      const dates = change?.closeDates?.length ? change.closeDates : [after?.closeDate].filter((x): x is string => !!x);
      const history: Version[] = [
        ...(before ? [{ at: since, amount: before.amount ?? null, forecastCategory: before.forecastCategory ?? null, stage: before.stage ?? null, isClosed: before.isClosed, isWon: before.isWon, closeDate: dates[0] ?? before.closeDate ?? null }] : []),
        ...dates.slice(1).map((closeDate) => ({ at: since, closeDate })),
        // Every amount and category it held in the window, so a drop from a peak in it (or since it was created) is flagged.
        ...(change?.amounts ?? []).map((amount) => ({ at: since, amount })),
        ...(change?.categories ?? []).map((forecastCategory) => ({ at: since, forecastCategory, isClosed: false, isWon: false })),
        ...(after ? [{ at: ctx.now, amount: after.amount ?? null, forecastCategory: after.forecastCategory ?? null, stage: after.stage ?? null, isClosed: after.isClosed, isWon: after.isWon, closeDate: after.closeDate ?? null }] : []),
      ];
      const fired = deal ? risksOf(deal, history, acts.filter((a) => a.dealId === id && typeof a.at === "number") as Array<{ at: number; personId?: string | null }>, DEFAULT_RISK_SETTINGS, ctx.now) : [];
      const mine = existing.filter((r) => r.data.deal === id);
      for (const r of fired) {
        const key = `${id}|${r.rule}`, doc = mine.find((x) => x.key === key);
        const owner = deal?.ownerId ?? null;
        const data = { deal: id, rule: r.rule, severity: r.severity, evidence: r.evidence, ...(owner ? { owner } : {}) };
        if (!doc) {
          out.push({ op: "put", collection: "risks", key, data: { ...data, since: ctx.now }, expect: [{ collection: "risks", key, version: null }] });
          // A new high risk tells the deal's owner, once: a reopened or a lower one waits for them on Inspect.
          if (r.severity === "high" && owner) out.push({ op: "notify", to: [owner], subject: `${deal?.name ?? "A deal"} is at risk`, badge: "Forecast", message: r.evidence, link: "inspect" } as Intent);
        }
        else if (doc.data.evidence !== r.evidence || (doc.data.owner ?? null) !== owner) {
          // The risk follows its deal's owner, who reads and dismisses it, whether or not its evidence moved.
          // A patch names no key field (deal, rule): the kernel refuses one that does, even unchanged.
          const { deal: _deal, rule: _rule, ...moved } = data;
          out.push({ op: "patch", collection: "risks", key, data: moved, ...(owner ? {} : { unset: ["owner"] }), expect: [{ collection: "risks", key, version: doc.version }] });
          if (doc.data.status === "dismissed" && doc.data.evidence !== r.evidence) out.push({ op: "transition", machine: "risk", name: "reopen", key });
        }
      }
      for (const doc of mine) if (doc.data.status === "open" && !fired.some((r) => `${id}|${r.rule}` === doc.key)) out.push({ op: "delete", collection: "risks", key: doc.key, expect: [{ collection: "risks", key: doc.key, version: doc.version }] });
    }
    return { byKey };
  },

  /**
   * Inspect: the period's deals with what changed over the window highlighted (amount down, close date pushed and
   * every date it held, category moved) and their open risks.
   */
  inspect(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) return { value: { rows: [], period: null } };
    const changes = new Map((reads.changes as Array<DealChange & { closeDates?: string[]; amounts?: number[] }>).map((c) => [c.id, c]));
    const risks = new Map<string, string[]>();
    for (const r of reads.risks as ReadDoc[]) if (r.data.status === "open") risks.set(String(r.data.deal), [...(risks.get(String(r.data.deal)) ?? []), String(r.data.evidence)]);
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    const rows = (reads.deals as Array<Deal & { companyName?: string | null }>).filter((d) => !d.isClosed).map((d) => {
      const c = changes.get(d.id), b = c?.before ?? null;
      const amountBefore = b && b.amount !== d.amount ? b.amount ?? null : null;
      const dates = c?.closeDates ?? [];
      // Pushed against where it stood at the window's start, or, for a deal made since, the first close date it held.
      const first = b?.closeDate ?? dates[0] ?? null;
      const pushed = !!(first && d.closeDate && d.closeDate > first);
      const from = b ? standingOf(b) : null, to = standingOf(d);
      const flags = risks.get(d.id) ?? [];
      return {
        id: d.id, name: d.name ?? "", ownerId: d.ownerId ?? null, companyName: d.companyName ?? null, amount: d.amount ?? 0, closeDate: d.closeDate ?? null, stage: d.stage ?? null,
        category: label[to], amountBefore, amountDown: amountBefore !== null && (d.amount ?? 0) < amountBefore, amountWas: amountBefore === null ? "" : `Was ${dollars(amountBefore)}`,
        pushed, datesHeld: dates.length > 1 ? `Close date moved ${dates.join(" → ")}` : "",
        categoryMove: from && from !== to ? `${label[from]} → ${label[to]}` : "", moved: !!(from && from !== to),
        risks: flags.join(" · "), riskCount: flags.length, atRisk: flags.length > 0, mine: d.ownerId === ctx.caller.userId,
      };
    });
    return { value: { period: period.data, days: ctx.args.days ?? 7, rows } };
  },

  /**
   * What moved in the quarter's amount between two dates (engine moves: start + the steps = end, checked), the category
   * moves, and where the deals of Commit and of Best case went (engine flow).
   */
  moved(_ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) return { value: { period: null, steps: [], categoryMoves: [], flows: [] } };
    const p = { start: String(period.data.start), end: String(period.data.end) };
    const changes = reads.changes as DealChange[];
    const names = new Map(changes.map((c) => [c.id, (c.after ?? c.before)?.name ?? c.id]));
    const m = moves(changes, p);
    const STEP: Record<string, string> = { new: "New", moved_in: "Moved in", increased: "Increased", decreased: "Decreased", slipped: "Slipped", moved_out: "Pulled out of the quarter", lost: "Lost" };
    const steps = Object.entries(m.buckets).filter(([, b]) => b.deals.length).map(([k, b]) => ({ step: STEP[k], amount: b.amount, deals: b.deals.length, names: b.deals.map((d) => names.get(d.id)).join(", ") }));
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    const END: Record<string, string> = { won: "Won", upgraded: "Upgraded", downgraded: "Downgraded", idle: "Unchanged", slipped: "Slipped", lost: "Lost" };
    const flows = (["commit", "best_case"] as const).flatMap((from) => {
      const f = flow(changes, p, from);
      return [
        ...Object.entries(f.ends).filter(([, e]) => e.deals.length).map(([k, e]) => ({ from: label[from], to: END[k], amount: e.amount, deals: e.deals.length, names: e.deals.map((id) => names.get(id)).join(", ") })),
        ...(f.into.length ? [{ from: label[from], to: "Came in", amount: f.into.reduce((n, x) => n + x.amount, 0), deals: f.into.length, names: f.into.map((x) => names.get(x.id)).join(", ") }] : []),
      ];
    });
    return { value: {
      period: period.data, start: m.start, end: m.end, won: m.won.amount,
      newAmount: m.buckets.new.amount + m.buckets.moved_in.amount, up: m.buckets.increased.amount, down: m.buckets.decreased.amount,
      slipped: m.buckets.slipped.amount + m.buckets.moved_out.amount, lost: m.buckets.lost.amount, steps,
      categoryMoves: m.categoryMoves.map((c) => ({ deal: names.get(c.id), from: label[c.from], to: label[c.to], amount: c.amount })),
      flows,
    } };
  },

  /**
   * Close a period: each member's call at its accuracy week (the Nth week anyone submitted in it, `settings.accuracyWeek`,
   * 4 by default) against what their part of the tree actually won (engine accuracyOf), and the period's final won.
   * Run once the quarter is over; a closed period's calls stay as they were.
   */
  closePeriod(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) throw new Error("Pick the period to close.");
    if (period.key === "current") throw new Error("Close a quarter by its own name, not the current one.");
    if (period.data.status === "closed") throw new Error(`${String(period.data.label)} is already closed.`);
    // Only a quarter that's over: its calls and its wins are final, and a close can't be done again.
    if (String(period.data.end) >= today(ctx)) throw new Error(`${String(period.data.label)} isn't over until ${String(period.data.end)}. Close it after that.`);
    const weekN = Math.max(1, Number((reads.settings as ReadDoc | null)?.data.accuracyWeek ?? 4));
    const users = reads.users as Array<Member & { isActive?: boolean }>;
    const parent = tree(users, (reads.teams as Team[]) ?? []);
    const numbers = systemNumbers(reads.deals as Deal[], users.map((u) => u.id));
    const rows = rollup(parent, numbers, [], [], new Map());
    const subs = (reads.subs as ReadDoc[]).filter((x) => x.data.status === "submitted");
    const weeks = [...new Set(subs.map((x) => String(x.data.week)))].sort();
    const week = weeks[Math.min(weekN, weeks.length) - 1] ?? null;
    const intents: Intent[] = [];
    const existing = new Map((reads.existing as ReadDoc[]).map((d) => [d.key, d]));
    // Deals no member owns count at the top of the tree, as the Team page counts them.
    const unowned = numbers.get(null)?.won ?? 0;
    for (const sub of subs.filter((x) => x.data.week === week)) {
      const member = String(sub.data.member), row = rows.get(member);
      const actual = (row?.won ?? 0) + (row && !row.parent ? unowned : 0);
      const a = accuracyOf(Number(sub.data.call), actual);
      const key = `${period.data.period}|${member}`;
      intents.push({ op: "put", collection: "accuracy", key, data: { period: period.data.period, member, week, call: a.call, actual: a.actual, error: a.error, ...(a.accuracy === null ? {} : { accuracy: a.accuracy }) }, expect: [{ collection: "accuracy", key, version: existing.get(key)?.version ?? null }] });
    }
    const finalWon = [...rows.values()].filter((r) => !r.parent).reduce((n, r) => n + r.won, 0) + unowned;
    intents.push({ op: "patch", collection: "periods", key: period.key, data: { status: "closed", finalWon, closedAt: ctx.now }, expect: [{ collection: "periods", key: period.key, version: period.version }] });
    return { intents, value: { label: period.data.label, members: intents.length - 1, week, finalWon } };
  },

  /** The deal page's Forecast panel (P6): the deal's forecast category, close date and next step; its risks are a view. */
  dealPanel(_ctx, reads) {
    const deal = (reads.deal as Deal[])[0];
    if (!deal) return { value: { category: null } };
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    return { value: { category: label[standingOf(deal)], closeDate: deal.closeDate ?? null, nextStep: deal.nextStep ?? null } };
  },

  /**
   * The weekly freeze (daily, a schedule): each member's numbers and call this week, as they stand now, kept per
   * week so history, trend and accuracy never read the past again. On the cadence day it also tells everyone whose
   * call is due.
   */
  freezeWeek(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    if (!period) return { intents: [] };
    const { settings, week, users, numbers, rows, submitted } = weekOfPeriod(ctx, reads, period);
    const existing = new Map((reads.existing as ReadDoc[]).map((d) => [d.key, d]));
    const asOf = today(ctx);
    // As on the Team page, deals no member owns count in each top-level member's numbers.
    const unowned = numbers.get(null);
    const intents: Intent[] = [...rows.values()].map((r) => {
      const key = `${period.data.period}|${week}|${r.member}`;
      const add = (f: "won" | "commit" | "bestCase" | "pipeline" | "openCount") => r[f] + (!r.parent && unowned ? unowned[f] : 0);
      const data = { period: period.data.period, week, member: r.member, top: !r.parent, asOf, won: add("won"), commit: add("commit"), bestCase: add("bestCase"), pipeline: add("pipeline"),
        openCount: add("openCount"), target: r.target, ...(r.adjustedCall !== null ? { call: r.adjustedCall } : {}) };
      return { op: "put", collection: "rollups", key, data, expect: [{ collection: "rollups", key, version: existing.get(key)?.version ?? null }] };
    });
    const iso = ((new Date(ctx.now).getUTCDay() + 6) % 7) + 1;
    const due = iso === settings.cadenceDay ? users.filter((u) => u.isActive !== false && !submitted.has(u.id)).map((u) => u.id) : [];
    for (let i = 0; i < due.length; i += 50) intents.push({ op: "notify", to: due.slice(i, i + 50), subject: "Your forecast call is due", badge: "Forecast", message: `Submit your call for the week of ${week}.`, link: "mine" } as Intent);
    return { intents, value: { week, members: rows.size } };
  },

  /**
   * The deals behind a member's numbers in the period, as the Team page counts them: theirs and their tree's, plus the
   * deals no member owns for a top-level member. Total (won and commit), closed won and open, by category.
   */
  memberDeals(ctx, reads) {
    const period = reads.period as ReadDoc | null;
    const member = String(ctx.args.member);
    if (!period) return { value: { deals: [] } };
    const users = reads.users as Member[];
    const parent = tree(users, (reads.teams as Team[]) ?? []);
    const names = new Map(users.map((u) => [u.id, u.name ?? u.id]));
    const under = (m: string) => { for (let p: string | null | undefined = m; p; p = parent.get(p)) if (p === member) return true; return false; };
    const top = !parent.get(member);
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted" };
    const deals = (reads.deals as Array<Deal & { companyName?: string | null }>).filter((d) => d.ownerId && names.has(d.ownerId) ? under(d.ownerId) : top);
    const rows = deals.map((d) => ({ id: d.id, name: d.name ?? "", companyName: d.companyName ?? null, owner: d.ownerId && names.has(d.ownerId) ? names.get(d.ownerId)! : "No Canon owner",
      amount: d.amount ?? 0, closeDate: d.closeDate, stage: d.stage ?? null, category: label[categoryOf(d)], open: !d.isClosed && !d.isWon }));
    const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.amount, 0);
    return { value: { period: period.data, deals: rows, total: sum((r) => r.category === "Closed won" || r.category === "Commit"), won: sum((r) => r.category === "Closed won"), open: sum((r) => r.open) } };
  },

  /** A deal's insights: its activity, newest first, how many people it has reached, and when it was last touched. */
  insights(ctx, reads) {
    const deal = (reads.deal as Deal[])[0];
    if (!deal) return { value: { deal: null, activities: [], team: [] } };
    const acts = (reads.acts as Array<{ id: string; kind?: string; at?: number | null; subject?: string | null; outcome?: string | null; personId?: string | null }>).filter((a) => typeof a.at === "number").sort((a, b) => b.at! - a.at!);
    const last = acts[0]?.at ?? null;
    const label: Record<string, string> = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    return { value: {
      deal: { name: deal.name ?? "", amount: deal.amount ?? 0, closeDate: deal.closeDate ?? null, category: label[standingOf(deal)], nextStep: deal.nextStep ?? null },
      lastAt: last, daysSince: last === null ? null : Math.floor((ctx.now - last) / 86_400_000), count: acts.length,
      people: new Set(acts.map((a) => a.personId).filter(Boolean)).size,
      // The people on the deal (deals.people, 1.6.0), each with their role and when activity last named them.
      ...onDeal(reads.team as Array<{ id: string; name?: string | null; title?: string | null; role?: string | null }>, acts),
      activities: acts.map((a) => ({ id: a.id, at: a.at, kind: a.kind ?? "", subject: a.subject ?? null, outcome: a.outcome ?? null })),
    } };
  },
};
