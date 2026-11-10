/**
 * The fold (docs/cp0-object-layer.md, "The fold"): one pure reducer from a
 * record's ledger entries to its state, and one projection from that state to
 * the row a user reads. Convex imports this file; the record service imports a
 * generated copy of it (scripts/sync-object-core.ts), checked equal by a test.
 *
 * The state keeps, per field, the latest accepted fact from each source plus
 * pending proposals. That is everything `resolveAttribute` reads, so a save
 * costs work proportional to the fields it touches, not to their history.
 */
import { AUTO_ACCEPT, effectiveTime, resolveAttribute, sameValue, type FactLike, type FieldState, type SourceKind } from "../canon/policy.ts";
import type { FieldId, FieldValue, ResolvedObjectDef } from "./registry.ts";

export type EntrySource = { kind: SourceKind; ref: string };
/** `rule` is an auto-accept rule's decision; `unrecorded` is a legacy decision whose decider was never stored. */
export type EntryActor = { kind: "user" | "agent" | "integration" | "rule"; id: string } | { kind: "unrecorded" };

export type Assertion = { fieldId: FieldId; value: FieldValue; validFrom?: number; confidence?: number; evidence?: string };

/** One fact about one field, as the fold keeps it and as a decide entry copies it. */
export type Fact = {
  factId: string;
  fieldId: FieldId;
  value: FieldValue;
  sourceKind: SourceKind;
  sourceRef: string;
  observedAt: number;
  validFrom?: number;
  confidence: number;
  evidence?: string;
};

export type Decision = { fact: Fact; status: "accepted" | "rejected" };

export type EntryBody =
  /** `createdAt` is the source system's creation time, honored only on the entry that opens a stream (imports). */
  /** `partial`: some of the snapshot's fields were left out for now, so its time does not become the source's watermark. */
  | { kind: "assert"; status: "accepted" | "proposed"; assertions: readonly Assertion[]; createdAt?: number; partial?: true }
  /** Carries a full copy of each decided fact, so folding never looks anything up. */
  | { kind: "decide"; decisions: readonly Decision[] }
  | { kind: "lifecycle"; op: "create" | "delete" | "restore" | "erase" }
  | { kind: "lifecycle"; op: "merge"; into: string }
  /**
   * A merge's survivor took these records in (CP15a, lib/canon/partyMerge.ts): their values, each with the
   * source it came from, kept in the survivor's history. It changes no field; the picked values are an `assert`.
   */
  | { kind: "lifecycle"; op: "absorb"; mergeId: string; from: readonly MergedRecord[] }
  /** `validFrom` is the source snapshot's time, recorded even when no value changed. */
  | { kind: "confirm"; fieldIds: readonly FieldId[]; validFrom?: number }
  /**
   * The undo of a merge on its survivor: each field's fold as it was before the merge (null: it had none).
   * It carries the folds, so folding never looks anything up.
   */
  | { kind: "revert"; mergeId: string; fields: readonly RevertedField[] };

/** A record a merge took in, as its survivor's history keeps it: each value with the source it came from. */
export type MergedRecord = {
  streamId: string;
  recordId: string;
  title: string;
  values: readonly { fieldId: FieldId; value: FieldValue; sourceKind: SourceKind | null }[];
};

export type RevertedField = { fieldId: FieldId; fold: FieldFold | null };

export type LedgerEntry = {
  streamId: string;
  version: number;
  observedAt: number;
  source: EntrySource;
  actor: EntryActor;
  body: EntryBody;
};

export type Lifecycle =
  | { status: "active" }
  | { status: "deleted"; at: number }
  | { status: "merged"; at: number; into: string }
  | { status: "erased"; at: number };

export type FieldFold = {
  /**
   * At most one accepted fact per source kind, most recently written first
   * (by origin, see `accept`), the order the `facts` ledger reads facts in.
   * `resolveAttribute` breaks equal-time ties by input order, so the later
   * write wins a tie and the order is part of the state.
   */
  candidates: readonly Fact[];
  /** Proposals awaiting a decision, oldest first, at most MAX_PENDING_PER_FIELD. */
  pending: readonly Fact[];
  /**
   * The latest value each source record asserted, whatever became of it, for
   * the write rule. Several records of one source kind can feed one entity, so
   * this is keyed by source record, not by kind. Oldest first. Snapshot
   * sources (SNAPSHOT_SOURCES) and patch sources (people, agents) are each
   * kept to MAX_OBSERVED_PER_FIELD records, so a burst of one class, such as
   * a person's keyed edits, each its own record, never pushes out the other's:
   * a CRM re-sync always finds what its record last said. A dropped record
   * only costs one extra fact.
   */
  observed: readonly Observation[];
};

