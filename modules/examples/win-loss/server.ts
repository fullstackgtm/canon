/**
 * Win-loss's server code (docs/modules.md, "Server code"), built into dist/module.js by
 * `node --experimental-strip-types scripts/build-module-examples.ts`. It runs in the recipe runtime: it gets the reads
 * module.json declares, computes (engine.ts), and returns writes Canon checks and applies.
 */
import type { CallFunctions, DealChange, Intent, ReadDoc, ReportReadValue } from "../../kernel/calls.ts";
import { DEFAULT_REASONS, byField, cardDigest, changeKeys, intakeIntents, reasonShares, stageOfPart, winRates, type CrmFields, type Deal, type Group } from "./engine.ts";
import { quoteFound } from "../../../engine/src/evidence.ts";

const LABELS: Record<string, Record<string, string>> = {
  direction: { negative: "Hurt us", positive: "Helped us" },
  weight: { primary: "Primary", contributing: "Contributing" },
  strength: { strong: "Strong", normal: "Some" },
  by: { ai: "AI", person: "Person" },
  kind: { call: "Call", meeting: "Meeting", note: "Note", email: "Email", survey: "Survey" },
};
type Quote = { text: string; source: { kind: string; id: string; at?: string; speaker?: string }; verified: boolean };
type Driver = { reason: string; direction: string; weight: string; strength?: string; by?: string; note?: string; quotes?: Quote[] };

const excludedOf = (settings: ReadDoc | null) => (settings?.data.excludedDealTypes ?? []) as string[];
/** The custom deal fields the settings name for the CRM's loss reason, region and lead source. */
const crmOf = (settings: ReadDoc | null): CrmFields => {
  const d = settings?.data ?? {};
  return { lossReasonField: d.lossReasonField as string | undefined, regionField: d.regionField as string | undefined, sourceField: d.sourceField as string | undefined };
};
/** Auto-draft on close (plan §13.6): on unless the settings turn it off. */
const autoDraftOf = (settings: ReadDoc | null) => settings?.data.autoDraft !== false;
const companiesOf = (companies: Array<Record<string, unknown>>) => new Map(companies.map((c) => [String(c.id), c]));

