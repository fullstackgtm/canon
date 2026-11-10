/**
 * Merge duplicate companies or people, and undo it (CP15a, docs/core-crm-parity.md).
 *
 * A merge keeps one record, the survivor, and merges the others (the losers) into it, in one transaction:
 *
 * 1. Every record without a stream is promoted onto the ledger first, from its register row.
 * 2. The survivor takes the values picked from the losers as one person's `assert` (mirrored into `facts`),
 *    then a `lifecycle absorb` entry that keeps every loser's values with their sources in its history.
 * 3. Each loser takes `lifecycle merge`, and its entity's `mergedInto` names the survivor: the projector hides
 *    its row, and the ledger's identity lookups (convex/canon.ts) route its domain, email, CRM and record ids to
 *    the survivor, so a later import or sync lands there. Its unique values stay claimed by it, as aliases.
 * 4. Edges to the losers get counterparts on the survivor (lib/objects/associations.ts repointEdges), and
 *    deals linked to a losing company link to the survivor.
 *
 * The undo snapshot it returns is enough to put everything back (unmergeParties): each picked field's fold
 * before and after, each edge's state before, each deal's company before. After an undo, every record has
 * the values, lifecycle, edges, deal links and identity routing it had before the merge; a field someone
 * changed after the merge keeps that change. History only grows.
 *
 * Pure apart from the stores: it runs in a Convex mutation (convex/recordMerges.ts) and in tests.
 */
import { foldAll, project, type FieldFold, type FoldState, type MergedRecord, type RevertedField } from "../objects/fold.ts";
import { repointEdges, restoreEdges, type EdgeContext, type EdgeStore, type TouchedEdge } from "../objects/associations.ts";
import { save, WRITE_FOLD_CAP, type SaveResult } from "../objects/write.ts";
import type { FieldValue, ResolvedObjectDef } from "../objects/registry.ts";
import { resolveAttribute } from "./policy.ts";
import { promoteRecord, writeParty, type PartyObject, type PartyStores, type RecordAccountSnapshot, type RecordContactSnapshot } from "./partyLedger.ts";

/** Records one merge takes: the survivor and at most eight others. */
export const MERGE_RECORDS_MAX = 9;

export interface MergeStores extends PartyStores {
  /** Edge streams, over the same object store. */
  edges: EdgeStore;
  /** Set or (null) clear the entity's `mergedInto`. */
  setMergedInto(entityId: string, into: string | null): Promise<void>;
  /** The deals linked to a register company by their `companyId` field. */
  dealsOfCompany(orgId: string, companyId: string): Promise<string[]>;
  /** Link a deal to another company, as this person's edit. `from` is checked first: a deal linked elsewhere since is left alone. */
  setDealCompany(dealId: string, from: string, to: string, userId: string): Promise<void>;
  /** Mark a `facts` row superseded, so it no longer resolves. */
  supersedeFact(factId: string): Promise<void>;
}

/** One register row in a merge: its record id, the row as it is now, and the stream it is linked to, if any. */
export type MergeParty = { recordId: string; streamId?: string; snapshot?: RecordAccountSnapshot | RecordContactSnapshot };

export type MergeCommand = {
  orgId: string;
  object: PartyObject;
  userId: string;
  now: number;
  mergeId: string;
  survivor: MergeParty;
  losers: readonly MergeParty[];
  /** Field (apiName) to the record whose value survives. A field not named keeps the survivor's value. */
  picks: Readonly<Record<string, string>>;
  /** Contacts whose company nobody has worked, with the company the register lists for them. */
  seeds: readonly { contactId: string; accountId: string }[];
  /** Activities naming a loser in their `accountId` or `contactId` lookup. */
  activityIds: readonly string[];
};

/** What an undo needs, stored with the merge (recordMerges.undo). */
export type MergeUndo = {
  version: 1;
  object: PartyObject;
  survivor: { recordId: string; streamId: string };
  losers: Array<{ recordId: string; streamId: string; title: string }>;
  /** The source ref of the picked values' `assert` (and its facts, `<ref>:<attribute>`). */
  pickRef: string;
  fields: Array<{ fieldId: string; before: FieldFold | null; after: FieldFold | null }>;
  edges: TouchedEdge[];
  deals: Array<{ dealId: string; companyId: string }>;
};

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

const labelOf = (object: PartyObject) => (object === "account" ? "company" : "person");

/** A record's fold state: its hot row, else a fold of its stream. */
async function stateOf(s: PartyStores, streamId: string): Promise<FoldState | null> {
  return (await s.objects.getHotRow(streamId)) ?? foldAll(await s.objects.readEntries(streamId, 0, WRITE_FOLD_CAP));
}

/** The fields a merge picks values for: every writable field except the unique ones (a domain or email stays the survivor's). */
export function mergeableFields(def: ResolvedObjectDef) {
  return def.fields.filter((f) => !f.system && f.type !== "formula" && !f.unique);
}

/** One record's value of one field in the merge dialog, with the source it came from and when it became true. */
export type MergeCell = { value: FieldValue; sourceKind: string | null; at: number | null };

