"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

export type MintedProviderConnection = {
  accessToken: string;
  instanceUrl?: string;
  fieldMappings: unknown;
};

/**
 * Exchange a broker CLI token for a short-lived provider connection minted
 * from the org's stored CRM credentials. The raw CLI token is the credential;
 * it is hashed here and never persisted or logged.
 */
export const mintProviderToken = action({
  args: {
    cliToken: v.string(),
    provider: v.union(v.literal("hubspot"), v.literal("salesforce")),
  },
  handler: async (ctx, args): Promise<MintedProviderConnection> => {
    const tokenHash = createHash("sha256").update(args.cliToken).digest("hex");
    const token = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
    if (!token) throw new ConvexError("Invalid or revoked CLI token");

    await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: token._id });

    if (args.provider === "salesforce") {
      const connection: { accessToken: string; instanceUrl: string; fieldMappings: unknown } =
        await ctx.runAction(internal.salesforceActions.getOrgAccessToken, {
          orgId: token.orgId,
        });
      return connection;
    }

    const connection: { accessToken: string; fieldMappings: unknown } = await ctx.runAction(
      internal.hubspotActions.getOrgAccessToken,
      { orgId: token.orgId },
    );
    return connection;
  },
});
