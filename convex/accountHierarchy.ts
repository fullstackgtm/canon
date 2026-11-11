import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { dealVisible, principalAccess, unrestrictedUser, workspaceMembers } from "./permissions";
import type { Access } from "./lib/access";
import { can, refusal } from "./lib/capabilities";
import { applyAsUser, changeAs, crmParentsOf, edgesOf } from "./associations";
import { recordEditPorts, requireCaller } from "./records";
import type { EdgeResult } from "./lib/objects/associations";
import { EditConflictError, editPartyRecord, isLedgerEditField, recordHolds } from "./lib/canon/partyLedger";
import { mergeableFields } from "./lib/canon/partyMerge";
import { resolveObjectDef, STANDARD_OBJECTS } from "./lib/objects/registry";
import { mergeAs, mergeWriteArgs, undoAs, writeMerge } from "./recordMerges";
import { partyStores } from "./canon";
import type { FieldItem, HierarchyItem, ParentItem } from "../engine/src/accountHierarchy/plan.ts";
import type { CitationCheck } from "../engine/src/accountHierarchy/research.ts";
import { checkPolicyInput, resolvePolicy, type HierarchyPolicy } from "../engine/src/accountHierarchy/policy.ts";

/**
 * Account hierarchy manager (docs/account-hierarchy-manager.md), the saved side: settings, scans, candidate groups,
 * research and a person's decisions. Reading the CRM and the web happens in accountHierarchyActions.ts.
 *
 * A scan reads Canon's own companies and parent links by default, so it works for any workspace. A workspace with
 * Salesforce connected can also scan Salesforce live: Canon's Salesforce import does not bring parent links, creation
 * dates or the custom fields a policy names.
 *
 * Approving an item on a Canon scan changes Canon at once, as the approver: a parent move (`approveParent`), a field
 * fix (`approveFields`) or a merge (`approveMerge`). On a Salesforce scan, whose ids are Salesforce ids, an approval
 * only records the decision. Nothing in this file or its actions writes to a CRM.
 *
 * A scan reads every account, so every function needs a caller who sees every record and may manage integrations.
 * Decisions also need `cleanup.run`.
 */

/** A scan or research row still "running" after this long was ended by the platform's 10-minute action limit. */
const STALE_MS = 12 * 60_000;
const MAX_GROUPS_LISTED = 1000;

async function manager(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await unrestrictedUser(ctx);
  if (!user) throw new ConvexError("The account hierarchy needs access to every record in the workspace.");
  if (!can(user, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return user;
}

async function policyOf(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<HierarchyPolicy> {
  const row = await ctx.db.query("hierarchySettings").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
  return resolvePolicy(row?.policy ?? {});
}

async function latestScan(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return ctx.db.query("hierarchyScans").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").first();
}

async function salesforceConnected(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  const integration = await ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "salesforce")).first();
  return integration?.isActive === true;
}

const stale = (status: string, startedAt: number) => status === "running" || status === "reading" ? Date.now() - startedAt > STALE_MS : false;

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const user = await manager(ctx);
    const settings = await ctx.db.query("hierarchySettings").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).unique();
    const scan = await latestScan(ctx, user.orgId);
    const groups = scan
      ? await ctx.db.query("hierarchyGroups").withIndex("by_scanId_and_rank", (q) => q.eq("scanId", scan._id)).take(MAX_GROUPS_LISTED)
      : [];
    const research = scan ? await ctx.db.query("hierarchyResearch").withIndex("by_scanId", (q) => q.eq("scanId", scan._id)).order("desc").take(500) : [];
    const researchByGroup = new Map<Id<"hierarchyGroups">, { status: string; groupName: string; counts?: unknown }>();
    for (const r of research) {
      if (researchByGroup.has(r.groupId)) continue;
      researchByGroup.set(r.groupId, {
        status: stale(r.status, r.startedAt) ? "failed" : r.status,
        groupName: r.groupName,
        counts: (r.proposal as { counts?: unknown } | undefined)?.counts,
      });
    }
    return {
      canDecide: can(user, "cleanup.run"),
      salesforceConnected: await salesforceConnected(ctx, user.orgId),
      policy: settings?.policy ?? null,
      effectivePolicy: resolvePolicy(settings?.policy ?? {}),
      scan: scan
        ? { ...scan, status: stale(scan.status, scan.startedAt) ? ("failed" as const) : scan.status, error: stale(scan.status, scan.startedAt) ? "The scan ran out of time." : scan.error }
        : null,
      groups: groups.map((g) => ({
        _id: g._id,
        rank: g.rank,
        size: g.size,
        shellCount: g.shellCount,
        names: g.accounts.slice(0, 8).map((a) => a.name),
        reasons: g.reasons.slice(0, 4),
        research: researchByGroup.get(g._id) ?? null,
      })),
    };
  },
});

