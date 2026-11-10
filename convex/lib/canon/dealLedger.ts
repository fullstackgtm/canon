/**
 * Deals on the object-layer ledger (docs/cp0-object-layer.md, migration step 4).
 *
 * A deal write appends to the deal's stream through `save`, and the fold's
 * projection patches the `deals` row, which stays the deal object's Convex
 * projection so its readers are untouched. Until the receipt drawer, the
 * review queue and `canonFieldState` read the ledger, every appended fact is
 * mirrored into the `facts` table. Agent proposals still enter through the
 * `facts` gate (convex/canonGate.ts) and are mirrored the other way.
 *
 * A stream with no entries is converted from the deal's facts on first use,
 * so the backfill and a live write converge on the same history.
 *
 * Written against LedgerStore and ObjectStore so it runs in Convex
 * (convex/canon.ts) and in unit tests. Everything runs in one transaction.
 */
import { DEAL_ATTRIBUTES, type DealAttribute } from "./attributes.ts";
import type { OwnershipOverride } from "./gate.ts";
import type { Decider } from "./decider.ts";
import { dealObservations, dealPatch, divergences, ingestObservations, providerModifiedAt, type FactActor, type StoredFact } from "./ledger.ts";
import { resolveAttribute, sameValue, type FactValue, type FieldState, type Resolution } from "./policy.ts";
import { appendWrite, compareFieldStates, decideInStream, ensureStream, mirrorProposalToStream, type FieldStateLike, type StreamInit, type StreamStores } from "./streamLedger.ts";
import { project, type EntrySource, type ProjectedRow } from "../objects/fold.ts";
import type { FieldValue, ResolvedObjectDef } from "../objects/registry.ts";
import { save, type SaveResult } from "../objects/write.ts";
import { automationRefPrefix, type AutomationMark } from "../automations.ts";

export type DealRow = Readonly<Record<string, unknown>>;

export interface DealStores extends StreamStores {
  getRow(dealId: string): Promise<DealRow | null>;
  patchRow(dealId: string, patch: Record<string, unknown>): Promise<void>;
}

export type DealSource =
  /** `history`: a dated point from the record's history (CP11c), its own source record so it never stands in for the current snapshot. */
  | { kind: "salesforce" | "hubspot"; crmId: string; rawData?: unknown; history?: true }
  /** `automation`: a rule wrote it as its creator (convex/automations.ts); its own source record, so rules can tell their writes apart. */
  | { kind: "user"; userId: string; automation?: AutomationMark }
  | { kind: "import" }
  /** A CSV row (`csv:<importId>:<row>`) or a CRM's dated past value (`hubspot-history:…`, as of `validFrom`), imported by `actorId`. */
  | { kind: "csv"; ref: string; actorId: string; validFrom?: number };

/** A dated past value (a CRM's history point or a dated import), not a change happening now. */
export const isHistoricalSource = (source: DealSource): boolean =>
  ("history" in source && source.history === true) || (source.kind === "csv" && source.validFrom !== undefined);

/**
 * Deal fields the projection writes to the deals row: the `facts`-tracked
 * attributes, and the company link, which a person sets and no CRM or agent
 * proposes, so a ledger write keeps it out of `facts`. A deferred write
 * (writeDealFactsOnly) holds it in `facts` until conversion reads it back.
 */
const DEAL_ROW_FIELDS = [...DEAL_ATTRIBUTES, "companyId", "ownerId"] as const;
/** The deals column a field lives in: the owner is the row's `primaryRepId`, a Canon member (the CRM's own owner id is `crmOwnerId`). */
const columnOf = (attribute: string): string => (attribute === "ownerId" ? "primaryRepId" : attribute);
const inColumns = (patch: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(patch).map(([k, v]) => [columnOf(k), v]));
type DealRowField = (typeof DEAL_ROW_FIELDS)[number];

export type DealValues = Partial<Record<DealRowField, FactValue>>;

