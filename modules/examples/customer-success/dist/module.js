var RENEWAL_WINDOW_DAYS = 30;
var DAY = 864e5;
var ms = (day) => Date.parse(`${day}T00:00:00Z`);
var addDays = (day, n) => new Date(ms(day) + n * DAY).toISOString().slice(0, 10);
function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
var recurringWin = (d) => !!d.isWon && d.revenueType !== "one_time" && d.dealType !== "one_time";
var ORDER = { new_business: 0, renewal: 1, expansion: 2 };
function ledger(deals) {
  const skipped = [];
  const byCompany = /* @__PURE__ */ new Map();
  for (const d of deals) {
    if (!recurringWin(d)) continue;
    const skip = (why) => skipped.push({ deal: d.id, dealName: d.name ?? d.id, company: d.companyId ?? null, closeDate: d.closeDate ?? null, why });
    if (!d.closeDate) skip("no_close_date");
    else if (!d.companyId) skip("no_company");
    else if (!((d.arr ?? d.amount ?? 0) > 0)) skip("no_arr");
    else byCompany.set(d.companyId, [...byCompany.get(d.companyId) ?? [], d]);
  }
  const lines = [];
  for (const [company, list] of byCompany) {
    const sorted = [...list].sort((a, b) => a.closeDate.localeCompare(b.closeDate) || (ORDER[a.dealType ?? ""] ?? 0) - (ORDER[b.dealType ?? ""] ?? 0) || a.id.localeCompare(b.id));
    const mine = [];
    for (const d of sorted) {
      const start = d.closeDate, assumed = [];
      if (!(d.arr && d.arr > 0)) assumed.push("arr_from_amount");
      if (!(d.contractLengthMonths && d.contractLengthMonths > 0)) assumed.push("length_assumed");
      const end = addMonths(start, d.contractLengthMonths && d.contractLengthMonths > 0 ? d.contractLengthMonths : 12);
      const arr = d.arr && d.arr > 0 ? d.arr : d.amount;
      let kind = d.dealType === "expansion" ? "expansion" : "new";
      let renews = [];
      if (d.dealType === "renewal") {
        renews = mine.filter((l) => l.until > addDays(start, -RENEWAL_WINDOW_DAYS) && Math.abs(ms(l.end) - ms(start)) <= RENEWAL_WINDOW_DAYS * DAY);
        if (!renews.length) assumed.push("renews_nothing");
        for (const l of renews) if (l.until > start) l.until = start;
        const before = renews.reduce((n, l) => n + l.arr, 0);
        kind = renews.length && arr < before ? "contraction" : "renewal";
      }
      mine.push({
        deal: d.id,
        dealName: d.name ?? d.id,
        company,
        kind,
        start,
        end,
        until: end,
        arr,
        owner: d.ownerId ?? null,
        renews: renews.map((l) => l.deal),
        renewedArr: renews.length ? renews.reduce((n, l) => n + l.arr, 0) : null,
        assumed
      });
    }
    lines.push(...mine);
  }
  return { lines, skipped };
}
var counts = (l, day) => l.start <= day && day < l.until;
function arrOn(lines, day) {
  const out = /* @__PURE__ */ new Map();
  for (const l of lines) if (counts(l, day)) out.set(l.company, (out.get(l.company) ?? 0) + l.arr);
  return out;
}
function accountOf(lines, today2) {
  const live = lines.filter((l) => counts(l, today2));
  const latest = lines.reduce((m, l) => !m || l.start > m.start || l.start === m.start && l.deal > m.deal ? l : m, null);
  return {
    arr: live.reduce((n, l) => n + l.arr, 0),
    renewalOn: live.length ? live.map((l) => l.end).sort()[0] : null,
    since: lines.length ? lines.map((l) => l.start).sort()[0] : null,
    lastDeal: latest?.deal ?? null,
    lastOwner: latest?.owner ?? null
  };
}

