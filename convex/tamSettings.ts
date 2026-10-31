/**
 * TAM explorer settings. The "Opportunity" metric sizes tiles by
 * employees x an annual $ per employee the workspace sets here.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUser, requireCap } from "./lib";

/** Default annual $ per employee until a workspace sets its own. */
export const DEFAULT_SEAT_PRICE_USD = 100;

export const get = query({
  args: {},
  returns: v.object({ seatPriceUsd: v.number(), isDefault: v.boolean() }),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const org = user ? await ctx.db.get(user.orgId) : null;
    const price = org?.tamSeatPriceUsd;
    return { seatPriceUsd: price ?? DEFAULT_SEAT_PRICE_USD, isDefault: price === undefined };
  },
});

export const setSeatPrice = mutation({
  args: { seatPriceUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireCap(ctx, "strategy.edit");
    if (!Number.isFinite(args.seatPriceUsd) || args.seatPriceUsd <= 0 || args.seatPriceUsd > 1_000_000) {
      throw new ConvexError("Enter an annual price per employee between $1 and $1,000,000.");
    }
    await ctx.db.patch(user.orgId, { tamSeatPriceUsd: Math.round(args.seatPriceUsd * 100) / 100 });
    return null;
  },
});
