import { ConvexError, v } from "convex/values";
import { action, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { piServiceHeaders, signWatchTicket } from "./lib/piRuntimeTokens";
import { piFixtureRun, piResearchEnabled, piWorkerUrl } from "./lib/research/piEnablement";
import { PUBLIC_LOCAL_FIXTURE_KEY } from "./lib/research/piFixture";

export const start = internalAction({
  args: { runId: v.id("researchRuns"), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const loaded = await ctx.runQuery(internal.piResearch.context, { runId: args.runId });
    if (loaded.run.status !== "running") return null;
    if (!piResearchEnabled(loaded.run.orgId)) {
      await ctx.runMutation(internal.researchAgents.progressRun, { runId: args.runId, set: { status: "failed", error: "Pi research is disabled on this deployment." } });
      return null;
    }
    try {
      const url = new URL(`/runs/${args.runId}`, piWorkerUrl());
      const response = await fetch(url, { method: "POST", headers: await piServiceHeaders(process.env.CANON_PI_SECRET!, "POST", url.pathname), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Pi Worker refused admission");
    } catch {
      const attempt = args.attempt ?? 0;
      if (attempt >= 5) await ctx.runMutation(internal.piResearch.fail, { runId: args.runId });
      else await ctx.scheduler.runAfter(Math.min(120_000, 15_000 * 2 ** attempt), internal.piRuntime.start, { runId: args.runId, attempt: attempt + 1 });
    }
    return null;
  },
});

export const viewer = internalQuery({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args): Promise<{ viewerId: Id<"users">; runId: Id<"researchRuns">; fixtureOrigin: string | null } | null> => {
    const user = await requireUser(ctx);
    const run = await ctx.db.get(args.runId);
    if (!run || run.orgId !== user.orgId || run.runtime !== "pi" || (!piResearchEnabled(user.orgId) && !piFixtureRun(run))) return null;
    return { viewerId: user._id, runId: run._id, fixtureOrigin: piFixtureRun(run) ? run.piFixtureOrigin ?? null : null };
  },
});

export const watch = action({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number }> => {
    const viewer = await ctx.runQuery(internal.piRuntime.viewer, args);
    if (!viewer) throw new ConvexError("Pi run unavailable");
    const now = Date.now();
    const url = new URL(`/runs/${viewer.runId}`, viewer.fixtureOrigin ?? piWorkerUrl());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", await signWatchTicket(viewer.fixtureOrigin ? PUBLIC_LOCAL_FIXTURE_KEY : process.env.CANON_PI_SECRET!, viewer.runId, viewer.viewerId, now));
    return { url: url.toString(), expiresAt: now + 60_000 };
  },
});
