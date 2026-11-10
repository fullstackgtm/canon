import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { awaitsLogin } from "./clerkRoles";

/**
 * Who is a member of a workspace now, and the one gate every credential passes on its way to a member.
 *
 * A member belongs to their home workspace (`users.orgId`) and to others through `orgMemberships`, each with its own
 * `isActive` and role. Turning a member off on the Team page clears `users.isActive` (and their home membership's);
 * Clerk turns off one membership, or all of them when the account is deleted.
 */

type Db = Pick<QueryCtx, "db">;

/**
 * The role `user` holds as an active member of `orgId`, or null when they are not one. Their home workspace needs
 * their member row on and, when it has one, its membership row on; any other needs its membership row on. Judged
 * from the stored member row: a member a session scoped to another workspace carries that workspace's `orgId`.
 */
export async function activeRoleIn(ctx: Db, user: Pick<Doc<"users">, "_id">, orgId: Id<"organizations">): Promise<string | null> {
  const stored = await ctx.db.get(user._id);
  if (!stored) return null;
  const home = stored.orgId === orgId;
  if (home && !stored.isActive) return null;
  const membership = await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", stored._id).eq("orgId", orgId)).first();
  if (membership) return membership.isActive ? membership.role : null;
  return home ? stored.role : null;
}

/**
 * The member a credential names, as they act in `orgId` now (that workspace's `orgId` and role), or null. Every
 * credential resolves to a member through here: a session's identity (lib.ts scopeUserToActiveOrg), a paired CLI token
 * (cliAuth.getTokenByHash), a self-hosted session cookie, an export or import key and a logging address.
 * tests/credentialResolution.test.ts lists them and fails on one that doesn't. A record nobody signs in as (added on
 * the Team page, or a CRM owner) is never one: an invitation takes it over first.
 */
export async function credentialMember(ctx: Db, user: Doc<"users"> | null, orgId: Id<"organizations">): Promise<Doc<"users"> | null> {
  if (!user || awaitsLogin(user.clerkUserId)) return null;
  const role = await activeRoleIn(ctx, user, orgId);
  if (role === null) return null;
  return user.orgId === orgId ? user : { ...user, orgId, role };
}

/**
 * End what Canon issued a member for `orgId`, or for every workspace when it is null, in the transaction that turns
 * them off: their paired CLI tokens and logging addresses there are revoked (Settings lists them as revoked), and their
 * self-hosted sessions, invitations and workspace export and import keys are deleted. The gate above already refuses
 * all of these; revoking them means turning the member back on brings none back: they sign in and pair again.
 */
export async function revokeMemberCredentials(ctx: MutationCtx, user: Doc<"users">, orgId: Id<"organizations"> | null) {
  const now = Date.now();
  const inScope = (row: { orgId: Id<"organizations"> }) => orgId === null || row.orgId === orgId;
  for (const token of await ctx.db.query("cliTokens").withIndex("by_userId", (q) => q.eq("userId", user._id)).collect()) {
    if (!token.revokedAt && inScope(token)) await ctx.db.patch(token._id, { revokedAt: now });
  }
  for (const address of await ctx.db.query("emailLogAddresses").withIndex("by_userId", (q) => q.eq("userId", user._id)).collect()) {
    if (address.revokedAt === undefined && inScope(address)) await ctx.db.patch(address._id, { revokedAt: now });
  }
  // A self-hosted session and invitation only ever sign in to the member's home workspace.
  if (orgId === null || orgId === user.orgId) {
    for (const session of await ctx.db.query("localSessions").withIndex("by_userId", (q) => q.eq("userId", user._id)).collect()) await ctx.db.delete(session._id);
    for (const invite of await ctx.db.query("localInvites").withIndex("by_userId", (q) => q.eq("userId", user._id)).collect()) await ctx.db.delete(invite._id);
  }
  const orgs = orgId !== null ? [orgId]
    : [...new Set([user.orgId, ...(await ctx.db.query("orgMemberships").withIndex("by_userId", (q) => q.eq("userId", user._id)).collect()).map((m) => m.orgId)])];
  for (const org of orgs) {
    for (const table of ["workspaceExportKeys", "workspaceImportKeys"] as const) {
      // Creating a key replaces the workspace's others, so there are few.
      for (const row of await ctx.db.query(table).withIndex("by_orgId", (q) => q.eq("orgId", org)).take(20)) if (row.userId === user._id) await ctx.db.delete(row._id);
    }
  }
}
