import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { mutation, query } from "./_generated/server";
import { getCurrentUser, requireUser } from "./lib";

/**
 * Tier-1 agent self-registration.
 *
 * Any agent may register itself (no human in the loop) and receive a
 * `fsgtm_agent_` bearer token — but that tier can ONLY reach the public read
 * endpoints (/api/public/*). Registrations carry fixed read-only scopes and
 * are never attached to an organization, so tenant CRM data is unreachable
 * by construction. Writes and org data always require the human-approved
 * cliAuth pairing (see convex/cliAuth.ts) — that tier boundary is the
 * product story, not an implementation accident.
 *
 * Token handling follows cliAuth exactly: the Next route mints the raw token
 * and only a SHA-256 hash lands here. Raw IPs never land here either — the
 * route sends a salted SHA-256 hash used solely for rate limiting.
 */

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, same as cliTokens
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTRATIONS_PER_IP_PER_DAY = 5;
const MAX_ACTIVE_PER_OPERATOR_CONTACT = 3;

/** The full Tier-1 surface. Scopes are assigned server-side, never requested. */
export const AGENT_SCOPES = ["read:evals"];

const SHA256_HEX = /^[0-9a-f]{64}$/;
// Deliberately loose: enough to make the contact plausibly reachable without
// rejecting valid addresses. The contact is an accountability handle.
const CONTACT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const register = mutation({
  args: {
    name: v.string(),
    operatorContact: v.string(),
    platform: v.optional(v.string()),
    tokenHash: v.string(),
    registrationIpHash: v.string(),
    // Hash of the one-time claim_token (auth.md claim ceremony). Optional so
    // a Convex deploy ahead of the Next deploy can't break registration; the
    // current route always sends it.
    claimTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const operatorContact = args.operatorContact.trim().toLowerCase();
    const platform = args.platform?.trim().slice(0, 60);

    if (name.length < 1 || name.length > 80) {
      throw new ConvexError({
        code: "invalid_request",
        message: "name must be 1-80 characters",
      });
    }
    if (operatorContact.length > 120 || !CONTACT_PATTERN.test(operatorContact)) {
      throw new ConvexError({
        code: "invalid_request",
        message: "operator_contact must be a reachable email address",
      });
    }
    if (!SHA256_HEX.test(args.tokenHash) || !SHA256_HEX.test(args.registrationIpHash)) {
      throw new ConvexError({
        code: "invalid_request",
        message: "tokenHash and registrationIpHash must be SHA-256 hex digests",
      });
    }
    if (args.claimTokenHash !== undefined && !SHA256_HEX.test(args.claimTokenHash)) {
      throw new ConvexError({
        code: "invalid_request",
        message: "claimTokenHash must be a SHA-256 hex digest",
      });
    }

    const now = Date.now();

    // Durable rate limit #1: registrations per (hashed) IP per rolling day.
    const fromSameIp = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_ipHash_createdAt", (q) =>
        q.eq("registrationIpHash", args.registrationIpHash).gte("createdAt", now - DAY_MS),
      )
      .collect();
    if (fromSameIp.length >= MAX_REGISTRATIONS_PER_IP_PER_DAY) {
      const oldest = Math.min(...fromSameIp.map((r) => r.createdAt));
      throw new ConvexError({
        code: "rate_limited",
        message: `This address has registered ${MAX_REGISTRATIONS_PER_IP_PER_DAY} agents in the last 24 hours. Reuse an existing token (they last 90 days) or retry later.`,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000)),
      });
    }

    // Durable rate limit #2: active registrations per operator contact.
    // Bounded: only "are there already ≥3 active?" matters, so a 200-row
    // sample decides it — an unbounded .collect() on a spammed contact could
    // otherwise blow the 4096-read cap and brick registration for everyone.
    const forContact = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_operatorContact", (q) => q.eq("operatorContact", operatorContact))
      .take(200);
    const active = forContact.filter((r) => !r.revokedAt && r.expiresAt > now);
    if (active.length >= MAX_ACTIVE_PER_OPERATOR_CONTACT) {
      throw new ConvexError({
        code: "rate_limited",
        message: `${operatorContact} already has ${MAX_ACTIVE_PER_OPERATOR_CONTACT} active agent registrations. Reuse one of those tokens, or contact us to revoke one.`,
        retryAfterSeconds: 24 * 60 * 60,
      });
    }

    const expiresAt = now + TOKEN_TTL_MS;
    await ctx.db.insert("agentRegistrations", {
      name,
      operatorContact,
      platform: platform || undefined,
      tokenHash: args.tokenHash,
      scopes: [...AGENT_SCOPES],
      registrationIpHash: args.registrationIpHash,
      claimTokenHash: args.claimTokenHash,
      createdAt: now,
      expiresAt,
    });
    return { expiresAt, scopes: [...AGENT_SCOPES] };
  },
});

/**
 * auth.md claim ceremony: a SIGNED-IN USER binds an anonymous registration to
 * themselves by presenting the claim_token the agent received at
 * registration. Keyed by the SHA-256 hash of that token, mirroring `validate`.
 *
 * SECURITY LINE — claiming is an ownership binding, never an access upgrade:
 * it stamps claimedByUserId/claimedByOrgId/claimedAt and NOTHING else. The
 * agent's bearer token keeps its fixed read-only scopes and is still rejected
 * on every org-scoped route (see agentTokenRejection in
 * src/app/api/agents/_lib.ts). Org data access continues to require the
 * human-approved cliAuth pairing — that boundary does not move here.
 *
 * Idempotent for the same user; a registration claimed by someone else is a
 * `conflict`; unknown, revoked, or expired claim tokens are `not_found`
 * (indistinguishable on purpose — the claim token is the only lookup key a
 * caller holds).
 */
