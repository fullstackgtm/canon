/**
 * A save (docs/cp0-object-layer.md, "A save"): coerce, gate, load, CAS, write
 * rule, append one ledger entry with its shard `seq`, fold and project into
 * the hot row, and keep the proposal queue in step. Create, delete and restore
 * take the same path.
 *
 * Written against a small store interface so the same code runs in a Convex
 * mutation (convex/objects.ts) and in unit tests (an in-memory store).
 * Everything runs inside one transaction.
 */
import type { Decider } from "../canon/decider.ts";
import { AGENT_SOURCES } from "../canon/gate.ts";
import { claimFieldOf, uniqueIdentityProvider, uniqueValueIdentity } from "../canon/identity.ts";
import {
  fold, foldAll, project, SNAPSHOT_SOURCES, watermarkOf, writeRule,
  type Assertion, type Decision, type EntryActor, type EntryBody, type EntrySource, type FoldState, type LedgerEntry, type MergedRecord, type ProjectedRow, type RevertedField,
} from "./fold.ts";
import { coerce, PRIMARY_LISTS, ruleModeFor, type CoerceError, type FieldDef, type FieldValue, type ResolvedObjectDef } from "./registry.ts";

/**
 * Objects the public object API (convex/objects.ts) serves. Deals, accounts
 * and contacts are on the ledger too, but only through their own writers
 * (convex/canon.ts saveDeal and saveParty), which keep the `facts` mirror.
 */
export const LEDGER_OBJECTS = ["lead", "task", "note", "call", "meeting", "product", "lineItem"] as const;
export type LedgerObject = (typeof LEDGER_OBJECTS)[number];

export const SHARDS = 16;

/** External ids a converted history's identities are reconciled against: a record's CRM and record-service ids, its claims and its identities. */
export const EXTERNAL_IDS_MAX = 256;

/** Entries a save folds when a record has no hot row. Past it the save refuses rather than guess. */
export const WRITE_FOLD_CAP = 1000;

/** FNV-1a: stable across runtimes, so Convex and the record service agree on a stream's shard. */
export function shardOf(streamId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < streamId.length; i++) {
    h ^= streamId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}

export type StoredEntry = LedgerEntry & { object: string; shard: number; seq: number };

export type Proposal = { streamId: string; object: string; fieldId: string; factId: string; observedAt: number };

/** What every read path needs. */
export interface ObjectReader {
  /** The stream's org and object, or null when it does not exist. */
  getStream(streamId: string): Promise<{ orgId: string; object: string } | null>;
  /** The hot row's fold state. A hot row, when present, is always current: it is written with every entry. */
  getHotRow(streamId: string): Promise<FoldState | null>;
  /** Entries with version above `afterVersion`, ascending, at most `limit`. */
  readEntries(streamId: string, afterVersion: number, limit: number): Promise<LedgerEntry[]>;
}

export interface ObjectStore extends ObjectReader {
  /** `association`: an edge stream (associations.ts), created through `save` like any record. */
  createStream(orgId: string, object: LedgerObject | "association", label: string): Promise<string>;
  findByExternalId(orgId: string, provider: string, externalId: string): Promise<string | null>;
  addExternalId(orgId: string, streamId: string, provider: string, externalId: string): Promise<void>;
  removeExternalId(orgId: string, streamId: string, provider: string, externalId: string): Promise<void>;
  /** The first `limit` external ids a stream holds (canonExternalIds by_entityId). */
  externalIdsOf(streamId: string, limit: number): Promise<Array<{ provider: string; externalId: string }>>;
  /** Bump the (org, shard) head and return the new `seq`. */
  nextSeq(orgId: string, shard: number): Promise<number>;
  appendEntry(orgId: string, entry: StoredEntry): Promise<void>;
  putHotRow(orgId: string, def: ResolvedObjectDef, state: FoldState, row: ProjectedRow, now: number): Promise<void>;
  addProposal(orgId: string, p: Proposal): Promise<void>;
  removeProposal(orgId: string, factId: string): Promise<void>;
  /** The record a stream was merged into (canonEntities.mergedInto), or null. Absent: the store has no merges. */
  survivorOf?(streamId: string): Promise<string | null>;
  /** A record's name, to say who holds a unique value a save is refused for. Absent: the refusal names no one. */
  labelOf?(streamId: string): Promise<string | null>;
}

