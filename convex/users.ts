import { query, mutation, action, internalQuery, internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { appUrl } from "./lib/operatorConfig";
import { orgRolesOf, requireRoleKey, roleBasesOf } from "./permissions";
import { baseRole } from "./lib/roles";
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { awaitsLogin, syncedRole } from "./lib/clerkRoles";
import { revokeMemberCredentials } from "./lib/membership";

/** A calendar day as YYYY-MM-DD that is a real date. */
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

const roleValidator = v.union(
  v.literal("admin"),
  v.literal("manager"),
  v.literal("rep"),
  v.literal("other"),
);

type AppRole = "admin" | "manager" | "rep" | "other";

async function upsertMembership(
  ctx: MutationCtx,
  userId: Id<"users">,
  orgId: Id<"organizations">,
  role: string,
) {
  const existing = await ctx.db
    .query("orgMemberships")
    .withIndex("by_userId_orgId", (q) => q.eq("userId", userId).eq("orgId", orgId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, { role, isActive: true, updatedAt: Date.now() });
    return existing._id;
  }
  return ctx.db.insert("orgMemberships", {
    userId,
    orgId,
    role,
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function userReadinessFromRows(users: any[]) {
  const active = users.filter((member) => member.isActive && !member.isHidden);
  const reps = active.filter((member) => member.role === "rep");
  const managers = active.filter((member) => member.role === "manager" || member.role === "admin");
  const unassignedReps = reps.filter((member) => !member.managerId).length;
  return {
    noun: "user",
    required: true,
    relevant: users.length > 0,
    configured: active.length > 0,
    lifecycle: active.length > 0 ? "active" : "not_configured",
    signals: { userCount: users.length, activeUsers: active.length, repCount: reps.length, managerCount: managers.length, unassignedReps },
    nextActions: active.length > 0 ? ["review manager hierarchy", "set user.role"] : ["invite users", "sync users from CRM"],
  };
}

function emptyUserReadiness() {
  return {
    noun: "user",
    required: true,
    relevant: false,
    configured: false,
    lifecycle: "not_configured",
    signals: { userCount: 0, activeUsers: 0, repCount: 0, managerCount: 0, unassignedReps: 0 },
    nextActions: ["Sign in to inspect user readiness"],
  };
}

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return emptyUserReadiness();
    const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    return userReadinessFromRows(users);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return { readiness: emptyUserReadiness(), users: [], roles: [] };
    const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(500);
    // The workspace's own roles, for the Team page's role picker (lib/roles.ts).
    const roles = (await orgRolesOf(ctx, user.orgId)).map((r) => ({ key: r.key, name: r.name, base: r.base }));
    return { readiness: userReadinessFromRows(users), users, roles };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("users")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .take(200);
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    return getCurrentUser(ctx);
  },
});

export const update = mutation({
  args: {
    userId: v.id("users"),
    name: v.optional(v.string()),
    title: v.optional(v.string()),
    /** A built-in role or one of the workspace's own (lib/roles.ts). */
    role: v.optional(v.string()),
    managerId: v.optional(v.union(v.id("users"), v.null())),
    isActive: v.optional(v.boolean()),
    /** Hidden from Settings > Team's list and every member picker, as a former or test member is; still a member. */
    isHidden: v.optional(v.boolean()),
    /** Employment dates (YYYY-MM-DD); null clears one. */
    startDate: v.optional(v.union(v.string(), v.null())),
    endDate: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!can(actor, "team.edit")) throw new ConvexError(refusal("team.edit"));

    const target = await ctx.db.get(args.userId);
    if (!target || target.orgId !== actor.orgId) {
      throw new ConvexError("User not found");
    }

    if (!can(actor, "members.manage") && (args.role !== undefined || args.isActive !== undefined || args.isHidden !== undefined)) throw new ConvexError(refusal("members.manage"));

    const bases = await roleBasesOf(ctx, actor.orgId);
    if (args.managerId) {
      if (args.managerId === args.userId) {
        throw new ConvexError("A team member cannot manage themselves");
      }
      const manager = await ctx.db.get(args.managerId);
      if (!manager || manager.orgId !== actor.orgId) {
        throw new ConvexError("Manager not found");
      }
      if (!manager.isActive || !["admin", "manager"].includes(baseRole(manager.role, bases))) {
        throw new ConvexError("Manager must be an active manager or admin");
      }
      if (await reportsTo(ctx, manager._id, args.userId)) throw new ConvexError(`${manager.name} reports to ${target.name}: pick someone outside their reporting line`);
    }

    if (target.role === "admin" && target.isActive && ((args.role !== undefined && args.role !== "admin") || args.isActive === false)) {
      const admins = await ctx.db.query("users").withIndex("by_orgId_role", (q) => q.eq("orgId", actor.orgId).eq("role", "admin")).take(50);
      if (!admins.some((a) => a._id !== target._id && a.isActive)) throw new ConvexError("The workspace needs another active admin first");
    }

    if (args.role !== undefined) await requireRoleKey(ctx, actor.orgId, args.role);
    // A member brought back must hold a role that still exists, or they'd have none of its rules.
    if (args.isActive === true && args.role === undefined) await requireRoleKey(ctx, actor.orgId, target.role);

    const managerLosesEligibility =
      args.isActive === false || (args.role !== undefined && !["admin", "manager"].includes(baseRole(args.role, bases)));
    if (managerLosesEligibility) {
      const directReport = await ctx.db
        .query("users")
        .withIndex("by_managerId", (q) => q.eq("managerId", args.userId))
        .first();
      if (directReport) {
        throw new ConvexError("Reassign direct reports before changing this manager");
      }
    }

    const cleanUpdates: {
      name?: string;
      title?: string;
      role?: string;
      managerId?: Id<"users">;
      isActive?: boolean;
      isHidden?: boolean;
      startDate?: string;
      endDate?: string;
    } = {};
    for (const k of ["startDate", "endDate"] as const) {
      const d = args[k];
      if (d === undefined) continue;
      if (d !== null && !isDay(d)) throw new ConvexError(`${k === "startDate" ? "Start" : "End"} date must be a date (YYYY-MM-DD)`);
      cleanUpdates[k] = d ?? undefined;
    }
    const start = args.startDate === undefined ? target.startDate : args.startDate ?? undefined;
    const end = args.endDate === undefined ? target.endDate : args.endDate ?? undefined;
    if (start && end && end < start) throw new ConvexError("End date can't be before the start date");

    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new ConvexError("Name is required");
      cleanUpdates.name = name;
    }
    if (args.title !== undefined) {
      const title = args.title.trim();
      if (title) cleanUpdates.title = title;
      else cleanUpdates.title = undefined;
    }
    if (args.role !== undefined) cleanUpdates.role = args.role;
    if (args.managerId !== undefined) {
      cleanUpdates.managerId = args.managerId ?? undefined;
    }
    if (args.isActive !== undefined) cleanUpdates.isActive = args.isActive;
    if (args.isHidden !== undefined) cleanUpdates.isHidden = args.isHidden || undefined;

    const turnedOff = args.isActive === false && target.isActive;
    await ctx.db.patch(args.userId, cleanUpdates);
    // The membership row is what a session in this org reads its role from (lib.ts scopeUserToActiveOrg), and is on
    // exactly when the member is (lib/membership.ts activeRoleIn).
    const membership = cleanUpdates.role !== undefined || args.isActive !== undefined
      ? await ctx.db.query("orgMemberships").withIndex("by_userId_orgId", (q) => q.eq("userId", args.userId).eq("orgId", actor.orgId)).first()
      : null;
    if (membership) {
      await ctx.db.patch(membership._id, {
        ...(cleanUpdates.role !== undefined ? { role: cleanUpdates.role } : {}),
        ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
        updatedAt: Date.now(),
      });
    }
    // Turned off, they lose what Canon issued them here; turned back on, they sign in and pair again.
    if (turnedOff) await revokeMemberCredentials(ctx, target, actor.orgId);
  },
});