export type Observation = { sourceKind: SourceKind; sourceRef: string; value: FieldValue; evidence?: string };

/**
 * The newest snapshot time a source record has given, changed or not, so an
 * older snapshot that arrives later is recognized as stale. Most recent last,
 * at most MAX_WATERMARKS.
 */
export type Watermark = { sourceKind: SourceKind; sourceRef: string; validFrom: number };

export type FoldState = {
  streamId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  lifecycle: Lifecycle;
  fields: Readonly<Record<string, FieldFold>>;
  watermarks: readonly Watermark[];
};

export const MAX_PENDING_PER_FIELD = 20;
export const MAX_OBSERVED_PER_FIELD = 10;
export const MAX_WATERMARKS = 20;

export class GapError extends Error {
  readonly streamId: string;
  readonly expected: number;
  readonly received: number;
  constructor(streamId: string, expected: number, received: number) {
    super(`ledger gap in ${streamId}: expected version ${expected}, got ${received}`);
    this.name = "GapError";
    this.streamId = streamId;
    this.expected = expected;
    this.received = received;
  }
}

export class StreamMismatchError extends Error {
  constructor(expected: string, received: string) {
    super(`entry for stream ${received} folded into stream ${expected}`);
    this.name = "StreamMismatchError";
  }
}

/** The id of the fact an assertion creates. Stable, so a decide entry can name it. */
export const factIdOf = (streamId: string, version: number, index: number) => `${streamId}@${version}#${index}`;

/**
 * Apply one entry. Returns a new state and never mutates the input. An entry
 * at or below the state's version was already applied and returns the state
 * unchanged; a skipped version throws GapError.
 */
export function fold(state: FoldState | null, entry: LedgerEntry): FoldState {
  if (state && entry.streamId !== state.streamId) throw new StreamMismatchError(state.streamId, entry.streamId);
  if (state && entry.version <= state.version) return state;
  const expected = (state?.version ?? 0) + 1;
  if (entry.version !== expected) throw new GapError(entry.streamId, expected, entry.version);

  const createdAt = entry.body.kind === "assert" && entry.body.createdAt !== undefined ? entry.body.createdAt : entry.observedAt;
  const base: FoldState = state ?? {
    streamId: entry.streamId, version: 0, createdAt, updatedAt: entry.observedAt, lifecycle: { status: "active" }, fields: {}, watermarks: [],
  };
  const next = withWatermark(applyBody(base, entry), entry);
  return { ...next, version: entry.version, updatedAt: entry.body.kind === "confirm" ? next.updatedAt : entry.observedAt };
}

function snapshotTime(body: EntryBody): number | undefined {
  if (body.kind === "confirm") return body.validFrom;
  if (body.kind !== "assert" || body.partial) return undefined;
  const times = body.assertions.map((a) => a.validFrom).filter((t): t is number => t !== undefined);
  return times.length ? Math.max(...times) : undefined;
}

/**
 * Sources whose `validFrom` is a snapshot time: when the source record looked
 * like this. A person's edit or an agent's claim is a patch whose `validFrom`
 * dates its values, not a snapshot, so it never sets a watermark.
 */
export const SNAPSHOT_SOURCES: readonly SourceKind[] = ["salesforce", "hubspot", "import"];

function withWatermark(state: FoldState, entry: LedgerEntry): FoldState {
  if (!SNAPSHOT_SOURCES.includes(entry.source.kind)) return state;
  const at = snapshotTime(entry.body);
  if (at === undefined) return state;
  const { kind, ref } = entry.source;
  const current = state.watermarks.find((w) => w.sourceKind === kind && w.sourceRef === ref);
  if (current && current.validFrom >= at) return state;
  const others = state.watermarks.filter((w) => w !== current);
  return { ...state, watermarks: [...others, { sourceKind: kind, sourceRef: ref, validFrom: at }].slice(-MAX_WATERMARKS) };
}

/** The newest snapshot time this source record has given, if any. */
export function watermarkOf(state: FoldState, source: EntrySource): number | undefined {
  return state.watermarks.find((w) => w.sourceKind === source.kind && w.sourceRef === source.ref)?.validFrom;
}