export const calls: CallFunctions = {
  /** Canon's 15 reasons, while the taxonomy is empty (plan §4). */
  seedTaxonomy(_ctx, reads) {
    if ((reads.reasons as ReadDoc[]).length) return { value: { added: 0 } };
    const intents: Intent[] = DEFAULT_REASONS.map((r, i) => ({
      op: "put", collection: "reasons", key: r.code, data: { ...r, order: (i + 1) * 10, active: true }, expect: [{ collection: "reasons", key: r.code, version: null }],
    }));
    return { intents, value: { added: intents.length } };
  },

  /** Rows dragged into a new order: each reason's order is its place, in tens. */
  reorderReasons(ctx, reads) {
    const byKey = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, r]));
    const intents: Intent[] = ((ctx.args.keys ?? []) as string[]).flatMap((key, i) => {
      const r = byKey.get(key);
      return r && r.data.order !== (i + 1) * 10 ? [{ op: "patch", collection: "reasons", key, data: { order: (i + 1) * 10 }, expect: [{ collection: "reasons", key, version: r.version }] } as Intent] : [];
    });
    return { intents };
  },

  /**
   * The deal feed: a deal that closed, reopened or changed while closed has its review looked at again, and an open
   * deal that moved stage has its stage kept, so a loss says where it was lost.
   */
  onDeals(ctx) {
    const changes = (ctx.args.changes ?? []) as DealChange[];
    const intents: Intent[] = changes.flatMap((c) => changeKeys(c)).map((k) => ({ op: "dirty", job: k.job, key: k.key }));
    return { intents };
  },

  /** Each deal's stage from its key (engine.ts stagePart), kept; then its review is looked at again, with it to hand. */
  keepStage(ctx, reads) {
    const kept = byField(reads.stages as ReadDoc[], "deal");
    const byKey: Record<string, Intent[]> = {};
    for (const key of (ctx.args.keys ?? []) as string[]) {
      const [deal, part] = key.split("|");
      const stage = stageOfPart(part), doc = kept.get(deal);
      byKey[key] = [
        ...(doc?.data.stage === stage ? [] : [{ op: "put", collection: "stages", key: deal, data: { deal, stage, at: ctx.now }, expect: [{ collection: "stages", key: deal, version: doc ? doc.version : null }] } as Intent]),
        { op: "dirty", job: "intake", key: deal },
      ];
    }
    return { byKey };
  },

  /** Once, when 0.3.0 starts serving: every review approved before it, published (the `upgrade` job). */
  publishAll(_ctx, reads) {
    return { byKey: { "*": (reads.approved as ReadDoc[]).map((r) => ({ op: "dirty", job: "publish", key: r.key }) as Intent) } };
  },

  /** Each dirty deal's review, opened, updated, reopened or closed again (engine.ts intakeIntents). */
  intake(ctx, reads) {
    const deals = reads.deals as Deal[];
    const companies = companiesOf(reads.companies as Array<Record<string, unknown>>);
    const reviews = byField(reads.reviews as ReadDoc[], "deal");
    const excluded = excludedOf(reads.settings as ReadDoc | null);
    const byKey: Record<string, Intent[]> = {};
    const autoDraft = autoDraftOf(reads.settings as ReadDoc | null);
    const stages = byField(reads.stages as ReadDoc[], "deal");
    for (const d of deals) {
      const kept = stages.get(d.id);
      byKey[d.id] = intakeIntents(d, d.companyId ? companies.get(d.companyId) : undefined, reviews.get(d.id), excluded, false, autoDraft, kept ? String(kept.data.stage) : null, crmOf(reads.settings as ReadDoc | null));
    }
    // A deal the caller can no longer read (archived, deleted) leaves its review as it is.
    for (const key of (ctx.args.deal ?? []) as string[]) byKey[key] ??= [];
    return { byKey };
  },

  /** Reviews for deals that closed before the module was on: the range's closed deals with none yet. */
  backfill(_ctx, reads) {
    const deals = (reads.deals as Deal[]).filter((d) => d.isClosed);
    const companies = companiesOf(reads.companies as Array<Record<string, unknown>>);
    const reviews = byField(reads.reviews as ReadDoc[], "deal");
    const excluded = excludedOf(reads.settings as ReadDoc | null);
    const crm = crmOf(reads.settings as ReadDoc | null);
    const intents = deals.flatMap((d) => intakeIntents(d, d.companyId ? companies.get(d.companyId) : undefined, reviews.get(d.id), excluded, true, false, null, crm));
    const skipped = deals.length - intents.length - deals.filter((d) => reviews.has(d.id)).length;
    return { intents, value: `Opened ${intents.length} ${intents.length === 1 ? "review" : "reviews"}${skipped ? `; ${skipped} closed ${skipped === 1 ? "deal has" : "deals have"} no owner, no close date or an excluded deal type` : ""}.` };
  },

  /** Each edited review's primary reason, kept beside its reasons so lists, filters and reports read it. */
  derive(ctx, reads) {
    const reviews = byField(reads.reviews as ReadDoc[], "deal");
    const byKey: Record<string, Intent[]> = {};
    for (const key of (ctx.args.deal ?? []) as string[]) {
      const r = reviews.get(key);
      const primary = ((r?.data.drivers ?? []) as Driver[]).find((d) => d.weight === "primary")?.reason;
      if (!r || primary === r.data.primaryReason) { byKey[key] = []; continue; }
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
    const reviews = byField(reads.reviews as ReadDoc[], "deal");
    const acts = reads.acts as Array<{ id: string; dealId?: string | null; text?: string | null; transcript?: string | null }>;
    const byKey: Record<string, Intent[]> = {};
    for (const key of (ctx.args.deal ?? []) as string[]) {
      const r = reviews.get(key);
      const drivers = (r?.data.drivers ?? []) as Driver[];
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
    const reviews = byField(reads.reviews as ReadDoc[], "deal");
    const published = byField(reads.published as ReadDoc[], "review");
    const categories = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, r.data.category]));
    const byKey: Record<string, Intent[]> = {};
    for (const key of (ctx.args.deal ?? []) as string[]) {
      const r = reviews.get(key), p = published.get(key);
      const live = p?.data.status === "live";
      if (!r || r.data.status !== "approved") { byKey[key] = p && live ? [{ op: "transition", machine: "published", name: "withdraw", key }] : []; continue; }
      const d = r.data;
      const data: Record<string, unknown> = { review: key, rep: d.rep, deal: d.deal, outcome: d.outcome, closedOn: d.closedOn, amount: d.amount, drivers: d.drivers ?? [] };
      for (const f of ["dealType", "segment", "lostAtStage", "region", "source", "competitor", "primaryReason", "summary", "approvedAt"]) if (d[f] !== undefined) data[f] = d[f];
      if (d.primaryReason && categories.get(String(d.primaryReason))) data.primaryCategory = categories.get(String(d.primaryReason));
      byKey[key] = [
        { op: "put", collection: "published", key, data, expect: [{ collection: "published", key, version: p ? p.version : null }] },
        ...(p && !live ? [{ op: "transition", machine: "published", name: "republish", key } as Intent] : []),
        // A review against a competitor may tip its battlecard: the digest looks again.
        ...(typeof d.competitor === "string" ? [{ op: "dirty", job: "cardDigest", key: d.competitor } as Intent] : []),
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
    const reasons = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, String(r.data.label)]));
    const competitors = new Map((reads.competitors as ReadDoc[]).map((c) => [c.key, String(c.data.name)]));
    const members = new Map((reads.members as Array<{ id: string; name?: string | null }>).map((m) => [m.id, m.name ?? m.id]));
    const groups = (name: string) => (reads[name] as ReportReadValue).groups as Group[];
    const rows = (name: string, label: (g: string | null) => string) => winRates(groups(name)).map((r) => ({ ...r, label: label(r.group) }));
    const all = winRates(groups("all").map((g) => ({ keys: ["all", g.keys[0]], values: g.values })))[0];
    const status = new Map(groups("status").map((g) => [String(g.keys[0]), g.values[0] ?? 0]));
    const total = [...status.values()].reduce((a, b) => a + b, 0);
    const published = (reads.published as ReadDoc[]).map((p) => p.data as { outcome: string; amount?: number; primaryReason?: string; lostAtStage?: string; closedOn?: string; approvedAt?: number; drivers?: Array<{ reason: string; weight?: string; strength?: string }> });
    // Days from a deal's close to its review's approval, the median over the approved reviews that say when.
    const days = published.flatMap((p) => (typeof p.approvedAt === "number" && p.closedOn ? [Math.max(0, Math.round((p.approvedAt - Date.parse(`${p.closedOn}T00:00:00Z`)) / 86_400_000))] : [])).sort((a, b) => a - b);
    const daysToApprove = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
    const influence = (["lost", "won"] as const).flatMap((o) => reasonShares(published, o).map((r) => ({ ...r, outcome: o === "lost" ? "Losses" : "Wins", label: reasons.get(r.reason) ?? r.reason })));
    const shares = (outcome: "won" | "lost") => reasonShares(published, outcome).filter((r) => r.primary > 0).map((r) => ({ ...r, label: reasons.get(r.reason) ?? r.reason }));
    const stages = new Map<string, number>();
    for (const p of published) if (p.outcome === "lost" && p.lostAtStage) stages.set(p.lostAtStage, (stages.get(p.lostAtStage) ?? 0) + 1);
    const quarter = (g: string | null) => { const d = g ? new Date(Number.isFinite(Number(g)) ? Number(g) : g) : null; return d && !Number.isNaN(d.getTime()) ? `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}` : "No date"; };
    return { value: {
      winRate: all?.rate ?? null, dollarRate: all?.dollarRate ?? null, won: all?.won ?? 0, closed: all?.closed ?? 0,
      coverage: total ? (status.get("approved") ?? 0) / total : null, approved: status.get("approved") ?? 0,
      waiting: (status.get("pending") ?? 0) + (status.get("drafting") ?? 0) + (status.get("draft") ?? 0) + (status.get("submitted") ?? 0),
      byCompetitor: rows("byCompetitor", (g) => (g ? competitors.get(g) ?? g : "None named")),
      byRep: rows("byRep", (g) => (g ? members.get(g) ?? "A former member" : "No rep")), byTeam: rows("byTeam", (g) => g ?? "No team"), bySegment: rows("bySegment", (g) => g ?? "Unknown"),
      byQuarter: rows("byQuarter", quarter),
      byRegion: rows("byRegion", (g) => g ?? "No region"), bySource: rows("bySource", (g) => g ?? "No lead source"), byDealType: rows("byDealType", (g) => g ?? "No deal type"),
      daysToApprove, influence,
      lossReasons: shares("lost"), winReasons: shares("won"),
      lostAtStage: [...stages.entries()].map(([stage, count]) => ({ stage, count })),
    } };
  },

  /** Every quote of the approved reviews in a range, one row each (plan §8 `quotes.csv`). */
  exportQuotes(_ctx, reads) {
    const reasons = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, String(r.data.label)]));
    // A deal's name only for a reader who sees the deal (the read is theirs); the quote stands without it.
    const deals = new Map((reads.deals as Array<{ id: string; name?: string }>).map((d) => [d.id, d.name ?? ""]));
    const rows = (reads.published as ReadDoc[]).flatMap((p) => ((p.data.drivers ?? []) as Driver[]).flatMap((d) => (d.quotes ?? []).filter((q) => q.verified).map((q) => ({
      deal: deals.get(String(p.data.deal)) || "A deal you can't see", outcome: p.data.outcome === "won" ? "Won" : "Lost", reason: reasons.get(d.reason) ?? d.reason, direction: d.direction === "positive" ? "Helped us" : "Hurt us",
      text: q.text, source: `${q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}`, closedOn: p.data.closedOn,
    }))));
    return { value: { rows } };
  },

  /** Each competitor's battlecard updates, proposed from the approved reviews against it (engine.ts cardDigest). */
  cardDigest(ctx, reads) {
    const published = (reads.published as ReadDoc[]).filter((p) => p.data.status === "live");
    const updates = reads.updates as ReadDoc[];
    const reasons = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, { label: String(r.data.label), category: r.data.category as string | undefined }]));
    const names = new Map((reads.competitors as ReadDoc[]).map((c) => [c.key, String(c.data.name)]));
    const byKey: Record<string, Intent[]> = {};
    for (const competitor of (ctx.args.competitor ?? []) as string[]) {
      const proposals = cardDigest({
        competitor, name: names.get(competitor) ?? competitor, now: ctx.now, reasons,
        published: published.filter((p) => p.data.competitor === competitor), existing: updates.filter((u) => u.data.competitor === competitor),
      });
      byKey[competitor] = proposals.map((p) => ({ op: "put", collection: "cardUpdates", data: p }) as Intent);
    }
    return { byKey };
  },

  /** An accepted card update, written into its section of the battlecard (a new section, or added to the one there). */
  applyCardUpdate(ctx, reads) {
    const u = reads.update as ReadDoc | null;
    if (!u || u.data.status !== "proposed") throw new Error("That update has been decided already.");
    const d = u.data as { competitor: string; section: string; line: string; quotes: Array<{ text: string; source?: string }> };
    const text = [d.line, ...d.quotes.map((q) => `"${q.text}"${q.source ? ` (${q.source})` : ""}`)].join("\n");
    const card = (reads.cards as ReadDoc[]).find((c) => c.data.section === d.section);
    // A section holds 6,000 characters: an update that won't fit is refused, never cut short and called accepted.
    if (card && String(card.data.text).length + 2 + text.length > 6000) throw new Error("This section is full. Edit it down, or move part of it to another section, then accept the update.");
    return { intents: [
      card
        ? { op: "patch", collection: "cards", key: card.key, data: { text: `${String(card.data.text)}\n\n${text}` }, expect: [{ collection: "cards", key: card.key, version: card.version }] }
        : { op: "put", collection: "cards", parentKey: d.competitor, data: { section: d.section, text } },
      { op: "transition", machine: "cardUpdate", name: "accept", key: u.key, expect: [{ collection: "cardUpdates", key: u.key, version: u.version }] },
    ] };
  },

  /** The Competitors page: win rate against each over every closed deal the caller sees, losses, the top loss reason, and updates to review. */
  competitorBoard(_ctx, reads) {
    const rates = new Map(winRates((reads.rates as ReportReadValue).groups as Group[]).map((r) => [r.group, r]));
    const reasons = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, String(r.data.label)]));
    const published = (reads.published as ReadDoc[]).map((p) => p.data as { competitor?: string; outcome: string; primaryReason?: string });
    const proposed = (reads.updates as ReadDoc[]).map((u) => String(u.data.competitor));
    const rows = (reads.competitors as ReadDoc[]).map((c) => {
      const r = rates.get(c.key);
      const top = reasonShares(published.filter((p) => p.competitor === c.key), "lost").find((x) => x.primary > 0);
      return { key: c.key, name: String(c.data.name), won: r?.won ?? 0, lost: r?.lost ?? 0, closed: r?.closed ?? 0, rate: r?.rate ?? null, small: r?.small ?? true,
        topLoss: top ? reasons.get(top.reason) ?? top.reason : null, proposed: proposed.filter((x) => x === c.key).length };
    });
    return { value: { rows } };
  },

  /** One competitor's page: the win rate against them, why we lose to them, and what buyers said, from approved reviews. */
  competitorDetail(ctx, reads) {
    const [r] = winRates((reads.rates as ReportReadValue).groups as Group[]);
    const reasons = new Map((reads.reasons as ReadDoc[]).map((x) => [x.key, String(x.data.label)]));
    const published = (reads.published as ReadDoc[]).filter((p) => p.data.status === "live");
    const quotes = published.flatMap((p) => ((p.data.drivers ?? []) as Driver[]).flatMap((d) => (d.quotes ?? []).filter((q) => q.verified).map((q) => ({
      text: q.text, reason: reasons.get(d.reason) ?? d.reason, outcome: p.data.outcome === "won" ? "Won" : "Lost", closedOn: p.data.closedOn, review: p.key,
    })))).slice(0, 100);
    const lossReasons = reasonShares(published.map((p) => p.data as { outcome: string; primaryReason?: string }), "lost").filter((x) => x.primary > 0).map((x) => ({ ...x, label: reasons.get(x.reason) ?? x.reason }));
    return { value: { competitor: ctx.args.competitor, won: r?.won ?? 0, closed: r?.closed ?? 0, rate: r?.rate ?? null, dollarRate: r?.dollarRate ?? null, reviews: published.length, lossReasons, quotes } };
  },

  /** A review's reasons as rows: each reason's label, its quotes and how many Canon found word for word. */
  reviewDrivers(_ctx, reads) {
    const review = reads.review as ReadDoc | null;
    const reasons = new Map((reads.reasons as ReadDoc[]).map((r) => [r.key, String(r.data.label)]));
    const drivers = (review?.data.drivers ?? []) as Driver[];
    const rows = drivers.map((d) => ({
      reason: reasons.get(d.reason) ?? d.reason,
      direction: LABELS.direction[d.direction] ?? d.direction, weight: LABELS.weight[d.weight] ?? d.weight,
      strength: d.strength ? LABELS.strength[d.strength] ?? d.strength : null, by: LABELS.by[d.by ?? "person"] ?? d.by,
      note: d.note ?? null,
      quotes: (d.quotes ?? []).map((q) => ({ text: q.text, from: `${LABELS.kind[q.source.kind] ?? q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}${q.verified ? "" : " (not found word for word)"}` })),
      quoteCount: (d.quotes ?? []).length, verifiedCount: (d.quotes ?? []).filter((q) => q.verified).length,
    }));
    const debrief = (review?.data.debrief ?? []) as Array<{ question: string; answer: string }>;
    return { value: { rows, debrief } };
  },
};