/** The most managers a reporting line is walked up: past it the line is treated as a loop. */
const MAX_CHAIN = 50;

/** Whether `memberId` is `bossId` or reports to them, directly or through others; `managers` overrides stored managers (an import's). */
async function reportsTo(ctx: MutationCtx, memberId: Id<"users">, bossId: Id<"users">, managers?: ReadonlyMap<string, Id<"users"> | null>): Promise<boolean> {
  let at: Id<"users"> | null | undefined = memberId;
  for (let i = 0; at && i < MAX_CHAIN; i++) {
    if (at === bossId) return true;
    const id: Id<"users"> = at;
    at = managers?.has(id) ? managers.get(id) : (await ctx.db.get(id))?.managerId;
  }
  return Boolean(at);
}

/** A member Canon adds with no login (clerkUserId `member:<org>:<email>`): they own deals and sit on teams, and never sign in. */
export const NO_LOGIN_PREFIX = "member:";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add a member who doesn't sign in (Settings > Team, New member; a CSV import's unknown owner): a rep who left, a
 * partner, someone whose deals and commissions are tracked before their invite. Admins only. If they later accept
 * an invite with the same email, their Clerk account takes this record over (upsertFromClerk).
 */
export const createMember = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    role: v.optional(v.string()),
    title: v.optional(v.string()),
    managerId: v.optional(v.id("users")),
    startDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!can(actor, "members.manage")) throw new ConvexError(refusal("members.manage"));
    const name = args.name.trim();
    const email = args.email.trim().toLowerCase();
    if (!name) throw new ConvexError("Name is required");
    if (!EMAIL.test(email)) throw new ConvexError("Email must be an email address");
    const taken = await ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", actor.orgId).eq("email", email)).first();
    if (taken) throw new ConvexError(`${taken.name} already has the email ${email}`);
    const role = args.role ?? "rep";
    await requireRoleKey(ctx, actor.orgId, role);
    if (args.startDate !== undefined && !isDay(args.startDate)) throw new ConvexError("Start date must be a date (YYYY-MM-DD)");
    if (args.managerId) {
      const manager = await ctx.db.get(args.managerId);
      const bases = await roleBasesOf(ctx, actor.orgId);
      if (!manager || manager.orgId !== actor.orgId || !manager.isActive || !["admin", "manager"].includes(baseRole(manager.role, bases))) {
        throw new ConvexError("Manager must be an active manager or admin");
      }
    }
    const title = args.title?.trim();
    return ctx.db.insert("users", {
      clerkUserId: `${NO_LOGIN_PREFIX}${actor.orgId}:${email}`,
      orgId: actor.orgId,
      email,
      name,
      role,
      isActive: true,
      createdAt: Date.now(),
      ...(title ? { title } : {}),
      ...(args.managerId ? { managerId: args.managerId } : {}),
      ...(args.startDate ? { startDate: args.startDate } : {}),
    });
  },
});

