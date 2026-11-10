var DEFAULT_REASONS = [
  { code: "product_fit", label: "Product fit", category: "product", applies: "both", description: "How well the product did the job the buyer bought it for." },
  { code: "missing_capability", label: "Missing capability", category: "product", applies: "loss", description: "Something the buyer needed that the product doesn't do." },
  { code: "integrations", label: "Integrations", category: "product", applies: "both", description: "How it connects to the systems the buyer already runs." },
  { code: "ease_of_use", label: "Ease of use", category: "product", applies: "both", description: "How easy the buyer found it to learn and use." },
  { code: "price", label: "Price", category: "price", applies: "both", description: "The price itself, against the budget or a competitor's." },
  { code: "packaging_terms", label: "Packaging and terms", category: "price", applies: "both", description: "Editions, seats, contract length and terms." },
  { code: "roi_case", label: "ROI case", category: "price", applies: "both", description: "Whether the return justified the spend." },
  { code: "sales_experience", label: "Sales experience", category: "sales_experience", applies: "both", description: "How the buyer found working with the sales team." },
  { code: "champion", label: "Champion strength", category: "relationship", applies: "both", description: "Whether someone inside sold it for us." },
  { code: "competitor_relationship", label: "Competitor relationship", category: "competition", applies: "loss", description: "A competitor's ties to the buyer." },
  { code: "incumbent", label: "Incumbent or status quo", category: "competition", applies: "loss", description: "The buyer kept what they had." },
  { code: "no_decision", label: "No decision or timing", category: "timing", applies: "loss", description: "The buyer didn't decide, or not now." },
  { code: "budget_cut", label: "Budget cut", category: "timing", applies: "loss", description: "The money went away." },
  { code: "security", label: "Security and compliance", category: "security", applies: "both", description: "Security review, compliance and data residency." },
  { code: "implementation_risk", label: "Implementation risk", category: "product", applies: "both", description: "The effort and risk of rolling it out." }
];
function segmentOf(employees) {
  if (typeof employees !== "number" || !Number.isFinite(employees) || employees <= 0) return void 0;
  return employees < 200 ? "SMB" : employees < 1e3 ? "Mid-market" : "Enterprise";
}
var DAY = 864e5;
var isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
var closedOn = (d) => isDay(d.closeDate) ? d.closeDate : typeof d.closedAt === "number" ? new Date(d.closedAt).toISOString().slice(0, 10) : null;
var crmText = (custom, slug, max) => {
  const v = slug ? custom?.[slug.replace(/^custom\./, "")] : void 0;
  const t = Array.isArray(v) ? v.join(", ") : v === null || v === void 0 ? "" : String(v);
  return t.trim() ? t.trim().slice(0, max) : void 0;
};
function reviewData(d, company, lastStage, crm = {}) {
  const day = closedOn(d);
  if (!d.isClosed || !d.ownerId || !day) return null;
  const data = { deal: d.id, rep: d.ownerId, outcome: d.isWon ? "won" : "lost", closedOn: day, amount: typeof d.amount === "number" ? d.amount : 0 };
  if (d.name) data.dealName = d.name.slice(0, 200);
  if (d.dealType) data.dealType = d.dealType;
  if (!d.isWon && lastStage) data.lostAtStage = lastStage;
  const loss = d.isWon ? void 0 : crmText(d.custom, crm.lossReasonField, 200), region = crmText(d.custom, crm.regionField, 120), source = crmText(d.custom, crm.sourceField, 120);
  if (loss) data.crmLossReason = loss;
  if (region) data.region = region;
  if (source) data.source = source;
  const segment = segmentOf(company?.employees);
  if (segment) data.segment = segment;
  if (typeof d.createdAt === "number") data.daysToClose = Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - d.createdAt) / DAY));
  return data;
}
var OPEN = ["pending", "drafting", "draft", "submitted"];
function intakeIntents(d, company, review, excluded, onlyNew = false, autoDraft = false, lastStage, crm = {}) {
  const expect = [{ collection: "reviews", key: d.id, version: review ? review.version : null }];
  const data = reviewData(d, company, lastStage, crm);
  if (!review) {
    if (!data || d.dealType && excluded.includes(d.dealType)) return [];
    return [{ op: "put", collection: "reviews", key: d.id, data, expect }, ...autoDraft ? [{ op: "transition", machine: "review", name: "autoDraft", key: d.id }] : []];
  }
  if (onlyNew) return [];
  const status = String(review.data.status);
  if (!d.isClosed) {
    if (OPEN.includes(status)) return [{ op: "transition", machine: "review", name: "dealReopened", key: d.id, expect }];
    if (status === "approved") return [{ op: "event", collection: "reviews", key: d.id, note: "The deal was reopened. The approved review stands.", expect }];
    return [];
  }
  if (!data) return [];
  const { rep: _rep, deal: _deal, ...fresh } = data;
  const changed = Object.entries(fresh).some(([k, v]) => review.data[k] !== v);
  const patch = changed && status !== "approved" && status !== "dismissed" ? [{ op: "patch", collection: "reviews", key: d.id, data: fresh, expect }] : [];
  if (status === "reopened") return [...patch, { op: "transition", machine: "review", name: "dealReclosed", key: d.id }, ...autoDraft ? [{ op: "transition", machine: "review", name: "autoDraft", key: d.id }] : []];
  return patch;
}
function stagePart(stage) {
  const hex = [...new TextEncoder().encode(stage)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.length && hex.length <= 100 ? hex : null;
}
var stageOfPart = (part) => new TextDecoder().decode(new Uint8Array((part.match(/../g) ?? []).map((h) => parseInt(h, 16))));
function changeKeys(c) {
  const was = c.before?.isClosed === true, is = c.after?.isClosed === true;
  const before = typeof c.before?.stage === "string" ? c.before.stage : null, after = typeof c.after?.stage === "string" ? c.after.stage : null;
  if (!was && is && before) {
    const part = stagePart(before);
    if (part) return [{ job: "keepStage", key: `${c.id}|${part}` }];
  }
  if (c.after && !is && after && after !== before) {
    const part = stagePart(after);
    if (part) return [{ job: "keepStage", key: `${c.id}|${part}` }, ...was ? [{ job: "intake", key: c.id }] : []];
  }
  return was || is ? [{ job: "intake", key: c.id }] : [];
}
var byField = (docs, field) => new Map(docs.map((d) => [String(d.data[field]), d]));
var SMALL_SAMPLE = 4;
function winRates(groups) {
  const by = /* @__PURE__ */ new Map();
  for (const g of groups) {
    const [group, outcome] = g.keys;
    const k = group === null || group === void 0 ? "" : String(group);
    const row = by.get(k) ?? { group: group === null || group === void 0 ? null : String(group), won: 0, lost: 0, closed: 0, wonAmount: 0, amount: 0, rate: null, dollarRate: null, small: false };
    const n = g.values[0] ?? 0, amt = g.values[1] ?? 0;
    if (outcome === "won") {
      row.won += n;
      row.wonAmount += amt;
    } else if (outcome === "lost") row.lost += n;
    else continue;
    row.closed += n;
    row.amount += amt;
    by.set(k, row);
  }
  return [...by.values()].map((r) => ({ ...r, rate: r.closed ? r.won / r.closed : null, dollarRate: r.amount ? r.wonAmount / r.amount : null, small: r.closed < SMALL_SAMPLE })).sort((a, b) => b.closed - a.closed || String(a.group).localeCompare(String(b.group)));
}
function reasonShares(reviews, outcome) {
  const mine = reviews.filter((r) => r.outcome === outcome);
  const by = /* @__PURE__ */ new Map();
  const at = (reason) => by.get(reason) ?? (by.set(reason, { primary: 0, contributing: 0, amount: 0, strengths: [] }), by.get(reason));
  for (const r of mine) {
    if (r.primaryReason) {
      const x = at(r.primaryReason);
      x.primary++;
      x.amount += r.amount ?? 0;
    }
    for (const d of r.drivers ?? []) {
      const x = at(d.reason);
      if (d.weight !== "primary") x.contributing++;
      x.strengths.push(d.strength === "strong" ? 2 : 1);
    }
  }
  return [...by.entries()].map(([reason, x]) => {
    const avg = x.strengths.length ? x.strengths.reduce((a, b) => a + b, 0) / x.strengths.length : null;
    return { reason, primary: x.primary, contributing: x.contributing, share: mine.length ? x.primary / mine.length : 0, amount: x.amount, avgStrength: avg, influence: (x.primary + x.contributing) * (avg ?? 1) };
  }).sort((a, b) => b.primary - a.primary || b.amount - a.amount || a.reason.localeCompare(b.reason));
}
function sectionFor(category, outcome) {
  if (outcome === "won") return "why_we_win";
  return category === "price" ? "pricing" : category === "product" ? "feature_comparison" : category === "competition" ? "landmines" : "objections";
}
var DIGEST_MIN = 3;
var DIGEST_DAYS = 180;
function cardDigest(a) {
  const since = new Date(a.now - DIGEST_DAYS * DAY).toISOString().slice(0, 10);
  const seen = new Set(a.existing.map((u) => `${u.data.reason}|${u.data.outcome}|${u.data.basis}`));
  const out = [];
  for (const outcome of ["lost", "won"]) {
    const mine = a.published.filter((p) => p.data.outcome === outcome && typeof p.data.closedOn === "string" && p.data.closedOn >= since);
    const byReason = /* @__PURE__ */ new Map();
    for (const p of mine) if (typeof p.data.primaryReason === "string") byReason.set(p.data.primaryReason, [...byReason.get(p.data.primaryReason) ?? [], p]);
    for (const [reason, reviews] of [...byReason.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))) {
      if (reviews.length < DIGEST_MIN) continue;
      const basis = reviews.map((r2) => r2.key).sort().join(",");
      if (seen.has(`${reason}|${outcome}|${basis}`)) continue;
      const r = a.reasons.get(reason);
      const first = reviews.map((x) => String(x.data.closedOn)).sort()[0].slice(0, 7);
      const quotes = reviews.flatMap((x) => {
        const drivers = Array.isArray(x.data.drivers) ? x.data.drivers : [];
        const q = drivers.find((d) => d.reason === reason && d.weight === "primary")?.quotes?.find((q2) => q2.verified);
        return q ? [{ text: q.text, review: x.key, ...q.source?.kind ? { source: `${q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}` } : {} }] : [];
      });
      out.push({
        competitor: a.competitor,
        section: sectionFor(r?.category, outcome),
        reason,
        outcome,
        basis,
        quotes,
        line: `${reviews.length} of ${mine.length} ${outcome === "lost" ? "losses to" : "wins against"} ${a.name} since ${first} cite ${r?.label ?? reason}`
      });
    }
  }
  return out;
}

