import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { verifyUnsubscribeToken } from "./lib/outbound/unsubscribe";
import { setSuppression } from "./lib/suppressions/store";

export const consume = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const verified = await verifyUnsubscribeToken(token);
    if (!verified) return null;
    const orgId = ctx.db.normalizeId("organizations", verified.terms.orgId);
    if (!orgId || !(await ctx.db.get(orgId))) return null;
    await setSuppression(ctx, { orgId, kind: "email", value: verified.terms.address, source: "unsubscribe", state: "active",
      actor: { kind: "recipient", proof: verified.proof } });
    return null;
  },
});
