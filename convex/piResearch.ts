import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { loadResearchRun } from "./researchAgents";
import { ID } from "./lib/canon/identity";
import { attributeFor, evidenceText, PROMPT_VERSION, RUN_CAP, type FetchedPage, type TraceStep } from "./lib/research/agentLoop";
import { piContextStamp, piEligible, piFinding, piSpecJson, piVerifiedFinding, type PiLanding } from "./lib/research/piProtocol";
import { piFixtureRun, piResearchEnabled } from "./lib/research/piEnablement";

export async function loadPiRun(ctx: QueryCtx, runId: Id<"researchRuns">) {
  const loaded = await loadResearchRun(ctx, runId);
  if (!loaded || loaded.run.runtime !== "pi" || !loaded.spec || !loaded.agent || !piEligible(loaded.run, loaded.spec)) throw new ConvexError("Pi run unavailable");
  return loaded as typeof loaded & { spec: NonNullable<typeof loaded.spec>; agent: NonNullable<typeof loaded.agent> };
}

async function active(ctx: QueryCtx, runId: Id<"researchRuns">, stamp?: string) {
  const loaded = await loadPiRun(ctx, runId);
  if (!piResearchEnabled(loaded.run.orgId) && !piFixtureRun(loaded.run)) throw new ConvexError("Pi research is disabled");
  if (loaded.run.status !== "running" || loaded.standing?.status !== "active" || !loaded.principals) throw new ConvexError("Pi run stopped");
  if (stamp !== undefined && stamp !== piContextStamp(loaded)) throw new ConvexError("Pi authorization changed; retry with current access");
  return loaded;
}

export const context = internalQuery({ args: { runId: v.id("researchRuns") }, handler: (ctx, args) => loadPiRun(ctx, args.runId) });

export const fail = internalMutation({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run?.runtime === "pi" && run.status === "running") await ctx.db.patch(run._id, { status: "failed", error: "The Pi runtime could not finish this run. Its landed answers are preserved.", updatedAt: Date.now() });
    return null;
  },
});

export const step = internalQuery({
  args: { runId: v.id("researchRuns"), index: v.number() },
  handler: async (ctx, args) => {
    await loadPiRun(ctx, args.runId);
    return ctx.db.query("piResearchSteps").withIndex("by_runId_and_index", (q) => q.eq("runId", args.runId).eq("index", args.index)).unique();
  },
});

export const stage = internalMutation({
  args: {
    runId: v.id("researchRuns"), index: v.number(), stamp: v.string(), total: v.number(),
    record: v.union(v.null(), v.object({ recordId: v.string(), entityId: v.id("canonEntities"), label: v.string(), subjectJson: v.string() })),
    nextCursor: v.union(v.string(), v.null()), skipped: v.number(), finished: v.boolean(),
  },
  handler: async (ctx, args) => {
    const loaded = await active(ctx, args.runId, args.stamp);
    const previous = await ctx.db.query("piResearchSteps").withIndex("by_runId_and_index", (q) => q.eq("runId", args.runId).eq("index", args.index)).unique();
    if (previous) return previous;
    if (!Number.isSafeInteger(args.index) || args.index !== (loaded.run.piStep ?? 0)) throw new ConvexError("Pi step out of order");
    if (args.record) {
      const entity = await ctx.db.get(args.record.entityId);
      const external = await ctx.db.query("canonExternalIds").withIndex("by_orgId_provider_externalId", (q) => q.eq("orgId", loaded.run.orgId).eq("provider", ID.recordAccount).eq("externalId", args.record!.recordId)).unique();
      if (!entity || entity.orgId !== loaded.run.orgId || external?.entityId !== entity._id) throw new ConvexError("Pi record identity changed");
    }
    const id = await ctx.db.insert("piResearchSteps", {
      runId: args.runId, index: args.index,
      ...(args.record ? { record: { ...args.record, specJson: piSpecJson(loaded.spec) } } : {}),
      nextCursor: args.nextCursor, skipped: args.skipped, finished: args.finished, createdAt: Date.now(),
    });
    if (loaded.run.planned === 0) await ctx.db.patch(args.runId, { inScope: args.total, planned: Math.min(args.total, RUN_CAP), updatedAt: Date.now() });
    return (await ctx.db.get(id))!;
  },
});

