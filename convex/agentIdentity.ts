"use node";

/**
 * Resolve a paired CLI token (fsgtm_…) to the Clerk identity the app signs a
 * short-lived service JWT for (src/lib/canonServiceJwt.ts). Lets headless
 * agents use the hosted MCP endpoint without an OAuth browser flow.
 */
import { createHash } from "node:crypto";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { touchCliToken } from "./cliAuth";

export const resolveCliToken = action({
  args: { cliToken: v.string() },
  handler: async (ctx, args): Promise<{ clerkUserId: string; clerkOrgId: string | null } | null> => {
    if (!args.cliToken.startsWith("fsgtm_") || args.cliToken.startsWith("fsgtm_agent_")) return null;
    const tokenHash = createHash("sha256").update(args.cliToken).digest("hex");
    const token = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!token) return null;
    await touchCliToken(ctx, token);
    return ctx.runQuery(internal.agentIdentityData.clerkIdentity, { userId: token.userId, orgId: token.orgId });
  },
});
