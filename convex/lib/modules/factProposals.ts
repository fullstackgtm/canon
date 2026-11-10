/**
 * A module's proposed facts (docs/modules.md, "Proposing facts"): a call's `facts.propose`, held on the fact review
 * queue by the one proposal writer (canonGate submitProposalBatch) as the member who ran the call, with the module as
 * its source. No rule or grant accepts one (lib/canon/gate.ts autoAcceptDecision): a member with `facts.review` does.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { submitProposalBatch, type proposedFactValidator } from "../../canonGate";
import { moduleLabel } from "../agents/attribution";
import type { FactObject, FactRejection, FactsProposeArgs } from "../../../modules/kernel/facts.ts";
import type { ProposalOutcome } from "../../../modules/kernel/proposals.ts";

type GateFact = typeof proposedFactValidator.type;
const ENTITY = { deals: "opportunity", companies: "account", people: "contact" } as const satisfies Record<FactObject, GateFact["entityType"]>;
const REASONS: Record<string, FactRejection> = { unknown_deal: "unknown_record", unknown_account: "unknown_record", unknown_contact: "unknown_record" };

/** What a fact proposal's plan keeps in `args` besides the gate's own: the module, and the facts the ledger didn't take. */
export type FactProposalArgs = { module: string; object: FactObject; rejected: Array<{ index: number; reason: FactRejection }>; unchanged: number };

/**
 * The gate's facts for a module's: a deal by its row id, a company or person by its record id, so the id of one
 * object's record never names another's.
 */
export function gateFacts(args: FactsProposeArgs): GateFact[] {
  const entityType = ENTITY[args.object];
  return args.facts.map((f) => ({
    entityType, ...(entityType === "opportunity" ? { dealId: f.id } : { recordId: f.id }),
    attribute: f.attribute, value: f.value, evidence: f.evidence,
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}), ...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}),
  }));
}

/** What a call's `facts.propose` reports at once: its proposal's id, and what `proposals.byIds` reads back as rejected and unchanged. */
export type FactProposalReceipt = Pick<ProposalOutcome, "id" | "rejected" | "unchanged">;

/**
 * Propose a module's facts as `userId`, on the records they see (`admitted`: the companies and people the call's
 * action admitted through their scoped client). A `custom.<slug>` the workspace doesn't have is `unknown_attribute`.
 * Returns the plan's id, which `proposals.byIds` reads back, and the facts it didn't store.
 */
export async function proposeModuleFacts(ctx: MutationCtx, a: {
  orgId: Id<"organizations">; userId: Id<"users">; module: { id: string; title: string }; args: FactsProposeArgs; reason: string; admitted: readonly string[];
}): Promise<FactProposalReceipt & { id: Id<"patchPlans"> }> {
  const res = await submitProposalBatch(ctx, {
    attribution: { kind: "user", orgId: a.orgId, userId: a.userId, label: moduleLabel(a.module.id) },
    sourceKind: "agent_run", title: `${a.module.title}: ${a.reason}`, reason: a.reason, facts: gateFacts(a.args), admitted: a.admitted, knownCustomOnly: true,
  });
  const rejected = res.rejected.map((r) => ({ index: r.index, reason: REASONS[r.reason] ?? (r.reason as FactRejection) }));
  const plan = (await ctx.db.get(res.patchPlanId))!;
  const kept: FactProposalArgs = { module: a.module.id, object: a.args.object, rejected, unchanged: res.unchanged };
  await ctx.db.patch(res.patchPlanId, { args: { ...plan.args, ...kept } });
  return { id: res.patchPlanId, rejected, unchanged: res.unchanged };
}
