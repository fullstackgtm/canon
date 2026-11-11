/**
 * Accounts and contacts on the object-layer ledger (docs/cp0-object-layer.md,
 * migration step 7).
 *
 * An account or contact enters the ledger when it is worked: a person edits
 * it, a CRM sync writes its mirror row, an agent proposes a fact about it, or
 * someone promotes it from the TAM. Its stream is its canonEntities row, found
 * through its domain or email first, so a TAM row and its CRM twin share one
 * stream. Unworked TAM rows stay in the record service.
 *
 * The stream is the authority; its projections are the hot row (recordRows),
 * the `facts` mirror and `canonFieldState`. The CRM mirror rows
 * (crmAccounts, crmContacts) stay each provider's own copy, written by the
 * sync as before, and the record-service row is still written by records.edit.
 *
 * Written against StreamStores so it runs in Convex (convex/canon.ts) and in
 * unit tests. Everything runs in one transaction.
 */
import { ConvexError } from "convex/values";
import { CORE_ATTRIBUTES, CUSTOM_ATTRIBUTE, isKnownAttribute } from "./attributes.ts";
import { mayWrite, type OwnershipOverride } from "./gate.ts";
import { accountExternalIds, contactExternalIds, ID } from "./identity.ts";
import type { Decider } from "./decider.ts";
import { ensureEntity, findEntity, ingestObservations, providerModifiedAt, type ExternalId, type FactActor, type LedgerStore, type StoredFact } from "./ledger.ts";
import { sameValue, type FactValue } from "./policy.ts";
import {
  appendWrite, compareFieldStates, decideInStream, ensureStream, mirrorProposalToStream, refuseTakenAcceptances,
  type FieldStateLike, type FieldStateMismatch, type StreamInit, type StreamStores, type StreamWriteResult,
} from "./streamLedger.ts";
import { project, type EntrySource, type FoldState, type ProjectedRow } from "../objects/fold.ts";
import { coerce, ruleModeFor, type CoerceError, type FieldValue, type ResolvedObjectDef } from "../objects/registry.ts";
import { settleFieldClaims, type CrmProvider, type FieldClaimStore } from "./personHold.ts";
import { checkUnique, checkUpdate, foldStream, save, type SaveResult } from "../objects/write.ts";
import type { EditResponse } from "../recordContract.ts";

export type PartyObject = "account" | "contact";

/** Fact attributes one record may have and still be converted. */
export const PARTY_ATTRIBUTES_MAX = 256;
/**
 * Facts one record's conversion may hold. A converted fact costs at most three
 * writes (its entry, a pending proposal's ledgerFactId patch and its queue
 * row), so 4,000 facts stay within about 12,000 of Convex's 16,000 writes per
 * transaction (convex/canon.ts CONVERSION_FACT_BUDGET).
 */
export const PARTY_CONVERSION_FACTS_MAX = 4_000;

export interface PartyStores extends StreamStores {
  /** The first `limit` attributes, by name, a record has facts for: its canonFieldState rows. */
  factAttributes(entityId: string, limit: number): Promise<string[]>;
  /**
   * The org's definition of `object`, with each `custom.<slug>` key of
   * `values` registered first as a custom field: typed by its research agent,
   * else by its value.
   */
  defWith(orgId: string, object: PartyObject, values: Readonly<Record<string, unknown>>): Promise<ResolvedObjectDef>;
  /** The org's field-ownership overrides (canonFieldOwnership), read once per transaction; every write of a source's values applies them. */
  ownership(orgId: string): Promise<readonly OwnershipOverride[]>;
  /** The field groups (by lead field) the workspace set to always follow a CRM for this object (crmFieldFollows). Absent: none. */
  crmFollows?(orgId: string, provider: CrmProvider, object: PartyObject): Promise<ReadonlySet<string>>;
  /** What CRMs say about the fields a person holds (lib/canon/personHold.ts). Absent: the hold still applies, and nothing is recorded. */
  fieldClaims?: FieldClaimStore;
}

export type PartySource =
  /**
   * A CRM mirror row; `rawData` carries the provider's last-modified stamp. `takenBy`: a person took this CRM record's
   * value over the one a person held (lib/canon/personHold.ts): written as the CRM's, by that person, dated now and
   * reasserted, so the field follows the CRM again.
   */
  | { kind: "salesforce" | "hubspot"; crmId: string; rawData?: unknown; takenBy?: string }
  /**
   * A person's write: a patch of the fields it names. `key` names the
   * operation (a records.edit's idempotency key) and `at` is its time, both
   * the same on every replay. Each operation is its own source record, so a
   * replay of it changes nothing while any other operation lands its fields,
   * whatever order they arrive in; `at` makes the newer edit win per field.
   */
  | { kind: "user"; userId: string; at?: number; key?: string }
  /**
   * A value a provider found when a person asked for it (a work-email lookup):
   * filed as enrichment under the paid call's `providerCalls` id, written and
   * accepted by that person, so it fills an empty field and loses to a CRM's.
   */
  | { kind: "enrichment"; lookup: FoundBy; userId: string; at?: number; key?: string }
  /** A snapshot from another store, such as a record-service row (`record:account:<id>`). */
  | { kind: "import"; ref: string; actorId: string; validFrom?: number }
  /** A Canon field's decision for this record, made at `at` (a preview). */
  | { kind: "canon_field"; fieldId: string; at: number };

/** The provider call that found a value: its provider and its `providerCalls` row. */
export type FoundBy = { provider: string; callId: string };

export type PartyValues = Record<string, FieldValue>;
export type PartySeed = { source: PartySource; values: PartyValues };

