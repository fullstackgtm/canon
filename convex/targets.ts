/**
 * Targets for Reports pacing: one bookings plan per workspace and fiscal year,
 * entered top down and split into teams, reps and months by
 * lib/reports/targets.ts (the editor runs the split; the plan it produced is
 * saved with the choices that made it). Everyone in the workspace reads the
 * plan; admins and managers set it.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireCap, requireUser } from "./lib";
import { callerClient, requireCaller, type ActionCaller } from "./records";
import { asListError } from "./objects";
import { targetPlanChoices, targetPlanFields } from "./lib/reports/validators";
import { buildPlan, planInput } from "./lib/reports/targets";
import { fiscalMonth, lastDay, monthStart, periodOf, type Grain } from "./lib/reports/pacing";

/** The team a rep's target counts toward when they are on no team. */
export const NO_TEAM = "none";
const ROSTER_MAX = 500;

export type Roster = { teams: { id: string; name: string }[]; reps: { id: string; name: string; team: string; role: Doc<"users">["role"] }[] };

/**
 * Who a plan splits into: every active member of the workspace, each on the first team (by name) that lists them, and
 * a "No team" group for the rest when there are any. A rep on several teams counts toward one, so teams add up.
 */
export async function rosterOf(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Roster> {
  const users = (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(ROSTER_MAX)).filter((u) => u.isActive);
  const groups = (await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(ROSTER_MAX)).sort((a, b) => a.name.localeCompare(b.name));
  const reps = users
    .map((u) => ({ id: u._id as string, name: u.name || u.email, role: u.role, team: (groups.find((g) => g.memberIds.includes(u._id))?._id as string | undefined) ?? NO_TEAM }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams = groups.filter((g) => reps.some((r) => r.team === g._id)).map((g) => ({ id: g._id as string, name: g.name }));
  if (reps.some((r) => r.team === NO_TEAM)) teams.push({ id: NO_TEAM, name: "No team" });
  return { teams, reps };
}

/** The month (1-12) the workspace's fiscal year starts in. */
export async function fyStartOf(ctx: QueryCtx, orgId: Id<"organizations">): Promise<number> {
  return (await ctx.db.get(orgId))?.fiscalYearStartMonth ?? 1;
}

/** The workspace's current month, quarter or year, with its last day. */
export async function currentPeriod(ctx: QueryCtx, orgId: Id<"organizations">, grain: Grain) {
  const p = periodOf(new Date().toISOString().slice(0, 10), grain, await fyStartOf(ctx, orgId));
  return { ...p, end: lastDay(p) };
}

export const fyStart = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, { orgId }) => fyStartOf(ctx, orgId),
});

/** The signed-in caller's roster, for actions (pacing splits and filters by team). */
export const callerRoster = internalQuery({
  args: {},
  handler: async (ctx): Promise<Roster> => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new ConvexError("Not authenticated");
    return await rosterOf(ctx, user.orgId);
  },
});

/**
 * A fiscal year's saved plan (null before anyone sets one) and the roster it splits into today. Without `year`, the
 * fiscal year today is in.
 */
export const get = query({
  args: { year: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const fyStart = await fyStartOf(ctx, user.orgId);
    const year = args.year ?? fiscalMonth(new Date().toISOString().slice(0, 10), fyStart).fy;
    const plan = await ctx.db.query("targetPlans").withIndex("by_orgId_and_year", (q) => q.eq("orgId", user.orgId).eq("year", year)).unique();
    return { year, fyStart, plan, roster: await rosterOf(ctx, user.orgId), canEdit: can(user, "targets.set") };
  },
});

/** What the caller can see booked in fiscal `year`: by month (12) and by owner, in cents. */
async function bookedIn(ctx: ActionCtx, caller: ActionCaller, year: number, fyStart: number) {
  const first = monthStart(year, 0, fyStart);
  const res = await asListError(() => callerClient(ctx, caller).aggregate(caller.orgId, "deal", {
    filter: [{ field: "isWon", op: "eq", value: true }, { field: "closeDate", op: "gte", value: first }, { field: "closeDate", op: "lte", value: lastDay(periodOf(first, "year", fyStart)) }],
    groupBy: [{ field: "closeDate", bucket: "month" }, { field: "ownerId" }],
    measures: [{ fn: "sum", field: "amount" }],
  }));
  const months = new Array<number>(12).fill(0);
  const reps: Record<string, number> = {};
  for (const g of res.groups) {
    const amount = g.values[0] ?? 0;
    months[fiscalMonth(String(g.keys[0]), fyStart).m] += amount;
    if (g.keys[1] !== null) reps[String(g.keys[1])] = (reps[String(g.keys[1])] ?? 0) + amount;
  }
  return { months, reps, truncated: res.truncated };
}

