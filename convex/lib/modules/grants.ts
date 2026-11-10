/**
 * A module's standing grants (docs/modules.md, "Standing grants"): an admin's approval, made in advance, for one module
 * to make one grantable proposal (modules/kernel/proposals.ts `grantableLabel`) without a person deciding each one. It
 * keeps the guarantees of an agent's grant (lib/agents/grants.ts): signed over its exact terms, an expiry, a daily cap,
 * a plan approved under it only when every row fits, and an apply that re-checks the grant and each record's version.
 *
 * A grant is live only while its signature verifies, it is unexpired and unrevoked, the module is on and still
 * proposes the operation, and the admin who gave it is still an admin of the workspace. The plan it approves applies
 * as that admin.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { derivedSecret } from "../operatorConfig";
import { hmacHex } from "../agents/grants";
import { roleIn } from "../../permissions";
import { grantFits, type ProposalRow } from "../../../modules/kernel/proposals.ts";
import type { ModuleManifest } from "../../../modules/kernel/manifest.ts";

export const MODULE_GRANT_MAX_DAYS = 90;
export const MODULE_GRANT_MAX_PER_DAY = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const moduleGrantKey = () => derivedSecret("module-grant");

/** Everything the signature covers. Changing any of these invalidates the grant. */
type Terms = Pick<Doc<"moduleGrants">, "orgId" | "moduleId" | "operation" | "maxPerDay" | "expiresAt" | "createdBy" | "createdAt"> & { grantId: string };

const canonical = (t: Terms) => JSON.stringify(["canon.module_grant.v1", t.grantId, t.orgId, t.moduleId, t.operation, t.maxPerDay ?? null, t.expiresAt, t.createdBy, t.createdAt]);
export const signModuleGrant = (t: Terms, key: string) => hmacHex(key, canonical(t));

export type ModuleGrantState = "live" | "expired" | "revoked" | "invalid" | "lapsed";
export const moduleGrantStateLabel: Record<ModuleGrantState, string> = {
  live: "Live",
  expired: "Expired",
  revoked: "Revoked",
  invalid: "Inert: its signature doesn't verify",
  lapsed: "Inert: the admin who gave it no longer is one",
};

/** Whether the grant may approve anything now, apart from its module being on (the caller's scope says that). */
export async function moduleGrantState(db: QueryCtx["db"], g: Doc<"moduleGrants">, key: string | null, now: number): Promise<ModuleGrantState> {
  if (g.revokedAt !== undefined) return "revoked";
  if (!key || (await signModuleGrant({ ...g, grantId: g._id }, key)) !== g.signature) return "invalid";
  if (g.expiresAt <= now) return "expired";
  const admin = await db.get(g.createdBy);
  return admin && (await roleIn({ db } as QueryCtx, admin, g.orgId)) === "admin" ? "live" : "lapsed";
}

const USES_READ = 1000;
/** Rows approved under the grant in the last 24 hours; past USES_READ uses it reads as no room left (fails closed). */
export async function usedToday(db: QueryCtx["db"], grantId: Id<"moduleGrants">, now: number): Promise<number> {
  const uses = await db.query("moduleGrantUses").withIndex("by_grantId_and_at", (q) => q.eq("grantId", grantId).gt("at", now - DAY_MS)).take(USES_READ + 1);
  return uses.length > USES_READ ? Number.POSITIVE_INFINITY : uses.reduce((n, u) => n + u.rows, 0);
}

/**
 * The live grant that covers this proposal whole, or null: the module (on, in `manifest`) still proposes the
 * operation, every row fits (it only fills an empty field), and the day's cap leaves room for all of them.
 */
export async function grantCovering(db: QueryCtx["db"], orgId: Id<"organizations">, moduleId: string, manifest: ModuleManifest, operation: string, rows: readonly ProposalRow[] | null, now: number): Promise<Doc<"moduleGrants"> | null> {
  if (!manifest.proposes?.includes(operation as never) || (rows && !grantFits(operation, rows))) return null;
  const key = await moduleGrantKey();
  for (const g of await db.query("moduleGrants").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).take(50)) {
    if (g.operation !== operation || (await moduleGrantState(db, g, key, now)) !== "live") continue;
    if (rows && g.maxPerDay !== undefined && (await usedToday(db, g._id, now)) + rows.length > g.maxPerDay) continue;
    return g;
  }
  return null;
}

