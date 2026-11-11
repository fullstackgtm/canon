/**
 * A person's value holds against a CRM (decided 2026-11-10): a field a person set or cleared in Canon is not
 * overwritten by a later Salesforce or HubSpot write. The CRM's differing value is recorded, and taking it hands the
 * field back to the CRM. Links follow the same rule in lib/objects/associations.ts (EdgeWriter.crm).
 *
 * The rule is decided in lib/objects/write.ts (heldFields, reclaims) and enforced by the two writers every write lands
 * in: `save` for the object ledger and `ingestObservations` (ledger.ts) for a record whose stream is not converted yet.
 * Each records what a CRM says about a held field (settleFieldClaims) when its caller passes a claim store. It is on only for the fields in
 * PERSON_HELD_FIELDS, and custom fields. A company or person is on the ledger once it is worked (a person edits it, a
 * CRM sync writes it, an agent proposes about it); a record-service row nobody worked has no ledger values to hold,
 * and the record service never lets a CRM import change the ledger's columns of a row that is on the ledger.
 *
 * Fields that mean one thing together are one group (FIELD_GROUPS): a person's value for any of them holds them all,
 * the CRM's differing values are recorded once for the group, and taking the CRM's value hands the group back.
 *
 * Pure: no database access.
 */
import { resolveAttribute, sameValue, type FactValue, type SourceKind } from "./policy.ts";
import type { Fact, FoldState } from "../objects/fold.ts";
import { CUSTOM_FIELD_API_NAME, type ResolvedObjectDef } from "../objects/registry.ts";

/** A field's api name from its id: a custom field's id need not be its `custom.<slug>`. */
type Names = Pick<ResolvedObjectDef, "byFieldId">;

/**
 * The fields the rule covers, by object: every deal, company and person field a CRM can write, and custom fields
 * (heldField). The CRM owner (`crmOwnerId`) is the CRM's own id for its owner, not a value a person sets, so it is not
 * held; the Canon owner is `ownerId`. Every other field still follows the newest value.
 */
export const PERSON_HELD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  deal: ["name", "companyId", "ownerId", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "dealType", "nextStep"],
  account: ["name", "domain", "industry", "employees", "annualRevenue", "country", "city", "phone", "description", "linkedinUrl", "ownerId", "status"],
  contact: ["fullName", "title", "email", "additionalEmails", "phone", "additionalPhones", "linkedinUrl", "ownerId", "lifecycleStage", "leadStatus"],
};

/**
 * Held fields that move together, by object and the group's lead field. A deal's stage sets its forecast category,
 * probability, closed and won (lib/pipelines.ts withStageOutcome), in Canon and in both CRMs, so holding one without
 * the others would mix a person's stage with a CRM's outcome. An amount means nothing in another currency. A person's
 * emails are one list edited on one row (the primary, then the others: registry PRIMARY_LISTS), and so are their
 * phones: a CRM's primary held apart from a person's others could name one address twice. A company has no address
 * block (a CRM syncs its country only) and a person's name is one field (a CRM's first and last name are joined).
 */
export const FIELD_GROUPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  deal: { stage: ["stage", "forecastCategory", "probability", "isClosed", "isWon"], amount: ["amount", "currency"] },
  contact: { email: ["email", "additionalEmails"], phone: ["phone", "additionalPhones"] },
};

/** The objects whose fields a person's value holds against a CRM. */
export const HELD_OBJECTS = ["deal", "account", "contact"] as const;
export type HeldObject = (typeof HELD_OBJECTS)[number];

/** A field's group: its lead field, or the field itself when it is in none. */
export function groupOf(object: string, field: string): string {
  for (const [lead, fields] of Object.entries(FIELD_GROUPS[object] ?? {})) if (fields.includes(field)) return lead;
  return field;
}

/** The fields of a group, by its lead field. */
export const groupFields = (object: string, group: string): readonly string[] => FIELD_GROUPS[object]?.[group] ?? [group];

export type CrmProvider = "salesforce" | "hubspot";