export function partySource(object: PartyObject, source: PartySource, streamId: string): { source: EntrySource; actor: FactActor; validFrom?: number; acceptedBy?: Decider } {
  switch (source.kind) {
    case "salesforce":
    case "hubspot": {
      const ref = `${source.kind}:${object}:${source.crmId}`;
      if (source.takenBy) return { source: { kind: source.kind, ref }, actor: { kind: "user", id: source.takenBy } };
      const validFrom = providerModifiedAt(source.rawData);
      return {
        source: { kind: source.kind, ref }, actor: { kind: "integration", id: source.kind },
        ...(validFrom !== undefined ? { validFrom } : {}),
      };
    }
    case "user":
      return {
        source: { kind: "user", ref: `user:${source.userId}:${streamId}${source.key !== undefined ? `:${source.key}` : ""}` }, actor: { kind: "user", id: source.userId },
        ...(source.at !== undefined ? { validFrom: source.at } : {}),
      };
    case "import":
      return {
        source: { kind: "import", ref: source.ref }, actor: { kind: "integration", id: source.actorId },
        ...(source.validFrom !== undefined ? { validFrom: source.validFrom } : {}),
      };
    case "enrichment":
      return {
        source: { kind: "enrichment", ref: `${source.lookup.provider}:${source.lookup.callId}` }, actor: { kind: "user", id: source.userId },
        acceptedBy: { kind: "user", userId: source.userId }, ...(source.at !== undefined ? { validFrom: source.at } : {}),
      };
    case "canon_field":
      return { source: { kind: "canon_field", ref: `canon_field:${source.fieldId}:${streamId}` }, actor: { kind: "integration", id: "canon_field" }, validFrom: source.at };
  }
}

const orNull = <T>(v: T | undefined | null): T | null => (v === undefined || v === "" ? null : v);

/** A crmAccounts row as account values. The mirror stores annual revenue in cents, as deals store amounts. */
export function crmAccountValues(row: { name: string; domain?: string; industry?: string; employeeCount?: number; annualRevenue?: number; ownerId?: string }): PartyValues {
  return {
    name: row.name, domain: orNull(row.domain), industry: orNull(row.industry), employees: orNull(row.employeeCount),
    annualRevenue: orNull(row.annualRevenue), ownerId: orNull(row.ownerId),
  };
}

export function crmContactValues(row: { firstName?: string; lastName?: string; email?: string; phone?: string; title?: string; ownerId?: string }): PartyValues {
  return {
    fullName: orNull([row.firstName, row.lastName].filter(Boolean).join(" ")), email: orNull(row.email), phone: orNull(row.phone),
    title: orNull(row.title), ownerId: orNull(row.ownerId),
  };
}

/** A record-service account row (the TAM tier) as account values. */
export function recordAccountValues(row: { domain: string; name: string; industry?: string; employees?: number; country?: string; linkedinUrl?: string; status?: string; ownerId?: string }): PartyValues {
  return {
    name: row.name, domain: row.domain, industry: orNull(row.industry), employees: orNull(row.employees), country: orNull(row.country),
    linkedinUrl: orNull(row.linkedinUrl), status: orNull(row.status), ownerId: orNull(row.ownerId),
  };
}

export function recordContactValues(row: { fullName: string; title?: string; email?: string; linkedinUrl?: string }): PartyValues {
  return { fullName: row.fullName, title: orNull(row.title), email: orNull(row.email), linkedinUrl: orNull(row.linkedinUrl) };
}

/** The fields of a record-service row a stream starts from. */
export type RecordAccountSnapshot = {
  id: string; domain: string; name: string; updatedAt: number;
  industry?: string; employees?: number; country?: string; linkedinUrl?: string; status?: string; ownerId?: string;
};
export type RecordContactSnapshot = { id: string; fullName: string; updatedAt: number; email?: string; title?: string; linkedinUrl?: string };

/** A record-service row as the snapshot a stream starts from when it is promoted. */
export function recordSeed(object: PartyObject, row: RecordAccountSnapshot | RecordContactSnapshot): PartySeed {
  return {
    source: { kind: "import", ref: `record:${object}:${row.id}`, actorId: "record-service", validFrom: row.updatedAt },
    values: "domain" in row ? recordAccountValues(row) : recordContactValues(row),
  };
}

/** The record-service edit fields that are registry fields (records/edit uses the registry's names); others stay record-service only. */
const EDIT_FIELDS: Readonly<Record<PartyObject, readonly string[]>> = {
  account: ["name", "industry", "employees", "country", "linkedinUrl", "status", "ownerId"],
  // The owner, lifecycle stage and lead status are the ledger's alone: the record service takes them from the projector's write-back.
  contact: ["fullName", "title", "email", "additionalEmails", "linkedinUrl", "phone", "additionalPhones", "ownerId", "lifecycleStage", "leadStatus"],
};

/** A standard field a records.edit writes to the ledger. */
export const isStandardEditField = (object: PartyObject, field: string) => EDIT_FIELDS[object].includes(field);

/** A field a records.edit writes to the ledger: a standard edit field, or a custom field (`custom.<slug>`, CP7a), which only the ledger keeps. */
export const isLedgerEditField = (object: PartyObject, field: string) => isStandardEditField(object, field) || CUSTOM_ATTRIBUTE.test(field);

/** A records.edit patch: field to value, null clearing the field. Lists and booleans are custom fields' (multi-selects, checkboxes, emails). */
export type RecordPatch = Record<string, string | number | boolean | null | string[]>;

/** A records.edit patch as registry values, employees rounded as the record service stores them. */
export function recordEditValues(object: PartyObject, patch: Readonly<RecordPatch>): PartyValues {
  const out: PartyValues = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!isLedgerEditField(object, field)) continue;
    out[field] = field === "employees" && value !== null && Number.isFinite(Number(value)) ? Math.round(Number(value)) : value;
  }
  return out;
}

/**
 * A records.edit patch with its registry fields as the ledger stores them
 * (text trimmed, blank cleared to null, employees whole), given to both the
 * record service and the ledger so the two store the same values. Null is how
 * the record service clears a field. Other fields pass through, and a patch
 * the registry rejects is returned as it is, for the ledger's checks to refuse.
 */
export function normalizeRecordEdit(def: ResolvedObjectDef, object: PartyObject, patch: Readonly<RecordPatch>): RecordPatch {
  const coerced = coerce(def, recordEditValues(object, patch), { mode: "update", rules: "off" });
  if (!coerced.ok) return { ...patch };
  const out: RecordPatch = { ...patch };
  for (const c of coerced.values) out[def.byFieldId.get(c.fieldId)!.apiName] = c.value as RecordPatch[string];
  return out;
}

