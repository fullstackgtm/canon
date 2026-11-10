/**
 * A person's value holds against a CRM (decided 2026-11-10): a field a person set or cleared in Canon is not
 * overwritten by a later Salesforce or HubSpot write. The CRM's differing value is recorded, and taking it hands the
 * field back to the CRM. Links follow the same rule in lib/objects/associations.ts (EdgeWriter.crm).
 *
 * The rule is enforced where every write lands: `save` (lib/objects/write.ts) for the object ledger and
 * `ingestObservations` (ledger.ts) for a deal whose stream is not converted yet. It is on only for the fields in
 * PERSON_HELD_FIELDS.
 *
 * Pure: no database access.
 */
import { resolveAttribute, sameValue, type FactValue, type SourceKind } from "./policy.ts";
import type { Fact } from "../objects/fold.ts";

/** The fields the rule covers, by object. Every other field still follows the newest value. */
export const PERSON_HELD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  deal: ["companyId", "ownerId"],
};

export type CrmProvider = "salesforce" | "hubspot";

/** The CRM a write comes from: an integration writing as its CRM record. "Use the CRM's value" is a person writing it, and is not one. */
export function crmOf(source: { kind: string }, actor: { kind: string }): CrmProvider | null {
  if (actor.kind !== "integration") return null;
  return source.kind === "salesforce" || source.kind === "hubspot" ? source.kind : null;
}

/** Whether a fact is a person's: a member's edit, an API or CLI edit with their token, a merge pick. An automation rule writes as `user` from its own source record and is not one. */
export const isPersonFact = (f: { sourceKind: string; sourceRef: string }) => f.sourceKind === "user" && !f.sourceRef.startsWith("automation:");

export const heldField = (object: string, field: string) => PERSON_HELD_FIELDS[object]?.includes(field) ?? false;

/** The fact a field resolves to from its candidates (fold.ts FieldFold), or null when it has none. */
export function winningFact(candidates: readonly Fact[]): Fact | null {
  const r = resolveAttribute(candidates.map((c) => ({
    _id: c.factId, attribute: c.fieldId, value: c.value, sourceKind: c.sourceKind as SourceKind, sourceRef: c.sourceRef,
    evidence: c.evidence, confidence: c.confidence, observedAt: c.observedAt, validFrom: c.validFrom, status: "accepted" as const,
  })));
  return r.factId === null ? null : candidates.find((c) => c.factId === r.factId) ?? null;
}

/** What a CRM says about a field a person holds: one per record, field and CRM record (parentDisagreements, `association: "field"`). */
export type FieldClaim = { id: string; recordId: string; field: string; provider: CrmProvider; ref: string; value: FactValue; seenAt: number };

export interface FieldClaimStore {
  /** Every claim kept for a record. */
  of(orgId: string, recordId: string): Promise<FieldClaim[]>;
  put(orgId: string, claim: Omit<FieldClaim, "id">, replaces?: string): Promise<void>;
  remove(orgId: string, id: string): Promise<void>;
}

/**
 * Keep the claims in step with a write. A CRM's write of a held field records what it says once, updates that when
 * the CRM's value changes, and clears it when the CRM agrees. A person writing the field again clears every claim on
 * it. A CRM's dated past value (`…:history:…`) is not what it says now and records nothing.
 */
export async function settleFieldClaims(store: FieldClaimStore, a: {
  orgId: string; recordId: string; object: string; source: { kind: string; ref: string }; actor: { kind: string };
  /** The values the write carried, by field. */
  values: ReadonlyMap<string, unknown>;
  held: readonly string[];
  /** The field's value in Canon now. */
  current: (field: string) => unknown;
  now: number;
}): Promise<void> {
  const crm = crmOf(a.source, a.actor);
  if (crm) {
    if (!a.held.length || a.source.ref.includes(":history:")) return;
    const claims = await store.of(a.orgId, a.recordId);
    for (const field of a.held) {
      const value = (a.values.get(field) ?? null) as FactValue;
      const kept = claims.find((c) => c.field === field && c.ref === a.source.ref);
      if (sameValue(value, (a.current(field) ?? null) as FactValue)) {
        if (kept) await store.remove(a.orgId, kept.id);
      } else if (!kept || !sameValue(kept.value, value)) {
        await store.put(a.orgId, { recordId: a.recordId, field, provider: crm, ref: a.source.ref, value, seenAt: a.now }, kept?.id);
      }
    }
    return;
  }
  if (!isPersonFact({ sourceKind: a.source.kind, sourceRef: a.source.ref })) return;
  const fields = [...a.values.keys()].filter((f) => heldField(a.object, f));
  if (!fields.length) return;
  for (const c of await store.of(a.orgId, a.recordId)) if (fields.includes(c.field)) await store.remove(a.orgId, c.id);
}