type OpRow = Pick<Doc<"patchOperations">, "packageOpId" | "objectId" | "beforeValue" | "afterValue">;

/** SHA-256 over the plan's exact rows: which records, from which value and version, to which value. */
export async function grantPlanHash(patchPlanId: string, ops: readonly OpRow[]): Promise<string> {
  const rows = ops.map((o) => [o.packageOpId ?? null, o.objectId ?? null, o.beforeValue ?? null, o.afterValue ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["canon.module_grant_plan.v1", patchPlanId, rows])));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const grantDigest = (key: string, g: Doc<"moduleGrants">, hash: string) => hmacHex(key, JSON.stringify(["canon.module_grant_approval.v1", g._id, g.signature, hash]));

/**
 * Approve a just-held proposal under the grant, as its admin, in the transaction that made it: every row, the request
 * decided, the use recorded with the digest binding the plan to the grant, and the apply scheduled.
 */
export async function approveUnderModuleGrant(ctx: MutationCtx, g: Doc<"moduleGrants">, patchPlanId: Id<"patchPlans">, apply: (patchPlanId: Id<"patchPlans">, grantId: Id<"moduleGrants">) => Promise<unknown>) {
  const key = await moduleGrantKey();
  if (!key) throw new Error("module grant key missing");
  const now = Date.now();
  const ops = await ctx.db.query("patchOperations").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", patchPlanId)).collect();
  const hash = await grantPlanHash(patchPlanId, ops);
  const digest = await grantDigest(key, g, hash);
  await ctx.db.patch(patchPlanId, { status: "approved", approvedBy: g.createdBy, approvedAt: now, approvedOperationIds: ops.map((o) => o.packageOpId!).filter(Boolean), updatedAt: now });
  for (const r of await ctx.db.query("approvalRequests").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", patchPlanId)).take(20)) {
    await ctx.db.patch(r._id, { status: "approved", reason: "Approved under a standing grant", decidedBy: g.createdBy, decidedAt: now, updatedAt: now });
  }
  await ctx.db.insert("moduleGrantUses", { orgId: g.orgId, grantId: g._id, patchPlanId, planHash: hash, digest, rows: ops.length, at: now });
  await ctx.db.insert("operationAuditLog", {
    orgId: g.orgId, userId: g.createdBy, patchPlanId, verb: "do", operation: "module.grant_approve", status: "approved",
    details: { grantId: g._id, module: g.moduleId, planHash: hash, digest, rows: ops.length }, createdAt: now,
  });
  await apply(patchPlanId, g._id);
}

/** A granted plan the grant no longer approves goes back to waiting for a person, whole, decided on Patch plans as any other. */
export async function releasePlan(ctx: MutationCtx, plan: Doc<"patchPlans">, reason: string, now: number) {
  // Nothing was applied under the grant: its use goes (the day's cap gets it back) and people decide the plan as any other.
  for (const u of await ctx.db.query("moduleGrantUses").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(5)) await ctx.db.delete(u._id);
  await ctx.db.patch(plan._id, { status: "pending_approval", approvedBy: undefined, approvedAt: undefined, approvedOperationIds: [], updatedAt: now });
  for (const r of await ctx.db.query("approvalRequests").withIndex("by_patchPlanId", (q) => q.eq("patchPlanId", plan._id)).take(20)) {
    await ctx.db.patch(r._id, { status: "pending", decidedBy: undefined, decidedAt: undefined, reason: `Waiting for a person: ${reason}`, updatedAt: now });
  }
  await ctx.db.insert("operationAuditLog", {
    orgId: plan.orgId, patchPlanId: plan._id, verb: plan.verb, operation: "module.grant_release", status: "previewed", details: { reason }, createdAt: now,
  });
}
