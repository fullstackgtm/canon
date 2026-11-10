"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const keyArgs = {
  cliToken: v.string(),
  key: v.string(),
};

type AuthenticatedCli = {
  _id: Id<"cliTokens">;
  orgId: Id<"organizations">;
  userId: Id<"users">;
};

type CheckpointResult = { checkpoint: unknown; version: number; updatedAt: number };

async function authenticate(ctx: any, cliToken: string): Promise<AuthenticatedCli> {
  const tokenHash = createHash("sha256").update(cliToken).digest("hex");
  const token: AuthenticatedCli | null = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
  if (!token) throw new ConvexError("Invalid or revoked CLI token");
  await ctx.runMutation(internal.cliAuth.touchToken, { cliTokenId: token._id });
  return token;
}

export const get = action({
  args: keyArgs,
  handler: async (ctx, args): Promise<CheckpointResult | null> => {
    const token = await authenticate(ctx, args.cliToken);
    const row = await ctx.runQuery(internal.acquisitionCheckpoints.get, {
      orgId: token.orgId,
      key: args.key,
    });
    if (!row) return null;
    return {
      checkpoint: row.checkpoint,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  },
});

export const upsert = action({
  args: {
    ...keyArgs,
    expectedVersion: v.optional(v.number()),
    checkpoint: v.any(),
  },
  handler: async (ctx, args): Promise<CheckpointResult> => {
    const token = await authenticate(ctx, args.cliToken);
    const checkpoint = {
      key: args.key,
      expectedVersion: args.expectedVersion,
      checkpoint: args.checkpoint,
    };
    return await ctx.runMutation(internal.acquisitionCheckpoints.upsert, {
      orgId: token.orgId,
      userId: token.userId,
      cliTokenId: token._id,
      ...checkpoint,
    });
  },
});
