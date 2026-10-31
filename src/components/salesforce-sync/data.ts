"use client";

/**
 * Typed data hooks for the Salesforce sync dashboard.
 *
 * Live mode binds to the Phase 1b Convex functions by name (makeFunctionReference)
 * because they are owned by workstreams A/B/C and are not in this branch's
 * generated api yet. Fake mode (NEXT_PUBLIC_SF_SYNC_FAKE=1) binds to the
 * in-memory fake store. The mode is fixed at module load so hook order is stable.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { fakeStore, type FakeState } from "./fake-store";
import type {
  Conflict,
  ConflictResolution,
  ConflictStatus,
  FieldDefinition,
  ImportJob,
  ImportableObject,
  ObjectDefinition,
  Paged,
  RejectedRow,
  SalesforceConnection,
  SyncAuthority,
  SyncState,
} from "./types";

export const SF_SYNC_FAKE = process.env.NEXT_PUBLIC_SF_SYNC_FAKE === "1";

const ref = {
  listObjects: makeFunctionReference<"query", Record<string, never>, ObjectDefinition[]>("salesforceMetadata:listObjects"),
  listFields: makeFunctionReference<"query", { object: string }, FieldDefinition[]>("salesforceMetadata:listFields"),
  importMetadata: makeFunctionReference<"action", Record<string, never>, { objects: number; fields: number }>("salesforceMetadata:importMetadata"),
  setFieldAuthority: makeFunctionReference<"mutation", { object: string; apiName: string; syncAuthority: SyncAuthority }, unknown>("salesforceMetadata:setFieldAuthority"),
  setObjectSyncEnabled: makeFunctionReference<"mutation", { apiName: string; enabled: boolean }, unknown>("salesforceMetadata:setObjectSyncEnabled"),
  startImport: makeFunctionReference<"action", { objects?: string[] }, { jobId: string }>("salesforceImport:start"),
  previewImport: makeFunctionReference<"action", Record<string, never>, ImportableObject[]>("salesforceImport:preview"),
  latestImport: makeFunctionReference<"query", Record<string, never>, ImportJob | null>("salesforceImport:latest"),
  listRejected: makeFunctionReference<"query", { jobId: string; cursor?: string }, Paged<RejectedRow> | RejectedRow[]>("salesforceImport:listRejected"),
  getState: makeFunctionReference<"query", Record<string, never>, SyncState>("salesforceSync:getState"),
  setReadOnly: makeFunctionReference<"mutation", { readOnly: boolean }, unknown>("salesforceSync:setReadOnly"),
  listConflicts: makeFunctionReference<"query", { status?: ConflictStatus; cursor?: string }, Paged<Conflict> | Conflict[]>("salesforceSync:listConflicts"),
  resolveConflict: makeFunctionReference<"mutation", { conflictId: string; resolution: ConflictResolution; value?: unknown }, unknown>("salesforceSync:resolveConflict"),
};

/** listRejected / listConflicts page shape is not pinned in the contract; accept both. */
export function normalizePage<T>(value: Paged<T> | T[] | undefined | null): T[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  // listRejected pages as {rows, nextCursor}; listConflicts as a Convex page.
  return (value as { rows?: T[] }).rows ?? value.page;
}

function useFake<T>(select: (s: FakeState) => T): T {
  const snapshot = useSyncExternalStore(fakeStore.subscribe, fakeStore.getState, fakeStore.getState);
  return select(snapshot);
}

export type SalesforceSyncHooks = {
  useConnection(): SalesforceConnection | undefined;
  useGetAuthUrl(): () => Promise<{ authUrl: string }>;
  useDisconnect(): () => Promise<unknown>;
  useObjects(): ObjectDefinition[] | undefined;
  useFields(object: string | null): FieldDefinition[] | undefined;
  useImportMetadata(): () => Promise<{ objects: number; fields: number }>;
  useSetFieldAuthority(): (args: { object: string; apiName: string; syncAuthority: SyncAuthority }) => Promise<unknown>;
  useSetObjectSyncEnabled(): (args: { apiName: string; enabled: boolean }) => Promise<unknown>;
  useLatestImport(): ImportJob | null | undefined;
  useStartImport(): (args: { objects?: string[] }) => Promise<{ jobId: string }>;
  useRejected(jobId: string | null): RejectedRow[] | undefined;
  usePreviewImport(): () => Promise<ImportableObject[]>;
  /** Every rejected row the job kept (its first 1000), for the failure report. */
  useLoadAllRejected(): (jobId: string) => Promise<RejectedRow[]>;
  useSyncState(): SyncState | undefined;
  useSetReadOnly(): (args: { readOnly: boolean }) => Promise<unknown>;
  useConflicts(status: ConflictStatus): Conflict[] | undefined;
  useResolveConflict(): (args: { conflictId: string; resolution: ConflictResolution; value?: unknown }) => Promise<unknown>;
};

