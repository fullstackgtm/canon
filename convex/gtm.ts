import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { requireUser, activeClerkOrgIdFromIdentity } from "./lib";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { requireUnrestricted, unrestrictedUser } from "./permissions";
import {
  accountPrimitiveSpec,
  approvalPrimitiveSpec,
  callPrimitiveSpec,
  competitorPrimitiveSpec,
  dealPrimitiveSpec,
  gtmNounSpecs,
  healthPrimitiveSpec,
  icpPrimitiveSpec,
  integrationPrimitiveSpec,
  organizationPrimitiveSpec,
  patchPlanPrimitiveSpec,
  researchPrimitiveSpec,
  routingPrimitiveSpec,
  userPrimitiveSpec,
} from "./lib/gtmNouns";
import { readinessNames, summarizeReadiness } from "./lib/gtmWorkspace";

const modeValidator = v.optional(v.union(v.literal("dry_run"), v.literal("apply")));

export const describe = query({
  args: {},
  handler: async () => {
    return {
      verbs: ["find", "set", "do", "parse"],
      findResources: Object.keys(findResources).sort(),
      setOperations: Object.keys(setOperations).sort(),
      actions: Object.keys(actionOperations).sort(),
      parseInputs: Object.keys(parseOperations).sort(),
      defaultMutationMode: "dry_run",
      primitives: gtmNounSpecs,
      note:
        "This is the canonical GTM operation layer. Nouns define bottom-up behavior; module-specific Convex functions are implementation details behind find/set/do/parse.",
    };
  },
});

export const find = query({
  args: {
    resource: v.string(),
    args: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const handler = findResources[args.resource];
    if (!handler) throw new ConvexError(`Unsupported find resource: ${args.resource}`);
    return handler(ctx, args.args ?? {});
  },
});

export const set = mutation({
  args: {
    operation: v.string(),
    args: v.optional(v.any()),
    mode: modeValidator,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const user = await requireUser(ctx);
    await requireUnrestricted(ctx, "a set plan over the CRM");
    const mode = args.mode ?? "dry_run";
    if (!setOperations[args.operation]) {
      throw new ConvexError(`Unsupported set operation: ${args.operation}`);
    }

    if (mode === "dry_run") {
      const preview = dryRunPlan({
        orgId: user.orgId,
        userId: user._id,
        verb: "set",
        operation: args.operation,
        args: args.args ?? {},
        reason: args.reason,
      });
      // Resolve the target record so the plan carries a real objectId and the
      // before-values of the fields it intends to change (mapped ops only).
      await enrichSetPreviewTarget(ctx, user, args.operation, (args.args ?? {}) as OperationArgs, preview);
      return persistPatchPlanPreview(ctx, user, preview);
    }

    throw new ConvexError(
      "Direct gtm.set apply is disabled. Run dry_run to create a patch plan, approve it, then apply through patch_plan.apply.",
    );
  },
});

export const doAction = action({
  args: {
    action: v.string(),
    args: v.optional(v.any()),
    mode: modeValidator,
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");

    const mode = args.mode ?? "dry_run";
    const handler = actionOperations[args.action];
    if (!handler) throw new ConvexError(`Unsupported action: ${args.action}`);

    if (mode === "dry_run") {
      return {
        kind: "patch_plan_preview",
        verb: "do",
        operation: args.action,
        args: args.args ?? {},
        reason: args.reason,
        riskLevel: actionRisk(args.action),
        approvalRequirement: actionRisk(args.action) === "high" ? "required" : "not_required",
        executable: true,
      };
    }

    if (args.action !== "patch_plan.apply") {
      throw new ConvexError(
        "Direct gtm.do apply is disabled for agent-facing actions. Run dry_run and use approved patch plans for writes.",
      );
    }

    return handler(ctx, args.args ?? {});
  },
});

/**
 * Persist a `do` operation as a pending patch plan — the governed path for
 * action-verbs that mutate external systems (e.g. backfill.stripe). The plan
 * shows up in the patch-plans approval flow; apply dispatches through
 * applyDoInternal.
 */
export const proposeDo = mutation({
  args: {
    operation: v.string(),
    args: v.optional(v.any()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!actionOperations[args.operation]) {
      throw new ConvexError(`Unsupported action: ${args.operation}`);
    }
    const riskLevel = actionRisk(args.operation);
    const approvalRequirement = riskLevel === "high" ? "required" : "not_required";
    // Broad-effect `do` operations persist a single args-blob row; the scope
    // map spells out the blast radius so a reviewer sees it on the op card.
    const scope = doOpScope(args.operation, (args.args ?? {}) as OperationArgs);
    const baseReason = args.reason ?? "Requested through gtm.proposeDo";
    return persistPatchPlanPreview(ctx, user, {
      kind: "patch_plan_preview",
      verb: "do",
      operation: args.operation,
      args: args.args ?? {},
      reason: args.reason,
      riskLevel,
      approvalRequirement,
      operations: [
        {
          objectType: scope?.objectType ?? objectTypeFromOperation(args.operation),
          objectId: null,
          fieldOrAction: args.operation,
          beforeValue: null,
          afterValue: args.args ?? {},
          reason: scope ? `${scope.scope} ${baseReason}` : baseReason,
          sourceRuleOrPolicy: "gtm_operation_layer",
          riskLevel,
          approvalRequirement,
          rollback: rollbackForOperation(args.operation),
        },
      ],
    });
  },
});

/**
 * Persist a `do` plan WITH a caller-supplied detailed operation list — the
 * action-layer twin of proposeDo, for operations whose preview requires
 * external reads (e.g. stripeActions.proposeBackfillPlan fetches invoices).
 * The persisted rows are what reviewers see in Patch Plans and what apply
 * executes.
 */
export const persistDoPlanInternal = internalMutation({
  args: {
    userId: v.id("users"),
    operation: v.string(),
    args: v.optional(v.any()),
    reason: v.optional(v.string()),
    operations: v.array(v.any()),
    document: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError("User not found");
    if (!actionOperations[args.operation]) {
      throw new ConvexError(`Unsupported action: ${args.operation}`);
    }
    const riskLevel = actionRisk(args.operation);
    const approvalRequirement = riskLevel === "high" ? "required" : "not_required";
    return persistPatchPlanPreview(ctx, user, {
      kind: "patch_plan_preview",
      verb: "do",
      operation: args.operation,
      args: args.args ?? {},
      reason: args.reason,
      riskLevel,
      approvalRequirement,
      operations: args.operations,
      document: args.document,
    });
  },
});

/**
 * Apply-side dispatch for approved `do` plans. Internal-only: reachable
 * exclusively from patchPlanActions.apply AFTER the approval decision, so the
 * public doAction gate ("dry_run only") stays intact. The plan's persisted
 * operations ride along so handlers can execute exactly what was reviewed.
 */
export const applyDoInternal = internalAction({
  args: {
    action: v.string(),
    args: v.optional(v.any()),
    operations: v.optional(v.array(v.any())),
    planDocument: v.optional(v.any()),
    patchPlanId: v.optional(v.id("patchPlans")),
    valueOverrides: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const handler = actionOperations[args.action];
    if (!handler) throw new ConvexError(`Unsupported action: ${args.action}`);
    return handler(
      ctx,
      (args.args ?? {}) as OperationArgs,
      args.operations as PersistedDoOperation[] | undefined,
      args.planDocument,
      args.patchPlanId,
      args.valueOverrides as Record<string, unknown> | undefined,
    );
  },
});

export const parse = action({
  args: {
    inputType: v.string(),
    input: v.any(),
    mode: modeValidator,
  },
  handler: async (ctx, args): Promise<unknown> => {
    const handler = parseOperations[args.inputType];
    await ctx.runQuery(internal.permissions.requireUnrestrictedCaller, { what: "parsing into the CRM" });
    if (!handler) throw new ConvexError(`Unsupported parse input: ${args.inputType}`);
    // Default is dry_run, matching set/do. Every in-repo caller (scripts/fsgtm.ts,
    // scripts/fsgtm-mcp.ts, /api/gtm/ops) already passes an explicit mode, and the
    // public API route already defaulted to dry_run — pass mode: "apply" to ingest.
    return handler(ctx, args.input, args.mode ?? "dry_run");
  },
});

type OperationArgs = Record<string, unknown>;

