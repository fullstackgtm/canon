/**
 * After a ledger append (convex/objects.ts appendEntry): wake the automation
 * fan-out (convex/automations.ts) once per transaction, and only for an org
 * with an active rule. A lost wake-up costs the one-minute sweep, not a run:
 * the fan-out reads the ledger from its cursor, not from these calls.
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

const woken = new WeakMap<MutationCtx, Set<string>>();

export async function scheduleAutomationFanout(ctx: MutationCtx, orgId: Id<"organizations">) {
  const done = woken.get(ctx) ?? new Set<string>();
  woken.set(ctx, done);
  if (done.has(orgId)) return;
  done.add(orgId);
  const active = await ctx.db.query("automationRules").withIndex("by_orgId_and_status", (q) => q.eq("orgId", orgId).eq("status", "active")).first();
  if (active) await ctx.scheduler.runAfter(0, internal.automations.fanout, { orgId });
}