/** Who Settings > Team may invite, and from which Clerk org: refuses unless the caller manages members of that workspace. */
export const inviteTarget = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!can(actor, "members.manage")) throw new ConvexError(refusal("members.manage"));
    const member = await ctx.db.get(args.userId);
    if (!member || member.orgId !== actor.orgId) throw new ConvexError("Member not found");
    const org = await ctx.db.get(member.orgId);
    if (!org) throw new ConvexError("Workspace not found");
    return { email: member.email, admin: member.role === "admin", clerkOrgId: org.clerkOrgId, inviter: actor.clerkUserId };
  },
});

/** Record the invite, so the Login column reads "Invited" until they accept. */
export const recordInvite = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { invitedAt: Date.now() });
  },
});

/**
 * Send a member Clerk's invite email to this workspace. Sent from the server because only Clerk's Backend API takes a
 * redirect: Accept lands on this app's /sign-up (which redeems the ticket), not Clerk's hosted pages. Accepting signs
 * them in as this member (upsertFromClerk takes over the record by email).
 */
export const invite = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<void> => {
    const target = await ctx.runQuery(internal.users.inviteTarget, args);
    const key = process.env.CLERK_SECRET_KEY;
    if (!key) throw new ConvexError("Invites aren't set up on this deployment (CLERK_SECRET_KEY)");
    const res = await fetch(`https://api.clerk.com/v1/organizations/${target.clerkOrgId}/invitations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email_address: target.email,
        // Clerk decides only who is an admin; every other role stays Canon's (lib/clerkRoles.ts:syncedRole).
        role: target.admin ? "org:admin" : "org:member",
        ...(target.inviter.startsWith("user_") ? { inviter_user_id: target.inviter } : {}),
        redirect_url: `${appUrl() ?? "http://localhost:3000"}/sign-up`,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { errors?: { long_message?: string; message?: string }[] } | null;
      const reason = body?.errors?.[0]?.long_message ?? body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new ConvexError(`Clerk didn't send the invite: ${reason}`);
    }
    await ctx.runMutation(internal.users.recordInvite, args);
  },
});