type FindHandler = (ctx: QueryCtx, args: OperationArgs) => Promise<unknown>;
type SetHandler = (ctx: MutationCtx, args: OperationArgs) => Promise<unknown>;
/**
 * A persisted patchOperations row, as handed to a `do` handler at apply time.
 * Handlers that execute reviewed plans (backfill.stripe) apply EXACTLY these
 * rows; handlers without one recompute from args.
 */
export type PersistedDoOperation = {
  /** The patchOperations row id, so apply handlers can write per-op outcomes back. */
  _id?: string;
  objectType: string;
  objectId?: string;
  fieldOrAction: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string;
  sourceRuleOrPolicy?: string;
  rollback?: string;
};

type ActionHandler = (
  ctx: ActionCtx,
  args: OperationArgs,
  operations?: PersistedDoOperation[],
  planDocument?: unknown,
  patchPlanId?: Id<"patchPlans">,
  valueOverrides?: Record<string, unknown>,
) => Promise<unknown>;
type ParseHandler = (
  ctx: ActionCtx,
  input: unknown,
  mode: "dry_run" | "apply",
) => Promise<unknown>;

const findResources: Record<string, FindHandler> = {
  summary: (ctx) => ctx.runQuery(api.dashboard.summary, {}),
  readiness: (ctx, args) => aggregateReadiness(ctx, args),
  noun_readiness: (ctx, args) => aggregateReadiness(ctx, args),

  organization: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.organizations.readiness, {});
    if (view !== "context") throw new ConvexError(`Unsupported organization view: ${view}`);
    return { primitive: organizationPrimitiveSpec, ...(await ctx.runQuery(api.organizations.context, {})) };
  },
  user: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.users.readiness, {});
    if (view === "records") return ctx.runQuery(api.users.list, {});
    if (view !== "context") throw new ConvexError(`Unsupported user view: ${view}`);
    return { primitive: userPrimitiveSpec, ...(await ctx.runQuery(api.users.context, {})) };
  },
  integration: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.integrations.readiness, {});
    if (view === "runs") return ctx.runQuery(api.integrations.listSyncRuns, { limit: numberArg(args, "limit", 20) });
    if (view !== "context") throw new ConvexError(`Unsupported integration view: ${view}`);
    return { primitive: integrationPrimitiveSpec, ...(await ctx.runQuery(api.integrations.context, {})), connections: await integrationConnections(ctx, args) };
  },

  account: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.accounts.readiness, {});
    if (view === "records") return ctx.runQuery(api.accounts.context, {});
    if (view !== "context") throw new ConvexError(`Unsupported account view: ${view}`);
    return { primitive: accountPrimitiveSpec, ...(await ctx.runQuery(api.accounts.context, {})) };
  },
  deals: (ctx) => ctx.runQuery(api.deals.list, {}),
  deal: async (ctx, args) => {
    const view = stringArg(args, "view", args.dealId ? "record" : "context");
    if (view === "readiness") return ctx.runQuery(api.deals.readiness, {});
    if (view === "pipeline") return ctx.runQuery(api.deals.list, {});
    if (view === "forecast") return ctx.runQuery(api.forecasting.getCurrentForecast, dateRangeArgs(args));
    if (view === "record") return ctx.runQuery(api.deals.get, { dealId: requiredId(args, "dealId") as any });
    if (view !== "context") throw new ConvexError(`Unsupported deal view: ${view}`);
    return { primitive: dealPrimitiveSpec, ...(await ctx.runQuery(api.deals.context, {})) };
  },
  team: (ctx) => ctx.runQuery(api.users.list, {}),
  integrations: async (ctx, args) => ({
    hubspot: await ctx.runQuery(api.hubspot.getConnection, {}),
    salesforce: await ctx.runQuery(api.salesforce.getConnection, {}),
    callProviders: await ctx.runQuery(api.callProviders.listConnections, {}),
    syncRuns: await ctx.runQuery(api.integrations.listSyncRuns, {
      limit: numberArg(args, "limit", 10),
    }),
  }),
  sync_runs: (ctx, args) => ctx.runQuery(api.integrations.listSyncRuns, {
    provider: optionalString(args, "provider") as any,
    limit: numberArg(args, "limit", 10),
  }),

  abm: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.abm.readiness, {});
    if (view === "lists") return ctx.runQuery(api.abm.listLists, {});
    if (view === "stats") return ctx.runQuery(api.abm.getStats, {});
    if (view !== "context") throw new ConvexError(`Unsupported abm view: ${view}`);
    return { ...(await ctx.runQuery(api.abm.context, {})), stats: await ctx.runQuery(api.abm.getStats, {}) };
  },
  abm_lists: (ctx) => ctx.runQuery(api.abm.listLists, {}),
  abm_list: async (ctx, args) => {
    const listId = requiredId(args, "listId") as any;
    return {
      list: await ctx.runQuery(api.abm.getList, { listId }),
      accounts: await ctx.runQuery(api.abm.listAccounts, { listId }),
      plays: await ctx.runQuery(api.abm.listPlays, { listId }),
      stats: await ctx.runQuery(api.abm.getStats, {}),
    };
  },
  abm_candidate_accounts: (ctx, args) => ctx.runQuery(api.abm.listCandidateAccounts, {
    listId: requiredId(args, "listId") as any,
  }),
  routing: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.leadScoring.readiness, {});
    if (view === "models") return ctx.runQuery(api.leadScoring.listModels, {});
    if (view === "scores") return ctx.runQuery(api.leadScoring.listScores, { modelId: optionalId(args, "modelId") as any });
    if (view === "rules") return ctx.runQuery(api.leadScoring.listRoutingRules, {});
    if (view !== "context") throw new ConvexError(`Unsupported routing view: ${view}`);
    return { primitive: routingPrimitiveSpec, ...(await ctx.runQuery(api.leadScoring.context, {})) };
  },
  lead_models: (ctx) => findCanonical(ctx, "routing", { view: "models" }),
  lead_scores: (ctx, args) => findCanonical(ctx, "routing", { view: "scores", modelId: optionalId(args, "modelId") }),
  routing_rules: (ctx) => findCanonical(ctx, "routing", { view: "rules" }),
  icp: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.icp.readiness, {});
    if (view === "profiles") return ctx.runQuery(api.icp.listProfiles, {});
    if (view === "scores") return ctx.runQuery(api.icp.listScores, { profileId: optionalId(args, "profileId") as any });
    if (view === "top_accounts") return ctx.runQuery(api.icp.getTopAccounts, { limit: numberArg(args, "limit", 50) });
    if (view !== "context") throw new ConvexError(`Unsupported icp view: ${view}`);
    return { primitive: icpPrimitiveSpec, ...(await ctx.runQuery(api.icp.context, {})) };
  },
  icp_profiles: (ctx) => findCanonical(ctx, "icp", { view: "profiles" }),
  icp_scores: (ctx, args) => findCanonical(ctx, "icp", { view: "scores", profileId: optionalId(args, "profileId") }),
  icp_top_accounts: (ctx, args) => findCanonical(ctx, "icp", { view: "top_accounts", limit: numberArg(args, "limit", 50) }),

  health: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.customerHealth.readiness, {});
    if (view === "configs") return ctx.runQuery(api.customerHealth.listConfigs, {});
    if (view === "scores") return optionalString(args, "health")
      ? ctx.runQuery(api.customerHealth.listByHealth, { health: optionalString(args, "health") as any })
      : ctx.runQuery(api.customerHealth.listScores, {});
    if (view === "stats") return ctx.runQuery(api.customerHealth.getStats, {});
    if (view !== "context") throw new ConvexError(`Unsupported health view: ${view}`);
    return { primitive: healthPrimitiveSpec, ...(await ctx.runQuery(api.customerHealth.context, {})), stats: await ctx.runQuery(api.customerHealth.getStats, {}) };
  },
  competitor: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.competitive.readiness, {});
    if (view === "records") return ctx.runQuery(api.competitive.listCompetitors, {});
    if (view === "battlecards") return ctx.runQuery(api.competitive.listBattlecards, { competitorId: optionalId(args, "competitorId") as any });
    if (view === "win_loss") return ctx.runQuery(api.competitive.listWinLoss, {});
    if (view !== "context") throw new ConvexError(`Unsupported competitor view: ${view}`);
    return { primitive: competitorPrimitiveSpec, ...(await ctx.runQuery(api.competitive.context, {})), stats: await ctx.runQuery(api.competitive.getWinLossStats, {}) };
  },
  competitive: (ctx) => findCanonical(ctx, "competitor", { view: "context" }),
  research: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return ctx.runQuery(api.research.readiness, {});
    if (view === "records") return ctx.runQuery(api.research.listEnrichments, {});
    if (view === "account") return ctx.runQuery(api.research.getForAccount, { accountId: requiredId(args, "accountId") as any });
    if (view !== "context") throw new ConvexError(`Unsupported research view: ${view}`);
    return { primitive: researchPrimitiveSpec, ...(await ctx.runQuery(api.research.context, {})) };
  },
  account_research: (ctx, args) => ctx.runQuery(api.research.getForAccount, {
    accountId: requiredId(args, "accountId") as any,
  }),
  forecast: (ctx, args) => ctx.runQuery(api.forecasting.getCurrentForecast, {
    ...dateRangeArgs(args),
  }),
  forecast_by_rep: (ctx, args) => ctx.runQuery(api.forecasting.getForecastByRep, {
    ...dateRangeArgs(args),
  }),
  calls: (ctx, args) => ctx.runQuery(api.callIntelligence.listCalls, {
    limit: numberArg(args, "limit", 50),
    provider: optionalString(args, "provider") as any,
    dealId: optionalId(args, "dealId") as any,
    accountId: optionalId(args, "accountId") as any,
  }),
  call: async (ctx, args) => {
    const view = stringArg(args, "view", args.callId ? "record" : "context");
    if (view === "readiness") return ctx.runQuery(api.callIntelligence.readiness, {});
    if (view === "records") return ctx.runQuery(api.callIntelligence.listCalls, { limit: numberArg(args, "limit", 50) });
    if (view === "insights") return ctx.runQuery(api.callIntelligence.listInsights, { limit: numberArg(args, "limit", 100) });
    if (view === "record") return ctx.runQuery(api.callIntelligence.getCall, {
      callId: requiredId(args, "callId") as any,
    });
    if (view !== "context") throw new ConvexError(`Unsupported call view: ${view}`);
    return { primitive: callPrimitiveSpec, ...(await ctx.runQuery(api.callIntelligence.context, {})) };
  },
  call_insights: (ctx, args) => ctx.runQuery(api.callIntelligence.listInsights, {
    type: optionalString(args, "type") as any,
    status: optionalString(args, "status") as any,
    limit: numberArg(args, "limit", 100),
  }),
  call_summary: (ctx) => ctx.runQuery(api.callIntelligence.summary, {}),
  approval: async (ctx, args) => {
    const view = stringArg(args, "view", "context");
    if (view === "readiness") return approvalReadiness(ctx);
    if (view !== "context") throw new ConvexError(`Unsupported approval view: ${view}`);
    return { primitive: approvalPrimitiveSpec, readiness: await approvalReadiness(ctx) };
  },
  patch_plan: async (ctx, args) => {
    const view = stringArg(args, "view", args.patchPlanId ? "record" : "context");
    if (view === "readiness") return patchPlanReadiness(ctx);
    if (view === "records") return ctx.runQuery(api.patchPlans.list, { limit: numberArg(args, "limit", 50), status: optionalString(args, "status") as any });
    if (view === "record") return ctx.runQuery(api.patchPlans.get, { patchPlanId: requiredId(args, "patchPlanId") as any });
    if (view !== "context") throw new ConvexError(`Unsupported patch_plan view: ${view}`);
    return { primitive: patchPlanPrimitiveSpec, readiness: await patchPlanReadiness(ctx), records: await ctx.runQuery(api.patchPlans.list, { limit: 20 }) };
  },
};