/** The CRM a write comes from: an integration writing as its CRM record. "Use the CRM's value" is a person writing it, and is not one. */
export function crmOf(source: { kind: string }, actor: { kind: string }): CrmProvider | null {
  if (actor.kind !== "integration") return null;
  return source.kind === "salesforce" || source.kind === "hubspot" ? source.kind : null;
}

/**
 * The CRM record a `facts` fact says its CRM holds now (`salesforce:<id>:<attribute>`), or null: a person's, Canon's
 * or an agent's fact, or a CRM's dated past value (`…:history:…`), which is not what it holds now.
 */
export function crmRecordOf(f: { sourceKind: string; sourceRef: string; attribute: string }, object: string = "deal"): { provider: CrmProvider; crmId: string } | null {
  if (f.sourceKind !== "salesforce" && f.sourceKind !== "hubspot") return null;
  const suffix = `:${f.attribute}`;
  if (!f.sourceRef.endsWith(suffix)) return null;
  return crmRecordOfRef(f.sourceKind, f.sourceRef.slice(0, -suffix.length), object);
}

/**
 * The CRM record a source ref names: a deal's is `salesforce:<id>`, a company's or person's `salesforce:account:<id>`
 * (lib/canon/partyLedger.ts partySource). Null for a dated past value (`…:history:…`) or another object's record.
 */
export function crmRecordOfRef(provider: CrmProvider, ref: string, object: string = "deal"): { provider: CrmProvider; crmId: string } | null {
  const prefix = object === "deal" ? `${provider}:` : `${provider}:${object}:`;
  if (!ref.startsWith(prefix) || ref.startsWith(`${provider}:history:`)) return null;
  const crmId = ref.slice(prefix.length);
  return crmId ? { provider, crmId } : null;
}

/** Whether a fact is a person's: a member's edit, an API or CLI edit with their token, a merge pick. An automation rule writes as `user` from its own source record and is not one. */
export const isPersonFact = (f: { sourceKind: string; sourceRef: string }) => f.sourceKind === "user" && !f.sourceRef.startsWith("automation:");

/** Whether the rule covers `field` (an id; `def` names it when it may be a custom field's). */
export function heldField(object: string, field: string, def?: Names): boolean {
  const name = def?.byFieldId.get(field as never)?.apiName ?? field;
  return (PERSON_HELD_FIELDS[object]?.includes(name) ?? false) || ((HELD_OBJECTS as readonly string[]).includes(object) && CUSTOM_FIELD_API_NAME.test(name));
}

/**
 * The fields of a CRM's write a person holds: covered by the rule, with a field of their group resolved now to a
 * person's fact. `winner` is the fact a field resolves to.
 */
export function personHeldFields(
  object: string, fields: readonly string[], winner: (field: string) => { sourceKind: string; sourceRef: string } | null, def?: Names,
  /** Groups (by lead field) the writing CRM always wins: an admin's "always follow this CRM" (crmFieldFollows). */
  follows?: (group: string) => boolean,
): string[] {
  const groups = new Map<string, boolean>();
  const heldGroup = (group: string) => {
    if (!groups.has(group)) groups.set(group, groupFields(object, group).some((f) => { const w = winner(f); return w !== null && isPersonFact(w); }));
    return groups.get(group)!;
  };
  return fields.filter((f) => heldField(object, f, def) && !follows?.(groupOf(object, f)) && heldGroup(groupOf(object, f)));
}

/** The fact a field resolves to from its candidates (fold.ts FieldFold), or null when it has none. */
export function winningFact(candidates: readonly Fact[]): Fact | null {
  const r = resolveAttribute(candidates.map((c) => ({
    _id: c.factId, attribute: c.fieldId, value: c.value, sourceKind: c.sourceKind as SourceKind, sourceRef: c.sourceRef,
    evidence: c.evidence, confidence: c.confidence, observedAt: c.observedAt, validFrom: c.validFrom, status: "accepted" as const,
  })));
  return r.factId === null ? null : candidates.find((c) => c.factId === r.factId) ?? null;
}

/**
 * What a CRM says about a field a person holds: one per record, field and CRM record (parentDisagreements,
 * `association: "field"`). For a group, `field` is its lead field and `values` what the CRM says each of the group's
 * fields is (those its write carried); `value` is the lead field's.
 */