/**
 * Set reporting lines from a CSV's rows (Settings > Team, Import reporting lines): each names a member by email and
 * their manager by email (empty clears it). Every row is checked as one edit on the Team page is, against the lines
 * the rows before it set, so the file never makes a loop. `apply: false` only says what each row would do.
 */
export const importReportingLines = mutation({
  args: { rows: v.array(v.object({ email: v.string(), managerEmail: v.string() })), apply: v.boolean() },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!can(actor, "team.edit")) throw new ConvexError(refusal("team.edit"));
    if (args.rows.length > 500) throw new ConvexError("Import at most 500 reporting lines at a time");
    const members = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", actor.orgId)).take(1000);
    const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
    const bases = await roleBasesOf(ctx, actor.orgId);
    const lines = new Map<string, Id<"users"> | null>();
    const out: Array<{ row: number; email: string; status: "set" | "cleared" | "unchanged" | "refused"; manager?: string; message?: string }> = [];
    for (const [i, r] of args.rows.entries()) {
      const row = i + 2;
      const email = r.email.trim().toLowerCase();
      const managerEmail = r.managerEmail.trim().toLowerCase();
      const member = byEmail.get(email);
      if (!member) { out.push({ row, email, status: "refused", message: `No member has the email ${email}` }); continue; }
      const manager = managerEmail ? byEmail.get(managerEmail) : null;
      if (managerEmail && !manager) { out.push({ row, email, status: "refused", message: `No member has the email ${managerEmail}` }); continue; }
      const now = lines.has(member._id) ? lines.get(member._id) : member.managerId ?? null;
      if (!manager) {
        out.push({ row, email, status: now ? "cleared" : "unchanged" });
        lines.set(member._id, null);
        continue;
      }
      let refused: string | null = null;
      if (manager._id === member._id) refused = "A member can't manage themselves";
      else if (!manager.isActive || !["admin", "manager"].includes(baseRole(manager.role, bases))) refused = `${manager.name} isn't an active manager or admin`;
      else if (await reportsTo(ctx, manager._id, member._id, lines)) refused = `${manager.name} reports to ${member.name}`;
      if (refused) { out.push({ row, email, status: "refused", message: refused }); continue; }
      out.push({ row, email, status: now === manager._id ? "unchanged" : "set", manager: manager.name });
      lines.set(member._id, manager._id);
    }
    if (args.apply) {
      for (const [id, managerId] of lines) {
        const member = members.find((m) => m._id === id)!;
        if ((member.managerId ?? null) !== managerId) await ctx.db.patch(member._id, { managerId: managerId ?? undefined });
      }
    }
    return out;
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    clerkOrgId: v.string(),
    email: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    role: roleValidator,
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    if (!org) throw new Error(`Organization not found: ${args.clerkOrgId}`);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();

    if (existing) {
      // A membership event for a SECOND org must not repoint the user's home
      // org — that was the bug where joining a client org hijacked every
      // session. Home org (and its mirrored role) only update when the event
      // is FOR the home org; other orgs live in orgMemberships.
      const home = existing.orgId === org._id;
      const membership = await ctx.db
        .query("orgMemberships")
        .withIndex("by_userId_orgId", (q) => q.eq("userId", existing._id).eq("orgId", org._id))
        .first();
      const role = syncedRole(args.role, membership?.role ?? (home ? existing.role : undefined));
      const updates: Record<string, unknown> = {
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
        isActive: true,
      };
      if (home) updates.role = role;
      await ctx.db.patch(existing._id, updates);
      await upsertMembership(ctx, existing._id, org._id, role);
      return existing._id;
    }

    // A member Canon added with no login, or a synced CRM owner, at this email: their invite takes the record over,
    // deals and lines and all (a CRM owner keeps crmOwnerId, so owner sync still finds them).
    // Clerk still decides who is an admin; the record's role is kept otherwise, as on any membership event.
    const added = await ctx.db.query("users").withIndex("by_orgId_email", (q) => q.eq("orgId", org._id).eq("email", args.email.trim().toLowerCase())).first();
    if (added && awaitsLogin(added.clerkUserId)) {
      const role = syncedRole(args.role, added.role);
      await ctx.db.patch(added._id, { clerkUserId: args.clerkUserId, name: args.name, imageUrl: args.imageUrl, role, isActive: true });
      await upsertMembership(ctx, added._id, org._id, role);
      return added._id;
    }

    const userId = await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      orgId: org._id,
      email: args.email,
      name: args.name,
      imageUrl: args.imageUrl,
      role: args.role,
      isActive: true,
      createdAt: Date.now(),
    });
    await upsertMembership(ctx, userId, org._id, args.role);
    return userId;
  },
});