export type SaveContext = {
  orgId: string;
  def: ResolvedObjectDef;
  source: EntrySource;
  actor: EntryActor;
  now: number;
  /** Applied to every assertion of the save (agent proposals carry their evidence). */
  evidence?: string;
  confidence?: number;
  /**
   * Field ownership (lib/canon/gate.ts). Absent means every source owns every
   * field, which is the default for the objects served here.
   */
  mayWrite?: (fieldApiName: string) => boolean;
  /**
   * False for bulk import of `onDemand` objects: a record an import creates
   * gets no hot row. Any later change writes one, so a stream never grows
   * cold past its first entry and saves never fold a long history.
   */
  alwaysKeepHotRow?: boolean;
  /**
   * The person who ran an agent-class source (a work-email lookup) and accepts
   * its values as they land: its assert is accepted, not proposed.
   */
  acceptedBy?: Decider;
};

export type SaveCommand =
  | { op: "create"; values: Record<string, unknown>; externalId?: { provider: string; externalId: string }; createdAt?: number; validFrom?: number }
  /**
   * `partial`: a snapshot with fields left out for now; its time must not mark the snapshot as seen.
   * `reassert`: the source's values are appended even where it already said them, dated `validFrom`, so they win
   * as of then (a value its source is the authority for, or one a person chose in a conflict).
   */
  | { op: "update"; streamId: string; values: Record<string, unknown>; expectedVersion?: number; validFrom?: number; partial?: true; reassert?: true }
  | { op: "delete" | "restore"; streamId: string; expectedVersion?: number }
  /**
   * Accept or reject proposals. A decision names a pending fact, or carries a
   * fact the stream never held as pending (one decided in the `facts` gate
   * during migration); an accepted one still applies. Accepting a unique
   * value another record holds makes the whole save invalid.
   */
  | { op: "decide"; streamId: string; decisions: readonly Decision[]; expectedVersion?: number }
  /**
   * A merge (CP15a, lib/canon/partyMerge.ts): a record is merged into its survivor, or restored from that
   * (`unmerge`); the survivor records the records it took in (`absorb`) and, on undo, its fields as they were before (`revert`).
   */
  | { op: "merge"; streamId: string; into: string; expectedVersion?: number }
  | { op: "unmerge"; streamId: string; expectedVersion?: number }
  | { op: "absorb"; streamId: string; mergeId: string; from: readonly MergedRecord[]; expectedVersion?: number }
  | { op: "revert"; streamId: string; mergeId: string; fields: readonly RevertedField[]; expectedVersion?: number };

export type SaveResult =
  | { status: "applied" | "proposed"; streamId: string; version: number; shard: number; seq: number }
  | { status: "unchanged"; streamId: string; version: number }
  | { status: "conflict"; streamId: string; version: number; expectedVersion: number }
  | { status: "invalid"; errors: CoerceError[] };

export class StreamTooLongError extends Error {
  constructor(streamId: string) {
    super(`stream ${streamId} has no hot row and more than ${WRITE_FOLD_CAP} entries`);
    this.name = "StreamTooLongError";
  }
}

const isAgentSource = (ctx: SaveContext) => (AGENT_SOURCES as readonly string[]).includes(ctx.source.kind);
const invalid = (field: string, message: string): SaveResult => ({ status: "invalid", errors: [{ field, message }] });
/** A unique value another record holds: it may be released later, so a snapshot refused for it is not consumed. */
const taken = (field: string, message: string): SaveResult => ({ status: "invalid", errors: [{ field, message, retryable: true }] });

