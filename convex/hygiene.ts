import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { userBelongsToOrg } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
// Import from the specific node-free modules, NOT the package barrel
// (`index.ts`): the barrel re-exports the HubSpot/Salesforce/Stripe connectors,
// which transitively pull node built-ins (node:http/fs/crypto). This file is a
// V8-runtime Convex query, so any node import breaks the Convex bundler.
// audit.ts → rules.ts/types.ts and format.ts → types.ts are pure + node-free.
import { auditSnapshot } from "../engine/src/audit.ts";
import { builtinAuditRules } from "../engine/src/rules.ts";
import { suggestValues } from "../engine/src/suggest.ts";
import { patchPlanToMarkdown } from "../engine/src/format.ts";
import type {
  CanonicalGtmSnapshot,
  PatchPlan,
} from "../engine/src/types.ts";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { hygienePolicy, hygieneRules } from "./lib/hygienePolicy";
import { modelSettings } from "./lib/recipes";
import type { Doc, Id } from "./_generated/dataModel";

// Bounded reads keep each call within Convex function limits (4096 document
// reads per query/mutation). The single-call buildSnapshot shares one budget
// across 4 tables (MAX_ROWS each); ACTION-layer callers assemble a snapshot
// from the per-table internal queries below instead — each table then gets
// its own budget (PAGE_ROWS). Orgs larger than these bounds should run the
// audit through the package CLI against the CRM directly.
const MAX_ROWS = 950;
const PAGE_ROWS = 4000;

export async function buildSnapshot(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
): Promise<CanonicalGtmSnapshot> {
  const [users, accounts, contacts, deals] = await Promise.all([
    ctx.db
      .query("users")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .take(MAX_ROWS),
    ctx.db
      .query("crmAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .take(MAX_ROWS),
    ctx.db
      .query("crmContacts")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .take(MAX_ROWS),
    ctx.db
      .query("deals")
      .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", orgId).eq("archivedAt", undefined))
      .take(MAX_ROWS),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    provider: "convex",
    users: mapUsers(users),
    accounts: mapAccounts(accounts),
    contacts: mapContacts(contacts),
    deals: mapDeals(deals),
    activities: [],
  };
}

function mapUsers(users: Doc<"users">[]) {
  return users.map((user: Doc<"users">) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    title: user.title,
    active: user.isActive,
  }));
}

function mapAccounts(accounts: Doc<"crmAccounts">[]) {
  return accounts.map((account: Doc<"crmAccounts">) => ({
      id: account._id,
      provider: account.provider,
      crmId: account.crmId,
      identities: [{ provider: account.provider, externalId: account.crmId }],
      name: account.name,
      domain: account.domain,
      industry: account.industry,
      ownerId: account.ownerId,
      employeeCount: account.employeeCount,
      annualRevenue:
        account.annualRevenue === undefined ? undefined : account.annualRevenue / 100,
    lastSyncAt: new Date(account.lastSyncAt).toISOString(),
  }));
}

function mapContacts(contacts: Doc<"crmContacts">[]) {
  return contacts.map((contact: Doc<"crmContacts">) => ({
      id: contact._id,
      provider: contact.provider,
      crmId: contact.crmId,
      identities: [{ provider: contact.provider, externalId: contact.crmId }],
      accountId: contact.accountId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      ownerId: contact.ownerId,
    // A row a sync made but has not written yet (convex/hubspot.ts prepareContacts) has no sync time: when it was made.
    lastSyncAt: new Date(contact.lastSyncAt || contact.createdAt).toISOString(),
  }));
}

function mapDeals(deals: Doc<"deals">[]) {
  return deals.map((deal: Doc<"deals">) => ({
      id: deal._id,
      provider: deal.crmProvider,
      crmId: deal.crmId,
      identities:
        deal.crmProvider && deal.crmId
          ? [{ provider: deal.crmProvider, externalId: deal.crmId }]
          : undefined,
      accountId: deal.accountId,
      ownerId: deal.primaryRepId,
      name: deal.name,
      amount: deal.amount === undefined ? undefined : deal.amount / 100,
      currency: deal.currency,
      stage: deal.stage,
      closeDate: deal.closeDate,
      forecastCategory: deal.forecastCategory,
      probability: deal.probability,
      isClosed: deal.isClosed,
      isWon: deal.isWon,
    lastSyncAt:
      deal.lastSyncAt === undefined
        ? new Date(deal.updatedAt).toISOString()
        : new Date(deal.lastSyncAt).toISOString(),
  }));
}

