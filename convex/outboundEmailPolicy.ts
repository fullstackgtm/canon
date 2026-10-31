import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { agentClientOf, getCurrentUser } from "./lib";
import { can } from "./lib/capabilities";
import { accessFor, roleIn } from "./permissions";
import { DEFAULT_RECIPIENT_WEEKLY_CAP, normalizedPostalAddress, validRecipientWeeklyCap } from "./lib/outbound/emailPolicy";

async function humanAdmin(ctx: QueryCtx) {
  if (await agentClientOf(ctx)) return null;
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  const stored = await ctx.db.get(user._id);
  const role = stored ? await roleIn(ctx, stored, user.orgId) : null;
  if (!stored?.isActive || stored.isHidden || !role) return null;
  const principal = { ...user, role };
  if (!can(principal, "outbound.manage") || (await accessFor(ctx, principal)).preview) return null;
  const org = await ctx.db.get(user.orgId);
  return org ? { user: principal, org } : null;
}

export const get = query({
  args: {},
  handler: async (ctx) => {
    const session = await humanAdmin(ctx);
    if (!session) return null;
    const policy = session.org.outboundEmailPolicy;
    return { postalAddress: policy?.postalAddress ?? "", recipientWeeklyCap: policy?.recipientWeeklyCap ?? DEFAULT_RECIPIENT_WEEKLY_CAP,
      timezone: session.org.timezone, updatedAt: policy?.updatedAt ?? null };
  },
});

export const save = mutation({
  args: { postalAddress: v.string(), recipientWeeklyCap: v.number() },
  handler: async (ctx, args) => {
    const session = await humanAdmin(ctx);
    if (!session) throw new ConvexError("Use an active human admin session outside a preview to manage outbound email policy.");
    const postalAddress = normalizedPostalAddress(args.postalAddress);
    if (postalAddress === null) throw new ConvexError("Enter a plain-text postal address of at most 500 characters, or clear it.");
    if (!validRecipientWeeklyCap(args.recipientWeeklyCap)) {
      throw new ConvexError("Choose a weekly recipient cap from one to three.");
    }
    await ctx.db.patch(session.org._id, { outboundEmailPolicy: { postalAddress, recipientWeeklyCap: args.recipientWeeklyCap, updatedAt: Date.now(), updatedBy: session.user._id } });
    return null;
  },
});