export async function save(store: ObjectStore, ctx: SaveContext, cmd: SaveCommand): Promise<SaveResult> {
  if (cmd.op === "create") return create(store, ctx, cmd);

  const stream = await store.getStream(cmd.streamId);
  if (!stream || stream.orgId !== ctx.orgId || stream.object !== ctx.def.apiName) return invalid("streamId", `${ctx.def.label} not found`);
  if (cmd.op !== "update" && isAgentSource(ctx)) return invalid("source", "Agent sources may only propose field values");

  let assertions: Assertion[] = [];
  if (cmd.op === "update") {
    const gated = coerceAndGate(ctx, cmd.values, "update", cmd.validFrom);
    if (!Array.isArray(gated)) return gated;
    assertions = await dropAliases(store, ctx, gated, cmd.streamId);
  }

  const hot = await store.getHotRow(cmd.streamId);
  const state = hot ?? (await foldStream(store, cmd.streamId));
  if (!state) return invalid("streamId", `${ctx.def.label} has no ledger entries`);
  if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== state.version) {
    return { status: "conflict", streamId: cmd.streamId, version: state.version, expectedVersion: cmd.expectedVersion };
  }
  const unchanged: SaveResult = { status: "unchanged", streamId: cmd.streamId, version: state.version };
  if (cmd.op === "update") assertions = primaryLists(ctx, project(ctx.def, state).values, assertions, state);

  if (cmd.op === "merge" || cmd.op === "unmerge" || cmd.op === "absorb" || cmd.op === "revert") {
    const status = state.lifecycle.status;
    if (cmd.op === "unmerge") {
      if (status === "active") return unchanged;
      if (status !== "merged") return invalid("streamId", `${ctx.def.label} is ${status}`);
      return append(store, ctx, state, { kind: "lifecycle", op: "restore" }, true, cmd.streamId);
    }
    if (status !== "active") return invalid("streamId", `${ctx.def.label} is ${status}`);
    if (cmd.op === "merge") {
      if (cmd.into === cmd.streamId) return invalid("into", "A record cannot be merged into itself");
      return append(store, ctx, state, { kind: "lifecycle", op: "merge", into: cmd.into }, true, cmd.streamId);
    }
    const body: EntryBody = cmd.op === "absorb"
      ? { kind: "lifecycle", op: "absorb", mergeId: cmd.mergeId, from: cmd.from }
      : { kind: "revert", mergeId: cmd.mergeId, fields: cmd.fields };
    return append(store, ctx, state, body, true, cmd.streamId);
  }

  if (cmd.op === "delete" || cmd.op === "restore") {
    const target = cmd.op === "delete" ? "deleted" : "active";
    if (state.lifecycle.status === target) return unchanged;
    if (state.lifecycle.status === "merged" || state.lifecycle.status === "erased") return invalid("streamId", `${ctx.def.label} was ${state.lifecycle.status}`);
    return append(store, ctx, state, { kind: "lifecycle", op: cmd.op }, true, cmd.streamId);
  }

  if (state.lifecycle.status !== "active") return invalid("streamId", `${ctx.def.label} is ${state.lifecycle.status}; restore it first`);
  if (cmd.op === "decide") {
    const open = cmd.decisions.filter((d) => isOpen(state, d));
    if (!open.length) return unchanged;
    // An accepted value is held to the same unique claims as a written one.
    const accepted = open.filter((d) => d.status === "accepted").map((d): Assertion => ({ fieldId: d.fact.fieldId, value: d.fact.value }));
    const taken = await uniqueConflicts(store, ctx, accepted, cmd.streamId);
    if (taken) return taken;
    return append(store, ctx, state, { kind: "decide", decisions: open }, true, cmd.streamId);
  }
  // A snapshot time orders a source's snapshots of a record. A person's or an agent's validFrom dates a patch, not a snapshot.
  const snapshotAt = cmd.op === "update" && SNAPSHOT_SOURCES.includes(ctx.source.kind) ? cmd.validFrom : undefined;
  const watermark = watermarkOf(state, ctx.source);
  if (snapshotAt !== undefined && watermark !== undefined && watermark >= snapshotAt) return unchanged;
  const ruled = { ...writeRule(state, ctx.source, assertions), ...(ctx.acceptedBy ? { status: "accepted" as const } : {}) };
  const plan = cmd.op === "update" && cmd.reassert ? { ...ruled, append: assertions, confirm: [] } : ruled;
  const taken = await uniqueConflicts(store, ctx, plan.append, cmd.streamId);
  if (taken) return taken;
  if (!plan.append.length) {
    // A newer snapshot that changed nothing still moves the watermark, so an older one cannot land after it.
    if (snapshotAt === undefined || (cmd.op === "update" && cmd.partial)) return unchanged;
    return append(store, ctx, state, { kind: "confirm", fieldIds: plan.confirm, validFrom: snapshotAt }, true, cmd.streamId);
  }
  return append(store, ctx, state, { kind: "assert", status: plan.status, assertions: plan.append, ...(cmd.op === "update" && cmd.partial ? { partial: true as const } : {}) }, true, cmd.streamId);
}

/** A decision still to apply: its fact is pending, or accepted here and not yet a candidate. */
function isOpen(state: FoldState, d: Decision): boolean {
  const field = state.fields[d.fact.fieldId];
  if (field?.pending.some((p) => p.factId === d.fact.factId)) return true;
  return d.status === "accepted" && !field?.candidates.some((c) => c.factId === d.fact.factId);
}

/**
 * Unique fields (registry `unique`) are claimed as external ids under
 * `unique:<object>.<fieldId>`, so a claim is one indexed lookup and two saves
 * racing for one value conflict in Convex and one retries. A deleted record
 * keeps its claims, so restoring it cannot collide. A list field's values are
 * claimed one by one, and a person's other emails share their primary's claims
 * (identity.ts claimFieldOf): one address belongs to one person.
 */
