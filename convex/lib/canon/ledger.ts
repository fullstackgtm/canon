/**
 * CanonCRM fact ledger: ingest and projection logic (docs/canoncrm-spec.md, P0).
 *
 * Written against a small storage interface (LedgerStore) so the same code runs
 * in Convex mutations (convexLedgerStore in convex/canon.ts) and in unit tests
 * (an in-memory store). Everything here runs inside one mutation, so facts,
 * field state and the projected row change together.
 */
import { DEAL_ATTRIBUTES, type DealAttribute, type EntityType } from "./attributes.ts";
import { decidedByOf, type Decider } from "./decider.ts";
import { ID } from "./identity.ts";
import { mayWrite, type OwnershipOverride } from "./gate.ts";
import { AUTO_ACCEPT, resolveAttribute, sameValue, writeDecision, type FactLike, type FactStatus, type FactValue, type Resolution, type SourceKind } from "./policy.ts";

export { DEAL_ATTRIBUTES, type DealAttribute, type EntityType };

/**
 * Where an entity's row lives. Deals project canonical values back onto the
 * deals table; the others are identity anchors (canonFieldState is their read
 * model). `recordAccounts`/`recordContacts` are record-service (TAM) rows.
 */
export type ProjectionTable = "deals" | "crmAccounts" | "crmContacts" | "recordAccounts" | "recordContacts";
export type ExternalId = { provider: string; externalId: string };

/** Who asserted a fact. Decisions have their own deciders (decider.ts). */
export type FactActor = { kind: "integration" | "agent" | "user"; id: string };

export type NewFact = Omit<FactLike, "_id"> & {
  orgId: string;
  entityType: EntityType;
  entityId: string;
  actor: FactActor;
  lastConfirmedAt: number;
  /** The patch plan (proposal batch) a proposed fact belongs to. */
  patchPlanId?: string;
  /** Legacy form of `decider`; read both through deciderOf (decider.ts). */
  decidedBy?: string;
  decider?: Decider;
  decidedAt?: number;
  /** For a deal proposal: the id of its copy in the deal's ledger stream (convex/lib/canon/dealLedger.ts). */
  ledgerFactId?: string;
};

export type StoredFact = NewFact & { _id: string };

export type FieldStateRow = { entityId: string; attribute: string } & Resolution & { updatedAt: number };

export interface LedgerStore {
  findEntityByExternalId(orgId: string, provider: string, externalId: string): Promise<string | null>;
  findEntityByProjection(orgId: string, projectionId: string): Promise<string | null>;
  createEntity(e: { orgId: string; entityType: EntityType; projectionTable: ProjectionTable; projectionId: string; label?: string }): Promise<string>;
  addExternalId(e: { orgId: string; entityId: string; provider: string; externalId: string }): Promise<void>;
  /** Whether the entity's ledger stream has any entries. */
  hasStream(entityId: string): Promise<boolean>;
  /** Latest fact (by observedAt) with this sourceRef, or null. */
  latestBySourceRef(orgId: string, sourceRef: string): Promise<StoredFact | null>;
  insertFact(f: NewFact): Promise<string>;
  confirmFact(factId: string, at: number): Promise<void>;
  getFact(factId: string): Promise<StoredFact | null>;
  decideFact(factId: string, d: { status: Extract<FactStatus, "accepted" | "rejected">; decider: Decider; decidedBy: string; decidedAt: number }): Promise<void>;
  /** Record the ledger copy of a mirrored proposal, so its decision finds that copy by id. */
  setLedgerFactId(factId: string, ledgerFactId: string): Promise<void>;
  /** Facts for one attribute of one entity (bounded; newest first). */
  factsFor(entityId: string, attribute: string): Promise<StoredFact[]>;
  upsertFieldState(row: FieldStateRow): Promise<void>;
  recordShadowOutbound(row: { orgId: string; entityId: string; provider: string; attribute: string; providerValue: FactValue; canonicalValue: FactValue; factId: string | null; at: number }): Promise<void>;
}

export type Observation = { attribute: string; value: FactValue; validFrom?: number; evidence?: string; confidence?: number };

/** The entity ensureEntity would resolve a row to, without creating or linking anything; null when it would create one. */
export async function findEntity(
  store: Pick<LedgerStore, "findEntityByExternalId" | "findEntityByProjection">,
  a: { orgId: string; projectionId: string; externalIds: readonly ExternalId[] },
): Promise<string | null> {
  for (const x of a.externalIds) {
    if (!x.provider || !x.externalId) continue;
    const entityId = await store.findEntityByExternalId(a.orgId, x.provider, x.externalId);
    if (entityId) return entityId;
  }
  return store.findEntityByProjection(a.orgId, a.projectionId);
}

