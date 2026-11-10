// Types live in the node-free `types.ts`; import them directly rather than via
// the package barrel (which re-exports node-using connectors) so the Convex
// bundler never has to resolve the barrel for this V8-runtime module.
import type {
  ApprovalStatus,
  PatchOperation,
  PatchPlan,
  RiskLevel,
} from "../../engine/src/types.ts";

/**
 * One patch-plan vocabulary: converts the app's legacy verb/operation rows
 * into the open-source package's typed `PatchPlan` document, so the dashboard
 * review queue, the HTTP API, and `fullstackgtm apply` all operate on the
 * same document shape. New plan sources should produce package documents
 * directly; this adapter keeps historical rows readable forever.
 */

type LegacyPlanRow = {
  _id: string;
  verb: string;
  operation: string;
  reason?: string;
  status: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: number;
};

type LegacyOperationRow = {
  _id: string;
  objectType: string;
  objectId?: string;
  fieldOrAction: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason?: string;
  sourceRuleOrPolicy?: string;
  riskLevel: RiskLevel;
};

const STATUS_MAP: Record<string, ApprovalStatus> = {
  draft: "draft",
  pending_approval: "needs_approval",
  approved: "approved",
  applied: "applied",
  rejected: "rejected",
  cancelled: "rejected",
  // A failed apply does not invalidate the approved proposal.
  failed: "approved",
};

const OBJECT_TYPES = new Set(["account", "contact", "deal", "user", "activity"]);

export function legacyPlanToDocument(
  plan: LegacyPlanRow,
  operations: LegacyOperationRow[],
): PatchPlan {
  const typedOperations: PatchOperation[] = operations.map((operation) => ({
    id: `op_${operation._id}`,
    objectType: OBJECT_TYPES.has(operation.objectType)
      ? (operation.objectType as PatchOperation["objectType"])
      : "deal",
    objectId: operation.objectId ?? "unknown",
    operation: "set_field",
    field: operation.fieldOrAction,
    beforeValue: operation.beforeValue ?? null,
    afterValue: operation.afterValue ?? null,
    reason: operation.reason ?? operation.sourceRuleOrPolicy ?? `${plan.verb} ${plan.operation}`,
    riskLevel: operation.riskLevel,
    approvalRequired: true,
  }));

  return {
    id: `patch_plan_${plan._id}`,
    title: `${plan.verb} ${plan.operation}`,
    createdAt: new Date(plan.createdAt).toISOString(),
    status: STATUS_MAP[plan.status] ?? "draft",
    dryRun: true,
    summary:
      plan.reason ??
      `${typedOperations.length} proposed operation(s) for ${plan.operation}.`,
    findings: [],
    operations: typedOperations,
  };
}