const uniqueProvider = (def: ResolvedObjectDef, fieldId: string) => `unique:${def.apiName}.${claimFieldOf(def.apiName, fieldId)}`;
const uniqueKey = (value: FieldValue) => (typeof value === "string" ? value.trim().toLowerCase() : JSON.stringify(value));
/** A unique value's claim key. An email or domain uses its identity's normalization, so spellings of one domain share one claim. */
const claimKey = (def: ResolvedObjectDef, fieldId: string, value: FieldValue) => uniqueValueIdentity(def.apiName, fieldId, value)?.externalId ?? uniqueKey(value);
/** A unique field's values one by one: a list field's items, else the value itself. */
const itemsOf = (value: FieldValue | undefined): FieldValue[] => (value === null || value === undefined ? [] : Array.isArray(value) ? [...value] : [value]);

/** What a claim check reads: claims and identities, and the holder's name when the store knows it. */
type ClaimReader = Pick<ObjectStore, "findByExternalId"> & Partial<Pick<ObjectStore, "labelOf">>;

async function uniqueConflicts(store: ClaimReader, ctx: Pick<SaveContext, "orgId" | "def">, assertions: readonly Assertion[], streamId: string | null): Promise<SaveResult | null> {
  for (const a of assertions) {
    if (!ctx.def.byFieldId.get(a.fieldId)?.unique) continue;
    for (const item of itemsOf(a.value)) {
      const holder = await heldElsewhere(store, ctx, a.fieldId, item, streamId);
      if (holder) return takenValue(store, ctx.def, a.fieldId, item, holder);
    }
  }
  return null;
}

/**
 * The record other than `streamId` that holds a unique value, or null: its
 * claim, or, for a value that is an identity (a contact's email, an account's
 * domain), its identity mapping. A record with Canon identity and no stream
 * holds no claim yet, but its email or domain still names it; taking the value
 * would make two people one. The same record reached from its CRM row and its
 * TAM twin is one entity, so it never conflicts with itself.
 */
async function heldElsewhere(store: Pick<ObjectStore, "findByExternalId">, ctx: Pick<SaveContext, "orgId" | "def">, fieldId: Assertion["fieldId"], value: FieldValue, streamId: string | null): Promise<string | null> {
  const claim = await store.findByExternalId(ctx.orgId, uniqueProvider(ctx.def, fieldId), claimKey(ctx.def, fieldId, value));
  if (claim !== null && claim !== streamId) return claim;
  const identity = uniqueValueIdentity(ctx.def.apiName, fieldId, value);
  const named = identity && (await store.findByExternalId(ctx.orgId, identity.provider, identity.externalId));
  return named && named !== streamId ? named : null;
}

/** How many merges deep a record's survivor is looked for: a chain of merges is short. */
const MERGE_DEPTH_MAX = 8;

/** Whether `from` was merged into `to`, directly or through records merged in turn (canonEntities.mergedInto). */
export async function mergedInto(store: Pick<ObjectStore, "survivorOf">, from: string, to: string): Promise<boolean> {
  if (!store.survivorOf) return false;
  let current = from;
  for (let depth = 0; depth < MERGE_DEPTH_MAX; depth++) {
    const next = await store.survivorOf(current);
    if (next === null) return false;
    if (next === to) return true;
    current = next;
  }
  return false;
}

/**
 * Leave out unique values (a domain, an email) that a record merged into this one holds. Such a value is an
 * alias of this record (CP15a): a CSV row or CRM sync that names it is routed here by its identity, and the
 * rest of what it says lands; the record keeps its own domain or email, and the alias stays claimed by the
 * merged record, so nothing else can take it. A list keeps its other items.
 */
async function dropAliases(store: Pick<ObjectStore, "findByExternalId" | "survivorOf">, ctx: Pick<SaveContext, "orgId" | "def">, assertions: Assertion[], streamId: string): Promise<Assertion[]> {
  if (!store.survivorOf) return assertions;
  const isAlias = async (fieldId: Assertion["fieldId"], item: FieldValue) => {
    const holder = await store.findByExternalId(ctx.orgId, uniqueProvider(ctx.def, fieldId), claimKey(ctx.def, fieldId, item));
    return holder !== null && holder !== streamId && (await mergedInto(store, holder, streamId));
  };
  const out: Assertion[] = [];
  for (const a of assertions) {
    if (a.value === null || !ctx.def.byFieldId.get(a.fieldId)?.unique) {
      out.push(a);
      continue;
    }
    if (!Array.isArray(a.value)) {
      if (!(await isAlias(a.fieldId, a.value))) out.push(a);
      continue;
    }
    const kept: string[] = [];
    for (const item of a.value as readonly string[]) if (!(await isAlias(a.fieldId, item))) kept.push(item);
    if (kept.length) out.push(kept.length === a.value.length ? a : { ...a, value: kept });
  }
  return out;
}

