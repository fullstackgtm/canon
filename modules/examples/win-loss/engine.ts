/**
 * Win-loss's pure computations (docs/module-plans/win-loss.md §6): the default taxonomy, the segment a company falls
 * in, and what a closed (or reopened) deal does to its review. server.ts calls them; tests check them against the
 * plan's goldens. No reads, no clock: everything comes in as arguments.
 */
import type { Intent, ReadDoc } from "../../kernel/calls.ts";

export type Category = "product" | "price" | "sales_experience" | "competition" | "timing" | "relationship" | "security" | "other";
export type Reason = { code: string; label: string; category: Category; applies: "both" | "win" | "loss"; description: string };

/** Canon's default reasons (plan §4): what a review's drivers pick from until an admin edits them. */
export const DEFAULT_REASONS: readonly Reason[] = [
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
  { code: "implementation_risk", label: "Implementation risk", category: "product", applies: "both", description: "The effort and risk of rolling it out." },
];

/** A company's segment by its employees (decision 2026-10-18): under 200 SMB, under 1,000 Mid-market, else Enterprise. */
export function segmentOf(employees: unknown): string | undefined {
  if (typeof employees !== "number" || !Number.isFinite(employees) || employees <= 0) return undefined;
  return employees < 200 ? "SMB" : employees < 1000 ? "Mid-market" : "Enterprise";
}

/** A deal as the review reads it (reads.deals). */
export type Deal = {
  id: string; name?: string; amount?: number | null; closeDate?: string | null; dealType?: string | null; isClosed?: boolean; isWon?: boolean;
  closedAt?: number | null; ownerId?: string | null; companyId?: string | null; createdAt?: number; stage?: string | null;
  /** Its custom fields by slug, on a read that asks for them. */
  custom?: Record<string, unknown>;
};
const DAY = 86_400_000;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** The day a deal closed: its close date, else when it was marked closed. */
export const closedOn = (d: Deal): string | null => (isDay(d.closeDate) ? d.closeDate : typeof d.closedAt === "number" ? new Date(d.closedAt).toISOString().slice(0, 10) : null);

/** The custom deal fields a workspace names for the CRM's loss reason, region and lead source (Setup > Program), by slug. */
export type CrmFields = { lossReasonField?: string; regionField?: string; sourceField?: string };
const crmText = (custom: Record<string, unknown> | undefined, slug: string | undefined, max: number) => {
  const v = slug ? custom?.[slug.replace(/^custom\./, "")] : undefined;
  const t = Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v);
  return t.trim() ? t.trim().slice(0, max) : undefined;
};

/** What a closed deal says of its review, from the deal at close: the fields intake writes. `lastStage`: the last stage it held open. */
export function reviewData(d: Deal, company: { employees?: unknown } | undefined, lastStage?: string | null, crm: CrmFields = {}): Record<string, unknown> | null {
  const day = closedOn(d);
  if (!d.isClosed || !d.ownerId || !day) return null;
  const data: Record<string, unknown> = { deal: d.id, rep: d.ownerId, outcome: d.isWon ? "won" : "lost", closedOn: day, amount: typeof d.amount === "number" ? d.amount : 0 };
  if (d.name) data.dealName = d.name.slice(0, 200);
  if (d.dealType) data.dealType = d.dealType;
  if (!d.isWon && lastStage) data.lostAtStage = lastStage;
  // The CRM's own fields, as the deal holds them at close (win-loss.md M8, read through PW3's custom fields).
  const loss = d.isWon ? undefined : crmText(d.custom, crm.lossReasonField, 200), region = crmText(d.custom, crm.regionField, 120), source = crmText(d.custom, crm.sourceField, 120);
  if (loss) data.crmLossReason = loss;
  if (region) data.region = region;
  if (source) data.source = source;
  const segment = segmentOf(company?.employees);
  if (segment) data.segment = segment;
  if (typeof d.createdAt === "number") data.daysToClose = Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - d.createdAt) / DAY));
  return data;
}

const OPEN = ["pending", "drafting", "draft", "submitted"];
/**
 * What intake writes for one deal (plan §6 `intake`): a closed deal with no review opens one; a deal reopened moves an
 * unfinished review to `reopened` (an approved one keeps its approval, with a line on its history); a deal closed again
 * moves it back to `pending` with what it closed at. An owner change after close leaves the rep the owner at close. A
 * deal type the settings exclude opens nothing. `onlyNew` (a backfill) opens missing reviews and touches no others.
 */
