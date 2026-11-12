import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { isBuiltInRole } from "./lib/roles";
import { can, refusal } from "./lib/capabilities";
import { credentialMember } from "./lib/membership";
import type { Capability } from "../modules/kernel/capabilities.ts";
import { ActionCtx, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export const DEV_ORG_CLERK_ID = "dev_org_fullstackgtm";
export const DEV_ORG_SLUG = "dev-organization";
export const DEV_USER_CLERK_ID = "dev_user_fullstackgtm";

/**
 * Whether unauthenticated callers are treated as the seeded demo user.
 *
 * This is fail-CLOSED: it is enabled ONLY by an explicit, deliberate opt-in
 * (`FSGTM_ENABLE_DEMO_DATA=true`). It is never inferred from a missing or
 * placeholder Clerk issuer — a deployment that simply forgot to configure
 * auth must reject requests, not silently grant admin access. The CLI and MCP
 * talk to Convex directly, so any auth bypass here is a deployment-wide hole.
 */
export function isDevAuthBypassEnabled() {
  if (process.env.CANON_AUTH === "local" || process.env.CANON_AUTH === "convex") return false;
  return process.env.FSGTM_ENABLE_DEMO_DATA === "true";
}

/**
 * The Clerk org active in this session, read from the JWT. Two shapes:
 * - custom "convex" JWT template claim: `"org_id": "{{org.id}}"`
 * - Clerk session-token v2 (aud === "convex"): nested `o: { id, ... }`
 * Returns null when no org is active or the template doesn't carry the claim
 * yet — callers fall back to the user's home org (`users.orgId`) so pre-claim
 * JWTs keep working during rollout.
 */
export function activeClerkOrgIdFromIdentity(
  identity: Record<string, unknown> | null | undefined,
): string | null {
  if (!identity) return null;
  const direct = identity["org_id"];
  if (typeof direct === "string" && direct) return direct;
  const nested = identity["o"];
  if (nested && typeof nested === "object") {
    const id = (nested as Record<string, unknown>)["id"];
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Re-scope a user row to the session's active Clerk org. The returned object
 * carries the EFFECTIVE `orgId` and `role` (from the orgMemberships row), so
 * every downstream `user.orgId` query is automatically scoped to the org the
 * OrganizationSwitcher selected. Fail-closed: an active org we can't map to a
 * mirrored org row, or one the user is not an active member of (their home org
 * included: lib/membership.ts credentialMember), yields null (deny), never another
 * org's data. Read budget: at most 2 point lookups.
 */
export async function scopeUserToActiveOrg(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  activeClerkOrgId: string | null,
  activeOrgId?: Id<"organizations">,
): Promise<Doc<"users"> | null> {
  if (activeOrgId) return credentialMember(ctx, user, activeOrgId);
  if (!activeClerkOrgId) return credentialMember(ctx, user, user.orgId);

  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", activeClerkOrgId))
    .first();
  if (!org) return null;
  return credentialMember(ctx, user, org._id);
}

/**
 * The OAuth client of an agent calling as its user, or null for anyone else. A call carrying Canon's service JWT came
 * through /mcp or the canon CLI (src/lib/canonServiceJwt.ts), and Canon can't tell the person typing from the agent,
 * so a gate a human must pass treats every such call as an agent.
 */
export async function agentClientOf(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  const serviceIssuer = process.env.CANON_SERVICE_JWT_ISSUER;
  if (!identity || !serviceIssuer || identity.issuer !== serviceIssuer) return null;
  if (process.env.CANON_AUTH === "local" && identity["canon_session"] === "local" && /^local_[a-f0-9-]{36}$/.test(identity.subject)) return null;
  const azp = (identity as Record<string, unknown>)["azp"];
  return typeof azp === "string" && azp ? azp.slice(0, 200) : "unknown";
}

/**
 * Get the current authenticated user, or null if not authenticated.
 * Use in queries to gracefully return empty data when unauthenticated.
 *
 * The returned row's `orgId`/`role` reflect the session's ACTIVE Clerk org
 * (see scopeUserToActiveOrg), not necessarily the stored home org.
 */
export async function getCurrentUser(ctx: QueryCtx | MutationCtx): Promise<(Doc<"users"> & { capabilities?: readonly string[] }) | null> {
  return withRole(ctx, await findUser(ctx));
}

/**
 * A member with the capabilities of their workspace's own role (lib/roles.ts), which `can` reads. A built-in role's
 * are in the registry. A role whose row is gone holds none.
 */
export async function withRole<U extends Doc<"users">>(ctx: QueryCtx | MutationCtx, user: U | null): Promise<(U & { capabilities?: readonly string[] }) | null> {
  if (!user || isBuiltInRole(user.role)) return user;
  const row = await ctx.db.query("orgRoles").withIndex("by_orgId_and_key", (q) => q.eq("orgId", user.orgId).eq("key", user.role)).unique();
  return { ...user, capabilities: row?.capabilities ?? [] };
}

async function findUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    if (!isDevAuthBypassEnabled()) return null;
    return devBypassUser(ctx);
  }

  if (process.env.CANON_AUTH === "convex") {
    const service = process.env.CANON_SERVICE_JWT_ISSUER;
    if (!service || identity.issuer !== service) {
      const userId = await getAuthUserId(ctx);
      const user = userId ? await ctx.db.get(userId) : null;
      if (!user?.isActive) return null;
      return scopeUserToActiveOrg(ctx, user, null, user.activeOrgId);
    }
    // Paired CLI JWTs use the legacy member key and the pairing's workspace claim.
  }

  const identityKeys = [identity.tokenIdentifier, identity.subject].filter(
    (key): key is string => Boolean(key),
  );

  for (const identityKey of identityKeys) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identityKey))
      .first();

    if (user) {
      if ((process.env.CANON_AUTH === "local" || process.env.CANON_AUTH === "convex") && !user.isActive) return null;
      return scopeUserToActiveOrg(ctx, user, activeClerkOrgIdFromIdentity(identity));
    }
  }

  return null;
}