const takenValue = async (store: Partial<Pick<ObjectStore, "labelOf">>, def: ResolvedObjectDef, fieldId: Assertion["fieldId"], value: FieldValue, holder: string): Promise<SaveResult> => {
  const field = def.byFieldId.get(fieldId)!;
  // A person's other email reads as an email, as the claim it shares with their primary.
  const label = def.byFieldId.get(claimFieldOf(def.apiName, fieldId) as Assertion["fieldId"])?.label ?? field.label;
  const name = store.labelOf ? await store.labelOf(holder) : null;
  return taken(field.apiName, `${label} ${JSON.stringify(value)} is already used by another ${def.label.toLowerCase()}${name ? `: ${name}` : ""}`);
};

/**
 * Keep a primary and its other values (registry PRIMARY_LISTS) one list. A
 * write that names one of the record's other values as its primary, saying
 * nothing of the others, makes it primary and moves the old primary into the
 * others; from an import (a CSV row matched by that value) it is a match, not a
 * change, so the primary stays. The others never repeat the primary. A
 * primary the source already said (a CRM snapshot repeating its own value)
 * appends nothing (fold.ts writeRule), so it moves nothing either: the two
 * fields always change together, from one source, in one entry.
 */
function primaryLists(ctx: Pick<SaveContext, "def" | "source" | "mayWrite">, current: Readonly<Record<string, FieldValue>> | null, assertions: Assertion[], state?: FoldState): Assertion[] {
  const pairs = PRIMARY_LISTS[ctx.def.apiName];
  if (!pairs) return assertions;
  const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
  let out = assertions;
  for (const pair of pairs) {
    const p: FieldDef | undefined = ctx.def.byApiName.get(pair.primary);
    const o: FieldDef | undefined = ctx.def.byApiName.get(pair.others);
    if (!p || !o) continue;
    const pa = out.find((a) => a.fieldId === p.fieldId);
    const oa = out.find((a) => a.fieldId === o.fieldId);
    const curP = current?.[p.fieldId] ?? null;
    const curO = current?.[o.fieldId];
    const appends = (a: Assertion) => !state || writeRule(state, ctx.source, [a]).append.length > 0;
    if (pa && !oa && Array.isArray(curO) && curO.some((x) => same(x, pa.value)) && !same(pa.value, curP) && appends(pa)) {
      // A source that may not write the others (field ownership) cannot move the list either: its write is a match.
      if (ctx.source.kind === "import" || (ctx.mayWrite && !ctx.mayWrite(o.apiName))) {
        out = out.filter((a) => a !== pa);
        continue;
      }
      // The old primary joins the list in the list's own form (emails lowercased, registry.ts parseMultiValue).
      const moved = typeof curP === "string" && curP.trim() ? [o.type === "emails" ? curP.trim().toLowerCase() : curP.trim()] : [];
      const rest = [...moved, ...(curO as readonly string[]).filter((x) => !same(x, pa.value))];
      out = [...out, { ...pa, fieldId: o.fieldId, value: rest.length ? rest : null }];
      continue;
    }
    if (oa && Array.isArray(oa.value)) {
      const primary = pa ? pa.value : curP;
      const kept = (oa.value as readonly string[]).filter((x) => !same(x, primary));
      if (kept.length !== oa.value.length) out = out.map((a) => (a === oa ? { ...a, value: kept.length ? kept : null } : a));
    }
  }
  return out;
}

/**
 * The same change to many records of one object (a list view's bulk edit,
 * delete or restore), each through `save`. Records reached once
 * `overBudget()` is true come back `unprocessed`, to send again.
 */
export async function saveBatch<T extends string>(
  store: ObjectStore,
  ctx: SaveContext,
  change: { op: "update"; values: Record<string, unknown> } | { op: "delete" | "restore" },
  streamIds: readonly T[],
  overBudget: () => boolean,
): Promise<{ results: Array<{ streamId: T; result: SaveResult }>; unprocessed: T[] }> {
  const results: Array<{ streamId: T; result: SaveResult }> = [];
  const unprocessed: T[] = [];
  for (const streamId of new Set(streamIds)) {
    if (overBudget()) {
      unprocessed.push(streamId);
      continue;
    }
    const cmd: SaveCommand = change.op === "update" ? { op: "update", streamId, values: change.values } : { op: change.op, streamId };
    results.push({ streamId, result: await save(store, ctx, cmd) });
  }
  return { results, unprocessed };
}

