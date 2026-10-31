import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { applyPatchPlan } from "../../engine/src/connector.ts";
import type { GtmConnector, PatchOperationResult, PatchPlan } from "../../engine/src/types.ts";

export type ApplyThroughPackageRow = { _id?: Id<"patchOperations"> | string; packageOpId?: string };
export type PersistedStatus = "applied" | "skipped" | "failed" | "conflict";

type PersistedResult = {
  operationId: Id<"patchOperations">;
  status: PersistedStatus;
  error?: string;
  providerData?: unknown;
};

export function patchPlanFromDocument(value: unknown): PatchPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { operations?: unknown };
  return Array.isArray(candidate.operations) ? (value as PatchPlan) : null;
}

function summarizeRunRecord(run: { planId?: string; provider?: unknown; startedAt?: string; finishedAt?: string; status?: unknown; results?: PatchOperationResult[] }) {
  const results = Array.isArray(run.results) ? run.results : [];
  return {
    ...run,
    resultCount: results.length,
    results: results.slice(0, 200),
    resultsTruncated: results.length > 200,
  };
}

function operationFromRow(row: any, index: number) {
  return {
    id: row.packageOpId ?? String(row._id ?? `legacy_${index}`),
    objectType: row.objectType,
    objectId: row.objectId ?? "",
    operation: row.fieldOrAction === "ownerId" ? "set_field" : row.fieldOrAction,
    field: row.fieldOrAction === "ownerId" ? "ownerId" : row.fieldOrAction,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    reason: row.reason ?? "Approved legacy patch operation",
    riskLevel: row.riskLevel ?? "medium",
    approvalRequired: row.approvalRequirement === "required",
    sourceRuleOrPolicy: row.sourceRuleOrPolicy,
    rollback: row.rollback,
  };
}

