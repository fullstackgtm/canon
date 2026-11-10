/**
 * Modules' standing grants (docs/modules.md, "Standing grants"; rules in lib/modules/grants.ts). An admin lets one
 * module make one grantable proposal without a person deciding each one, until it expires; and revokes it. These are
 * signed-in admins' mutations, kept off the gtm API, CLI and MCP tool surface (src/lib/gtm-human-only-mutations.ts).
 *
 * A proposal a live grant covers whole is approved as its admin in the transaction that makes it
 * (lib/modules/scope.ts), and `applyGranted` applies it as that admin, after checking the grant again: revoking a
 * grant stops a plan already queued under it, which then waits for a person.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentClientOf, getCurrentUser, requireUser } from "./lib";
import { can, refusal } from "./lib/capabilities";
import { installedModule, manifestOf } from "./lib/modules/packages";
import { systemScope } from "./lib/modules/scope";
import {
  MODULE_GRANT_MAX_DAYS, MODULE_GRANT_MAX_PER_DAY, grantCovering, releasePlan, grantDigest, grantPlanHash, moduleGrantKey, moduleGrantState,
  moduleGrantStateLabel, signModuleGrant, usedToday,
} from "./lib/modules/grants";
import { applyRecordRows } from "./moduleRecords";
import { grantableLabel, MAX_PROPOSAL_ROWS, PROPOSAL_OPERATIONS, type ProposalOperation } from "../modules/kernel/proposals.ts";

const MAX_GRANTS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each installed module's grantable proposals, with their grants newest first, their state and today's use. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const key = await moduleGrantKey();
    const now = Date.now();
    const pkgs = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", user.orgId).eq("status", "installed")).take(50);
    const names = new Map<Id<"users">, Promise<string | null>>();
    const modules = (await Promise.all(pkgs.map(async (pkg) => {
      const operations = (manifestOf(pkg).proposes ?? []).filter((op) => grantableLabel(op));
      if (!operations.length) return [];
      const rows = await ctx.db.query("moduleGrants").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", user.orgId).eq("moduleId", pkg.moduleId)).order("desc").take(MAX_GRANTS);
      const grants = await Promise.all(rows.map(async (g) => {
        if (!names.has(g.createdBy)) names.set(g.createdBy, ctx.db.get(g.createdBy).then((creator) => creator?.name ?? null));
        const state = await moduleGrantState(ctx.db, g, key, now);
        return {
          id: g._id, operation: g.operation, expiresAt: g.expiresAt, maxPerDay: g.maxPerDay ?? null, createdAt: g.createdAt,
          createdBy: await names.get(g.createdBy)!, revokedAt: g.revokedAt ?? null, state, stateLabel: moduleGrantStateLabel[state],
          usedToday: await usedToday(ctx.db, g._id, now),
        };
      }));
      return [{
        moduleId: pkg.moduleId,
        operations: operations.map((op) => ({ operation: op, label: PROPOSAL_OPERATIONS[op].label, grantable: grantableLabel(op)!, grants: grants.filter((g) => g.operation === op) })),
      }];
    }))).flat();
    return { modules, canManage: can(user, "grants.manage"), signingReady: key !== null, maxDays: MODULE_GRANT_MAX_DAYS };
  },
});

/** Admin: let the module make one grantable proposal without asking, within a daily cap, until it expires. */
export const create = mutation({
  args: { moduleId: v.string(), operation: v.string(), days: v.number(), maxPerDay: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (await agentClientOf(ctx)) throw new ConvexError("An agent can't grant a module standing approval; an admin does, on the Customization page.");
    if (!can(user, "grants.manage")) throw new ConvexError(refusal("grants.manage"));
    const pkg = await installedModule(ctx, user.orgId, args.moduleId);
    if (!pkg || !(manifestOf(pkg).proposes ?? []).includes(args.operation as ProposalOperation)) throw new ConvexError("That module doesn't propose this.");
    if (!grantableLabel(args.operation)) throw new ConvexError("Each of these proposals waits for a person; it can't be granted.");
    if (!(Number.isInteger(args.days) && args.days >= 1 && args.days <= MODULE_GRANT_MAX_DAYS)) throw new ConvexError(`A grant expires after 1 to ${MODULE_GRANT_MAX_DAYS} days.`);
    if (args.maxPerDay !== undefined && !(Number.isInteger(args.maxPerDay) && args.maxPerDay >= 1 && args.maxPerDay <= MODULE_GRANT_MAX_PER_DAY)) throw new ConvexError(`The daily cap is 1 to ${MODULE_GRANT_MAX_PER_DAY} records.`);
    const existing = await ctx.db.query("moduleGrants").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", user.orgId).eq("moduleId", pkg.moduleId)).take(MAX_GRANTS);
    if (existing.length >= MAX_GRANTS) throw new ConvexError(`A module has at most ${MAX_GRANTS} grants.`);
    const key = await moduleGrantKey();
    if (!key) throw new ConvexError("Grants can't be signed on this deployment yet: its encryption key isn't configured.");
    const now = Date.now();
    const row = {
      orgId: user.orgId, moduleId: pkg.moduleId, operation: args.operation, ...(args.maxPerDay !== undefined ? { maxPerDay: args.maxPerDay } : {}),
      expiresAt: now + args.days * DAY_MS, createdBy: user._id, createdAt: now,
    };
    // The id is part of the signed terms, so the row is signed once it exists (same transaction).
    const grantId = await ctx.db.insert("moduleGrants", { ...row, signature: "" });
    await ctx.db.patch(grantId, { signature: await signModuleGrant({ ...row, grantId }, key) });
    await ctx.db.insert("operationAuditLog", {
      orgId: user.orgId, userId: user._id, verb: "do", operation: "module.grant_create", status: "applied",
      details: { grantId, module: pkg.moduleId, operation: args.operation, maxPerDay: args.maxPerDay ?? null, expiresAt: row.expiresAt }, createdAt: now,
    });
    return { grantId };
  },
});

