/**
 * Records whose `facts` history moves onto an object-layer stream: deals
 * (dealLedger.ts, CP1d) and accounts and contacts (partyLedger.ts, CP2a).
 *
 * A write appends to the record's stream through `save`, and every appended
 * value of a field the `facts` ledger tracks is mirrored into `facts` and
 * `canonFieldState`, which the receipt drawer and the review queue still read.
 * Agent proposals enter through the `facts` gate and are mirrored the other
 * way. A stream with no entries is converted from the record's facts on first
 * use, so a backfill and a live write converge on the same history.
 *
 * Written against LedgerStore and ObjectStore so it runs in Convex and in unit
 * tests. Everything runs in one transaction.
 */
import { ConvexError } from "convex/values";
import { isKnownAttribute, type EntityType } from "./attributes.ts";
import { decidedByOf, decisionMeta, deciderOf, type Decider } from "./decider.ts";
import { mayWrite, type OwnershipOverride } from "./gate.ts";
import type { FactActor, LedgerStore, StoredFact } from "./ledger.ts";
import { AUTO_ACCEPT, resolveAttribute, sameValue, type FactValue, type FieldState, type Resolution } from "./policy.ts";
import { factIdOf, type Decision, type EntryActor, type EntrySource, type Fact, type FoldState, type LedgerEntry, type ProjectedRow } from "../objects/fold.ts";
import { coerce, ruleModeFor, type CoerceError, type FieldValue, type ResolvedObjectDef } from "../objects/registry.ts";
import { appendHistory, checkUnique, save, type ObjectStore, type SaveResult } from "../objects/write.ts";
import type { FieldClaimStore } from "./personHold.ts";

export interface StreamStores {
  facts: LedgerStore;
  objects: ObjectStore;
  /**
   * Facts this transaction may still read to convert records' histories into
   * streams, shared by every write in one transaction. When it runs out, a
   * record without a stream is written to `facts` only and converted later.
   * With `limit`, a record whose history does not fit what is left waits for
   * a transaction of its own, so one transaction converts at most `limit`
   * facts, or one record's history.
   */
  conversionBudget?: { remaining: number; limit?: number };
  /**
   * Queue a write's `facts` mirror for later, off the writing transaction (StreamWrite `deferMirror`). The queue's
   * runner calls mirrorAppended with the job, in its own transaction.
   */
  queueMirror?: (job: MirrorJob) => Promise<void>;
  /** What CRMs say about the fields a person holds, recorded by the writes (SaveContext `fieldClaims`). Absent: the hold still applies, and nothing is recorded. */
  fieldClaims?: FieldClaimStore;
}

/** A record's stream and the `facts` it is converted from. */
export type StreamTarget = {
  orgId: string;
  def: ResolvedObjectDef;
  /** The record's canonEntities id, which is its stream. */
  streamId: string;
  /** The `facts` ledger's name for the object (`opportunity` for deals). */
  entityType: EntityType;
  /** The attributes the record has facts for. */
  attributes: readonly string[];
};

export const baseRef = (f: Pick<StoredFact, "sourceRef" | "attribute">) =>
  f.sourceRef.endsWith(`:${f.attribute}`) ? f.sourceRef.slice(0, -(f.attribute.length + 1)) : f.sourceRef;

export type ConvertibleFact = Pick<StoredFact,
  "_id" | "attribute" | "value" | "sourceKind" | "sourceRef" | "actor" | "evidence" | "confidence" | "observedAt" | "validFrom" | "status" | "decidedBy" | "decider" | "decidedAt"
> & { _creationTime?: number };

/**
 * A record's `facts` as ledger entries, oldest first from `fromVersion`. Facts
 * one write recorded (same source record, time and actor) become one assert
 * entry. A proposal becomes a proposed assert, and its decision a decide
 * entry at `decidedAt` carrying a copy of the fact. Folding the result gives
 * every attribute the accepted facts `resolveAttribute` sees in `facts`.
 */
