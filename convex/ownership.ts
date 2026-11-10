import { ConvexError, v } from "convex/values";
import { can, refusal } from "./lib/capabilities";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { activeClerkOrgIdFromIdentity } from "./lib";
import { saveDealValues } from "./canon";

/**
 * Deal-owner backfill: ownerless deals now SYNC into the mirror (the sync no
 * longer drops them), and this module proposes owners for them through the
 * governed patch-plan flow — one reviewable set_field op per deal, suggested
 * by rule:
 *   account-owner — the deal's account already has an owner; inherit it.
 *   only-owner    — the org has exactly one CRM-mapped owner; assign them.
 * Deals with no defensible suggestion are reported, never guessed. Writes
 * happen only through approve → apply (gtm "deal.assign_owners" →
 * ownershipActions.applyDealOwnersInternal).
 */

// Bounded reads: deals take(2000) + one account get per unowned deal (≤2000)
// + users take(400) ≈ well under the 4096 budget for realistic unowned counts.
const MAX_DEALS = 2000;
const MAX_USERS = 400;

/**
 * The CRM owner id a user maps to. Owner sync persists users.crmOwnerId (also
 * when the owner merged onto an existing Clerk user by email); the clerkUserId
 * pattern `<provider>:<orgId>:<crmOwnerId>` is the legacy fallback for rows
 * synced before that field existed.
 */
function crmOwnerIdFromUser(user: Doc<"users">, orgId: Id<"organizations">): string | null {
  if (user.crmOwnerId) return user.crmOwnerId;
  const parts = user.clerkUserId.split(":");
  if (parts.length === 3 && (parts[0] === "hubspot" || parts[0] === "salesforce") && parts[1] === orgId) {
    return parts[2];
  }
  return null;
}

export const gatherUnownedDealOps = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const deals = await ctx.db
      .query("deals")
      .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", args.orgId).eq("archivedAt", undefined))
      .take(MAX_DEALS);
    const unowned = deals.filter((deal) => !deal.primaryRepId);

    const users = await ctx.db
      .query("users")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .take(MAX_USERS);
    const usersById = new Map(users.map((user) => [user._id, user]));
    // The only-owner fallback: exactly one active CRM-mapped owner in the org.
    const crmOwners = users
      .filter((user) => user.isActive && !user.isHidden)
      .map((user) => ({ user, crmOwnerId: crmOwnerIdFromUser(user, args.orgId) }))
      .filter((entry): entry is { user: Doc<"users">; crmOwnerId: string } => entry.crmOwnerId !== null);
    // only-owner: the org has exactly one CRM-mapped owner. sole-admin: several
    // owner records exist (integration bots, ex-staff) but exactly one is a
    // real ADMIN — the person running this workspace; suggest them.
    const adminOwners = crmOwners.filter((entry) => entry.user.role === "admin");
    const fallbackOwner =
      crmOwners.length === 1
        ? { ...crmOwners[0], rule: "only-owner" }
        : adminOwners.length === 1
          ? { ...adminOwners[0], rule: "sole-admin" }
          : null;

    const operations = [];
    const unassignable: Array<{ dealName: string; reason: string }> = [];

    for (const deal of unowned) {
      const account = deal.accountId ? await ctx.db.get(deal.accountId) : null;

      let suggestion: { userId: Id<"users">; crmOwnerId: string; rule: string; userName: string } | null = null;
      if (account?.ownerId && account.crmOwnerId) {
        const owner = usersById.get(account.ownerId);
        if (owner) {
          suggestion = {
            userId: account.ownerId,
            crmOwnerId: account.crmOwnerId,
            rule: "account-owner",
            userName: owner.name,
          };
        }
      }
      if (!suggestion && fallbackOwner) {
        suggestion = {
          userId: fallbackOwner.user._id,
          crmOwnerId: fallbackOwner.crmOwnerId,
          rule: fallbackOwner.rule,
          userName: fallbackOwner.user.name,
        };
      }
      if (!suggestion) {
        unassignable.push({
          dealName: deal.name,
          reason: account
            ? `account "${account.name}" has no mapped owner and the org has ${crmOwners.length} CRM owners (${adminOwners.length} admins) — pick manually`
            : `no linked account and the org has ${crmOwners.length} CRM owners (${adminOwners.length} admins) — pick manually`,
        });
        continue;
      }

      operations.push({
        objectType: "deal",
        objectId: deal.crmId ?? String(deal._id),
        fieldOrAction: "set_field",
        beforeValue: null,
        afterValue: {
          dealId: deal._id,
          crmId: deal.crmId ?? null,
          provider: deal.crmProvider ?? null,
          field: "ownerId",
          value: suggestion.crmOwnerId,
          userId: suggestion.userId,
          userName: suggestion.userName,
          assignedBy: suggestion.rule,
          dealName: deal.name,
        },
        reason:
          `Deal "${deal.name}"${deal.stage ? ` (${deal.stage})` : ""} has no owner — ` +
          `assign ${suggestion.userName} (rule: ${suggestion.rule}` +
          `${suggestion.rule === "account-owner" && account ? `, inherited from account "${account.name}"` : ""}).`,
        sourceRuleOrPolicy: `ownership:${suggestion.rule}`,
        riskLevel: "medium",
        approvalRequirement: "required",
        rollback: "Clear the owner field on the deal (it was unassigned before).",
      });
    }

    return { operations, unassignable, unownedCount: unowned.length };
  },
});

