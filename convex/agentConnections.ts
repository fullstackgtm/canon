import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { agentClientOf, getCurrentUser } from "./lib";

// A connection is re-stamped at most this often; /mcp also throttles in memory.
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com"]);

/**
 * Whether this user has reached /mcp from an agent (MCP client, canon CLI or
 * paired CLI token; /mcp records all three). Read budget: 1 index probe.
 */
export async function hasAgentConnection(ctx: QueryCtx, user: Doc<"users">): Promise<boolean> {
  const row = await ctx.db
    .query("agentConnections")
    .withIndex("by_userId_and_clientId", (q) => q.eq("userId", user._id))
    .first();
  return row !== null;
}

/**
 * Called by /mcp after it verifies an agent's credential, with the service JWT
 * it signed for that user. Only that issuer counts: a dashboard session
 * calling this cannot mark the user as agent-connected.
 */
export const record = mutation({
  args: {},
  handler: async (ctx) => {
    const clientId = await agentClientOf(ctx);
    if (!clientId) return null;
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const now = Date.now();
    const existing = await ctx.db
      .query("agentConnections")
      .withIndex("by_userId_and_clientId", (q) => q.eq("userId", user._id).eq("clientId", clientId))
      .unique();
    if (!existing) {
      await ctx.db.insert("agentConnections", { userId: user._id, clientId, firstSeenAt: now, lastSeenAt: now });
    } else if (now - existing.lastSeenAt > TOUCH_INTERVAL_MS) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
    }
    return null;
  },
});

/** The agent-onboarding gate's state for the signed-in user (null when signed out). */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const domain = user.email.split("@")[1]?.toLowerCase() ?? "";
    return {
      connected: await hasAgentConnection(ctx, user),
      domain: domain && !FREE_MAIL.has(domain) ? domain : null,
    };
  },
});