var GROW_DEFAULTS = { declinePercent: 30, inactiveDays: 14, renewalDays: 90, seatPercent: 90, growthPercent: 25 };
var SIGNAL_KINDS = ["declining", "inactive", "renewal", "seats", "growth"];
var object = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var domainOf = (x) => {
  if (typeof x !== "string") return null;
  const domain = x.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
};
function dailyUsage(data, today2) {
  if (!object(data) || typeof data.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.day) || !Number.isFinite(Date.parse(data.day)) || new Date(data.day).toISOString().slice(0, 10) !== data.day) return "A daily aggregate needs a valid UTC day (YYYY-MM-DD).";
  if (data.day > today2 || data.day < addDays(today2, -90)) return "The day must be within the last 90 days, including today.";
  if (!object(data.metrics) || !Object.keys(data.metrics).length || Object.keys(data.metrics).length > 30) return "Supply 1 to 30 numeric daily metrics.";
  const metrics = {};
  for (const [name, value] of Object.entries(data.metrics)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12) return "Metrics need names in snake_case and finite values from 0 to 1 trillion.";
    metrics[name] = value;
  }
  return { day: data.day, metrics };
}
var daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
var round = (n) => Math.round(n * 10) / 10;
function usageSignals(usage, account, today2, settings = GROW_DEFAULTS) {
  const rows = [...new Map(usage.filter((u) => u.day <= today2).map((u) => [u.day, u])).values()].sort((a, b) => a.day.localeCompare(b.day));
  if (!rows.length) return [];
  const out = [];
  const add2 = (kind, category, title, evidence) => out.push({ kind, category, title, evidence });
  const active = rows.filter((u) => u.metrics.active_users !== void 0);
  const window = (from, to) => active.filter((u) => u.day >= addDays(today2, from) && u.day < addDays(today2, to));
  const prior = window(-56, -28), recent = window(-28, 0);
  const mean = (items) => items.reduce((n, u) => n + u.metrics.active_users, 0) / items.length;
  const baseline = mean(prior), current = mean(recent);
  const covered = prior.length >= 21 && recent.length >= 21;
  const drop = covered && baseline > 0 ? (baseline - current) / baseline * 100 : 0;
  const comparison = `Active users/day ${round(baseline)} to ${round(current)} (${round(drop)}% down). ${addDays(today2, -56)}–${addDays(today2, -29)}: ${prior.length}/28 days; ${addDays(today2, -28)}–${addDays(today2, -1)}: ${recent.length}/28 days.`;
  if (covered && drop >= settings.declinePercent) add2("declining", "Churn risk", "Active users declining", `${comparison} Threshold ${settings.declinePercent}%.`);
  const renewalIn = account.renewalOn ? daysBetween(today2, account.renewalOn) : -1;
  if (covered && drop >= settings.declinePercent && renewalIn >= 0 && renewalIn <= settings.renewalDays) add2("renewal", "Churn risk", "Renewal with declining usage", `Renews ${account.renewalOn}, in ${renewalIn} days (within ${settings.renewalDays}). ${comparison} Decline threshold ${settings.declinePercent}%.`);
  const activity = rows.filter((u) => u.metrics.active_users !== void 0 || u.metrics.key_events !== void 0);
  const lastPositive = activity.filter((u) => (u.metrics.active_users ?? 0) > 0 || (u.metrics.key_events ?? 0) > 0).at(-1);
  const lastReport = activity.at(-1);
  if (lastReport) {
    const since = lastPositive?.day ?? activity[0].day;
    const days = daysBetween(since, today2);
    if (days >= settings.inactiveDays) add2("inactive", "Churn risk", "No reported usage", `${days} days since ${lastPositive ? "positive activity" : "tracking began with zero activity"} on ${since}; threshold ${settings.inactiveDays}. Last activity report ${lastReport.day}, ${daysBetween(lastReport.day, today2)} days ago. Missing reports may indicate a feed outage.`);
  }
  const seats = rows.filter((u) => u.metrics.seats_used !== void 0 && (u.metrics.seats_purchased ?? 0) > 0).at(-1);
  if (seats && daysBetween(seats.day, today2) <= 2) {
    const ratio = seats.metrics.seats_used / seats.metrics.seats_purchased * 100;
    if (ratio >= settings.seatPercent) add2("seats", "Expansion", "Seats near limit", `${seats.metrics.seats_used}/${seats.metrics.seats_purchased} seats used (${round(ratio)}%) on ${seats.day}; threshold ${settings.seatPercent}%.`);
  }
  const weeks = Array.from({ length: 4 }, (_, i) => window(-28 + i * 7, -21 + i * 7));
  if (covered && baseline > 0 && weeks.every((w) => w.length >= 5 && mean(w) >= baseline * (1 + settings.growthPercent / 100))) add2("growth", "Expansion", "Sustained usage growth", `Prior 4-week active users/day ${round(baseline)} (${prior.length}/28 days). Each recent week averages ${weeks.map((w) => round(mean(w))).join(", ")} with ${weeks.map((w) => w.length).join(", ")} reported days; each at least ${settings.growthPercent}% above baseline.`);
  return out;
}