/**
 * A person's edit of a record-service row (records.edit): the values it
 * writes, the identity its stream is found or created from, and, for a record
 * worked for the first time, the row as it was before the edit to start the
 * stream from. The stream is found from the record's identity before the edit
 * (its record id, its row's domain or email) and never from a value the edit
 * sets: an email the edit sets is linked to that stream once the edit lands,
 * and refused (lib/objects/write.ts) if it already identifies another record.
 */
export function recordEditTarget(
  object: PartyObject,
  recordId: string,
  patch: Readonly<RecordPatch>,
  snapshot?: RecordAccountSnapshot | RecordContactSnapshot,
): { values: PartyValues; identity: { externalIds: ExternalId[]; label?: string }; seed?: PartySeed } {
  const label = snapshot && ("domain" in snapshot ? snapshot.name : snapshot.fullName);
  const externalIds = snapshot && "domain" in snapshot
    ? accountExternalIds({ domain: snapshot.domain, recordId })
    : object === "account"
      ? accountExternalIds({ recordId })
      : contactExternalIds({ email: snapshot?.email, recordId });
  return {
    values: recordEditValues(object, patch),
    identity: { externalIds, ...(label ? { label } : {}) },
    ...(snapshot ? { seed: recordSeed(object, snapshot) } : {}),
  };
}

export type PartyTarget = { orgId: string; object: PartyObject; streamId: string; now: number };

/** The value each `custom.<slug>` attribute was first given in a history, which types its field as a first write would. */
function customFieldValues(facts: readonly StoredFact[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of [...facts].sort((a, b) => a.observedAt - b.observedAt)) {
    if (CUSTOM_ATTRIBUTE.test(f.attribute) && f.value !== null && !(f.attribute in out)) out[f.attribute] = f.value;
  }
  return out;
}

/**
 * Give a record's stream its history (see ensureStream): every attribute it
 * has facts for, with the custom fields they name registered first, or
 * nothing when the history is too large for one transaction. A stream this
 * call started also gets `seed` (the values the record held where it was
 * worked: its TAM row, its CRM row, or its identity), so a record converted
 * from a single agent fact still has a name. A converted history keeps every
 * field it already resolves: the seed fills only the others.
 */
export async function ensurePartyStream(s: PartyStores, t: PartyTarget, seed?: () => Promise<PartySeed | null>): Promise<StreamInit> {
  if ((await s.objects.readEntries(t.streamId, 0, 1)).length) return { status: "existing", factsRead: 0 };
  const attributes = await s.factAttributes(t.streamId, PARTY_ATTRIBUTES_MAX + 1);
  if (attributes.length > PARTY_ATTRIBUTES_MAX) return { status: "deferred", factsRead: 0, oversized: true };
  const init = await ensureStream(s, {
    orgId: t.orgId, streamId: t.streamId, now: t.now, attributes, maxFacts: PARTY_CONVERSION_FACTS_MAX,
    def: (facts) => s.defWith(t.orgId, t.object, customFieldValues(facts)),
  });
  if ((init.status === "converted" || init.status === "created") && seed) {
    const values = await seed();
    if (values) {
      // The seed may be staler than the history (an entity's label, a TAM row), so it fills only fields nothing accepted yet.
      const state = await s.objects.getHotRow(t.streamId);
      const missing = Object.fromEntries(Object.entries(values.values).filter(([field]) => !state?.fields[field]?.candidates.length));
      // A seed with fields left out is not the whole snapshot, so a later sync at the same stamp still lands them.
      const partial = Object.keys(missing).length < Object.keys(values.values).length;
      if (Object.keys(missing).length) await write(s, t, values.source, missing, undefined, await s.ownership(t.orgId), partial);
    }
  }
  return init;
}

/** For a CRM's own write (not a person taking its value): the groups the workspace set to always follow it, or none. */
async function followsOf(s: PartyStores, orgId: string, object: PartyObject, source: PartySource): Promise<((group: string) => boolean) | undefined> {
  if ((source.kind !== "salesforce" && source.kind !== "hubspot") || source.takenBy || !s.crmFollows) return undefined;
  const follows = await s.crmFollows(orgId, source.kind, object);
  return follows.size ? (group) => follows.has(group) : undefined;
}

async function write(s: PartyStores, t: PartyTarget, source: PartySource, values: PartyValues, evidence?: string, ownership?: readonly OwnershipOverride[], partial?: boolean, reassert?: boolean, deferMirror?: boolean) {
  const def = await s.defWith(t.orgId, t.object, values);
  const crmFollows = await followsOf(s, t.orgId, t.object, source);
  const from = partySource(t.object, source, t.streamId);
  const out = await appendWrite(s, {
    orgId: t.orgId, def, streamId: t.streamId, entityType: t.object, values, now: t.now,
    ...from, ...(evidence !== undefined ? { evidence } : {}),
    ...(ownership ? { mayWrite: (apiName: string) => mayWrite(source.kind, apiName, ownership, t.object) } : {}),
    ...(partial ? { partial: true as const } : {}),
    ...(reassert || ("takenBy" in source && source.takenBy) ? { reassert: true as const } : {}),
    ...(deferMirror ? { deferMirror: true as const } : {}),
    ...(crmFollows ? { crmFollows } : {}),
  });
  const { result } = out;
  if (s.fieldClaims && (result.status === "applied" || result.status === "unchanged" || result.status === "proposed")) {
    const held = result.status === "proposed" ? [] : result.held ?? [];
    // Canon's values are read only where a person holds a field: a write nobody holds against costs nothing more.
    const state = held.length ? await s.objects.getHotRow(t.streamId) : null;
    const current = state ? project(def, state).values : {};
    await settleFieldClaims(s.fieldClaims, {
      orgId: t.orgId, recordId: t.streamId, object: t.object, source: from.source, actor: from.actor, values: out.incoming,
      held, now: t.now, current: (field) => current[field] ?? null, def,
    });
  }
  return out;
}