export function factsToEntries(streamId: string, facts: readonly ConvertibleFact[], fromVersion = 1, copiesOut?: Map<string, Fact>): LedgerEntry[] {
  const ordered = [...facts].sort((a, b) => a.observedAt - b.observedAt || (a._creationTime ?? 0) - (b._creationTime ?? 0));
  type Event =
    | { at: number; rank: 0; source: EntrySource; actor: EntryActor; status: "accepted" | "proposed"; facts: ConvertibleFact[] }
    | { at: number; rank: 1; meta: { source: EntrySource; actor: EntryActor }; facts: ConvertibleFact[] };
  const events = new Map<string, Event>();
  const add = (key: string, make: () => Event, f: ConvertibleFact) => {
    const e = events.get(key) ?? make();
    events.set(key, e);
    e.facts.push(f);
  };
  // One write's facts are adjacent in creation order, so only a run of adjacent facts with the same
  // source, time and actor (and no repeated attribute) forms one entry; an interleaved write splits it.
  let run: { key: string; n: number; attributes: Set<string> } | null = null;
  let runs = 0;
  for (const f of ordered) {
    const accepted = AUTO_ACCEPT.has(f.sourceKind) && f.status === "accepted";
    const source: EntrySource = { kind: f.sourceKind, ref: baseRef(f) };
    const key = JSON.stringify(["assert", f.observedAt, source, f.actor, accepted]);
    if (!run || run.key !== key || run.attributes.has(f.attribute)) run = { key, n: runs++, attributes: new Set() };
    run.attributes.add(f.attribute);
    add(`${key}#${run.n}`, () => ({ at: f.observedAt, rank: 0, source, actor: f.actor, status: accepted ? "accepted" : "proposed", facts: [] }), f);
    if (!accepted && f.status !== "proposed") {
      const at = Math.max(f.decidedAt ?? f.observedAt, f.observedAt);
      const meta = decisionMeta(deciderOf(f));
      add(JSON.stringify(["decide", at, meta]), () => ({ at, rank: 1, meta, facts: [] }), f);
    }
  }
  // Map order is first appearance, which is time order within each rank.
  const timeline = [...events.values()].map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.e.rank - b.e.rank || a.i - b.i);

  const copies = copiesOut ?? new Map<string, Fact>();
  return timeline.map(({ e }, i): LedgerEntry => {
    const version = fromVersion + i;
    if (e.rank === 1) {
      const decisions: Decision[] = e.facts.map((f) => ({ fact: copies.get(f._id)!, status: f.status === "accepted" ? "accepted" : "rejected" }));
      return { streamId, version, observedAt: e.at, ...e.meta, body: { kind: "decide", decisions } };
    }
    const assertions = e.facts.map((f, index) => {
      const optional = { ...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}), ...(f.evidence !== undefined ? { evidence: f.evidence } : {}) };
      copies.set(f._id, {
        factId: factIdOf(streamId, version, index), fieldId: f.attribute as Fact["fieldId"], value: f.value,
        sourceKind: f.sourceKind, sourceRef: e.source.ref, observedAt: e.at, confidence: f.confidence, ...optional,
      });
      return { fieldId: f.attribute as Fact["fieldId"], value: f.value, confidence: f.confidence, ...optional };
    });
    return { streamId, version, observedAt: e.at, source: e.source, actor: e.actor, body: { kind: "assert", status: e.status, assertions } };
  });
}

/**
 * `deferred` with `oversized`: the record's history is larger than one
 * transaction converts, so it stays in `facts` and is never converted in part.
 */
export type StreamInit = { status: "existing" | "converted" | "created" | "deferred"; factsRead: number; oversized?: true };

/**
 * Give a record's stream its history before its first ledger write: its facts
 * converted, or a create entry when it has none. A stream with entries is
 * left alone, so this is idempotent and resumable per record. A history is
 * converted whole or not at all: past `maxFacts` nothing is written. `def`
 * may be derived from the facts read, so fields they name can be registered
 * before the history is folded.
 */
