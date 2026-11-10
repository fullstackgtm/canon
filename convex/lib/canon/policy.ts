/**
 * CanonCRM fact ledger: the pure core (docs/canoncrm-spec.md).
 *
 * Facts are append-only claims about one attribute of one entity. A resolution
 * policy turns an attribute's accepted facts into its canonical value. This
 * module has no database access so it can be unit-tested and reused by the
 * projection (on write) and by as-of replay (on read).
 *
 * Time model (P0 decision: bitemporal):
 *   observedAt  transaction time: when Canon learned the fact
 *   validFrom   valid time: when it became true in the world (provider's
 *               last-modified timestamp for syncs); falls back to observedAt
 */

import type { SplitAllocation } from "../objects/splits.ts";

export type SourceKind =
  | "user"
  | "salesforce"
  | "hubspot"
  | "import"
  | "call"
  /** A rep's email thread or LinkedIn conversation, read the way a call is (docs/conversation-intake.md). */
  | "email"
  | "linkedin"
  | "enrichment"
  | "pipeline"
  | "agent_run"
  /** A Canon field's decision from its sources (docs/canon-fields-above-the-crm.md). */
  | "canon_field";

export type FactStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type FieldState = "resolved" | "contested" | "empty";
export type ScalarFactValue = string | number | boolean | null;
export type FactValue = ScalarFactValue | readonly SplitAllocation[];
/**
 * A value the policy can compare: a fact value, or a string list from the object layer.
 */
export type ComparableValue = FactValue | readonly string[];

/** The fields of a fact the policy needs (a `facts` row satisfies this). */
export type FactLike<V extends ComparableValue = FactValue> = {
  _id: string;
  attribute: string;
  value: V;
  sourceKind: SourceKind;
  sourceRef: string;
  evidence?: string;
  confidence: number;
  observedAt: number;
  validFrom?: number;
  status: FactStatus;
};

export type Resolution<V extends ComparableValue = FactValue> = {
  value: V | null;
  factId: string | null;
  sourceKind: SourceKind | null;
  state: FieldState;
  /** When contested: the other facts that disagree with the winner. */
  contestedBy?: string[];
};

/**
 * Default precedence (spec: user > system-of-record CRM > call > enrichment >
 * agent_run). A Canon field's decision ranks between a person and the CRMs: it
 * is the org's own rule over those CRMs' values, so it takes the attribute over
 * from them, and a person's newer edit still wins until the field decides again. Backfilled `import` facts carry values that came from the CRM
 * before the ledger existed, so they rank just below live CRM facts. Sources in
 * the same tier are peers: their disagreements can be contested. Email threads
 * and LinkedIn conversations are read the way calls are and rank with them.
 */
export const SOURCE_TIER: Record<SourceKind, number> = {
  user: 100,
  canon_field: 90,
  salesforce: 80,
  hubspot: 80,
  import: 70,
  call: 60,
  email: 60,
  linkedin: 60,
  enrichment: 40,
  pipeline: 30,
  agent_run: 20,
};

/**
 * P0 decision: facts from these sources are accepted on ingest; everything
 * else lands as `proposed` (patch plans approve them in P2).
 */
export const AUTO_ACCEPT: ReadonlySet<SourceKind> = new Set<SourceKind>(["user", "salesforce", "hubspot", "import", "canon_field"]);

export type AttributePolicy = {
  /** Facts below this confidence never win on recency alone. */
  minConfidence: number;
  /** Peer sources that disagree within this window are contested. */
  contestWindowMs: number;
  /** Per-attribute precedence overrides (missing kinds use SOURCE_TIER). */
  tier?: Partial<Record<SourceKind, number>>;
};

export const DEFAULT_POLICY: AttributePolicy = {
  minConfidence: 0.5,
  contestWindowMs: 30 * 24 * 60 * 60 * 1000,
};

const tierOf = (p: AttributePolicy, k: SourceKind) => p.tier?.[k] ?? SOURCE_TIER[k];
/** When the fact became true (valid time), else when Canon learned it. */
export const effectiveTime = (f: Pick<FactLike, "validFrom" | "observedAt">) => f.validFrom ?? f.observedAt;

/**
 * Lists compare in order: a multi-value field's first item is its primary, so
 * a new primary is a change. Multi-picklists are stored sorted, so the same
 * options always compare equal.
 */
export function sameValue(a: ComparableValue, b: ComparableValue): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (isList(a) || isList(b)) {
    if (!isList(a) || !isList(b)) return false;
    return a.length === b.length && a.every((x, i) => {
      const y = b[i];
      return typeof x === "string" ? x === y : typeof y === "object" && y !== null && x.userId === y.userId && x.percentage === y.percentage && x.kind === y.kind;
    });
  }
  return a === b;
}