/** One source record per CRM record, per user and deal, or per imported deal: the `facts` sourceRef without its attribute. */
function ledgerSource(source: DealSource, dealId: string, row: DealRow | null): { source: EntrySource; actor: FactActor; validFrom?: number } {
  switch (source.kind) {
    case "salesforce":
    case "hubspot": {
      const validFrom = providerModifiedAt(source.rawData);
      const ref = source.history ? `${source.kind}:history:${source.crmId}` : `${source.kind}:${source.crmId}`;
      return { source: { kind: source.kind, ref }, actor: { kind: "integration", id: source.kind }, ...(validFrom !== undefined ? { validFrom } : {}) };
    }
    case "user":
      return { source: { kind: "user", ref: `${source.automation ? automationRefPrefix(source.automation) : ""}user:${source.userId}:${dealId}` }, actor: { kind: "user", id: source.userId } };
    case "import": {
      const updatedAt = row?.updatedAt;
      return { source: { kind: "import", ref: `import:deal:${dealId}` }, actor: { kind: "integration", id: "backfill" }, ...(typeof updatedAt === "number" ? { validFrom: updatedAt } : {}) };
    }
    case "csv":
      return { source: { kind: "import", ref: source.ref }, actor: { kind: "integration", id: source.actorId }, ...(source.validFrom !== undefined ? { validFrom: source.validFrom } : {}) };
  }
}

const rowValue = (row: DealRow | null, attribute: string): FieldValue => {
  const value = row?.[columnOf(attribute)] ?? null;
  if (attribute === "splitAllocations" && Array.isArray(value)) return value.map((s) => ({ ...s, kind: s.kind ?? "revenue" }));
  return value as FieldValue;
};

/** Give a deal's stream its history before its first ledger write (see ensureStream), including a company link a deferred write left in `facts`. */
export function ensureDealStream(s: DealStores, a: { orgId: string; def: ResolvedObjectDef; streamId: string; now: number; creator?: { source: EntrySource; actor: FactActor } }): Promise<StreamInit> {
  return ensureStream(s, { ...a, attributes: DEAL_ROW_FIELDS });
}

/**
 * Archive (`delete`) or restore a deal: its stream takes a lifecycle entry, as any record's does, and the deals row's
 * `archivedAt` follows it, so the readers of the deals table leave an archived deal out. A deal whose history can't be
 * converted in this transaction is left as it was.
 */
export async function writeDealLifecycle(
  s: DealStores,
  a: { orgId: string; def: ResolvedObjectDef; dealId: string; streamId: string; op: "delete" | "restore"; userId: string; now: number; expectedVersion?: number },
): Promise<SaveResult> {
  const init = await ensureDealStream(s, { orgId: a.orgId, def: a.def, streamId: a.streamId, now: a.now });
  if (init.status === "deferred") return { status: "invalid", errors: [{ field: "streamId", message: "This deal's history is still being converted. Try again in a minute." }] };
  const result = await save(s.objects, {
    orgId: a.orgId, def: a.def, source: { kind: "user", ref: `user:${a.userId}:${a.dealId}` }, actor: { kind: "user", id: a.userId }, now: a.now,
  }, { op: a.op, streamId: a.streamId, ...(a.expectedVersion !== undefined ? { expectedVersion: a.expectedVersion } : {}) });
  // An unchanged result still settles the row, so a row and its stream that disagree agree again.
  if (result.status === "applied" || result.status === "unchanged") {
    const row = await s.getRow(a.dealId);
    const archived = a.op === "delete";
    if (row && Boolean(row.archivedAt) !== archived) await s.patchRow(a.dealId, { archivedAt: archived ? a.now : undefined });
  }
  return result;
}

/**
 * The patch that makes a deals row show its projection. A field the ledger
 * never resolved is left alone, and an empty value never clears a required
 * column (name, currency, closeDate, dealType, isClosed, isWon).
 */