/**
 * The checks an update's values must pass before anything is appended: the
 * registry's coercion, field ownership (`mayWrite`) and unique claims, as
 * `save` runs them. A caller that writes another store first (records.edit
 * writes the record service) runs these beforehand, so a value the ledger
 * would refuse is refused everywhere. `streamId` is null for a record with no
 * stream yet. Empty when the update would be accepted.
 */
export async function checkUpdate(
  store: ClaimReader,
  ctx: Pick<SaveContext, "orgId" | "def" | "source" | "mayWrite">,
  values: Record<string, unknown>,
  streamId: string | null,
): Promise<CoerceError[]> {
  const gated = coerceAndGate(ctx, values, "update", undefined);
  if (!Array.isArray(gated)) return gated.status === "invalid" ? gated.errors : [];
  const taken = await uniqueConflicts(store, ctx, gated, streamId);
  return taken?.status === "invalid" ? taken.errors : [];
}

/** The unique claims values would collide with: each value another record than `streamId` holds. */
export async function checkUnique(
  store: ClaimReader, ctx: Pick<SaveContext, "orgId" | "def">, values: readonly Assertion[], streamId: string,
): Promise<CoerceError[]> {
  const taken = await uniqueConflicts(store, ctx, values, streamId);
  return taken?.status === "invalid" ? taken.errors : [];
}

/**
 * The unique values a projected row shows, by claim provider and claim key: a
 * list field's items one by one, and a person's primary and other emails in one
 * set (they share claims), so moving an address between them claims nothing anew.
 */
function claimedValues(def: ResolvedObjectDef, row: ProjectedRow | null): Map<string, Map<string, { fieldId: Assertion["fieldId"]; value: FieldValue }>> {
  const out = new Map<string, Map<string, { fieldId: Assertion["fieldId"]; value: FieldValue }>>();
  for (const field of def.fields) {
    if (!field.unique) continue;
    const provider = uniqueProvider(def, field.fieldId);
    const keys = out.get(provider) ?? new Map<string, { fieldId: Assertion["fieldId"]; value: FieldValue }>();
    out.set(provider, keys);
    for (const value of itemsOf(row?.values[field.fieldId])) {
      const key = claimKey(def, field.fieldId, value);
      if (!keys.has(key)) keys.set(key, { fieldId: field.fieldId, value });
    }
  }
  return out;
}

/**
 * Move each unique field's claims from the values the record showed to the
 * values it shows now. A value is claimed once. A value that is also an
 * identity (identity.ts uniqueValueIdentity) moves with its claim: released
 * with it, and linked to this record when it claims it. A save never gets here
 * with an identity another record holds (heldElsewhere refuses it); only a
 * history converted whole (appendHistory) can take one, and that is logged.
 */
async function syncUniqueClaims(store: ObjectStore, ctx: Pick<SaveContext, "orgId" | "def">, streamId: string, before: ProjectedRow | null, after: ProjectedRow) {
  const was = claimedValues(ctx.def, before);
  for (const [provider, now] of claimedValues(ctx.def, after)) {
    const had = was.get(provider) ?? new Map<string, { fieldId: Assertion["fieldId"]; value: FieldValue }>();
    for (const [key, { fieldId, value }] of had) {
      if (now.has(key)) continue;
      await store.removeExternalId(ctx.orgId, streamId, provider, key);
      const released = uniqueValueIdentity(ctx.def.apiName, fieldId, value);
      if (released) await store.removeExternalId(ctx.orgId, streamId, released.provider, released.externalId);
    }
    for (const [key, { fieldId, value }] of now) {
      if (had.has(key)) continue;
      const apiName = ctx.def.byFieldId.get(fieldId)?.apiName ?? fieldId;
      // A history converted whole (appendHistory) can show a value another record holds; its claim and identity stay with that record.
      const holder = await store.findByExternalId(ctx.orgId, provider, key);
      if (holder !== null && holder !== streamId) {
        console.warn(`${ctx.def.apiName} ${streamId}: ${apiName} ${JSON.stringify(value)} is claimed by ${holder}; not claimed twice`);
        continue;
      }
      if (holder === null) await store.addExternalId(ctx.orgId, streamId, provider, key);
      const identity = uniqueValueIdentity(ctx.def.apiName, fieldId, value);
      const named = identity && (await store.findByExternalId(ctx.orgId, identity.provider, identity.externalId));
      if (!identity || named === streamId) continue;
      if (named) {
        console.warn(`${ctx.def.apiName} ${streamId}: ${apiName} ${JSON.stringify(value)} named ${named}; its converted history takes that identity`);
        await store.removeExternalId(ctx.orgId, named, identity.provider, identity.externalId);
      }
      await store.addExternalId(ctx.orgId, streamId, identity.provider, identity.externalId);
    }
  }
}