const isList = (v: ComparableValue): v is readonly string[] | readonly SplitAllocation[] => Array.isArray(v);

export type AsOf = {
  /** Transaction time: only facts Canon had observed by then. */
  knownAt?: number;
  /** Valid time: only facts that were true in the world by then. */
  validAt?: number;
};

/** The facts visible at a point in (bi)time. */
export function visibleAt<T extends Pick<FactLike, "observedAt" | "validFrom">>(facts: readonly T[], asOf?: AsOf): T[] {
  if (!asOf) return [...facts];
  return facts.filter((f) => (asOf.knownAt === undefined || f.observedAt <= asOf.knownAt)
    && (asOf.validAt === undefined || effectiveTime(f) <= asOf.validAt));
}

/**
 * Resolve one attribute from its facts (spec §Resolution policies), using only
 * `accepted` facts:
 *   1. a user fact newer than every other accepted fact wins;
 *   2. else the highest-precedence non-user source wins (its latest fact). A
 *      source's null yields to a lower-ranked value learned after it: the
 *      source had none, so the newer value fills the gap (a found email under
 *      a CRM row with no email). A null newer than every value is a clear;
 *   3. ties within a tier go to the most recent fact above the confidence floor;
 *   4. peer sources (same tier, different source) that disagree within the
 *      contest window are `contested`: value = the winner, flag raised.
 * Recency compares valid time, then transaction time.
 */
export function resolveAttribute<V extends ComparableValue = FactValue>(
  facts: readonly FactLike<V>[],
  policy: AttributePolicy = DEFAULT_POLICY,
  asOf?: AsOf,
): Resolution<V> {
  const accepted = visibleAt(facts, asOf).filter((f) => f.status === "accepted");
  if (!accepted.length) return { value: null, factId: null, sourceKind: null, state: "empty" };
  const newer = (a: FactLike<V>, b: FactLike<V>) => effectiveTime(a) - effectiveTime(b) || a.observedAt - b.observedAt;
  const byRecency = [...accepted].sort((a, b) => newer(b, a));

  // The latest fact per source: an older fact from the same source is superseded by its newer one.
  const latestPerSource = new Map<SourceKind, FactLike<V>>();
  for (const f of byRecency) if (!latestPerSource.has(f.sourceKind)) latestPerSource.set(f.sourceKind, f);
  const candidates = [...latestPerSource.values()];

  let winner: FactLike<V>;
  const newest = byRecency[0];
  if (newest.sourceKind === "user") {
    winner = newest; // rule 1
  } else {
    // A user fact wins only while it is the newest (rule 1). Once another source
    // has a newer fact (e.g. the rep changed the deal in Salesforce afterwards),
    // older user facts no longer block it.
    const others = candidates.filter((f) => f.sourceKind !== "user");
    const ranked = others.filter((f) => f.value !== null || !others.some((g) => g.value !== null && newer(g, f) > 0));
    const topTier = Math.max(...ranked.map((f) => tierOf(policy, f.sourceKind)));
    const peers = ranked.filter((f) => tierOf(policy, f.sourceKind) === topTier);
    const confident = peers.filter((f) => f.confidence >= policy.minConfidence);
    winner = (confident.length ? confident : peers).sort((a, b) => newer(b, a))[0]; // rules 2-3
  }

  const winnerTier = tierOf(policy, winner.sourceKind);
  const contestedBy = candidates
    .filter((f) => f._id !== winner._id
      && f.sourceKind !== winner.sourceKind
      && tierOf(policy, f.sourceKind) === winnerTier
      && !sameValue(f.value, winner.value)
      && Math.abs(effectiveTime(f) - effectiveTime(winner)) <= policy.contestWindowMs)
    .map((f) => f._id);

  return {
    value: winner.value,
    factId: winner._id,
    sourceKind: winner.sourceKind,
    state: winner.value === null ? "empty" : contestedBy.length ? "contested" : "resolved",
    ...(contestedBy.length ? { contestedBy } : {}),
  };
}

/**
 * The write rule (spec §facts): a new observation becomes a new fact only if
 * its value or evidence differs from the latest fact from the same source and
 * source record; otherwise the existing fact is re-confirmed.
 */
export function writeDecision(
  latestFromSource: Pick<FactLike, "_id" | "value" | "evidence"> | null,
  incoming: { value: FactValue; evidence?: string },
): { kind: "write" } | { kind: "confirm"; factId: string } {
  if (latestFromSource && sameValue(latestFromSource.value, incoming.value) && (latestFromSource.evidence ?? "") === (incoming.evidence ?? "")) {
    return { kind: "confirm", factId: latestFromSource._id };
  }
  return { kind: "write" };
}