export const status = internalMutation({
  args: { runId: v.id("researchRuns"), stepId: v.id("piResearchSteps") },
  handler: async (ctx, args): Promise<PiLanding | null> => {
    const loaded = await loadPiRun(ctx, args.runId);
    const row = await ctx.db.get(args.stepId);
    if (!row || row.runId !== args.runId) throw new ConvexError("Pi step unavailable");
    if (row.landed) return row.landed;
    if (loaded.standing?.status !== "active") await ctx.runMutation(internal.researchAgents.stopIfInactive, { runId: args.runId });
    if (!loaded.principals && loaded.run.status === "running") await ctx.db.patch(args.runId, { status: "cancelled", error: "A run principal is no longer a workspace member.", updatedAt: Date.now() });
    return loaded.run.status !== "running" || loaded.standing?.status !== "active" || !loaded.principals ? { finished: true, completed: loaded.run.done + loaded.run.errors } : null;
  },
});

export const effect = internalMutation({
  args: {
    runId: v.id("researchRuns"), stepId: v.id("piResearchSteps"), stamp: v.string(), key: v.string(),
    operation: v.union(v.literal("read"), v.literal("search"), v.literal("model")), request: v.string(), response: v.optional(v.string()), model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const loaded = await active(ctx, args.runId, args.stamp);
    const row = await ctx.db.get(args.stepId);
    if (!row || row.runId !== args.runId || !row.record || row.landed || row.index !== (loaded.run.piStep ?? 0) || row.record.specJson !== piSpecJson(loaded.spec)) throw new ConvexError("Pi step unavailable");
    if (!/^(read|model|search):[0-9]{1,2}$/.test(args.key) || !args.key.startsWith(`${args.operation}:`) || args.request.length > 80_000 || (args.response?.length ?? 0) > 180_000) throw new ConvexError("Pi effect exceeds its bounds");
    const previous = await ctx.db.query("piResearchEffects").withIndex("by_stepId_and_key", (q) => q.eq("stepId", args.stepId).eq("key", args.key)).unique();
    if (previous) {
      if (previous.operation !== args.operation || previous.request !== args.request) throw new ConvexError("Pi effect identity changed");
      if (previous.response !== undefined || args.response === undefined) return previous;
      await ctx.db.patch(previous._id, { response: args.response, ...(args.model ? { model: args.model.slice(0, 120) } : {}) });
      return { ...previous, response: args.response };
    }
    const effects = await ctx.db.query("piResearchEffects").withIndex("by_stepId_and_key", (q) => q.eq("stepId", args.stepId)).take(33);
    const limit = { read: 20, search: 2, model: 5 }[args.operation];
    if (effects.length >= 32 || effects.filter((e) => e.operation === args.operation).length >= limit) throw new ConvexError("Pi effect budget exhausted");
    if (Date.now() - row.createdAt > 90_000) throw new ConvexError("Pi record deadline exceeded");
    if (args.response !== undefined) throw new ConvexError("Reserve a Pi effect before executing it");
    const id = await ctx.db.insert("piResearchEffects", { stepId: args.stepId, key: args.key, operation: args.operation, request: args.request });
    return (await ctx.db.get(id))!;
  },
});