async function create(store: ObjectStore, ctx: SaveContext, cmd: Extract<SaveCommand, { op: "create" }>): Promise<SaveResult> {
  if (isAgentSource(ctx)) return invalid("source", "Agent sources may only propose values on existing records");
  const gated = coerceAndGate(ctx, cmd.values, "create", cmd.validFrom);
  if (!Array.isArray(gated)) return gated;
  // Emptying a field that was never set is not a change.
  const assertions = primaryLists(ctx, null, gated).filter((a) => a.value !== null);
  const taken = await uniqueConflicts(store, ctx, assertions, null);
  if (taken) return taken;

  const title = assertions.find((a) => a.fieldId === ctx.def.titleFieldId)?.value;
  const streamId = await store.createStream(ctx.orgId, ctx.def.apiName as LedgerObject | "association", typeof title === "string" ? title : "");
  if (cmd.externalId) await store.addExternalId(ctx.orgId, streamId, cmd.externalId.provider, cmd.externalId.externalId);
  const body: EntryBody = assertions.length
    ? { kind: "assert", status: "accepted", assertions, ...(cmd.createdAt !== undefined ? { createdAt: cmd.createdAt } : {}) }
    : { kind: "lifecycle", op: "create" };
  return append(store, ctx, null, body, ctx.alwaysKeepHotRow !== false, streamId);
}

function coerceAndGate(ctx: Pick<SaveContext, "def" | "source" | "mayWrite" | "confidence" | "evidence"> & { now?: number }, values: Record<string, unknown>, mode: "create" | "update", validFrom: number | undefined): Assertion[] | SaveResult {
  const coerced = coerce(ctx.def, values, { mode, rules: ruleModeFor(ctx.source.kind), ...(ctx.now !== undefined ? { now: ctx.now } : {}) });
  if (!coerced.ok) return { status: "invalid", errors: coerced.errors };
  const denied = Object.keys(values).filter((apiName) => ctx.mayWrite && !ctx.mayWrite(apiName));
  if (denied.length) return { status: "invalid", errors: denied.map((field) => ({ field, message: `${ctx.source.kind} may not write ${field}` })) };
  return coerced.values.map((c) => ({
    fieldId: c.fieldId,
    value: c.value,
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(ctx.confidence !== undefined ? { confidence: ctx.confidence } : {}),
    ...(ctx.evidence !== undefined ? { evidence: ctx.evidence } : {}),
  }));
}

async function append(
  store: ObjectStore,
  ctx: SaveContext,
  before: FoldState | null,
  body: EntryBody,
  keepHotRow: boolean,
  streamId: string,
): Promise<SaveResult> {
  const shard = shardOf(streamId);
  const draft: StoredEntry = {
    streamId, version: (before?.version ?? 0) + 1, observedAt: ctx.now, source: ctx.source, actor: ctx.actor, body,
    object: ctx.def.apiName, shard, seq: 0,
  };
  const after = fold(before, draft);
  const row = project(ctx.def, after);
  // The value a record resolves to can differ from what was written (a decision can restore a higher-ranked value),
  // so uniqueness is checked on the projection before anything is stored.
  const taken = await projectedConflicts(store, ctx, streamId, before && project(ctx.def, before), row);
  if (taken) return taken;
  const entry: StoredEntry = { ...draft, seq: await store.nextSeq(ctx.orgId, shard) };
  await store.appendEntry(ctx.orgId, entry);
  if (keepHotRow) await store.putHotRow(ctx.orgId, ctx.def, after, row, ctx.now);
  await syncUniqueClaims(store, ctx, streamId, before && project(ctx.def, before), row);
  await syncProposals(store, ctx, before, after);
  const status = body.kind === "assert" && body.status === "proposed" ? "proposed" : "applied";
  return { status, streamId, version: entry.version, shard, seq: entry.seq };
}

/** A unique value the write would newly show that another record holds. */
async function projectedConflicts(store: ObjectStore, ctx: Pick<SaveContext, "orgId" | "def">, streamId: string, before: ProjectedRow | null, after: ProjectedRow): Promise<SaveResult | null> {
  const was = claimedValues(ctx.def, before);
  for (const [provider, now] of claimedValues(ctx.def, after)) {
    for (const [key, { fieldId, value }] of now) {
      if (was.get(provider)?.has(key)) continue;
      const holder = await heldElsewhere(store, ctx, fieldId, value, streamId);
      if (holder) return takenValue(store, ctx.def, fieldId, value, holder);
    }
  }
  return null;
}

