import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { awaitsLogin } from "./lib/clerkRoles";
import { credentialMember } from "./lib/membership";
import { seedEnablements } from "./lib/recipes";
import { seedDefaultModules } from "./moduleDefaults";

async function requireBroker(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (process.env.CANON_AUTH !== "local" || !identity ||
      identity.issuer !== process.env.CANON_SERVICE_JWT_ISSUER || identity.subject !== "local_auth_server") {
    throw new ConvexError("Local auth server required");
  }
}

const sessionArgs = { tokenHash: v.string(), expiresAt: v.number() };
const registrationArgs = { email: v.string(), name: v.string(), passwordHash: v.string(), subject: v.string(), ...sessionArgs };

export const setupNeeded = query({
  args: {},
  handler: async (ctx) => {
    await requireBroker(ctx);
    return !(await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", "local")).unique());
  },
});

/** Whether the first owner has yet to register. The container's entrypoint asks, to print the setup code only then. */
export const setupPending = internalQuery({
  args: {},
  handler: async (ctx) => process.env.CANON_AUTH === "local" &&
    !(await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", "local")).unique()),
});

export const credential = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireBroker(ctx);
    return ctx.db.query("localCredentials").withIndex("by_email", (q) => q.eq("email", email)).unique();
  },
});

export const session = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    await requireBroker(ctx);
    const session = await ctx.db.query("localSessions").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const found = await ctx.db.get(session.userId);
    const user = found && await credentialMember(ctx, found, found.orgId);
    if (!user) return null;
    const org = await ctx.db.get(user.orgId);
    if (!org || org.clerkOrgId !== "local") return null;
    return { user, org };
  },
});

export const register = mutation({
  args: { ...registrationArgs, inviteHash: v.optional(v.string()), workspaceName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireBroker(ctx);
    const now = Date.now();
    if (!/^local_[a-f0-9-]{36}$/.test(args.subject)) throw new ConvexError("Invalid local identity");
    if (await ctx.db.query("localCredentials").withIndex("by_email", (q) => q.eq("email", args.email)).unique()) {
      throw new ConvexError("This email already has a login");
    }
    let userId;
    if (args.inviteHash) {
      const invite = await ctx.db.query("localInvites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.inviteHash!)).unique();
      if (!invite || invite.expiresAt <= now) throw new ConvexError("Invitation is invalid or expired");
      const member = await ctx.db.get(invite.userId);
      if (!member?.isActive || member.email.trim().toLowerCase() !== args.email || !awaitsLogin(member.clerkUserId)) throw new ConvexError("Invitation does not match this email");
      userId = member._id;
      await ctx.db.patch(userId, { clerkUserId: args.subject, lastLoginAt: now });
      await ctx.db.delete(invite._id);
    } else {
      const org = await ctx.db.query("organizations").withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", "local")).unique();
      if (org) throw new ConvexError("Setup is complete. Ask an admin for an invitation.");
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "local", name: args.workspaceName || "My workspace", slug: "local",
        fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC", planTier: "free", createdAt: now, updatedAt: now,
      });
      await seedEnablements(ctx, orgId, now);
      await seedDefaultModules(ctx, orgId);
      userId = await ctx.db.insert("users", {
        clerkUserId: args.subject, orgId, email: args.email, name: args.name, role: "admin",
        isActive: true, createdAt: now, lastLoginAt: now,
      });
    }
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("Member not found");
    await ctx.db.insert("orgMemberships", { userId, orgId: user.orgId, role: user.role, isActive: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("localCredentials", { email: args.email, userId, passwordHash: args.passwordHash });
    await ctx.db.insert("localSessions", { tokenHash: args.tokenHash, userId, expiresAt: args.expiresAt });
    return null;
  },
});

export const signIn = mutation({
  args: { credentialId: v.id("localCredentials"), passwordHash: v.string(), ...sessionArgs },
  handler: async (ctx, args) => {
    await requireBroker(ctx);
    const credential = await ctx.db.get(args.credentialId);
    const found = credential && await ctx.db.get(credential.userId);
    const user = found && await credentialMember(ctx, found, found.orgId);
    if (!credential || credential.passwordHash !== args.passwordHash || !user) throw new ConvexError("Sign-in failed");
    await ctx.db.insert("localSessions", { tokenHash: args.tokenHash, userId: user._id, expiresAt: args.expiresAt });
    await ctx.db.patch(user._id, { lastLoginAt: Date.now() });
    return null;
  },
});

export const signOut = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    await requireBroker(ctx);
    const session = await ctx.db.query("localSessions").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (session) await ctx.db.delete(session._id);
    return null;
  },
});

export const invite = mutation({
  args: { userId: v.id("users"), tokenHash: v.string() },
  handler: async (ctx, args) => {
    if (process.env.CANON_AUTH !== "local") throw new ConvexError("Local auth is disabled");
    const actor = await requireUser(ctx);
    if (!can(actor, "members.manage")) throw new ConvexError(refusal("members.manage"));
    const member = await ctx.db.get(args.userId);
    if (!member?.isActive || member.orgId !== actor.orgId || !awaitsLogin(member.clerkUserId)) throw new ConvexError("This member cannot be invited");
    const existing = await ctx.db.query("localInvites").withIndex("by_userId", (q) => q.eq("userId", member._id)).unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("localInvites", { tokenHash: args.tokenHash, userId: member._id, expiresAt: Date.now() + 7 * 86400_000 });
    await ctx.db.patch(member._id, { invitedAt: Date.now() });
    return null;
  },
});
