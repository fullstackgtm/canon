/**
 * Applying a module's approved record proposal (docs/modules.md, "Writes to Canon records"), from the Patch plans
 * page through patchPlanActions.apply: each approved row written as the person applying it, through the records edit
 * path (their role, the row and the field's rules, receipts and history), and only while the record still holds the
 * version the proposal read. A record changed since is skipped and named, never overwritten.
 */
import { ConvexError, v } from "convex/values";
import { TARGET_CHANGED } from "./targets";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { clientFor, recordEditPorts, requireCaller } from "./records";
import { EditConflictError, editPartyRecord } from "./lib/canon/partyLedger";
import { chunked } from "../modules/kernel/calls.ts";
import { judgeRow, MAX_PROPOSAL_ROWS, MAX_SKIPPED_NAMED, MODULE_RECORDS, type ProposalSetRow, type MeetingLogArgs, type TargetsSetArgs } from "../modules/kernel/proposals.ts";
import { canonicalMeetingArgs, meetingProposalRow, type AppliedOutcome, type RecordProposalArgs } from "./lib/modules/recordProposals";
import type { Access } from "./lib/access";
import { agentClientOf, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { requireWriteAccess } from "./permissions";
import { requireWritable, saveAsCaller } from "./objects";
import { attachTargets } from "./activityTargets";
import { canonicalJson } from "../modules/kernel/integrity.ts";

type Row = { _id: Id<"patchOperations">; objectType?: string; objectId?: string; fieldOrAction: string; beforeValue?: unknown; afterValue?: unknown; packageOpId?: string };
type Result = { operationId: Id<"patchOperations">; status: "applied" | "failed" | "conflict"; error?: string; providerData?: unknown };

export const applyInternal = internalAction({
  args: { patchPlanId: v.id("patchPlans"), claimId: v.string() },
  handler: async (ctx, args): Promise<{ applied: number; skipped: number; failed: number }> => {
    const approved = await ctx.runQuery(internal.moduleRecords.hostedRows, args);
    return applyRecordRows(ctx, await requireCaller(ctx), { ...args, ...approved });
  },
});

async function hostedRecordPlan(ctx: QueryCtx, args: { patchPlanId: Id<"patchPlans">; claimId: string }) {
  const user = await requireUser(ctx);
  if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
  const plan = await ctx.db.get(args.patchPlanId);
  if (!plan || plan.orgId !== user.orgId || plan.operation !== MODULE_RECORDS || plan.status !== "approved"
    || plan.applyClaim?.replica !== "hosted" || plan.applyClaim.id !== args.claimId
    || args.claimId !== `hosted:${plan._id}:${user._id}:${plan.applyClaim.claimedAt}`) throw new ConvexError("The approved hosted module plan is not claimed by this applier");
  const granted = await ctx.db.query("moduleGrantUses").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).first();
  if (granted) throw new ConvexError("Granted plans use their grant executor");
  const operations = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(MAX_PROPOSAL_ROWS + 1);
  if (operations.length > MAX_PROPOSAL_ROWS) throw new ConvexError("The module plan exceeds the proposal row limit");
  const approved = new Set(plan.approvedOperationIds ?? []);
  return { user, plan, operations: operations.filter((o) => o.orgId === user.orgId && o.packageOpId && approved.has(o.packageOpId)) };
}

export const hostedRows = internalQuery({
  args: { patchPlanId: v.id("patchPlans"), claimId: v.string() },
  handler: async (ctx, args): Promise<{ args: unknown; operations: Doc<"patchOperations">[] }> => {
    const { plan, operations } = await hostedRecordPlan(ctx, args);
    return { args: plan.args ?? {}, operations };
  },
});

/** The approved row, ledger create, deal edge and canonical receipt share this transaction. */
export const applyMeeting = internalMutation({
  args: { patchPlanId: v.id("patchPlans"), operationId: v.id("patchOperations"), claimId: v.string() },
  handler: async (ctx, args): Promise<{ operation: "meetings.log"; object: "meeting"; streamId: string }> => {
    const { user, plan, operations } = await hostedRecordPlan(ctx, args);
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person can apply a meeting proposal");
    const proposal = plan.args as RecordProposalArgs;
    const op = operations.find((o) => o._id === args.operationId);
    const before = op?.beforeValue as { kind?: unknown; dealStreamId?: unknown } | undefined;
    if (proposal.operation !== "meetings.log" || operations.length !== 1 || !op || op.objectType !== "meeting" || op.fieldOrAction !== "create" || before?.kind !== "meeting.create"
      || canonicalJson(op.afterValue) !== canonicalJson(proposal.args)) throw new ConvexError("The selected operation is not the approved meeting create");
    const access = await requireWriteAccess(ctx, user);
    const row = await meetingProposalRow(ctx, user.orgId, access, op.afterValue as MeetingLogArgs);
    if (row.id !== op.objectId || row.dealStreamId !== before.dealStreamId) throw new ConvexError("The proposed deal target changed");
    const meeting = canonicalMeetingArgs(row.meeting);
    const values = { title: meeting.title, startAt: meeting.startAt, ownerId: meeting.ownerId,
      ...(meeting.endAt !== undefined ? { endAt: meeting.endAt } : {}), ...(meeting.notes !== undefined ? { notes: meeting.notes } : {}), ...(meeting.location !== undefined ? { location: meeting.location } : {}) };
    const writable = { ...values, dealId: row.dealStreamId };
    await requireWritable(ctx, user, access, "meeting", "create", undefined, writable);
    const prior = op.providerData as { operation?: unknown; object?: unknown; streamId?: unknown } | undefined;
    if (prior?.operation === "meetings.log" && prior.object === "meeting" && typeof prior.streamId === "string") {
      await ctx.db.patch(op._id, { status: "applied", error: undefined, updatedAt: Date.now() });
      return { operation: "meetings.log", object: "meeting", streamId: prior.streamId };
    }
    const result = await saveAsCaller(ctx, user, "meeting", { op: "create", values: writable }, { moduleProposal: { module: proposal.module, plan: plan._id } });
    if (result.status !== "applied") throw new ConvexError(`Meeting creation was not applied (${result.status})`);
    await attachTargets(ctx, user, result.streamId, [row.dealStreamId]);
    const receipt = { operation: "meetings.log" as const, object: "meeting" as const, streamId: result.streamId };
    await ctx.db.patch(op._id, { status: "applied", providerData: receipt, error: undefined, updatedAt: Date.now() });
    return receipt;
  },
});