/** What the workspace booked in `year`, by month and owner: the "like last year" splits read the year before a plan's. */
export const history = action({
  args: { year: v.number() },
  handler: async (ctx, { year }): Promise<{ months: number[]; reps: Record<string, number>; truncated: boolean }> => {
    const caller = await requireCaller(ctx, { read: true });
    return await bookedIn(ctx, caller, year, await ctx.runQuery(internal.targets.fyStart, { orgId: caller.orgId as Id<"organizations"> }));
  },
});

/**
 * Set a year's targets top down: the total, how it spreads over months, teams and reps, and any amounts already
 * known (locks, a rep's quarters, start dates and ramps). Splits it against last year's bookings and today's
 * roster (lib/reports/targets.ts) and saves the plan it produces. Admins and managers only.
 */
export const set = action({
  args: {
    ...targetPlanChoices,
    /**
     * The year's plan version the save is made on (a module's approved proposal, CAS): its `updatedAt`, or null for a
     * year with no plan. A plan saved since refuses the save, in the same transaction that would write it.
     */
    expect: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, { expect, ...choices }): Promise<{ total: number; teams: Record<string, number>; reps: Record<string, number> }> => {
    const caller = await requireCaller(ctx);
    if (!can(caller, "targets.set")) throw new ConvexError(refusal("targets.set"));
    if (!Number.isInteger(choices.year) || choices.year < 2000 || choices.year > 2100) throw new ConvexError("Give a year between 2000 and 2100");
    if (!finite(choices.total)) throw new ConvexError("The target must be a positive amount");
    if (!Number.isFinite(choices.coverage) || choices.coverage <= 0 || choices.coverage > 20) throw new ConvexError("Coverage must be between 0 and 20 times bookings");
    if (choices.months.custom && (choices.months.custom.length !== 12 || !choices.months.custom.every(finite))) throw new ConvexError("A custom month split needs 12 weights");
    for (const q of Object.values(choices.reps.quarters ?? {})) if (q.length !== 4 || !q.every(finite)) throw new ConvexError("A rep's quarters are four amounts");
    const roster: Roster = await ctx.runQuery(internal.targets.callerRoster, {});
    const fyStart: number = await ctx.runQuery(internal.targets.fyStart, { orgId: caller.orgId as Id<"organizations"> });
    const plan = buildPlan(planInput(choices, roster, await bookedIn(ctx, caller, choices.year - 1, fyStart), fyStart));
    if (plan.misfits.length) {
      const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
      const where = plan.misfits.map((o) => `${o.level === "teams" ? "the teams" : roster.teams.find((t) => t.id === o.level)?.name ?? o.level} ${o.by > 0 ? `exceed their total by ${usd(o.by)}` : `leave ${usd(-o.by)} unplaced`}`);
      throw new ConvexError(`Locked amounts do not fit: ${where.join("; ")}. Unlock one or change the total.`);
    }
    await ctx.runMutation(internal.targets.store, {
      ...choices, ...(expect !== undefined ? { expect } : {}),
      repTeam: Object.fromEntries(roster.reps.map((r) => [r.id, r.team])),
      repMonths: plan.repMonths,
      teamMonths: plan.teamMonths,
      fyStart,
    });
    return { total: plan.total, teams: plan.teams, reps: plan.reps };
  },
});

const finite = (n: number) => Number.isFinite(n) && n >= 0;
/** A save made on a plan version that's no longer the year's: nothing was written. */
export const TARGET_CHANGED = "The year's target changed since this was proposed; nothing was saved.";

/** A year's saved plan, for a module's proposed target (lib/modules/recordProposals.ts): its choices and version. */
export const planOf = internalQuery({
  args: { orgId: v.id("organizations"), year: v.number() },
  handler: async (ctx, { orgId, year }) => {
    const plan = await ctx.db.query("targetPlans").withIndex("by_orgId_and_year", (q) => q.eq("orgId", orgId).eq("year", year)).unique();
    return plan ? { total: plan.total, updatedAt: plan.updatedAt, coverage: plan.coverage, months: plan.months, teams: plan.teams, reps: plan.reps } : null;
  },
});

/** Save a year's plan as `set` produced it. */
export const store = internalMutation({
  args: { ...targetPlanFields, expect: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, { expect, ...args }) => {
    const user = await requireCap(ctx, "targets.set");
    const existing = await ctx.db.query("targetPlans").withIndex("by_orgId_and_year", (q) => q.eq("orgId", user.orgId).eq("year", args.year)).unique();
    if (expect !== undefined && (existing?.updatedAt ?? null) !== expect) throw new ConvexError(TARGET_CHANGED);
    const doc = { ...args, orgId: user.orgId, updatedBy: user._id, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.replace(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("targetPlans", doc);
  },
});