/**
 * Identities that change with a record's values (an account's domain, a
 * contact's email). On an entity with a ledger stream they move only through
 * the value's unique claim (lib/objects/write.ts syncUniqueClaims).
 */
const MUTABLE_IDS: ReadonlySet<string> = new Set([ID.domain, ID.email]);

/**
 * Find or create the Canon entity for a row, and link its identifiers.
 * External ids are tried in order (a record's own ids, then its domain or
 * email, so a CRM account and the TAM row for the same company share one
 * entity), then the projection. An id already linked to another entity is
 * left alone. A domain or email is linked only to an entity with no stream
 * yet: on a stream it follows the value the record resolves to, so a stale
 * snapshot never links back a value the record gave up.
 * The bare `provider`/`externalId` pair is the deal form.
 */
export async function ensureEntity(
  store: LedgerStore,
  a: {
    orgId: string;
    projectionId: string;
    entityType?: EntityType;
    projectionTable?: ProjectionTable;
    label?: string;
    provider?: string;
    externalId?: string;
    externalIds?: readonly ExternalId[];
  },
): Promise<string> {
  const ids = [...(a.externalIds ?? []), ...(a.provider && a.externalId ? [{ provider: a.provider, externalId: a.externalId }] : [])]
    .filter((x) => x.provider && x.externalId);
  const found = await findEntity(store, { orgId: a.orgId, projectionId: a.projectionId, externalIds: ids });
  const entityId = found ?? await store.createEntity({
    orgId: a.orgId, entityType: a.entityType ?? "opportunity", projectionTable: a.projectionTable ?? "deals", projectionId: a.projectionId,
    ...(a.label ? { label: a.label } : {}),
  });
  const claimed = found !== null && ids.some((x) => MUTABLE_IDS.has(x.provider)) && await store.hasStream(found);
  for (const x of ids) {
    if (claimed && MUTABLE_IDS.has(x.provider)) continue;
    if (!(await store.findEntityByExternalId(a.orgId, x.provider, x.externalId))) {
      await store.addExternalId({ orgId: a.orgId, entityId, provider: x.provider, externalId: x.externalId });
    }
  }
  return entityId;
}

export type IngestResult = {
  resolved: Record<string, Resolution>;
  written: number;
  confirmed: number;
  /** Ids of facts this call wrote, by attribute. */
  factIds: Record<string, string>;
  /** Attributes the source does not own (field ownership); nothing was stored for them. */
  rejected: string[];
};

/**
 * Record a source's observations of an entity's attributes and re-resolve them.
 * Idempotent: re-observing an unchanged value only bumps lastConfirmedAt.
 * `sourceRefBase` identifies the source record (e.g. "salesforce:006xx");
 * each attribute's fact gets `${sourceRefBase}:${attribute}`.
 */
export async function ingestObservations(
  store: LedgerStore,
  a: {
    orgId: string;
    entityId: string;
    /** Defaults to opportunity (deal facts). */
    entityType?: EntityType;
    sourceKind: SourceKind;
    sourceRefBase: string;
    actor: NewFact["actor"];
    observedAt: number;
    observations: Observation[];
    ownership?: readonly OwnershipOverride[];
    patchPlanId?: string;
    /** The person who ran an agent-class source and accepts its facts as they land. */
    acceptedBy?: Decider;
  },
): Promise<IngestResult> {
  const out: IngestResult = { resolved: {}, written: 0, confirmed: 0, factIds: {}, rejected: [] };
  for (const o of a.observations) {
    if (!mayWrite(a.sourceKind, o.attribute, a.ownership, a.entityType)) {
      out.rejected.push(o.attribute);
      continue;
    }
    const sourceRef = `${a.sourceRefBase}:${o.attribute}`;
    const latest = await store.latestBySourceRef(a.orgId, sourceRef);
    const decision = writeDecision(latest, { value: o.value, evidence: o.evidence });
    if (decision.kind === "confirm") {
      await store.confirmFact(decision.factId, a.observedAt);
      out.confirmed++;
    } else {
      out.factIds[o.attribute] = await store.insertFact({
        orgId: a.orgId, entityType: a.entityType ?? "opportunity", entityId: a.entityId, attribute: o.attribute, value: o.value,
        sourceKind: a.sourceKind, sourceRef, actor: a.actor, evidence: o.evidence, confidence: o.confidence ?? 1,
        observedAt: a.observedAt, validFrom: o.validFrom, lastConfirmedAt: a.observedAt,
        status: AUTO_ACCEPT.has(a.sourceKind) || a.acceptedBy ? "accepted" : "proposed",
        ...(a.acceptedBy ? { decider: a.acceptedBy, decidedBy: decidedByOf(a.acceptedBy), decidedAt: a.observedAt } : {}),
        ...(a.patchPlanId ? { patchPlanId: a.patchPlanId } : {}),
      });
      out.written++;
    }
    const resolution = resolveAttribute(await store.factsFor(a.entityId, o.attribute));
    await store.upsertFieldState({ entityId: a.entityId, attribute: o.attribute, ...resolution, updatedAt: a.observedAt });
    out.resolved[o.attribute] = resolution;
  }
  return out;
}