var QUOTE_MIN_CHARS = 12;
var foldText = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
function quoteFound(quote, text, minLength = QUOTE_MIN_CHARS) {
  if (typeof quote !== "string" || quote.trim().length < minLength) return false;
  return foldText(text).includes(foldText(quote));
}

var LABELS = {
  direction: { negative: "Hurt us", positive: "Helped us" },
  weight: { primary: "Primary", contributing: "Contributing" },
  strength: { strong: "Strong", normal: "Some" },
  by: { ai: "AI", person: "Person" },
  kind: { call: "Call", meeting: "Meeting", note: "Note", email: "Email", survey: "Survey" }
};
var excludedOf = (settings) => settings?.data.excludedDealTypes ?? [];
var crmOf = (settings) => {
  const d = settings?.data ?? {};
  return { lossReasonField: d.lossReasonField, regionField: d.regionField, sourceField: d.sourceField };
};
var autoDraftOf = (settings) => settings?.data.autoDraft !== false;
var companiesOf = (companies) => new Map(companies.map((c) => [String(c.id), c]));
var calls = {
  /** Canon's 15 reasons, while the taxonomy is empty (plan §4). */
  seedTaxonomy(_ctx, reads) {
    if (reads.reasons.length) return { value: { added: 0 } };
    const intents = DEFAULT_REASONS.map((r, i) => ({
      op: "put",
      collection: "reasons",
      key: r.code,
      data: { ...r, order: (i + 1) * 10, active: true },
      expect: [{ collection: "reasons", key: r.code, version: null }]
    }));
    return { intents, value: { added: intents.length } };
  },
  /** Rows dragged into a new order: each reason's order is its place, in tens. */
  reorderReasons(ctx, reads) {
    const byKey = new Map(reads.reasons.map((r) => [r.key, r]));
    const intents = (ctx.args.keys ?? []).flatMap((key, i) => {
      const r = byKey.get(key);
      return r && r.data.order !== (i + 1) * 10 ? [{ op: "patch", collection: "reasons", key, data: { order: (i + 1) * 10 }, expect: [{ collection: "reasons", key, version: r.version }] }] : [];
    });
    return { intents };
  },
  /**
   * The deal feed: a deal that closed, reopened or changed while closed has its review looked at again, and an open
   * deal that moved stage has its stage kept, so a loss says where it was lost.
   */
  onDeals(ctx) {
    const changes = ctx.args.changes ?? [];
    const intents = changes.flatMap((c) => changeKeys(c)).map((k) => ({ op: "dirty", job: k.job, key: k.key }));
    return { intents };
  },
  /** Each deal's stage from its key (engine.ts stagePart), kept; then its review is looked at again, with it to hand. */
  keepStage(ctx, reads) {
    const kept = byField(reads.stages, "deal");
    const byKey = {};
    for (const key of ctx.args.keys ?? []) {
      const [deal, part] = key.split("|");
      const stage = stageOfPart(part), doc = kept.get(deal);
      byKey[key] = [
        ...doc?.data.stage === stage ? [] : [{ op: "put", collection: "stages", key: deal, data: { deal, stage, at: ctx.now }, expect: [{ collection: "stages", key: deal, version: doc ? doc.version : null }] }],
        { op: "dirty", job: "intake", key: deal }
      ];
    }
    return { byKey };
  },
  /** Once, when 0.3.0 starts serving: every review approved before it, published (the `upgrade` job). */
  publishAll(_ctx, reads) {
    return { byKey: { "*": reads.approved.map((r) => ({ op: "dirty", job: "publish", key: r.key })) } };
  },
  /** Each dirty deal's review, opened, updated, reopened or closed again (engine.ts intakeIntents). */
  intake(ctx, reads) {
    const deals = reads.deals;
    const companies = companiesOf(reads.companies);
    const reviews = byField(reads.reviews, "deal");
    const excluded = excludedOf(reads.settings);
    const byKey = {};
    const autoDraft = autoDraftOf(reads.settings);
    const stages = byField(reads.stages, "deal");
    for (const d of deals) {
      const kept = stages.get(d.id);
      byKey[d.id] = intakeIntents(d, d.companyId ? companies.get(d.companyId) : void 0, reviews.get(d.id), excluded, false, autoDraft, kept ? String(kept.data.stage) : null, crmOf(reads.settings));
    }
    for (const key of ctx.args.deal ?? []) byKey[key] ??= [];
    return { byKey };
  },
  /** Reviews for deals that closed before the module was on: the range's closed deals with none yet. */
  backfill(_ctx, reads) {
    const deals = reads.deals.filter((d) => d.isClosed);
    const companies = companiesOf(reads.companies);
    const reviews = byField(reads.reviews, "deal");
    const excluded = excludedOf(reads.settings);
    const crm = crmOf(reads.settings);
    const intents = deals.flatMap((d) => intakeIntents(d, d.companyId ? companies.get(d.companyId) : void 0, reviews.get(d.id), excluded, true, false, null, crm));
    const skipped = deals.length - intents.length - deals.filter((d) => reviews.has(d.id)).length;
    return { intents, value: `Opened ${intents.length} ${intents.length === 1 ? "review" : "reviews"}${skipped ? `; ${skipped} closed ${skipped === 1 ? "deal has" : "deals have"} no owner, no close date or an excluded deal type` : ""}.` };
  },
  /** Each edited review's primary reason, kept beside its reasons so lists, filters and reports read it. */
  derive(ctx, reads) {
    const reviews = byField(reads.reviews, "deal");
    const byKey = {};
    for (const key of ctx.args.deal ?? []) {
      const r = reviews.get(key);
      const primary = (r?.data.drivers ?? []).find((d) => d.weight === "primary")?.reason;
      if (!r || primary === r.data.primaryReason) {
        byKey[key] = [];
        continue;
      }
      const expect = [{ collection: "reviews", key, version: r.version }];
      byKey[key] = [primary ? { op: "patch", collection: "reviews", key, data: { primaryReason: primary }, expect } : { op: "patch", collection: "reviews", key, data: {}, unset: ["primaryReason"], expect }];
    }
    return { byKey };
  },
  /**
   * Each edited review's quotes, checked word for word against the deal's calls, meetings and notes (plan §6
   * `verifyQuotes`, the rule engine/src/evidence.ts holds for every gate): a quote is verified only when the record it
   * names is on this deal and holds it. Canon's own read: every activity on the deal. One deal a run (the job's batch
   * is 1): an activity about two deals comes back named by one, so a batch would miss it for the other.
   */
  verifyQuotes(ctx, reads) {
    const reviews = byField(reads.reviews, "deal");
    const acts = reads.acts;
    const byKey = {};
    for (const key of ctx.args.deal ?? []) {
      const r = reviews.get(key);
      const drivers = r?.data.drivers ?? [];
      const onDeal = new Map(acts.filter((a) => a.dealId === key).map((a) => [a.id, [a.text, a.transcript].filter(Boolean).join("\n")]));
      const checked = drivers.map((d) => ({ ...d, quotes: (d.quotes ?? []).map((q) => ({ ...q, verified: quoteFound(q.text, onDeal.get(q.source.id) ?? "") })) }));
      byKey[key] = r && JSON.stringify(checked) !== JSON.stringify(drivers) ? [{ op: "patch", collection: "reviews", key, data: { drivers: checked }, expect: [{ collection: "reviews", key, version: r.version }] }] : [];
    }
    return { byKey };
  },
  /**
   * Each approved review published (plan §4 `published`): the copy every role reads, its deal by ref so a reader who
   * can't see the deal sees no name. A review reopened is withdrawn; approved again, it is published again.
   */
  publish(ctx, reads) {
    const reviews = byField(reads.reviews, "deal");
    const published = byField(reads.published, "review");
    const categories = new Map(reads.reasons.map((r) => [r.key, r.data.category]));
    const byKey = {};
    for (const key of ctx.args.deal ?? []) {
      const r = reviews.get(key), p = published.get(key);
      const live = p?.data.status === "live";
      if (!r || r.data.status !== "approved") {
        byKey[key] = p && live ? [{ op: "transition", machine: "published", name: "withdraw", key }] : [];
        continue;
      }
      const d = r.data;
      const data = { review: key, rep: d.rep, deal: d.deal, outcome: d.outcome, closedOn: d.closedOn, amount: d.amount, drivers: d.drivers ?? [] };
      for (const f of ["dealType", "segment", "lostAtStage", "region", "source", "competitor", "primaryReason", "summary", "approvedAt"]) if (d[f] !== void 0) data[f] = d[f];
      if (d.primaryReason && categories.get(String(d.primaryReason))) data.primaryCategory = categories.get(String(d.primaryReason));
      byKey[key] = [
        { op: "put", collection: "published", key, data, expect: [{ collection: "published", key, version: p ? p.version : null }] },
        ...p && !live ? [{ op: "transition", machine: "published", name: "republish", key }] : [],
        // A review against a competitor may tip its battlecard: the digest looks again.
        ...typeof d.competitor === "string" ? [{ op: "dirty", job: "cardDigest", key: d.competitor }] : []
      ];
    }
    return { byKey };
  },
  /**
   * The Trends page (plan §6 `winRates`, `reasonShares`, `coverage`): win rate and dollar win rate over every closed
   * deal in the range the caller sees, in all and by competitor, rep, team, segment and quarter; each reason's share of
   * the approved reviews; how many reviews are approved; and where lost deals were lost.
   */
  trends(_ctx, reads) {
    const reasons = new Map(reads.reasons.map((r) => [r.key, String(r.data.label)]));
    const competitors = new Map(reads.competitors.map((c) => [c.key, String(c.data.name)]));
    const members = new Map(reads.members.map((m) => [m.id, m.name ?? m.id]));
    const groups = (name) => reads[name].groups;
    const rows = (name, label) => winRates(groups(name)).map((r) => ({ ...r, label: label(r.group) }));
    const all = winRates(groups("all").map((g) => ({ keys: ["all", g.keys[0]], values: g.values })))[0];
    const status = new Map(groups("status").map((g) => [String(g.keys[0]), g.values[0] ?? 0]));
    const total = [...status.values()].reduce((a, b) => a + b, 0);
    const published = reads.published.map((p) => p.data);
    const days = published.flatMap((p) => typeof p.approvedAt === "number" && p.closedOn ? [Math.max(0, Math.round((p.approvedAt - Date.parse(`${p.closedOn}T00:00:00Z`)) / 864e5))] : []).sort((a, b) => a - b);
    const daysToApprove = days.length ? days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2 : null;
    const influence = ["lost", "won"].flatMap((o) => reasonShares(published, o).map((r) => ({ ...r, outcome: o === "lost" ? "Losses" : "Wins", label: reasons.get(r.reason) ?? r.reason })));
    const shares = (outcome) => reasonShares(published, outcome).filter((r) => r.primary > 0).map((r) => ({ ...r, label: reasons.get(r.reason) ?? r.reason }));
    const stages = /* @__PURE__ */ new Map();
    for (const p of published) if (p.outcome === "lost" && p.lostAtStage) stages.set(p.lostAtStage, (stages.get(p.lostAtStage) ?? 0) + 1);
    const quarter = (g) => {
      const d = g ? new Date(Number.isFinite(Number(g)) ? Number(g) : g) : null;
      return d && !Number.isNaN(d.getTime()) ? `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}` : "No date";
    };
    return { value: {
      winRate: all?.rate ?? null,
      dollarRate: all?.dollarRate ?? null,
      won: all?.won ?? 0,
      closed: all?.closed ?? 0,
      coverage: total ? (status.get("approved") ?? 0) / total : null,
      approved: status.get("approved") ?? 0,
      waiting: (status.get("pending") ?? 0) + (status.get("drafting") ?? 0) + (status.get("draft") ?? 0) + (status.get("submitted") ?? 0),
      byCompetitor: rows("byCompetitor", (g) => g ? competitors.get(g) ?? g : "None named"),
      byRep: rows("byRep", (g) => g ? members.get(g) ?? "A former member" : "No rep"),
      byTeam: rows("byTeam", (g) => g ?? "No team"),
      bySegment: rows("bySegment", (g) => g ?? "Unknown"),
      byQuarter: rows("byQuarter", quarter),
      byRegion: rows("byRegion", (g) => g ?? "No region"),
      bySource: rows("bySource", (g) => g ?? "No lead source"),
      byDealType: rows("byDealType", (g) => g ?? "No deal type"),
      daysToApprove,
      influence,
      lossReasons: shares("lost"),
      winReasons: shares("won"),
      lostAtStage: [...stages.entries()].map(([stage, count]) => ({ stage, count }))
    } };
  },
  /** Every quote of the approved reviews in a range, one row each (plan §8 `quotes.csv`). */
  exportQuotes(_ctx, reads) {
    const reasons = new Map(reads.reasons.map((r) => [r.key, String(r.data.label)]));
    const deals = new Map(reads.deals.map((d) => [d.id, d.name ?? ""]));
    const rows = reads.published.flatMap((p) => (p.data.drivers ?? []).flatMap((d) => (d.quotes ?? []).filter((q) => q.verified).map((q) => ({
      deal: deals.get(String(p.data.deal)) || "A deal you can't see",
      outcome: p.data.outcome === "won" ? "Won" : "Lost",
      reason: reasons.get(d.reason) ?? d.reason,
      direction: d.direction === "positive" ? "Helped us" : "Hurt us",
      text: q.text,
      source: `${q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}`,
      closedOn: p.data.closedOn
    }))));
    return { value: { rows } };
  },
  /** Each competitor's battlecard updates, proposed from the approved reviews against it (engine.ts cardDigest). */
  cardDigest(ctx, reads) {
    const published = reads.published.filter((p) => p.data.status === "live");
    const updates = reads.updates;
    const reasons = new Map(reads.reasons.map((r) => [r.key, { label: String(r.data.label), category: r.data.category }]));
    const names = new Map(reads.competitors.map((c) => [c.key, String(c.data.name)]));
    const byKey = {};
    for (const competitor of ctx.args.competitor ?? []) {
      const proposals = cardDigest({
        competitor,
        name: names.get(competitor) ?? competitor,
        now: ctx.now,
        reasons,
        published: published.filter((p) => p.data.competitor === competitor),
        existing: updates.filter((u) => u.data.competitor === competitor)
      });
      byKey[competitor] = proposals.map((p) => ({ op: "put", collection: "cardUpdates", data: p }));
    }
    return { byKey };
  },
  /** An accepted card update, written into its section of the battlecard (a new section, or added to the one there). */
  applyCardUpdate(ctx, reads) {
    const u = reads.update;
    if (!u || u.data.status !== "proposed") throw new Error("That update has been decided already.");
    const d = u.data;
    const text = [d.line, ...d.quotes.map((q) => `"${q.text}"${q.source ? ` (${q.source})` : ""}`)].join("\n");
    const card = reads.cards.find((c) => c.data.section === d.section);
    if (card && String(card.data.text).length + 2 + text.length > 6e3) throw new Error("This section is full. Edit it down, or move part of it to another section, then accept the update.");
    return { intents: [
      card ? { op: "patch", collection: "cards", key: card.key, data: { text: `${String(card.data.text)}

${text}` }, expect: [{ collection: "cards", key: card.key, version: card.version }] } : { op: "put", collection: "cards", parentKey: d.competitor, data: { section: d.section, text } },
      { op: "transition", machine: "cardUpdate", name: "accept", key: u.key, expect: [{ collection: "cardUpdates", key: u.key, version: u.version }] }
    ] };
  },
  /** The Competitors page: win rate against each over every closed deal the caller sees, losses, the top loss reason, and updates to review. */
  competitorBoard(_ctx, reads) {
    const rates = new Map(winRates(reads.rates.groups).map((r) => [r.group, r]));
    const reasons = new Map(reads.reasons.map((r) => [r.key, String(r.data.label)]));
    const published = reads.published.map((p) => p.data);
    const proposed = reads.updates.map((u) => String(u.data.competitor));
    const rows = reads.competitors.map((c) => {
      const r = rates.get(c.key);
      const top = reasonShares(published.filter((p) => p.competitor === c.key), "lost").find((x) => x.primary > 0);
      return {
        key: c.key,
        name: String(c.data.name),
        won: r?.won ?? 0,
        lost: r?.lost ?? 0,
        closed: r?.closed ?? 0,
        rate: r?.rate ?? null,
        small: r?.small ?? true,
        topLoss: top ? reasons.get(top.reason) ?? top.reason : null,
        proposed: proposed.filter((x) => x === c.key).length
      };
    });
    return { value: { rows } };
  },
  /** One competitor's page: the win rate against them, why we lose to them, and what buyers said, from approved reviews. */
  competitorDetail(ctx, reads) {
    const [r] = winRates(reads.rates.groups);
    const reasons = new Map(reads.reasons.map((x) => [x.key, String(x.data.label)]));
    const published = reads.published.filter((p) => p.data.status === "live");
    const quotes = published.flatMap((p) => (p.data.drivers ?? []).flatMap((d) => (d.quotes ?? []).filter((q) => q.verified).map((q) => ({
      text: q.text,
      reason: reasons.get(d.reason) ?? d.reason,
      outcome: p.data.outcome === "won" ? "Won" : "Lost",
      closedOn: p.data.closedOn,
      review: p.key
    })))).slice(0, 100);
    const lossReasons = reasonShares(published.map((p) => p.data), "lost").filter((x) => x.primary > 0).map((x) => ({ ...x, label: reasons.get(x.reason) ?? x.reason }));
    return { value: { competitor: ctx.args.competitor, won: r?.won ?? 0, closed: r?.closed ?? 0, rate: r?.rate ?? null, dollarRate: r?.dollarRate ?? null, reviews: published.length, lossReasons, quotes } };
  },
  /** A review's reasons as rows: each reason's label, its quotes and how many Canon found word for word. */
  reviewDrivers(_ctx, reads) {
    const review = reads.review;
    const reasons = new Map(reads.reasons.map((r) => [r.key, String(r.data.label)]));
    const drivers = review?.data.drivers ?? [];
    const rows = drivers.map((d) => ({
      reason: reasons.get(d.reason) ?? d.reason,
      direction: LABELS.direction[d.direction] ?? d.direction,
      weight: LABELS.weight[d.weight] ?? d.weight,
      strength: d.strength ? LABELS.strength[d.strength] ?? d.strength : null,
      by: LABELS.by[d.by ?? "person"] ?? d.by,
      note: d.note ?? null,
      quotes: (d.quotes ?? []).map((q) => ({ text: q.text, from: `${LABELS.kind[q.source.kind] ?? q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}${q.verified ? "" : " (not found word for word)"}` })),
      quoteCount: (d.quotes ?? []).length,
      verifiedCount: (d.quotes ?? []).filter((q) => q.verified).length
    }));
    const debrief = review?.data.debrief ?? [];
    return { value: { rows, debrief } };
  }
};
export {
  calls
};
