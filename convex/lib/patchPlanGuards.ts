import { ConvexError } from "convex/values";

/**
 * Pure apply-path safety guards for patch plans. Both the Convex mutation
 * (patchPlans.apply) and the action wrapper (patchPlanActions.apply) decide
 * through these functions so the safety model stays testable without a
 * Convex runtime.
 */

export type ApplyDecision =
  | { kind: "already_applied" }
  | { kind: "blocked"; reason: string }
  | { kind: "allowed" };

/** A provider or local mutation only ever happens from an approved plan. */
export function applyDecision(plan: { status: string }): ApplyDecision {
  if (plan.status === "applied") return { kind: "already_applied" };
  if (plan.status !== "approved") {
    return {
      kind: "blocked",
      reason: `Patch plan must be approved before apply (is ${plan.status})`,
    };
  }
  return { kind: "allowed" };
}

/** Set equality for an immutable approval revision (order is irrelevant). */
export function sameOperationSubset(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((id) => expected.has(id));
}

/**
 * The apply mutation only dispatches `set` operations itself; `do` operations
 * need an action context and must arrive with alreadyDispatched set by
 * patchPlanActions.apply.
 */
export function dispatchBlockReason(
  plan: { verb: string },
  alreadyDispatched: boolean,
): string | null {
  if (alreadyDispatched) return null;
  if (plan.verb !== "set") {
    return `${plan.verb} operations are applied through patchPlanActions.apply`;
  }
  return null;
}

/**
 * A CRM-backed deal patch may only be marked applied when the provider
 * writeback result matches the deal's provider and CRM id — never on a null,
 * foreign, or malformed result.
 */
export function providerWritebackBlockReason(
  deal: { crmId?: string | null; crmProvider?: string | null },
  providerResult: unknown,
): string | null {
  if (
    deal.crmId &&
    (deal.crmProvider === "hubspot" || deal.crmProvider === "salesforce") &&
    !validProviderResult(providerResult, deal.crmProvider, deal.crmId)
  ) {
    return "Provider writeback result is required before marking a CRM-backed deal patch applied";
  }
  return null;
}

export function validProviderResult(providerResult: unknown, provider: string, crmId: string) {
  if (!providerResult || typeof providerResult !== "object" || Array.isArray(providerResult)) return false;
  const result = providerResult as Record<string, unknown>;
  return result.provider === provider && result.crmId === crmId;
}

export function requiredString(args: unknown, name: string) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ConvexError(`${name} is required`);
  const value = (args as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value.trim()) throw new ConvexError(`${name} is required`);
  return value.trim();
}