/**
 * Accept or reject proposed facts (a person's review decision, or an
 * auto-accept rule after verification), then re-resolve each touched
 * attribute. Only `proposed` facts change; anything else is skipped, so a
 * decision is never applied twice. Returns the new resolutions per entity.
 */
export async function decideFacts(
  store: LedgerStore,
  a: { orgId: string; decisions: Array<{ factId: string; status: "accepted" | "rejected" }>; decider: Decider; at: number },
): Promise<{ decided: StoredFact[]; skipped: string[]; resolved: Map<string, Record<string, Resolution>> }> {
  const decided: StoredFact[] = [];
  const skipped: string[] = [];
  for (const d of a.decisions) {
    const fact = await store.getFact(d.factId);
    if (!fact || fact.orgId !== a.orgId || fact.status !== "proposed") {
      skipped.push(d.factId);
      continue;
    }
    await store.decideFact(fact._id, { status: d.status, decider: a.decider, decidedBy: decidedByOf(a.decider), decidedAt: a.at });
    decided.push({ ...fact, status: d.status });
  }
  const resolved = new Map<string, Record<string, Resolution>>();
  for (const f of decided) {
    const perEntity = resolved.get(f.entityId) ?? {};
    if (!perEntity[f.attribute]) {
      perEntity[f.attribute] = resolveAttribute(await store.factsFor(f.entityId, f.attribute));
      await store.upsertFieldState({ entityId: f.entityId, attribute: f.attribute, ...perEntity[f.attribute], updatedAt: a.at });
    }
    resolved.set(f.entityId, perEntity);
  }
  return { decided, skipped, resolved };
}

/**
 * Attributes whose canonical value differs from what the source just sent:
 * these are re-projected onto the row, and for provider syncs recorded as
 * shadow outbound (what Canon would push back; P0 sends nothing).
 */
export function divergences(observations: Observation[], resolved: Record<string, Resolution>) {
  return observations
    .map((o) => ({ o, r: resolved[o.attribute] }))
    .filter(({ o, r }) => r && r.factId !== null && !sameValue(r.value, o.value))
    .map(({ o, r }) => ({ attribute: o.attribute, providerValue: o.value, canonicalValue: r.value, factId: r.factId }));
}

/** Read a provider's last-modified timestamp from a raw record (valid time). */
export function providerModifiedAt(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const props = (r.properties && typeof r.properties === "object" ? r.properties : {}) as Record<string, unknown>;
  for (const v of [r.SystemModstamp, r.LastModifiedDate, r.updatedAt, props.hs_lastmodifieddate, r.lastSyncAt]) {
    const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
}

/** Deal row fields -> observations (undefined means the source asserts empty). */
export function dealObservations(
  deal: Partial<Record<DealAttribute, FactValue | undefined>>,
  attributes: readonly DealAttribute[],
  validFrom?: number,
): Observation[] {
  return attributes.map((attribute) => ({ attribute, value: (deal[attribute] ?? null) as FactValue, validFrom }));
}

/** Required deals columns: an empty canonical value never clears them. */
const REQUIRED_DEAL_FIELDS: ReadonlySet<string> = new Set(["name", "currency", "closeDate", "dealType", "isClosed", "isWon"]);

/** Resolved values as a deals-table patch (empty -> undefined for optional fields; required fields are left alone). */
export function dealPatch(changes: Array<{ attribute: string; canonicalValue: FactValue }>): Record<string, unknown> {
  return Object.fromEntries(changes
    .filter((c) => c.canonicalValue !== null || !REQUIRED_DEAL_FIELDS.has(c.attribute))
    .map((c) => [c.attribute, c.canonicalValue ?? undefined]));
}
