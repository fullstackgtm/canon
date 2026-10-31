var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAY = 864e5;
var ms = (day) => Date.parse(`${day}T00:00:00Z`);
var iso = (t) => new Date(t).toISOString().slice(0, 10);
var SPAN = { month: 1, quarter: 3, year: 12 };
var monthIndex = (day) => {
  const [y, m] = day.split("-").map(Number);
  return y * 12 + m - 1;
};
var firstMonth = (fy, fyStart) => (fy - (fyStart > 1 ? 1 : 0)) * 12 + fyStart - 1;
var fiscalYearOf = (month, fyStart) => Math.floor((month - fyStart + 1) / 12) + (fyStart > 1 ? 1 : 0);
var fiscalYearName = (fy, fyStart = 1) => fyStart === 1 ? String(fy) : `FY${String(fy).slice(-2)}`;
function periodFrom(first, grain, fyStart) {
  const fy = fiscalYearOf(first, fyStart);
  const q = Math.floor((first - firstMonth(fy, fyStart)) / 3) + 1;
  const y = Math.floor(first / 12);
  const m = first % 12;
  const label = grain === "month" ? `${MONTHS[m]} ${y}` : grain === "quarter" ? `Q${q} ${fiscalYearName(fy, fyStart)}` : fiscalYearName(fy, fyStart);
  const key = grain === "month" ? `${y}-${String(m + 1).padStart(2, "0")}` : grain === "quarter" ? `${fy}-Q${q}` : String(fy);
  const start = Date.UTC(y, m, 1);
  return { key, label, start: iso(start), days: Math.round((Date.UTC(y, m + SPAN[grain], 1) - start) / DAY) };
}
function periodOf(day, grain, fyStart = 1) {
  const offset = grain === "month" ? 0 : fyStart - 1;
  return periodFrom(Math.floor((monthIndex(day) - offset) / SPAN[grain]) * SPAN[grain] + offset, grain, fyStart);
}
function shiftPeriod(p, grain, n, fyStart = 1) {
  return periodFrom(monthIndex(p.start) + n * SPAN[grain], grain, fyStart);
}
var lastDay = (p) => iso(ms(p.start) + (p.days - 1) * DAY);