export type PartyWriteResult = Omit<StreamWriteResult, "result" | "incoming"> & {
  /**
   * `deferred`: no stream yet and no conversion budget left in this
   * transaction, or (`oversized`) a history too large to convert; fact-tracked
   * fields were written to `facts` only.
   */
  result: SaveResult | { status: "deferred"; streamId: string; oversized?: true };
};

/**
 * A user edit, CRM sync or snapshot of an account or contact. Appends through
 * the write rule (an unchanged value appends nothing; a provider snapshot no
 * newer than one already seen changes nothing) and mirrors fact-tracked
 * fields into `facts`.
 */
/** FNV-1a over a string, twice with different seeds: a stable 16-hex digest in any runtime (no Node crypto in Convex queries). */
function payloadHash(values: PartyValues): string {
  const text = JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x01000193);
}

export async function writeParty(
  s: PartyStores,
  w: PartyTarget & {
    source: PartySource; values: PartyValues; evidence?: string; seed?: () => Promise<PartySeed | null>;
    /** The org's field ownership, applied to this source's values; absent, the stores' (the org's own). */
    ownership?: readonly OwnershipOverride[];
    /** A CRM snapshot of only some fields (a sync's patch): it never marks the snapshot as seen. */
    partial?: true;
    /** Append the values even where the source already said them, so they win as of the write's time (SaveCommand `reassert`). */
    reassert?: true;
    /** Mirror into `facts` from the stores' queue, after this transaction (StreamWrite `deferMirror`): a CRM sync's bulk writes. */
    deferMirror?: true;
  },
): Promise<PartyWriteResult> {
  // A person's operation is claimed under its key in the transaction that records it, so a replay changes nothing however many edits came between.
  const op = (w.source.kind === "user" || w.source.kind === "enrichment") && w.source.key !== undefined ? { provider: opProvider(w.object), key: w.source.key } : null;
  // A key reused for a different operation is refused by the record service before this runs (editPartyRecord's claim).
  if (op && (await s.objects.findByExternalId(w.orgId, op.provider, op.key)) !== null) {
    const hot = await s.objects.getHotRow(w.streamId);
    return { result: hot ? { status: "unchanged", streamId: w.streamId, version: hot.version } : { status: "deferred", streamId: w.streamId }, resolved: {}, rejected: [] };
  }
  const ownership = w.ownership ?? await s.ownership(w.orgId);
  const init = await ensurePartyStream(s, w, w.seed);
  const out = init.status === "deferred" ? await writePartyFactsOnly(s, { ...w, ownership }, init.oversized) : await write(s, w, w.source, w.values, w.evidence, ownership, w.partial, w.reassert, w.deferMirror);
  // An operation the ledger took only in part stays unclaimed, so its retry lands the rest; the parts it took are unchanged on the retry.
  if (op && !out.rejected.length) await s.objects.addExternalId(w.orgId, w.streamId, op.provider, op.key);
  return { result: out.result, resolved: out.resolved, rejected: out.rejected };
}

/**
 * A record whose history did not fit this transaction's conversion budget:
 * its fact-tracked fields go to `facts` as before the ledger, and converting
 * its stream later reads them. A field `facts` does not track (an account's
 * status) has nowhere to go, so it is reported as rejected: the write is not
 * acknowledged whole and a person's operation stays unclaimed, so its retry,
 * in a transaction with budget to convert, lands it. An oversized history is
 * never converted, so such a field is refused for good.
 */
/** Whether `facts` can hold a field's value: a tracked attribute with a scalar value (a list lives on the ledger only). */
const factTracked = (object: PartyObject, attribute: string, value: unknown) => isKnownAttribute(object, attribute) && !Array.isArray(value);

async function writePartyFactsOnly(
  s: PartyStores, w: PartyTarget & { source: PartySource; values: PartyValues; evidence?: string; ownership: readonly OwnershipOverride[] }, oversized?: true,
): Promise<PartyWriteResult> {
  const { source, actor, validFrom, acceptedBy } = partySource(w.object, w.source, w.streamId);
  const def = await s.defWith(w.orgId, w.object, w.values);
  const parsed = coerce(def, Object.fromEntries(Object.entries(w.values).filter(([k, value]) => factTracked(w.object, k, value))), { mode: "update", rules: ruleModeFor(source.kind), now: w.now });
  const untracked: CoerceError[] = Object.keys(w.values).filter((k) => !factTracked(w.object, k, w.values[k])).map((field) => ({
    field,
    message: oversized
      ? `${field} was not recorded: this record's history is too large to move onto the ledger`
      : `${field} was not recorded yet: this record's history is still being moved onto the ledger`,
  }));
  // A unique value another record holds is refused here as on a stream (lib/objects/write.ts), not accepted into facts.
  const taken = parsed.ok
    ? await checkUnique(s.objects, { orgId: w.orgId, def }, parsed.values.map((c) => ({ fieldId: c.fieldId, value: c.value })), w.streamId)
    : [];
  const observations = parsed.ok
    ? parsed.values
      .filter((c) => !Array.isArray(c.value) && !taken.some((t) => t.field === def.byFieldId.get(c.fieldId)?.apiName))
      .map((c) => ({ attribute: c.fieldId as string, value: c.value as FactValue, ...(validFrom !== undefined ? { validFrom } : {}), ...(w.evidence !== undefined ? { evidence: w.evidence } : {}) }))
    : [];
  const crmFollows = await followsOf(s, w.orgId, w.object, w.source);
  const out = await ingestObservations(s.facts, {
    orgId: w.orgId, entityId: w.streamId, entityType: w.object, sourceKind: source.kind, sourceRefBase: source.ref, actor, observedAt: w.now, observations,
    ownership: w.ownership, ...(acceptedBy ? { acceptedBy } : {}), ...(crmFollows ? { crmFollows } : {}),
  });
  if (s.fieldClaims) {
    await settleFieldClaims(s.fieldClaims, {
      orgId: w.orgId, recordId: w.streamId, object: w.object, source, actor, values: new Map(observations.map((o) => [o.attribute, o.value])), held: out.held,
      now: w.now, current: (field) => out.resolved[field]?.value ?? null, def,
    });
  }
  const denied = out.rejected.map((field) => ({ field, message: `${source.kind} may not write ${field}` }));
  return { result: { status: "deferred", streamId: w.streamId, ...(oversized ? { oversized } : {}) }, resolved: out.resolved, rejected: [...(parsed.ok ? [] : parsed.errors), ...taken, ...denied, ...untracked] };
}

