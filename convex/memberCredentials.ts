import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { credentialMember } from "./lib/membership";

const BATCH = 200;

/**
 * One-off, for credentials issued before turning a member off revoked them (lib/membership.ts
 * revokeMemberCredentials): revoke every paired CLI token and logging address whose member is no longer active in its
 * workspace, so Settings lists them truthfully. Those already stop working where they are resolved; this only records
 * it. Idempotent; a page at a time: run it again with the returned `cursor` until `isDone`.
 */
export const revokeInactiveMembersCredentials = internalMutation({
  args: { table: v.union(v.literal("cliTokens"), v.literal("emailLogAddresses")), cursor: v.optional(v.union(v.string(), v.null())), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ scanned: number; revoked: number; cursor: string; isDone: boolean }> => {
    const page = await ctx.db.query(args.table).paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    const now = Date.now();
    let revoked = 0;
    for (const row of page.page) {
      if (row.revokedAt !== undefined) continue;
      if (await credentialMember(ctx, await ctx.db.get(row.userId), row.orgId)) continue;
      revoked += 1;
      if (!args.dryRun) await ctx.db.patch(row._id, { revokedAt: now });
    }
    return { scanned: page.page.length, revoked, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Self-hosted sign-in sessions past their expiry: they no longer sign anyone in, so they are deleted. */
export const purgeExpiredLocalSessions = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const expired = await ctx.db.query("localSessions").withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now())).take(BATCH);
    for (const session of expired) await ctx.db.delete(session._id);
    if (expired.length === BATCH) await ctx.scheduler.runAfter(0, internal.memberCredentials.purgeExpiredLocalSessions, {});
    return expired.length;
  },
});
