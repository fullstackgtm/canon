/**
 * Resolve a paired CLI token (fsgtm_…) to the Clerk identity the app signs a
 * short-lived service JWT for (src/lib/canonServiceJwt.ts). Lets headless
 * agents use the hosted MCP endpoint without an OAuth browser flow.
 *
 * Default runtime, not Node: a self-hosted backend's Node actions call back
 * through SITE_URL, which the container may not reach, and every /mcp and
 * /api/v1 request with a CLI token runs this.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { touchCliToken } from "./cliAuth";

export const resolveCliToken = action({
  args: { cliToken: v.string() },
  handler: async (ctx, args): Promise<{ clerkUserId: string; clerkOrgId: string | null } | null> => {
    if (!args.cliToken.startsWith("fsgtm_") || args.cliToken.startsWith("fsgtm_agent_")) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(args.cliToken));
    const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!token) return null;
    await touchCliToken(ctx, token);
    return ctx.runQuery(internal.agentIdentityData.clerkIdentity, { userId: token.userId, orgId: token.orgId });
  },
});
