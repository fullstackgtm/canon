/**
 * What a CRM says about a deal field a person holds (lib/canon/personHold.ts): read on the deal page, and the one
 * way to take it. Taking it writes the CRM's value as the CRM record's, by the person, so the field follows the CRM
 * again and later imports and syncs change it.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { hiddenFields } from "./lib/access";
import { accessFor, recordVisible, requireWriteAccess } from "./permissions";
import { asState, requireWritable, view } from "./objects";
import { saveDealValues } from "./canon";
import { asFieldClaim, fieldClaimsOf } from "./lib/fieldClaimStore";
import { heldField, isPersonFact, winningFact } from "./lib/canon/personHold";
import { sameValue, type FactValue } from "./lib/canon/policy";
import * as objectValidators from "./lib/objects/validators";
import type { DealValues } from "./lib/canon/dealLedger";

const claimView = v.object({
  id: v.string(),
  field: v.string(),
  provider: v.union(v.literal("salesforce"), v.literal("hubspot")),
  value: objectValidators.factValue,
  /** The owner's name, for an owner. */
  label: v.union(v.string(), v.null()),
});

/** The CRM values that differ from a deal field a person holds now, one per field and CRM record. */
export const forDeal = query({
  args: { streamId: v.id("canonEntities") },
  returns: v.array(claimView),
  handler: async (ctx, { streamId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const record = await view(ctx, user.orgId, streamId, 1000, new Map());
    const access = await accessFor(ctx, user);
    if (!record || record.object !== "deal" || !(await recordVisible(ctx, access, record))) return [];
    const claims = await fieldClaimsOf(ctx, user.orgId, streamId);
    if (!claims.length) return [];
    const hot = await ctx.db.query("recordRows").withIndex("by_orgId_streamId", (q) => q.eq("orgId", user.orgId).eq("streamId", streamId)).unique();
    if (!hot) return [];
    const state = asState(hot);
    const hidden = hiddenFields(access, "deal");
    const out: Array<Infer<typeof claimView>> = [];
    for (const c of claims) {
      if (hidden.includes(c.field)) continue;
      // A claim is shown while a person still holds the field and the CRM still differs from it.
      const winner = winningFact(state.fields[c.field]?.candidates ?? []);
      if (!winner || !isPersonFact(winner) || sameValue(winner.value as FactValue, c.value)) continue;
      const owner = c.field === "ownerId" && typeof c.value === "string" ? ctx.db.normalizeId("users", c.value) : null;
      const member = owner ? await ctx.db.get(owner) : null;
      out.push({ id: c.id, field: c.field, provider: c.provider, value: c.value as Infer<typeof objectValidators.factValue>, label: member && member.orgId === user.orgId ? member.name : null });
    }
    return out;
  },
});

/** Use what a CRM record says a deal field is, where a person's value in Canon held against it. */
export const useCrmValue = mutation({
  args: { id: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => takeCrmValue(ctx, await requireUser(ctx), args.id),
});

/** useCrmValue as `user`, who may edit the deal's field: the CRM record's value, written as that record's by them, and its claim gone. */
export async function takeCrmValue(ctx: MutationCtx, user: Doc<"users">, id: string): Promise<{ status: string }> {
  const rowId = ctx.db.normalizeId("parentDisagreements", id);
  const row = rowId ? await ctx.db.get(rowId) : null;
  const claim = row && row.orgId === user.orgId ? asFieldClaim(row) : null;
  if (!row || !claim || !heldField("deal", claim.field)) throw new ConvexError("Canon already follows the CRM here");
  const streamId = ctx.db.normalizeId("canonEntities", claim.recordId);
  const entity = streamId ? await ctx.db.get(streamId) : null;
  const dealId = entity && entity.orgId === user.orgId && entity.projectionTable === "deals" ? ctx.db.normalizeId("deals", entity.projectionId) : null;
  const deal = dealId ? await ctx.db.get(dealId) : null;
  if (!streamId || !deal) throw new ConvexError("Deal not found");
  await requireWritable(ctx, user, await requireWriteAccess(ctx, user), "deal", "edit", streamId, { [claim.field]: claim.value });
  if (!can(user, "deals.write")) throw new ConvexError(refusal("deals.write"));
  if (claim.field === "ownerId" && typeof claim.value === "string") {
    const ownerId = ctx.db.normalizeId("users", claim.value);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.orgId !== user.orgId) throw new ConvexError("That owner is not in this workspace");
  }
  const crmId = claim.ref.slice(claim.provider.length + 1);
  const { result } = await saveDealValues(ctx, deal, { kind: claim.provider, crmId, takenBy: user._id }, { [claim.field]: claim.value } as DealValues);
  if (result.status === "deferred") throw new ConvexError("This deal's history is still being converted. Try again in a minute.");
  if (result.status === "invalid") throw new ConvexError(result.errors.map((e) => e.message).join("; "));
  if (result.status === "conflict") throw new ConvexError("The deal changed. Reload the page.");
  await ctx.db.delete(row._id);
  return { status: result.status };
}
