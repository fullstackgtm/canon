import { ConvexError } from "convex/values";
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { awaitsLogin } from "./lib/clerkRoles";
import { seedEnablements } from "./lib/recipes";
import { seedDefaultModules } from "./moduleDefaults";

type UserArgs = Parameters<NonNullable<NonNullable<ConvexAuthConfig["callbacks"]>["createOrUpdateUser"]>>[1];

export async function createOrUpdateUser(ctx: MutationCtx, args: UserArgs): Promise<Id<"users">> {
  if (process.env.CANON_AUTH !== "convex") throw new ConvexError("Convex Auth is disabled");
  if (args.existingUserId) return args.existingUserId;
  const email = args.profile.email?.trim().toLowerCase();
  if (!email) throw new ConvexError("An email address is required");
  const now = Date.now();
  const verified = args.profile.emailVerified === true || args.type === "verification" ||
    (args.type === "oauth" && args.profile.email_verified === true);
  // Indexed exact match on the normalized address; capped so a common address can never scan the table.
  // Rows stored with different casing are not linked here (PR 2 normalizes stored member emails).
  const matches = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).take(2);
  if (matches.length > 1) throw new ConvexError("Multiple members use this email. Ask an administrator to resolve them.");
  const member = matches[0];
  if (member) {
    if (member.emailVerificationTime === undefined && await ctx.db.query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", member._id).eq("provider", "password")).first()) {
      // An unverified password account must not retain access when the address owner arrives via OAuth/email.
      throw new ConvexError("Sign in with your password or reset it before linking another sign-in method.");
    }
    // Knowing an invited or migrated member's address must not grant their workspace access.
    if (!verified && args.type !== "email") throw new ConvexError("Verify this email before linking an existing member. Use email sign-in or Google.");
    await ctx.db.patch(member._id, {
      ...(awaitsLogin(member.clerkUserId) ? { clerkUserId: `convex_${member._id}` } : {}),
      ...(verified ? { emailVerificationTime: now } : {}), lastLoginAt: now,
    });
    return member._id;
  }
  const key = crypto.randomUUID();
  const orgId = await ctx.db.insert("organizations", {
    clerkOrgId: `convex_${key}`, name: "My workspace", slug: `convex-${key}`,
    fiscalYearStartMonth: 1, defaultCurrency: "USD", timezone: "UTC", planTier: "free", createdAt: now, updatedAt: now,
  });
  await seedEnablements(ctx, orgId, now);
  await seedDefaultModules(ctx, orgId);
  const userId = await ctx.db.insert("users", {
    clerkUserId: `convex_pending_${key}`, orgId, activeOrgId: orgId, email,
    name: typeof args.profile.name === "string" ? args.profile.name : email.split("@")[0],
    role: "admin", isActive: true, createdAt: now, lastLoginAt: now,
    ...(verified ? { emailVerificationTime: now } : {}),
  });
  // A marked surrogate keeps legacy member indexes and paired CLI identities usable without Clerk.
  await ctx.db.patch(userId, { clerkUserId: `convex_${userId}` });
  await ctx.db.insert("orgMemberships", { userId, orgId, role: "admin", isActive: true, createdAt: now, updatedAt: now });
  return userId;
}