/**
 * Create the governed owner-assignment plan: one set_field op per ownerless
 * deal with a defensible suggestion. Review/approve/apply in Patch Plans.
 */
export const proposeDealOwnerBackfill = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    patchPlanId: unknown;
    operationCount: number;
    unassignable: Array<{ dealName: string; reason: string }>;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!can(user, "team.edit")) throw new ConvexError(refusal("team.edit"));
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "owner backfill over the CRM" });

    const gathered = await ctx.runQuery(internal.ownership.gatherUnownedDealOps, {
      orgId: user.orgId,
    });
    if (gathered.operations.length === 0) {
      throw new ConvexError(
        gathered.unownedCount === 0
          ? "No ownerless deals in the synced CRM — nothing to assign."
          : `${gathered.unownedCount} ownerless deal(s), but none has a defensible suggestion (no account owner, multiple possible owners). Assign these manually in the CRM.`,
      );
    }

    const summary =
      `Assign owners to ${gathered.operations.length} ownerless deal(s) ` +
      `(${gathered.unassignable.length} reported for manual pick).`;
    const packageOpsByRow = new Map<number, string>();
    const documentOperations = gathered.operations.flatMap((operation, index) => {
      const payload = operation.afterValue as { crmId?: string | null; provider?: string | null; value?: unknown };
      // Only active HubSpot CRM rows are sent through the HubSpot connector.
      // Local-only deals are mirror-patched at apply; non-HubSpot rows are skipped.
      if (!payload.crmId || payload.provider !== "hubspot") return [];
      const id = `op_owner_${index}`;
      packageOpsByRow.set(index, id);
      return [{
        id,
        objectType: operation.objectType,
        objectId: payload.crmId,
        operation: "set_field",
        field: "ownerId",
        beforeValue: operation.beforeValue,
        afterValue: payload.value,
        reason: operation.reason,
        sourceRuleOrPolicy: operation.sourceRuleOrPolicy,
        riskLevel: operation.riskLevel,
        approvalRequired: true,
        rollback: operation.rollback,
      }];
    });
    const document = {
      id: `deal_assign_owners_${Date.now()}`,
      title: "Assign deal owners",
      createdAt: new Date().toISOString(),
      status: "needs_approval",
      dryRun: true,
      summary,
      findings: [],
      operations: documentOperations,
    };

    const persisted = await ctx.runMutation(internal.gtm.persistDoPlanInternal, {
      userId: user._id,
      operation: "deal.assign_owners",
      args: {},
      reason: summary,
      operations: gathered.operations.map((operation, index) => ({ ...operation, fieldOrAction: "ownerId", packageOpId: packageOpsByRow.get(index) })),
      document: JSON.parse(JSON.stringify(document)),
    });

    return {
      patchPlanId: (persisted as { patchPlanId?: unknown }).patchPlanId,
      operationCount: gathered.operations.length,
      unassignable: gathered.unassignable,
    };
  },
});

/**
 * Mirror update after the CRM write succeeds. The owner goes through the deal's ledger stream (saveDealValues), as
 * every other deal write does, so what reads the ledger (automations, a module's deal feed) sees the change with the
 * owner before and after.
 */
export const patchDealOwner = internalMutation({
  args: {
    dealId: v.id("deals"),
    userId: v.id("users"),
    crmOwnerId: v.string(),
  },
  handler: async (ctx, args) => {
    const deal = await ctx.db.get(args.dealId);
    if (!deal) return;
    await ctx.db.patch(args.dealId, { primaryRepId: args.userId, crmOwnerId: args.crmOwnerId, updatedAt: Date.now() });
    const updated = await ctx.db.get(args.dealId);
    if (!updated) return;
    // The owner now lives in the CRM (written back first), so it is that provider's fact.
    const source = updated.crmId && (updated.crmProvider === "salesforce" || updated.crmProvider === "hubspot")
      ? { kind: updated.crmProvider, crmId: updated.crmId } as const
      : { kind: "import" } as const;
    await saveDealValues(ctx, updated, source, { ownerId: args.userId, crmOwnerId: args.crmOwnerId });
  },
});
