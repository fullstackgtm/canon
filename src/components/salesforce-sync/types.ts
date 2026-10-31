/**
 * Client-side mirror of the Phase 1b shared contracts (workstreams A/B/C).
 * The Convex functions are owned by other workstreams, so the pages depend on
 * these shapes rather than on convex/_generated/api until those functions merge.
 */

export type SyncAuthority = "fsgtm" | "salesforce" | "newest" | "review";
export const SYNC_AUTHORITIES: SyncAuthority[] = ["fsgtm", "salesforce", "newest", "review"];

export type SalesforceConnection = {
  instanceUrl?: string;
  displayName?: string;
  externalOrgDomain?: string;
  isActive: boolean;
  lastSyncAt?: number;
  lastSyncStatus?: string;
  lastSyncError?: string;
  connectedAt?: number;
} | null;

export type ObjectDefinition = {
  _id: string;
  apiName: string;
  label: string;
  isCustom: boolean;
  syncEnabled: boolean;
  recordCount?: number;
  describedAt: number;
};

export type FieldDefinition = {
  _id: string;
  object: string;
  apiName: string;
  label: string;
  type: string;
  picklistValues?: string[];
  referenceTo?: string[];
  updateable: boolean;
  syncAuthority: SyncAuthority;
  mappedTo?: string;
};

export type ImportObjectProgress = {
  apiName: string;
  sfTotal: number;
  upserted: number;
  merged: number;
  rejected: number;
  bulkJobId?: string;
  state: string;
  seen?: number;
  error?: string;
};

/** A Salesforce owner the imported records held; no memberId means no Canon member has that email. */
export type ImportOwner = { sfUserId: string; name: string; email?: string; memberId?: string; records: number };

export type ImportJob = {
  _id: string;
  status: string;
  objects: ImportObjectProgress[];
  owners?: ImportOwner[];
  rejectedCount?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

/** An object an import would bring across, with Salesforce's count. */
export type ImportableObject = { apiName: string; sfTotal: number };

export type RejectedRow = { object: string; sfId?: string; index?: number; reason: string };

export type SyncState = {
  readOnly: boolean;
  mode: "cdc" | "poll";
  lastInboundAt?: number;
  lastOutboundAt?: number;
  pollIntervalMs: number;
  outboxCursor?: number;
} | null;

export type ConflictStatus = "open" | "resolved";
export type Conflict = {
  _id: string;
  object: string;
  recordId: string;
  sfId: string;
  field: string;
  fsgtmValue: unknown;
  sfValue: unknown;
  fsgtmAt: number;
  sfAt: number;
  status: ConflictStatus;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: number;
};

export type ConflictResolution = "fsgtm" | "salesforce" | "custom";

export type Paged<T> = { page: T[]; isDone: boolean; continueCursor: string | null };
