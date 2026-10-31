import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  HARD_CEILING, MAX_PENDING_INVITES, SALES_NAV_WEEKLY_CEILING,
  effectiveLimits, healthOf, isLightDay, localDayStart, localTime, weekStart,
  type Acceptance, type Limits, type Usage,
} from "./limits";

export async function senderCapacity(ctx: QueryCtx, account: Doc<"linkedinAccounts">, now: number) {
  const dayStart = localDayStart(now, account.timezone);
  const since = (kind: Doc<"linkedinSends">["kind"], from: number, max: number) =>
    ctx.db.query("linkedinSends").withIndex("by_accountId_and_kind_and_at", (q) => q.eq("accountId", account._id).eq("kind", kind).gte("at", from)).take(max);
  const invites = await since("invite", weekStart(now), SALES_NAV_WEEKLY_CEILING + 1);
  const usage: Usage = {
    invitesToday: invites.filter((r) => r.at >= dayStart).length,
    invitesWeek: invites.length,
    messagesToday: (await since("message", dayStart, HARD_CEILING.messagesPerDay + 1)).length,
    lookupsToday: (await since("lookup", dayStart, HARD_CEILING.lookupsPerDay + 1)).length,
  };
  const acceptance: Acceptance = {
    sent: invites.filter((r) => r.ok).length,
    accepted: (await since("accepted", weekStart(now), SALES_NAV_WEEKLY_CEILING + 1)).length,
  };
  const pending = (
    await ctx.db.query("linkedinEnrollments").withIndex("by_senderAccountId_and_state_and_nextAt", (q) => q.eq("senderAccountId", account._id).eq("state", "invited")).take(MAX_PENDING_INVITES + 1)
  ).length;
  const health = healthOf(acceptance, pending);
  const limits: Limits = effectiveLimits(account, health, isLightDay(account._id, localTime(now, account.timezone).date));
  return { usage, acceptance, pending, health, limits };
}