export const group = query({
  args: { groupId: v.id("hierarchyGroups") },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    const g = await ctx.db.get(args.groupId);
    if (!g || g.orgId !== user.orgId) return null;
    const scan = await ctx.db.get(g.scanId);
    const research = await ctx.db.query("hierarchyResearch").withIndex("by_groupId", (q) => q.eq("groupId", g._id)).order("desc").first();
    const decisions = research
      ? await ctx.db.query("hierarchyDecisions").withIndex("by_researchId_and_itemKey", (q) => q.eq("researchId", research._id)).take(500)
      : [];
    return {
      group: g,
      provider: scan?.provider ?? null,
      scanFinishedAt: scan?.finishedAt ?? null,
      canDecide: can(user, "cleanup.run"),
      research: research
        ? {
            ...research,
            status: stale(research.status, research.startedAt) ? ("failed" as const) : research.status,
            error: stale(research.status, research.startedAt) ? "Research ran out of time. Start it again." : research.error,
          }
        : null,
      decisions: Object.fromEntries(await Promise.all(decisions.map(async (d) => [d.itemKey, {
        decision: d.decision,
        decidedAt: d.decidedAt,
        decidedBy: (await ctx.db.get(d.decidedBy))?.name ?? "a former member",
        // A merge undone from the survivor's history is no longer applied.
        ...(d.appliedAt && (!d.mergeId || (await standingMerge(ctx, g.orgId, d))) ? { appliedAt: d.appliedAt } : {}),
        ...(d.applyError ? { applyError: d.applyError } : {}),
      }] as const))) as Record<string, ItemDecision>,
      // A Canon scan's parents as they are now, so an applied move shows without a rescan, and what a CRM says
      // instead where a person's parent held against it.
      ...(scan?.provider === "canon" ? await canonParents(ctx, g.orgId, g.accounts.map((a) => a.id)) : { parents: null, crmParents: null }),
    };
  },
});

export const savePolicy = mutation({
  args: { policy: v.any() },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    try {
      checkPolicyInput(args.policy);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : String(error));
    }
    const row = await ctx.db.query("hierarchySettings").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).unique();
    if (row) await ctx.db.patch(row._id, { policy: args.policy, updatedBy: user._id, updatedAt: Date.now() });
    else await ctx.db.insert("hierarchySettings", { orgId: user.orgId, policy: args.policy, updatedBy: user._id, updatedAt: Date.now() });
    return null;
  },
});

/** Scans Canon's companies (the default), or Salesforce live when it is connected and asked for. */
export const startScan = mutation({
  args: { source: v.optional(v.union(v.literal("canon"), v.literal("salesforce"))) },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    const provider = args.source ?? "canon";
    if (provider === "salesforce" && !(await salesforceConnected(ctx, user.orgId))) throw new ConvexError("Connect Salesforce under Integrations to scan it.");
    const last = await latestScan(ctx, user.orgId);
    if (last?.status === "reading" && !stale(last.status, last.startedAt)) throw new ConvexError("A scan is already running.");
    const scanId = await ctx.db.insert("hierarchyScans", { orgId: user.orgId, provider, status: "reading", startedBy: user._id, startedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.accountHierarchyActions.runScan, { scanId });
    return scanId;
  },
});

