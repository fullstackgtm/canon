// Salesforce shadow-sync engine: one tick = inbound (Salesforce -> FSGTM)
// then outbound (FSGTM outbox -> patch plan -> Salesforce).
//
// Delivery guarantees
//   Inbound: the cursor is saved after each batch has been fully applied. A
//   crash mid-batch replays the batch; replays compare equal and are no-ops.
//   Outbound: at-least-once. For every outbox batch the engine creates (or
//   finds, by deterministic key) a patch plan, applies it to Salesforce,
//   completes the plan with an audit entry, and only then saves the cursor.
//   Replays find the existing applied plan and skip the Salesforce write.
//
// Echo suppression
//   Inbound writes carry source "salesforce", so the outbox rows they produce
//   have origin "salesforce" and are skipped. Outbound writes come back as
//   CDC/poll events whose values equal FSGTM's, which the resolver treats as
//   a no-op.
import { resolveField } from "./resolver.ts";
import type {
  CdcSource,
  ConflictSink,
  FieldRule,
  LocalRecord,
  ObjectRule,
  OutboxChange,
  PlanSink,
  RecordPort,
  SfPort,
  SfRecord,
  SyncPolicy,
  SyncState,
  TickStats,
} from "./types.ts";

export const INBOUND_SOURCE = "salesforce";
export const OUTBOUND_SOURCE = "salesforce-sync";

export type EnginePorts = {
  records: RecordPort;
  sf: SfPort;
  cdc: CdcSource;
  plans: PlanSink;
  conflicts: ConflictSink;
  saveState: (state: SyncState) => Promise<void>;
  now?: () => number;
};

export type TickOptions = {
  /** Upper bound on batches per direction per tick (keeps a Convex action short). */
  maxBatches?: number;
  outboxBatchSize?: number;
};

/** Errors thrown by a SfPort with retryable=false are recorded and skipped; anything else stops the tick. */
export class SfWriteError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

export function emptyStats(): TickStats {
  return { inboundEvents: 0, inboundEdits: 0, outboundChanges: 0, outboundPatches: 0, skippedEcho: 0, conflicts: 0, errors: [] };
}

function objectBySf(policy: SyncPolicy, sfObject: string): ObjectRule | undefined {
  return policy.objects.find((o) => o.sf === sfObject);
}
function objectByLocal(policy: SyncPolicy, local: string, sfId?: string): ObjectRule | undefined {
  const candidates = policy.objects.filter((o) => o.local === local);
  if (sfId && candidates.length > 1) {
    const byPrefix = candidates.find((o) => o.keyPrefix && sfId.startsWith(o.keyPrefix));
    if (byPrefix) return byPrefix;
  }
  return candidates[0];
}

