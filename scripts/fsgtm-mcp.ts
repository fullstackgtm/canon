import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod/v4";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { getGtmOperatingModel } from "../src/lib/gtm-operating-model.ts";
import { getGtmSurfaceManifest } from "../src/lib/gtm-surface-manifest.ts";
import { getGtmMutationReference, gtmMutationNames, gtmMutationSurfaceManifest } from "../src/lib/gtm-mutation-registry.ts";

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function client() {
  loadLocalEnv();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required in env or .env.local");
  }

  const convex = new ConvexHttpClient(url);
  const token = process.env.FSGTM_AUTH_TOKEN;
  if (token) convex.setAuth(token);
  return convex;
}

function content(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: "fullstackgtm",
  version: "0.1.0",
});

server.registerTool(
  "gtm_capabilities",
  {
    title: "GTM Capabilities",
    description: "Return the machine-readable CLI/MCP contract and agent quickstart for CanonCRM.",
  },
  async () => content({
    ok: true,
    tool: "gtm",
    cli: {
      command: "npm run gtm -- <command> [options]",
      firstCommands: [
        "npm run gtm -- capabilities --json",
        "npm run gtm -- doctor --json",
        "npm run gtm -- surface --json",
        "npm run gtm -- describe --json",
      ],
    },
    contract: {
      stdout: "data only; JSON mode prints parseable JSON to stdout",
      stderr: "diagnostics only",
      dryRunDefaultFor: ["gtm_set", "gtm_do", "gtm_parse"],
      applyRequires: "explicit mode=apply plus reason when available",
    },
    exitCodes: { success: 0, userInputError: 1, safetyBlock: 2, toolEnvironmentError: 3, upstreamFailure: 4, conflict: 5 },
    keyTools: ["gtm_surface_manifest", "gtm_mutation_manifest", "gtm_mutation", "gtm_operating_model", "gtm_find", "gtm_set", "gtm_do", "gtm_parse", "gtm_patch_plans", "gtm_calls"],
  }),
);

server.registerTool(
  "gtm_doctor",
  {
    title: "GTM Doctor",
    description: "Return setup diagnostics and recommended first commands for agents using the GTM MCP server.",
  },
  async () => content({
    ok: Boolean(process.env.NEXT_PUBLIC_CONVEX_URL),
    checks: [
      {
        name: "convex-url-configured",
        ok: Boolean(process.env.NEXT_PUBLIC_CONVEX_URL),
        detail: process.env.NEXT_PUBLIC_CONVEX_URL || "NEXT_PUBLIC_CONVEX_URL is missing",
        hint: "Set NEXT_PUBLIC_CONVEX_URL in .env.local or environment before data-backed MCP calls.",
      },
      {
        name: "auth-token-optional",
        ok: true,
        detail: process.env.FSGTM_AUTH_TOKEN ? "FSGTM_AUTH_TOKEN is set" : "No FSGTM_AUTH_TOKEN; local dev-bypass or public metadata tools may still work.",
      },
    ],
    nextCommands: [
      "npm run gtm -- doctor --json",
      "npm run gtm -- mcp-smoke --json",
    ],
  }),
);

server.registerTool(
  "gtm_surface_manifest",
  {
    title: "GTM Surface Manifest",
    description: "Return the shared dashboard/API/CLI/MCP surface manifest for parity audits and tool selection.",
  },
  async () => content(getGtmSurfaceManifest()),
);

server.registerTool(
  "gtm_mutation_manifest",
  {
    title: "GTM Mutation Manifest",
    description: "Return allowlisted dashboard mutations that can be previewed/applied through CLI, MCP, and API surfaces.",
  },
  async () => content(gtmMutationSurfaceManifest()),
);

