import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { callerClient, requireCaller } from "./records";
import { readIcps } from "./lib/icpsInterface";
import { winnersCheck, type WinnersCheck } from "./lib/tam/winnersCheck";

export const active = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    return (await readIcps(ctx, orgId)).some((icp) => icp.active);
  },
});

export type IcpWinnersRead = { sampled: boolean; check: WinnersCheck } | null;
export const read = action({
  args: {},
  handler: async (ctx): Promise<IcpWinnersRead> => {
    const caller = await requireCaller(ctx, { read: true });
    if (!await ctx.runQuery(internal.icpWinners.active, { orgId: caller.orgId as Id<"organizations"> })) return null;
    const client = callerClient(ctx, caller);
    const won = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listObjects(caller.orgId, "deal", { filter: [{ field: "isWon", op: "eq", value: true }], limit: 200, ...(cursor ? { cursor } : {}) });
      for (const deal of page.rows) {
        if (typeof deal.values.companyId === "string") won.add(deal.values.companyId);
        if (won.size === 500) break;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && won.size < 500);
    const distribution = await client.aggregate(caller.orgId, "account", { groupBy: [{ field: "fit" }], measures: [{ fn: "count" }] });
    if (distribution.truncated) throw new Error("The fit distribution is incomplete");
    // Aggregates expose register points (0..100); account gets return unit fit (0..1).
    const histogram = distribution.groups.flatMap(({ keys, values }) =>
      typeof keys[0] === "number" && typeof values[0] === "number" ? [{ fit: keys[0] / 100, count: values[0] }] : []);
    const fits: number[] = [];
    const ids = [...won];
    for (let i = 0; i < ids.length; i += 10) {
      const accounts = await Promise.all(ids.slice(i, i + 10).map((id) => client.get(caller.orgId, id)));
      for (const detail of accounts) if (detail && typeof detail.account.fit === "number") fits.push(detail.account.fit);
    }
    return { sampled: won.size === 500, check: winnersCheck(histogram, fits) };
  },
});
