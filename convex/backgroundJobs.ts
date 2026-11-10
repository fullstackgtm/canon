/**
 * Background jobs shown in the activity tray. Writers create a job, patch its
 * detail/phases as work progresses, and finish it; the tray reads them through
 * activity.background. A processing job that stops updating is reported as
 * stalled there rather than spinning forever.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const status = v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"));
const kind = v.union(v.literal("contact_sweep"), v.literal("conversation_intake"), v.literal("meeting_import"), v.literal("deal_gaps"), v.literal("field_consolidation"), v.literal("unique_field"));
const phase = v.object({ key: v.string(), label: v.string(), status, count: v.optional(v.number()), done: v.optional(v.number()), total: v.optional(v.number()), note: v.optional(v.string()) });

export const create = internalMutation({
  args: { orgId: v.id("organizations"), kind, userId: v.optional(v.id("users")), title: v.string(), detail: v.optional(v.string()), href: v.string(), phases: v.array(phase) },
  handler: async (ctx, args) => {
    const now = Date.now();
    return ctx.db.insert("backgroundJobs", { ...args, status: "processing", startedAt: now, updatedAt: now });
  },
});

export const update = internalMutation({
  args: {
    jobId: v.id("backgroundJobs"),
    detail: v.optional(v.string()),
    phases: v.optional(v.array(phase)),
    status: v.optional(status),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, ...patch }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return;
    const now = Date.now();
    const done = patch.status === "completed" || patch.status === "failed";
    await ctx.db.patch(jobId, { ...patch, updatedAt: now, ...(done ? { completedAt: now } : {}) });
  },
});