export function intakeIntents(d: Deal, company: { employees?: unknown } | undefined, review: ReadDoc | undefined, excluded: readonly string[], onlyNew = false, autoDraft = false, lastStage?: string | null, crm: CrmFields = {}): Intent[] {
  const expect = [{ collection: "reviews", key: d.id, version: review ? review.version : null }];
  const data = reviewData(d, company, lastStage, crm);
  if (!review) {
    if (!data || (d.dealType && excluded.includes(d.dealType))) return [];
    // Auto-draft (plan §13.6): the new review drafts itself with AI, as the deal's owner, on their own plan.
    return [{ op: "put", collection: "reviews", key: d.id, data, expect }, ...(autoDraft ? [{ op: "transition", machine: "review", name: "autoDraft", key: d.id } as Intent] : [])];
  }
  if (onlyNew) return [];
  const status = String(review.data.status);
  if (!d.isClosed) {
    if (OPEN.includes(status)) return [{ op: "transition", machine: "review", name: "dealReopened", key: d.id, expect }];
    if (status === "approved") return [{ op: "event", collection: "reviews", key: d.id, note: "The deal was reopened. The approved review stands.", expect }];
    return [];
  }
  if (!data) return [];
  // The rep stays who owned the deal when it closed.
  const { rep: _rep, deal: _deal, ...fresh } = data;
  const changed = Object.entries(fresh).some(([k, v]) => review.data[k] !== v);
  const patch: Intent[] = changed && status !== "approved" && status !== "dismissed" ? [{ op: "patch", collection: "reviews", key: d.id, data: fresh, expect }] : [];
  if (status === "reopened") return [...patch, { op: "transition", machine: "review", name: "dealReclosed", key: d.id }, ...(autoDraft ? [{ op: "transition", machine: "review", name: "autoDraft", key: d.id } as Intent] : [])];
  return patch;
}

/**
 * A stage as a job key's part (letters, digits and . _ : @ ~ - only): its UTF-8 bytes in hex, at most 100 characters,
 * so a stage of up to 50 bytes rides on the key. Null for a longer one.
 */
