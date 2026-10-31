"use client";

/**
 * In-memory stand-in for the Phase 1b Convex functions (A/B/C), used when
 * NEXT_PUBLIC_SF_SYNC_FAKE=1 (Playwright specs, local UI work before the
 * backend workstreams merge). It mimics the contract semantics the UI relies
 * on: authority updates, read-only flag, conflict resolution, import progress.
 */

import type {
  Conflict,
  ConflictResolution,
  FieldDefinition,
  ImportJob,
  ObjectDefinition,
  RejectedRow,
  SalesforceConnection,
  SyncAuthority,
  SyncState,
} from "./types";

export type FakeState = {
  connection: SalesforceConnection;
  objects: ObjectDefinition[];
  fields: FieldDefinition[];
  jobs: ImportJob[];
  rejected: Record<string, RejectedRow[]>;
  syncState: SyncState;
  conflicts: Conflict[];
  writes: number;
};

const NOW = 1_790_000_000_000;

function field(
  object: string,
  apiName: string,
  type: string,
  syncAuthority: SyncAuthority,
  updateable = true,
): FieldDefinition {
  return { _id: `${object}.${apiName}`, object, apiName, label: apiName.replace(/__c$/, "").replace(/_/g, " "), type, updateable, syncAuthority };
}

export function initialFakeState(): FakeState {
  return {
    connection: {
      instanceUrl: "https://example-dev-ed.develop.my.salesforce.com",
      displayName: "Example Dev Org",
      externalOrgDomain: "example-dev-ed.develop.my.salesforce.com",
      isActive: true,
      connectedAt: NOW - 86_400_000,
      lastSyncAt: NOW - 60_000,
      lastSyncStatus: "success",
    },
    objects: [
      { _id: "o1", apiName: "Account", label: "Account", isCustom: false, syncEnabled: true, recordCount: 10000, describedAt: NOW },
      { _id: "o2", apiName: "Contact", label: "Contact", isCustom: false, syncEnabled: true, recordCount: 50000, describedAt: NOW },
      { _id: "o3", apiName: "Lead", label: "Lead", isCustom: false, syncEnabled: true, recordCount: 2200, describedAt: NOW },
      { _id: "o4", apiName: "Project__c", label: "Project", isCustom: true, syncEnabled: false, recordCount: 340, describedAt: NOW },
    ],
    fields: [
      field("Account", "Name", "string", "newest"),
      field("Account", "Website", "url", "newest"),
      field("Account", "OwnerId", "reference", "salesforce"),
      field("Account", "SystemModstamp", "datetime", "salesforce", false),
      field("Account", "Fit_Score__c", "double", "fsgtm"),
      field("Account", "Industry", "picklist", "review"),
      field("Contact", "Email", "email", "newest"),
      field("Contact", "LastName", "string", "newest"),
      field("Project__c", "Budget__c", "currency", "newest"),
    ],
    jobs: [
      {
        _id: "job1",
        status: "completed",
        startedAt: NOW - 3_600_000,
        finishedAt: NOW - 3_000_000,
        objects: [
          { apiName: "Account", sfTotal: 10000, upserted: 9950, merged: 120, rejected: 50, state: "done" },
          { apiName: "Contact", sfTotal: 50000, upserted: 50000, merged: 310, rejected: 0, state: "done" },
        ],
      },
    ],
    rejected: {
      job1: Array.from({ length: 3 }, (_, i) => ({
        object: "Account",
        sfId: `001000000000${String(i).padStart(3, "0")}AAA`,
        reason: "Account has no Website or domain; cannot derive natural key",
      })),
    },
    syncState: { readOnly: false, mode: "poll", pollIntervalMs: 15000, lastInboundAt: NOW - 20_000, lastOutboundAt: NOW - 40_000, outboxCursor: 812 },
    conflicts: [
      { _id: "c1", object: "Account", recordId: "acc_1", sfId: "001000000000001AAA", field: "Industry", fsgtmValue: "Software", sfValue: "Technology", fsgtmAt: NOW - 5000, sfAt: NOW - 4000, status: "open" },
      { _id: "c2", object: "Contact", recordId: "con_9", sfId: "003000000000009AAA", field: "Title", fsgtmValue: "VP Sales", sfValue: "SVP Sales", fsgtmAt: NOW - 9000, sfAt: NOW - 8000, status: "open" },
    ],
    writes: 0,
  };
}

let state: FakeState = initialFakeState();
const listeners = new Set<() => void>();

function set(next: Partial<FakeState>) {
  state = { ...state, ...next, writes: state.writes + 1 };
  listeners.forEach((l) => l());
}

export const fakeStore = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reset() {
    state = initialFakeState();
    listeners.forEach((l) => l());
  },
  async getAuthUrl() {
    return { authUrl: "https://login.salesforce.com/services/oauth2/authorize?fake=1" };
  },
  async disconnect() {
    set({ connection: null });
    return null;
  },
  async importMetadata() {
    set({ objects: state.objects.map((o) => ({ ...o, describedAt: Date.now() })) });
    return { objects: state.objects.length, fields: state.fields.length };
  },
  async setFieldAuthority(args: { object: string; apiName: string; syncAuthority: SyncAuthority }) {
    set({
      fields: state.fields.map((f) =>
        f.object === args.object && f.apiName === args.apiName ? { ...f, syncAuthority: args.syncAuthority } : f,
      ),
    });
    return null;
  },
  async setObjectSyncEnabled(args: { apiName: string; enabled: boolean }) {
    set({ objects: state.objects.map((o) => (o.apiName === args.apiName ? { ...o, syncEnabled: args.enabled } : o)) });
    return null;
  },
  async startImport(args: { objects?: string[] }) {
    const jobId = `job${state.jobs.length + 1}`;
    const names = args.objects ?? state.objects.filter((o) => o.syncEnabled).map((o) => o.apiName);
    const job: ImportJob = {
      _id: jobId,
      status: "running",
      startedAt: Date.now(),
      objects: names.map((apiName) => ({
        apiName,
        sfTotal: state.objects.find((o) => o.apiName === apiName)?.recordCount ?? 0,
        upserted: 0,
        merged: 0,
        rejected: 0,
        state: "queued",
      })),
    };
    set({ jobs: [...state.jobs, job], rejected: { ...state.rejected, [jobId]: [] } });
    setTimeout(() => {
      set({
        jobs: state.jobs.map((j) =>
          j._id === jobId
            ? { ...j, status: "completed", finishedAt: Date.now(), objects: j.objects.map((o) => ({ ...o, upserted: o.sfTotal, state: "done" })) }
            : j,
        ),
      });
    }, 300);
    return { jobId };
  },
  async previewImport() {
    return state.objects.map((o) => ({ apiName: o.apiName, sfTotal: o.recordCount ?? 0 }));
  },
  async loadAllRejected(jobId: string) {
    return state.rejected[jobId] ?? [];
  },
  async setReadOnly(args: { readOnly: boolean }) {
    if (state.syncState) set({ syncState: { ...state.syncState, readOnly: args.readOnly } });
    return null;
  },
  async resolveConflict(args: { conflictId: string; resolution: ConflictResolution; value?: unknown }) {
    set({
      conflicts: state.conflicts.map((c) =>
        c._id === args.conflictId
          ? { ...c, status: "resolved", resolution: args.resolution, resolvedBy: "you", resolvedAt: Date.now() }
          : c,
      ),
    });
    return null;
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { __sfSyncFake?: typeof fakeStore }).__sfSyncFake = fakeStore;
}