const setOperations: Record<string, SetHandler> = {
  "deal.forecast_category": (ctx, args) => ctx.runMutation(api.deals.updateForecast, {
    dealId: requiredId(args, "dealId") as any,
    forecastCategory: requiredString(args, "forecastCategory") as any,
  }),
  "deal.next_step": (ctx, args) => ctx.runMutation(api.deals.updateNextStep, {
    dealId: requiredId(args, "dealId") as any,
    nextStep: requiredString(args, "nextStep"),
  }),
  update_deal_forecast: (ctx, args) => ctx.runMutation(api.deals.updateForecast, {
    dealId: requiredId(args, "dealId") as any,
    forecastCategory: requiredString(args, "forecastCategory") as any,
  }),
  "organization.settings": (ctx, args) => ctx.runMutation(api.organizations.updateSettings, args as any),
  "user.profile": (ctx, args) => ctx.runMutation(api.users.update, {
    userId: requiredId(args, "userId") as any,
    title: optionalString(args, "title"),
    role: optionalString(args, "role") as any,
    managerId: optionalId(args, "managerId") as any,
    isActive: optionalBoolean(args, "isActive"),
  }),
  "integration.settings": (ctx, args) => ctx.runMutation(api.integrations.updateSettings, args as any),
  update_team_member: (ctx, args) => ctx.runMutation(api.users.update, {
    userId: requiredId(args, "userId") as any,
    title: optionalString(args, "title"),
    role: optionalString(args, "role") as any,
    managerId: optionalId(args, "managerId") as any,
    isActive: optionalBoolean(args, "isActive"),
  }),
  update_org_settings: (ctx, args) => ctx.runMutation(api.organizations.updateSettings, args as any),
  update_integration_settings: (ctx, args) => ctx.runMutation(api.integrations.updateSettings, args as any),
  create_abm_list: (ctx, args) => ctx.runMutation(api.abm.createList, args as any),
  update_abm_list: (ctx, args) => ctx.runMutation(api.abm.updateList, args as any),
  update_abm_account: (ctx, args) => ctx.runMutation(api.abm.updateAccount, args as any),
  create_abm_play: (ctx, args) => ctx.runMutation(api.abm.createPlay, args as any),
  update_abm_play: (ctx, args) => ctx.runMutation(api.abm.updatePlay, args as any),
  "routing.model": (ctx, args) => ctx.runMutation(api.leadScoring.createModel, args as any),
  "routing.rule": (ctx, args) => ctx.runMutation(api.leadScoring.createRoutingRule, args as any),
  create_lead_model: (ctx, args) => ctx.runMutation(api.leadScoring.createModel, args as any),
  update_lead_model: (ctx, args) => ctx.runMutation(api.leadScoring.updateModel, args as any),
  create_routing_rule: (ctx, args) => ctx.runMutation(api.leadScoring.createRoutingRule, args as any),
  update_routing_rule: (ctx, args) => ctx.runMutation(api.leadScoring.updateRoutingRule, args as any),
  "icp.profile": (ctx, args) => ctx.runMutation(api.icp.createProfile, args as any),
  create_icp_profile: (ctx, args) => ctx.runMutation(api.icp.createProfile, args as any),
  update_icp_profile: (ctx, args) => ctx.runMutation(api.icp.updateProfile, args as any),
  "health.model": (ctx, args) => ctx.runMutation(api.customerHealth.createConfig, args as any),
  create_health_config: (ctx, args) => ctx.runMutation(api.customerHealth.createConfig, args as any),
  update_health_config: (ctx, args) => ctx.runMutation(api.customerHealth.updateConfig, args as any),
  "competitor.record": (ctx, args) => ctx.runMutation(api.competitive.createCompetitor, args as any),
  "competitor.battlecard": (ctx, args) => ctx.runMutation(api.competitive.createBattlecard, args as any),
  create_competitor: (ctx, args) => ctx.runMutation(api.competitive.createCompetitor, args as any),
  update_competitor: (ctx, args) => ctx.runMutation(api.competitive.updateCompetitor, args as any),
  create_battlecard: (ctx, args) => ctx.runMutation(api.competitive.createBattlecard, args as any),
  update_battlecard: (ctx, args) => ctx.runMutation(api.competitive.updateBattlecard, args as any),
};