var docs = (value) => value;
var dayOf = (now) => new Date(now).toISOString().slice(0, 10);
var usageOf = (doc) => ({ day: String(doc.data.day), metrics: doc.data.metrics });
var settingsOf = (doc) => ({ ...GROW_DEFAULTS, ...doc?.data ?? {} });
var sourceKey = async (id) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))), (n) => n.toString(16).padStart(2, "0")).join("");
var growCalls = {
  async onUsage(ctx, reads) {
    const day = dayOf(ctx.now);
    const accounts = new Set(docs(reads.accounts).map((a) => a.key));
    const domains = /* @__PURE__ */ new Map();
    for (const company of reads.companies) {
      const domain = domainOf(company.domain);
      if (domain && accounts.has(company.id)) domains.set(domain, [...domains.get(domain) ?? [], company.id]);
    }
    const usage = new Map(docs(reads.usage).map((u) => [u.key, u]));
    const writes = /* @__PURE__ */ new Map();
    for (const item of ctx.args.items) {
      if (![item.before, item.after].some((v) => typeof v?.type === "string" && v.type.startsWith("usage."))) continue;
      const source = await sourceKey(item.id);
      const removePrevious = () => {
        for (const row of usage.values()) {
          if (row.data.source !== source || Number(row.data.sourceAt) > item.at) continue;
          usage.delete(row.key);
          writes.set(`usage:${row.key}`, { op: "delete", collection: "usage", key: row.key, ifPresent: true });
        }
      };
      writes.set(`review:${source}`, { op: "delete", collection: "usageReview", key: source, ifPresent: true });
      const after = item.after;
      if (typeof after?.type !== "string" || !after.type.startsWith("usage.")) {
        removePrevious();
        continue;
      }
      const domain = domainOf(object(after.subject) ? after.subject.domain : null);
      const daily = after.type === "usage.daily" ? dailyUsage(after.data, day) : "Only usage.daily aggregates are supported. Send raw events to your own aggregator.";
      const matches = domain ? domains.get(domain) ?? [] : [];
      const reason = typeof daily === "string" ? daily : !domain ? "Missing subject domain." : matches.length === 0 ? "No customer account has this domain." : matches.length > 1 ? "Multiple customer accounts have this domain." : null;
      if (reason || typeof daily === "string") {
        writes.set(`review:${source}`, { op: "put", collection: "usageReview", key: source, data: {
          source,
          domain: domain ?? "Unknown",
          day: object(after.data) && typeof after.data.day === "string" ? after.data.day.slice(0, 40) : "Unknown",
          reason
        } });
        continue;
      }
      removePrevious();
      const account = matches[0], key = `${account}|${daily.day}`;
      const existing = usage.get(key);
      if (existing && Number(existing.data.sourceAt) > item.at) continue;
      const data = { account, ...daily, source, sourceAt: item.at };
      writes.set(`usage:${key}`, { op: "put", collection: "usage", key, parentKey: account, data });
      usage.set(key, { key, data });
    }
    return { intents: [...writes.values()] };
  },
  signals(ctx, reads) {
    const day = dayOf(ctx.now), settings = settingsOf(reads.settings);
    const usage = docs(reads.usage);
    const rows = docs(reads.accounts).filter((a) => Number(a.data.arr) > 0).flatMap((a) => {
      const dismissed = a.data.dismissed ?? [];
      return usageSignals(usage.filter((u) => u.parentKey === a.key).map(usageOf), a.data, day, settings).filter((s) => !dismissed.includes(s.kind)).map((s) => ({ ...s, account: a.key, companyName: a.data.companyName ?? a.key, arr: a.data.arr }));
    });
    const risk = rows.filter((r) => r.category === "Churn risk"), expansion = rows.filter((r) => r.category === "Expansion");
    const riskAccounts = new Set(risk.map((r) => r.account));
    return { value: { risk, expansion, riskArr: docs(reads.accounts).filter((a) => riskAccounts.has(a.key)).reduce((n, a) => n + Number(a.data.arr), 0), asOf: day } };
  },
  accountUsage(ctx, reads) {
    const account = reads.account;
    if (!account) return { value: { rows: [], signals: [], summary: "No customer account is visible." } };
    const rows = docs(reads.usage).map(usageOf).sort((a, b) => a.day.localeCompare(b.day));
    const dismissed = account.data.dismissed ?? [];
    const signals = Number(account.data.arr) > 0 ? usageSignals(rows, account.data, dayOf(ctx.now), settingsOf(reads.settings)).filter((s) => !dismissed.includes(s.kind)) : [];
    return { value: {
      rows: rows.filter((u) => u.metrics.active_users !== void 0).map((u) => ({ day: u.day, activeUsers: u.metrics.active_users })),
      signals,
      summary: rows.length ? `Last aggregate ${rows.at(-1).day}. Missing days are unknown; counts are daily active users.` : "No usage yet. Connect a signed usage.daily webhook in Settings > Feeds."
    } };
  },
  restoreSignals(_ctx, reads) {
    const account = reads.account;
    if (!account) throw new Error("Choose a visible account.");
    return { intents: [{ op: "patch", collection: "accounts", key: account.key, data: {}, unset: ["dismissed"], expect: [{ collection: "accounts", key: account.key, version: account.version }] }] };
  },
  dismissSignal(ctx, reads) {
    const account = reads.account;
    if (!account || !SIGNAL_KINDS.includes(ctx.args.kind)) throw new Error("Choose a visible account and a signal rule.");
    const dismissed = [.../* @__PURE__ */ new Set([...account.data.dismissed ?? [], String(ctx.args.kind)])];
    return { intents: [{ op: "patch", collection: "accounts", key: account.key, data: { dismissed }, expect: [{ collection: "accounts", key: account.key, version: account.version }] }] };
  }
};

