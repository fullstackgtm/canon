// In-memory ports for tests: a record store with the 1.2.0 outbox semantics
// (origin, fieldUpdatedAt, seq never reused after reload), a patch-plan sink
// with an audit log, and a conflict sink. Test-only.
import type {
  ConflictInput,
  ConflictSink,
  EditOptions,
  LocalRecord,
  OutboundPatch,
  OutboxChange,
  PlanSink,
  RecordPort,
} from "../types.ts";

export type StoreSnapshot = { records: LocalRecord[]; outbox: OutboxChange[] };

export class FakeRecordStore implements RecordPort {
  records = new Map<string, LocalRecord>();
  outbox: OutboxChange[] = [];
  private nextSeq = 1;
  private seenKeys = new Set<string>();
  now: () => number;
  constructor(now: () => number = Date.now, snapshot?: StoreSnapshot) {
    this.now = now;
    if (snapshot) {
      for (const r of snapshot.records) this.records.set(`${r.object}:${r.id}`, structuredClone(r));
      this.outbox = structuredClone(snapshot.outbox);
      this.nextSeq = this.outbox.reduce((m, c) => Math.max(m, c.seq), 0) + 1;
    }
  }
  snapshot(): StoreSnapshot {
    return structuredClone({ records: [...this.records.values()], outbox: this.outbox });
  }
  seed(object: string, id: string, sfId: string, fields: Record<string, unknown>, at = 0) {
    const fieldUpdatedAt: Record<string, number> = {};
    for (const k of Object.keys(fields)) fieldUpdatedAt[k] = at;
    this.records.set(`${object}:${id}`, { id, object, sfId, fields: { ...fields }, fieldUpdatedAt, version: 1 });
  }
  /** An FSGTM user's edit (origin "fsgtm"). */
  userEdit(object: string, id: string, fields: Record<string, unknown>) {
    return this.apply(object, id, fields, "fsgtm", this.now());
  }
  private apply(object: string, id: string, fields: Record<string, unknown>, origin: string, at: number) {
    const r = this.records.get(`${object}:${id}`);
    if (!r) throw new Error(`no record ${object}:${id}`);
    for (const [k, v] of Object.entries(fields)) { r.fields[k] = v; r.fieldUpdatedAt[k] = at; }
    r.version++;
    this.outbox.push({ seq: this.nextSeq++, object, id, op: "edit", fields: Object.keys(fields), origin, at: this.now() });
    return r.version;
  }
  edits = 0;
  async changes(after: number, limit: number) {
    const changes = this.outbox.filter((c) => c.seq > after).slice(0, limit);
    return { changes, lastSeq: this.outbox.length ? this.outbox[this.outbox.length - 1].seq : 0 };
  }
  async get(object: string, id: string) {
    const r = this.records.get(`${object}:${id}`);
    return r ? structuredClone(r) : null;
  }
  async findBySfId(object: string, sfId: string) {
    for (const r of this.records.values()) if (r.object === object && r.sfId === sfId) return structuredClone(r);
    return null;
  }
  async edit(object: string, id: string, fields: Record<string, unknown>, opts: EditOptions) {
    if (this.seenKeys.has(opts.idempotencyKey)) return { version: this.records.get(`${object}:${id}`)!.version };
    this.seenKeys.add(opts.idempotencyKey);
    this.edits++;
    return { version: this.apply(object, id, fields, opts.source, opts.sourceTimestamp) };
  }
}

export type PlanRow = { patchPlanId: string; key: string; patch: OutboundPatch; status: "approved" | "applied" | "failed"; createdAt: number; appliedAt?: number; error?: string };
export type AuditRow = { patchPlanId: string; status: "applied" | "failed"; source: string; at: number };

export class MemoryPlanSink implements PlanSink {
  plans = new Map<string, PlanRow>();
  audit: AuditRow[] = [];
  now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  async begin(patch: OutboundPatch) {
    const existing = this.plans.get(patch.key);
    if (existing) return { patchPlanId: existing.patchPlanId, alreadyApplied: existing.status === "applied" };
    const patchPlanId = `pp_${this.plans.size + 1}`;
    this.plans.set(patch.key, { patchPlanId, key: patch.key, patch, status: "approved", createdAt: this.now() });
    return { patchPlanId, alreadyApplied: false };
  }
  async complete(patchPlanId: string, result: { ok: true } | { ok: false; error: string }) {
    const row = [...this.plans.values()].find((p) => p.patchPlanId === patchPlanId)!;
    row.status = result.ok ? "applied" : "failed";
    row.appliedAt = this.now();
    if (!result.ok) row.error = result.error;
    this.audit.push({ patchPlanId, status: row.status, source: "salesforce-sync", at: this.now() });
  }
}

export class MemoryConflictSink implements ConflictSink {
  open_: Map<string, ConflictInput & { status: "open" }> = new Map();
  async open(c: ConflictInput) {
    this.open_.set(`${c.recordId}:${c.field}`, { ...c, status: "open" });
  }
  list() { return [...this.open_.values()]; }
}