export type FieldClaim = {
  id: string; recordId: string; field: string; provider: CrmProvider; ref: string; value: FactValue; values?: Readonly<Record<string, FactValue>>; seenAt: number;
  /** A company's or a person's field; absent for a deal's. */
  object?: "account" | "contact";
};

/** The object a claim's record is. */
export const claimObject = (c: Pick<FieldClaim, "object">): HeldObject => c.object ?? "deal";

/** Whether a person still holds a claim's field or group, and the CRM still says something else about it: the claims the deal page and the admin page show. */
export function standing(state: FoldState, c: Pick<FieldClaim, "field" | "value" | "values">, object = "deal"): boolean {
  const winner = (f: string) => winningFact(state.fields[f]?.candidates ?? []);
  if (!groupFields(object, c.field).some((f) => { const w = winner(f); return w !== null && isPersonFact(w); })) return false;
  return Object.entries(claimValues(c)).some(([f, value]) => !sameValue((winner(f)?.value ?? null) as FactValue, value));
}

/** A claim's values by field: a group's, or its one field's. */
export const claimValues = (c: Pick<FieldClaim, "field" | "value" | "values">): Readonly<Record<string, FactValue>> => c.values ?? { [c.field]: c.value };

export interface FieldClaimStore {
  /** Every claim kept for a record. */
  of(orgId: string, recordId: string): Promise<FieldClaim[]>;
  put(orgId: string, claim: Omit<FieldClaim, "id">, replaces?: string): Promise<void>;
  remove(orgId: string, id: string): Promise<void>;
}

/**
 * Keep the claims in step with a write. A CRM's write of a held field records what it says once per group, updates
 * that when the CRM's values change, and clears it when the CRM agrees on every field of it. A person writing a field
 * again clears every claim on its group. A CRM's dated past value (`…:history:…`) is not what it says now and records
 * nothing.
 */
export async function settleFieldClaims(store: FieldClaimStore, a: {
  orgId: string; recordId: string; object: string; source: { kind: string; ref: string }; actor: { kind: string };
  /** The values the write carried, by field. */
  values: ReadonlyMap<string, unknown>;
  held: readonly string[];
  /** The field's value in Canon now. */
  current: (field: string) => unknown;
  now: number;
  def?: Names;
}): Promise<void> {
  const crm = crmOf(a.source, a.actor);
  if (crm) {
    if (!a.held.length || a.source.ref.includes(":history:")) return;
    const claims = await store.of(a.orgId, a.recordId);
    for (const group of new Set(a.held.map((f) => groupOf(a.object, f)))) {
      const says: Record<string, FactValue> = Object.fromEntries(groupFields(a.object, group).filter((f) => a.values.has(f)).map((f) => [f, (a.values.get(f) ?? null) as FactValue]));
      const kept = claims.find((c) => c.field === group && c.ref === a.source.ref);
      if (Object.entries(says).every(([f, value]) => sameValue(value, (a.current(f) ?? null) as FactValue))) {
        if (kept) await store.remove(a.orgId, kept.id);
      } else if (!kept || !sameValues(claimValues(kept), says)) {
        const grouped = groupFields(a.object, group).length > 1;
        await store.put(a.orgId, {
          recordId: a.recordId, field: group, provider: crm, ref: a.source.ref, value: says[group] ?? null, ...(grouped ? { values: says } : {}), seenAt: a.now,
          ...(a.object === "account" || a.object === "contact" ? { object: a.object } : {}),
        }, kept?.id);
      }
    }
    return;
  }
  if (!isPersonFact({ sourceKind: a.source.kind, sourceRef: a.source.ref })) return;
  const groups = new Set([...a.values.keys()].filter((f) => heldField(a.object, f, a.def)).map((f) => groupOf(a.object, f)));
  if (!groups.size) return;
  for (const c of await store.of(a.orgId, a.recordId)) if (groups.has(c.field)) await store.remove(a.orgId, c.id);
}

const sameValues = (a: Readonly<Record<string, FactValue>>, b: Readonly<Record<string, FactValue>>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => sameValue(a[k] ?? null, b[k] ?? null));
