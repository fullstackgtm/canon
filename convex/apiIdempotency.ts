/** The record creates' Idempotency-Keys (lib/idempotency.ts): the company and person claim, and the hourly purge. */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { requireUser } from "./lib";
import { createOnce, purgeExpiredKeys } from "./lib/idempotency";

/**
 * Bind a company or person upsert's key to its request before the record service runs it. The record service
 * replays a key itself and serializes a workspace's writes, so it answers a retry; this refuses the key sent again
 * with other records, which the record service would answer with the first ones.
 */
export const claim = internalMutation({
  args: { key: v.string(), request: v.any() },
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx);
    return createOnce(ctx, { orgId: user.orgId, userId: user._id }, args.key, args.request, async () => null);
  },
});

const PURGE_BATCH = 500;

export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const purged = await purgeExpiredKeys(ctx, PURGE_BATCH);
    if (purged === PURGE_BATCH) await ctx.scheduler.runAfter(0, internal.apiIdempotency.purgeExpired, {});
    return purged;
  },
});