/**
 * Each approved row written as `caller` (the person applying it, or the admin whose standing grant approved it), CAS on
 * its version; the per-row results and the outcome kept on the plan.
 */
export async function applyRecordRows(ctx: ActionCtx, caller: { orgId: string; userId: string; access: Access }, args: { patchPlanId: Id<"patchPlans">; operations: unknown[]; args?: unknown; claimId?: string }): Promise<{ applied: number; skipped: number; failed: number }> {
  const client = clientFor(ctx);
  const results: Result[] = [];
  const outcome: AppliedOutcome = { applied: 0, skipped: 0, failed: 0, skippedRows: [] };
  for (const op of args.operations as Row[]) {
    const before = (op.beforeValue ?? {}) as { value?: string | null; version?: number; name?: string };
    const row: ProposalSetRow = { id: String(op.objectId), name: before.name ?? String(op.objectId), field: op.fieldOrAction, before: before.value ?? null, after: String(op.afterValue), version: Number(before.version) };
    try {
      if (op.objectType === "meeting") {
        if (!args.claimId) throw new ConvexError("Meeting creation requires a person's hosted approval claim");
        await ctx.runMutation(internal.moduleRecords.applyMeeting, { patchPlanId: args.patchPlanId, operationId: op._id, claimId: args.claimId });
        outcome.applied++;
        continue;
      }
      if (op.objectType === "targetPlan") {
        // The year's plan, re-read: written only while it holds the total and version the proposal read.
        const proposed = ((args.args as { args?: TargetsSetArgs } | undefined)?.args ?? {}) as TargetsSetArgs;
        const now = await ctx.runQuery(internal.targets.planOf, { orgId: caller.orgId as Id<"organizations">, year: proposed.year });
        const judged = judgeRow(row, now ? { version: now.updatedAt, value: String(now.total) } : row.version === 0 ? { version: 0, value: null } : null);
        if (judged.status === "conflict") {
          outcome.skipped++;
          outcome.skippedRows.push({ id: row.id, name: row.name, why: judged.why });
          results.push({ operationId: op._id, status: "conflict", error: `${row.name}: ${judged.why}` });
          continue;
        }
        // Canon's own save, as the approver: their targets.set capability, the plan's other choices kept.
        // The version the proposal read goes into the save: a target saved since refuses in the write's own transaction.
        await ctx.runAction(api.targets.set, {
          expect: row.version === 0 ? null : row.version,
          year: proposed.year, total: proposed.total, coverage: now?.coverage ?? 3,
          months: proposed.months ? { method: "custom", custom: proposed.months } : now?.months ?? { method: "even" },
          teams: now?.teams ?? { method: "even" }, reps: now?.reps ?? { method: "capacity" },
        });
        outcome.applied++;
        results.push({ operationId: op._id, status: "applied" });
        continue;
      }
      const account = (await client.get(caller.orgId, row.id))?.account ?? null;
      const judged = judgeRow(row, account ? { version: account.updatedAt, value: account.ownerId ?? null } : null);
      if (judged.status === "conflict") {
        outcome.skipped++;
        if (outcome.skippedRows.length < MAX_SKIPPED_NAMED) outcome.skippedRows.push({ id: row.id, name: row.name, why: judged.why });
        results.push({ operationId: op._id, status: "conflict", error: `${row.name}: ${judged.why}` });
        continue;
      }
      // The ledger writes it only while the record still holds the value the proposal read, in its own transaction.
      await editPartyRecord(await recordEditPorts(ctx, caller, {
        object: "account", id: row.id, patch: { [row.field]: row.after }, idempotencyKey: `plan:${args.patchPlanId}:${op.packageOpId ?? op._id}`, expect: { [row.field]: row.before },
      }, "edit"));
      outcome.applied++;
      results.push({ operationId: op._id, status: "applied" });
    } catch (cause) {
      if (op.objectType === "meeting") throw cause;
      if (cause instanceof EditConflictError || (cause instanceof ConvexError && String(cause.data).includes(TARGET_CHANGED))) {
        outcome.skipped++;
        const why = "changed since it was proposed";
        if (outcome.skippedRows.length < MAX_SKIPPED_NAMED) outcome.skippedRows.push({ id: row.id, name: row.name, why });
        results.push({ operationId: op._id, status: "conflict", error: `${row.name}: ${why}` });
        continue;
      }
      outcome.failed++;
      results.push({ operationId: op._id, status: "failed", error: cause instanceof Error ? (cause as { data?: unknown }).data ? String((cause as { data?: unknown }).data) : cause.message : String(cause) });
    }
  }
  for (const chunk of chunked(results, 200, 200_000)) await ctx.runMutation(internal.patchPlans.recordOperationResults, { results: chunk });
  await ctx.runMutation(internal.patchPlans.recordPatchPlanRun, { patchPlanId: args.patchPlanId, runRecord: { outcome } });
  return { applied: outcome.applied, skipped: outcome.skipped, failed: outcome.failed };
}