/** Canonical snapshot of an org's synced CRM rows in ONE query (shared 4096
 *  budget — MAX_ROWS per table). Action-layer callers should prefer the
 *  per-table queries below, which give each table its own budget. */
export const snapshotForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return buildSnapshot(ctx, args.orgId);
  },
});

// Per-table canonical reads (PAGE_ROWS budget each) for action-layer snapshot
// assembly — used by healthSnapshots.captureForOrg and the Stripe backfill.
export const snapshotUsersPage = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) =>
    mapUsers(
      await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(PAGE_ROWS),
    ),
});

export const snapshotAccountsPage = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) =>
    mapAccounts(
      await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(PAGE_ROWS),
    ),
});

export const snapshotContactsPage = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) =>
    mapContacts(
      await ctx.db.query("crmContacts").withIndex("by_orgId", (q) => q.eq("orgId", args.orgId)).take(PAGE_ROWS),
    ),
});

export const snapshotDealsPage = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) =>
    mapDeals(
      await ctx.db.query("deals").withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", args.orgId).eq("archivedAt", undefined)).take(PAGE_ROWS),
    ),
});

/** Assemble a full canonical snapshot from the per-table queries (action ctx). */
export async function snapshotFromPages(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  orgId: Id<"organizations">,
): Promise<CanonicalGtmSnapshot> {
  const { internal } = await import("./_generated/api");
  const [users, accounts, contacts, deals] = await Promise.all([
    ctx.runQuery(internal.hygiene.snapshotUsersPage, { orgId }),
    ctx.runQuery(internal.hygiene.snapshotAccountsPage, { orgId }),
    ctx.runQuery(internal.hygiene.snapshotContactsPage, { orgId }),
    ctx.runQuery(internal.hygiene.snapshotDealsPage, { orgId }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    provider: "convex",
    users,
    accounts,
    contacts,
    deals,
    activities: [],
  };
}

/**
 * Run the open-source fullstackgtm audit engine over this org's synced CRM
 * data and return the dry-run patch plan. Read-only: persisting and applying
 * plans stays with the existing patchPlans workflow.
 */
export const preview = query({
  args: {
    staleDealDays: v.optional(v.number()),
    today: v.optional(v.string()),
    rule: v.optional(v.string()),
    format: v.optional(v.union(v.literal("json"), v.literal("markdown"))),
  },
  handler: async (ctx, args) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;

    const model = await modelSettings(ctx, user.orgId, "hygiene.policy");
    const policy = hygienePolicy(model, args.today);
    if (args.staleDealDays !== undefined) policy.staleDealDays = args.staleDealDays;

    const snapshot = await buildSnapshot(ctx, user.orgId);
    let plan: PatchPlan = auditSnapshot(snapshot, policy, hygieneRules(model));
    if (args.rule) plan = filterPlanByRule(plan, args.rule);

    if (args.format === "markdown") {
      return { plan, markdown: patchPlanToMarkdown(plan) };
    }
    return { plan };
  },
});

function filterPlanByRule(plan: PatchPlan, rule: string): PatchPlan {
  const ruleFindings = plan.findings.filter((finding) => finding.ruleId === rule);
  const findingIds = new Set(ruleFindings.map((finding) => finding.id));
  return {
    ...plan,
    title: `${plan.title} — ${rule}`,
    summary: `${rule}: ${ruleFindings.length} finding(s).`,
    findings: ruleFindings,
    operations: plan.operations.filter(
      (operation) =>
        operation.sourceRuleOrPolicy === rule ||
        operation.findingIds?.some((findingId) => findingIds.has(findingId)),
    ),
  };
}

const PATCH_PLAN_OPERATION_CAP = 500;
const PATCH_PLAN_DOCUMENT_BYTES_CAP = 700_000;
const PATCHABLE_RULE_IDS = new Set(
  builtinAuditRules.filter((rule) => rule.emitsOperations !== false).map((rule) => rule.id),
);

/** The workspace's hygiene.policy model, for the actions that audit (createPlanForRule, healthSnapshots). */
export const modelFor = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: (ctx, args) => modelSettings(ctx, args.orgId, "hygiene.policy"),
});