export function dealRowPatch(def: ResolvedObjectDef, row: DealRow | null, projected: ProjectedRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const attribute of DEAL_ROW_FIELDS) {
    // The owner is the row's own (ownership write-backs and CRM syncs set it directly): only a write that carries it patches it (writeDeal).
    if (attribute === "ownerId" || !projected.meta[attribute]?.factId) continue;
    const value = projected.values[attribute] ?? null;
    if (value === null && def.byApiName.get(attribute)?.required) continue;
    if (sameValue(rowValue(row, attribute), value)) continue;
    patch[columnOf(attribute)] = value ?? undefined;
  }
  return patch;
}

/** Patch the deals row from the stream's hot row; `stamp` also sets updatedAt when something changed. */
export async function projectDealRow(s: DealStores, a: { def: ResolvedObjectDef; dealId: string; streamId: string; stamp?: number }): Promise<Record<string, unknown>> {
  const state = await s.objects.getHotRow(a.streamId);
  const row = await s.getRow(a.dealId);
  if (!state || !row) return {};
  const patch = dealRowPatch(a.def, row, project(a.def, state));
  if (Object.keys(patch).length) await s.patchRow(a.dealId, a.stamp !== undefined ? { ...patch, updatedAt: a.stamp } : patch);
  return patch;
}

export type DealWrite = {
  orgId: string;
  def: ResolvedObjectDef;
  dealId: string;
  /** The deal's canonEntities id, which is its stream. */
  streamId: string;
  source: DealSource;
  values: DealValues;
  now: number;
  evidence?: string;
  /** This write creates the deal: its create entry names this write's source. */
  creates?: true;
  /** Mirror into `facts` from the stores' queue, after this transaction (StreamWrite `deferMirror`): a CRM sync's bulk writes. */
  deferMirror?: true;
};

export type DealWriteResult = {
  /** `deferred`: the deal has no stream yet and this transaction had no budget to convert one; written to `facts` only. */
  result: SaveResult | { status: "deferred"; streamId: string };
  /** The `facts` resolution of each attribute this write appended. */
  resolved: Record<string, Resolution>;
  /** Fields the registry rejected; they were left out of the write and logged. */
  rejected: Array<{ field: string; message: string }>;
};

/**
 * A user edit, provider sync, owner write-back or import of a deal. Appends
 * through the write rule (an unchanged value appends nothing; an older
 * provider snapshot than one already seen changes nothing), mirrors the
 * appended facts into `facts`, patches the deals row from the projection and,
 * for provider syncs, records shadow outbound where Canon disagrees.
 */
