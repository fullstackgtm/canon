import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireUser } from "./lib";
import { Id } from "./_generated/dataModel";

const crmProviderValidator = v.union(v.literal("hubspot"), v.literal("salesforce"));

/**
 * Device-flow pairing between the fullstackgtm CLI and this deployment.
 *
 * The CLI never sees Clerk or provider OAuth: it starts a pairing request,
 * the operator approves it in the dashboard (the one place a browser is
 * required), and the CLI claims a long-lived broker token. Provider access
 * tokens are minted on demand from the org's stored CRM credentials
 * (convex/cliAuthActions.ts). Raw secrets never land in the database — the
 * CLI holds them; rows store SHA-256 hashes.
 */

const PAIRING_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Backstop ceiling on concurrently-pending requests. This is NOT a per-user
// gate (the edge route does per-IP limiting): it only stops unbounded table
// growth and caps a flood, while leaving legitimate pairing unaffected even
// under contention because expired rows are swept first.
const MAX_PENDING_REQUESTS = 200;

async function sweepExpired(ctx: { db: any }, now: number) {
  const stale = await ctx.db
    .query("cliAuthRequests")
    .withIndex("by_expiresAt", (q: any) => q.lt("expiresAt", now))
    .take(50);
  for (const request of stale) {
    if (request.status === "pending") {
      await ctx.db.patch(request._id, { status: "expired" });
    }
  }
}

export const start = mutation({
  args: {
    deviceCodeHash: v.string(),
    userCode: v.string(),
    requesterLabel: v.optional(v.string()),
    provider: v.optional(crmProviderValidator),
    // RFC 8628 route asks for 900s; the legacy CLI route keeps the 600s
    // default. Clamped so a caller can never mint a long-lived pending code.
    ttlSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await sweepExpired(ctx, now);
    const ttlMs =
      args.ttlSeconds === undefined
        ? PAIRING_TTL_MS
        : Math.min(Math.max(Math.floor(args.ttlSeconds), 60), 900) * 1000;

    const pending = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_expiresAt", (q) => q.gte("expiresAt", now))
      .take(MAX_PENDING_REQUESTS + 1);
    if (pending.filter((request) => request.status === "pending").length >= MAX_PENDING_REQUESTS) {
      throw new ConvexError("Too many pending CLI pairing requests; try again shortly.");
    }

    const cliAuthRequestId = await ctx.db.insert("cliAuthRequests", {
      deviceCodeHash: args.deviceCodeHash,
      userCode: args.userCode,
      status: "pending",
      requesterLabel: args.requesterLabel?.slice(0, 120),
      provider: args.provider,
      createdAt: now,
      expiresAt: now + ttlMs,
    });
    return { expiresInSeconds: ttlMs / 1000, cliAuthRequestId };
  },
});

/**
 * Public, secret-free lookup so the dashboard can show the approver WHO is
 * asking before they approve — the key defense against device-code phishing.
 */
export const describe = query({
  args: { userCode: v.string() },
  handler: async (ctx, args) => {
    // Only the people who can approve (authenticated admins/managers) may see
    // the requester details — never an anonymous caller holding a user code.
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "tokens.manage")) return null;
    const requests = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_userCode", (q) => q.eq("userCode", args.userCode.trim().toUpperCase()))
      .order("desc")
      .take(5);
    const request = requests.find(
      (candidate) => candidate.status === "pending" && Date.now() <= candidate.expiresAt,
    );
    if (!request) return null;
    return {
      requesterLabel: request.requesterLabel ?? "unknown device",
      createdAt: request.createdAt,
    };
  },
});

export const getPendingOAuthRequest = internalQuery({
  args: { userCode: v.string(), provider: crmProviderValidator },
  handler: async (ctx, args): Promise<{ _id: Id<"cliAuthRequests">; deviceCodeHash: string } | null> => {
    const requests = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_userCode", (q) => q.eq("userCode", args.userCode.trim().toUpperCase()))
      .order("desc")
      .take(5);
    const request = requests.find(
      (candidate) =>
        candidate.status === "pending" &&
        Date.now() <= candidate.expiresAt &&
        candidate.provider === args.provider,
    );
    if (!request) return null;
    return { _id: request._id, deviceCodeHash: request.deviceCodeHash };
  },
});

export const approveOAuth = internalMutation({
  args: {
    cliAuthRequestId: v.id("cliAuthRequests"),
    provider: crmProviderValidator,
    orgId: v.id("organizations"),
    userId: v.id("users"),
    deviceCodeHash: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.cliAuthRequestId);
    if (!request || request.status !== "pending") return { ok: false, reason: "not_pending" };
    if (request.provider !== args.provider) return { ok: false, reason: "provider_mismatch" };
    if (request.deviceCodeHash !== args.deviceCodeHash) return { ok: false, reason: "device_mismatch" };
    if (Date.now() > request.expiresAt) {
      await ctx.db.patch(request._id, { status: "expired" });
      return { ok: false, reason: "expired" };
    }
    await ctx.db.patch(request._id, {
      status: "approved",
      orgId: args.orgId,
      userId: args.userId,
    });
    return { ok: true };
  },
});