export async function ensureStream(
  s: StreamStores,
  a: Omit<StreamTarget, "entityType" | "def"> & {
    now: number;
    def: ResolvedObjectDef | ((facts: readonly StoredFact[]) => Promise<ResolvedObjectDef>);
    maxFacts?: number;
    /** Who the create entry of a record with no history names; a person creating the record, else Canon. */
    creator?: { source: EntrySource; actor: FactActor };
  },
): Promise<StreamInit> {
  if ((await s.objects.readEntries(a.streamId, 0, 1)).length) return { status: "existing", factsRead: 0 };
  const budget = s.conversionBudget;
  if (budget && budget.remaining <= 0) return { status: "deferred", factsRead: 0 };
  const facts: StoredFact[] = [];
  for (const attribute of a.attributes) {
    facts.push(...(await s.facts.factsFor(a.streamId, attribute)));
    if (a.maxFacts !== undefined && facts.length > a.maxFacts) {
      if (budget) budget.remaining = Math.max(0, budget.remaining - facts.length);
      return { status: "deferred", factsRead: facts.length, oversized: true };
    }
  }
  if (budget) {
    if (budget.limit !== undefined && budget.remaining < budget.limit && facts.length > budget.remaining) {
      budget.remaining = 0;
      return { status: "deferred", factsRead: facts.length };
    }
    budget.remaining -= facts.length;
  }
  const copies = new Map<string, Fact>();
  const entries: LedgerEntry[] = facts.length
    ? factsToEntries(a.streamId, facts, 1, copies)
    : [{ streamId: a.streamId, version: 1, observedAt: a.now, ...(a.creator ?? { source: { kind: "import", ref: "canon:stream" }, actor: { kind: "integration", id: "canon" } }), body: { kind: "lifecycle", op: "create" } }];
  const def = typeof a.def === "function" ? await a.def(facts) : a.def;
  await appendHistory(s.objects, { orgId: a.orgId, def, now: a.now }, a.streamId, entries);
  for (const f of facts) {
    const copy = f.status === "proposed" ? copies.get(f._id) : undefined;
    if (copy) await s.facts.setLedgerFactId(f._id, copy.factId);
  }
  return { status: facts.length ? "converted" : "created", factsRead: facts.length };
}

export type StreamWrite = Omit<StreamTarget, "attributes"> & {
  source: EntrySource;
  actor: FactActor;
  /** The source's snapshot time (a provider's last-modified stamp). */
  validFrom?: number;
  values: Record<string, unknown>;
  now: number;
  evidence?: string;
  /** Field ownership for this source (lib/canon/gate.ts); absent, it owns every field. A denied field is left out like an invalid one. */
  mayWrite?: (fieldApiName: string) => boolean;
  /** Some of the snapshot's fields were left out by the caller, so its time must not mark the snapshot as seen. */
  partial?: true;
  /** Append the values even where the source already said them, dated validFrom (SaveCommand `reassert`). */
  reassert?: true;
  /** The person who ran an agent-class source and accepts its values as they land (SaveContext `acceptedBy`). */
  acceptedBy?: Decider;
  /** For a CRM's write: the field groups it always wins (SaveContext `crmFollows`). */
  crmFollows?: (group: string) => boolean;
  /**
   * Mirror into `facts` later (the stores' queueMirror), not in this transaction: a CRM sync's bulk writes. The
   * stream and its hot row are written now; `facts` and `canonFieldState` follow when the queue runs, so `resolved`
   * is empty. Without a queue, the mirror is written now as usual.
   */
  deferMirror?: true;
};

/** What mirroring one write into `facts` needs once the write has committed (mirrorAppended). */
export type MirrorJob = {
  orgId: string;
  entityType: EntityType;
  streamId: string;
  /** The entry the write appended, or none (a write that appended nothing still confirms re-observed values). */
  version: number | null;
  source: { kind: EntrySource["kind"]; ref: string };
  actor: FactActor;
  acceptedBy?: Decider;
  now: number;
  /** Fields of the record's definition whose list values are kept as facts (splits). */
  listFacts: string[];
  /** The coerced values the write carried, by fieldId. */
  incoming: Array<[string, unknown]>;
};