export async function writeDeal(s: DealStores, w: DealWrite): Promise<DealWriteResult> {
  const row = await s.getRow(w.dealId);
  const { source, actor, validFrom } = ledgerSource(w.source, w.dealId, row);
  const init = await ensureDealStream(s, { orgId: w.orgId, def: w.def, streamId: w.streamId, now: w.now, ...(w.creates ? { creator: { source, actor } } : {}) });
  if (init.status === "deferred") return writeDealFactsOnly(s, w, row, source, actor, validFrom);

  // A deal a CRM import created holds its owner on the row only. Before an owner change, its stream takes that owner
  // as the import's fact, so the change's entry has the owner before it (a module's deal feed dirties both).
  const rowOwner = rowValue(row, "ownerId");
  if ("ownerId" in w.values && typeof rowOwner === "string" && !sameValue(rowOwner, w.values.ownerId ?? null)) {
    const state = await s.objects.getHotRow(w.streamId);
    if (state && !project(w.def, state).meta.ownerId?.factId) {
      await appendWrite(s, {
        orgId: w.orgId, def: w.def, streamId: w.streamId, entityType: "opportunity", values: { ownerId: rowOwner }, now: w.now,
        ...ledgerSource({ kind: "import" }, w.dealId, row),
      });
    }
  }

  const legacySplits = rowValue(row, "splitAllocations");
  if ("splitAllocations" in w.values && Array.isArray(legacySplits) && legacySplits.length) {
    const state = await s.objects.getHotRow(w.streamId);
    if (state && !project(w.def, state).meta.splitAllocations?.factId) await appendWrite(s, {
      orgId: w.orgId, def: w.def, streamId: w.streamId, entityType: "opportunity", values: { splitAllocations: legacySplits }, now: w.now,
      ...ledgerSource({ kind: "import" }, w.dealId, row),
    });
  }

  const { result, resolved, rejected, incoming } = await appendWrite(s, {
    orgId: w.orgId, def: w.def, streamId: w.streamId, entityType: "opportunity", source, actor, values: w.values, now: w.now,
    ...(validFrom !== undefined ? { validFrom } : {}), ...(w.evidence !== undefined ? { evidence: w.evidence } : {}),
    ...(w.deferMirror ? { deferMirror: true as const } : {}),
  });

  const state = await s.objects.getHotRow(w.streamId);
  if (state) {
    const projected = project(w.def, state);
    if (row) {
      const patch = dealRowPatch(w.def, row, projected);
      if ("ownerId" in w.values && !sameValue(rowValue(row, "ownerId"), w.values.ownerId ?? null)) patch.primaryRepId = w.values.ownerId ?? undefined;
      if (Object.keys(patch).length) await s.patchRow(w.dealId, patch);
    }
    // A history point is what the CRM held then, not what it holds now: no outbound shadow for it.
    if ((w.source.kind === "salesforce" || w.source.kind === "hubspot") && !w.source.history) {
      for (const [attribute, providerValue] of incoming) {
        const canonicalValue = projected.values[attribute] ?? null;
        if (!projected.meta[attribute]?.factId || sameValue(canonicalValue, providerValue)) continue;
        const factId = resolveAttribute(await s.facts.factsFor(w.streamId, attribute)).factId;
        await s.facts.recordShadowOutbound({
          orgId: w.orgId, entityId: w.streamId, provider: w.source.kind, attribute,
          providerValue: providerValue as FactValue, canonicalValue: canonicalValue as FactValue, factId, at: w.now,
        });
      }
    }
  }
  return { result, resolved, rejected };
}

/**
 * A deal whose history did not fit this transaction's conversion budget is
 * written the way it was before the ledger: to `facts`, with the row patched
 * to the facts' resolution. Converting its stream later reads these facts, so
 * nothing is lost; only this write's entry waits for the conversion.
 */
async function writeDealFactsOnly(
  s: DealStores, w: DealWrite, row: DealRow | null, source: EntrySource, actor: FactActor, validFrom: number | undefined,
): Promise<DealWriteResult> {
  const attributes = Object.keys(w.values) as DealAttribute[];
  const observations = dealObservations({ ...(row ?? {}), ...w.values } as Parameters<typeof dealObservations>[0], attributes, validFrom)
    .map((o) => (w.evidence !== undefined ? { ...o, evidence: w.evidence } : o));
  const out = await ingestObservations(s.facts, {
    orgId: w.orgId, entityId: w.streamId, sourceKind: source.kind, sourceRefBase: source.ref, actor, observedAt: w.now, observations,
  });
  const diffs = divergences(observations, out.resolved);
  const patch = inColumns(dealPatch(attributes
    .map((attribute) => ({ attribute, r: out.resolved[attribute] }))
    .filter(({ attribute, r }) => r && r.factId !== null && !sameValue(rowValue(row, attribute) as FactValue, r.value))
    .map(({ attribute, r }) => ({ attribute, canonicalValue: r.value }))));
  if (Object.keys(patch).length) await s.patchRow(w.dealId, patch);
  if (w.source.kind === "salesforce" || w.source.kind === "hubspot") {
    for (const d of diffs) {
      await s.facts.recordShadowOutbound({
        orgId: w.orgId, entityId: w.streamId, provider: w.source.kind, attribute: d.attribute,
        providerValue: d.providerValue, canonicalValue: d.canonicalValue, factId: d.factId, at: w.now,
      });
    }
  }
  return { result: { status: "deferred", streamId: w.streamId }, resolved: out.resolved, rejected: [] };
}