function stableKey(fields: Record<string, unknown>): string {
  const s = JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

// ───────────────────────────── inbound ─────────────────────────────

export async function runInbound(ports: EnginePorts, policy: SyncPolicy, state: SyncState, opts: TickOptions = {}, stats = emptyStats()) {
  const now = ports.now ?? Date.now;
  const maxBatches = opts.maxBatches ?? 20;
  for (let b = 0; b < maxBatches; b++) {
    const { events, cursor } = await ports.cdc.next(state.inboundCursor);
    if (events.length === 0) {
      if (JSON.stringify(cursor) !== JSON.stringify(state.inboundCursor)) {
        state.inboundCursor = cursor;
        await ports.saveState(state);
      }
      break;
    }
    for (const ev of events) {
      stats.inboundEvents++;
      const rule = objectBySf(policy, ev.sfObject);
      if (!rule) continue;
      if (ev.changeType === "DELETE") continue; // shadow phase: deletes are not mirrored
      for (const sfId of ev.sfIds) {
        const local = await ports.records.findBySfId(rule.local, sfId);
        if (!local) continue; // unmatched: creates are the import's job
        await applyInboundToRecord(ports, rule, local, ev.changedFields, ev.values, ev.commitTimestamp, stats);
      }
    }
    state.inboundCursor = cursor;
    state.lastInboundAt = now();
    await ports.saveState(state);
  }
  return stats;
}

async function applyInboundToRecord(
  ports: EnginePorts,
  rule: ObjectRule,
  local: LocalRecord,
  changedFields: string[],
  values: Record<string, unknown>,
  sfAt: number,
  stats: TickStats,
) {
  const patch: Record<string, unknown> = {};
  for (const f of rule.fields) {
    if (changedFields.length && !changedFields.includes(f.sf)) continue;
    if (!(f.sf in values)) continue;
    const d = resolveField({
      authority: f.authority,
      direction: "inbound",
      fsgtmValue: local.fields[f.local],
      fsgtmAt: local.fieldUpdatedAt[f.local],
      sfValue: values[f.sf],
      sfAt,
    });
    if (d.action === "apply") patch[f.local] = values[f.sf] ?? null;
    else if (d.action === "conflict") {
      stats.conflicts++;
      await ports.conflicts.open({
        object: rule.local,
        recordId: local.id,
        sfId: local.sfId ?? "",
        field: f.local,
        fsgtmValue: local.fields[f.local] ?? null,
        sfValue: values[f.sf] ?? null,
        fsgtmAt: local.fieldUpdatedAt[f.local] ?? 0,
        sfAt,
      });
    }
  }
  if (!Object.keys(patch).length) return;
  await ports.records.edit(rule.local, local.id, patch, {
    source: INBOUND_SOURCE,
    sourceTimestamp: sfAt,
    idempotencyKey: `sf-in:${rule.sf}:${local.sfId}:${sfAt}:${stableKey(patch)}`,
  });
  stats.inboundEdits++;
}

// ───────────────────────────── outbound ─────────────────────────────

type Pending = { change: OutboxChange; fields: Set<string> | null };

export async function runOutbound(ports: EnginePorts, policy: SyncPolicy, state: SyncState, opts: TickOptions = {}, stats = emptyStats()) {
  // Read-only: Salesforce sync is inbound only. The outbox cursor is held, so
  // turning read-only off pushes what accumulated (newest/review rules still
  // compare against Salesforce's current values first).
  if (state.readOnly) return stats;
  const now = ports.now ?? Date.now;
  const maxBatches = opts.maxBatches ?? 20;
  const size = opts.outboxBatchSize ?? 500;
  for (let b = 0; b < maxBatches; b++) {
    const { changes } = await ports.records.changes(state.outboxCursor, size);
    if (!changes.length) break;
    // Collapse to one entry per record (last seq wins, fields unioned).
    const byRecord = new Map<string, Pending>();
    for (const c of changes) {
      stats.outboundChanges++;
      if (c.origin === INBOUND_SOURCE) { stats.skippedEcho++; continue; }
      if (c.op !== "edit" && c.op !== "upsert") continue;
      if (!objectByLocal(policy, c.object)) continue;
      const key = `${c.object}:${c.id}`;
      const prev = byRecord.get(key);
      const fields = c.fields?.length ? new Set(c.fields) : null;
      if (!prev) byRecord.set(key, { change: c, fields });
      else {
        prev.change = c;
        prev.fields = prev.fields && fields ? new Set([...prev.fields, ...fields]) : null;
      }
    }
    await pushRecords(ports, policy, [...byRecord.values()], stats);
    state.outboxCursor = changes[changes.length - 1].seq;
    state.lastOutboundAt = now();
    await ports.saveState(state);
    if (changes.length < size) break;
  }
  return stats;
}

async function pushRecords(ports: EnginePorts, policy: SyncPolicy, pending: Pending[], stats: TickStats) {
  // Load local records, group by object for one Salesforce read per 200 ids.
  const loaded: Array<{ p: Pending; rec: LocalRecord; rule: ObjectRule }> = [];
  for (const p of pending) {
    const rec = await ports.records.get(p.change.object, p.change.id);
    if (!rec?.sfId) continue; // never synced to Salesforce: outbound creates are out of shadow scope
    const rule = objectByLocal(policy, p.change.object, rec.sfId)!;
    loaded.push({ p, rec, rule });
  }
  const sfValues = new Map<string, SfRecord>();
  const byObject = new Map<string, typeof loaded>();
  for (const l of loaded) byObject.set(l.rule.sf, [...(byObject.get(l.rule.sf) ?? []), l]);
  for (const [sfObject, list] of byObject) {
    const fields = [...new Set(list[0].rule.fields.filter(outboundEligible).map((f) => f.sf))];
    for (let i = 0; i < list.length; i += 200) {
      const ids = list.slice(i, i + 200).map((l) => l.rec.sfId!);
      const got = await ports.sf.fetch(sfObject, ids, fields);
      for (const [id, r] of got) sfValues.set(`${sfObject}:${id}`, r);
    }
  }
  for (const { p, rec, rule } of loaded) {
    const sfRec = sfValues.get(`${rule.sf}:${rec.sfId}`);
    if (!sfRec) { stats.errors.push(`missing in salesforce: ${rule.sf} ${rec.sfId}`); continue; }
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const f of rule.fields) {
      if (!outboundEligible(f)) continue;
      if (p.fields && !p.fields.has(f.local)) continue;
      const d = resolveField({
        authority: f.authority,
        direction: "outbound",
        fsgtmValue: rec.fields[f.local],
        fsgtmAt: rec.fieldUpdatedAt[f.local],
        sfValue: sfRec[f.sf],
        sfAt: sfRec.SystemModstamp,
      });
      if (d.action === "apply") { patch[f.sf] = rec.fields[f.local] ?? null; before[f.sf] = sfRec[f.sf] ?? null; }
      else if (d.action === "conflict") {
        stats.conflicts++;
        await ports.conflicts.open({
          object: rule.local, recordId: rec.id, sfId: rec.sfId!, field: f.local,
          fsgtmValue: rec.fields[f.local] ?? null, sfValue: sfRec[f.sf] ?? null,
          fsgtmAt: rec.fieldUpdatedAt[f.local] ?? 0, sfAt: sfRec.SystemModstamp,
        });
      }
    }
    if (!Object.keys(patch).length) continue;
    const plan = await ports.plans.begin({
      key: `sf-out:${p.change.seq}:${rec.id}`,
      object: rule.local, recordId: rec.id, sfObject: rule.sf, sfId: rec.sfId!,
      fields: patch, before, seq: p.change.seq,
    });
    if (plan.alreadyApplied) continue;
    try {
      await ports.sf.patch(rule.sf, rec.sfId!, patch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SfWriteError && !e.retryable) {
        await ports.plans.complete(plan.patchPlanId, { ok: false, error: msg });
        stats.errors.push(`${rule.sf} ${rec.sfId}: ${msg}`);
        continue;
      }
      throw e; // retryable: stop before the cursor moves; the plan is reused on replay
    }
    await ports.plans.complete(plan.patchPlanId, { ok: true });
    stats.outboundPatches++;
  }
}

function outboundEligible(f: FieldRule): boolean {
  return f.updateable !== false && f.authority !== "salesforce";
}

export async function runTick(ports: EnginePorts, policy: SyncPolicy, state: SyncState, opts: TickOptions = {}) {
  const stats = emptyStats();
  await runInbound(ports, policy, state, opts, stats);
  await runOutbound(ports, policy, state, opts, stats);
  return stats;
}
