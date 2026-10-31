import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireCap } from "../lib";

export async function stopPopulation(ctx: MutationCtx, args: { jobId: Id<"backgroundJobs"> }) {
  const user = await requireCap(ctx, "strategy.edit");
  const job = await ctx.db.get(args.jobId);
  if (!job || job.orgId !== user.orgId || job.counters?.pending === undefined) throw new Error("No such population");
  if (job.status !== "processing" || job.counters.stopped) return null;
  await ctx.db.patch(args.jobId, { counters: { ...job.counters, stopped: 1, stoppedByUser: 1 }, detail: "Stopping…", updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.populateActions.settleStopped, { jobId: args.jobId });
  return null;
}