export function stagePart(stage: string): string | null {
  const hex = [...new TextEncoder().encode(stage)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.length && hex.length <= 100 ? hex : null;
}
export const stageOfPart = (part: string) => new TextDecoder().decode(new Uint8Array((part.match(/../g) ?? []).map((h) => parseInt(h, 16))));

/**
 * What a deal change asks of win-loss's jobs (plan §5 watches): the stage an open deal moved to, or the last one it
 * held when it closed (from the change's before, which a later read of the closed deal no longer has), kept by
 * `keepStage`, which then looks at the review; and any other change to a deal that was or is closed, at once.
 */
export function changeKeys(c: { id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }): Array<{ job: string; key: string }> {
  const was = c.before?.isClosed === true, is = c.after?.isClosed === true;
  const before = typeof c.before?.stage === "string" ? c.before.stage : null, after = typeof c.after?.stage === "string" ? c.after.stage : null;
  if (!was && is && before) { const part = stagePart(before); if (part) return [{ job: "keepStage", key: `${c.id}|${part}` }]; }
  if (c.after && !is && after && after !== before) { const part = stagePart(after); if (part) return [{ job: "keepStage", key: `${c.id}|${part}` }, ...(was ? [{ job: "intake", key: c.id }] : [])]; }
  return was || is ? [{ job: "intake", key: c.id }] : [];
}

/** Docs of a read by a field's value (a deal's review by its deal). */
export const byField = (docs: readonly ReadDoc[], field: string) => new Map(docs.map((d) => [String(d.data[field]), d]));

/** A report read's groups: keys are the dimensions' values (the group, then the outcome), values [count, amount]. */
export type Group = { keys: Array<string | number | boolean | null>; values: Array<number | null> };
/** Groups under this many closed deals carry a "small sample" mark, not a hidden number (plan §6). */
export const SMALL_SAMPLE = 4;
export type RateRow = { group: string | null; won: number; lost: number; closed: number; wonAmount: number; amount: number; rate: number | null; dollarRate: number | null; small: boolean };

/** Win rate and dollar win rate per group, from counts and amounts by group and outcome (plan §6 `winRates`). */
export function winRates(groups: readonly Group[]): RateRow[] {
  const by = new Map<string, RateRow>();
  for (const g of groups) {
    const [group, outcome] = g.keys;
    const k = group === null || group === undefined ? "" : String(group);
    const row = by.get(k) ?? { group: group === null || group === undefined ? null : String(group), won: 0, lost: 0, closed: 0, wonAmount: 0, amount: 0, rate: null, dollarRate: null, small: false };
    const n = g.values[0] ?? 0, amt = g.values[1] ?? 0;
    if (outcome === "won") { row.won += n; row.wonAmount += amt; } else if (outcome === "lost") row.lost += n; else continue;
    row.closed += n; row.amount += amt;
    by.set(k, row);
  }
  return [...by.values()].map((r) => ({ ...r, rate: r.closed ? r.won / r.closed : null, dollarRate: r.amount ? r.wonAmount / r.amount : null, small: r.closed < SMALL_SAMPLE }))
    .sort((a, b) => b.closed - a.closed || String(a.group).localeCompare(String(b.group)));
}

type Driver = { reason: string; direction?: string; weight?: string; strength?: string };
type Published = { outcome: string; amount?: number; primaryReason?: string; drivers?: Driver[] };
export type ShareRow = { reason: string; primary: number; contributing: number; share: number; amount: number; avgStrength: number | null; influence: number };
/**
 * Each reason's share of approved reviews of one outcome (plan §6 `reasonShares`), by their primary reason: count,
 * share and amount; and how often it contributed. Strength is Clozd's rating: strong 2, some 1 (decision 2026-10-18);
 * influence = reviews naming it × average strength, so a reason named often and strongly ranks first.
 */
export function reasonShares(reviews: readonly Published[], outcome: "won" | "lost"): ShareRow[] {
  const mine = reviews.filter((r) => r.outcome === outcome);
  const by = new Map<string, { primary: number; contributing: number; amount: number; strengths: number[] }>();
  const at = (reason: string) => by.get(reason) ?? (by.set(reason, { primary: 0, contributing: 0, amount: 0, strengths: [] }), by.get(reason)!);
  for (const r of mine) {
    if (r.primaryReason) { const x = at(r.primaryReason); x.primary++; x.amount += r.amount ?? 0; }
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

/** The battlecard section a reason's category feeds (plan §6 `cardDigest`): price to pricing, product to features, competition to landmines. */
export function sectionFor(category: string | undefined, outcome: "won" | "lost"): string {
  if (outcome === "won") return "why_we_win";
  return category === "price" ? "pricing" : category === "product" ? "feature_comparison" : category === "competition" ? "landmines" : "objections";
}
/** How many approved reviews against a competitor must share a primary reason before a card update is proposed. */
export const DIGEST_MIN = 3;
/** How far back a digest looks, in days. */
export const DIGEST_DAYS = 180;
type Approved = { key: string; data: { outcome?: unknown; closedOn?: unknown; primaryReason?: unknown; drivers?: unknown } };
type Proposal = { competitor: string; section: string; reason: string; outcome: "won" | "lost"; line: string; quotes: Array<{ text: string; review: string; source?: string }>; basis: string };

/**
 * Card updates for one competitor (plan §6 `cardDigest`): when one primary reason runs through at least three approved
 * losses (or wins) against it in the last 180 days, a proposed update to the section its category feeds, carrying the
 * quotes Canon found word for word, with a line a person can keep or edit ("3 of 4 losses to Acme since 2026-07 cite
 * Price"). An update that already rests on the same reviews for the same reason, in any state, isn't proposed again.
 */
export function cardDigest(a: {
  competitor: string; name: string; now: number; published: readonly Approved[]; existing: ReadonlyArray<{ data: { reason?: unknown; outcome?: unknown; basis?: unknown } }>;
  reasons: ReadonlyMap<string, { label: string; category?: string }>;
}): Proposal[] {
  const since = new Date(a.now - DIGEST_DAYS * DAY).toISOString().slice(0, 10);
  const seen = new Set(a.existing.map((u) => `${u.data.reason}|${u.data.outcome}|${u.data.basis}`));
  const out: Proposal[] = [];
  for (const outcome of ["lost", "won"] as const) {
    const mine = a.published.filter((p) => p.data.outcome === outcome && typeof p.data.closedOn === "string" && p.data.closedOn >= since);
    const byReason = new Map<string, Approved[]>();
    for (const p of mine) if (typeof p.data.primaryReason === "string") byReason.set(p.data.primaryReason, [...(byReason.get(p.data.primaryReason) ?? []), p]);
    for (const [reason, reviews] of [...byReason.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))) {
      if (reviews.length < DIGEST_MIN) continue;
      const basis = reviews.map((r) => r.key).sort().join(",");
      if (seen.has(`${reason}|${outcome}|${basis}`)) continue;
      const r = a.reasons.get(reason);
      const first = reviews.map((x) => String(x.data.closedOn)).sort()[0].slice(0, 7);
      const quotes = reviews.flatMap((x) => {
        const drivers = (Array.isArray(x.data.drivers) ? x.data.drivers : []) as Array<{ reason?: string; weight?: string; quotes?: Array<{ text: string; verified?: boolean; source?: { kind?: string; at?: string } }> }>;
        const q = drivers.find((d) => d.reason === reason && d.weight === "primary")?.quotes?.find((q) => q.verified);
        return q ? [{ text: q.text, review: x.key, ...(q.source?.kind ? { source: `${q.source.kind}${q.source.at ? `, ${q.source.at}` : ""}` } : {}) }] : [];
      });
      out.push({
        competitor: a.competitor, section: sectionFor(r?.category, outcome), reason, outcome, basis, quotes,
        line: `${reviews.length} of ${mine.length} ${outcome === "lost" ? "losses to" : "wins against"} ${a.name} since ${first} cite ${r?.label ?? reason}`,
      });
    }
  }
  return out;
}
