/**
 * CanonCRM P1: the agent write gate (docs/canoncrm-spec.md).
 *
 * Two plain tables decide what happens to a proposed fact:
 *   - field ownership: which sourceKind may write which attribute. A fact from
 *     a source that does not own the attribute is rejected at ingest (never
 *     stored). Orgs override single (source, attribute) cells; no rule language.
 *   - auto-accept rules: an org may let (source, attribute) facts accept
 *     without a person, above a confidence floor. Off by default. A fact only
 *     qualifies after an independent check (Jev) of its value against its
 *     evidence; an agent's self-reported confidence alone never accepts a fact.
 */
import type { EntityType } from "./attributes.ts";
import type { SourceKind } from "./policy.ts";

/** patchPlans.operation for a batch of proposed facts. */
export const CANON_PROPOSAL_OP = "canon.propose_facts";

/** Sources an agent may submit as. CRM, import and user facts never come through the gate. */
export const AGENT_SOURCES = ["agent_run", "enrichment", "call", "email", "linkedin", "pipeline"] as const satisfies readonly SourceKind[];
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * Fields only a system of record or a person may change by default: deal
 * money/stage/ownership, and the identity and ownership of accounts and
 * contacts. Agents still propose everything else, including `custom.*`.
 */
const PROTECTED: Readonly<Record<EntityType, readonly string[]>> = {
  opportunity: ["name", "amount", "currency", "stage", "forecastCategory", "isClosed", "isWon", "crmOwnerId", "dealType", "probability"],
  account: ["name", "domain", "ownerId"],
  contact: ["ownerId"],
};

/**
 * Default ownership per entity type. Sources not listed (user, CRMs, import)
 * own every attribute. Agent-class sources may not write protected fields.
 */
export function defaultDenied(sourceKind: SourceKind, entityType: EntityType = "opportunity"): readonly string[] {
  return (AGENT_SOURCES as readonly SourceKind[]).includes(sourceKind) ? PROTECTED[entityType] : [];
}

/** An org override of one (source, attribute) cell. No entityType means a deal field. */
export type OwnershipOverride = { sourceKind: SourceKind; attribute: string; allowed: boolean; entityType?: EntityType };

const sameType = (a: EntityType | undefined, b: EntityType) => (a ?? "opportunity") === b;

export function mayWrite(sourceKind: SourceKind, attribute: string, overrides: readonly OwnershipOverride[] = [], entityType: EntityType = "opportunity"): boolean {
  const o = overrides.find((x) => x.sourceKind === sourceKind && x.attribute === attribute && sameType(x.entityType, entityType));
  if (o) return o.allowed;
  return !defaultDenied(sourceKind, entityType).includes(attribute);
}

/** The full ownership grid (defaults with overrides applied), for the settings table. */
export function ownershipGrid(attributes: readonly string[], overrides: readonly OwnershipOverride[] = [], entityType: EntityType = "opportunity") {
  return (["user", "salesforce", "hubspot", "import", ...AGENT_SOURCES] as SourceKind[]).map((sourceKind) => ({
    sourceKind,
    cells: attributes.map((attribute) => ({
      attribute,
      allowed: mayWrite(sourceKind, attribute, overrides, entityType),
      overridden: overrides.some((x) => x.sourceKind === sourceKind && x.attribute === attribute && sameType(x.entityType, entityType)),
    })),
  }));
}

/** No entityType means a deal field. */
export type AutoAcceptRule = { sourceKind: SourceKind; attribute: string; minConfidence: number; enabled: boolean; entityType?: EntityType };

type GatedFact = { sourceKind: SourceKind; attribute: string; evidence?: string; entityType?: EntityType };

/**
 * Whether a proposed fact may be auto-accepted. `verifiedConfidence` is the
 * independent check's score (Jev probability that the evidence supports the
 * value); undefined means unchecked, which never qualifies.
 */
export function autoAcceptDecision(
  fact: GatedFact,
  rules: readonly AutoAcceptRule[],
  verifiedConfidence: number | undefined,
): { accept: true; rule: AutoAcceptRule } | { accept: false; reason: "no_rule" | "no_evidence" | "unverified" | "below_threshold" } {
  const entityType = fact.entityType ?? "opportunity";
  const rule = rules.find((r) => r.enabled && r.sourceKind === fact.sourceKind && r.attribute === fact.attribute && sameType(r.entityType, entityType));
  if (!rule) return { accept: false, reason: "no_rule" };
  if (!fact.evidence?.trim()) return { accept: false, reason: "no_evidence" };
  if (verifiedConfidence === undefined || !Number.isFinite(verifiedConfidence)) return { accept: false, reason: "unverified" };
  if (verifiedConfidence < rule.minConfidence) return { accept: false, reason: "below_threshold" };
  return { accept: true, rule };
}

/** True when a fact is a candidate for verification (a rule exists and it has evidence). */
export function needsVerification(fact: GatedFact, rules: readonly AutoAcceptRule[]) {
  return autoAcceptDecision(fact, rules, 1).accept;
}