export type StreamWriteResult = {
  result: SaveResult;
  /** The `facts` resolution of each attribute this write appended. */
  resolved: Record<string, Resolution>;
  /** Fields the registry or a unique claim rejected; they were left out of the write and logged. */
  rejected: CoerceError[];
  /** The coerced values the write carried, by fieldId. */
  incoming: Map<string, FieldValue>;
};

/**
 * Append one write to a stream that already has its history. Fields the
 * registry rejects, or whose unique value another record holds, are left out
 * and the rest still lands. Appended values of fields the `facts` ledger
 * tracks are mirrored into `facts` and `canonFieldState`; a re-observed value
 * bumps its fact's lastConfirmedAt, as the `facts` write rule does.
 */
export async function appendWrite(s: StreamStores, w: StreamWrite): Promise<StreamWriteResult> {
  const rejected: CoerceError[] = [];
  let values: Record<string, unknown> = { ...w.values };
  const leaveOut = (errors: readonly CoerceError[]) => {
    rejected.push(...errors);
    const bad = new Set(errors.map((e) => e.field));
    values = Object.fromEntries(Object.entries(values).filter(([k]) => !bad.has(k)));
  };
  const parsed = coerce(w.def, values, { mode: "update", rules: ruleModeFor(w.source.kind), now: w.now });
  if (!parsed.ok) leaveOut(parsed.errors);
  const run = () => save(s.objects, {
    orgId: w.orgId, def: w.def, source: w.source, actor: w.actor, now: w.now, ...(w.evidence !== undefined ? { evidence: w.evidence } : {}),
    ...(w.mayWrite ? { mayWrite: w.mayWrite } : {}), ...(w.acceptedBy ? { acceptedBy: w.acceptedBy } : {}), ...(w.crmFollows ? { crmFollows: w.crmFollows } : {}),
    ...(s.fieldClaims ? { fieldClaims: s.fieldClaims } : {}),
  }, { op: "update", streamId: w.streamId, values, ...(w.validFrom !== undefined ? { validFrom: w.validFrom } : {}), ...(w.partial || rejected.some((e) => e.retryable) ? { partial: true as const } : {}), ...(w.reassert ? { reassert: true as const } : {}) });
  // Each stage (ownership, then unique claims) can refuse different fields; leave each out until the rest lands.
  let result = await run();
  while (result.status === "invalid" && result.errors.some((e) => e.field in values)) {
    leaveOut(result.errors.filter((e) => e.field in values));
    result = await run();
  }
  if (rejected.length) console.warn(`${w.def.apiName} ${w.streamId}: ${w.source.kind} write left out ${JSON.stringify(rejected)}`);
  const final = coerce(w.def, values, { mode: "update", rules: "off" });
  const incoming = new Map(final.ok ? final.values.map((c) => [c.fieldId as string, c.value]) : []);

  const job: MirrorJob = {
    orgId: w.orgId, entityType: w.entityType, streamId: w.streamId,
    version: result.status === "applied" || result.status === "proposed" ? result.version : null,
    source: { kind: w.source.kind, ref: w.source.ref }, actor: w.actor, ...(w.acceptedBy ? { acceptedBy: w.acceptedBy } : {}), now: w.now,
    listFacts: [...w.def.byApiName.values()].filter((f) => f.type === "splits").map((f) => f.apiName),
    incoming: [...incoming],
  };
  if (w.deferMirror && s.queueMirror) {
    await s.queueMirror(job);
    return { result, resolved: {}, rejected, incoming };
  }
  const resolved = await mirrorAppended(s, job);
  return { result, resolved, rejected, incoming };
}

/**
 * Mirror one write into `facts` and `canonFieldState`, which the receipt drawer and the review queue still read:
 * each value the write's entry asserted for a field `facts` tracks becomes a fact and re-resolves its field, and a
 * re-observed value bumps its fact's lastConfirmedAt, as the `facts` write rule does. Run in the write's transaction,
 * or later from the queue (StreamWrite `deferMirror`): it reads the committed entry, so both write the same rows.
 */
