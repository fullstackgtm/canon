/**
 * LinkedIn accounts for invite and message cadences (docs/linkedin-cadences.md,
 * slice L1). One connected account per user in each org, connected through Unipile's hosted
 * login (convex/linkedinActions.ts). Canon stores only Unipile's account id.
 *
 * The owner edits their sending window and limits. A limit above Canon's
 * recommendation needs an admin; nothing goes above the hard ceiling
 * (convex/lib/linkedin/limits.ts).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser, userBelongsToOrg } from "./lib";
import {
  DEFAULT_TIMEZONE, DEFAULT_WINDOW, HARD_CEILING, NEW_ACCOUNT, RECOMMENDED,
  ceilingFor, noteLimit, validTimezone, validateOverrides, validateWindow,
} from "./lib/linkedin/limits";
import { statusFromUnipile } from "./lib/linkedin/unipile";
import { senderCapacity } from "./lib/linkedin/sender";
import { publishSender } from "./lib/linkedin/feedProjection";
import { intakeView } from "./lib/conversations/intakeJob";

const sendWindow = v.object({ days: v.array(v.number()), startMinute: v.number(), endMinute: v.number() });
const overrides = v.object({
  invitesPerDay: v.optional(v.number()),
  invitesPerWeek: v.optional(v.number()),
  messagesPerDay: v.optional(v.number()),
  lookupsPerDay: v.optional(v.number()),
});
const tier = v.union(v.literal("free"), v.literal("premium"), v.literal("sales_navigator"));
const SENDERS_MAX = 200;

/** Whether Canon's Unipile key is set on this deployment. */
const configured = () => integrationEnabled("unipile");

/** Whether a member (with the capabilities of a workspace role, lib.ts withRole) holds shared.moderate. */
const isAdmin = (who: { role: string; capabilities?: readonly string[] }) => can(who, "shared.moderate");

/** The user's account in this org. A user in several orgs connects once per org. */
async function accountOf(ctx: QueryCtx, userId: Id<"users">, orgId: Id<"organizations">) {
  const rows = await ctx.db.query("linkedinAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).take(SENDERS_MAX);
  return rows.find((r) => r.orgId === orgId) ?? null;
}

/** An account as its owner sees it: settings and the caps they lead to. Never the Unipile id. */
async function view(ctx: QueryCtx, row: Doc<"linkedinAccounts">) {
  const now = Date.now();
  const t = await senderCapacity(ctx, row, now);
  return {
    _id: row._id,
    status: row.status,
    statusReason: row.statusReason ?? null,
    profileName: row.profileName ?? null,
    publicIdentifier: row.publicIdentifier ?? null,
    tier: row.tier,
    timezone: row.timezone,
    window: row.window,
    overrides: row.overrides,
    salesNavHighVolume: row.salesNavHighVolume ?? false,
    rampStep: row.rampStep,
    connectedAt: row.connectedAt,
    today: t.limits,
    usage: t.usage,
    pendingInvites: t.pending,
    acceptance: t.acceptance,
    invitePause: t.health.invitePause,
    throttled: t.health.factor < 1,
    holdUntil: (row.holdUntil ?? 0) > now ? row.holdUntil! : null,
    inviteHoldUntil: (row.inviteHoldUntil ?? 0) > now ? row.inviteHoldUntil! : null,
    holdReason: row.holdReason ?? null,
    recommended: RECOMMENDED,
    ceiling: ceilingFor(row.tier, row.salesNavHighVolume),
    newAccount: NEW_ACCOUNT,
    noteLimit: noteLimit(row.tier),
    // Conversation intake (convex/conversations.ts): whether Canon reads this account's messages, and whether any are stored.
    intake: await intakeView(ctx, row),
  };
}

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const row = await accountOf(ctx, user._id, user.orgId);
    return {
      configured: configured(),
      isAdmin: isAdmin(user),
      account: row && row.status !== "disconnected" ? await view(ctx, row) : null,
      hardCeiling: HARD_CEILING,
    };
  },
});

/** The org's connected senders, for picking who a cadence sends from. */
export const senders = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("linkedinAccounts").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(SENDERS_MAX);
    const live = rows.filter((r) => r.status !== "disconnected");
    const owners = await Promise.all(live.map((r) => ctx.db.get(r.userId)));
    return live.map((r, i) => ({
      _id: r._id,
      owner: owners[i]?.name ?? owners[i]?.email ?? "Unknown",
      profileName: r.profileName ?? null,
      status: r.status,
      statusReason: r.statusReason ?? null,
    }));
  },
});

export const updateSettings = mutation({
  args: {
    accountId: v.id("linkedinAccounts"),
    timezone: v.string(),
    window: sendWindow,
    overrides,
    salesNavHighVolume: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.accountId);
    if (!row || row.orgId !== user.orgId || row.status === "disconnected") throw new ConvexError("LinkedIn account not found");
    if (row.userId !== user._id && !isAdmin(user)) throw new ConvexError("Only the account's owner or an admin can change its limits");
    if (!validTimezone(args.timezone)) throw new ConvexError("Pick a valid timezone.");
    const windowError = validateWindow(args.window);
    if (windowError) throw new ConvexError(windowError);
    const salesNavHighVolume = row.tier === "sales_navigator" && args.salesNavHighVolume;
    const limitsError = validateOverrides(args.overrides, { tier: row.tier, salesNavHighVolume, isAdmin: can(user, "sending.limits") });
    if (limitsError) throw new ConvexError(limitsError);
    await ctx.db.patch(row._id, {
      timezone: args.timezone,
      window: { ...args.window, days: [...args.window.days].sort((a, b) => a - b) },
      overrides: args.overrides,
      salesNavHighVolume,
      updatedAt: Date.now(),
    });
    await publishSender(ctx, row._id);
  },
});

