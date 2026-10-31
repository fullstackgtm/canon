import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { unrestrictedUser } from "./permissions";
import { mergeReports, type CoverageReport } from "./lib/enrich/freeFill";

/**
 * A free fill coverage check as a resumable job (convex/enrichFreeFill.ts): readers walk the portal a chunk at a
 * time, each chunk is matched by its own action in parallel, and the matches merge here into one report.
 */

export type IndexLookup = { mode: string; version: string | null; domains: number; rows: number; error: string | null };

export const start = internalMutation({
  args: { orgId: v.id("organizations"), userId: v.id("users"), runKey: v.string(), total: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("freeFillRuns").withIndex("by_runKey", (q) => q.eq("runKey", args.runKey)).unique();
    if (existing) throw new Error("This run key is already in use.");
    await ctx.db.insert("freeFillRuns", {
      orgId: args.orgId, userId: args.userId, runKey: args.runKey, stage: "reading", read: 0, total: args.total,
      chunks: 0, matchedChunks: 0, readDone: false, updatedAt: Date.now(),
    });
    return null;
  },
});

async function runOf(ctx: { db: any }, runKey: string) {
  return await ctx.db.query("freeFillRuns").withIndex("by_runKey", (q: any) => q.eq("runKey", runKey)).unique();
}

/** Whether the job should keep going: it exists and hasn't failed. */
export const live = internalQuery({
  args: { runKey: v.string() },
  handler: async (ctx, args) => {
    const run = await runOf(ctx, args.runKey);
    return Boolean(run && run.stage !== "error");
  },
});

/** A reader finished one chunk; `last` when the portal (or the cap) is exhausted. */
export const chunkRead = internalMutation({
  args: { runKey: v.string(), companies: v.number(), last: v.boolean(), capped: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const run = await runOf(ctx, args.runKey);
    if (!run || run.stage === "error") return null;
    const chunks = (run.chunks ?? 0) + (args.companies > 0 ? 1 : 0);
    const read = run.read + args.companies;
    const finished = args.last && (run.matchedChunks ?? 0) >= chunks;
    await ctx.db.patch(run._id, {
      read, chunks, readDone: args.last, ...(args.capped ? { capped: true } : {}),
      stage: finished ? "done" : args.last ? "matching" : "reading",
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** A matcher finished one chunk: fold its report and lookup counts into the run's. */
export const chunkMatched = internalMutation({
  args: { runKey: v.string(), report: v.any(), lookup: v.any() },
  handler: async (ctx, args) => {
    const run = await runOf(ctx, args.runKey);
    if (!run || run.stage === "error") return null;
    const chunk = args.lookup as IndexLookup;
    const prev = run.lookup as IndexLookup | undefined;
    const lookup: IndexLookup = prev
      ? { mode: chunk.mode, version: chunk.version ?? prev.version, domains: prev.domains + chunk.domains, rows: prev.rows + chunk.rows, error: prev.error ?? chunk.error }
      : chunk;
    const matchedChunks = (run.matchedChunks ?? 0) + 1;
    const finished = run.readDone && matchedChunks >= (run.chunks ?? 0);
    await ctx.db.patch(run._id, {
      report: mergeReports((run.report as CoverageReport | undefined) ?? null, args.report as CoverageReport),
      lookup, matchedChunks,
      stage: finished ? "done" : run.stage,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const fail = internalMutation({
  args: { runKey: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const run = await runOf(ctx, args.runKey);
    if (run) await ctx.db.patch(run._id, { stage: "error", error: args.error.slice(0, 500), updatedAt: Date.now() });
    return null;
  },
});

/** The caller's own run in their current workspace: progress, and the report as it builds. */
export const progress = query({
  args: { runKey: v.string() },
  handler: async (ctx, args) => {
    // The report names companies across the whole portal: re-checked on every read, so narrowed access hides it.
    const user = await unrestrictedUser(ctx);
    if (!user) return null;
    const run = await runOf(ctx, args.runKey);
    if (!run || run.userId !== user._id || run.orgId !== user.orgId) return null;
    return {
      stage: run.stage,
      read: run.read,
      total: run.total ?? null,
      chunks: run.chunks ?? 0,
      matchedChunks: run.matchedChunks ?? 0,
      truncated: Boolean(run.capped),
      report: (run.report as CoverageReport | undefined) ?? null,
      lookup: (run.lookup as IndexLookup | undefined) ?? null,
      error: run.error ?? null,
    };
  },
});