/** The prefix of every seeded member's Clerk id (convex/devSeed.ts): the members a local stack can sign in as. */
export const DEV_MEMBER_PREFIX = "dev_user_";

/**
 * Who the dev auth bypass signs an unauthenticated caller in as: the seeded member picked with the "Signed in as"
 * switcher (convex/devAuth.ts), else the seeded admin. Only a seeded member of the demo workspace, so the switch can't
 * reach anyone else. Callers check isDevAuthBypassEnabled first: without it, nothing here runs.
 */
export async function devBypassUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const byClerk = (id: string) => ctx.db.query("users").withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", id)).first();
  const admin = await byClerk(DEV_USER_CLERK_ID);
  const picked = await ctx.db.query("devActAs").first();
  if (!admin || !picked || picked.clerkUserId === DEV_USER_CLERK_ID || !picked.clerkUserId.startsWith(DEV_MEMBER_PREFIX)) return admin;
  const member = await byClerk(picked.clerkUserId);
  return member && member.orgId === admin.orgId && member.isActive ? member : admin;
}

/**
 * Get the current user or throw. Use in mutations that require auth.
 *
 * An admin's "view as" preview (CP14, convex/permissions.ts) is read-only by
 * construction: in a mutation, this refuses while one is live, so no write
 * goes through whether or not it checks permissions. Only the mutations that
 * start and end a preview pass `allowPreview`.
 */
export async function requireUser(ctx: QueryCtx | MutationCtx, opts: { allowPreview?: boolean } = {}) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated");
  if (!opts.allowPreview && user.role === "admin" && isMutation(ctx)) {
    const preview = await ctx.db.query("accessPreviews").withIndex("by_userId_and_orgId", (q) => q.eq("userId", user._id).eq("orgId", user.orgId)).unique();
    if (preview && preview.expiresAt > Date.now()) throw new ConvexError("You are viewing as another member: changes are off until you exit the preview");
  }
  return user;
}

/** A mutation's database can write; a query's cannot. */
const isMutation = (ctx: QueryCtx | MutationCtx): ctx is MutationCtx => typeof (ctx.db as Partial<MutationCtx["db"]>).insert === "function";

/** The signed-in member, if their role holds `cap` (lib/capabilities.ts); otherwise a refusal naming what it covers. */
export async function requireCap(ctx: QueryCtx | MutationCtx, cap: Capability) {
  const user = await requireUser(ctx);
  if (!can(user, cap)) throw new ConvexError(refusal(cap));
  return user;
}

/**
 * Build a clean update object from args, filtering out undefined values.
 * Automatically sets updatedAt to now.
 */
export function buildUpdate(
  args: Record<string, unknown>,
  exclude: string[] = [],
): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !exclude.includes(key)) {
      updates[key] = value;
    }
  }
  return updates;
}

/**
 * Whether a user belongs to an org: either it is their home org row, or an
 * active orgMemberships row links them. Use this (not `user.orgId === orgId`)
 * whenever an internal mutation/action re-validates a (userId, orgId) pair —
 * multi-org members' active org differs from their home row's orgId.
 */
export async function userBelongsToOrg(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  orgId: Id<"organizations">,
): Promise<boolean> {
  if (user.orgId === orgId) return true;
  const membership = await ctx.db
    .query("orgMemberships")
    .withIndex("by_userId_orgId", (q) => q.eq("userId", user._id).eq("orgId", orgId))
    .first();
  return Boolean(membership && membership.isActive);
}