const actionOperations: Record<string, ActionHandler> = {
  // Stripe → closed-won backfill. Always high-risk (creates CRM records), so
  // it only ever runs through an APPROVED patch plan: proposeDo persists the
  // pending plan, approval happens in the patch-plans flow, and
  // patchPlanActions.apply dispatches here via gtm.applyDoInternal. The
  // underlying stripeActions.backfillApplyInternal is internal-only, so there
  // is no unapproved path to the write.
  "backfill.stripe": async (ctx, args, operations, planDocument, patchPlanId, valueOverrides) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    // Plans created through stripeActions.proposeBackfillPlan carry the full
    // reviewed operation list — apply EXACTLY those (what was approved is
    // what runs). Legacy arg-only plans fall back to recomputing.
    if (operations && operations.length > 0) {
      return ctx.runAction(internal.stripeActions.backfillApplyOpsInternal, {
        orgId: user.orgId,
        operations,
        planDocument,
        patchPlanId,
        valueOverrides,
      });
    }
    return ctx.runAction(internal.stripeActions.backfillApplyInternal, {
      orgId: user.orgId,
      sinceIso: typeof args.sinceIso === "string" ? args.sinceIso : undefined,
      pipeline: typeof args.pipeline === "string" ? args.pipeline : undefined,
    });
  },
  // Hygiene remediation — always through an APPROVED plan whose persisted
  // per-operation review rows select the package PatchPlan operation ids.
  "hygiene.apply_operations": async (ctx, _args, operations, planDocument, patchPlanId, valueOverrides) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!operations || operations.length === 0) {
      throw new ConvexError("This hygiene plan carries no persisted operations.");
    }
    return ctx.runAction(internal.hygieneActions.applyOperationsInternal, {
      orgId: user.orgId,
      operations,
      planDocument,
      patchPlanId,
      valueOverrides,
    });
  },
  "deal.assign_owners": async (ctx, _args, operations, planDocument, patchPlanId, valueOverrides) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not authenticated");
    const user = await ctx.runQuery(internal.hubspot.getUserByClerkId, {
      clerkUserId: identity.subject,
      activeClerkOrgId: activeClerkOrgIdFromIdentity(identity) ?? undefined,
    });
    if (!user) throw new ConvexError("User not found");
    if (!operations || operations.length === 0) {
      throw new ConvexError(
        "This plan carries no persisted owner assignments. Create it through ownership.proposeDealOwnerBackfill.",
      );
    }
    return ctx.runAction(internal.ownershipActions.applyDealOwnersInternal, {
      orgId: user.orgId,
      operations,
      planDocument,
      patchPlanId,
      valueOverrides,
    });
  },
  "organization.bootstrap": async () => ({ ok: true, message: "Organization defaults are created during auth/dev seed. Configure settings with set organization.settings." }),
  "user.bootstrap": async () => ({ ok: true, message: "Users sync from auth/CRM owner sync. Run CRM sync via integration.sync." }),
  "integration.sync": (ctx, args) => {
    const provider = requiredString(args, "provider");
    if (provider === "hubspot") return ctx.runAction(api.hubspotActions.syncAll, {});
    if (provider === "salesforce") return ctx.runAction(api.salesforceActions.syncAll, {});
    if (provider === "gong" || provider === "chorus" || provider === "fathom" || provider === "avoma" || provider === "granola") {
      return ctx.runAction(api.callProviderActions.syncProvider, { provider });
    }
    throw new ConvexError(`Unsupported integration provider: ${provider}`);
  },
  "integration.disconnect": (ctx, args) => {
    const provider = requiredString(args, "provider");
    if (provider === "hubspot") return ctx.runAction(api.hubspot.disconnectWithRevocation, {});
    if (provider === "salesforce") return ctx.runAction(api.salesforce.disconnectWithRevocation, {});
    if (provider === "gong" || provider === "chorus" || provider === "fathom" || provider === "avoma" || provider === "granola") {
      return ctx.runMutation(api.callProviders.disconnect, { provider });
    }
    throw new ConvexError(`Unsupported integration provider: ${provider}`);
  },
  sync_hubspot: (ctx) => ctx.runAction(api.hubspotActions.syncAll, {}),
  sync_salesforce: (ctx) => ctx.runAction(api.salesforceActions.syncAll, {}),
  sync_call_provider: (ctx, args) => ctx.runAction(api.callProviderActions.syncProvider, {
    provider: requiredString(args, "provider") as any,
  }),
  connect_call_provider: (ctx, args) => ctx.runMutation(api.callProviders.connect, args as any),
  disconnect_call_provider: (ctx, args) => ctx.runMutation(api.callProviders.disconnect, args as any),
  disconnect_hubspot: (ctx) => ctx.runAction(api.hubspot.disconnectWithRevocation, {}),
  disconnect_salesforce: (ctx) => ctx.runAction(api.salesforce.disconnectWithRevocation, {}),
  "account.bootstrap": (ctx) => ctx.runAction(api.hubspotActions.syncAll, {}),
  "account.enrich": (ctx) => ctx.runMutation(api.research.generateFromCrm, {}),
  "deal.inspect": async (ctx, args) => ({
    forecast: await ctx.runQuery(api.forecasting.getCurrentForecast, dateRangeArgs(args)),
    byRep: await ctx.runQuery(api.forecasting.getForecastByRep, dateRangeArgs(args)),
    calls: await ctx.runQuery(api.callIntelligence.listInsights, { limit: numberArg(args, "limit", 100) }),
  }),
  "call.import": (ctx, args) => ctx.runAction(api.callProviderActions.syncProvider, {
    provider: requiredString(args, "provider") as any,
  }),
  "call.analyze": (ctx, args) => ctx.runMutation(api.callIntelligence.analyzeCall, {
    callId: requiredId(args, "callId") as any,
  }),
  generate_abm_from_crm: (ctx) => ctx.runMutation(api.abm.generateFromCrm, {}),
  "routing.bootstrap": (ctx) => ctx.runAction(api.leadScoring.generateFromCrm, {}),
  generate_leads_from_crm: (ctx) => ctx.runAction(api.leadScoring.generateFromCrm, {}),
  "icp.score": (ctx) => ctx.runAction(api.icp.generateFromCrm, {}),
  generate_icp_from_crm: (ctx) => ctx.runAction(api.icp.generateFromCrm, {}),
  "health.score": (ctx) => ctx.runMutation(api.customerHealth.generateFromCrm, {}),
  generate_health_from_crm: (ctx) => ctx.runMutation(api.customerHealth.generateFromCrm, {}),
  "competitor.bootstrap": (ctx) => ctx.runMutation(api.competitive.generateFromDeals, {}),
  generate_competitive_from_deals: (ctx) => ctx.runMutation(api.competitive.generateFromDeals, {}),
  "research.enrich": (ctx) => ctx.runMutation(api.research.generateFromCrm, {}),
  generate_research_from_crm: (ctx) => ctx.runMutation(api.research.generateFromCrm, {}),
  ingest_demo_call: (ctx) => ctx.runMutation(api.callIntelligence.ingestAndAnalyzeDemo, {}),
  "approval.request": (ctx, args) => {
    // Never default the decision — an approval must be stated, not implied.
    const decision = optionalString(args, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new ConvexError(
        'approval.request requires an explicit "decision" arg ("approved" or "rejected") — it is never defaulted.',
      );
    }
    return ctx.runMutation(api.patchPlans.approve, {
      patchPlanId: requiredId(args, "patchPlanId") as any,
      decision,
      reason: optionalString(args, "reason"),
    });
  },
  "patch_plan.apply": (ctx, args) => ctx.runAction(api.patchPlanActions.apply, {
    patchPlanId: requiredId(args, "patchPlanId") as any,
  }),
  analyze_call: (ctx, args) => ctx.runMutation(api.callIntelligence.analyzeCall, {
    callId: requiredId(args, "callId") as any,
  }),
};

/**
 * Apply a governed `set`/`do` operation by name through the same handler
 * registry the live CLI/MCP/API use. Patch-plan apply dispatches through these
 * so every operation a plan can be created for can also be applied — there is
 * no separate, partial apply path.
 */
export async function dispatchSetOperation(
  ctx: MutationCtx,
  operation: string,
  operationArgs: OperationArgs,
): Promise<unknown> {
  const handler = setOperations[operation];
  if (!handler) throw new ConvexError(`Unsupported set operation: ${operation}`);
  return handler(ctx, operationArgs);
}

export async function dispatchActionOperation(
  ctx: ActionCtx,
  operation: string,
  operationArgs: OperationArgs,
): Promise<unknown> {
  const handler = actionOperations[operation];
  if (!handler) throw new ConvexError(`Unsupported action operation: ${operation}`);
  return handler(ctx, operationArgs);
}