export function foldAll(entries: readonly LedgerEntry[], state: FoldState | null = null): FoldState | null {
  return entries.reduce<FoldState | null>(fold, state);
}

function applyBody(state: FoldState, entry: LedgerEntry): FoldState {
  const body = entry.body;
  switch (body.kind) {
    case "assert": {
      if (state.lifecycle.status === "erased") return state;
      const facts = body.assertions.map((a, i): Fact => ({
        factId: factIdOf(entry.streamId, entry.version, i),
        fieldId: a.fieldId,
        value: a.value,
        sourceKind: entry.source.kind,
        sourceRef: entry.source.ref,
        observedAt: entry.observedAt,
        ...(a.validFrom !== undefined ? { validFrom: a.validFrom } : {}),
        confidence: a.confidence ?? 1,
        ...(a.evidence !== undefined ? { evidence: a.evidence } : {}),
      }));
      return facts.reduce((s, fact) => updateField(s, fact.fieldId, (f) => {
        const seen = observe(f, fact);
        return body.status === "accepted" ? accept(seen, fact) : propose(seen, fact);
      }), state);
    }
    case "decide": {
      if (state.lifecycle.status === "erased") return state;
      return body.decisions.reduce((s, { fact, status }) => updateField(s, fact.fieldId, (f) => {
        const undecided = { ...f, pending: f.pending.filter((p) => p.factId !== fact.factId) };
        return status === "accepted" ? accept(undecided, fact) : undecided;
      }), state);
    }
    case "lifecycle":
      return { ...state, ...lifecycleChange(state, body, entry.observedAt) };
    case "confirm":
      return state;
    case "revert": {
      if (state.lifecycle.status === "erased") return state;
      const fields = { ...state.fields };
      for (const { fieldId, fold: was } of body.fields) {
        if (was) fields[fieldId] = was;
        else delete fields[fieldId];
      }
      return { ...state, fields };
    }
    default: {
      const unhandled: never = body;
      throw new Error(`unknown ledger entry body ${JSON.stringify(unhandled)}`);
    }
  }
}

function lifecycleChange(state: FoldState, body: Extract<EntryBody, { kind: "lifecycle" }>, at: number): Partial<FoldState> {
  const current = state.lifecycle;
  if (current.status === "erased") return {};
  switch (body.op) {
    case "create":
      return {};
    case "delete":
      return current.status === "active" ? { lifecycle: { status: "deleted", at } } : {};
    case "restore":
      return { lifecycle: { status: "active" } };
    case "merge":
      return { lifecycle: { status: "merged", at, into: body.into } };
    case "absorb":
      return {};
    case "erase":
      return { lifecycle: { status: "erased", at }, fields: {} };
  }
}

const EMPTY_FIELD: FieldFold = { candidates: [], pending: [], observed: [] };

function updateField(state: FoldState, fieldId: FieldId, change: (f: FieldFold) => FieldFold): FoldState {
  const before = state.fields[fieldId] ?? EMPTY_FIELD;
  const after = change(before);
  return after === before ? state : { ...state, fields: { ...state.fields, [fieldId]: after } };
}

/** Recency as `resolveAttribute` compares it: valid time, then transaction time. */
const recency = (a: Fact, b: Fact) => effectiveTime(a) - effectiveTime(b) || a.observedAt - b.observedAt;

/**
 * When a fact was first written: its entry version and index, which its id
 * encodes. A proposal accepted later keeps the origin of the entry that
 * proposed it, so the order a reviewer approves in never changes a winner.
 * Ids from outside the ledger sort as oldest.
 */
function origin(fact: Fact): number {
  const m = /@(\d+)#(\d+)$/.exec(fact.factId);
  return m ? Number(m[1]) * 10_000 + Number(m[2]) : -1;
}

function accept(field: FieldFold, fact: Fact): FieldFold {
  const current = field.candidates.find((c) => c.sourceKind === fact.sourceKind);
  if (current) {
    const order = recency(fact, current) || origin(fact) - origin(current);
    if (order < 0) return field;
  }
  const candidates = [fact, ...field.candidates.filter((c) => c.sourceKind !== fact.sourceKind)].sort((a, b) => origin(b) - origin(a));
  return { ...field, candidates };
}