export const patchFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      email: args.email,
      name: args.name,
      imageUrl: args.imageUrl,
    });
    return existing._id;
  },
});

// user.deleted: the Clerk account is gone — deactivate the user AND every
// membership. Read budget: one user + their handful of membership rows.
export const deactivateFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (!user) return;
    await ctx.db.patch(user._id, { isActive: false });
    await revokeMemberCredentials(ctx, user, null);
    const memberships = await ctx.db
      .query("orgMemberships")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    for (const membership of memberships) {
      if (membership.isActive) {
        await ctx.db.patch(membership._id, { isActive: false, updatedAt: Date.now() });
      }
    }
  },
});

// organizationMembership.deleted: revoke ONE org, not the whole account. If
// the revoked org was the user's home org, fall back to another active
// membership; only deactivate the user when no memberships remain.
export const removeMembershipFromClerk = internalMutation({
  args: { clerkUserId: v.string(), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (!user) return;

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    if (!org) return;

    const membership = await ctx.db
      .query("orgMemberships")
      .withIndex("by_userId_orgId", (q) => q.eq("userId", user._id).eq("orgId", org._id))
      .first();
    if (membership && membership.isActive) {
      await ctx.db.patch(membership._id, { isActive: false, updatedAt: Date.now() });
    }
    await revokeMemberCredentials(ctx, user, org._id);

    if (user.orgId !== org._id) return;

    const remaining = await ctx.db
      .query("orgMemberships")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    const next = remaining.find((m) => m.isActive && m.orgId !== org._id);
    if (next) {
      await ctx.db.patch(user._id, { orgId: next.orgId, role: next.role });
    } else {
      await ctx.db.patch(user._id, { isActive: false });
    }
  },
});

// One-time migration: give every existing user a membership row for their
// home org (webhooks only create rows going forward). Idempotent. Run with
// `npx convex run users:backfillMemberships`. Read budget: users table is org
// staff (tens of rows) + one point lookup each — far under the 4096 cap.
export const backfillMemberships = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let created = 0;
    for (const user of users) {
      const existing = await ctx.db
        .query("orgMemberships")
        .withIndex("by_userId_orgId", (q) =>
          q.eq("userId", user._id).eq("orgId", user.orgId),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert("orgMemberships", {
        userId: user._id,
        orgId: user.orgId,
        role: user.role,
        isActive: user.isActive,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      created += 1;
    }
    return { users: users.length, created };
  },
});

// Repair tool for memberships the old webhook handler lost (it overwrote
// users.orgId instead of recording a row, so earlier orgs vanished). Run with
// `npx convex run users:grantMembership '{"email":"...","orgSlug":"...","role":"admin"}'`.
// Pass makeHome:true to also repoint the user's home org. Read budget: one
// org lookup + a scan of the small users table.
export const grantMembership = internalMutation({
  args: {
    email: v.string(),
    orgSlug: v.string(),
    role: roleValidator,
    makeHome: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.orgSlug))
      .first();
    if (!org) throw new Error(`Organization not found: ${args.orgSlug}`);

    const users = await ctx.db.query("users").collect();
    const email = args.email.toLowerCase();
    const user = users.find((u) => u.email.toLowerCase() === email);
    if (!user) throw new Error(`User not found: ${args.email}`);

    await upsertMembership(ctx, user._id, org._id, args.role);
    if (args.makeHome) {
      await ctx.db.patch(user._id, { orgId: org._id, role: args.role });
    }
    return { userId: user._id, orgId: org._id, org: org.name };
  },
});
