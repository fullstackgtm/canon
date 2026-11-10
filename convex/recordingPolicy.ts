import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { can } from "./lib/capabilities";
import { policyOf, readPolicy, recordingPolicyFields, writePolicy } from "./lib/recordingPolicy";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user && can(user, "recording.manage") ? readPolicy(ctx, user.orgId) : null;
  },
});

export const save = mutation({
  args: recordingPolicyFields,
  handler: async (ctx, args) => writePolicy(ctx, await requireUser(ctx), args),
});

/** A human runs this on dev, then production. It preserves existing policies and schedules every page. */
export const backfillDialerSettings = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("dialerSettings").paginate({ cursor: cursor ?? null, numItems: 200 });
    let created = 0;
    for (const legacy of page.page) {
      const existing = await ctx.db.query("recordingPolicy").withIndex("by_orgId", (q) => q.eq("orgId", legacy.orgId)).unique();
      if (existing) continue;
      const org = await ctx.db.get(legacy.orgId);
      if (!org) continue;
      const policy = policyOf(null, { ...org, callRecording: legacy.record });
      await ctx.db.insert("recordingPolicy", { orgId: legacy.orgId, ...policy, updatedBy: legacy.updatedBy, updatedAt: legacy.updatedAt });
      await ctx.db.insert("operationAuditLog", {
        orgId: legacy.orgId, userId: legacy.updatedBy, verb: "do", operation: "recording_policy.migrate", status: "applied",
        details: { callRecording: legacy.record }, createdAt: Date.now(),
      });
      created++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.recordingPolicy.backfillDialerSettings, { cursor: page.continueCursor });
    return { created, done: page.isDone };
  },
});
