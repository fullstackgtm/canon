/**
 * A member's in-app notifications (the bell in the sidebar, and canon_module `notifications` for their agent): what a
 * module's transition or job told them, newest first, with a link. Each member reads only their own, in the
 * workspace they are in. Writes come from convex/lib/notifications.ts; email delivery is not built.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, mutation, query } from "./_generated/server";
import { getCurrentUser, requireUser } from "./lib";
import { accessFor } from "./permissions";

const SHOWN = 30;
const UNREAD_COUNTED = 99;

const shape = (n: Doc<"notifications">) => ({ id: n._id, message: n.message, subject: n.subject ?? null, badge: n.badge ?? null, link: n.link ?? null, at: n.at, read: n.readAt !== undefined, moduleId: n.source.moduleId });

/**
 * The caller's latest notifications, and how many they haven't read (counted to 99). `module`: one module's only. In
 * an admin's "view as" preview, the member previewed's, read-only: `preview` names them, and nothing marks them read.
 */
export const list = query({
  args: { module: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { unread: 0, items: [], preview: null };
    const access = await accessFor(ctx, user);
    const userId = access.userId as Id<"users">;
    const take = Math.max(1, Math.min(100, Math.round(args.limit ?? SHOWN)));
    const rows = await ctx.db.query("notifications").withIndex("by_orgId_userId_at", (q) => q.eq("orgId", user.orgId).eq("userId", userId)).order("desc").take(args.module ? 200 : take);
    const mine = args.module ? rows.filter((n) => n.source.moduleId === args.module || n.source.moduleId.endsWith(`/${args.module}`)).slice(0, take) : rows;
    const unread = await ctx.db.query("notifications").withIndex("by_orgId_userId_readAt", (q) => q.eq("orgId", user.orgId).eq("userId", userId).eq("readAt", undefined)).take(UNREAD_COUNTED);
    return { unread: unread.length, items: mine.map(shape), preview: access.preview?.asName ?? null };
  },
});

/**
 * Mark the caller's notifications read: the ones named (a row's Mark read, or opening one), or all of them. Only this
 * marks them read: opening the bell doesn't (decision 2026-10-18).
 */
export const markRead = mutation({
  args: { ids: v.optional(v.array(v.id("notifications"))), all: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    // A preview reads the member's notifications; marking them read would be a change, which it never makes.
    const user = await requireUser(ctx);
    const now = Date.now();
    const rows = args.all
      ? await ctx.db.query("notifications").withIndex("by_orgId_userId_readAt", (q) => q.eq("orgId", user.orgId).eq("userId", user._id).eq("readAt", undefined)).take(500)
      : (await Promise.all((args.ids ?? []).slice(0, 100).map((id) => ctx.db.get(id)))).filter((n): n is Doc<"notifications"> => n !== null && n.userId === user._id && n.orgId === user.orgId && n.readAt === undefined);
    for (const n of rows) await ctx.db.patch(n._id, { readAt: now });
    return rows.length;
  },
});

/** A member's notifications, for checking one on a local stack (`convex run notifications:forMember`). Internal only. */
export const forMember = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return [];
    return (await ctx.db.query("notifications").withIndex("by_orgId_userId_at", (q) => q.eq("orgId", user.orgId).eq("userId", user._id)).order("desc").take(SHOWN)).map(shape);
  },
});