/** Admin: revoke a grant. It approves nothing from now on, and a plan queued under it waits for a person. */
export const revoke = mutation({
  args: { grantId: v.id("moduleGrants") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (await agentClientOf(ctx)) throw new ConvexError("An agent can't change a module's standing grant.");
    if (!can(user, "grants.manage")) throw new ConvexError(refusal("grants.manage"));
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.orgId !== user.orgId) throw new ConvexError("Grant not found");
    if (grant.revokedAt !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch(grant._id, { revokedAt: now, revokedBy: user._id });
    // Plans approved under it and not yet claimed wait for a person from now on.
    for (const u of await ctx.db.query("moduleGrantUses").withIndex("by_grantId_and_at", (q) => q.eq("grantId", grant._id)).order("desc").take(200)) {
      const plan = await ctx.db.get(u.patchPlanId);
      if (plan?.status === "approved" && !plan.applyClaim) await releasePlan(ctx, plan, "its standing grant was revoked", now);
    }
    await ctx.db.insert("operationAuditLog", {
      orgId: grant.orgId, userId: user._id, verb: "do", operation: "module.grant_revoke", status: "applied", details: { grantId: grant._id, module: grant.moduleId }, createdAt: now,
    });
    return null;
  },
});

/** The admin whose live grant lets the module (on) propose `operation` without asking, or null. */
export const grantorFor = internalQuery({
  args: { orgId: v.id("organizations"), module: v.string(), operation: v.string() },
  handler: async (ctx, a): Promise<Id<"users"> | null> => {
    const scope = await systemScope(ctx, a.orgId, a.module);
    if (!scope) return null;
    return (await grantCovering(ctx.db, a.orgId, scope.moduleId, scope.manifest, a.operation, null, Date.now()))?.createdBy ?? null;
  },
});