function categoryOf(d) {
  if (d.isWon || d.forecastCategory === "closed_won") return "won";
  if (d.isClosed || d.forecastCategory === "closed_lost" || d.forecastCategory === "omit") return "omit";
  if (d.forecastCategory === "commit" || d.forecastCategory === "best_case") return d.forecastCategory;
  return "pipeline";
}
var standingOf = (d) => d.isClosed && !d.isWon && d.forecastCategory !== "closed_won" ? "lost" : categoryOf(d);
var RANK = { lost: -1, omit: 0, pipeline: 1, best_case: 2, commit: 3, won: 4 };
var zero = () => ({ won: 0, commit: 0, bestCase: 0, pipeline: 0, openCount: 0 });
var add = (a, b) => ({ won: a.won + b.won, commit: a.commit + b.commit, bestCase: a.bestCase + b.bestCase, pipeline: a.pipeline + b.pipeline, openCount: a.openCount + b.openCount });
function systemNumbers(deals, members) {
  const out = new Map(members.map((m) => [m, zero()]));
  for (const d of deals) {
    const owner = d.ownerId && out.has(d.ownerId) ? d.ownerId : null;
    const n = out.get(owner) ?? zero();
    const amount = d.amount ?? 0, c = categoryOf(d);
    if (c === "won") {
      n.won += amount;
      n.commit += amount;
      n.bestCase += amount;
    } else if (c === "commit") {
      n.commit += amount;
      n.bestCase += amount;
      n.openCount += 1;
    } else if (c === "best_case") {
      n.bestCase += amount;
      n.openCount += 1;
    } else if (c === "pipeline") {
      n.pipeline += amount;
      n.openCount += 1;
    }
    out.set(owner, n);
  }
  return out;
}
function tree(members, teams) {
  const ids = new Set(members.map((m) => m.id));
  const parent = /* @__PURE__ */ new Map();
  for (const m of members) {
    let p = m.managerId && ids.has(m.managerId) ? m.managerId : null;
    if (!p) p = teams.find((t) => t.memberIds.includes(m.id) && t.managerId && t.managerId !== m.id && ids.has(t.managerId))?.managerId ?? null;
    parent.set(m.id, p);
  }
  for (const m of members) {
    const seen = [];
    for (let at = m.id; at; at = parent.get(at) ?? null) {
      if (seen.includes(at)) {
        const names = seen.slice(seen.indexOf(at)).map((id) => members.find((x) => x.id === id)?.name ?? id);
        throw new Error(`The manager chain loops: ${names.join(" → ")} → ${names[0]}. Fix it in Settings > Team.`);
      }
      seen.push(at);
    }
  }
  return parent;
}
function adjustmentOf(adjs, by, member, field) {
  if (!by) return null;
  const mine = adjs.filter((a) => a.by === by && a.member === member && a.field === field);
  return mine.length ? mine.reduce((a, b) => (b.at ?? 0) >= (a.at ?? 0) ? b : a) : null;
}
function rollup(parent, numbers, submissions, adjustments, targets) {
  const children = /* @__PURE__ */ new Map();
  for (const [m, p] of parent) if (p) children.set(p, [...children.get(p) ?? [], m]);
  const callOf = new Map(submissions.map((s) => [s.member, s.call]));
  const out = /* @__PURE__ */ new Map();
  const visit = (m) => {
    const done = out.get(m);
    if (done) return done;
    const kids = (children.get(m) ?? []).map(visit);
    const own = numbers.get(m) ?? zero();
    const sum = kids.reduce((a, k) => add(a, k), own);
    const target = kids.reduce((n, k) => n + k.target, targets.get(m) ?? 0);
    const call = callOf.has(m) ? callOf.get(m) : null;
    const adj = adjustmentOf(adjustments, parent.get(m) ?? null, m, "call");
    const reportsCall = kids.reduce((n, k) => n + (k.adjustedCall ?? 0), 0);
    const reportsCallUnadjusted = kids.reduce((n, k) => n + (k.call ?? 0), 0);
    const row = {
      ...sum,
      member: m,
      parent: parent.get(m) ?? null,
      target,
      call,
      adjustedCall: adj ? adj.to : call,
      adjusted: adj !== null,
      reportsCall,
      reportsCallUnadjusted,
      gap: target - sum.won,
      coverage: call !== null && target > 0 ? call / target : null,
      commitShare: call ? sum.commit / call : null
    };
    out.set(m, row);
    return row;
  };
  for (const m of parent.keys()) visit(m);
  return out;
}
var inPeriod = (d, p) => !!d && !!d.closeDate && d.closeDate >= p.start && d.closeDate <= p.end;
var counts = (d, p) => inPeriod(d, p) && standingOf(d) !== "lost" && standingOf(d) !== "omit";
function moves(changes, period) {
  const buckets = Object.fromEntries(["new", "moved_in", "increased", "decreased", "slipped", "moved_out", "lost"].map((b) => [b, { amount: 0, deals: [] }]));
  const put = (b, id, amount) => {
    buckets[b].amount += amount;
    buckets[b].deals.push({ id, amount });
  };
  const out = { start: 0, end: 0, buckets, won: { amount: 0, deals: [] }, pulledIn: [], categoryMoves: [] };
  for (const c of changes) {
    const was = counts(c.before, period) ? c.before : null, is = counts(c.after, period) ? c.after : null;
    const a0 = was?.amount ?? 0, a1 = is?.amount ?? 0;
    out.start += a0;
    out.end += a1;
    if (was && is) {
      if (a1 > a0) put("increased", c.id, a1 - a0);
      if (a1 < a0) put("decreased", c.id, a1 - a0);
      if (c.before.closeDate > c.after.closeDate) out.pulledIn.push({ id: c.id, from: c.before.closeDate, to: c.after.closeDate });
    } else if (was) {
      if (c.after && standingOf(c.after) === "lost") put("lost", c.id, -a0);
      else if (c.after && inPeriod(c.after, period)) put("lost", c.id, -a0);
      else if (c.after && c.after.closeDate && c.after.closeDate > period.end) put("slipped", c.id, -a0);
      else put("moved_out", c.id, -a0);
    } else if (is) put(c.before ? "moved_in" : "new", c.id, a1);
    if (c.before && c.after && (inPeriod(c.before, period) || inPeriod(c.after, period))) {
      const from = standingOf(c.before), to = standingOf(c.after);
      if (from !== to) out.categoryMoves.push({ id: c.id, from, to, amount: to === "lost" ? c.before.amount ?? 0 : c.after.amount ?? 0 });
      if (to === "won" && from !== "won" && is) {
        out.won.amount += a1;
        out.won.deals.push({ id: c.id, amount: a1 });
      }
    }
  }
  const steps = Object.values(buckets).reduce((n, b) => n + b.amount, 0);
  if (out.start + steps !== out.end) throw new Error(`What moved doesn't add up: ${out.start} + ${steps} ≠ ${out.end}.`);
  return out;
}
function flow(changes, period, from) {
  const ends = Object.fromEntries(["won", "upgraded", "downgraded", "idle", "slipped", "lost"].map((e) => [e, { amount: 0, deals: [] }]));
  const out = { from, start: { amount: 0, deals: 0 }, ends, into: [] };
  for (const c of changes) {
    const startIn = counts(c.before, period) && categoryOf(c.before) === from;
    if (startIn) {
      const amount = c.before.amount ?? 0;
      out.start.amount += amount;
      out.start.deals += 1;
      const to = c.after ? standingOf(c.after) : "lost";
      const end = to === "lost" ? "lost" : !inPeriod(c.after, period) ? "slipped" : to === "won" && from !== "won" ? "won" : RANK[to] > RANK[from] ? "upgraded" : RANK[to] < RANK[from] ? "downgraded" : "idle";
      ends[end].amount += amount;
      ends[end].deals.push(c.id);
    } else if (counts(c.after, period) && categoryOf(c.after) === from) {
      out.into.push({ id: c.id, from: c.before ? standingOf(c.before) : "new", amount: c.after.amount ?? 0 });
    }
  }
  return out;
}
var DEFAULT_RISK_SETTINGS = { noActivityDays: 14, stalledDays: {}, pushesFlag: 2, amountDropPct: 0.1, minContacts: 2 };
var DAY2 = 864e5;
var isoDay = (ms2) => new Date(ms2).toISOString().slice(0, 10);
var dollars = (minor) => `${minor < 0 ? "−" : ""}$${Math.round(Math.abs(minor) / 100).toLocaleString("en-US")}`;
function risksOf(deal, history, activities, settings, now) {
  if (deal.isClosed || deal.isWon) return [];
  const out = [];
  const today2 = isoDay(now);
  const last = activities.reduce((m, a) => m === null || a.at > m ? a.at : m, null);
  if (last === null) out.push({ rule: "no_activity", severity: "medium", evidence: "No activity logged on this deal." });
  else if (now - last >= settings.noActivityDays * DAY2) out.push({ rule: "no_activity", severity: "medium", evidence: `No activity since ${isoDay(last)} (${Math.floor((now - last) / DAY2)} days)` });
  if (deal.closeDate && deal.closeDate < today2) out.push({ rule: "overdue", severity: "high", evidence: `Close date ${deal.closeDate} has passed` });
  const stalled = deal.stage ? settings.stalledDays[deal.stage] : void 0;
  if (stalled !== void 0 && history.length) {
    let since = history[history.length - 1].at;
    for (let i = history.length - 1; i > 0 && history[i - 1].stage === deal.stage; i--) since = history[i - 1].at;
    const days = Math.floor((now - since) / DAY2);
    if (days >= stalled) out.push({ rule: "stalled", severity: "medium", evidence: `In ${deal.stage} for ${days} days` });
  }
  const dates = history.map((v) => v.closeDate).filter((x) => !!x).filter((x, i, a) => i === 0 || a[i - 1] !== x);
  const pushes = dates.filter((x, i) => i > 0 && x > dates[i - 1]).length;
  if (pushes >= settings.pushesFlag) out.push({ rule: "pushed", severity: "high", evidence: `Close date moved ${dates.join(" → ")}` });
  const amounts = history.map((v) => v.amount).filter((x) => typeof x === "number");
  const peak = amounts.length ? Math.max(...amounts) : null, now$ = deal.amount ?? null;
  if (peak !== null && now$ !== null && peak > 0 && (peak - now$) / peak >= settings.amountDropPct - 1e-12) {
    out.push({ rule: "amount_down", severity: "medium", evidence: `Amount ${dollars(peak)} → ${dollars(now$)} (−${Math.round((peak - now$) / peak * 100)}%)` });
  }
  const cats = history.filter((v) => v.forecastCategory != null || v.isClosed !== void 0).map((v) => categoryOf({ id: deal.id, ...v }));
  const top = cats.reduce((m, c) => m === null || RANK[c] > RANK[m] ? c : m, null);
  const cur = categoryOf(deal);
  if (top && RANK[cur] < RANK[top]) out.push({ rule: "category_down", severity: "high", evidence: `Category moved down from ${top} to ${cur}` });
  const contacts = new Set(activities.map((a) => a.personId).filter(Boolean)).size;
  if (contacts < settings.minContacts) out.push({ rule: "single_threaded", severity: "medium", evidence: contacts ? "Only one contact engaged" : "No contacts engaged" });
  if ("nextStep" in deal && !deal.nextStep?.trim()) out.push({ rule: "no_next_step", severity: "low", evidence: "No next step" });
  return out;
}
function accuracyOf(call, actual) {
  const error = call - actual;
  return { call, actual, error, accuracy: actual > 0 ? 1 - Math.abs(error) / actual : null };
}

