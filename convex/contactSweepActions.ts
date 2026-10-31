/**
 * Compatibility only: the pipe0 contact sweep this module ran is replaced by
 * CRM population (populateActions.ts). Batches scheduled before that deploy
 * still call these functions, so they close the old sweep job instead of
 * failing against a missing function and leaving it "processing" forever.
 * Remove once no contact_sweep job from before the change is still open.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const RETIRED = "This contact sweep was replaced by CRM population. Claim a research session again to populate your CRM.";

export const runBatch = internalAction({
  args: { sessionId: v.id("researchSessions"), jobId: v.id("backgroundJobs"), batch: v.number() },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.contactSweepActions.retire, { jobId: args.jobId, sessionId: args.sessionId });
    return null;
  },
});

export const recordBatch = internalMutation({
  args: {
    jobId: v.id("backgroundJobs"),
    sessionId: v.id("researchSessions"),
    accounts: v.number(),
    accountsTotal: v.number(),
    batchesTotal: v.number(),
    people: v.number(),
    accountsWithPeople: v.number(),
    credits: v.number(),
    failedAccounts: v.number(),
  },
  handler: async (ctx, a) => {
    await retireJob(ctx, a.jobId, a.sessionId);
    return null;
  },
});

export const retire = internalMutation({
  args: { jobId: v.id("backgroundJobs"), sessionId: v.id("researchSessions") },
  handler: async (ctx, a) => {
    await retireJob(ctx, a.jobId, a.sessionId);
    return null;
  },
});

async function retireJob(ctx: MutationCtx, jobId: Id<"backgroundJobs">, sessionId: Id<"researchSessions">) {
  const job = await ctx.db.get(jobId);
  const now = Date.now();
  if (job && job.status === "processing") {
    await ctx.db.patch(jobId, {
      status: "completed",
      detail: RETIRED,
      phases: job.phases.map((p) => ({ ...p, status: "completed" as const })),
      updatedAt: now,
      completedAt: now,
    });
    await ctx.db.patch(sessionId, { contactsNote: RETIRED, updatedAt: now });
  }
}
