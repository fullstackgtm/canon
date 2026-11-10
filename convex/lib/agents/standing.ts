/**
 * Whether an org-owned agent may act, and whether a user may own one
 * (docs/org-agents.md, phase 1). Pure: the Convex shell (convex/agents.ts)
 * loads the owner's rows and asks these functions.
 *
 * Standing precedence: archived, then a stored pause (it latches until a
 * person clears it), then a problem derived from the owner now (queries show
 * it before any mutation has latched it), then active.
 */
import { baseRole } from "../roles.ts";
import type { Doc, Id } from "../../_generated/dataModel";

/** Any full member may own an agent. Clerk maps every non-admin role to rep, so a higher floor would pause agents on each membership webhook. */
export const OWNER_ROLES = ["admin", "manager", "rep"] as const;
export type Role = Doc<"users">["role"];

export const PAUSE_REASON_KEYS = [
  "paused_by_user",
  "owner_missing",
  "owner_inactive",
  "owner_not_member",
  "owner_role",
  "owner_placeholder",
] as const;
export type PauseReason = (typeof PAUSE_REASON_KEYS)[number];
export type OwnerProblem = Exclude<PauseReason, "paused_by_user">;

/**
 * What each reason means: what people read while the agent is paused, and for
 * an owner problem (which only an admin can clear) why a person can't own one.
 */
export const PAUSE_REASONS: Record<PauseReason, { message: string; refusal: string | null }> = {
  paused_by_user: { message: "Paused by its owner or an admin", refusal: null },
  owner_missing: { message: "Paused: owner no longer exists", refusal: "That person no longer exists." },
  owner_inactive: { message: "Paused: owner was deactivated", refusal: "That person is deactivated." },
  owner_not_member: { message: "Paused: owner left the workspace", refusal: "That person is not a member of this workspace." },
  owner_role: { message: "Paused: owner's role can't own agents", refusal: "That person's role can't own agents." },
  owner_placeholder: { message: "Paused: owner is a CRM record, not a person", refusal: "That is a CRM record, not a person." },
};

export function isOwnerCaused(reason: PauseReason): reason is OwnerProblem {
  return PAUSE_REASONS[reason].refusal !== null;
}

export const ARCHIVED_MESSAGE = "Archived: its field was deleted";

export type Standing =
  | { status: "active" }
  | { status: "paused"; reason: PauseReason }
  | { status: "archived" };

/** Everything standing needs about the owner, as plain rows so the rule is unit-testable. */
export type OwnerFacts = {
  orgId: Id<"organizations">;
  user: Pick<Doc<"users">, "orgId" | "role" | "isActive" | "clerkUserId"> | null;
  /** The owner's orgMemberships row for `orgId`, if any. */
  membership: Pick<Doc<"orgMemberships">, "role" | "isActive"> | null;
  /** The base of each of the workspace's own roles (convex/permissions.ts roleBasesOf). */
  bases?: Readonly<Record<string, string>>;
};

export type OwnerRule = { ok: true; role: Role } | { ok: false; reason: OwnerProblem };

/** CRM owner sync's pseudo-users (convex/hubspot.ts, convex/salesforce.ts) have `<provider>:<org>:<ownerId>` ids and may hold backfilled membership rows. */
export function isCrmPlaceholder(user: { clerkUserId: string }): boolean {
  return /^(hubspot|salesforce):/.test(user.clerkUserId);
}

/**
 * May this user be accountable for an agent in this org now? Mirrors
 * getCurrentUser's org scoping: the home org's role is users.role, any other
 * org's is the membership's. A home-org user with no membership row counts
 * (the dev seed, and rows from before the membership backfill).
 */
export function ownerRuleOf(f: OwnerFacts): OwnerRule {
  if (!f.user) return { ok: false, reason: "owner_missing" };
  if (isCrmPlaceholder(f.user)) return { ok: false, reason: "owner_placeholder" };
  if (!f.user.isActive) return { ok: false, reason: "owner_inactive" };
  const home = f.user.orgId === f.orgId;
  if (f.membership ? !f.membership.isActive : !home) return { ok: false, reason: "owner_not_member" };
  const role = baseRole(home ? f.user.role : f.membership!.role, f.bases ?? {});
  return (OWNER_ROLES as readonly string[]).includes(role) ? { ok: true, role: role as Role } : { ok: false, reason: "owner_role" };
}

export function standingOf(agent: Pick<Doc<"agents">, "pause" | "archivedAt">, owner: OwnerFacts): Standing {
  if (agent.archivedAt !== undefined) return { status: "archived" };
  if (agent.pause) return { status: "paused", reason: agent.pause.reason };
  const rule = ownerRuleOf(owner);
  return rule.ok ? { status: "active" } : { status: "paused", reason: rule.reason };
}

export function standingMessage(s: Standing): string | null {
  return s.status === "active" ? null : s.status === "archived" ? ARCHIVED_MESSAGE : PAUSE_REASONS[s.reason].message;
}