const parseOperations: Record<string, ParseHandler> = {
  call_transcript: async (ctx, input, mode) => {    const payload = normalizeParseObject(input);
    if (mode === "dry_run") {
      return {
        kind: "parse_preview",
        inputType: "call_transcript",
        outputPrimitive: "call_intelligence",
        title: payload.title ?? "Untitled call",
        transcriptChars: String(payload.transcriptText ?? "").length,
      };
    }
    const created: { callId: string } = await ctx.runMutation(api.callIntelligence.ingestTranscript, {
      provider: (payload.provider as any) ?? "manual",
      externalCallId: optionalPayloadString(payload, "externalCallId"),
      title: requiredPayloadString(payload, "title"),
      callDate: optionalPayloadString(payload, "callDate"),
      durationSeconds: optionalPayloadNumber(payload, "durationSeconds"),
      recordingUrl: optionalPayloadString(payload, "recordingUrl"),
      participants: Array.isArray(payload.participants) ? payload.participants : undefined,
      transcriptText: requiredPayloadString(payload, "transcriptText"),
    });
    const analysis = await ctx.runMutation(api.callIntelligence.analyzeCall, {
      callId: created.callId as any,
    });
    return { ...created, analysis };
  },
};

type PatchPlanPreview = Omit<ReturnType<typeof dryRunPlan>, "verb"> & {
  verb: "set" | "do";
  document?: unknown;
};

const MAX_STORED_DOCUMENT_OPS = 2000;
const MAX_STORED_DOCUMENT_BYTES = 700_000;