function observe(field: FieldFold, fact: Fact): FieldFold {
  const observation: Observation = {
    sourceKind: fact.sourceKind, sourceRef: fact.sourceRef, value: fact.value, ...(fact.evidence !== undefined ? { evidence: fact.evidence } : {}),
  };
  const observed = [...field.observed.filter((o) => o.sourceKind !== fact.sourceKind || o.sourceRef !== fact.sourceRef), observation];
  // Trim only the incoming record's class, oldest first.
  const snapshot = isSnapshotSource(fact.sourceKind);
  const sameClass = observed.filter((o) => isSnapshotSource(o.sourceKind) === snapshot);
  const drop = new Set(sameClass.slice(0, Math.max(0, sameClass.length - MAX_OBSERVED_PER_FIELD)));
  return { ...field, observed: drop.size ? observed.filter((o) => !drop.has(o)) : observed };
}

const isSnapshotSource = (kind: SourceKind) => SNAPSHOT_SOURCES.includes(kind);

function propose(field: FieldFold, fact: Fact): FieldFold {
  return { ...field, pending: [...field.pending, fact].slice(-MAX_PENDING_PER_FIELD) };
}

export type FieldMeta = { state: FieldState; factId: string | null; sourceKind: SourceKind | null };

export type ProjectedRow = {
  /** Every writable field of the object, keyed by fieldId; `null` when empty. */
  values: Record<string, FieldValue>;
  meta: Record<string, FieldMeta>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  mergedInto: string | null;
};

/**
 * The row a user reads. Each field resolves with `resolveAttribute` over its
 * candidates. System fields are the row's own timestamps; formula fields are
 * computed elsewhere (CP7), so neither appears in `values`.
 */
export function project(def: ResolvedObjectDef, state: FoldState): ProjectedRow {
  const values: Record<string, FieldValue> = {};
  const meta: Record<string, FieldMeta> = {};
  for (const field of def.fields) {
    if (field.system || field.type === "formula") continue;
    const resolution = resolveAttribute((state.fields[field.fieldId]?.candidates ?? []).map(asFactLike));
    values[field.fieldId] = resolution.value;
    meta[field.fieldId] = { state: resolution.state, factId: resolution.factId, sourceKind: resolution.sourceKind };
  }
  const lifecycle = state.lifecycle;
  return {
    values,
    meta,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    deletedAt: lifecycle.status === "active" ? null : lifecycle.at,
    mergedInto: lifecycle.status === "merged" ? lifecycle.into : null,
  };
}

/** The text a record is listed and searched by: its title field's value. */
export function titleOf(def: Pick<ResolvedObjectDef, "titleFieldId">, row: Pick<ProjectedRow, "values">): string {
  const value = row.values[def.titleFieldId];
  return value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
}

function asFactLike(fact: Fact): FactLike<FieldValue> {
  return {
    _id: fact.factId,
    attribute: fact.fieldId,
    value: fact.value,
    sourceKind: fact.sourceKind,
    sourceRef: fact.sourceRef,
    evidence: fact.evidence,
    confidence: fact.confidence,
    observedAt: fact.observedAt,
    validFrom: fact.validFrom,
    status: "accepted",
  };
}

export type WritePlan = {
  /** Values to append in one `assert` entry. */
  append: Assertion[];
  /** Fields the source re-observed unchanged: a `confirm` entry, or nothing. */
  confirm: FieldId[];
  /** The status the `assert` entry takes for this source. */
  status: "accepted" | "proposed";
};

/**
 * The write rule (docs/canoncrm-spec.md §facts) against the fold state: a value
 * becomes a new fact only if its value or evidence differs from the latest
 * value the same source record asserted, whether it was accepted, is pending
 * or was rejected.
 */
export function writeRule(state: FoldState | null, source: EntrySource, values: readonly Assertion[]): WritePlan {
  const append: Assertion[] = [];
  const confirm: FieldId[] = [];
  for (const incoming of values) {
    const field = state?.fields[incoming.fieldId] ?? EMPTY_FIELD;
    const latest = field.observed.find((o) => o.sourceKind === source.kind && o.sourceRef === source.ref);
    const unchanged = latest && sameValue(latest.value, incoming.value) && (latest.evidence ?? "") === (incoming.evidence ?? "");
    if (unchanged) confirm.push(incoming.fieldId);
    else append.push(incoming);
  }
  return { append, confirm, status: AUTO_ACCEPT.has(source.kind) ? "accepted" : "proposed" };
}