export const land = internalMutation({
  args: { runId: v.id("researchRuns"), stepId: v.id("piResearchSteps"), stamp: v.string(), finding: piFinding, ms: v.number() },
  handler: async (ctx, args): Promise<PiLanding> => {
    const loaded = await loadPiRun(ctx, args.runId);
    const row = await ctx.db.get(args.stepId);
    if (!row || row.runId !== args.runId) throw new ConvexError("Pi step unavailable");
    if (row.landed) return row.landed;
    await active(ctx, args.runId, args.stamp);
    if (row.index !== (loaded.run.piStep ?? 0) || (row.record && row.record.specJson !== piSpecJson(loaded.spec))) throw new ConvexError("Pi step changed");
    const effects = await ctx.db.query("piResearchEffects").withIndex("by_stepId_and_key", (q) => q.eq("stepId", args.stepId)).take(33);
    const pages: FetchedPage[] = [];
    const steps: TraceStep[] = [];
    let calls = 0;
    for (const e of effects.sort((a, b) => Number(a.key.split(":")[1]) - Number(b.key.split(":")[1]))) {
      if (e.response === undefined) continue;
      const value = JSON.parse(e.response);
      if (e.operation === "read") {
        if (value) pages.push(value);
        steps.push({ kind: "read", url: JSON.parse(e.request).url.slice(0, 500), ok: !!value });
      } else if (e.operation === "search") {
        pages.push(...value.pages);
        calls += value.calls;
        steps.push({ kind: "search", query: JSON.parse(e.request).query.slice(0, 500), pages: value.pages.length });
      } else {
        calls++;
        if (["read", "search", "answer"].includes(value.action)) steps.push({ kind: "model", action: value.action });
      }
    }
    const finding = piVerifiedFinding(loaded.spec, args.finding, pages);
    const add = { done: 0, skipped: row.skipped, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: pages.length, llmCalls: calls };
    let outcome: { status: "answered" | "unknown" | "no_evidence" | "error" | "rejected"; value?: string; quote?: string; sourceUrl?: string; reason?: string } = { status: finding.status };
    if (row.record) {
      if (finding.status === "error") { add.errors = 1; outcome.reason = finding.reason; }
      else {
        add.done = 1;
        if (finding.status === "answered") {
          add.answered = 1;
          const result = await ctx.runMutation(internal.researchAgents.submitAnswers, {
            runId: args.runId,
            facts: [{ entityType: "account", entityId: row.record.entityId, attribute: attributeFor(loaded.agent.slug), value: finding.value, evidence: evidenceText(finding), confidence: finding.confidence }],
            admitted: [row.record.recordId],
          });
          if (!result) throw new ConvexError("Pi run stopped before landing");
          outcome = result.rejected.length
            ? { status: "rejected", reason: result.rejected[0].reason }
            : { status: "answered", value: String(finding.value), quote: finding.quote.slice(0, 300), sourceUrl: finding.sourceUrl.slice(0, 500) };
        } else {
          if (finding.status === "unknown") add.unknown = 1;
          else add.noEvidence = 1;
          outcome.reason = finding.reason;
          await ctx.runMutation(internal.researchAgents.recordAttempts, { runId: args.runId, entityIds: [row.record.entityId] });
        }
      }
    }
    if (pages.length) await ctx.runMutation(internal.researchAgents.savePages, { orgId: loaded.run.orgId, pages: pages.map(({ url, text }) => ({ url, text })) });
    const finished = row.finished || loaded.run.done + loaded.run.errors + add.done + add.errors >= loaded.run.planned;
    const state: "running" | "stopped" = await ctx.runMutation(internal.researchAgents.progressRun, {
      runId: args.runId, set: { ...(row.nextCursor ? { cursor: row.nextCursor } : {}), ...(finished ? { status: "done" as const } : {}) }, add,
      traces: row.record ? [{ ...outcome, recordId: row.record.recordId, label: row.record.label.slice(0, 300), steps, calls, ms: Math.max(0, Math.min(90_000, args.ms)), model: effects.find((e) => e.operation === "model")?.model ?? "pi-ai", promptVersion: PROMPT_VERSION }] : [],
    });
    const result = { finished: finished || state === "stopped", completed: loaded.run.done + loaded.run.errors + add.done + add.errors };
    await ctx.db.patch(args.runId, { piStep: row.index + 1 });
    await ctx.db.patch(row._id, { landed: result });
    return result;
  },
});