/** What the backfill did with one record. `ignored`: not an account or contact, or a record already visited; not counted. */
export type BackfillOutcome = "applied" | "unchanged" | "converted" | "skipped" | "oversized" | "deferred" | "ignored";
export type BackfillTotals = { records: number; applied: number; unchanged: number; converted: number; skipped: number };

/**
 * One page of the CP2a backfill (convex/canon.ts backfillAccountContactLedger).
 * Visits the page's items after `after` (the key of the last item an earlier
 * run of this page visited) in order while conversion budget is left. A
 * `deferred` record, or no budget left, stops the page: the caller reruns it
 * from the same cursor after `resumeAfter`. A fresh transaction's budget
 * converts any history that is not oversized, so each run moves past at least
 * one item, and an oversized one, counted as skipped, is visited once.
 */
export async function backfillPage<T>(
  page: readonly T[],
  o: { key: (item: T) => string; after?: string; hasBudget: () => boolean; visit: (item: T) => Promise<BackfillOutcome> },
): Promise<{ counted: BackfillTotals; stopped: boolean; resumeAfter?: string }> {
  const counted: BackfillTotals = { records: 0, applied: 0, unchanged: 0, converted: 0, skipped: 0 };
  // An item missing from the page (deleted since) restarts it; every visit is idempotent.
  const start = o.after === undefined ? 0 : page.findIndex((item) => o.key(item) === o.after) + 1;
  let resumeAfter = o.after;
  for (const item of page.slice(start)) {
    const stop = { counted, stopped: true, ...(resumeAfter !== undefined ? { resumeAfter } : {}) };
    if (!o.hasBudget()) return stop;
    const outcome = await o.visit(item);
    if (outcome === "deferred") return stop;
    resumeAfter = o.key(item);
    if (outcome === "ignored") continue;
    counted.records++;
    counted[outcome === "oversized" ? "skipped" : outcome]++;
  }
  return { counted, stopped: false };
}

/** Mirror an agent proposal about an account or contact into its stream (see mirrorProposalToStream). */
export async function mirrorPartyProposal(
  s: PartyStores,
  t: Omit<PartyTarget, "streamId" | "now"> & { fact: StoredFact; ownership?: readonly OwnershipOverride[] },
  seed?: () => Promise<PartySeed | null>,
): Promise<SaveResult | StreamInit> {
  const init = await ensurePartyStream(s, { orgId: t.orgId, object: t.object, streamId: t.fact.entityId, now: t.fact.observedAt }, seed);
  const def = await s.defWith(t.orgId, t.object, { [t.fact.attribute]: t.fact.value });
  return mirrorProposalToStream(s, { orgId: t.orgId, def, entityType: t.object, fact: t.fact, ownership: t.ownership }, init);
}

/** Apply the `facts` gate's decisions to an account's or contact's stream (see decideInStream). */
export async function mirrorPartyDecisions(
  s: PartyStores,
  t: PartyTarget & { decided: readonly StoredFact[]; decider: Decider },
  seed?: () => Promise<PartySeed | null>,
): Promise<StreamInit> {
  // Unique fields are standard ones, so the stored definition knows them; custom fields the decisions name are registered after conversion, as before.
  await refuseTakenAcceptances(s, { orgId: t.orgId, def: await s.defWith(t.orgId, t.object, {}), streamId: t.streamId, decided: t.decided });
  const init = await ensurePartyStream(s, t, seed);
  const def = await s.defWith(t.orgId, t.object, Object.fromEntries(t.decided.map((f) => [f.attribute, f.value])));
  await decideInStream(s, { orgId: t.orgId, def, streamId: t.streamId, decided: t.decided, decider: t.decider, at: t.now }, init);
  return init;
}

/** The lookups checkPartyEdit reads: identity, unique and operation claims all live in canonExternalIds. */
export type PartyLookup = Pick<LedgerStore, "findEntityByExternalId" | "findEntityByProjection"> & {
  /** A record's name, so a refusal says who holds the value (lib/objects/write.ts labelOf). */
  labelOf?(entityId: string): Promise<string | null>;
};

/** The canonExternalIds provider an account's or contact's operation (a records.edit idempotency key) is claimed under. */
export const opProvider = (object: PartyObject) => `op:${object}`;

/**
 * Would the ledger take this records.edit whole? Normalizes the patch
 * (normalizeRecordEdit), resolves the record's stream as saveRecordEdit does
 * (none yet for a record worked for the first time) and runs the save's own
 * checks on its values: coercion, the user's field ownership and unique
 * values another record holds (its claim, or the identity a contact's email
 * names: lib/objects/write.ts). An operation the ledger already recorded is a replay and passes.
 * Returns the normalized patch and the fields the ledger would leave out.
 */
export async function checkPartyEdit(
  lookup: PartyLookup,
  a: {
    orgId: string; object: PartyObject; def: ResolvedObjectDef; recordId: string;
    patch: Readonly<RecordPatch>; snapshot?: RecordAccountSnapshot | RecordContactSnapshot;
    key?: string; ownership?: readonly OwnershipOverride[];
    /** The stream the register links the record's row to, when it has one. */
    streamId?: string;
  },
): Promise<{ patch: RecordPatch; refused: CoerceError[] }> {
  const patch = normalizeRecordEdit(a.def, a.object, a.patch);
  if (a.key !== undefined && (await lookup.findEntityByExternalId(a.orgId, opProvider(a.object), a.key)) !== null) return { patch, refused: [] };
  const edit = recordEditTarget(a.object, a.recordId, patch, a.snapshot);
  const streamId = a.streamId ?? await findEntity(lookup, { orgId: a.orgId, projectionId: a.recordId, externalIds: edit.identity.externalIds });
  const refused = await checkUpdate({ findByExternalId: (orgId, provider, id) => lookup.findEntityByExternalId(orgId, provider, id), ...(lookup.labelOf ? { labelOf: lookup.labelOf } : {}) }, {
    orgId: a.orgId, def: a.def, source: { kind: "user", ref: "check" }, mayWrite: (apiName) => mayWrite("user", apiName, a.ownership, a.object),
  }, edit.values, streamId);
  return { patch, refused };
}