var empty = () => ({ start: 0, end: 0, grrNumerator: 0, nrr: null, grr: null, churn: 0, contraction: 0, expansion: 0, accounts: 0 });
function add(t, c) {
  t.start += c.start;
  t.end += c.end;
  t.grrNumerator += Math.min(c.start, c.end);
  t.accounts += 1;
  if (c.end === 0) t.churn += c.start;
  else if (c.end < c.start) t.contraction += c.start - c.end;
  else t.expansion += c.end - c.start;
}
var ratios = (t) => ({ ...t, nrr: t.start > 0 ? t.end / t.start : null, grr: t.start > 0 ? t.grrNumerator / t.start : null });
function companiesOver(lines, from, to) {
  const before = arrOn(lines, addDays(from, -1)), after = arrOn(lines, to);
  const out = [];
  for (const company of /* @__PURE__ */ new Set([...before.keys(), ...after.keys()])) {
    const start = before.get(company) ?? 0, end = after.get(company) ?? 0;
    const outcome = start === 0 ? "new" : end === 0 ? "churned" : end < start ? "contracted" : end > start ? "expanded" : "flat";
    out.push({ company, start, end, outcome });
  }
  return out.sort((a, b) => b.start - a.start || b.end - a.end || a.company.localeCompare(b.company));
}
function retention(lines, from, to, groupOf) {
  const companies = companiesOver(lines, from, to);
  const total = empty(), groups = /* @__PURE__ */ new Map();
  const newLogos = companies.filter((c) => c.outcome === "new");
  for (const c of companies) {
    if (c.outcome === "new") continue;
    add(total, c);
    if (groupOf) {
      const g = groupOf(c.company);
      if (!groups.has(g)) groups.set(g, empty());
      add(groups.get(g), c);
    }
  }
  return {
    total: ratios(total),
    groups: new Map([...groups].map(([g, t]) => [g, ratios(t)])),
    companies,
    newLogos: newLogos.map((c) => ({ company: c.company, arr: c.end })),
    newLogoArr: newLogos.reduce((n, c) => n + c.end, 0)
  };
}
function monthly(lines, from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    const [y, mo] = m.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const { total } = retention(lines, from, monthEnd < to ? monthEnd : to);
    out.push({ month: m, nrr: total.nrr, grr: total.grr });
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  return out;
}

