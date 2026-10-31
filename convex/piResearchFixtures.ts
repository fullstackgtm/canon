import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireUser } from "./lib";
import { ensureFieldAgent } from "./agents";
import { agentSlug, attributeFor } from "./lib/research/agentLoop";
import { piFixtureRun } from "./lib/research/piEnablement";

function localFixture() {
  if (!piFixtureRun({ piFixture: "account-text" })) throw new ConvexError("Pi fixtures require the managed anonymous local stack");
}

export const seed = internalMutation({
  args: { tag: v.string(), origin: v.string() },
  handler: async (ctx, args) => {
    localFixture();
    if (!/^[a-z0-9-]{1,40}$/.test(args.tag)) throw new ConvexError("Invalid fixture tag");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(args.origin)) throw new ConvexError("Fixture Worker must be local");
    const user = await requireUser(ctx);
    const now = Date.now();
    const slug = agentSlug(`Pi proof ${args.tag}`, new Set());
    if (await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", user.orgId).eq("slug", slug)).unique()) throw new ConvexError("Fixture already exists");
    const agentId = await ctx.db.insert("researchAgents", { orgId: user.orgId, slug, label: `Pi proof ${args.tag}`, entityType: "account", kind: "qa", question: "What does this company sell?", answerType: "text", createdBy: user._id, createdAt: now, updatedAt: now });
    await ensureFieldAgent(ctx, (await ctx.db.get(agentId))!);
    const runId = await ctx.db.insert("researchRuns", {
      orgId: user.orgId, agentId, filter: {}, scope: { entity: "account", filter: {} }, status: "running", runtime: "pi", piStep: 0, piFixture: "account-text",
      piFixtureOrigin: args.origin,
      inScope: 0, planned: 0, done: 0, skipped: 0, answered: 0, unknown: 0, noEvidence: 0, errors: 0, pagesRead: 0, llmCalls: 0,
      createdBy: user._id, createdAt: now, updatedAt: now,
    });
    return { runId, slug };
  },
});

export const receipt = internalQuery({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, args) => {
    localFixture();
    const run = await ctx.db.get(args.runId);
    if (!run || !piFixtureRun(run)) throw new ConvexError("Fixture unavailable");
    const field = (await ctx.db.get(run.agentId))!;
    const steps = await ctx.db.query("piResearchSteps").withIndex("by_runId_and_index", (q) => q.eq("runId", run._id)).take(2000);
    const traces = await ctx.db.query("researchTraces").withIndex("by_runId", (q) => q.eq("runId", run._id)).take(200);
    const facts = [];
    const plans = [];
    const effects = [];
    for (const step of steps) {
      effects.push(...await ctx.db.query("piResearchEffects").withIndex("by_stepId_and_key", (q) => q.eq("stepId", step._id)).take(33));
      if (!step.record) continue;
      const rows = await ctx.db.query("facts").withIndex("by_entity_attribute_observedAt", (q) => q.eq("entityId", step.record!.entityId).eq("attribute", attributeFor(field.slug))).take(5);
      for (const row of rows) {
        facts.push({ id: row._id, entityId: row.entityId, status: row.status, value: row.value, evidence: row.evidence });
        if (row.patchPlanId) {
          const plan = await ctx.db.get(row.patchPlanId);
          if (plan) plans.push({ id: plan._id, status: plan.status, agentId: plan.agentId });
        }
      }
    }
    return { run: { id: run._id, status: run.status, runtime: run.runtime, done: run.done, answered: run.answered, errors: run.errors, pagesRead: run.pagesRead, llmCalls: run.llmCalls },
      steps: steps.map((s) => ({ id: s._id, index: s.index, landed: s.landed ?? null })), traces: traces.map((t) => ({ id: t._id, recordId: t.recordId, status: t.status, reason: t.reason ?? null })), facts, plans,
      effects: effects.map((e) => ({ stepId: e.stepId, key: e.key, operation: e.operation, completed: e.response !== undefined })),
    };
  },
});