/**
 * A person's edit of a record-service account or contact, appended to its
 * stream (convex/canon.ts saveRecordEdit). The stream is found or created from
 * the record's identity; a record worked for the first time starts from
 * `snapshot`, the row before the edit, else from `identitySeed`. The edit is
 * one operation named by `key`, and `at`, the record service's time for it,
 * orders it against other edits of the same field.
 */
export async function writeRecordEdit(
  s: PartyStores,
  a: {
    orgId: string; object: PartyObject; recordId: string; patch: Readonly<RecordPatch>;
    userId: string; key: string; at?: number; found?: FoundBy; snapshot?: RecordAccountSnapshot | RecordContactSnapshot;
    ownership?: readonly OwnershipOverride[]; now: number; identitySeed?: (streamId: string) => Promise<PartySeed | null>;
    /**
     * The stream the register links the row to (one register): the record's id becomes its identity, so the
     * edit lands there even for a record nothing else identifies (a CRM-only contact with no email).
     */
    streamId?: string;
    /** Values the record must still hold, checked in this transaction; else nothing is written and it is a conflict. */
    expect?: Readonly<Record<string, string | null>>;
    /** Why the person made the edit, kept on each value it writes (an approved research fix's quotes and sources). */
    evidence?: string;
  },
): Promise<PartyWriteResult & { entityId: string }> {
  if (a.streamId) {
    const provider = a.object === "account" ? ID.recordAccount : ID.recordContact;
    if ((await s.objects.findByExternalId(a.orgId, provider, a.recordId)) === null) await s.objects.addExternalId(a.orgId, a.streamId, provider, a.recordId);
  }
  const edit = recordEditTarget(a.object, a.recordId, a.patch, a.snapshot);
  const entityId = await ensureEntity(s.facts, {
    orgId: a.orgId, entityType: a.object, projectionTable: a.object === "account" ? "recordAccounts" : "recordContacts", projectionId: a.recordId,
    externalIds: edit.identity.externalIds, ...(edit.identity.label ? { label: edit.identity.label } : {}),
  });
  if (a.expect && !(await holds(s, a.orgId, a.object, entityId, a.expect, a.snapshot))) {
    return { result: { status: "conflict", streamId: entityId, version: 0, expectedVersion: 0 }, resolved: {}, rejected: [], entityId };
  }
  // An email the edit sets that names another record (a race past checkPartyEdit) is left out by the save, and the rest still lands.
  const out = await writeParty(s, {
    orgId: a.orgId, object: a.object, streamId: entityId, now: a.now, values: edit.values, ...(a.evidence !== undefined ? { evidence: a.evidence } : {}),
    source: { ...(a.found ? { kind: "enrichment" as const, lookup: a.found } : { kind: "user" as const }), userId: a.userId, key: a.key, ...(a.at !== undefined ? { at: a.at } : {}) },
    ...(a.ownership ? { ownership: a.ownership } : {}),
    seed: async () => edit.seed ?? (a.identitySeed ? a.identitySeed(entityId) : null),
  });
  // An edited email or domain becomes this stream's identity through its unique claim (syncUniqueClaims in
  // lib/objects/write.ts), from the value the record resolves to, so a replayed older edit never restores one.
  return { ...out, entityId };
}

/**
 * Whether a stream still holds `expect` (field to value, null for none), read in the transaction that writes it: its
 * projection when it has entries, else the row it starts from (`snapshot`). A module's approved proposal is written
 * only while the record holds what the proposal read (CAS, docs/modules.md "Writes to Canon records").
 */
async function holds(s: PartyStores, orgId: string, object: PartyObject, streamId: string, expect: Readonly<Record<string, string | null>>, snapshot?: RecordAccountSnapshot | RecordContactSnapshot): Promise<boolean> {
  const state = (await s.objects.readEntries(streamId, 0, 1)).length ? ((await s.objects.getHotRow(streamId)) ?? (await foldStream(s.objects, streamId))) : null;
  const values: Record<string, unknown> = state ? project(await s.defWith(orgId, object, {}), state).values : { ...(snapshot ?? {}) };
  return Object.entries(expect).every(([field, value]) => (values[field] ?? null) === value);
}

/** Whether a register row's stream holds `values` now (field to value, null for none): false for a row with no stream. */
export async function recordHolds(s: PartyStores, a: { orgId: string; object: PartyObject; recordId: string; values: Readonly<Record<string, string | null>> }): Promise<boolean> {
  const streamId = await s.objects.findByExternalId(a.orgId, a.object === "account" ? ID.recordAccount : ID.recordContact, a.recordId);
  return streamId !== null && (await holds(s, a.orgId, a.object, streamId, a.values));
}

/** A register row as a write about it names it: its record id, the row as it is now, and the stream it is linked to, if any. */
export type RegisterRecordRef = {
  orgId: string; object: PartyObject; recordId: string; now: number;
  snapshot?: RecordAccountSnapshot | RecordContactSnapshot; streamId?: string; identitySeed?: (streamId: string) => Promise<PartySeed | null>;
};

/**
 * A register row's stream, found or created: a row nobody has worked is promoted onto the ledger, its stream
 * starting from `snapshot` as an import from the row, as a first edit promotes it (writeRecordEdit).
 */