/** Sources whose values a merge never prefers by default over a person's, a CRM's or an import's (lib/canon/gate.ts AGENT_SOURCES). */
const AGENT_KINDS: ReadonlySet<string> = new Set(["agent_run", "enrichment", "call", "email", "linkedin", "pipeline"]);

/**
 * The record whose value each field keeps by default: the most recent non-empty value, except that an
 * agent's value never wins over a person's, a CRM's or an import's. Ties go to the earlier record (the
 * survivor first). Returns field -> record id.
 */
export function defaultPicks(fields: readonly string[], records: ReadonlyArray<{ id: string; cells: Readonly<Record<string, MergeCell>> }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const filled = records.flatMap((r) => {
      const cell = r.cells[field];
      return cell && cell.value !== null && cell.value !== "" ? [{ id: r.id, cell }] : [];
    });
    const trusted = filled.filter((c) => !AGENT_KINDS.has(c.cell.sourceKind ?? ""));
    const pool = trusted.length ? trusted : filled;
    let best = pool[0];
    for (const c of pool) if ((c.cell.at ?? 0) > (best.cell.at ?? 0)) best = c;
    if (best) out[field] = best.id;
  }
  return out;
}

const fail = (r: SaveResult, what: string) => {
  if (r.status === "invalid") throw new MergeError(`${what}: ${r.errors.map((e) => e.message).join("; ")}`);
  if (r.status === "conflict") throw new MergeError(`${what}: the record changed; try again`);
};

export async function mergeParties(s: MergeStores, c: MergeCommand): Promise<MergeUndo> {
  const label = labelOf(c.object);
  const ids = [c.survivor.recordId, ...c.losers.map((l) => l.recordId)];
  if (c.losers.length < 1 || ids.length > MERGE_RECORDS_MAX) throw new MergeError(`Merge 2 to ${MERGE_RECORDS_MAX} records at a time`);
  if (new Set(ids).size !== ids.length) throw new MergeError(`Pick each ${label} once`);

  // 1. Every record onto the ledger: an unworked row is promoted from the row as it is now.
  const streams: string[] = [];
  for (const party of [c.survivor, ...c.losers]) {
    const { entityId, init } = await promoteRecord(s, { orgId: c.orgId, object: c.object, now: c.now, ...party });
    if (init.status === "deferred") throw new MergeError("This record's history is still being moved onto the ledger; try again in a moment");
    streams.push(entityId);
  }
  if (new Set(streams).size !== streams.length) throw new MergeError(`Two of these are already the same ${label}`);
  const [survivorStream, ...loserStreams] = streams;
  const def = await s.defWith(c.orgId, c.object, {});
  const states = await Promise.all(streams.map((id) => stateOf(s, id)));
  states.forEach((st, i) => {
    if (!st || st.lifecycle.status !== "active") throw new MergeError(`${ids[i]} is ${st?.lifecycle.status ?? "missing"}; only live records merge`);
  });
  const rows = states.map((st) => project(def, st!));
  const before = states[0]!;

  // 2. The survivor takes the picked values that differ from its own, as this person's edit.
  const values: Record<string, FieldValue> = {};
  const fieldIds: string[] = [];
  for (const [apiName, from] of Object.entries(c.picks)) {
    const field = def.byApiName.get(apiName);
    if (!field || !mergeableFields(def).includes(field)) throw new MergeError(`${apiName} is not picked in a merge`);
    const at = ids.indexOf(from);
    if (at < 0) throw new MergeError(`${from} is not in this merge`);
    const value = rows[at].values[field.fieldId] ?? null;
    if (JSON.stringify(value) === JSON.stringify(rows[0].values[field.fieldId] ?? null)) continue;
    values[apiName] = value;
    fieldIds.push(field.fieldId);
  }
  const pickKey = `merge:${c.mergeId}`;
  if (Object.keys(values).length) {
    const out = await writeParty(s, {
      orgId: c.orgId, object: c.object, streamId: survivorStream, now: c.now, values, source: { kind: "user", userId: c.userId, key: pickKey }, reassert: true,
    });
    if (out.rejected.length) throw new MergeError(`Not merged: ${out.rejected.map((e) => e.message).join("; ")}`);
  }
  const after = (await stateOf(s, survivorStream))!;

  const actor = { kind: "user" as const, id: c.userId };
  const ctx = { orgId: c.orgId, def, source: { kind: "user" as const, ref: `user:${c.userId}:${pickKey}` }, actor, now: c.now };
  const from: MergedRecord[] = loserStreams.map((streamId, i) => ({
    streamId, recordId: c.losers[i].recordId, title: String(rows[i + 1].values[def.titleFieldId] ?? ""),
    values: mergeableFields(def).flatMap((f) => {
      const value = rows[i + 1].values[f.fieldId] ?? null;
      return value === null ? [] : [{ fieldId: f.fieldId, value, sourceKind: rows[i + 1].meta[f.fieldId]?.sourceKind ?? null }];
    }),
  }));
  fail(await save(s.objects, ctx, { op: "absorb", streamId: survivorStream, mergeId: c.mergeId, from }), "Not merged");

  // 3. Each loser is merged into the survivor, and its identities name the survivor from now on.
  for (const streamId of loserStreams) {
    fail(await save(s.objects, ctx, { op: "merge", streamId, into: survivorStream }), "Not merged");
    await s.setMergedInto(streamId, survivorStream);
  }

  // 4. Edges and deal links move to the survivor.
  const edgeCtx: EdgeContext = { orgId: c.orgId, source: ctx.source, actor, now: c.now };
  const loserIds = c.losers.map((l) => l.recordId);
  const edges = await repointEdges(s.edges, edgeCtx, { object: c.object, survivorId: c.survivor.recordId, loserIds, seeds: c.seeds, activityIds: c.activityIds });
  const deals: MergeUndo["deals"] = [];
  if (c.object === "account") {
    for (const companyId of loserIds) {
      for (const dealId of await s.dealsOfCompany(c.orgId, companyId)) {
        await s.setDealCompany(dealId, companyId, c.survivor.recordId, c.userId);
        deals.push({ dealId, companyId });
      }
    }
  }

  return {
    version: 1, object: c.object,
    survivor: { recordId: c.survivor.recordId, streamId: survivorStream },
    losers: loserStreams.map((streamId, i) => ({ recordId: c.losers[i].recordId, streamId, title: from[i].title })),
    pickRef: `user:${c.userId}:${survivorStream}:${pickKey}`,
    fields: fieldIds.map((fieldId) => ({ fieldId, before: before.fields[fieldId] ?? null, after: after.fields[fieldId] ?? null })),
    edges, deals,
  };
}

