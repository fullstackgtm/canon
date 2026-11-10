/**
 * Receipts of a module's hosted AI steps (docs/modules.md, "Hosted AI steps"): one row per run. The call's action
 * (convex/lib/modules/ai.ts) reserves a run against its `budget.perDay` before the model runs, so runs started together
 * never pass it, and finishes the row once the run has applied or failed. No module docs: those are read and written
 * only through convex/lib/modules/scope.ts.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { principalAccess } from "./permissions";
import type { Access } from "./lib/access";

/** The most of a person's runs since a time one count reads: past it, the budget (1,000 a day at most) is spent anyway. */
const SINCE_MAX = 2000;
const dropped = v.array(v.object({ path: v.string(), quote: v.string(), why: v.string() }));

/**
 * Start a run of `call` as `userId`, when they ran it fewer than `perDay` times since `since`: its receipt, `running`.
 * Null when the budget is spent. One mutation, so runs started together are counted one after another.
 */
export const reserve = internalMutation({
  args: {
    orgId: v.id("organizations"), moduleId: v.string(), call: v.string(), key: v.string(), userId: v.id("users"), since: v.number(), perDay: v.number(),
    promptVersion: v.string(), inputChars: v.number(), reads: v.array(v.object({ name: v.string(), ids: v.array(v.string()) })),
  },
  handler: async (ctx, a): Promise<{ id: string; ran: number } | { id: null; ran: number }> => {
    const rows = await ctx.db.query("moduleAiRuns").withIndex("by_orgId_userId_at", (q) => q.eq("orgId", a.orgId).eq("userId", a.userId).gte("at", a.since)).take(SINCE_MAX);
    const ran = rows.filter((r) => r.moduleId === a.moduleId && r.call === a.call).length;
    if (ran >= a.perDay) return { id: null, ran };
    const { since: _s, perDay: _p, ...row } = a;
    const id = await ctx.db.insert("moduleAiRuns", { ...row, status: "running", provider: "", model: "", kept: 0, dropped: [], ms: 0, at: Date.now() });
    return { id, ran };
  },
});

/** A run's receipt, finished: done or failed, on which model, what it kept and dropped, its credits or its error. */
export const finish = internalMutation({
  args: {
    id: v.id("moduleAiRuns"), status: v.union(v.literal("done"), v.literal("failed")), provider: v.string(), model: v.string(),
    kept: v.number(), dropped, creditsMicro: v.optional(v.number()), error: v.optional(v.string()), ms: v.number(), inputChars: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...a }): Promise<null> => {
    await ctx.db.patch(id, a);
    return null;
  },
});

/** A member's access with no session (permissions.principalAccess): what a background AI step reads records as. */
export const accessOf = internalQuery({
  args: { orgId: v.id("organizations"), userId: v.id("users") },
  handler: async (ctx, a): Promise<Access> => {
    const [access] = (await principalAccess(ctx, a.orgId, [a.userId])) ?? [];
    if (!access) throw new Error("That member is no longer in the workspace.");
    return access;
  },
});