export async function promoteRecord(s: PartyStores, a: RegisterRecordRef): Promise<{ entityId: string; init: StreamInit }> {
  if (a.streamId) {
    const provider = a.object === "account" ? ID.recordAccount : ID.recordContact;
    if ((await s.objects.findByExternalId(a.orgId, provider, a.recordId)) === null) await s.objects.addExternalId(a.orgId, a.streamId, provider, a.recordId);
  }
  const target = recordEditTarget(a.object, a.recordId, {}, a.snapshot);
  const entityId = await ensureEntity(s.facts, {
    orgId: a.orgId, entityType: a.object, projectionTable: a.object === "account" ? "recordAccounts" : "recordContacts", projectionId: a.recordId,
    externalIds: target.identity.externalIds, ...(target.identity.label ? { label: target.identity.label } : {}),
  });
  const init = await ensurePartyStream(s, { orgId: a.orgId, object: a.object, streamId: entityId, now: a.now },
    async () => target.seed ?? (a.identitySeed ? a.identitySeed(entityId) : null));
  return { entityId, init };
}

/**
 * Delete or restore a register row (convex/records.ts bulkRegister). The row's
 * stream takes a `lifecycle` entry, which the projector writes back as the
 * row's `deletedAt`: the register list drops the row and the recycle bin lists
 * it. A row nobody has worked has no stream yet, so it is promoted first, as a
 * first edit promotes it (writeRecordEdit), starting from `snapshot`: its
 * stream then reads import from the row, delete, restore. `unchanged` when the
 * row is already in that state.
 */
export async function writeRecordLifecycle(
  s: PartyStores,
  a: {
    orgId: string; object: PartyObject; recordId: string; op: "delete" | "restore"; userId: string; now: number;
    snapshot?: RecordAccountSnapshot | RecordContactSnapshot; streamId?: string; identitySeed?: (streamId: string) => Promise<PartySeed | null>;
  },
): Promise<{ result: SaveResult | { status: "deferred"; streamId: string }; entityId: string }> {
  const { entityId, init } = await promoteRecord(s, a);
  // A history too large to convert in this transaction cannot take an entry: the row is left as it was.
  if (init.status === "deferred") return { result: { status: "deferred", streamId: entityId }, entityId };
  const result = await save(s.objects, {
    orgId: a.orgId, def: await s.defWith(a.orgId, a.object, {}), source: { kind: "user", ref: `user:${a.userId}` },
    actor: { kind: "user", id: a.userId }, now: a.now,
  }, { op: a.op, streamId: entityId });
  return { result, entityId };
}

/**
 * How records.edit writes an account or contact (convex/records.ts). The
 * record-service row is the register's copy (docs/cp0-object-layer.md, "One
 * register"): fields the ledger tracks go only to the ledger, and the projector
 * writes them back to the row; the few fields only the service keeps (a
 * contact's emailStatus and triage status) go to the service.
 */
export interface RecordEditPorts {
  object: PartyObject;
  /**
   * Whether the record service keeps the register (contract 1.8.0): its
   * projector writes the ledger's fields back to the row. Without it (an older
   * service mid-deploy, or the fake), the row is also sent the ledger's fields.
   */
  register: boolean;
  /** The edit holds only while the record has the values it expects (`expect`): without the register, the ledger's check runs before the row is written. */
  conditional?: boolean;
  /** checkPartyEdit for this edit, read before anything is written: the normalized patch, and what the ledger would refuse. */
  check(): Promise<{ patch: RecordPatch; refused: readonly CoerceError[] }>;
  /**
   * saveRecordEdit of the ledger's fields: the ones it left out, and the stream's version after the write.
   * `deferred`: the record's history did not fit this transaction to convert, so the edit went to `facts`
   * only and no entry reaches the projector.
   */
  ledger(patch: RecordPatch, at?: number): Promise<{ rejected: readonly CoerceError[]; version?: number; deferred?: boolean; conflict?: boolean }>;
  /** Wait until the projector has written the ledger's values back to the row, so the next read of the row shows the edit. */
  settle(): Promise<void>;
  /**
   * The record-service edit, under the operation's idempotency key (or `keySuffix` added to it). `payload`
   * claims the key for the whole operation when the patch is only part of it, so a missing record is a 404 and
   * a key reused for a different operation is refused before the ledger is written.
   */
  service(patch: RecordPatch, opts?: { payload?: string; keySuffix?: string }): Promise<EditResponse>;
}

const refusal = (errors: readonly CoerceError[]) => errors.map((e) => e.message).join("; ");

/** An edit made on a condition (`expect`) the record no longer meets when the ledger writes: nothing was written. */
export class EditConflictError extends Error {
  constructor() { super("Changed since it was read; nothing was written"); this.name = "EditConflictError"; }
}

/** A patch split into what the ledger tracks and what only the record service keeps. */
export function splitRecordPatch(object: PartyObject, patch: Readonly<RecordPatch>): { ledger: RecordPatch; service: RecordPatch } {
  const ledger: RecordPatch = {};
  const service: RecordPatch = {};
  for (const [field, value] of Object.entries(patch)) (isLedgerEditField(object, field) ? ledger : service)[field] = value;
  return { ledger, service };
}

/**
 * Write an edit: refused whole if the ledger would leave out any field,
 * before anything is written. The ledger's fields go to the ledger, and the
 * edit returns once the projector has written them back to the row; the
 * service-only fields go to the record service. A field the ledger still
 * refuses (a claim that landed after the check) fails the edit with its
 * operation unclaimed (writeParty), so a retry of the same key, once the
 * conflict is resolved, lands what is missing.
 */