/** JSON with sorted keys, so two copies of one fold compare equal whatever order a store kept their keys in. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
}

/**
 * Undo a merge from its snapshot. Each loser is restored and its identities are its own again; the
 * survivor's picked fields go back to their folds before the merge, except a field changed since, which keeps
 * the later change (returned in `kept`); edges and deal links go back. The merge's facts are superseded.
 */
export async function unmergeParties(
  s: MergeStores, a: { orgId: string; userId: string; now: number; mergeId: string; undo: MergeUndo },
): Promise<{ kept: string[] }> {
  const u = a.undo;
  const def = await s.defWith(a.orgId, u.object, {});
  const actor = { kind: "user" as const, id: a.userId };
  const ctx = { orgId: a.orgId, def, source: { kind: "user" as const, ref: `user:${a.userId}:unmerge:${a.mergeId}` }, actor, now: a.now };

  for (const loser of u.losers) {
    fail(await save(s.objects, ctx, { op: "unmerge", streamId: loser.streamId }), "Not undone");
    await s.setMergedInto(loser.streamId, null);
  }

  const now = await stateOf(s, u.survivor.streamId);
  if (!now) throw new MergeError("The surviving record is missing");
  // A field the survivor had no value for gets an accepted empty value back, not no fold at all: the register
  // leaves a field the ledger never resolved as the row has it, which would keep the merged-in value there.
  // A later value from any source still fills it (a newer value beats an older empty one).
  const cleared = (fieldId: string): FieldFold => ({
    candidates: [{
      factId: `${u.survivor.streamId}@unmerge:${a.mergeId}#${fieldId}`, fieldId: fieldId as RevertedField["fieldId"], value: null,
      sourceKind: "user", sourceRef: ctx.source.ref, observedAt: a.now, confidence: 1,
    }],
    pending: [], observed: [],
  });
  const kept: string[] = [];
  const fields: RevertedField[] = [];
  for (const f of u.fields) {
    if (stableJson(now.fields[f.fieldId] ?? null) !== stableJson(f.after)) kept.push(def.byFieldId.get(f.fieldId as never)?.apiName ?? f.fieldId);
    else fields.push({ fieldId: f.fieldId as RevertedField["fieldId"], fold: f.before ?? cleared(f.fieldId) });
  }
  if (fields.length) {
    fail(await save(s.objects, ctx, { op: "revert", streamId: u.survivor.streamId, mergeId: a.mergeId, fields }), "Not undone");
    // The `facts` mirror forgets the merge's values too, so the gate and receipts resolve as before.
    for (const { fieldId } of fields) {
      const fact = await s.facts.latestBySourceRef(a.orgId, `${u.pickRef}:${fieldId}`);
      if (!fact) continue;
      await s.supersedeFact(fact._id);
      const resolution = resolveAttribute(await s.facts.factsFor(u.survivor.streamId, fieldId));
      await s.facts.upsertFieldState({ entityId: u.survivor.streamId, attribute: fieldId, ...resolution, updatedAt: a.now });
    }
  }

  await restoreEdges(s.edges, { orgId: a.orgId, source: ctx.source, actor, now: a.now }, u.edges);
  for (const d of u.deals) await s.setDealCompany(d.dealId, u.survivor.recordId, d.companyId, a.userId);
  return { kept };
}