export async function mirrorAppended(s: Pick<StreamStores, "facts" | "objects">, m: MirrorJob): Promise<Record<string, Resolution>> {
  const resolved: Record<string, Resolution> = {};
  const appended = new Set<string>();
  const tracked = (attribute: string, value: unknown) => isKnownAttribute(m.entityType, attribute) && (!Array.isArray(value) || m.listFacts.includes(attribute));
  if (m.version !== null) {
    const [entry] = await s.objects.readEntries(m.streamId, m.version - 1, 1);
    if (entry?.body.kind === "assert") {
      for (const a of entry.body.assertions) {
        // String lists remain on the object ledger; structured split facts use the shared fact value.
        if (!tracked(a.fieldId, a.value)) continue;
        await s.facts.insertFact({
          orgId: m.orgId, entityType: m.entityType, entityId: m.streamId, attribute: a.fieldId, value: a.value as FactValue,
          sourceKind: m.source.kind, sourceRef: `${m.source.ref}:${a.fieldId}`, actor: m.actor, evidence: a.evidence, confidence: a.confidence ?? 1,
          observedAt: entry.observedAt, validFrom: a.validFrom, lastConfirmedAt: entry.observedAt, status: entry.body.status,
          ...(m.acceptedBy ? { decider: m.acceptedBy, decidedBy: decidedByOf(m.acceptedBy), decidedAt: entry.observedAt } : {}),
        });
        appended.add(a.fieldId);
      }
      for (const attribute of appended) {
        resolved[attribute] = resolveAttribute(await s.facts.factsFor(m.streamId, attribute));
        await s.facts.upsertFieldState({ entityId: m.streamId, attribute, ...resolved[attribute], updatedAt: m.now });
      }
    }
  }
  for (const [attribute, value] of m.incoming) {
    if (appended.has(attribute) || !tracked(attribute, value)) continue;
    const latest = await s.facts.latestBySourceRef(m.orgId, `${m.source.ref}:${attribute}`);
    // Confirmation times only move forward, however late a queued mirror runs.
    if (latest && sameValue(latest.value, value as FactValue) && (latest.lastConfirmedAt ?? 0) < m.now) await s.facts.confirmFact(latest._id, m.now);
  }
  return resolved;
}

/**
 * Mirror an agent proposal the `facts` gate just stored into the record's
 * stream as a proposed assert, with the fact's own time, evidence and
 * confidence. `init` is the caller's ensureStream result: a conversion already
 * copied the fact, or will. Field ownership is checked again by the save.
 */
export async function mirrorProposalToStream(
  s: StreamStores,
  a: Omit<StreamTarget, "streamId" | "attributes"> & { fact: StoredFact; ownership?: readonly OwnershipOverride[] },
  init: StreamInit,
): Promise<SaveResult | StreamInit> {
  const f = a.fact;
  if (init.status === "converted" || init.status === "deferred") return init;
  const result = await save(s.objects, {
    orgId: a.orgId, def: a.def, source: { kind: f.sourceKind, ref: baseRef(f) }, actor: f.actor, now: f.observedAt, confidence: f.confidence,
    ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    mayWrite: (apiName) => mayWrite(f.sourceKind, apiName, a.ownership, a.entityType),
  }, { op: "update", streamId: f.entityId, values: { [f.attribute]: f.value }, ...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}) });
  if (result.status === "invalid") console.warn(`fact ${f._id}: proposal not mirrored to the ledger ${JSON.stringify(result.errors)}`);
  if (result.status === "proposed") await s.facts.setLedgerFactId(f._id, factIdOf(f.entityId, result.version, 0));
  return result;
}

/**
 * The pending ledger fact a `facts` proposal was mirrored as, by the id the
 * mirror recorded. Older proposals fall back to source record and time, with
 * the coerced value breaking a tie.
 */
function pendingFor(def: ResolvedObjectDef, state: FoldState | null, f: StoredFact): Fact | undefined {
  const pending = state?.fields[f.attribute]?.pending ?? [];
  if (f.ledgerFactId) return pending.find((p) => p.factId === f.ledgerFactId);
  // Proposals mirrored before ledgerFactId existed: match on source record and time.
  const ref = baseRef(f);
  const same = state?.fields[f.attribute]?.pending.filter((p) => p.sourceKind === f.sourceKind && p.sourceRef === ref && p.observedAt === f.observedAt) ?? [];
  if (same.length <= 1) return same[0];
  const coerced = coerce(def, { [f.attribute]: f.value }, { mode: "update", rules: "off" });
  const value = coerced.ok ? coerced.values[0]?.value ?? null : f.value;
  return same.find((p) => sameValue(p.value, value));
}