function boundedReviewDocument(document: unknown, storedOperationCount: number): { document: unknown; truncated: boolean; total: number; stored: number } {
  if (storedOperationCount > MAX_STORED_DOCUMENT_OPS) {
    throw new ConvexError(`Patch plan has ${storedOperationCount} review rows, over the ${MAX_STORED_DOCUMENT_OPS}-operation document cap. Split this plan into smaller slices.`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { document, truncated: false, total: storedOperationCount, stored: storedOperationCount };
  }
  const candidate = document as { operations?: unknown[]; summary?: unknown };
  if (!Array.isArray(candidate.operations)) {
    const bytes = JSON.stringify(document).length;
    if (bytes > MAX_STORED_DOCUMENT_BYTES) throw new ConvexError(`Patch plan document is ${bytes} bytes, over the ${MAX_STORED_DOCUMENT_BYTES}-byte cap. Split this plan into smaller slices.`);
    return { document, truncated: false, total: storedOperationCount, stored: storedOperationCount };
  }
  const total = candidate.operations.length;
  const stored = Math.min(storedOperationCount, total, MAX_STORED_DOCUMENT_OPS);
  const truncated = stored < total;
  const sliced = { ...candidate, operations: candidate.operations.slice(0, stored) };
  const serialized = JSON.stringify(sliced);
  if (serialized.length > MAX_STORED_DOCUMENT_BYTES) {
    throw new ConvexError(`Patch plan document is ${serialized.length} bytes after capping to ${stored} operations, over the ${MAX_STORED_DOCUMENT_BYTES}-byte cap. Split this plan into smaller slices.`);
  }
  return { document: JSON.parse(serialized), truncated, total, stored };
}

async function persistPatchPlanPreview(ctx: MutationCtx, user: any, preview: PatchPlanPreview) {
  const now = Date.now();
  const status = preview.approvalRequirement === "required" ? "pending_approval" : "draft";
  const bounded = boundedReviewDocument(preview.document, preview.operations.length);
  const patchPlanId = await ctx.db.insert("patchPlans", {
    orgId: user.orgId,
    createdBy: user._id,
    verb: preview.verb,
    operation: preview.operation,
    args: preview.args,
    reason: preview.reason,
    status,
    riskLevel: preview.riskLevel as "low" | "medium" | "high",
    approvalRequirement: preview.approvalRequirement as "not_required" | "required",
    createdAt: now,
    updatedAt: now,
    document: bounded.document,
    truncatedOperations: bounded.truncated,
    totalOperationCount: bounded.total,
    storedOperationCount: preview.operations.length,
  });
  const documentOps = bounded.document && typeof bounded.document === "object" && !Array.isArray(bounded.document)
    ? ((bounded.document as { operations?: Array<{ id?: unknown }> }).operations ?? [])
    : [];
  const positionalPackageIds = documentOps.length === preview.operations.length;
  for (const [index, operation] of preview.operations.entries()) {
    await ctx.db.insert("patchOperations", {
      orgId: user.orgId,
      patchPlanId,
      objectType: operation.objectType,
      objectId: typeof operation.objectId === "string" ? operation.objectId : undefined,
      fieldOrAction: operation.fieldOrAction,
      beforeValue: operation.beforeValue,
      afterValue: operation.afterValue,
      reason: operation.reason,
      sourceRuleOrPolicy: operation.sourceRuleOrPolicy,
      riskLevel: operation.riskLevel as "low" | "medium" | "high",
      approvalRequirement: operation.approvalRequirement as "not_required" | "required",
      rollback: operation.rollback,
      packageOpId: typeof operation.packageOpId === "string" ? operation.packageOpId : positionalPackageIds && typeof documentOps[index]?.id === "string" ? documentOps[index].id : undefined,
      suggestion: operation.suggestion,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
  if (preview.approvalRequirement === "required") {
    await ctx.db.insert("approvalRequests", {
      orgId: user.orgId,
      patchPlanId,
      requestedBy: user._id,
      status: "pending",
      reason: preview.reason,
      createdAt: now,
      updatedAt: now,
    });
  }
  // Summary only — the full preview (every operation of a 1–2K-op backfill)
  // would push this audit document toward the 1MiB cap. Operation rows live
  // in patchOperations; this entry just records that a preview happened.
  await ctx.db.insert("operationAuditLog", {
    orgId: user.orgId,
    userId: user._id,
    patchPlanId,
    verb: preview.verb,
    operation: preview.operation,
    status: "previewed",
    details: {
      verb: preview.verb,
      operation: preview.operation,
      reason: preview.reason,
      riskLevel: preview.riskLevel,
      approvalRequirement: preview.approvalRequirement,
      operationCount: preview.operations.length,
      argsPreview: JSON.stringify(preview.args ?? null).slice(0, 2000),
    },
    createdAt: now,
  });
  return { ...preview, patchPlanId, persisted: true, status };
}

type PreviewOperation = {
  objectType: string;
  objectId: unknown;
  fieldOrAction: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string;
  sourceRuleOrPolicy: string;
  riskLevel: string;
  approvalRequirement: string;
  rollback: string;
  suggestion?: unknown;
  packageOpId?: string;
};

function dryRunPlan(args: {
  orgId: unknown;
  userId: unknown;
  verb: "set";
  operation: string;
  args: unknown;
  reason?: string;
}) {
  const riskLevel = setRisk(args.operation);
  const approvalRequirement = riskLevel === "high" ? "required" : "not_required";
  const operations: PreviewOperation[] = [
    {
      objectType: objectTypeFromOperation(args.operation),
      objectId: recordIdFromArgs(args.args),
      fieldOrAction: fieldOrActionFromOperation(args.operation),
      beforeValue: null,
      afterValue: args.args,
      reason: args.reason ?? "Requested through gtm.set dry run",
      sourceRuleOrPolicy: "gtm_operation_layer",
      riskLevel,
      approvalRequirement,
      rollback: rollbackForOperation(args.operation),
    },
  ];
  return {
    kind: "patch_plan_preview",
    verb: args.verb,
    operation: args.operation,
    args: args.args,
    reason: args.reason,
    riskLevel,
    approvalRequirement,
    operations,
  };
}

/**
 * Target metadata for registered set operations: which arg carries the record
 * id, which table it lives in, and the reviewer-facing object type. The set
 * dry_run path uses it to resolve the target doc (ONE ctx.db.get per plan)
 * and capture real before-values for the fields the plan intends to change.
 * Unmapped operations keep the null-before / args-sniffed-id fallback.
 */
const SET_OP_TARGETS: Record<string, { idArg?: string; table?: string; objectType: string }> = {
  "deal.forecast_category": { idArg: "dealId", table: "deals", objectType: "deal" },
  "deal.next_step": { idArg: "dealId", table: "deals", objectType: "deal" },
  update_deal_forecast: { idArg: "dealId", table: "deals", objectType: "deal" },
  "organization.settings": { table: "organizations", objectType: "organization" },
  update_org_settings: { table: "organizations", objectType: "organization" },
  "user.profile": { idArg: "userId", table: "users", objectType: "user" },
  update_team_member: { idArg: "userId", table: "users", objectType: "user" },
  update_abm_list: { idArg: "listId", table: "abmLists", objectType: "abm_list" },
  update_abm_account: { idArg: "listAccountId", table: "abmListAccounts", objectType: "abm_account" },
  update_abm_play: { idArg: "playId", table: "abmPlays", objectType: "abm_play" },
  update_lead_model: { idArg: "modelId", table: "leadScoringModels", objectType: "lead_model" },
  update_routing_rule: { idArg: "ruleId", table: "routingRules", objectType: "routing_rule" },
  update_icp_profile: { idArg: "profileId", table: "icpProfiles", objectType: "icp_profile" },
  update_health_config: { idArg: "configId", table: "customerHealthConfigs", objectType: "health_config" },
  update_competitor: { idArg: "competitorId", table: "competitors", objectType: "competitor" },
  update_battlecard: { idArg: "battlecardId", table: "battlecards", objectType: "battlecard" },
};

/**
 * Resolve the set operation's target document and stamp the preview's single
 * operation row with the real objectId and the before-values of exactly the
 * fields the args intend to change. Cheap by design: at most one ctx.db.get.
 */
async function enrichSetPreviewTarget(
  ctx: MutationCtx,
  user: { orgId: string },
  operation: string,
  operationArgs: OperationArgs,
  preview: ReturnType<typeof dryRunPlan>,
) {
  const target = SET_OP_TARGETS[operation];
  const row = preview.operations[0];
  if (!target || !row) return;
  row.objectType = target.objectType;
  const docId = target.idArg
    ? optionalId(operationArgs, target.idArg)
    : target.table === "organizations"
      ? (user.orgId as string)
      : undefined;
  if (!docId) return;
  let doc: Record<string, unknown> | null = null;
  try {
    doc = (await ctx.db.get(docId as any)) as Record<string, unknown> | null;
  } catch {
    return; // malformed id — keep the fallback preview untouched
  }
  if (!doc) return;
  if ("orgId" in doc && doc.orgId !== user.orgId) return;
  row.objectId = docId;
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(operationArgs)) {
    if (key === target.idArg) continue;
    if (key in doc) before[key] = doc[key];
  }
  row.beforeValue = before;
}

function setRisk(operation: string) {
  if (operation.includes("deal") || operation.includes("statement") || operation.includes("owner")) return "high";
  if (operation.includes("status") || operation.includes("settings")) return "medium";
  return "low";
}

/**
 * Blast-radius descriptions for `do` operations whose single persisted row is
 * otherwise just an args blob. The scope text is PREPENDED to the operation
 * reason so a reviewer sees what the op actually touches before approving.
 * `<provider>` is interpolated from args (or the operation name) at use time.
 */
const DO_OP_SCOPES: Record<string, { objectType: string; scope: string }> = {
  "integration.sync": { objectType: "integration", scope: "Re-syncs the ENTIRE CRM mirror: all owners, accounts, contacts, and deals from <provider>." },
  sync_hubspot: { objectType: "integration", scope: "Re-syncs the ENTIRE CRM mirror: all owners, accounts, contacts, and deals from <provider>." },
  sync_salesforce: { objectType: "integration", scope: "Re-syncs the ENTIRE CRM mirror: all owners, accounts, contacts, and deals from <provider>." },
  "deal.assign_owners": { objectType: "deal", scope: "Writes the owner field on every listed deal in the CRM." },
  "call.import": { objectType: "call", scope: "Imports <provider>'s full call corpus." },
  sync_call_provider: { objectType: "call", scope: "Imports <provider>'s full call corpus." },
  "integration.disconnect": { objectType: "integration", scope: "Severs the org's CRM connection to <provider>." },
  disconnect_hubspot: { objectType: "integration", scope: "Severs the org's CRM connection to <provider>." },
  disconnect_salesforce: { objectType: "integration", scope: "Severs the org's CRM connection to <provider>." },
  disconnect_call_provider: { objectType: "integration", scope: "Severs the org's call-provider connection to <provider>." },
  generate_abm_from_crm: { objectType: "abm", scope: "Recomputes ABM lists for up to hundreds of records from the synced CRM." },
  "routing.bootstrap": { objectType: "routing", scope: "Recomputes lead scores and routing for up to hundreds of records from the synced CRM." },
  generate_leads_from_crm: { objectType: "routing", scope: "Recomputes lead scores and routing for up to hundreds of records from the synced CRM." },
  "icp.score": { objectType: "icp", scope: "Recomputes ICP scores for up to hundreds of records from the synced CRM." },
  generate_icp_from_crm: { objectType: "icp", scope: "Recomputes ICP scores for up to hundreds of records from the synced CRM." },
  "health.score": { objectType: "health", scope: "Recomputes customer-health scores for up to hundreds of records from the synced CRM." },
  generate_health_from_crm: { objectType: "health", scope: "Recomputes customer-health scores for up to hundreds of records from the synced CRM." },
  "competitor.bootstrap": { objectType: "competitor", scope: "Recomputes competitor records and win/loss from every deal in the synced CRM." },
  generate_competitive_from_deals: { objectType: "competitor", scope: "Recomputes competitor records and win/loss from every deal in the synced CRM." },
  "account.enrich": { objectType: "account", scope: "Recomputes enrichment for up to hundreds of accounts from the synced CRM." },
  "research.enrich": { objectType: "research", scope: "Recomputes enrichment for up to hundreds of accounts from the synced CRM." },
  generate_research_from_crm: { objectType: "research", scope: "Recomputes enrichment for up to hundreds of accounts from the synced CRM." },
};

function doOpScope(operation: string, opArgs: OperationArgs): { objectType: string; scope: string } | null {
  const entry = DO_OP_SCOPES[operation];
  if (!entry) return null;
  const provider =
    optionalString(opArgs, "provider") ??
    (operation.endsWith("hubspot") ? "HubSpot" : operation.endsWith("salesforce") ? "Salesforce" : undefined);
  return { objectType: entry.objectType, scope: entry.scope.replace("<provider>", provider ?? "the connected provider") };
}

function objectTypeFromOperation(operation: string) {
  const objectType = operation.includes(".")
    ? operation.split(".")[0]
    : operation.split("_").find((part) => ["deal", "account", "user", "organization"].includes(part));
  return objectType || "gtm_operation";
}

function fieldOrActionFromOperation(operation: string) {
  if (operation === "deal.next_step") return "nextStep";
  if (operation === "deal.forecast_category" || operation === "update_deal_forecast") return "forecastCategory";
  return operation;
}

function rollbackForOperation(operation: string) {
  if (operation === "backfill.stripe") {
    return "Archive the created deals — each was net-new and carries its Stripe invoice id, so they are individually identifiable.";
  }
  if (operation === "deal.next_step") {
    return "Restore the previous deal next step in Salesforce/HubSpot or the local deal record.";
  }
  if (operation === "deal.forecast_category" || operation === "update_deal_forecast") {
    return "Restore the previous forecast category in Salesforce/HubSpot or the local deal record.";
  }
  return "No mutation applied in dry_run mode. If applied later, restore the prior value from operation beforeValue/audit.";
}

function actionRisk(operation: string) {
  // Backfill/assign write CRM records — always approval-gated.
  if (operation.includes("backfill") || operation.includes("assign")) return "high";
  if (operation.includes("sync") || operation.includes("disconnect") || operation.includes("connect")) return "high";
  if (operation.includes("generate")) return "medium";
  return "low";
}

function requiredId(args: OperationArgs, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new ConvexError(`${name} is required`);
  return value;
}

function optionalId(args: OperationArgs, name: string) {
  const value = args[name];
  return typeof value === "string" && value ? value : undefined;
}

function requiredString(args: OperationArgs, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new ConvexError(`${name} is required`);
  return value;
}

function stringArg(args: OperationArgs, name: string, fallback: string) {
  const value = args[name];
  return typeof value === "string" && value ? value : fallback;
}

function optionalString(args: OperationArgs, name: string) {
  const value = args[name];
  return typeof value === "string" && value ? value : undefined;
}

function arrayArg(args: OperationArgs, name: string) {
  const value = args[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined;
}

function optionalNumber(args: OperationArgs, name: string) {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArg(args: OperationArgs, name: string, fallback: number) {
  const value = optionalNumber(args, name);
  return value ?? fallback;
}

function optionalBoolean(args: OperationArgs, name: string) {
  const value = args[name];
  return typeof value === "boolean" ? value : undefined;
}

function dateRangeArgs(args: OperationArgs) {
  const year = new Date().getUTCFullYear();
  return {
    periodStart: stringArg(args, "periodStart", `${year}-01-01`),
    periodEnd: stringArg(args, "periodEnd", `${year}-12-31`),
  };
}

async function findCanonical(ctx: QueryCtx, resource: string, args: OperationArgs = {}) {
  const handler = findResources[resource];
  if (!handler) throw new ConvexError(`Unsupported canonical find resource: ${resource}`);
  return handler(ctx, args);
}

/**
 * Aggregate noun readiness for `find readiness` / `find noun_readiness`.
 *
 * BUDGET MATH — this runs as ONE query transaction, so every runQuery below
 * joins the same 4096-document read budget (budgets SUM, they don't reset).
 * Worst-case caps per noun (realistic org: 10k contacts / 5k accounts /
 * 3k deals / 100 users is far lower):
 *
 *   Fanned out to the real per-noun readiness queries (each ≤ ~660):
 *     organization ~3 · user ~502 · integration ~152 · deal ~353
 *     · call ~522 · competitor ~652 · approval ~102 · patch_plan ~127 ≈ 2,413
 *   Derived HERE from org.crmCounts + bounded probes (their full readiness
 *   queries each scan 1000-row crmAccounts/crmContacts/etc samples —
 *   1,000–2,300 reads apiece, which summed would blow the cap):
 *     account ~5 · abm ~152 · routing ~152 · icp ~102 · health ~102
 *     · research ~252                                                ≈   765
 *   Viewer + org + presence probes                                   ≈     5
 *   TOTAL ≈ 3,183 worst case (realistic ≈ 1,600)                    < 4,096
 *
 * The derived rows keep the same shape (noun/required/relevant/configured/
 * lifecycle/signals/nextActions) and lifecycle semantics as the full queries;
 * their sampled signals saturate at the probe size and carry `sampled: true`.
 * For exact per-noun detail, call the noun's own `find <noun> view=readiness`,
 * which still runs the full query in its own transaction.
 */
async function aggregateReadiness(ctx: QueryCtx, args: OperationArgs = {}) {
  const requested = arrayArg(args, "nouns");
  const wanted = (noun: string) => !requested || requested.includes(noun);
  const viewer = await unrestrictedUser(ctx);
  const orgId = viewer?.orgId ?? null;
  const org = orgId ? await ctx.db.get(orgId) : null;
  const crmCounts = org?.crmCounts;

  // Presence markers for CRM row tables when the maintained counters are not
  // set yet (org never synced since crmCounts shipped): a take(1) existence
  // probe instead of a 1000-row sample. Counter-backed counts are exact.
  const crmAccountCount =
    crmCounts?.accounts ??
    (orgId && (wanted("account") || wanted("abm") || wanted("icp") || wanted("health") || wanted("research"))
      ? (await ctx.db.query("crmAccounts").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(1)).length
      : 0);
  const crmContactCount =
    crmCounts?.contacts ??
    (orgId && wanted("routing")
      ? (await ctx.db.query("crmContacts").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(1)).length
      : 0);

  const finders: Record<string, () => Promise<unknown>> = {
    organization: () => ctx.runQuery(api.organizations.readiness, {}),
    user: () => ctx.runQuery(api.users.readiness, {}),
    integration: () => ctx.runQuery(api.integrations.readiness, {}),
    account: () => derivedAccountReadiness(ctx, orgId, crmAccountCount, crmCounts),
    deal: () => ctx.runQuery(api.deals.readiness, {}),
    call: () => ctx.runQuery(api.callIntelligence.readiness, {}),
    abm: () => derivedAbmReadiness(ctx, orgId, crmAccountCount),
    routing: () => derivedRoutingReadiness(ctx, orgId, crmContactCount),
    icp: () => derivedIcpReadiness(ctx, orgId, crmAccountCount),
    health: () => derivedHealthReadiness(ctx, orgId, crmAccountCount),
    competitor: () => ctx.runQuery(api.competitive.readiness, {}),
    research: () => derivedResearchReadiness(ctx, orgId, crmAccountCount),
    approval: () => approvalReadiness(ctx),
    patch_plan: () => patchPlanReadiness(ctx),
  };

  const entries = Object.entries(finders).filter(([noun]) => wanted(noun));
  const rows = await Promise.all(entries.map(async ([noun, finder]) => [noun, await finder()] as const));
  return {
    nouns: Object.fromEntries(rows),
    summary: summarizeReadiness(rows),
    required: readinessNames(rows, (row) => row.required),
    relevant: readinessNames(rows, (row) => row.relevant),
    missing: readinessNames(rows, (row) => row.relevant && !row.configured),
    missingRequired: readinessNames(rows, (row) => row.required && !row.configured),
  };
}

// Probe size for the derived readiness rows: enough to answer "is this noun
// configured and roughly how active is it" without joining a 1000-row scan to
// the aggregate transaction. Sampled counts saturate at this value.
const READINESS_PROBE = 50;

type OrgIdArg = import("./_generated/dataModel").Id<"organizations"> | null;
type CrmCountsArg =
  | {
      accounts: number;
      contacts: number;
      deals: number;
      openDeals: number;
      openPipeline: number;
      wonRevenue: number;
      updatedAt: number;
    }
  | undefined;

/** ~2 integration point reads; counts/pipeline from crmCounts. */
async function derivedAccountReadiness(
  ctx: QueryCtx,
  orgId: OrgIdArg,
  accountCount: number,
  crmCounts: CrmCountsArg,
) {
  if (!orgId) {
    return {
      noun: "account",
      required: true,
      relevant: false,
      configured: false,
      lifecycle: "not_connected",
      signals: { crmConnected: false, accountCount: 0, contactCount: 0, openPipeline: 0, sampled: true },
      nextActions: ["Sign in to inspect account readiness"],
    };
  }
  const [hubspot, salesforce] = await Promise.all([
    ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "hubspot")).first(),
    ctx.db.query("integrations").withIndex("by_orgId_provider", (q) => q.eq("orgId", orgId).eq("provider", "salesforce")).first(),
  ]);
  const connected = Boolean(hubspot?.isActive || salesforce?.isActive);
  return {
    noun: "account",
    required: true,
    relevant: connected || accountCount > 0,
    configured: accountCount > 0,
    lifecycle: !connected && accountCount === 0 ? "not_connected" : accountCount > 0 ? "synced" : "connected_no_records",
    signals: {
      crmConnected: connected,
      accountCount,
      contactCount: crmCounts?.contacts ?? 0,
      openPipeline: crmCounts?.openPipeline ?? 0,
      sampled: true,
    },
    nextActions: accountCount > 0
      ? ["do account.enrich", "review ICP/health/ABM views"]
      : ["connect CRM", "do account.bootstrap", "parse account_csv"],
  };
}

/** Mirrors abm.readiness lifecycle logic over READINESS_PROBE-row samples. */
async function derivedAbmReadiness(ctx: QueryCtx, orgId: OrgIdArg, accountCount: number) {
  if (!orgId) {
    return {
      noun: "abm",
      required: false,
      relevant: false,
      configured: false,
      lifecycle: "not_relevant_yet",
      signals: { listCount: 0, targetAccountCount: 0, playCount: 0, activePlays: 0, accountCount: 0, sampled: true },
      nextActions: ["Sign in to inspect ABM readiness"],
    };
  }
  const [lists, listAccounts, plays] = await Promise.all([
    ctx.db.query("abmLists").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("abmListAccounts").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("abmPlays").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
  ]);
  // NOTE: matches abm.readiness (abm.ts) exactly, including its untyped
  // `play.status` check — the schema field is `isActive`, so activePlays is 0
  // there too. Fixing that belongs in abm.ts, not in this mirror.
  const activePlays = plays.filter((play) => (play as any).status === "active");
  const relevant = lists.length > 0 || listAccounts.length > 0 || plays.length > 0 || accountCount > 0;
  return {
    noun: "abm",
    required: false,
    relevant,
    configured: lists.length > 0,
    lifecycle: activePlays.length > 0 ? "active" : lists.length > 0 ? "targeted" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { listCount: lists.length, targetAccountCount: listAccounts.length, playCount: plays.length, activePlays: activePlays.length, accountCount, sampled: true },
    nextActions: lists.length > 0 ? ["review target accounts", "launch ABM play"] : ["do abm.bootstrap", "sync account data"],
  };
}

/** Mirrors leadScoring.readiness lifecycle logic over bounded samples. */
async function derivedRoutingReadiness(ctx: QueryCtx, orgId: OrgIdArg, contactCount: number) {
  if (!orgId) {
    return {
      noun: "routing",
      required: false,
      relevant: false,
      configured: false,
      lifecycle: "not_relevant_yet",
      signals: { modelCount: 0, ruleCount: 0, scoreCount: 0, contactCount: 0, sampled: true },
      nextActions: ["Sign in to inspect routing readiness"],
    };
  }
  const [models, rules, scores] = await Promise.all([
    ctx.db.query("leadScoringModels").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("routingRules").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("leadScores").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
  ]);
  const relevant = models.length > 0 || rules.length > 0 || scores.length > 0 || contactCount > 0;
  const configured = models.length > 0 || rules.length > 0;
  return {
    noun: "routing",
    required: false,
    relevant,
    configured,
    lifecycle: configured ? "active_or_draft" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { modelCount: models.length, ruleCount: rules.length, scoreCount: scores.length, contactCount, sampled: true },
    nextActions: configured ? ["review scores", "set routing.rule"] : ["do routing.bootstrap", "set routing.model"],
  };
}

/** Mirrors icp.readiness lifecycle logic over bounded samples. */
async function derivedIcpReadiness(ctx: QueryCtx, orgId: OrgIdArg, accountCount: number) {
  if (!orgId) {
    return {
      noun: "icp",
      required: false,
      relevant: false,
      configured: false,
      lifecycle: "not_relevant_yet",
      signals: { profileCount: 0, activeProfiles: 0, scoreCount: 0, accountCount: 0, sampled: true },
      nextActions: ["Sign in to inspect ICP readiness"],
    };
  }
  const [profiles, scores] = await Promise.all([
    ctx.db.query("icpProfiles").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("icpScores").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
  ]);
  // NOTE: matches icp.readiness (icp.ts) exactly, including its untyped
  // `profile.isActive` check — the schema field is `isDefault`, so
  // activeProfiles is 0 there too. Fixing that belongs in icp.ts.
  const activeProfiles = profiles.filter((profile) => (profile as any).isActive);
  const relevant = profiles.length > 0 || accountCount > 0 || scores.length > 0;
  return {
    noun: "icp",
    required: false,
    relevant,
    configured: profiles.length > 0,
    lifecycle: activeProfiles.length > 0 ? "active" : profiles.length > 0 ? "draft" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { profileCount: profiles.length, activeProfiles: activeProfiles.length, scoreCount: scores.length, accountCount, sampled: true },
    nextActions: profiles.length > 0 ? ["review top accounts", "set icp.profile"] : ["do icp.bootstrap", "connect account data"],
  };
}

/** Mirrors customerHealth.readiness lifecycle logic over bounded samples. */
async function derivedHealthReadiness(ctx: QueryCtx, orgId: OrgIdArg, accountCount: number) {
  if (!orgId) {
    return {
      noun: "health",
      required: false,
      relevant: false,
      configured: false,
      lifecycle: "not_relevant_yet",
      signals: { configCount: 0, scoreCount: 0, accountCount: 0, atRiskAccounts: 0, sampled: true },
      nextActions: ["Sign in to inspect health readiness"],
    };
  }
  const [configs, scores] = await Promise.all([
    ctx.db.query("customerHealthConfigs").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
    ctx.db.query("customerHealthScores").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(READINESS_PROBE),
  ]);
  const atRisk = scores.filter((score) => score.health === "at_risk" || score.health === "churning").length;
  const relevant = configs.length > 0 || scores.length > 0 || accountCount > 0;
  const configured = configs.length > 0 || scores.length > 0;
  return {
    noun: "health",
    required: false,
    relevant,
    configured,
    lifecycle: scores.length > 0 ? "scored" : configs.length > 0 ? "configured" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { configCount: configs.length, scoreCount: scores.length, accountCount, atRiskAccounts: atRisk, sampled: true },
    nextActions: configured ? ["review at-risk accounts", "set health.config"] : ["do health.bootstrap", "sync account usage/support data"],
  };
}

/** Mirrors research.readiness lifecycle logic over a 250-row sample. */
async function derivedResearchReadiness(ctx: QueryCtx, orgId: OrgIdArg, accountCount: number) {
  if (!orgId) {
    return {
      noun: "research",
      required: false,
      relevant: false,
      configured: false,
      lifecycle: "not_relevant_yet",
      signals: { enrichmentCount: 0, staleEnrichments: 0, accountCount: 0, sampled: true },
      nextActions: ["Sign in to inspect research readiness"],
    };
  }
  const enrichments = await ctx.db
    .query("accountEnrichments")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .take(250);
  const stale = enrichments.filter((row) => !row.lastEnrichedAt || Date.now() - row.lastEnrichedAt > 30 * 86_400_000).length;
  const relevant = accountCount > 0 || enrichments.length > 0;
  return {
    noun: "research",
    required: false,
    relevant,
    configured: enrichments.length > 0,
    lifecycle: enrichments.length > 0 ? "enriched" : relevant ? "not_configured" : "not_relevant_yet",
    signals: { enrichmentCount: enrichments.length, staleEnrichments: stale, accountCount, sampled: true },
    nextActions: enrichments.length > 0 ? ["refresh stale research", "find account research"] : ["do research.enrich_accounts", "sync accounts"],
  };
}

async function integrationConnections(ctx: QueryCtx, args: OperationArgs = {}) {
  return {
    hubspot: await ctx.runQuery(api.hubspot.getConnection, {}),
    salesforce: await ctx.runQuery(api.salesforce.getConnection, {}),
    callProviders: await ctx.runQuery(api.callProviders.listConnections, {}),
    syncRuns: await ctx.runQuery(api.integrations.listSyncRuns, { limit: numberArg(args, "limit", 10) }),
  };
}

async function approvalReadiness(ctx: QueryCtx) {
  const user = await unrestrictedUser(ctx);
  const workflows = user
    ? await ctx.db.query("approvalWorkflows").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).take(100)
    : [];
  return {
    noun: "approval",
    required: false,
    relevant: workflows.length > 0,
    configured: workflows.length > 0,
    lifecycle: workflows.length > 0 ? "configured" : "not_required",
    signals: { workflowCount: workflows.length },
    nextActions: workflows.length > 0 ? ["request approval for high-risk patch plans"] : ["set approval.workflow when governance is needed"],
  };
}

async function patchPlanReadiness(ctx: QueryCtx) {
  const user = await unrestrictedUser(ctx);
  const [plans, audit] = user
    ? await Promise.all([
        ctx.db.query("patchPlans").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(100),
        ctx.db.query("operationAuditLog").withIndex("by_orgId", (q) => q.eq("orgId", user.orgId)).order("desc").take(25),
      ])
    : [[], []];
  const pendingApproval = plans.filter((plan) => plan.status === "pending_approval").length;
  return {
    noun: "patch_plan",
    required: false,
    relevant: true,
    configured: plans.length > 0,
    lifecycle: pendingApproval > 0 ? "pending_approval" : plans.length > 0 ? "active" : "available",
    signals: { patchPlanCount: plans.length, pendingApproval, recentOperationAuditRows: audit.length, persistentPatchPlansImplemented: true },
    nextActions: ["create dry-run patch plans", "approve high-risk plans", "apply supported patch plans"],
  };
}

function normalizeParseObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConvexError("parse input must be an object");
  }
  return input as Record<string, unknown>;
}

function optionalPayloadString(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  return typeof value === "string" && value ? value : undefined;
}

function requiredPayloadString(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) throw new ConvexError(`${name} is required`);
  return value;
}

function optionalPayloadNumber(payload: Record<string, unknown>, name: string) {
  const value = payload[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordIdFromArgs(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  return (
    record.id ??
    record.dealId ??
    record.accountId ??
    record.userId ??
    null
  );
}
