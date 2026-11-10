"use node";

import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { touchCliToken } from "./cliAuth";
import type { Id } from "./_generated/dataModel";
import { admitProposalTargets, proposedFactValidator } from "./canonGate";
import { principalClient } from "./records";
import { admitThenRead } from "./lib/scopedRecordClient";
import { AGENT_SOURCES } from "./lib/canon/gate";

type CliIdentity = { _id: Id<"cliTokens">; orgId: Id<"organizations">; userId: Id<"users"> };

async function authenticate(ctx: ActionCtx, cliToken: string): Promise<CliIdentity> {
  const tokenHash = createHash("sha256").update(cliToken).digest("hex");
  const token: CliIdentity | null = await ctx.runQuery(internal.cliAuth.getTokenByHash, { tokenHash });
  if (!token) throw new ConvexError("Invalid or revoked CLI token");
  await touchCliToken(ctx, token);
  return token;
}

/** Submit a batch of proposed deal facts (agent write gate). */
export const submit = action({
  args: {
    cliToken: v.string(),
    agentId: v.string(),
    sourceKind: v.union(...AGENT_SOURCES.map((k) => v.literal(k))),
    title: v.string(),
    reason: v.optional(v.string()),
    facts: v.array(proposedFactValidator),
  },
  handler: async (ctx, { cliToken, ...args }): Promise<{
    patchPlanId: Id<"patchPlans">; proposed: number; unchanged: number; verifying: number;
    rejected: Array<{ index: number; attribute: string; reason: string }>;
  }> => {
    const token = await authenticate(ctx, cliToken);
    // Companies and people the token's user cannot see read as missing at the gate (CP14).
    const admitted = await admitProposalTargets(ctx, token.orgId, token.userId, args.facts);
    return ctx.runMutation(internal.canonGate.submitProposals, { ...args, orgId: token.orgId, userId: token.userId, cliTokenId: token._id, admitted });
  },
});

export const status = action({
  args: { cliToken: v.string(), patchPlanId: v.string() },
  handler: async (ctx, args): Promise<unknown> => {
    const token = await authenticate(ctx, args.cliToken);
    const read = (admitted: string[]) => ctx.runQuery(internal.canonGate.batchStatus, { orgId: token.orgId, userId: token.userId, patchPlanId: args.patchPlanId, admitted });
    const first = await read([]);
    // Companies and people only the record service can judge are admitted through the token's user's scoped client (CP14).
    if (!first.pending.length || !first.accesses) return first.value;
    return admitThenRead(principalClient(ctx, token.orgId, first.accesses), token.orgId, read);
  },
});