export const disconnect = mutation({
  args: { accountId: v.id("linkedinAccounts") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.accountId);
    if (!row || row.orgId !== user.orgId) throw new ConvexError("LinkedIn account not found");
    if (row.userId !== user._id && !isAdmin(user)) throw new ConvexError("Only the account's owner or an admin can disconnect it");
    if (row.status === "disconnected") return;
    await ctx.db.patch(row._id, { status: "disconnected", statusReason: "Disconnected in Canon", updatedAt: Date.now() });
    await publishSender(ctx, row._id);
    await ctx.scheduler.runAfter(0, internal.linkedinActions.deleteRemote, { unipileAccountId: row.unipileAccountId });
  },
});

// ───────────────────────────── Internal ─────────────────────────────

export const caller = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const row = await accountOf(ctx, user._id, user.orgId);
    return { orgId: user.orgId, userId: user._id, reconnectAccountId: row && row.status !== "disconnected" ? row.unipileAccountId : null };
  },
});

/**
 * Unipile's notify callback, after verifying Canon's signed state: bind the
 * account to the user who started the connect. An account already bound to
 * someone else is refused. A user who connects a different account replaces
 * their old one, which is then removed from Unipile.
 */
export const connected = internalMutation({
  args: {
    userId: v.id("users"),
    orgId: v.id("organizations"),
    riskAcceptedAt: v.number(),
    riskTextVersion: v.string(),
    timezone: v.string(),
    unipileAccountId: v.string(),
    status: v.string(),
    profileName: v.union(v.string(), v.null()),
    publicIdentifier: v.union(v.string(), v.null()),
    tier,
  },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || !(await userBelongsToOrg(ctx, user, args.orgId))) return { ok: false };
    const bound = await ctx.db.query("linkedinAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    if (bound && (bound.userId !== args.userId || bound.orgId !== args.orgId)) return { ok: false };
    const now = Date.now();
    const existing = await accountOf(ctx, args.userId, args.orgId);
    const fresh = {
      unipileAccountId: args.unipileAccountId,
      status: statusFromUnipile(args.status, "ok"),
      statusReason: undefined,
      ...(args.profileName ? { profileName: args.profileName } : {}),
      ...(args.publicIdentifier ? { publicIdentifier: args.publicIdentifier } : {}),
      tier: args.tier,
      riskAcceptedAt: args.riskAcceptedAt,
      riskTextVersion: args.riskTextVersion,
      updatedAt: now,
    };
    if (existing) {
      const sameAccount = existing.unipileAccountId === args.unipileAccountId;
      if (!sameAccount && existing.status !== "disconnected") {
        await ctx.scheduler.runAfter(0, internal.linkedinActions.deleteRemote, { unipileAccountId: existing.unipileAccountId });
      }
      // A reconnect keeps the warm-up and the settings; a different account starts over.
      await ctx.db.patch(existing._id, {
        ...fresh,
        ...(sameAccount && existing.status !== "disconnected"
          ? {}
          : {
            rampStep: 0, rampAdvancedAt: now, connectedAt: now, overrides: {}, salesNavHighVolume: undefined, connectionCount: undefined,
            // Consent to read messages was given for the old account, not this one.
            ingest: undefined, ingestSince: undefined, ingestBackfillCursor: undefined, ingestBackfillResume: undefined, ingestBackfilledAt: undefined, ingestSyncedAt: undefined,
          }),
      });
      await publishSender(ctx, existing._id, now);
      return { ok: true };
    }
    const accountId = await ctx.db.insert("linkedinAccounts", {
      orgId: args.orgId,
      userId: args.userId,
      ...fresh,
      timezone: validTimezone(args.timezone) ? args.timezone : DEFAULT_TIMEZONE,
      window: DEFAULT_WINDOW,
      overrides: {},
      rampStep: 0,
      rampAdvancedAt: now,
      connectedAt: now,
    });
    await publishSender(ctx, accountId, now);
    return { ok: true };
  },
});

/** Unipile's account-status webhook: pause, resume or ask for a new login. */
export const applyStatus = internalMutation({
  args: { unipileAccountId: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("linkedinAccounts").withIndex("by_unipileAccountId", (q) => q.eq("unipileAccountId", args.unipileAccountId)).first();
    if (!row) return;
    const status = statusFromUnipile(args.message, row.status);
    if (status === row.status) return;
    const reason =
      status === "credentials" ? "LinkedIn needs you to log in again." : status === "paused" ? `LinkedIn session stopped (${args.message.toUpperCase()}).` : undefined;
    await ctx.db.patch(row._id, { status, statusReason: reason, updatedAt: Date.now() });
    await publishSender(ctx, row._id);
  },
});

export type LinkedinCaller = { orgId: Id<"organizations">; userId: Id<"users">; reconnectAccountId: string | null };