const APPLY_CLAIM_SENTINEL_EXPIRY = 8_640_000_000_000_000;

/**
 * Claim a granted plan's apply, in the transaction that checks the grant still approves it: live, its module on and
 * still proposing the operation, and the plan's rows the ones its approval's digest was made over. A revoke committed
 * before this claim stops the apply. One that doesn't approve it any more sends the plan back to waiting for a person,
 * whole.
 */
export const claimGranted = internalMutation({
  args: { patchPlanId: v.id("patchPlans"), grantId: v.id("moduleGrants") },
  handler: async (ctx, a) => {
    const plan = await ctx.db.get(a.patchPlanId);
    const grant = await ctx.db.get(a.grantId);
    const use = await ctx.db.query("moduleGrantUses").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", a.patchPlanId)).unique();
    if (!plan || !grant || !use || use.grantId !== grant._id || plan.status !== "approved" || plan.applyClaim) return { ok: false as const, reason: "not a plan waiting under this grant" };
    const now = Date.now();
    const key = await moduleGrantKey();
    const scope = await systemScope(ctx, grant.orgId, grant.moduleId);
    const state = await moduleGrantState(ctx.db, grant, key, now);
    const ops = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(MAX_PROPOSAL_ROWS + 1);
    const reason = ops.length > MAX_PROPOSAL_ROWS ? "the plan exceeds the proposal row limit"
      : state !== "live" ? `grant ${state}`
      : !scope || !scope.manifest.proposes?.includes(grant.operation as ProposalOperation) ? "its module is off or no longer proposes this"
      : (await grantDigest(key!, grant, await grantPlanHash(plan._id, ops))) !== use.digest ? "the plan isn't the one the grant approved"
      : null;
    if (reason) {
      await releasePlan(ctx, plan, reason, now);
      return { ok: false as const, reason };
    }
    const approved = new Set(plan.approvedOperationIds ?? []);
    const claimId = `grant:${grant._id}:${plan._id}:${now}`;
    await ctx.db.patch(plan._id, { applyClaim: { id: claimId, replica: "hosted", claimedAt: now, expiresAt: APPLY_CLAIM_SENTINEL_EXPIRY }, updatedAt: now });
    return {
      ok: true as const, claimId, orgId: plan.orgId, actor: grant.createdBy, args: plan.args ?? {},
      operations: ops.filter((o) => o.packageOpId && approved.has(o.packageOpId)).map((o) => ({ _id: o._id, objectType: o.objectType, objectId: o.objectId, fieldOrAction: o.fieldOrAction, beforeValue: o.beforeValue, afterValue: o.afterValue, packageOpId: o.packageOpId })),
    };
  },
});

/** Apply a plan approved under a grant, as the grant's admin, if the grant still approves it; else it waits for a person. */
export const applyGranted = internalAction({
  args: { patchPlanId: v.id("patchPlans"), grantId: v.id("moduleGrants") },
  handler: async (ctx, a): Promise<null> => {
    const c = await ctx.runMutation(internal.moduleGrants.claimGranted, a);
    if (!c.ok) return null;
    try {
      const access = await ctx.runQuery(internal.moduleAi.accessOf, { orgId: c.orgId, userId: c.actor });
      const providerResult = await applyRecordRows(ctx, { orgId: c.orgId, userId: c.actor, access }, { patchPlanId: a.patchPlanId, operations: c.operations, args: c.args });
      await ctx.runMutation(internal.patchPlans.apply, { patchPlanId: a.patchPlanId, providerResult, alreadyDispatched: true, claimId: c.claimId, actor: c.actor });
    } catch (error) {
      await ctx.runMutation(internal.patchPlans.recordApplyFailure, { patchPlanId: a.patchPlanId, error: error instanceof Error ? error.message : String(error), actor: c.actor });
    }
    return null;
  },
});