export async function editPartyRecord(ports: RecordEditPorts): Promise<EditResponse> {
  const { patch, refused } = await ports.check();
  if (refused.length) throw new ConvexError(refusal(refused));
  const split = splitRecordPatch(ports.object, patch);
  const ledgerFields = Object.keys(split.ledger).length > 0;
  if (!ports.register && ports.conditional) {
    // Without the register the row would take the patch before the ledger checks the condition: check it first.
    const { rejected, conflict } = await ports.ledger(split.ledger);
    if (conflict) throw new EditConflictError();
    if (rejected.length) throw new ConvexError(`Not saved: ${refusal(rejected)}. Resolve that and retry the edit.`);
    return ports.service(patch);
  }
  // The record service claims the key for the whole operation first, as before the register: it 404s a missing
  // record and refuses a key reused for a different edit before the ledger is written. It takes only the fields
  // it keeps; without the register (an older service, the fake) it takes the whole patch, as it always did.
  let response = ports.register
    ? await ports.service(split.service, ledgerFields ? { payload: operationDigest(patch) } : {})
    : await ports.service(patch);
  if (!ledgerFields) return response;
  // Without the register the row took the whole patch first: the service's commit time orders the ledger's
  // copy of it, so concurrent edits resolve in the order the row applied them.
  const { rejected, version, deferred, conflict } = await ports.ledger(split.ledger, ports.register ? undefined : response.at);
  if (conflict) throw new EditConflictError();
  if (rejected.length) throw new ConvexError(`Not saved: ${refusal(rejected)}. Resolve that and retry the edit.`);
  if (ports.register) {
    // A deferred edit has no entry for the projector to write back: the row, still unlinked, takes it directly.
    if (deferred) response = await ports.service(split.ledger, { keySuffix: ":deferred" });
    else {
      await ports.settle();
      response = { ...response, version: version ?? response.version };
    }
  }
  return response;
}

/** A stable digest of an operation's whole normalized patch (FNV-1a, any runtime). */
export function operationDigest(patch: Readonly<RecordPatch>): string {
  return payloadHash(patch as PartyValues);
}

/** A work-email lookup's answer (convex/records.ts findEmail) as a records.edit of the contact, found by `call`. */
export function foundEmailEdit<C extends FoundBy>(contactId: string, day: string, email: string | null, call: C): {
  patch: Record<string, string | number | null>; idempotencyKey: string; found: C;
} {
  return {
    patch: email ? { email, emailStatus: "found" } : { emailStatus: "not_found" },
    // The outcome is part of the key: a later lookup the same day that finds an email is a different edit, not a replay.
    idempotencyKey: `find-email:${contactId}:${day}:${email ?? "not_found"}`,
    found: call,
  };
}

/**
 * Write a work-email lookup's answer back to the contact (see foundEmailEdit):
 * a found email goes to the contact's stream as enrichment the person who ran
 * the lookup accepted, so an email another contact holds is refused before
 * anything is written; the lookup's status is the record service's own. A
 * miss sets only that status.
 */
export async function writeFoundEmail(ports: RecordEditPorts, patch: Readonly<RecordPatch>): Promise<EditResponse> {
  return Object.keys(recordEditValues("contact", patch)).length ? editPartyRecord(ports) : ports.service({ ...patch });
}

export type PartyMismatch =
  | (FieldStateMismatch & { against: "fieldState" })
  /** The CRM row holds a value its own source record never asserted in the stream: the ledger missed a sync. */
  | { attribute: string; against: "crmRow"; ledger: FieldValue; other: FieldValue };

/**
 * The CP2a proof for one record: its projection against `canonFieldState`
 * for the fields the `facts` ledger tracks and, given a CRM mirror row, that
 * row against the latest values its own source record asserted. `overridden`
 * lists the fields where another source (a person, a peer CRM, an accepted
 * agent fact) wins over the CRM row; that is expected, not a mismatch.
 */
export function compareParty(
  def: ResolvedObjectDef,
  object: PartyObject,
  state: FoldState,
  projected: ProjectedRow,
  fieldStates: ReadonlyMap<string, FieldStateLike>,
  crm?: { sourceRef: string; values: PartyValues },
): { mismatches: PartyMismatch[]; overridden: string[] } {
  // A custom field missing from the definition still counts: its values would never reach the projection.
  const tracked = [...new Set([...CORE_ATTRIBUTES[object], ...fieldStates.keys(), ...Object.keys(projected.values)])]
    .filter((a) => isKnownAttribute(object, a));
  const mismatches: PartyMismatch[] = compareFieldStates(projected, fieldStates, tracked).map((m) => ({ ...m, against: "fieldState" as const }));
  const overridden: string[] = [];
  if (crm) {
    for (const [field, raw] of Object.entries(crm.values)) {
      const parsed = coerce(def, { [field]: raw }, { mode: "update", rules: "off" });
      const c = parsed.ok ? parsed.values[0] : undefined;
      if (!c) continue;
      const said = state.fields[c.fieldId]?.observed.find((o) => o.sourceRef === crm.sourceRef);
      const asserted = said ? said.value : null;
      if (!sameValue(asserted, c.value)) mismatches.push({ attribute: c.fieldId, against: "crmRow", ledger: asserted, other: c.value });
      else if (!sameValue(projected.values[c.fieldId] ?? null, c.value)) overridden.push(c.fieldId);
    }
  }
  return { mismatches, overridden };
}

/**
 * One CRM sync mutation's accounts or contacts (convex/hubspot.ts and
 * convex/salesforce.ts upsertAccounts, upsertContacts). Rows are visited in
 * order while `hasBudget` (the transaction's facts-read budget) holds; the
 * rows not reached are returned for the caller to resubmit. The first row is
 * always visited, so each resubmission makes progress.
 */
export async function syncPartyBatch<T>(rows: readonly T[], o: { hasBudget: () => boolean; visit: (row: T) => Promise<unknown> }): Promise<{ unprocessed: T[] }> {
  for (const [i, row] of rows.entries()) {
    if (i > 0 && !o.hasBudget()) return { unprocessed: rows.slice(i) };
    await o.visit(row);
  }
  return { unprocessed: [] };
}

/**
 * Submit `rows` to a sync or promotion mutation, then the rows it hands back,
 * until none are left (see syncPartyBatch). The first submission always runs,
 * even with no rows: a promotion writes its account whether it has people or not.
 */
export async function resubmitUnprocessed<T>(rows: readonly T[], submit: (rows: T[]) => Promise<T[]>): Promise<void> {
  let left = [...rows];
  do left = await submit(left);
  while (left.length);
}
