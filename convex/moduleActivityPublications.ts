import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { activityHead } from "./lib/modules/activityCapture";
import { publishActivityStep } from "./lib/modules/activityPublication";
import { adoptActivityBaselines } from "./lib/modules/jobs";
import { manifestOf } from "./lib/modules/packages";

export const next = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const head = await activityHead(ctx.db, orgId);
    if (!head?.pending) return null;
    const row = await ctx.db.query("moduleActivityPublications").withIndex("by_orgId_ordinal", (q) => q.eq("orgId", orgId).eq("ordinal", head.publishedOrdinal + 1)).unique();
    return !row || row.state === "lifecycle" || (row.retryAt !== null && row.retryAt > Date.now()) ? null : { id: row._id, revision: row.revision };
  },
});
export const step = internalMutation({
  args: { id: v.id("moduleActivityPublications"), revision: v.number() },
  handler: async (ctx, { id, revision }) => publishActivityStep(ctx, id, revision),
});
export const failed = internalMutation({
  args: { id: v.id("moduleActivityPublications"), revision: v.number(), error: v.string() },
  handler: async (ctx, { id, revision, error }) => {
    const row = await ctx.db.get(id);
    if (!row || row.revision !== revision || row.state === "complete" || row.state === "lifecycle") return null;
    const attempt = row.attempt + 1, wait = Math.min(300_000, 5_000 * 2 ** Math.min(attempt - 1, 6));
    await ctx.db.patch(id, { state: "failed", attempt, error: error.slice(0, 500), retryAt: Date.now() + wait, revision: revision + 1 });
    await ctx.scheduler.runAfter(wait, internal.moduleActivityPublications.run, { orgId: row.orgId });
    return null;
  },
});
export const run = internalAction({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }): Promise<null> => {
    const started = Date.now();
    let folds = 0;
    for (let steps = 0; steps < 3000 && folds <= 2997 && Date.now() - started < 60_000; steps++) {
      const at: { id: Id<"moduleActivityPublications">; revision: number } | null = await ctx.runQuery(internal.moduleActivityPublications.next, { orgId });
      if (!at) return null;
      try {
        const result: { more: boolean; revision: number; folds: number } = await ctx.runMutation(internal.moduleActivityPublications.step, at);
        folds += result.folds;
        if (!result.more && result.revision === at.revision) return null;
      } catch (error) {
        await ctx.runMutation(internal.moduleActivityPublications.failed, { ...at, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }
    await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.run, { orgId });
    return null;
  },
});
/** Recovery visits pending org heads, including uninstalled and disabled sources. */
export const wake = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<null> => {
    const page = await ctx.db.query("moduleActivityHeads").withIndex("by_pending_orgId", (q) => q.eq("pending", true)).paginate({ numItems: 50, cursor: cursor ?? null });
    for (const row of page.page) await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.run, { orgId: row.orgId });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.wake, { cursor: page.continueCursor });
    return null;
  },
});
/** Baseline adoption never consumes journal rows and includes disabled legacy watches. */
export const adopt = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<null> => {
    const page = await ctx.db.query("modulePackages").withIndex("by_status", (q) => q.eq("status", "installed")).paginate({ numItems: 50, cursor: cursor ?? null });
    for (const pkg of page.page) await adoptActivityBaselines(ctx, pkg, manifestOf(pkg));
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.moduleActivityPublications.adopt, { cursor: page.continueCursor });
    return null;
  },
});