var DEFAULTS = { cadenceDay: 1 };
var settingsOf = (doc) => ({ ...DEFAULTS, ...doc?.data ?? {} });
var today = (ctx) => new Date(ctx.now).toISOString().slice(0, 10);
function weekOf(day, cadenceDay) {
  const d = /* @__PURE__ */ new Date(`${day}T00:00:00Z`);
  const iso2 = (d.getUTCDay() + 6) % 7 + 1;
  d.setUTCDate(d.getUTCDate() - (iso2 - cadenceDay + 7) % 7);
  return d.toISOString().slice(0, 10);
}
function quarterOf(day, fyStart) {
  const p = periodOf(day, "quarter", fyStart);
  return { period: p.key, label: p.label, start: p.start, end: lastDay(p) };
}
function shape(r, names, submitted, reports, at) {
  return {
    // Only the caller's own direct reports take the caller's adjustment: rollup applies a parent's to its children.
    period: at.period,
    week: at.week,
    person: true,
    isReport: at.parent.get(r.member) === at.callerId,
    subKey: `${at.period}|${at.week}|${r.member}`,
    callValue: r.call ?? 0,
    member: r.member,
    name: names.get(r.member) ?? r.member,
    won: r.won,
    commit: r.commit,
    bestCase: r.bestCase,
    pipeline: r.pipeline,
    openCount: r.openCount,
    target: r.target,
    call: r.call,
    adjustedCall: r.adjustedCall,
    adjusted: r.adjusted,
    reportsCall: r.reportsCall,
    reportsCallUnadjusted: r.reportsCallUnadjusted,
    gap: r.gap,
    coverage: r.coverage,
    status: submitted.has(r.member) ? "submitted" : "due",
    statusLabel: submitted.has(r.member) ? "Submitted" : "Update required",
    reports,
    hasReports: reports > 0
  };
}
function weekOfPeriod(ctx, reads, period) {
  const settings = settingsOf(reads.settings);
  const week = weekOf(today(ctx), settings.cadenceDay);
  const users = reads.users;
  const parent = tree(users, reads.teams ?? []);
  const names = new Map(users.map((u) => [u.id, u.name ?? u.id]));
  const numbers = systemNumbers(reads.deals, users.map((u) => u.id));
  const thisWeek = reads.subs.filter((x) => x.data.week === week && x.data.status === "submitted");
  const subs = thisWeek.map((x) => ({ member: String(x.data.member), call: Number(x.data.call), upside: x.data.upside ?? null }));
  const adjs = reads.adjs.filter((a) => a.data.week === week).map((a) => ({ by: String(a.data.by), member: String(a.data.member), field: "call", to: Number(a.data.to), at: a.updatedAt }));
  const targets = /* @__PURE__ */ new Map();
  const plan = reads.plan?.[0];
  if (plan?.repMonths) {
    const fy = plan.fyStart ?? 1, [, m0] = String(period.data.start).split("-").map(Number);
    const first = (m0 - fy + 12) % 12;
    for (const [rep, months] of Object.entries(plan.repMonths)) targets.set(rep, (months[first] ?? 0) + (months[first + 1] ?? 0) + (months[first + 2] ?? 0));
  }
  const rows = rollup(parent, numbers, subs, adjs, targets);
  return { settings, week, users, parent, names, numbers, rows, submitted: new Set(subs.map((x) => x.member)) };
}
function onDeal(team, acts) {
  const last = /* @__PURE__ */ new Map();
  for (const a of acts) if (a.personId && typeof a.at === "number" && a.at > (last.get(a.personId) ?? -Infinity)) last.set(a.personId, a.at);
  const rows = team.map((p) => ({ id: p.id, name: p.name ?? "", title: p.title ?? null, role: p.role ? p.role.replace(/_/g, " ") : null, lastAt: last.get(p.id) ?? null }));
  return { team: rows, onDeal: rows.length, engaged: rows.filter((r) => r.lastAt !== null).length };
}
var calls = {
  /**
   * Keep the current and next fiscal quarters open, and the `current` period doc naming the quarter today is in, which
   * every page reads when its URL names no period.
   */
  openPeriods(ctx, reads) {
    const fyStart = ctx.workspace?.fiscalYearStartMonth || 1;
    const day = today(ctx);
    const now = quarterOf(day, fyStart);
    const next = quarterOf(shiftPeriod(periodOf(day, "quarter", fyStart), "quarter", 1, fyStart).start, fyStart);
    const have = new Map(reads.periods.map((p) => [p.key, p]));
    const intents = [];
    for (const q of [now, next]) {
      if (!have.has(q.period)) intents.push({ op: "put", collection: "periods", key: q.period, data: { ...q, grain: "quarter", status: "open" }, expect: [{ collection: "periods", key: q.period, version: null }] });
    }
    const cur = have.get("current");
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
    const period = reads.period;
    if (!period) return { value: { rows: [], root: null, period: null } };
    const { week, parent, names, numbers, rows, submitted } = weekOfPeriod(ctx, reads, period);
    const rootId = typeof ctx.args.member === "string" && ctx.args.member && rows.has(ctx.args.member) ? ctx.args.member : ctx.caller.userId;
    const root = rows.get(rootId);
    if (!root) return { value: { rows: [], root: null, period: period.data, week } };
    const kids = [...parent].filter(([, p]) => p === rootId).map(([m]) => m);
    const count = (m) => [...parent.values()].filter((p) => p === m).length;
    const at = { period: String(period.data.period), week, rootId, callerId: ctx.caller.userId, parent };
    const top = shape(root, names, submitted, kids.length, at);
    const list = [top, ...kids.map((k) => shape(rows.get(k), names, submitted, count(k), at))];
    const unowned = numbers.get(null);
    if (unowned && (unowned.won || unowned.bestCase || unowned.pipeline) && !parent.get(rootId)) {
      for (const f of ["won", "commit", "bestCase", "pipeline", "openCount"]) top[f] += unowned[f];
      top.gap = top.target - top.won;
      list.push({
        ...top,
        ...unowned,
        member: "unassigned",
        name: "Unassigned (no Canon owner)",
        target: 0,
        call: null,
        adjustedCall: null,
        adjusted: false,
        reportsCall: 0,
        reportsCallUnadjusted: 0,
        gap: 0,
        coverage: null,
        status: "none",
        statusLabel: "Not forecast",
        reports: 0,
        hasReports: false,
        isReport: false,
        person: false,
        callValue: 0
      });
    }
    return { value: { period: period.data, week, root: top, rows: list } };
  },
  /** My forecast: the caller's own numbers, this week's call and their deals in the period by category. */
  mine(ctx, reads) {
    const period = reads.period;
    if (!period) return { value: { deals: [], period: null } };
    const settings = settingsOf(reads.settings);
    const week = weekOf(today(ctx), settings.cadenceDay);
    const me = ctx.caller.userId;
    const deals = reads.deals.filter((d) => d.closeDate && d.closeDate >= String(period.data.start) && d.closeDate <= String(period.data.end));
    const n = systemNumbers(deals, [me]).get(me);
    const sub = reads.subs.find((s) => s.data.week === week && s.data.member === me);
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted" };
    return { value: {
      period: period.data,
      week,
      ...n,
      call: sub?.data.status === "submitted" ? Number(sub.data.call) : null,
      upside: sub?.data.upside ?? null,
      note: sub?.data.note ?? null,
      status: sub?.data.status === "submitted" ? "submitted" : "due",
      statusLabel: sub?.data.status === "submitted" ? "Submitted" : "Update required",
      deals: deals.map((d) => ({ id: d.id, name: d.name ?? "", amount: d.amount ?? 0, closeDate: d.closeDate, stage: d.stage ?? null, category: label[categoryOf(d)], open: !d.isClosed && !d.isWon }))
    } };
  },
  /** Save and submit the caller's call for this week of the period: the system numbers it rests on are frozen with it. */
  saveCall(ctx, reads) {
    const period = reads.period;
    if (!period) throw new Error("Pick a period first.");
    const call = Number(ctx.args.call);
    if (!Number.isFinite(call) || call < 0) throw new Error("Give your call as an amount.");
    const settings = settingsOf(reads.settings);
    const week = weekOf(today(ctx), settings.cadenceDay);
    const me = ctx.caller.userId;
    const key = `${period.data.period}|${week}|${me}`;
    const existing = reads.subs.find((s) => s.key === key);
    const deals = reads.deals.filter((d) => d.closeDate && d.closeDate >= String(period.data.start) && d.closeDate <= String(period.data.end));
    const system = systemNumbers(deals, [me]).get(me);
    const data = {
      period: period.data.period,
      week,
      member: me,
      call,
      ...ctx.args.upside != null ? { upside: Number(ctx.args.upside) } : {},
      ...typeof ctx.args.note === "string" && ctx.args.note ? { note: ctx.args.note } : {},
      system,
      submittedAt: ctx.now
    };
    const expect = [{ collection: "submissions", key, version: existing?.version ?? null }];
    const intents = [{ op: "put", collection: "submissions", key, data, expect }];
    if (existing?.data.status !== "submitted") intents.push({ op: "transition", machine: "submission", name: "submit", key });
    return { intents, value: { call, week } };
  },
  /**
   * Every open deal assessed again, daily: on install (the watches see only later changes) and as time alone turns a
   * deal overdue or quiet.
   */
  riskSweep(_ctx, reads) {
    const open = reads.deals.filter((d) => !d.isClosed && !d.isWon);
    return { intents: open.map((d) => ({ op: "dirty", job: "risk", key: d.id })) };
  },
  /** The deal feed: a deal whose forecast fields changed is assessed again. */
  onDeals(ctx) {
    const keys = new Set(ctx.args.changes.map((c) => c.id));
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "risk", key })) };
  },
  /** The activity feed: the deals an activity is about are assessed again (no activity, contacts engaged). */
  onActivities(ctx) {
    const keys = new Set(ctx.args.changes.flatMap((c) => c.targets?.deals ?? []));
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "risk", key })) };
  },
  /**
   * The risk job: each deal's flags from its last 90 days (deals.changesBetween: the close dates it held, its amount and
   * category then and now) and its activities, with evidence built from those values only (engine risksOf). A flag that
   * fires opens its doc, or reopens a dismissed one whose evidence is new; a cleared open flag goes.
   */
  assess(ctx, reads) {
    const keys = ctx.args.keys;
    const deals = new Map(reads.deals.map((d) => [d.id, d]));
    const changes = new Map(reads.changes.map((c) => [c.id, c]));
    const acts = reads.acts;
    const existing = reads.existing;
    const since = ctx.now - 90 * 864e5;
    const byKey = {};
    for (const id of keys) {
      const deal = deals.get(id);
      const out = byKey[id] = [];
      const change = changes.get(id);
      const before = change?.before ?? deal ?? null, after = deal ?? null;
      const dates = change?.closeDates?.length ? change.closeDates : [after?.closeDate].filter((x) => !!x);
      const history = [
        ...before ? [{ at: since, amount: before.amount ?? null, forecastCategory: before.forecastCategory ?? null, stage: before.stage ?? null, isClosed: before.isClosed, isWon: before.isWon, closeDate: dates[0] ?? before.closeDate ?? null }] : [],
        ...dates.slice(1).map((closeDate) => ({ at: since, closeDate })),
        // Every amount and category it held in the window, so a drop from a peak in it (or since it was created) is flagged.
        ...(change?.amounts ?? []).map((amount) => ({ at: since, amount })),
        ...(change?.categories ?? []).map((forecastCategory) => ({ at: since, forecastCategory, isClosed: false, isWon: false })),
        ...after ? [{ at: ctx.now, amount: after.amount ?? null, forecastCategory: after.forecastCategory ?? null, stage: after.stage ?? null, isClosed: after.isClosed, isWon: after.isWon, closeDate: after.closeDate ?? null }] : []
      ];
      const fired = deal ? risksOf(deal, history, acts.filter((a) => a.dealId === id && typeof a.at === "number"), DEFAULT_RISK_SETTINGS, ctx.now) : [];
      const mine = existing.filter((r) => r.data.deal === id);
      for (const r of fired) {
        const key = `${id}|${r.rule}`, doc = mine.find((x) => x.key === key);
        const owner = deal?.ownerId ?? null;
        const data = { deal: id, rule: r.rule, severity: r.severity, evidence: r.evidence, ...owner ? { owner } : {} };
        if (!doc) {
          out.push({ op: "put", collection: "risks", key, data: { ...data, since: ctx.now }, expect: [{ collection: "risks", key, version: null }] });
          if (r.severity === "high" && owner) out.push({ op: "notify", to: [owner], subject: `${deal?.name ?? "A deal"} is at risk`, badge: "Forecast", message: r.evidence, link: "inspect" });
        } else if (doc.data.evidence !== r.evidence || (doc.data.owner ?? null) !== owner) {
          const { deal: _deal, rule: _rule, ...moved } = data;
          out.push({ op: "patch", collection: "risks", key, data: moved, ...owner ? {} : { unset: ["owner"] }, expect: [{ collection: "risks", key, version: doc.version }] });
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
    const period = reads.period;
    if (!period) return { value: { rows: [], period: null } };
    const changes = new Map(reads.changes.map((c) => [c.id, c]));
    const risks = /* @__PURE__ */ new Map();
    for (const r of reads.risks) if (r.data.status === "open") risks.set(String(r.data.deal), [...risks.get(String(r.data.deal)) ?? [], String(r.data.evidence)]);
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    const rows = reads.deals.filter((d) => !d.isClosed).map((d) => {
      const c = changes.get(d.id), b = c?.before ?? null;
      const amountBefore = b && b.amount !== d.amount ? b.amount ?? null : null;
      const dates = c?.closeDates ?? [];
      const first = b?.closeDate ?? dates[0] ?? null;
      const pushed = !!(first && d.closeDate && d.closeDate > first);
      const from = b ? standingOf(b) : null, to = standingOf(d);
      const flags = risks.get(d.id) ?? [];
      return {
        id: d.id,
        name: d.name ?? "",
        ownerId: d.ownerId ?? null,
        companyName: d.companyName ?? null,
        amount: d.amount ?? 0,
        closeDate: d.closeDate ?? null,
        stage: d.stage ?? null,
        category: label[to],
        amountBefore,
        amountDown: amountBefore !== null && (d.amount ?? 0) < amountBefore,
        amountWas: amountBefore === null ? "" : `Was ${dollars(amountBefore)}`,
        pushed,
        datesHeld: dates.length > 1 ? `Close date moved ${dates.join(" → ")}` : "",
        categoryMove: from && from !== to ? `${label[from]} → ${label[to]}` : "",
        moved: !!(from && from !== to),
        risks: flags.join(" · "),
        riskCount: flags.length,
        atRisk: flags.length > 0,
        mine: d.ownerId === ctx.caller.userId
      };
    });
    return { value: { period: period.data, days: ctx.args.days ?? 7, rows } };
  },
  /**
   * What moved in the quarter's amount between two dates (engine moves: start + the steps = end, checked), the category
   * moves, and where the deals of Commit and of Best case went (engine flow).
   */
  moved(_ctx, reads) {
    const period = reads.period;
    if (!period) return { value: { period: null, steps: [], categoryMoves: [], flows: [] } };
    const p = { start: String(period.data.start), end: String(period.data.end) };
    const changes = reads.changes;
    const names = new Map(changes.map((c) => [c.id, (c.after ?? c.before)?.name ?? c.id]));
    const m = moves(changes, p);
    const STEP = { new: "New", moved_in: "Moved in", increased: "Increased", decreased: "Decreased", slipped: "Slipped", moved_out: "Pulled out of the quarter", lost: "Lost" };
    const steps = Object.entries(m.buckets).filter(([, b]) => b.deals.length).map(([k, b]) => ({ step: STEP[k], amount: b.amount, deals: b.deals.length, names: b.deals.map((d) => names.get(d.id)).join(", ") }));
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    const END = { won: "Won", upgraded: "Upgraded", downgraded: "Downgraded", idle: "Unchanged", slipped: "Slipped", lost: "Lost" };
    const flows = ["commit", "best_case"].flatMap((from) => {
      const f = flow(changes, p, from);
      return [
        ...Object.entries(f.ends).filter(([, e]) => e.deals.length).map(([k, e]) => ({ from: label[from], to: END[k], amount: e.amount, deals: e.deals.length, names: e.deals.map((id) => names.get(id)).join(", ") })),
        ...f.into.length ? [{ from: label[from], to: "Came in", amount: f.into.reduce((n, x) => n + x.amount, 0), deals: f.into.length, names: f.into.map((x) => names.get(x.id)).join(", ") }] : []
      ];
    });
    return { value: {
      period: period.data,
      start: m.start,
      end: m.end,
      won: m.won.amount,
      newAmount: m.buckets.new.amount + m.buckets.moved_in.amount,
      up: m.buckets.increased.amount,
      down: m.buckets.decreased.amount,
      slipped: m.buckets.slipped.amount + m.buckets.moved_out.amount,
      lost: m.buckets.lost.amount,
      steps,
      categoryMoves: m.categoryMoves.map((c) => ({ deal: names.get(c.id), from: label[c.from], to: label[c.to], amount: c.amount })),
      flows
    } };
  },
  /**
   * Close a period: each member's call at its accuracy week (the Nth week anyone submitted in it, `settings.accuracyWeek`,
   * 4 by default) against what their part of the tree actually won (engine accuracyOf), and the period's final won.
   * Run once the quarter is over; a closed period's calls stay as they were.
   */
  closePeriod(ctx, reads) {
    const period = reads.period;
    if (!period) throw new Error("Pick the period to close.");
    if (period.key === "current") throw new Error("Close a quarter by its own name, not the current one.");
    if (period.data.status === "closed") throw new Error(`${String(period.data.label)} is already closed.`);
    if (String(period.data.end) >= today(ctx)) throw new Error(`${String(period.data.label)} isn't over until ${String(period.data.end)}. Close it after that.`);
    const weekN = Math.max(1, Number(reads.settings?.data.accuracyWeek ?? 4));
    const users = reads.users;
    const parent = tree(users, reads.teams ?? []);
    const numbers = systemNumbers(reads.deals, users.map((u) => u.id));
    const rows = rollup(parent, numbers, [], [], /* @__PURE__ */ new Map());
    const subs = reads.subs.filter((x) => x.data.status === "submitted");
    const weeks = [...new Set(subs.map((x) => String(x.data.week)))].sort();
    const week = weeks[Math.min(weekN, weeks.length) - 1] ?? null;
    const intents = [];
    const existing = new Map(reads.existing.map((d) => [d.key, d]));
    const unowned = numbers.get(null)?.won ?? 0;
    for (const sub of subs.filter((x) => x.data.week === week)) {
      const member = String(sub.data.member), row = rows.get(member);
      const actual = (row?.won ?? 0) + (row && !row.parent ? unowned : 0);
      const a = accuracyOf(Number(sub.data.call), actual);
      const key = `${period.data.period}|${member}`;
      intents.push({ op: "put", collection: "accuracy", key, data: { period: period.data.period, member, week, call: a.call, actual: a.actual, error: a.error, ...a.accuracy === null ? {} : { accuracy: a.accuracy } }, expect: [{ collection: "accuracy", key, version: existing.get(key)?.version ?? null }] });
    }
    const finalWon = [...rows.values()].filter((r) => !r.parent).reduce((n, r) => n + r.won, 0) + unowned;
    intents.push({ op: "patch", collection: "periods", key: period.key, data: { status: "closed", finalWon, closedAt: ctx.now }, expect: [{ collection: "periods", key: period.key, version: period.version }] });
    return { intents, value: { label: period.data.label, members: intents.length - 1, week, finalWon } };
  },
  /** The deal page's Forecast panel (P6): the deal's forecast category, close date and next step; its risks are a view. */
  dealPanel(_ctx, reads) {
    const deal = reads.deal[0];
    if (!deal) return { value: { category: null } };
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    return { value: { category: label[standingOf(deal)], closeDate: deal.closeDate ?? null, nextStep: deal.nextStep ?? null } };
  },
  /**
   * The weekly freeze (daily, a schedule): each member's numbers and call this week, as they stand now, kept per
   * week so history, trend and accuracy never read the past again. On the cadence day it also tells everyone whose
   * call is due.
   */
  freezeWeek(ctx, reads) {
    const period = reads.period;
    if (!period) return { intents: [] };
    const { settings, week, users, numbers, rows, submitted } = weekOfPeriod(ctx, reads, period);
    const existing = new Map(reads.existing.map((d) => [d.key, d]));
    const asOf = today(ctx);
    const unowned = numbers.get(null);
    const intents = [...rows.values()].map((r) => {
      const key = `${period.data.period}|${week}|${r.member}`;
      const add2 = (f) => r[f] + (!r.parent && unowned ? unowned[f] : 0);
      const data = {
        period: period.data.period,
        week,
        member: r.member,
        top: !r.parent,
        asOf,
        won: add2("won"),
        commit: add2("commit"),
        bestCase: add2("bestCase"),
        pipeline: add2("pipeline"),
        openCount: add2("openCount"),
        target: r.target,
        ...r.adjustedCall !== null ? { call: r.adjustedCall } : {}
      };
      return { op: "put", collection: "rollups", key, data, expect: [{ collection: "rollups", key, version: existing.get(key)?.version ?? null }] };
    });
    const iso2 = (new Date(ctx.now).getUTCDay() + 6) % 7 + 1;
    const due = iso2 === settings.cadenceDay ? users.filter((u) => u.isActive !== false && !submitted.has(u.id)).map((u) => u.id) : [];
    for (let i = 0; i < due.length; i += 50) intents.push({ op: "notify", to: due.slice(i, i + 50), subject: "Your forecast call is due", badge: "Forecast", message: `Submit your call for the week of ${week}.`, link: "mine" });
    return { intents, value: { week, members: rows.size } };
  },
  /**
   * The deals behind a member's numbers in the period, as the Team page counts them: theirs and their tree's, plus the
   * deals no member owns for a top-level member. Total (won and commit), closed won and open, by category.
   */
  memberDeals(ctx, reads) {
    const period = reads.period;
    const member = String(ctx.args.member);
    if (!period) return { value: { deals: [] } };
    const users = reads.users;
    const parent = tree(users, reads.teams ?? []);
    const names = new Map(users.map((u) => [u.id, u.name ?? u.id]));
    const under = (m) => {
      for (let p = m; p; p = parent.get(p)) if (p === member) return true;
      return false;
    };
    const top = !parent.get(member);
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted" };
    const deals = reads.deals.filter((d) => d.ownerId && names.has(d.ownerId) ? under(d.ownerId) : top);
    const rows = deals.map((d) => ({
      id: d.id,
      name: d.name ?? "",
      companyName: d.companyName ?? null,
      owner: d.ownerId && names.has(d.ownerId) ? names.get(d.ownerId) : "No Canon owner",
      amount: d.amount ?? 0,
      closeDate: d.closeDate,
      stage: d.stage ?? null,
      category: label[categoryOf(d)],
      open: !d.isClosed && !d.isWon
    }));
    const sum = (f) => rows.filter(f).reduce((n, r) => n + r.amount, 0);
    return { value: { period: period.data, deals: rows, total: sum((r) => r.category === "Closed won" || r.category === "Commit"), won: sum((r) => r.category === "Closed won"), open: sum((r) => r.open) } };
  },
  /** A deal's insights: its activity, newest first, how many people it has reached, and when it was last touched. */
  insights(ctx, reads) {
    const deal = reads.deal[0];
    if (!deal) return { value: { deal: null, activities: [], team: [] } };
    const acts = reads.acts.filter((a) => typeof a.at === "number").sort((a, b) => b.at - a.at);
    const last = acts[0]?.at ?? null;
    const label = { won: "Closed won", commit: "Commit", best_case: "Best case", pipeline: "Pipeline", omit: "Omitted", lost: "Closed lost" };
    return { value: {
      deal: { name: deal.name ?? "", amount: deal.amount ?? 0, closeDate: deal.closeDate ?? null, category: label[standingOf(deal)], nextStep: deal.nextStep ?? null },
      lastAt: last,
      daysSince: last === null ? null : Math.floor((ctx.now - last) / 864e5),
      count: acts.length,
      people: new Set(acts.map((a) => a.personId).filter(Boolean)).size,
      // The people on the deal (deals.people, 1.6.0), each with their role and when activity last named them.
      ...onDeal(reads.team, acts),
      activities: acts.map((a) => ({ id: a.id, at: a.at, kind: a.kind ?? "", subject: a.subject ?? null, outcome: a.outcome ?? null }))
    } };
  }
};
export {
  calls,
  weekOf
};