const liveHooks: SalesforceSyncHooks = {
  useConnection: () => useQuery(api.salesforce.getConnection) as SalesforceConnection | undefined,
  useGetAuthUrl: () => {
    const fn = useAction(api.salesforceActions.getAuthUrl);
    return useCallback(() => fn({}), [fn]);
  },
  useDisconnect: () => {
    const fn = useAction(api.salesforce.disconnectWithRevocation);
    return useCallback(() => fn({}), [fn]);
  },
  useObjects: () => useQuery(ref.listObjects, {}),
  useFields: (object) => useQuery(ref.listFields, object ? { object } : "skip"),
  useImportMetadata: () => {
    const fn = useAction(ref.importMetadata);
    return useCallback(() => fn({}), [fn]);
  },
  useSetFieldAuthority: () => useMutation(ref.setFieldAuthority),
  useSetObjectSyncEnabled: () => useMutation(ref.setObjectSyncEnabled),
  useLatestImport: () => useQuery(ref.latestImport, {}),
  useStartImport: () => useAction(ref.startImport),
  useRejected: (jobId) => normalizePage(useQuery(ref.listRejected, jobId ? { jobId } : "skip")),
  usePreviewImport: () => {
    const fn = useAction(ref.previewImport);
    return useCallback(() => fn({}), [fn]);
  },
  useLoadAllRejected: () => {
    const convex = useConvex();
    return useCallback(async (jobId: string) => {
      const rows: RejectedRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = (await convex.query(ref.listRejected, { jobId, ...(cursor ? { cursor } : {}) })) as Paged<RejectedRow> & { rows?: RejectedRow[]; nextCursor?: string | null };
        rows.push(...(normalizePage(page) ?? []));
        if (!page.nextCursor) return rows;
        cursor = page.nextCursor;
      }
    }, [convex]);
  },
  useSyncState: () => useQuery(ref.getState, {}),
  useSetReadOnly: () => useMutation(ref.setReadOnly),
  useConflicts: (status) => normalizePage(useQuery(ref.listConflicts, { status })),
  useResolveConflict: () => useMutation(ref.resolveConflict),
};

const fakeHooks: SalesforceSyncHooks = {
  useConnection: () => useFake((s) => s.connection),
  useGetAuthUrl: () => fakeStore.getAuthUrl,
  useDisconnect: () => fakeStore.disconnect,
  useObjects: () => useFake((s) => s.objects),
  useFields: (object) => {
    const fields = useFake((s) => s.fields);
    return object ? fields.filter((f) => f.object === object) : undefined;
  },
  useImportMetadata: () => fakeStore.importMetadata,
  useSetFieldAuthority: () => fakeStore.setFieldAuthority,
  useSetObjectSyncEnabled: () => fakeStore.setObjectSyncEnabled,
  useLatestImport: () => useFake((s) => s.jobs.at(-1) ?? null),
  useStartImport: () => fakeStore.startImport,
  usePreviewImport: () => fakeStore.previewImport,
  useLoadAllRejected: () => fakeStore.loadAllRejected,
  useRejected: (jobId) => {
    const rejected = useFake((s) => s.rejected);
    return jobId ? rejected[jobId] ?? [] : undefined;
  },
  useSyncState: () => useFake((s) => s.syncState),
  useSetReadOnly: () => fakeStore.setReadOnly,
  useConflicts: (status) => {
    const conflicts = useFake((s) => s.conflicts);
    return conflicts.filter((c) => c.status === status);
  },
  useResolveConflict: () => fakeStore.resolveConflict,
};

export const sfSync: SalesforceSyncHooks = SF_SYNC_FAKE ? fakeHooks : liveHooks;
