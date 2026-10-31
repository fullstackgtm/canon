"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const HS_SCOPES = [
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
];

/**
 * Register a provider connection from a PAIRED CLI. The CLI holds the CRM token
 * locally and pushes it over its broker token (same auth as cliRunsActions): we
 * resolve the org/user from the token hash, validate the provider token, then
 * store it as the org's integration so the hosted app can sync independently.
 */
export const connectFromCli = action({
  args: {
    cliToken: v.string(),
    provider: v.literal("hubspot"),
    token: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true; created: boolean }> => {
    const tokenHash = createHash("sha256").update(args.cliToken).digest("hex");
    const cliToken = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!cliToken) throw new ConvexError("Invalid or revoked CLI token");
    await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: cliToken._id });

    const token = args.token.trim();
    if (!token) throw new ConvexError("A provider token is required");

    const response = await fetch("https://api.hubapi.com/account-info/v3/details", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new ConvexError(
        "HubSpot rejected the token. Use a private-app token with CRM read scopes.",
      );
    }

    const result = await ctx.runMutation(internal.hubspot.connectFromCli, {
      orgId: cliToken.orgId,
      userId: cliToken.userId,
      accessToken: token,
      scopes: HS_SCOPES,
    });
    return { ok: true, created: result.created };
  },
});