export const poll = mutation({
  args: { deviceCodeHash: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_deviceCodeHash", (q) => q.eq("deviceCodeHash", args.deviceCodeHash))
      .unique();
    if (!request) return { status: "expired" as const };
    if (request.status === "pending" && Date.now() > request.expiresAt) {
      await ctx.db.patch(request._id, { status: "expired" });
      return { status: "expired" as const };
    }
    return { status: request.status };
  },
});

export const claim = mutation({
  args: { deviceCodeHash: v.string(), tokenHash: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_deviceCodeHash", (q) => q.eq("deviceCodeHash", args.deviceCodeHash))
      .unique();
    if (!request || request.status !== "approved" || request.cliTokenId) {
      throw new ConvexError("Pairing request is not claimable");
    }
    if (!request.orgId || !request.userId) {
      throw new ConvexError("Pairing request was approved without an organization");
    }
    if (Date.now() > request.expiresAt) {
      await ctx.db.patch(request._id, { status: "expired" });
      throw new ConvexError("Pairing request expired before it was claimed");
    }
    const now = Date.now();
    const cliTokenId = await ctx.db.insert("cliTokens", {
      orgId: request.orgId,
      userId: request.userId,
      tokenHash: args.tokenHash,
      name: args.name,
      requesterLabel: request.requesterLabel,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    });
    await ctx.db.patch(request._id, { status: "claimed", cliTokenId });
    return { ok: true };
  },
});

export const approve = mutation({
  args: {
    userCode: v.string(),
    decision: v.union(v.literal("approved"), v.literal("denied")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "tokens.manage")) throw new ConvexError(refusal("tokens.manage"));
    const requests = await ctx.db
      .query("cliAuthRequests")
      .withIndex("by_userCode", (q) => q.eq("userCode", args.userCode.trim().toUpperCase()))
      .order("desc")
      .take(5);
    const request = requests.find(
      (candidate) => candidate.status === "pending" && Date.now() <= candidate.expiresAt,
    );
    if (!request) {
      throw new ConvexError("No pending CLI pairing request for that code");
    }
    await ctx.db.patch(request._id, {
      status: args.decision,
      orgId: args.decision === "approved" ? user.orgId : undefined,
      userId: args.decision === "approved" ? user._id : undefined,
    });
    const org = await ctx.db.get(user.orgId);
    return { status: args.decision, orgName: org?.name ?? null };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "tokens.manage")) return [];
    const tokens = await ctx.db
      .query("cliTokens")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
      .order("desc")
      .take(100);
    return Promise.all(
      tokens.map(async (token) => {
        const owner = await ctx.db.get(token.userId);
        const expired = token.expiresAt !== undefined && Date.now() > token.expiresAt;
        return {
          _id: token._id,
          userName: owner?.name ?? "Unknown user",
          requesterLabel: token.requesterLabel ?? null,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt ?? null,
          expiresAt: token.expiresAt ?? null,
          revokedAt: token.revokedAt ?? null,
          expired,
        };
      }),
    );
  },
});

export const revoke = mutation({
  args: { cliTokenId: v.id("cliTokens") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!can(user, "tokens.manage")) throw new ConvexError(refusal("tokens.manage"));
    const token = await ctx.db.get(args.cliTokenId);
    if (!token || token.orgId !== user.orgId) throw new ConvexError("CLI token not found");
    if (token.revokedAt) return { ok: true, alreadyRevoked: true };
    await ctx.db.patch(args.cliTokenId, { revokedAt: Date.now() });
    return { ok: true };
  },
});

export const getTokenByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("cliTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!token || token.revokedAt) return null;
    if (token.expiresAt !== undefined && Date.now() > token.expiresAt) return null;
    return { _id: token._id, orgId: token.orgId, userId: token.userId, lastUsedAt: token.lastUsedAt ?? null };
  },
});

/**
 * How stale a credential's last-used time may get. It is shown in Settings and read by nothing else, so a minute is
 * precise enough, and a busy token writes once a minute instead of once a request: every request reads the token, and
 * writing it each time made parallel requests conflict on that one row.
 */
export const LAST_USED_INTERVAL_MS = 60_000;
export const lastUsedIsStale = (lastUsedAt: number | null | undefined, now: number) => lastUsedAt == null || now - lastUsedAt >= LAST_USED_INTERVAL_MS;

/** Stamp a token resolved by getTokenByHash as used, unless it was stamped within the interval: then nothing runs. */
export async function touchCliToken(ctx: ActionCtx, token: { _id: Id<"cliTokens">; lastUsedAt?: number | null }): Promise<void> {
  if (lastUsedIsStale(token.lastUsedAt, Date.now())) await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: token._id });
}

export const touchToken = internalMutation({
  args: { cliTokenId: v.id("cliTokens") },
  handler: async (ctx, args) => {
    // Parallel requests can all find the stamp stale; the first writes it and the rest, retried, find it fresh.
    const token = await ctx.db.get(args.cliTokenId);
    const now = Date.now();
    if (token && lastUsedIsStale(token.lastUsedAt, now)) await ctx.db.patch(args.cliTokenId, { lastUsedAt: now });
  },
});