export const ruleCatalog = query({
  args: {},
  handler: async () => builtinAuditRules.map((rule) => ({
    id: rule.id,
    title: rule.title,
    description: rule.description,
    category: rule.category,
    patchable: PATCHABLE_RULE_IDS.has(rule.id),
  })),
});

async function currentActionUser(ctx: ActionCtx) {
  const user = await ctx.runQuery(api.users.me, {});
  if (!user) throw new Error("Not authenticated");
  return user;
}

export const createPlanForRule = action({
  args: { rule: v.string(), today: v.optional(v.string()) },
  handler: async (ctx, args): Promise<
    | { status: "created"; patchPlanId: Id<"patchPlans">; operationCount: number; storedOperationCount: number; truncated: boolean }
    | { status: "nothing_to_patch"; rule: string; message: string }
    | { status: "manual_review"; rule: string; message: string }
  > => {
    const user = await currentActionUser(ctx);
    await ctx.runQuery(internal.permissions.requireUnrestrictedPrincipal, { orgId: user.orgId, userId: user._id, what: "hygiene plans over the CRM" });
    if (!PATCHABLE_RULE_IDS.has(args.rule)) {
      return { status: "manual_review", rule: args.rule, message: `${args.rule} is a findings-only rule. Review and resolve it manually.` };
    }

    const snapshot = await snapshotFromPages(ctx, user.orgId);
    const model = await ctx.runQuery(internal.hygiene.modelFor, { orgId: user.orgId });
    const plan = filterPlanByRule(auditSnapshot(snapshot, hygienePolicy(model, args.today), hygieneRules(model)), args.rule);
    if (plan.operations.length === 0) {
      return {
        status: "nothing_to_patch",
        rule: args.rule,
        message: `Nothing to patch for ${args.rule} — a recent sync may have resolved these records. Re-sync if the issue still appears.`,
      };
    }

    const suggestionsByOperationId = new Map(suggestValues(plan, snapshot).map((suggestion) => [suggestion.operationId, suggestion]));
    // Shrink the stored slice until the review document fits the byte cap:
    // the fixed operation cap alone is not enough when individual operations
    // carry large before/after payloads (a 100k-record org produced a 3.5MB
    // document at 500 ops and hard-failed here). The full plan is still
    // re-derivable from a fresh audit; the stored slice is a review window.
    const buildSlice = (count: number) => {
      const storedOperations = plan.operations.slice(0, count).map((operation) => ({
        ...operation,
        packageOpId: operation.id,
        suggestion: suggestionsByOperationId.get(operation.id),
      }));
      const reviewDocument = {
        ...plan,
        operations: plan.operations.slice(0, storedOperations.length),
        summary:
          storedOperations.length < plan.operations.length
            ? `${plan.summary} Stored ${storedOperations.length} of ${plan.operations.length} operation(s).`
            : plan.summary,
      };
      return { storedOperations, reviewDocument, bytes: JSON.stringify(reviewDocument).length };
    };
    let sliceCount = Math.min(plan.operations.length, PATCH_PLAN_OPERATION_CAP);
    let slice = buildSlice(sliceCount);
    while (slice.bytes > PATCH_PLAN_DOCUMENT_BYTES_CAP && sliceCount > 1) {
      // Estimate how many ops fit from the average op size, with 10% headroom,
      // then rebuild; loop handles uneven op sizes.
      const perOp = slice.bytes / Math.max(1, sliceCount);
      sliceCount = Math.max(1, Math.min(sliceCount - 1, Math.floor((PATCH_PLAN_DOCUMENT_BYTES_CAP * 0.9) / perOp)));
      slice = buildSlice(sliceCount);
    }
    if (slice.bytes > PATCH_PLAN_DOCUMENT_BYTES_CAP) {
      throw new ConvexError(`Patch plan document is ${slice.bytes} bytes even at a single operation, over the ${PATCH_PLAN_DOCUMENT_BYTES_CAP}-byte cap. This record's payload is too large to review; resolve it manually.`);
    }
    const { storedOperations, reviewDocument } = slice;
    const persisted: { patchPlanId: Id<"patchPlans"> } = await ctx.runMutation(internal.hygiene.persistRulePlan, {
      userId: user._id,
      orgId: user.orgId,
      rule: args.rule,
      summary: plan.summary,
      operations: storedOperations,
      document: JSON.parse(JSON.stringify(reviewDocument)),
      foundOperationCount: plan.operations.length,
    });
    await ctx.runMutation(internal.opportunities.markPlannedForRule, {
      orgId: user.orgId,
      rule: args.rule,
      planId: persisted.patchPlanId,
      objectIds: storedOperations.map((operation) => operation.objectId),
    });
    return {
      status: "created",
      patchPlanId: persisted.patchPlanId,
      operationCount: plan.operations.length,
      storedOperationCount: storedOperations.length,
      truncated: storedOperations.length < plan.operations.length,
    };
  },
});