var today = (now) => new Date(now).toISOString().slice(0, 10);
var ASSUMED = {
  arr_from_amount: "No ARR on the deal: its amount is used",
  length_assumed: "No contract length: 12 months assumed",
  renews_nothing: "A renewal of no contract Canon has"
};
var SKIPPED = {
  no_company: "No company on the deal: not counted",
  no_arr: "No ARR or amount: not counted",
  no_close_date: "No close date: not counted"
};
var SEGMENT = { enterprise: "Enterprise", mid: "Mid-market", smb: "SMB" };
var calls = {
  ...growCalls,
  /** The deal feed: a deal's old and new company have their contracts rebuilt. */
  onDeals(ctx) {
    const keys = /* @__PURE__ */ new Set();
    for (const c of ctx.args.changes) {
      for (const side of [c.before, c.after]) if (typeof side?.companyId === "string" && side.companyId) keys.add(side.companyId);
    }
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "contracts", key })) };
  },
  /**
   * Every customer's contracts rebuilt, daily and on install (the feed sees only later changes): ARR moves when a
   * contract ends with no deal changing, and a deal's ARR and length aren't on the feed.
   */
  sweep(_ctx, reads) {
    const keys = /* @__PURE__ */ new Set();
    for (const d of reads.deals) if (d.isWon && d.companyId) keys.add(d.companyId);
    for (const a of reads.accounts) keys.add(a.key);
    return { intents: [...keys].map((key) => ({ op: "dirty", job: "contracts", key })) };
  },
  /**
   * The contracts job: each company's contract lines from its won recurring deals (engine ledger), and its account's
   * ARR, next renewal and newest deal. A new account starts with the newest deal's owner as its CSM; after that the
   * CSM and segment are a person's, and the contracts follow the account's CSM.
   */
  rebuild(ctx, reads) {
    const keys = ctx.args.keys;
    const wanted = new Set(keys);
    const deals = reads.deals.filter((d) => d.companyId && wanted.has(d.companyId));
    const { lines } = ledger(deals);
    const accounts = new Map(reads.accounts.map((a) => [a.key, a]));
    const contracts = reads.contracts;
    const names = new Map(reads.companies.map((c) => [c.id, c.name]));
    const day = today(ctx.now);
    const byKey = {};
    for (const company of keys) {
      const out = byKey[company] = [];
      const mine = lines.filter((l) => l.company === company);
      const existing = accounts.get(company);
      if (!mine.length && !existing) continue;
      const a = accountOf(mine, day);
      const name = names.get(company) ?? existing?.data.companyName ?? null;
      const facts = { arr: a.arr, contracts: mine.length, ...name ? { companyName: name } : {}, ...a.renewalOn ? { renewalOn: a.renewalOn } : {}, ...a.since ? { since: a.since } : {}, ...a.lastDeal ? { lastDeal: a.lastDeal } : {} };
      const csm = existing ? existing.data.csm ?? null : a.lastOwner;
      if (!existing) {
        out.push({ op: "put", collection: "accounts", key: company, data: { company, ...facts, ...csm ? { csm } : {} }, expect: [{ collection: "accounts", key: company, version: null }] });
      } else {
        const changed = Object.entries(facts).some(([k, v]) => existing.data[k] !== v);
        const unset = ["renewalOn", "since", "lastDeal"].filter((k) => !(k in facts) && existing.data[k] !== void 0);
        if (changed || unset.length) out.push({ op: "patch", collection: "accounts", key: company, data: facts, ...unset.length ? { unset } : {}, expect: [{ collection: "accounts", key: company, version: existing.version }] });
      }
      const had = new Map(contracts.filter((c) => c.data.account === company).map((c) => [c.key, c]));
      for (const l of mine) {
        const data = contractData(l, csm);
        const doc = had.get(l.deal);
        had.delete(l.deal);
        if (doc && same(doc.data, data)) continue;
        out.push({ op: "put", collection: "contracts", key: l.deal, parentKey: company, data, expect: [{ collection: "contracts", key: l.deal, version: doc?.version ?? null }] });
      }
      for (const doc of had.values()) out.push({ op: "delete", collection: "contracts", key: doc.key, expect: [{ collection: "contracts", key: doc.key, version: doc.version }] });
    }
    return { byKey };
  },
  /**
   * Retention for a period (engine retention) over the contracts the caller reads, the ledger the contracts job keeps,
   * so a CSM's Retention covers the same accounts as their Portfolio whoever owns the deals: the cohort's start and end
   * ARR, NRR, GRR, churn, contraction and expansion, by segment and by CSM, NRR and GRR month by month, the new logos
   * apart, the steps from starting to ending ARR, and the deals guessed at or left out. An end after today reads the
   * contracts booked to run then.
   */
  retention(ctx, reads) {
    const from = String(ctx.args.from), to = String(ctx.args.to);
    if (from > to) throw new Error(`The period starts after it ends (${from} to ${to}).`);
    const lines = reads.contracts.map(lineOf);
    const { skipped } = ledger(reads.deals);
    const accounts = new Map(reads.accounts.map((a) => [a.key, a]));
    const users = new Map(reads.users.map((u) => [u.id, u.name ?? u.id]));
    const companyName = (c) => accounts.get(c)?.data.companyName ?? c;
    const segmentOf = (c) => SEGMENT[String(accounts.get(c)?.data.segment)] ?? "No segment";
    const csmOf = (c) => accounts.get(c)?.data.csm ?? null;
    const r = retention(lines, from, to);
    const bySegment = retention(lines, from, to, segmentOf).groups;
    const byCsm = retention(lines, from, to, (c) => csmOf(c) ?? "").groups;
    const groups = [
      ...[...bySegment].map(([g, t]) => ({ by: "Segment", label: g, ...t })),
      ...[...byCsm].map(([g, t]) => ({ by: "CSM", label: g ? users.get(g) ?? g : "No CSM", ...t }))
    ];
    const OUTCOME = { churned: "Churned", contracted: "Contracted", expanded: "Expanded", flat: "Renewed flat", new: "New logo" };
    const rows = companiesOver(lines, from, to).map((c) => ({
      company: c.company,
      name: companyName(c.company),
      segment: segmentOf(c.company),
      csm: csmOf(c.company),
      startArr: c.start,
      endArr: c.end,
      change: c.end - c.start,
      outcome: OUTCOME[c.outcome],
      inCohort: c.outcome !== "new"
    }));
    const edges = [addDays(from, -1), to];
    const counted = (l) => edges.some((d) => l.start <= d && d < l.until);
    const notes = [
      ...reads.contracts.filter((c) => c.data.note && counted(lineOf(c))).map((c) => ({ deal: String(c.data.deal), name: String(c.data.dealName), company: companyName(String(c.data.account)), note: String(c.data.note), kind: "Guessed" })),
      ...skipped.filter((s) => s.closeDate && s.closeDate <= to && s.closeDate > addDays(from, -366)).map((s) => ({ deal: s.deal, name: s.dealName, company: s.company ? companyName(s.company) : "No company", note: SKIPPED[s.why], kind: "Left out" }))
    ];
    return { value: {
      from,
      to,
      ...r.total,
      newLogoArr: r.newLogoArr,
      newLogos: r.newLogos.map((n) => ({ company: n.company, name: companyName(n.company), arr: n.arr, csm: csmOf(n.company) })),
      groups,
      rows,
      // The cohort's walk from starting to ending ARR, for the page's waterfall: start − churn − contraction + expansion = end.
      bridge: [{ step: "Churn", amount: -r.total.churn }, { step: "Contraction", amount: -r.total.contraction }, { step: "Expansion", amount: r.total.expansion }],
      monthly: monthly(lines, from, to).flatMap((m) => [{ month: m.month, metric: "NRR", value: m.nrr ?? 0 }, { month: m.month, metric: "GRR", value: m.grr ?? 0 }]),
      notes,
      noteCount: notes.length
    } };
  }
};
var lineOf = (c) => ({
  deal: String(c.data.deal),
  dealName: String(c.data.dealName),
  company: String(c.data.account),
  kind: c.data.kind,
  start: String(c.data.start),
  end: String(c.data.end),
  until: String(c.data.until),
  arr: Number(c.data.arr),
  owner: c.data.csm ?? null,
  renews: [],
  renewedArr: c.data.renewedArr ?? null,
  assumed: []
});
function contractData(l, csm) {
  return {
    deal: l.deal,
    dealName: l.dealName,
    account: l.company,
    kind: l.kind,
    start: l.start,
    end: l.end,
    until: l.until,
    arr: l.arr,
    ...l.renewedArr !== null ? { renewedArr: l.renewedArr } : {},
    ...l.assumed.length ? { note: l.assumed.map((x) => ASSUMED[x]).join(" · ") } : {},
    ...csm ? { csm } : {}
  };
}
var same = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== "status"));
  return [...keys].every((k) => a[k] === b[k]);
};
export {
  calls
};