/**
 * Apply decisions the `facts` gate made (a reviewer, or an auto-accept rule
 * after Jev's check) to the record's stream as one decide entry. A proposal
 * that was never mirrored is decided by a copy of its fact. `init` is the
 * caller's ensureStream result: a converted stream already holds the
 * decisions, and a deferred one has none yet. An acceptance the stream
 * refuses (its unique value is another record's) throws, so the caller's
 * transaction, the `facts` decision with it, rolls back and the proposal
 * stays open for a reviewer to reject.
 */
export async function decideInStream(
  s: StreamStores,
  a: Pick<StreamTarget, "orgId" | "def" | "streamId"> & { decided: readonly StoredFact[]; decider: Decider; at: number },
  init: StreamInit,
): Promise<void> {
  if (init.status === "converted" || init.status === "deferred") return;
  const state = await s.objects.getHotRow(a.streamId);
  const decisions: Decision[] = a.decided.map((f) => ({
    status: f.status === "accepted" ? "accepted" : "rejected",
    fact: pendingFor(a.def, state, f) ?? {
      factId: f.ledgerFactId ?? `facts:${f._id}`, fieldId: f.attribute as Fact["fieldId"], value: f.value, sourceKind: f.sourceKind, sourceRef: baseRef(f),
      observedAt: f.observedAt, confidence: f.confidence,
      ...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}), ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
    },
  }));
  const result = await save(s.objects, { orgId: a.orgId, def: a.def, ...decisionMeta(a.decider), now: a.at }, { op: "decide", streamId: a.streamId, decisions });
  if (result.status === "invalid" && decisions.some((d) => d.status === "accepted")) {
    throw new ConvexError(result.errors.map((e) => e.message).join("; "));
  }
}

/**
 * A record with no stream yet converts its facts, decisions included, on its
 * first ledger write, and a conversion does not refuse a value another record
 * holds. So the values the `facts` gate just accepted for it are held to the
 * unique claims first, as a decide on its stream is (decideInStream): a
 * collision throws and the caller's transaction rolls back.
 */
export async function refuseTakenAcceptances(
  s: StreamStores,
  a: Pick<StreamTarget, "orgId" | "def" | "streamId"> & { decided: readonly StoredFact[] },
): Promise<void> {
  if ((await s.objects.readEntries(a.streamId, 0, 1)).length) return;
  const accepted = a.decided.filter((f) => f.status === "accepted").map((f) => ({ fieldId: f.attribute as Fact["fieldId"], value: f.value }));
  const taken = await checkUnique(s.objects, a, accepted, a.streamId);
  if (taken.length) throw new ConvexError(taken.map((e) => e.message).join("; "));
}

export type FieldStateLike = { value: FactValue; state: FieldState };
export type FieldStateMismatch = { attribute: string; ledger: FieldValue; ledgerState: FieldState; other: FieldStateLike | null };

/**
 * A projection against `canonFieldState`, attribute by attribute: equal value
 * and equal state, or both absent. A field the ledger never resolved needs no
 * state row.
 */
export function compareFieldStates(
  projected: ProjectedRow,
  fieldStates: ReadonlyMap<string, FieldStateLike>,
  attributes: readonly string[],
): FieldStateMismatch[] {
  const out: FieldStateMismatch[] = [];
  for (const attribute of attributes) {
    const meta = projected.meta[attribute];
    const ledger = projected.values[attribute] ?? null;
    const ledgerState = meta?.state ?? "empty";
    const fs = fieldStates.get(attribute);
    if (fs ? !sameValue(fs.value, ledger) || fs.state !== ledgerState : Boolean(meta?.factId)) {
      out.push({ attribute, ledger, ledgerState, other: fs ?? null });
    }
  }
  return out;
}