export const persistRulePlan = internalMutation({
  args: {
    userId: v.id("users"),
    orgId: v.id("organizations"),
    rule: v.string(),
    summary: v.string(),
    operations: v.array(v.any()),
    document: v.optional(v.any()),
    foundOperationCount: v.number(),
    // The CRM the plan writes to, for orgs with both connected; unset means the one active CRM.
    provider: v.optional(v.union(v.literal("hubspot"), v.literal("salesforce"))),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !(await userBelongsToOrg(ctx, user, args.orgId))) throw new Error("User not found");
    const now = Date.now();
    const riskLevel = args.operations.some((op) => op.riskLevel === "high")
      ? "high"
      : args.operations.some((op) => op.riskLevel === "medium")
        ? "medium"
        : "low";
    const approvalRequirement = args.operations.some((op) => op.approvalRequired) ? "required" : "not_required";
    const storedCount = args.operations.length;
    const truncated = storedCount < args.foundOperationCount;
    const reason = truncated
      ? `${args.summary} Stored ${storedCount} of ${args.foundOperationCount} operation(s).`
      : args.summary;
    const patchPlanId = await ctx.db.insert("patchPlans", {
      orgId: args.orgId,
      createdBy: args.userId,
      verb: "do",
      operation: "hygiene.apply_operations",
      args: { rule: args.rule, foundOperationCount: args.foundOperationCount, storedOperationCount: storedCount, truncated, ...(args.provider ? { provider: args.provider } : {}) },
      reason,
      status: approvalRequirement === "required" ? "pending_approval" : "draft",
      riskLevel,
      approvalRequirement,
      createdAt: now,
      updatedAt: now,
      document: args.document,
      truncatedOperations: truncated,
      totalOperationCount: args.foundOperationCount,
      storedOperationCount: storedCount,
    });
    for (const operation of args.operations) {
      await ctx.db.insert("patchOperations", {
        orgId: args.orgId,
        patchPlanId,
        objectType: operation.objectType,
        objectId: operation.objectId,
        fieldOrAction: operation.field ?? operation.operation,
        beforeValue: operation.beforeValue,
        afterValue: operation.afterValue,
        reason: operation.reason,
        sourceRuleOrPolicy: operation.sourceRuleOrPolicy ?? args.rule,
        riskLevel: operation.riskLevel,
        approvalRequirement: operation.approvalRequired ? "required" : "not_required",
        rollback: operation.rollback,
        packageOpId: typeof operation.packageOpId === "string" ? operation.packageOpId : typeof operation.id === "string" ? operation.id : undefined,
        suggestion: operation.suggestion,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    if (approvalRequirement === "required") {
      await ctx.db.insert("approvalRequests", {
        orgId: args.orgId,
        patchPlanId,
        requestedBy: args.userId,
        status: "pending",
        reason,
        createdAt: now,
        updatedAt: now,
      });
    }
    return { patchPlanId };
  },
});
