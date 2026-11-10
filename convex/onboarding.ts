import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser } from "./lib";
import { hasAgentConnection } from "./agentConnections";
import { readIcps } from "./lib/icpsInterface";

export const STEP_IDS = ["connect_agent", "review_icp", "research_accounts", "triage_tam", "connect_crm", "invite_team"] as const;
/** Optional steps: Canon is the CRM, and a solo workspace has no one to invite. */
export const SKIPPABLE_STEP_IDS: readonly string[] = ["connect_crm", "invite_team"];

/**
 * Native onboarding checklist. Onboarding is agent-driven: connecting an agent
 * comes first, and the ICP and research steps are done from that agent.
 * A row in `orgOnboardingSteps` marks a step done, whether it was done
 * (`markStep`) or skipped (`skipStep`).
 * Read budget: 1 range of marks + 4 index probes + 2 users.
 */
export const getSteps = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return STEP_IDS.map((id) => ({ id, done: false }));
    const flags = new Set<string>();
    const marks = await ctx.db
      .query("orgOnboardingSteps")
      .withIndex("by_orgId_stepId", (q) => q.eq("orgId", user.orgId))
      .take(STEP_IDS.length);
    for (const mark of marks) flags.add(mark.stepId);
    if (await hasAgentConnection(ctx, user)) flags.add("connect_agent");
    if ((await readIcps(ctx, user.orgId)).length) flags.add("review_icp");
    const run = await ctx.db
      .query("researchRuns")
      .withIndex("by_orgId_and_createdAt", (q) => q.eq("orgId", user.orgId))
      .first();
    if (run) flags.add("research_accounts");
    const crm = await ctx.db
      .query("integrations")
      .withIndex("by_orgId_provider", (q) => q.eq("orgId", user.orgId))
      .take(5);
    if (crm.some((row) => row.isActive)) flags.add("connect_crm");
    const team = await ctx.db
      .query("users")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(2);
    if (team.length > 1) flags.add("invite_team");
    return STEP_IDS.map((id) => ({ id, done: flags.has(id) }));
  },
});

async function mark(ctx: MutationCtx, orgId: Id<"organizations">, stepId: string) {
  const existing = await ctx.db
    .query("orgOnboardingSteps")
    .withIndex("by_orgId_stepId", (q) => q.eq("orgId", orgId).eq("stepId", stepId))
    .first();
  if (existing) return;
  await ctx.db.insert("orgOnboardingSteps", { orgId, stepId, doneAt: Date.now() });
}

export const markStep = internalMutation({
  args: { orgId: v.string(), stepId: v.string() },
  handler: async (ctx, args) => {
    const orgId: Id<"organizations"> | null = ctx.db.normalizeId("organizations", args.orgId);
    if (!orgId) return;
    await mark(ctx, orgId, args.stepId);
  },
});

/** Skip an optional step for the whole workspace, so setup can finish. */
export const skipStep = mutation({
  args: { stepId: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not signed in");
    if (!SKIPPABLE_STEP_IDS.includes(args.stepId)) throw new ConvexError("This step can't be skipped");
    await mark(ctx, user.orgId, args.stepId);
  },
});

export const getStartingPlan = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user ? (await ctx.db.get(user.orgId))?.startingPlan ?? null : null;
  },
});

export const completePlanTask = mutation({
  args: { stepId: v.string() },
  handler: async (ctx, { stepId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not signed in");
    const org = await ctx.db.get(user.orgId);
    if (!org?.startingPlan?.tasks.some((task) => task.id === stepId)) throw new ConvexError("Unknown setup task");
    await mark(ctx, user.orgId, stepId);
  },
});