server.registerTool(
  "gtm_mutation",
  {
    title: "GTM Mutation",
    description: "Echo (unvalidated preview) or apply an allowlisted dashboard mutation. Only mode=apply executes; anything else echoes the request without validating args (Convex's generated api is anyApi — no runtime arg metadata). Typed dry-run previews live in the patch-plan surface.",
    inputSchema: {
      name: z.string(),
      args: z.record(z.string(), z.any()).optional(),
      mode: z.enum(["echo", "dry_run", "apply"]).optional(),
    },
  },
  async ({ name, args, mode }) => {
    const mutationRef = getGtmMutationReference(name);
    if (!mutationRef) return content({ ok: false, error: { code: "USER_INPUT", message: `Mutation is not allowlisted: ${name}`, hints: ["Call gtm_mutation_manifest first."] }, allowedMutations: gtmMutationNames() });
    if (mode !== "apply") return content({ ok: true, mode: "echo", validated: false, mutation: name, args: args ?? {}, allowedMutations: gtmMutationNames() });
    const result = await client().mutation(mutationRef as any, (args ?? {}) as any);
    return content(result);
  },
);

server.registerTool(
  "gtm_operating_model",
  {
    title: "GTM Operating Model",
    description:
      "Read the canonical CanonCRM primitive registry, source-of-record policy, provider support, and CRM storage recommendations.",
  },
  async () => content(getGtmOperatingModel()),
);

