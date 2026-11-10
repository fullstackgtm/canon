import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export const fitState = (ctx: Pick<MutationCtx, "db">, orgId: Id<"organizations">) =>
  ctx.db.query("fitReconciliations").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();

/** Called in the transaction that changes the definitions or model, never after its commit. */
export async function invalidateFit(ctx: MutationCtx, orgId: Id<"organizations">): Promise<Doc<"fitReconciliations">> {
  const row = await fitState(ctx, orgId);
  const revision = (row?.revision ?? 0) + 1;
  const generation = (row?.generation ?? 0) + (row?.queued ? 0 : 1);
  if (!row?.queued) await ctx.scheduler.runAfter(0, internal.fitReconciler.reconcile, { orgId, generation });
  const data = { revision, generation, queued: true };
  if (row) {
    await ctx.db.patch(row._id, data);
    return { ...row, ...data };
  }
  const _id = await ctx.db.insert("fitReconciliations", { orgId, acknowledgedRevision: 0, ...data });
  return (await ctx.db.get(_id))!;
}
