/**
 * Writing in-app notifications (convex/notifications.ts reads them). One row per member; members who aren't in the
 * workspace are skipped, so a stale id never reaches someone outside it.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { workspaceMembers } from "../permissions";

/** The most members one notification goes to, and the longest message. */
export const NOTIFY_MAX = 50;
export const MESSAGE_MAX = 300;
/** The longest subject line and badge. */
export const SUBJECT_MAX = 120;
export const BADGE_MAX = 30;

export async function notifyMembers(
  ctx: MutationCtx, orgId: Id<"organizations">, userIds: readonly string[], n: { source: Doc<"notifications">["source"]; message: string; link?: string; subject?: string; badge?: string },
): Promise<number> {
  const members = new Set((await workspaceMembers(ctx, orgId)).map((u) => u.id as string));
  const to = [...new Set(userIds)].filter((id) => members.has(id)).slice(0, NOTIFY_MAX);
  const at = Date.now();
  for (const userId of to) {
    await ctx.db.insert("notifications", {
      orgId, userId: userId as Id<"users">, source: n.source, message: n.message.slice(0, MESSAGE_MAX), ...(n.link ? { link: n.link } : {}), at,
      ...(n.subject?.trim() ? { subject: n.subject.trim().slice(0, SUBJECT_MAX) } : {}), ...(n.badge?.trim() ? { badge: n.badge.trim().slice(0, BADGE_MAX) } : {}),
    });
  }
  return to.length;
}
