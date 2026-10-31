// Salesforce two-way shadow sync: shared types and ports.
//
// The engine is pure TypeScript with injected ports so the same code runs in a
// Convex action (HTTP ports), in tests (in-process fakes) and against the
// Salesforce simulator. Nothing here imports Convex or Node built-ins.

/** Who wins a field when both sides have a value (docs/crm-system-of-record.md §4). */
export type SyncAuthority = "fsgtm" | "salesforce" | "newest" | "review";

export type FieldRule = {
  /** Field name in the record service (AccountRow key, or the custom field api name). */
  local: string;
  /** Salesforce field api name. */
  sf: string;
  authority: SyncAuthority;
  /** Salesforce says the field is updateable. Non-updateable fields never go outbound. */
  updateable?: boolean;
};

export type ObjectRule = {
  /** Record-service object: "account" | "contact" | a custom object api name. */
  local: string;
  /** Salesforce sObject api name. */
  sf: string;
  /** 3-char Salesforce id prefix (001 Account, 003 Contact, 00Q Lead). Disambiguates objects sharing a local home. */
  keyPrefix?: string;
  fields: FieldRule[];
};

export type SyncPolicy = { objects: ObjectRule[] };

/** One row of GET /changes (record-service contract 1.2.0). */
export type OutboxChange = {
  seq: number;
  object: string;
  id: string;
  op: string;
  fields: string[];
  origin: string;
  at: number;
};

export type LocalRecord = {
  id: string;
  object: string;
  sfId?: string;
  fields: Record<string, unknown>;
  /** epoch ms of the last write per field. */
  fieldUpdatedAt: Record<string, number>;
  version: number;
};

export type EditOptions = {
  source: string;
  sourceTimestamp: number;
  idempotencyKey: string;
  expectedVersion?: number;
};

export interface RecordPort {
  changes(after: number, limit: number): Promise<{ changes: OutboxChange[]; lastSeq: number }>;
  get(object: string, id: string): Promise<LocalRecord | null>;
  findBySfId(object: string, sfId: string): Promise<LocalRecord | null>;
  edit(object: string, id: string, fields: Record<string, unknown>, opts: EditOptions): Promise<{ version: number }>;
}

export type SfRecord = { Id: string; SystemModstamp: number; [field: string]: unknown };

export interface SfPort {
  /** Current values of `fields` (plus Id and SystemModstamp) for the given ids. */
  fetch(sfObject: string, sfIds: string[], fields: string[]): Promise<Map<string, SfRecord>>;
  /** The only Salesforce write the engine performs. */
  patch(sfObject: string, sfId: string, fields: Record<string, unknown>): Promise<void>;
}

/** A ChangeEventHeader-shaped event, flattened. */
export type CdcEvent = {
  sfObject: string;
  sfIds: string[];
  changeType: string;
  /** Changed Salesforce field api names. Empty means "unknown, compare every mapped field". */
  changedFields: string[];
  /** epoch ms when Salesforce committed the change. */
  commitTimestamp: number;
  /** New values of the changed fields (CDC), or every polled field (polling). */
  values: Record<string, unknown>;
  changeOrigin?: string;
};

export type InboundCursor = {
  replayId?: string;
  modstampByObject: Record<string, number>;
  /** Polling keyset tiebreak: last Id read at modstampByObject[object]. */
  lastIdByObject?: Record<string, string>;
};

export interface CdcSource {
  readonly kind: "cdc" | "poll";
  next(cursor: InboundCursor): Promise<{ events: CdcEvent[]; cursor: InboundCursor }>;
}

export type OutboundPatch = {
  /** Deterministic: one plan per (outbox seq, record). Replays reuse it. */
  key: string;
  object: string;
  recordId: string;
  sfObject: string;
  sfId: string;
  fields: Record<string, unknown>;
  before: Record<string, unknown>;
  seq: number;
};

/**
 * The patch-plan path. `begin` creates (or finds) the plan for `key`;
 * `complete` marks it applied/failed and writes the audit entry carrying the
 * patchPlanId. Both must be idempotent per key.
 */
export interface PlanSink {
  begin(patch: OutboundPatch): Promise<{ patchPlanId: string; alreadyApplied: boolean }>;
  complete(patchPlanId: string, result: { ok: true } | { ok: false; error: string }): Promise<void>;
}

export type ConflictInput = {
  object: string;
  recordId: string;
  sfId: string;
  field: string;
  fsgtmValue: unknown;
  sfValue: unknown;
  fsgtmAt: number;
  sfAt: number;
};

export interface ConflictSink {
  /** Opens a conflict, or refreshes the open one for (recordId, field). */
  open(conflict: ConflictInput): Promise<void>;
}

export type SyncState = {
  readOnly: boolean;
  mode: "cdc" | "poll";
  inboundCursor: InboundCursor;
  outboxCursor: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
};

export type TickStats = {
  inboundEvents: number;
  inboundEdits: number;
  outboundChanges: number;
  outboundPatches: number;
  skippedEcho: number;
  conflicts: number;
  errors: string[];
};