server.registerTool(
  "gtm_describe_operations",
  {
    title: "Describe GTM Operations",
    description: "List canonical find/set/do/parse resources and actions exposed by the GTM operation layer.",
  },
  async () => {
    const result = await client().query(api.gtm.describe, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_find",
  {
    title: "GTM Find",
    description: "Run a canonical read over the GTM operation layer.",
    inputSchema: {
      resource: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async ({ resource, args }) => {
    const result = await client().query(api.gtm.find, { resource, args: args ?? {} });
    return content(result);
  },
);

server.registerTool(
  "gtm_set",
  {
    title: "GTM Set",
    description:
      "Create a dry-run canonical patch plan for a governed state mutation. Direct apply is disabled; approve and apply patch plans separately.",
    inputSchema: {
      operation: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      mode: z.enum(["dry_run", "apply"]).optional(),
      reason: z.string().optional(),
    },
  },
  async ({ operation, args, mode, reason }) => {
    const result = await client().mutation(api.gtm.set, {
      operation,
      args: args ?? {},
      mode: mode ?? "dry_run",
      reason,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_do",
  {
    title: "GTM Do",
    description:
      "Preview a side-effectful GTM action, or apply an already approved patch plan. Other direct apply actions are disabled.",
    inputSchema: {
      action: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      mode: z.enum(["dry_run", "apply"]).optional(),
      reason: z.string().optional(),
    },
  },
  async ({ action, args, mode, reason }) => {
    const result = await client().action(api.gtm.doAction, {
      action,
      args: args ?? {},
      mode: mode ?? "dry_run",
      reason,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_patch_plans",
  {
    title: "GTM Patch Plans",
    description: "List or inspect durable GTM patch plans awaiting review or apply.",
    inputSchema: {
      patchPlanId: z.string().optional(),
      status: z.enum(["draft", "pending_approval", "approved", "applied", "rejected", "cancelled", "failed"]).optional(),
      limit: z.number().optional(),
    },
  },
  async ({ patchPlanId, status, limit }) => {
    if (patchPlanId) {
      const result = await client().query(api.patchPlans.get, {
        patchPlanId: patchPlanId as Id<"patchPlans">,
      });
      return content(result);
    }
    const result = await client().query(api.patchPlans.list, {
      status,
      limit: limit ?? 50,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_review_patch_plan",
  {
    title: "Review GTM Patch Plan",
    description: "Approve, reject, or apply a durable GTM patch plan.",
    inputSchema: {
      patchPlanId: z.string(),
      decision: z.enum(["approve", "reject", "apply"]),
      reason: z.string().optional(),
    },
  },
  async ({ patchPlanId, decision, reason }) => {
    if (decision === "apply") {
      const result = await client().action(api.patchPlanActions.apply, {
        patchPlanId: patchPlanId as Id<"patchPlans">,
      });
      return content(result);
    }
    const result = await client().mutation(api.patchPlans.approve, {
      patchPlanId: patchPlanId as Id<"patchPlans">,
      decision: decision === "approve" ? "approved" : "rejected",
      reason,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_parse",
  {
    title: "GTM Parse",
    description: "Parse unstructured input into GTM records or preview the parse result.",
    inputSchema: {
      inputType: z.string(),
      input: z.unknown(),
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ inputType, input, mode }) => {
    const result = await client().action(api.gtm.parse, {
      inputType,
      input,
      mode: mode ?? "dry_run",
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_summary",
  {
    title: "GTM Summary",
    description: "Read the current CanonCRM operating summary.",
  },
  async () => {
    const result = await client().query(api.dashboard.summary, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_deals",
  {
    title: "CRM Deals",
    description: "List CRM-inherited deals.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ limit }) => {
    const result = await client().query(api.deals.list, {});
    return content(result.slice(0, limit ?? 50));
  },
);

server.registerTool(
  "gtm_update_deal_forecast",
  {
    title: "Preview Deal Forecast Patch",
    description:
      "Create a dry-run patch plan for a CRM-inherited deal forecast-category change. This tool does not directly mutate CRM or local deal state.",
    inputSchema: {
      dealId: z.string(),
      forecastCategory: z.enum([
        "omit",
        "pipeline",
        "best_case",
        "commit",
        "closed_won",
        "closed_lost",
      ]),
    },
  },
  async ({ dealId, forecastCategory }) => {
    const result = await client().mutation(api.gtm.set, {
      operation: "deal.forecast_category",
      args: { dealId, forecastCategory },
      mode: "dry_run",
      reason: "MCP forecast update request; routed through governed patch-plan preview.",
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_integrations",
  {
    title: "CRM Integrations",
    description: "Read CRM connection and recent sync run status.",
  },
  async () => {
    const convex = client();
    const [hubspot, salesforce, syncRuns] = await Promise.all([
      convex.query(api.hubspot.getConnection, {}),
      convex.query(api.salesforce.getConnection, {}),
      convex.query(api.integrations.listSyncRuns, { limit: 10 }),
    ]);
    return content({ hubspot, salesforce, syncRuns });
  },
);

server.registerTool(
  "gtm_calls",
  {
    title: "Call Intelligence",
    description: "List call-intelligence recordings, summary metrics, and extracted insights.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ limit }) => {
    const [summary, calls, insights] = await Promise.all([
      client().query(api.callIntelligence.summary, {}),
      client().query(api.callIntelligence.listCalls, { limit: limit ?? 100 }),
      client().query(api.callIntelligence.listInsights, { limit: limit ?? 100 }),
    ]);
    return content({ summary, calls, insights });
  },
);

server.registerTool(
  "gtm_call",
  {
    title: "Call Recording",
    description: "Inspect one call-intelligence recording by id.",
    inputSchema: {
      callId: z.string(),
    },
  },
  async ({ callId }) => {
    const call = await client().query(api.callIntelligence.getCall, {
      callId: callId as Id<"callRecordings">,
    });
    return content({ call });
  },
);

server.registerTool(
  "gtm_analyze_call",
  {
    title: "Analyze Call",
    description: "Analyze one call recording. Defaults to dry_run unless mode=apply.",
    inputSchema: {
      callId: z.string(),
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ callId, mode }) => {
    if (mode !== "apply") return content({ ok: true, dryRun: true, action: "analyzeCall", callId });
    const result = await client().mutation(api.callIntelligence.analyzeCall, {
      callId: callId as Id<"callRecordings">,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_ingest_call_transcript",
  {
    title: "Ingest Call Transcript",
    description: "Ingest a call transcript. Defaults to dry_run unless mode=apply.",
    inputSchema: {
      title: z.string(),
      transcriptText: z.string(),
      provider: z.enum(["gong", "chorus", "fathom", "avoma", "salesforce", "hubspot", "csv", "manual", "custom"]).optional(),
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ title, transcriptText, provider, mode }) => {
    const args = { title, transcriptText, provider: provider ?? "manual" };
    if (mode !== "apply") return content({ ok: true, dryRun: true, action: "ingestTranscript", args });
    const result = await client().mutation(api.callIntelligence.ingestTranscript, args);
    return content(result);
  },
);

server.registerTool(
  "gtm_propose_call_next_step_patch_plan",
  {
    title: "Propose Call Next-Step Patch Plan",
    description: "Create a deal next-step patch plan from a call insight. Defaults to dry_run unless mode=apply.",
    inputSchema: {
      insightId: z.string(),
      nextStep: z.string().optional(),
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ insightId, nextStep, mode }) => {
    if (mode !== "apply") return content({ ok: true, dryRun: true, action: "proposeDealNextStepPatchPlan", insightId, nextStep });
    const result = await client().mutation(api.callIntelligence.proposeDealNextStepPatchPlan, {
      insightId: insightId as Id<"callInsights">,
      nextStep,
    });
    return content(result);
  },
);

server.registerTool(
  "gtm_sync_call_provider",
  {
    title: "Sync Call Provider",
    description: "Import recent calls and transcripts from a connected call provider. Defaults to dry_run unless mode=apply.",
    inputSchema: {
      provider: z.enum(["gong", "chorus", "fathom", "avoma", "granola"]),
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ provider, mode }) => {
    if (mode !== "apply") return content({ ok: true, dryRun: true, action: "syncProvider", provider });
    return content(await client().action(api.callProviderActions.syncProvider, { provider }));
  },
);

server.registerTool(
  "gtm_ingest_and_analyze_demo_call",
  {
    title: "Ingest and Analyze Demo Call",
    description: "Seed demo call intelligence data. Defaults to dry_run unless mode=apply.",
    inputSchema: {
      mode: z.enum(["dry_run", "apply"]).optional(),
    },
  },
  async ({ mode }) => {
    if (mode !== "apply") return content({ ok: true, dryRun: true, action: "ingestAndAnalyzeDemo" });
    const result = await client().mutation(api.callIntelligence.ingestAndAnalyzeDemo, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_settings",
  {
    title: "Organization Settings",
    description:
      "Read organization defaults used across GTM planning, CRM inheritance, and reporting.",
  },
  async () => {
    const result = await client().query(api.organizations.current, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_update_settings",
  {
    title: "Update Organization Settings",
    description:
      "Update organization defaults used by planning, CRM inheritance, and reporting.",
    inputSchema: {
      name: z.string().optional(),
      industry: z.string().optional(),
      fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
      defaultCurrency: z.string().length(3).optional(),
      timezone: z.string().optional(),
      syncSchedule: z.enum(["daily", "weekly", "monthly"]).optional(),
      hierarchySource: z
        .enum(["salesforce", "hubspot", "csv", "manual"])
        .optional(),
    },
  },
  async (updates) => {
    const organizationId = await client().mutation(
      api.organizations.updateSettings,
      updates,
    );
    return content({ organizationId, updates });
  },
);

server.registerTool(
  "gtm_abm",
  {
    title: "ABM Lists",
    description:
      "Read ABM list stats and lists, or include accounts, candidate accounts, and plays for one list.",
    inputSchema: {
      listId: z.string().optional(),
    },
  },
  async ({ listId }) => {
    const convex = client();
    const [stats, lists] = await Promise.all([
      convex.query(api.abm.getStats, {}),
      convex.query(api.abm.listLists, {}),
    ]);
    if (!listId) return content({ stats, lists });

    const typedListId = listId as Id<"abmLists">;
    const [list, accounts, candidateAccounts, plays] = await Promise.all([
      convex.query(api.abm.getList, { listId: typedListId }),
      convex.query(api.abm.listAccounts, { listId: typedListId }),
      convex.query(api.abm.listCandidateAccounts, { listId: typedListId }),
      convex.query(api.abm.listPlays, { listId: typedListId }),
    ]);
    return content({ stats, list, accounts, candidateAccounts, plays });
  },
);

server.registerTool(
  "gtm_generate_abm",
  {
    title: "Generate ABM",
    description: "Generate or refresh CRM-derived ABM target-account lists.",
  },
  async () => {
    const result = await client().mutation(api.abm.generateFromCrm, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_lead_scoring",
  {
    title: "Lead Scoring",
    description: "Read lead scoring models, routing rules, and scored leads.",
    inputSchema: {
      modelId: z.string().optional(),
    },
  },
  async ({ modelId }) => {
    const convex = client();
    const typedModelId = modelId as Id<"leadScoringModels"> | undefined;
    const [models, scores, routingRules] = await Promise.all([
      convex.query(api.leadScoring.listModels, {}),
      convex.query(api.leadScoring.listScores, { modelId: typedModelId }),
      convex.query(api.leadScoring.listRoutingRules, {}),
    ]);
    return content({ models, scores, routingRules });
  },
);

server.registerTool(
  "gtm_generate_lead_scoring",
  {
    title: "Generate Lead Scores",
    description: "Generate or refresh CRM-derived lead scores.",
  },
  async () => {
    const result = await client().action(api.leadScoring.generateFromCrm, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_customer_health",
  {
    title: "Customer Health",
    description:
      "Read customer health configs, stats, and account scores. Optionally filter by health.",
    inputSchema: {
      health: z.enum(["healthy", "at_risk", "churning"]).optional(),
    },
  },
  async ({ health }) => {
    const convex = client();
    const [configs, stats, scores] = await Promise.all([
      convex.query(api.customerHealth.listConfigs, {}),
      convex.query(api.customerHealth.getStats, {}),
      health
        ? convex.query(api.customerHealth.listByHealth, { health })
        : convex.query(api.customerHealth.listScores, {}),
    ]);
    return content({ configs, stats, scores });
  },
);

server.registerTool(
  "gtm_generate_customer_health",
  {
    title: "Generate Customer Health",
    description: "Generate or refresh CRM-derived customer health scores.",
  },
  async () => {
    const result = await client().mutation(api.customerHealth.generateFromCrm, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_competitive",
  {
    title: "Competitive Intel",
    description:
      "Read competitors, battlecards, win/loss records, and win/loss stats.",
    inputSchema: {
      competitorId: z.string().optional(),
    },
  },
  async ({ competitorId }) => {
    const convex = client();
    const typedCompetitorId = competitorId as Id<"competitors"> | undefined;
    const [stats, competitors, battlecards, winLoss] = await Promise.all([
      convex.query(api.competitive.getWinLossStats, {}),
      convex.query(api.competitive.listCompetitors, {}),
      convex.query(api.competitive.listBattlecards, {
        competitorId: typedCompetitorId,
      }),
      convex.query(api.competitive.listWinLoss, {}),
    ]);
    return content({ stats, competitors, battlecards, winLoss });
  },
);

server.registerTool(
  "gtm_generate_competitive",
  {
    title: "Generate Competitive Intel",
    description: "Generate or refresh competitive intel from CRM deal data.",
  },
  async () => {
    const result = await client().mutation(api.competitive.generateFromDeals, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_research",
  {
    title: "Account Research",
    description:
      "Read account research enrichments, or fetch enrichment for one CRM account.",
    inputSchema: {
      accountId: z.string().optional(),
    },
  },
  async ({ accountId }) => {
    const convex = client();
    if (accountId) {
      const enrichment = await convex.query(api.research.getForAccount, {
        accountId: accountId as Id<"crmAccounts">,
      });
      return content({ enrichment });
    }
    const enrichments = await convex.query(api.research.listEnrichments, {});
    return content({ enrichments });
  },
);

server.registerTool(
  "gtm_generate_research",
  {
    title: "Generate Account Research",
    description:
      "Generate or refresh CRM-derived firmographic and signal enrichments.",
  },
  async () => {
    const result = await client().mutation(api.research.generateFromCrm, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_icp",
  {
    title: "ICP Scoring",
    description: "Read ICP profiles, scores, and top scored CRM accounts.",
    inputSchema: {
      profileId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ profileId, limit }) => {
    const convex = client();
    const typedProfileId = profileId as Id<"icpProfiles"> | undefined;
    const [profiles, scores, topAccounts] = await Promise.all([
      convex.query(api.icp.listProfiles, {}),
      convex.query(api.icp.listScores, {
        profileId: typedProfileId,
      }),
      convex.query(api.icp.getTopAccounts, { limit }),
    ]);
    return content({ profiles, scores, topAccounts });
  },
);

server.registerTool(
  "gtm_generate_icp",
  {
    title: "Generate ICP Scores",
    description: "Generate or refresh CRM-derived ICP profile and account scores.",
  },
  async () => {
    const result = await client().action(api.icp.generateFromCrm, {});
    return content(result);
  },
);

server.registerTool(
  "gtm_forecasting",
  {
    title: "Revenue Forecasting",
    description: "Read forecast rollups and rep-level forecast coverage.",
    inputSchema: {
      periodStart: z.string().optional(),
      periodEnd: z.string().optional(),
    },
  },
  async ({ periodStart, periodEnd }) => {
    const convex = client();
    const [forecast, byRep] = await Promise.all([
      convex.query(api.forecasting.getCurrentForecast, { periodStart, periodEnd }),
      convex.query(api.forecasting.getForecastByRep, { periodStart, periodEnd }),
    ]);
    return content({ periodStart: forecast.periodStart, periodEnd: forecast.periodEnd, forecast, byRep });
  },
);

server.registerTool(
  "gtm_pipeline",
  {
    title: "Pipeline",
    description: "Read open pipeline, weighted forecast categories, and target coverage.",
  },
  async () => {
    const convex = client();
    const [deals, forecast] = await Promise.all([
      convex.query(api.deals.list, {}),
      convex.query(api.forecasting.getCurrentForecast, {}),
    ]);
    const openDeals = deals.filter((deal) => !deal.isClosed);
    const categories = [
      { key: "commit", label: "Commit", weight: 0.85 },
      { key: "best_case", label: "Best Case", weight: 0.5 },
      { key: "pipeline", label: "Pipeline", weight: 0.25 },
      { key: "omit", label: "Omitted", weight: 0 },
    ].map((option) => {
      const categoryDeals = openDeals.filter(
        (deal) => (deal.forecastCategory ?? "pipeline") === option.key,
      );
      const amount = categoryDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
      return {
        ...option,
        count: categoryDeals.length,
        amount,
        weighted: Math.round(amount * option.weight),
      };
    });
    const totalPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const weighted = categories.reduce((sum, row) => sum + row.weighted, 0);
    const target = forecast?.targetAmount ?? 0;
    return content({
      summary: {
        totalPipeline,
        weighted,
        target,
        coverage: target > 0 ? totalPipeline / target : 0,
      },
      categories,
      deals: openDeals,
    });
  },
);

server.registerTool(
  "gtm_team",
  {
    title: "Team",
    description: "Read team roster, active coverage, and operating landscape context.",
  },
  async () => {
    const convex = client();
    const members = await convex.query(api.users.list, {});
    const activeMembers = members.filter((member) => member.isActive);
    const managers = activeMembers.filter(
      (member) => member.role === "admin" || member.role === "manager",
    );
    const reps = activeMembers.filter((member) => member.role === "rep");
    return content({
      summary: {
        members: members.length,
        activeMembers: activeMembers.length,
        managers: managers.length,
        reps: reps.length,
      },
      members,
    });
  },
);

server.registerTool(
  "gtm_update_team_member",
  {
    title: "Update Team Member",
    description: "Update a team member's management fields.",
    inputSchema: {
      userId: z.string(),
      name: z.string().optional(),
      title: z.string().optional(),
      role: z.enum(["admin", "manager", "rep", "other"]).optional(),
      managerId: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
    },
  },
  async ({ userId, name, title, role, managerId, isActive }) => {
    await client().mutation(api.users.update, {
      userId: userId as Id<"users">,
      name,
      title,
      role,
      managerId:
        typeof managerId === "string" ? (managerId as Id<"users">) : managerId,
      isActive,
    });
    return content({ ok: true });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CanonCRM MCP server failed: ${message}`);
  process.exit(1);
});
