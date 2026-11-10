/**
 * An agent's proposed module write (docs/modules.md, "Agents"): an op or a transition whose agent mode is `propose`
 * becomes a patch plan that a person approves and applies on the Patch plans page, as any other agent proposal does.
 * Applying it runs the write again as the person applying it (convex/lib/modules/scope.ts applyModuleProposal), with
 * every check, so an approval can't do what its approver couldn't.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export const MODULE_TRANSITION = "module.transition";
export const MODULE_OP = "module.op";
export const MODULE_CALL = "module.call";
export const isModuleProposal = (operation: string) => operation === MODULE_TRANSITION || operation === MODULE_OP || operation === MODULE_CALL;

/** What a module proposal's patch plan stores in `args`: the write to run again on apply. */
export type ProposalArgs = { /** The module's epoch when proposed: an upgrade since refuses the apply. */ epoch?: number } & (
  | { kind: "transition"; module: string; machine: string; name: string; key: string; expect: number; args?: Record<string, unknown>; reason?: string }
  | { kind: "op"; module: string; op: string; key?: string; parentKey?: string; expect?: number; data?: Record<string, unknown>; unset?: string[] }
  /** A call an agent ran whose writes wait for a person: its intents, applied again as that person (each with its `expect`). */
  | { kind: "call"; module: string; call: string; args: Record<string, unknown>; intents: unknown[] }
);

/** One row a reviewer reads: which doc, what the write does, and the fields before and after. */
export type ProposalRow = { collection: string; key?: string; action: string; before: unknown; after: unknown };

/**
 * The patch plan for one proposed write, or a call's writes, pending a person's approval: one operation a reviewer
 * reads per write, all applied together. Its operations are approved by default.
 */
export async function insertProposal(
  db: MutationCtx["db"],
  who: { orgId: Id<"organizations">; userId: Id<"users">; agent: string },
  args: ProposalArgs,
  row: ProposalRow | readonly ProposalRow[],
  summary: string,
): Promise<Id<"patchPlans">> {
  const now = Date.now();
  const rows = Array.isArray(row) ? row : [row as ProposalRow];
  const operation = args.kind === "transition" ? MODULE_TRANSITION : args.kind === "call" ? MODULE_CALL : MODULE_OP;
  const reason = `${summary} (proposed by ${who.agent})`;
  const patchPlanId = await db.insert("patchPlans", {
    orgId: who.orgId, createdBy: who.userId, verb: "set", operation, args, reason,
    status: "pending_approval", riskLevel: "medium", approvalRequirement: "required", source: "hosted", createdAt: now, updatedAt: now,
    totalOperationCount: rows.length, storedOperationCount: rows.length,
  });
  for (const [i, r] of rows.entries()) {
    await db.insert("patchOperations", {
      orgId: who.orgId, patchPlanId, objectType: r.collection, ...(r.key ? { objectId: r.key } : {}), fieldOrAction: r.action,
      beforeValue: r.before, afterValue: r.after, reason, sourceRuleOrPolicy: `module ${args.module}`, riskLevel: "medium",
      approvalRequirement: "required", packageOpId: String(i + 1), status: "pending", createdAt: now, updatedAt: now,
    });
  }
  await db.insert("approvalRequests", { orgId: who.orgId, patchPlanId, requestedBy: who.userId, status: "pending", reason, createdAt: now, updatedAt: now });
  await db.insert("operationAuditLog", {
    orgId: who.orgId, userId: who.userId, patchPlanId, verb: "set", operation, status: "previewed",
    details: { module: args.module, agent: who.agent, summary }, createdAt: now,
  });
  return patchPlanId;
}