export async function applyLegacyRowsThroughConnector(
  ctx: ActionCtx,
  args: {
    connector: GtmConnector;
    rows: ApplyThroughPackageRow[];
    afterResult?: (result: PatchOperationResult, row: ApplyThroughPackageRow | undefined) => Promise<void>;
  },
): Promise<{ applied: number; skipped: number; failed: number; conflicts: number; firstErrors: string[] }> {
  if (!args.connector.applyOperation) throw new Error(`Connector ${args.connector.provider} does not support patch operation apply.`);
  const persisted: PersistedResult[] = [];
  for (const [index, row] of args.rows.entries()) {
    if (!row._id) continue;
    const operation = operationFromRow(row, index);
    let result: PatchOperationResult;
    try {
      result = await args.connector.applyOperation(operation as any);
    } catch (error) {
      result = { operationId: operation.id, status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    await args.afterResult?.(result, row);
    const status: PersistedStatus = result.status === "applied" ? "applied" : result.status === "skipped" ? "skipped" : result.status === "conflict" ? "conflict" : "failed";
    persisted.push({
      operationId: row._id as Id<"patchOperations">,
      status,
      error: status === "failed" || status === "conflict" ? result.detail : undefined,
      providerData: { detail: result.detail, providerData: result.providerData },
    });
  }
  for (let i = 0; i < persisted.length; i += 400) {
    await ctx.runMutation(internal.patchPlans.recordOperationResults, { results: persisted.slice(i, i + 400) });
  }
  const applied = persisted.filter((result) => result.status === "applied").length;
  const skipped = persisted.filter((result) => result.status === "skipped").length;
  const failedOnly = persisted.filter((result) => result.status === "failed").length;
  const conflicts = persisted.filter((result) => result.status === "conflict").length;
  return { applied, skipped, failed: failedOnly + conflicts, conflicts, firstErrors: persisted.map((result) => result.error).filter((error): error is string => Boolean(error)).slice(0, 5) };
}

export async function applyThroughPackage(
  ctx: ActionCtx,
  args: {
    connector: GtmConnector;
    plan: PatchPlan;
    rows: ApplyThroughPackageRow[];
    patchPlanId?: Id<"patchPlans">;
    valueOverrides?: Record<string, unknown>;
    checkConflicts?: boolean;
    afterResult?: (result: PatchOperationResult, row: ApplyThroughPackageRow | undefined) => Promise<void>;
  },
): Promise<{ applied: number; skipped: number; failed: number; conflicts: number; firstErrors: string[] }> {
  const packageOperationIds = new Set(args.plan.operations.map((operation) => operation.id));
  const approvedOperationIds = args.rows
    .map((row) => row.packageOpId)
    .filter((id): id is string => typeof id === "string" && packageOperationIds.has(id));
  const rowByOperationId = new Map<string, ApplyThroughPackageRow>();
  for (const row of args.rows) {
    if (row.packageOpId && packageOperationIds.has(row.packageOpId)) rowByOperationId.set(row.packageOpId, row);
  }

  const persisted: PersistedResult[] = [];
  const liveByOperationId = new Map<string, PersistedResult>();
  let flushedCount = 0;
  let lastFlushAt = Date.now();
  let flushPromise: Promise<void> = Promise.resolve();
  const flushLive = async () => {
    const pending = persisted.slice(flushedCount);
    if (pending.length === 0) return;
    if (pending.length < 10 && Date.now() - lastFlushAt < 5000) return;
    lastFlushAt = Date.now();
    try {
      await ctx.runMutation(internal.patchPlans.recordOperationResults, { results: pending });
      flushedCount = persisted.length;
    } catch {
      // Retried by the next live flush or final chunked write-back.
    }
  };
  const queueLiveFlush = () => {
    flushPromise = flushPromise.then(flushLive, flushLive);
  };

  const run = await applyPatchPlan(args.connector, args.plan, {
    approvedOperationIds,
    checkConflicts: args.checkConflicts ?? true,
    valueOverrides: args.valueOverrides,
    progress: {
      stage() {},
      items() {},
      note() {},
      meter() {},
      snapshot() { return { opsApplied: 0, opsSkipped: 0, opsFailed: 0, updatedAt: Date.now() }; },
      flush() { queueLiveFlush(); },
      opResult(operationId, status, detail) {
        const row = rowByOperationId.get(operationId);
        if (!row?._id || liveByOperationId.has(operationId)) return;
        const live = {
          operationId: row._id as Id<"patchOperations">,
          status,
          error: status === "failed" || status === "conflict" ? detail : undefined,
          providerData: detail ? { detail } : undefined,
        };
        liveByOperationId.set(operationId, live);
        persisted.push(live);
        queueLiveFlush();
      },
    },
  });
  await flushPromise;
  if (args.patchPlanId) {
    await ctx.runMutation(internal.patchPlans.recordPatchPlanRun, {
      patchPlanId: args.patchPlanId,
      runRecord: JSON.parse(JSON.stringify(summarizeRunRecord(run))),
    });
  }

  for (const result of run.results) {
    const row = rowByOperationId.get(result.operationId);
    await args.afterResult?.(result, row);
    if (!row?._id) {
      await flushLive();
      continue;
    }
    const status: PersistedStatus =
      result.status === "applied" ? "applied" :
      result.status === "skipped" ? "skipped" :
      result.status === "conflict" ? "conflict" : "failed";
    const finalResult = {
      operationId: row._id as Id<"patchOperations">,
      status,
      error: status === "failed" || status === "conflict" ? result.detail : undefined,
      providerData: { detail: result.detail, providerData: result.providerData },
    };
    const live = liveByOperationId.get(result.operationId);
    if (live) Object.assign(live, finalResult);
    else persisted.push(finalResult);
    await flushLive();
  }

  // Final chunked write-back overwrites any live-flushed placeholder detail
  // with the full applyPatchPlan result/providerData.
  for (let i = 0; i < persisted.length; i += 400) {
    await ctx.runMutation(internal.patchPlans.recordOperationResults, { results: persisted.slice(i, i + 400) });
  }

  const applied = persisted.filter((result) => result.status === "applied").length;
  const skipped = persisted.filter((result) => result.status === "skipped").length;
  const failedOnly = persisted.filter((result) => result.status === "failed").length;
  const conflicts = persisted.filter((result) => result.status === "conflict").length;
  return {
    applied,
    skipped,
    failed: failedOnly + conflicts,
    conflicts,
    firstErrors: persisted.map((result) => result.error).filter((error): error is string => Boolean(error)).slice(0, 5),
  };
}