/** Add queue rows for new pending facts and drop rows for facts no longer pending (decided or trimmed). */
async function syncProposals(store: ObjectStore, ctx: Pick<SaveContext, "orgId" | "def">, before: FoldState | null, after: FoldState) {
  for (const fieldId of new Set([...Object.keys(before?.fields ?? {}), ...Object.keys(after.fields)])) {
    const was = before?.fields[fieldId]?.pending ?? [];
    const now = after.fields[fieldId]?.pending ?? [];
    if (was === now) continue;
    const wasIds = new Set(was.map((f) => f.factId));
    const nowIds = new Set(now.map((f) => f.factId));
    for (const f of was) if (!nowIds.has(f.factId)) await store.removeProposal(ctx.orgId, f.factId);
    for (const f of now) {
      if (!wasIds.has(f.factId)) {
        await store.addProposal(ctx.orgId, { streamId: after.streamId, object: ctx.def.apiName, fieldId: f.fieldId, factId: f.factId, observedAt: f.observedAt });
      }
    }
  }
}

/**
 * Append entries built elsewhere (a backfill converting the `facts` ledger)
 * to a stream whose identity exists, then write its hot row and proposal
 * queue once. Versions must continue the stream; a gap throws.
 */
export async function appendHistory(
  store: ObjectStore,
  ctx: Pick<SaveContext, "orgId" | "def" | "now">,
  streamId: string,
  entries: readonly LedgerEntry[],
): Promise<FoldState | null> {
  const before = (await store.getHotRow(streamId)) ?? (await foldStream(store, streamId));
  let after = before;
  for (const e of entries) {
    const shard = shardOf(streamId);
    const stored: StoredEntry = { ...e, streamId, object: ctx.def.apiName, shard, seq: await store.nextSeq(ctx.orgId, shard) };
    after = fold(after, stored);
    await store.appendEntry(ctx.orgId, stored);
  }
  if (!after || after === before) return after;
  const row = project(ctx.def, after);
  await store.putHotRow(ctx.orgId, ctx.def, after, row, ctx.now);
  await syncUniqueClaims(store, ctx, streamId, before && project(ctx.def, before), row);
  await releaseStaleIdentities(store, ctx, streamId, after, row);
  await syncProposals(store, ctx, before, after);
  return after;
}

/**
 * After a history is converted whole, drop the identities (an email, a
 * domain) the record was found by that its history no longer shows. A record
 * can be identified by a value before it has a stream, and syncUniqueClaims
 * only releases values a projection showed. A field the history never
 * mentions keeps its identities: they are all the record has.
 */
async function releaseStaleIdentities(store: ObjectStore, ctx: Pick<SaveContext, "orgId" | "def">, streamId: string, state: FoldState, row: ProjectedRow) {
  const fields = ctx.def.fields.filter((f) => f.unique && uniqueIdentityProvider(ctx.def.apiName, f.fieldId) && state.fields[f.fieldId]?.candidates.length);
  if (!fields.length) return;
  const held = await store.externalIdsOf(streamId, EXTERNAL_IDS_MAX);
  for (const provider of new Set(fields.map((f) => uniqueIdentityProvider(ctx.def.apiName, f.fieldId)))) {
    // Every value the record shows under this identity stays: a person's other emails as well as their primary.
    const keep = new Set(ctx.def.fields.filter((f) => f.unique && uniqueIdentityProvider(ctx.def.apiName, f.fieldId) === provider)
      .flatMap((f) => itemsOf(row.values[f.fieldId]).flatMap((v) => uniqueValueIdentity(ctx.def.apiName, f.fieldId, v)?.externalId ?? [])));
    for (const id of held) {
      if (id.provider === provider && !keep.has(id.externalId)) await store.removeExternalId(ctx.orgId, streamId, id.provider, id.externalId);
    }
  }
}

export async function foldStream(store: ObjectReader, streamId: string): Promise<FoldState | null> {
  const entries = await store.readEntries(streamId, 0, WRITE_FOLD_CAP + 1);
  if (entries.length > WRITE_FOLD_CAP) throw new StreamTooLongError(streamId);
  return foldAll(entries);
}

export type Materialized = { state: FoldState; hot: boolean; complete: boolean };

/**
 * A record for reading: its hot row, else a fold of at most `cap` entries. A
 * longer stream comes back folded to version `cap` and marked incomplete, so
 * one page of ids cannot read an unbounded number of entries.
 */
export async function materialize(store: ObjectReader, streamId: string, cap: number): Promise<Materialized | null> {
  const hot = await store.getHotRow(streamId);
  if (hot) return { state: hot, hot: true, complete: true };
  const entries = await store.readEntries(streamId, 0, cap + 1);
  const state = foldAll(entries.slice(0, cap));
  return state ? { state, hot: false, complete: entries.length <= cap } : null;
}