export const startResearch = mutation({
  args: { groupId: v.id("hierarchyGroups"), groupName: v.string(), rootAccountId: v.string() },
  handler: async (ctx, args) => {
    const user = await manager(ctx);
    const g = await ctx.db.get(args.groupId);
    if (!g || g.orgId !== user.orgId) throw new ConvexError("Group not found");
    const scan = await ctx.db.get(g.scanId);
    if (!scan?.snapshot || scan.status !== "done") throw new ConvexError("This group's scan has no snapshot. Scan again.");
    const groupName = args.groupName.trim().slice(0, 120);
    if (!groupName) throw new ConvexError("Name the corporate family (for example, LVMH).");
    if (!g.accounts.some((a) => a.id === args.rootAccountId)) throw new ConvexError("Choose the family's top account.");
    const running = await ctx.db.query("hierarchyResearch").withIndex("by_groupId", (q) => q.eq("groupId", g._id)).order("desc").first();
    if (running?.status === "running" && !stale(running.status, running.startedAt)) throw new ConvexError("Research for this group is already running.");
    const researchId = await ctx.db.insert("hierarchyResearch", {
      orgId: user.orgId,
      scanId: g.scanId,
      groupId: g._id,
      groupName,
      rootAccountId: args.rootAccountId,
      status: "running",
      startedBy: user._id,
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.accountHierarchyActions.runResearch, { researchId });
    return researchId;
  },
});

export type ItemDecision = { decision: "approved" | "rejected"; decidedAt: number; decidedBy: string; appliedAt?: number; applyError?: string };

const PARENT_CHANGED = "The parent changed since this scan. Rescan to review it again.";
const PARENT_CHANGED_SINCE_MOVE = "The parent changed after this move, so undo would overwrite that change. Rescan to review it again.";
const APPLIED = "This change was applied. Undo it to change the decision.";
const FIELDS_CHANGED = "The company's fields changed since this scan. Rescan to review it again.";
const MERGE_CHANGED = "The companies' fields changed since this scan. Rescan to review the merge again.";
const FIELDS_CHANGED_SINCE_FIX = "The fields changed after this fix, so undo would overwrite that change. Edit them on the company page instead.";

/** A proposal item and its decision, for a caller who may decide. */
async function itemOf(ctx: QueryCtx | MutationCtx, researchId: Id<"hierarchyResearch">, itemKey: string) {
  const user = await manager(ctx);
  if (!can(user, "cleanup.run")) throw new ConvexError(refusal("cleanup.run"));
  const research = await ctx.db.get(researchId);
  if (!research || research.orgId !== user.orgId || research.status !== "done") throw new ConvexError("Research not found");
  const item = ((research.proposal as { items?: HierarchyItem[] } | undefined)?.items ?? []).find((i) => i.key === itemKey);
  if (!item) throw new ConvexError("That item is not in this proposal.");
  const scan = await ctx.db.get(research.scanId);
  const existing = await ctx.db
    .query("hierarchyDecisions")
    .withIndex("by_researchId_and_itemKey", (q) => q.eq("researchId", research._id).eq("itemKey", itemKey))
    .unique();
  // Only a Canon scan names Canon record ids; a Salesforce scan's items are recorded, never applied.
  const applies = scan?.provider === "canon";
  return { user, research, item, existing, applies };
}

async function canonParents(ctx: QueryCtx, orgId: Id<"organizations">, ids: string[]) {
  const rows = await Promise.all(ids.map(async (id) => {
    const parent = await currentParent(ctx, orgId, id);
    return { id, parent, crm: await crmParentsOf(ctx, orgId, id, parent) };
  }));
  return {
    parents: Object.fromEntries(rows.map((r) => [r.id, r.parent])) as Record<string, string | null>,
    crmParents: Object.fromEntries(rows.filter((r) => r.crm.length).map((r) => [r.id, r.crm])) as Record<string, Awaited<ReturnType<typeof crmParentsOf>>>,
  };
}

/** A company's parent in Canon now: its oldest active parent link, the one the scan reads. */
async function currentParent(ctx: QueryCtx, orgId: Id<"organizations">, accountId: string): Promise<string | null> {
  return (await edgesOf(ctx, orgId, "account_parent", "from", accountId)).active[0]?.toId ?? null;
}

/**
 * Records a person's decision on one proposed item. A Canon scan's items are approved and undone through
 * `approveParent`/`undoParent`, `approveFields`/`undoFields` and `approveMerge`/`undoMerge`, which change Canon; this
 * records a Salesforce scan's and rejects anything.
 */
export const decide = mutation({
  args: { researchId: v.id("hierarchyResearch"), itemKey: v.string(), decision: v.union(v.literal("approved"), v.literal("rejected"), v.literal("clear")) },
  handler: async (ctx, args) => {
    const { user, research, existing, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (existing?.appliedAt && (!existing.mergeId || (await standingMerge(ctx, user.orgId, existing)))) throw new ConvexError(APPLIED);
    if (args.decision === "approved" && applies) throw new ConvexError("This change is approved by applying it. Reload the page and approve again.");
    if (args.decision === "clear") {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const row = { decision: args.decision, decidedBy: user._id, decidedAt: Date.now(), applyError: undefined };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("hierarchyDecisions", { orgId: user.orgId, researchId: research._id, itemKey: args.itemKey, decision: args.decision, decidedBy: user._id, decidedAt: row.decidedAt });
    return null;
  },
});

const itemArgs = { researchId: v.id("hierarchyResearch"), itemKey: v.string() };

/**
 * Approve a Canon scan's parent move: Canon's parent link changes now, as the approver. Both companies are read as
 * the approver sees them (associations.changeAs), then one transaction compares the parent with the scan's, writes
 * the link and records the decision with `appliedAt`, or records the refusal. Approving again changes nothing.
 */
export const approveParent = action({
  args: itemArgs,
  handler: (ctx, args): Promise<EdgeResult> => moveParent(ctx, args, false),
});

/** Undo an applied parent move: the previous parent comes back, if the parent is still the one the move set. */
export const undoParent = action({
  args: itemArgs,
  handler: (ctx, args): Promise<EdgeResult> => moveParent(ctx, args, true),
});

async function moveParent(ctx: ActionCtx, args: { researchId: Id<"hierarchyResearch">; itemKey: string }, undo: boolean): Promise<EdgeResult> {
  const caller = await requireCaller(ctx);
  const item: Pick<ParentItem, "accountId" | "from" | "to"> = await ctx.runQuery(internal.accountHierarchy.parentMove, args);
  const command = { op: "setParent" as const, accountId: item.accountId, parentId: undo ? item.from : item.to };
  try {
    return await changeAs(ctx, caller, command, (): Promise<EdgeResult> => ctx.runMutation(internal.accountHierarchy.applyParentMove, { ...args, undo }));
  } catch (error) {
    // A company the approver cannot see, or a role that cannot edit companies: kept on the decision like any refusal.
    if (undo || !(error instanceof ConvexError) || typeof error.data !== "string") throw error;
    await ctx.runMutation(internal.accountHierarchy.refuseItem, { ...args, message: error.data });
    return { status: "invalid", message: error.data };
  }
}

export const parentMove = internalQuery({
  args: itemArgs,
  handler: async (ctx, args): Promise<Pick<ParentItem, "accountId" | "from" | "to">> => {
    const { item, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (!applies || item.op !== "set_parent") throw new ConvexError("Only a parent move on a scan of Canon's companies changes a parent.");
    return { accountId: item.accountId, from: item.from, to: item.to };
  },
});

/**
 * The compare, the link and the decision in one transaction, so the decision says applied exactly when the link was
 * written. The parent must still be the one the scan read (`from`); it already being `to` counts as applied. Undo is
 * the same move backwards, and deletes the decision.
 */
export const applyParentMove = internalMutation({
  args: { ...itemArgs, undo: v.boolean() },
  handler: async (ctx, args): Promise<EdgeResult> => {
    const { user, research, item, existing, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (!applies || item.op !== "set_parent") throw new ConvexError("Only a parent move on a scan of Canon's companies changes a parent.");
    const now = await currentParent(ctx, user.orgId, item.accountId);
    const move = (parentId: string | null) => applyAsUser(ctx, user.orgId, user._id, { op: "setParent", accountId: item.accountId, parentId });
    if (args.undo) {
      if (!existing?.appliedAt) {
        if (existing) await ctx.db.delete(existing._id);
        return { status: "unchanged" };
      }
      if (now !== item.from && now !== item.to) return { status: "invalid", message: PARENT_CHANGED_SINCE_MOVE };
      const result = now === item.from ? ({ status: "unchanged" } as const) : await move(item.from);
      if (result.status !== "invalid") await ctx.db.delete(existing._id);
      return result;
    }
    if (existing?.appliedAt) return { status: "unchanged" };
    const result: EdgeResult = now === item.to ? { status: "unchanged" } : now !== item.from ? { status: "invalid", message: PARENT_CHANGED } : await move(item.to);
    const decided = { decision: "approved" as const, decidedBy: user._id, decidedAt: Date.now() };
    const row = result.status === "invalid" ? { ...decided, appliedAt: undefined, applyError: result.message } : { ...decided, appliedAt: decided.decidedAt, applyError: undefined };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("hierarchyDecisions", { orgId: user.orgId, researchId: research._id, itemKey: args.itemKey, ...decided, ...(result.status === "invalid" ? { applyError: result.message } : { appliedAt: decided.decidedAt }) });
    return result;
  },
});

/** A parent move or merge refused before its transaction (a company the approver cannot see): the reason stays on the page. */
export const refuseItem = internalMutation({
  args: { ...itemArgs, message: v.string() },
  handler: async (ctx, args) => {
    const { user, research, existing } = await itemOf(ctx, args.researchId, args.itemKey);
    if (existing?.appliedAt) return null;
    const row = { decision: "approved" as const, decidedBy: user._id, decidedAt: Date.now(), applyError: args.message.slice(0, 500) };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("hierarchyDecisions", { orgId: user.orgId, researchId: research._id, itemKey: args.itemKey, ...row });
    return null;
  },
});

/**
 * Approve a Canon scan's field fix: the company's fields change now, as the approver's own edit on the company page
 * (records.edit's path: their role edits companies and the fields, they see the company), so a CRM's next value for
 * them is held against like any person's edit. The write carries the research's quotes as its evidence, and lands
 * only while the company still holds the values the scan read (CAS). A refusal stays on the decision.
 */
export const approveFields = action({
  args: itemArgs,
  handler: (ctx, args): Promise<FixResult> => changeFields(ctx, args, false),
});

/** Undo an applied field fix: the values the scan read come back, if the fields still hold the fix. */
export const undoFields = action({
  args: itemArgs,
  handler: (ctx, args): Promise<FixResult> => changeFields(ctx, args, true),
});

export type FixResult = { status: "applied" | "unchanged" } | { status: "invalid"; message: string };
type FieldFix = Pick<FieldItem, "accountId" | "fields" | "expect"> & { applied: boolean; evidence: string };

/** Why a fix's field can't be written as a person's edit of a Canon company, or null when it can. */
export function fieldFixProblem(fields: Readonly<Record<string, string>>): string | null {
  for (const field of Object.keys(fields)) {
    if (/owner/i.test(field)) return "Owners are never changed here; routing decides them.";
    if (!isLedgerEditField("account", field)) return `Canon companies have no field "${field}" a person edits, so this fix can't be applied. Make it on the company page.`;
  }
  return null;
}

/** The research's verbatim quotes behind a fix, in the shape research facts keep (lib/research/agentLoop.ts evidenceText). */
export function fixEvidence(groupName: string, item: Pick<FieldItem, "citations">, checks: readonly CitationCheck[], checkedAt?: string): string {
  const result = (url: string, quote: string) => checks.find((c) => c.url === url && c.quote === quote)?.result ?? "not checked";
  const lines = item.citations.map((c) => `"${c.quote}" (${c.url}; ${result(c.url, c.quote).replace("_", " ")}${c.attestedBy ? ` by ${c.attestedBy}` : ""})`);
  return `${lines.join("\n")}\n\nSource: account hierarchy research for ${groupName}${checkedAt ? `, quotes checked ${checkedAt.slice(0, 10)}` : ""}`.slice(0, 4000);
}

async function changeFields(ctx: ActionCtx, args: { researchId: Id<"hierarchyResearch">; itemKey: string }, undo: boolean): Promise<FixResult> {
  const caller = await requireCaller(ctx);
  const fix: FieldFix = await ctx.runQuery(internal.accountHierarchy.fieldFix, args);
  const record = (error?: string) => ctx.runMutation(internal.accountHierarchy.recordFieldFix, { ...args, undo, ...(error ? { error } : {}) });
  if (fix.applied !== undo) {
    if (undo) await record();
    return { status: "unchanged" };
  }
  const refuse = async (message: string): Promise<FixResult> => {
    if (!undo) await record(message);
    return { status: "invalid", message };
  };
  const problem = fieldFixProblem(fix.fields);
  if (problem) return refuse(problem);
  const patch = undo ? fix.expect : fix.fields;
  try {
    await editPartyRecord(await recordEditPorts(ctx, caller, {
      object: "account", id: fix.accountId, patch, expect: undo ? fix.fields : fix.expect,
      // A fresh key per attempt: an approval after an undo is a new edit, not a replay of the first.
      idempotencyKey: `hierarchy:${args.researchId}:${args.itemKey}:${undo ? "undo" : "apply"}:${Date.now()}`,
      ...(undo ? {} : { evidence: fix.evidence }),
    }, "edit"));
  } catch (error) {
    if (error instanceof EditConflictError) {
      // Already holding what this would write (an earlier attempt landed, or someone made the same change) counts as done.
      const held = await ctx.runMutation(internal.canon.recordHolds, { orgId: caller.orgId as Id<"organizations">, object: "account", recordId: fix.accountId, values: patch });
      if (!held) return refuse(undo ? FIELDS_CHANGED_SINCE_FIX : FIELDS_CHANGED);
    } else {
      // A company the approver cannot see, a field their role cannot edit, a value the field refuses.
      const data: unknown = error instanceof ConvexError ? error.data : null;
      const message = typeof data === "string" ? data : data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : null;
      if (message === null) throw error;
      return refuse(message);
    }
  }
  await record();
  return { status: "applied" };
}

export const fieldFix = internalQuery({
  args: itemArgs,
  handler: async (ctx, args): Promise<FieldFix> => {
    const { research, item, existing, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (!applies || item.op !== "set_fields") throw new ConvexError("Only a field fix on a scan of Canon's companies changes fields.");
    const checks = (research.verification as { checks?: CitationCheck[]; checkedAt?: string } | undefined) ?? {};
    return {
      accountId: item.accountId, fields: item.fields, expect: item.expect, applied: existing?.appliedAt !== undefined,
      evidence: fixEvidence(research.groupName, item, checks.checks ?? [], checks.checkedAt),
    };
  },
});

/** A field fix's outcome on its decision: applied, refused (kept with its reason), or undone (the decision deleted). */
export const recordFieldFix = internalMutation({
  args: { ...itemArgs, undo: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user, research, existing } = await itemOf(ctx, args.researchId, args.itemKey);
    if (args.undo) {
      if (existing && !args.error) await ctx.db.delete(existing._id);
      return null;
    }
    const decided = { decision: "approved" as const, decidedBy: user._id, decidedAt: Date.now() };
    const outcome = args.error ? { applyError: args.error.slice(0, 500) } : { appliedAt: decided.decidedAt };
    if (existing) await ctx.db.patch(existing._id, { ...decided, appliedAt: undefined, applyError: undefined, ...outcome });
    else await ctx.db.insert("hierarchyDecisions", { orgId: user.orgId, researchId: research._id, itemKey: args.itemKey, ...decided, ...outcome });
    return null;
  },
});

/**
 * Approve a Canon scan's merge: the duplicate is merged into the company the page shows as kept, through the record
 * pages' merge (recordMerges.mergeAs) as the approver: an admin or manager whose role sees and edits every field and
 * deletes companies, and who sees both. Its people, deals, links and facts move to the survivor, and the values it
 * takes from the duplicate (the proposal's blank fields to fill) are the approver's picks, a person's values. The
 * merge and the decision commit together; undo is the record merge's undo.
 */
export const approveMerge = action({
  args: itemArgs,
  handler: async (ctx, args): Promise<FixResult> => {
    const caller = await requireCaller(ctx);
    const item: MergeFix = await ctx.runQuery(internal.accountHierarchy.mergeItem, args);
    if (item.mergeId) return { status: "unchanged" };
    try {
      await mergeAs(ctx, caller, { object: "account", survivorId: item.survivorId, loserIds: [item.loserId], picks: item.picks }, (merge) =>
        ctx.runMutation(internal.accountHierarchy.applyMerge, { ...args, merge }));
      return { status: "applied" };
    } catch (error) {
      if (!(error instanceof ConvexError) || typeof error.data !== "string") throw error;
      await ctx.runMutation(internal.accountHierarchy.refuseItem, { ...args, message: error.data });
      return { status: "invalid", message: error.data };
    }
  },
});

/** Undo an applied merge: the record merge's undo puts both companies back, then the decision is cleared. */
export const undoMerge = action({
  args: itemArgs,
  handler: async (ctx, args): Promise<FixResult> => {
    const caller = await requireCaller(ctx);
    const item: MergeFix = await ctx.runQuery(internal.accountHierarchy.mergeItem, args);
    if (item.mergeId) {
      try {
        await undoAs(ctx, caller, item.mergeId);
      } catch (error) {
        if (!(error instanceof ConvexError) || typeof error.data !== "string") throw error;
        return { status: "invalid", message: error.data };
      }
    }
    await ctx.runMutation(internal.accountHierarchy.clearDecision, args);
    return { status: item.mergeId ? "applied" : "unchanged" };
  },
});

type MergeFix = { survivorId: string; loserId: string; picks: Record<string, string>; mergeId: string | null };

/** A decision's merge, while it stands: null once it was undone, here or from the survivor's history. */
async function standingMerge(ctx: QueryCtx, orgId: Id<"organizations">, decision: Doc<"hierarchyDecisions"> | null): Promise<string | null> {
  if (!decision?.mergeId || decision.appliedAt === undefined) return null;
  const merge = await ctx.db.query("recordMerges").withIndex("by_orgId_and_mergeId", (q) => q.eq("orgId", orgId).eq("mergeId", decision.mergeId!)).unique();
  return merge && !merge.undoneAt ? merge.mergeId : null;
}

export const mergeItem = internalQuery({
  args: itemArgs,
  handler: async (ctx, args): Promise<MergeFix> => {
    const { user, item, existing, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (!applies || item.op !== "merge") throw new ConvexError("Only a merge on a scan of Canon's companies merges companies.");
    // The survivor keeps its values; it takes the duplicate's only where the proposal fills a blank, never an owner.
    const pickable = new Set(mergeableFields(resolveObjectDef(STANDARD_OBJECTS.account)).map((f) => f.apiName));
    const picks = Object.fromEntries(Object.keys(item.fill).filter((f) => pickable.has(f) && !/owner/i.test(f)).map((f) => [f, item.loserId]));
    return { survivorId: item.survivorId, loserId: item.loserId, picks, mergeId: await standingMerge(ctx, user.orgId, existing) };
  },
});

/** The merge and its decision in one transaction, so the decision says applied exactly when the companies merged. */
export const applyMerge = internalMutation({
  args: { ...itemArgs, merge: mergeWriteArgs },
  handler: async (ctx, args) => {
    const { user, research, item, existing, applies } = await itemOf(ctx, args.researchId, args.itemKey);
    if (!applies || item.op !== "merge" || args.merge.survivor.recordId !== item.survivorId) throw new ConvexError("Only a merge on a scan of Canon's companies merges companies.");
    if (await standingMerge(ctx, user.orgId, existing)) throw new ConvexError(APPLIED);
    // The fields the survivor takes from the duplicate: still blank on the survivor, still what the scan read on the duplicate (CAS).
    const picked = Object.keys(args.merge.picks);
    const [loser] = args.merge.losers;
    const holds = (party: typeof loser, values: Record<string, string | null>) => recordHolds(partyStores(ctx), { orgId: user.orgId, object: "account", recordId: party.recordId, values, ...(party.streamId ? { streamId: party.streamId } : {}), ...(party.snapshot ? { snapshot: party.snapshot } : {}) });
    if (picked.length && !((await holds(args.merge.survivor, Object.fromEntries(picked.map((f) => [f, null])))) && (await holds(loser, Object.fromEntries(picked.map((f) => [f, item.fill[f] ?? null])))))) {
      throw new ConvexError(MERGE_CHANGED);
    }
    await writeMerge(ctx, args.merge);
    const row = { decision: "approved" as const, decidedBy: user._id, decidedAt: Date.now(), appliedAt: Date.now(), mergeId: args.merge.mergeId };
    if (existing) await ctx.db.patch(existing._id, { ...row, applyError: undefined });
    else await ctx.db.insert("hierarchyDecisions", { orgId: user.orgId, researchId: research._id, itemKey: args.itemKey, ...row });
    return null;
  },
});

export const clearDecision = internalMutation({
  args: itemArgs,
  handler: async (ctx, args) => {
    const { existing } = await itemOf(ctx, args.researchId, args.itemKey);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

// ------------------------------------------------------------------ for the actions

export const scanForAction = internalQuery({
  args: { scanId: v.id("hierarchyScans") },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) return null;
    const policy = await policyOf(ctx, scan.orgId);
    if (scan.provider !== "canon") return { scan, policy, accesses: null, members: [] };
    // A Canon scan reads as the person who started it, with their access now: null once they have left the workspace.
    const accesses = await principalAccess(ctx, scan.orgId, [scan.startedBy]);
    const members = (await workspaceMembers(ctx, scan.orgId)).map((m) => ({ id: m.id as string, name: m.name, email: m.email }));
    return { scan, policy, accesses, members };
  },
});

/** A page of the workspace's live deals on a company, as every one of `accesses` sees them (dealVisible). */
export const canonDealsPage = internalQuery({
  args: { orgId: v.id("organizations"), accesses: v.array(v.any()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const accesses = args.accesses as Access[];
    const page = await ctx.db.query("deals").withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", args.orgId).eq("archivedAt", undefined)).paginate(args.paginationOpts);
    return {
      page: page.page
        .filter((d) => d.companyId && accesses.every((a) => dealVisible(a, d)))
        .map((d) => ({
          id: d._id as string,
          companyId: d.companyId!,
          name: d.name,
          ...(d.primaryRepId ? { ownerId: d.primaryRepId as string } : {}),
          ...(d.stage ? { stage: d.stage } : {}),
          closeDate: d.closeDate,
          isClosed: d.isClosed,
          isWon: d.isWon,
          ...(d.amount !== undefined ? { amount: d.amount } : {}),
        })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const insertGroups = internalMutation({
  args: {
    scanId: v.id("hierarchyScans"),
    groups: v.array(
      v.object({
        rank: v.number(),
        groupKey: v.string(),
        size: v.number(),
        shellCount: v.number(),
        accounts: v.array(v.object({ id: v.string(), name: v.string(), parentId: v.optional(v.string()), shell: v.boolean() })),
        reasons: v.array(v.string()),
        suggestedRootId: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (!scan) return null;
    for (const g of args.groups) await ctx.db.insert("hierarchyGroups", { orgId: scan.orgId, scanId: scan._id, ...g });
    return null;
  },
});

export const finishScan = internalMutation({
  args: {
    scanId: v.id("hierarchyScans"),
    snapshot: v.id("_storage"),
    accounts: v.number(),
    groups: v.number(),
    shellGroups: v.number(),
  },
  handler: async (ctx, args) => {
    const { scanId, ...rest } = args;
    await ctx.db.patch(scanId, { ...rest, status: "done", finishedAt: Date.now() });
    return null;
  },
});

export const failScan = internalMutation({
  args: { scanId: v.id("hierarchyScans"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.scanId, { status: "failed", error: args.error.slice(0, 500), finishedAt: Date.now() });
    return null;
  },
});

export const researchForAction = internalQuery({
  args: { researchId: v.id("hierarchyResearch") },
  handler: async (ctx, args) => {
    const research = await ctx.db.get(args.researchId);
    if (!research) return null;
    const scan = await ctx.db.get(research.scanId);
    const g = await ctx.db.get(research.groupId);
    return { research, snapshot: scan?.snapshot ?? null, group: g, policy: await policyOf(ctx, research.orgId) };
  },
});

export const finishResearch = internalMutation({
  args: {
    researchId: v.id("hierarchyResearch"),
    model: v.string(),
    research: v.any(),
    verification: v.any(),
    proposal: v.any(),
    pages: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const { researchId, ...rest } = args;
    await ctx.db.patch(researchId, { ...rest, status: "done", finishedAt: Date.now() });
    return null;
  },
});

export const failResearch = internalMutation({
  args: { researchId: v.id("hierarchyResearch"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.researchId, { status: "failed", error: args.error.slice(0, 500), finishedAt: Date.now() });
    return null;
  },
});
