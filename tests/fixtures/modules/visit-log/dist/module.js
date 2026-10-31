var nextMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
var monthDoc = (month) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return { month, start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}`, prev };
};
var calls = {
  /** The caller's visits counted by status, saved as their summary, with one line per status. */
  summarize(ctx, reads) {
    const visits = reads.mine;
    const current = reads.current;
    const byStatus = /* @__PURE__ */ new Map();
    let amount = 0;
    for (const v of visits) {
      const status = String(v.data.status);
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      if (typeof v.data.amount === "number") amount += v.data.amount;
    }
    const rep = ctx.caller.userId;
    const done = byStatus.get("done") ?? 0;
    const expect = [{ collection: "summaries", key: rep, version: current?.version ?? null }, ...visits.map((v) => ({ collection: "visits", key: v.key, version: v.version }))];
    const intents = [
      { op: "put", collection: "summaries", key: rep, data: { rep, visits: visits.length, done, amount, asOf: new Date(ctx.now).toISOString().slice(0, 10) }, expect },
      { op: "replaceSet", collection: "summaryLines", parentKey: rep, docs: [...byStatus].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => ({ status, count })) },
      { op: "event", collection: "summaries", key: rep, note: `Summarized ${visits.length} visits` }
    ];
    return { intents, value: `${visits.length} visits, ${done} done` };
  },
  /**
   * The visits done between two dates (a range read), every visit of the reps who did them (an `in` read by the
   * first read's reps), the notes on all of them (a set read across parents) and each rep's manager and title.
   */
  digest(_ctx, reads) {
    const done = reads.done;
    const all = reads.repVisits;
    const notes = reads.notes;
    const people = new Map(reads.people.map((p) => [p.id, p]));
    const reps = [...new Set(done.map((v) => String(v.data.rep)))].sort().map((id) => {
      const p = people.get(id);
      const manager = p?.managerId ? people.get(p.managerId) : void 0;
      return { rep: p?.name ?? id, title: p?.title ?? null, manager: manager?.name ?? null, active: p?.isActive ?? null, done: done.filter((v) => v.data.rep === id).length, visits: all.filter((v) => v.data.rep === id).length };
    });
    return { value: { done: done.map((v) => v.data.title), notes: notes.length, firstCreatedAt: Math.min(...done.map((v) => v.createdAt)), reps } };
  },
  /** How many notes the given visits have: a set read across the parents the caller names. */
  notesFor(_ctx, reads) {
    return { value: reads.notes.length };
  },
  /**
   * The tally job (docs/modules.md, "Jobs, watches and schedules"): each rep's won deals in one month, and the year so
   * far from the month before. A rep of "*" counts every rep the month has deals or tallies for. A tally that changed
   * dirties the same rep's next month, whose year to date reads it.
   */
  recount(ctx, reads) {
    const month = reads.month;
    const byKey = {};
    if (!month) return { byKey };
    if (month.data.hold) throw new Error(`${month.key} is on hold`);
    const deals = reads.deals.filter((d) => d.isWon && d.ownerId);
    const current = new Map(reads.current.map((t) => [String(t.data.rep), t]));
    const prior = new Map(reads.prior.map((t) => [String(t.data.rep), t]));
    for (const key of ctx.args.keys) {
      const rep = key.split("|")[1];
      const reps = rep === "*" ? [.../* @__PURE__ */ new Set([...deals.map((d) => d.ownerId), ...current.keys()])].sort() : [rep];
      const intents = [];
      for (const r of reps) {
        const mine = deals.filter((d) => d.ownerId === r);
        const amount = mine.reduce((n, d) => n + (d.amount ?? 0), 0);
        const before = prior.get(r);
        const ytd = month.data.month.endsWith("-01") || !before ? amount : Number(before.data.ytd) + amount;
        const now = current.get(r);
        if (now && now.data.status !== "open") continue;
        if (now && now.data.won === mine.length && now.data.amount === amount && now.data.ytd === ytd) continue;
        const expect = [
          { collection: "tallies", key: `${month.key}|${r}`, version: now?.version ?? null },
          { collection: "months", key: month.key, version: month.version },
          ...before ? [{ collection: "tallies", key: before.key, version: before.version }] : []
        ];
        intents.push({ op: "put", collection: "tallies", data: { month: month.key, rep: r, won: mine.length, amount, ytd }, expect, ...now ? { require: { field: "status", in: ["open"] } } : {} });
        intents.push({ op: "dirty", job: "tally", key: `${nextMonth(month.key)}|${r}` });
      }
      byKey[key] = intents;
    }
    return { byKey };
  },
  /** The deal feed: a won deal's tally, under the owner and month it had and the ones it has now. */
  onDeals(ctx) {
    const keys = /* @__PURE__ */ new Set();
    for (const c of ctx.args.changes) {
      for (const side of [c.before, c.after]) {
        if (side?.isWon && typeof side.closeDate === "string" && typeof side.ownerId === "string") keys.add(`${side.closeDate.slice(0, 7)}|${side.ownerId}`);
      }
    }
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "tally", key })) };
  },
  /** On a schedule: this month and the next exist, each counted for every rep once it is new. */
  ensureMonths(ctx, reads) {
    const have = new Set(reads.months.map((d) => d.key));
    const now = new Date(ctx.now).toISOString().slice(0, 7);
    const intents = [];
    for (const month of [now, nextMonth(now)]) {
      if (have.has(month)) continue;
      intents.push({ op: "put", collection: "months", data: monthDoc(month), expect: [{ collection: "months", key: month, version: null }] });
      intents.push({ op: "dirty", job: "tally", key: `${month}|*` });
    }
    return { intents };
  },
  /** A load test: `count` made-up reps' tallies of a month marked to run. */
  dirtyMany(ctx) {
    const month = String(ctx.args.month);
    const n = Number(ctx.args.count);
    return { intents: Array.from({ length: n }, (_, i) => ({ op: "dirty", job: "tally", key: `${month}|load${String(i).padStart(4, "0")}` })), value: n };
  }
};
export {
  calls
};
