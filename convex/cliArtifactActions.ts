"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { touchCliToken } from "./cliAuth";
import type { Doc, Id } from "./_generated/dataModel";

type CliIdentity = { _id: Id<"cliTokens">; orgId: Id<"organizations">; userId: Id<"users"> };
type UpsertResult = { artifactId: Id<"cliArtifacts">; updatedAt: number; created: boolean; revision: number; documentSha256: string; unchanged: boolean };
type ReadResult = { artifactId: Id<"cliArtifacts">; kind: "icp" | "signal_run" | "lead_run"; key: string; label: string; domain?: string; document: unknown; sourceVersion?: string; revision: number; documentSha256?: string; origin: "cli" | "hosted"; updatedAt: number };

async function authenticate(ctx: ActionCtx, cliToken: string): Promise<CliIdentity> {
  const tokenHash = createHash("sha256").update(cliToken).digest("hex");
  const token: CliIdentity | null = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
  if (!token) throw new ConvexError("Invalid or revoked CLI token");
  await touchCliToken(ctx, token);
  return token;
}

export const upsert = action({
  args: {
    cliToken: v.string(), kind: v.union(v.literal("icp"), v.literal("signal_run"), v.literal("lead_run")),
    key: v.string(), label: v.string(), domain: v.optional(v.string()), document: v.any(),
    sourceVersion: v.optional(v.string()), expectedRevision: v.optional(v.number()),
    changeSummary: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<UpsertResult> => {
    const token = await authenticate(ctx, args.cliToken);
    return ctx.runMutation(internal.cliArtifacts.upsert, {
      orgId: token.orgId, userId: token.userId, cliTokenId: token._id,
      kind: args.kind, key: args.key, label: args.label, domain: args.domain,
      document: args.document, sourceVersion: args.sourceVersion,
      expectedRevision: args.expectedRevision, changeSummary: args.changeSummary,
    });
  },
});

export const get = action({
  args: { cliToken: v.string(), kind: v.union(v.literal("icp"), v.literal("signal_run"), v.literal("lead_run")), key: v.string() },
  handler: async (ctx, args): Promise<ReadResult | null> => {
    const token = await authenticate(ctx, args.cliToken);
    const artifact: Doc<"cliArtifacts"> | null = await ctx.runQuery(internal.cliArtifacts.getForCli, { orgId: token.orgId, kind: args.kind, key: args.key });
    if (!artifact) return null;
    return { artifactId: artifact._id, kind: artifact.kind, key: artifact.key, label: artifact.label, domain: artifact.domain, document: artifact.document, sourceVersion: artifact.sourceVersion, revision: artifact.currentRevision ?? 1, documentSha256: artifact.documentSha256, origin: artifact.origin ?? "cli", updatedAt: artifact.updatedAt };
  },
});