/** Mirror an agent proposal about a deal into its stream (see mirrorProposalToStream). */
export async function mirrorProposal(
  s: DealStores,
  a: { orgId: string; def: ResolvedObjectDef; fact: StoredFact; ownership?: readonly OwnershipOverride[] },
): Promise<SaveResult | StreamInit> {
  const init = await ensureDealStream(s, { orgId: a.orgId, def: a.def, streamId: a.fact.entityId, now: a.fact.observedAt });
  return mirrorProposalToStream(s, { ...a, entityType: "opportunity" }, init);
}

/**
 * Apply decisions the `facts` gate made to the deal's stream (see
 * decideInStream), then patch the deals row from the projection.
 */
export async function mirrorDecisions(
  s: DealStores,
  a: { orgId: string; def: ResolvedObjectDef; dealId: string; streamId: string; decided: readonly StoredFact[]; decider: Decider; at: number },
): Promise<Record<string, unknown>> {
  const init = await ensureDealStream(s, { orgId: a.orgId, def: a.def, streamId: a.streamId, now: a.at });
  if (init.status === "deferred") {
    // No stream yet: patch the row from the facts' resolution, as before the ledger.
    const attributes = [...new Set(a.decided.map((f) => f.attribute))];
    const resolved = await Promise.all(attributes.map(async (attribute) => ({ attribute, r: resolveAttribute(await s.facts.factsFor(a.streamId, attribute)) })));
    const row = await s.getRow(a.dealId);
    const patch = inColumns(dealPatch(resolved
      .filter(({ attribute, r }) => r.factId !== null && !sameValue(rowValue(row, attribute) as FactValue, r.value))
      .map(({ attribute, r }) => ({ attribute, canonicalValue: r.value }))));
    if (Object.keys(patch).length) await s.patchRow(a.dealId, { ...patch, updatedAt: a.at });
    return patch;
  }
  await decideInStream(s, a, init);
  return projectDealRow(s, { def: a.def, dealId: a.dealId, streamId: a.streamId, stamp: a.at });
}

export type { FieldStateLike };
export type DealMismatch = { attribute: string; against: "fieldState" | "row"; ledger: FieldValue; ledgerState: FieldState; other: unknown };

/**
 * The CP1d proof for one deal: its projection against `canonFieldState` and
 * against the deals row. A field the ledger never resolved is reported as
 * unseen when the row holds a value; a required column the ledger resolved
 * to empty keeps the row's value by rule.
 */
export function compareDeal(
  def: ResolvedObjectDef,
  row: DealRow,
  projected: ProjectedRow,
  fieldStates: ReadonlyMap<string, FieldStateLike>,
): { mismatches: DealMismatch[]; unseen: string[] } {
  const mismatches: DealMismatch[] = compareFieldStates(projected, fieldStates, DEAL_ATTRIBUTES).map((m) => ({ ...m, against: "fieldState" }));
  const unseen: string[] = [];
  for (const attribute of DEAL_ATTRIBUTES) {
    const meta = projected.meta[attribute];
    const ledger = projected.values[attribute] ?? null;
    if (!meta?.factId) {
      if (rowValue(row, attribute) !== null) unseen.push(attribute);
      continue;
    }
    if (ledger === null && def.byApiName.get(attribute)?.required) continue;
    if (!sameValue(rowValue(row, attribute), ledger)) mismatches.push({ attribute, against: "row", ledger, ledgerState: meta.state, other: row[attribute] ?? null });
  }
  return { mismatches, unseen };
}