export const claim = mutation({
  args: { claimTokenHash: v.string() },
  handler: async (ctx, args) => {
    // ConvexError (not requireUser's plain Error) so the API route can map
    // this precisely to a 401 instead of a generic upstream failure.
    const user = await getCurrentUser(ctx);
    if (!user) {
      throw new ConvexError({
        code: "not_authenticated",
        message: "Claiming an agent registration requires a signed-in user",
      });
    }
    if (!SHA256_HEX.test(args.claimTokenHash)) {
      throw new ConvexError({
        code: "invalid_request",
        message: "claimTokenHash must be a SHA-256 hex digest",
      });
    }

    const registration = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_claimTokenHash", (q) => q.eq("claimTokenHash", args.claimTokenHash))
      .unique();
    const now = Date.now();
    if (!registration || registration.revokedAt || now > registration.expiresAt) {
      throw new ConvexError({
        code: "not_found",
        message: "Unknown, revoked, or expired claim token",
      });
    }

    if (registration.claimedByUserId && registration.claimedByUserId !== user._id) {
      throw new ConvexError({
        code: "conflict",
        message: "This agent registration has already been claimed by another user",
      });
    }

    const alreadyClaimed = registration.claimedByUserId === user._id;
    if (!alreadyClaimed) {
      // The ONLY fields claiming may touch. Scopes and tokenHash are
      // deliberately untouched: a claimed agent token is exactly as powerful
      // as an unclaimed one.
      await ctx.db.patch(registration._id, {
        claimedByUserId: user._id,
        claimedByOrgId: user.orgId,
        claimedAt: now,
      });
    }

    return {
      name: registration.name,
      scopes: registration.scopes,
      expiresAt: registration.expiresAt,
      claimedAt: alreadyClaimed ? registration.claimedAt! : now,
      alreadyClaimed,
    };
  },
});

/**
 * Registrations the current user has claimed — the "visible as theirs" half
 * of the claim ceremony. Read-only metadata; never token or claim hashes.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const registrations = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_claimedByUserId", (q) => q.eq("claimedByUserId", user._id))
      .collect();
    const now = Date.now();
    return registrations.map((registration) => ({
      _id: registration._id,
      name: registration.name,
      platform: registration.platform ?? null,
      scopes: registration.scopes,
      createdAt: registration.createdAt,
      expiresAt: registration.expiresAt,
      lastUsedAt: registration.lastUsedAt ?? null,
      revokedAt: registration.revokedAt ?? null,
      claimedAt: registration.claimedAt ?? null,
      expired: now > registration.expiresAt,
    }));
  },
});

/**
 * Validator used by the API layer (src/app/api/public/_lib.ts). A mutation
 * rather than a query for the same reason cliAuth.poll is: it stamps
 * lastUsedAt on the way through. Keyed by token hash — holding the hash
 * preimage IS the credential, mirroring cliAuth.getTokenByHash.
 */
export const validate = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const registration = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!registration || registration.revokedAt) return null;
    if (Date.now() > registration.expiresAt) return null;
    await ctx.db.patch(registration._id, { lastUsedAt: Date.now() });
    return {
      name: registration.name,
      scopes: registration.scopes,
      expiresAt: registration.expiresAt,
    };
  },
});

/**
 * Registrations are platform-level (org-less), so listing/revoking is
 * restricted to admins — stricter than cliAuth's admin-or-manager because
 * there is no org boundary to additionally scope by.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user || !can(user, "grants.manage")) return [];
    const registrations = await ctx.db
      .query("agentRegistrations")
      .order("desc")
      .take(200);
    const now = Date.now();
    return registrations.map((registration) => ({
      _id: registration._id,
      name: registration.name,
      operatorContact: registration.operatorContact,
      platform: registration.platform ?? null,
      scopes: registration.scopes,
      createdAt: registration.createdAt,
      expiresAt: registration.expiresAt,
      lastUsedAt: registration.lastUsedAt ?? null,
      revokedAt: registration.revokedAt ?? null,
      claimed: Boolean(registration.claimedAt),
      expired: now > registration.expiresAt,
    }));
  },
});

/**
 * Admins can revoke anything; a user who has CLAIMED a registration can
 * revoke that registration ("revocable as theirs" — the useful half of
 * ownership). Claiming still never widens read access anywhere.
 */
export const revoke = mutation({
  args: { registrationId: v.id("agentRegistrations") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db.get(args.registrationId);
    const ownsClaim = Boolean(existing && existing.claimedByUserId === user._id);
    if (!can(user, "grants.manage") && !ownsClaim) {
      throw new ConvexError(
        "Only admins or the user who claimed a registration can revoke it",
      );
    }
    const registration = await ctx.db.get(args.registrationId);
    if (!registration) throw new ConvexError("Agent registration not found");
    if (registration.revokedAt) return { ok: true, alreadyRevoked: true };
    await ctx.db.patch(args.registrationId, { revokedAt: Date.now() });
    return { ok: true };
  },
});
