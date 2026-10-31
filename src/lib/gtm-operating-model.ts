export type GtmSourceOfRecord = "crm" | "convex" | "hybrid";

export type GtmSyncDirection =
  | "crm_to_convex"
  | "convex_to_crm"
  | "bidirectional"
  | "convex_only"
  | "derived";

export type GtmProviderSupport = {
  salesforce: "native" | "custom_object" | "custom_fields" | "metadata" | "limited" | "none";
  hubspot: "native" | "custom_object" | "custom_fields" | "associations" | "limited" | "none";
  convex: "table" | "derived" | "configuration";
};

export type GtmPrimitive = {
  id: string;
  name: string;
  description: string;
  sourceOfRecord: GtmSourceOfRecord;
  syncDirection: GtmSyncDirection;
  convexTables: string[];
  crmRepresentation: {
    salesforce: string;
    hubspot: string;
  };
  providerSupport: GtmProviderSupport;
  agentUseCases: string[];
  patchPlanOperations: string[];
};

export type GtmOperatingModel = {
  product: string;
  positioning: string;
  generatedFrom: string;
  version: string;
  repoBoundary: {
    slackIntake: string;
    appRepo: string;
    websiteRepo: string;
    appRepoOwns: string[];
    websiteRepoOwns: string[];
  };
  sourcePolicy: {
    crmNative: string;
    convexPlane: string;
    hybrid: string;
  };
  mutationPolicy: {
    readSafety: string;
    writeSafety: string;
    requiredPatchOperationFields: string[];
  };
  comparison: {
    comparedTo: string;
    sourceNote: string;
    summary: string;
    differentiators: string[];
  };
  surfaces: {
    cli: string;
    mcp: string;
    api: string;
    web: string;
  };
  primitives: GtmPrimitive[];
  recommendations: Array<{
    sourceOfRecord: GtmSourceOfRecord;
    guidance: string;
    primitiveIds: string[];
  }>;
};

const patchFields = [
  "id",
  "objectType",
  "objectId",
  "operation",
  "field",
  "beforeValue",
  "afterValue",
  "reason",
  "riskLevel",
  "approvalRequired",
  "sourceRuleOrPolicy",
  "rollback",
  "evidenceIds",
  "findingIds",
  "verification",
  "preconditions",
  "groupId",
];

export const gtmOperatingModel = {
  product: "CanonCRM",
  positioning:
    "Agentic GTM layer for Salesforce and HubSpot: a first-class operating model, application interface, and agent control plane for running revenue teams.",
  generatedFrom: "src/lib/gtm-operating-model.ts",
  version: "2026-05-03",
  repoBoundary: {
    slackIntake:
      "Repository boundary guidance: this operating-model registry belongs to the CanonCRM app repo; marketing-site copy, domains, and static website assets belong to the website repo.",
    appRepo: "https://github.com/fullstackgtm/fullstackgtm",
    websiteRepo: "https://github.com/ryanfsgtm/fullstackgtm-website",
    appRepoOwns: [
      "GTM operating-model registry",
      "CRM-native source-of-record and sync guidance",
      "agent patch-plan safety contracts",
      "API, CLI, MCP, and dashboard product surfaces",
    ],
    websiteRepoOwns: [
      "marketing-site copy and layout",
      "public domain and routing fixes",
      "static website assets",
      "website-only analytics and SEO changes",
    ],
  },
  sourcePolicy: {
    crmNative:
      "Use CRM-native objects, fields, metadata, and associations when the primitive is durable operational CRM state.",
    convexPlane:
      "Use Convex for planning scenarios, simulations, rich policy metadata, approval queues, agent memory, and derived analytics that CRM schemas do not model cleanly.",
    hybrid:
      "Use CRM for durable operator-visible state and Convex for agent/application metadata, policy context, simulation output, and stable cross-system identifiers.",
  },
  mutationPolicy: {
    readSafety: "Read-only inspection and explanation are safe by default.",
    writeSafety:
      "Agents must express every mutation as approval-gated, auditable patch operations before any Salesforce, HubSpot, Convex, or provider connector write executes; direct provider writes are not an agent surface.",
    requiredPatchOperationFields: patchFields,
  },
  comparison: {
    comparedTo: "Traction Complete",
    sourceNote:
      "Public Traction Complete positioning describes an Agentic Data Management Suite for Salesforce whose public homepage/navigation lists Complete Leads, Complete Hierarchies, lead routing, lead-to-account matching, account hierarchies, deduplication, relationship mapping, and mass territory reassignment; this registry avoids unverified packaging, pricing, or private feature claims.",
    summary:
      "Use TractionComplete as the Salesforce-native data-management, routing, matching, hierarchy, deduplication, relationship, and territory benchmark to validate; position CanonCRM as the broader agentic GTM operating layer for Salesforce and HubSpot.",
    differentiators: [
      "CanonCRM models the end-to-end revenue operating system, not only Salesforce-native data management, routing, assignment, territory, matching, or hierarchy workflows.",
      "The registry spans planning, budgets, headcount, performance, commissions, forecasting, intelligence, customer health, patch plans, and approvals.",
      "Agent writes are governed through explicit patch-plan operations with approval and audit requirements before connector execution.",
      "The same primitive registry is available through CLI, API, MCP, and web surfaces for deterministic agent behavior.",
    ],
  },
  surfaces: {
    cli: "Registry: npm run gtm -- operating-model [--json]. Governed operations: npm run gtm -- describe | find | set | do | parse.",
    mcp: "Registry tool: gtm_operating_model. Governed tools: gtm_describe_operations, gtm_find, gtm_set, gtm_do, gtm_parse.",
    api: "Registry endpoint: GET /api/gtm/operating-model. Governed operation endpoint: /api/gtm/ops.",
    web: "Dashboard modules use module-specific views backed by the canonical Convex gtm.find/set/do/parse operation layer and patch-plan review queue.",
  },
  primitives: [
    primitive("organization", "Organization", "Tenant-level fiscal, currency, hierarchy, and sync defaults.", "hybrid", "bidirectional", ["organizations", "integrations"], "Account/company settings, custom metadata, fiscal year settings.", "Company properties and private app settings.", { salesforce: "metadata", hubspot: "custom_fields", convex: "table" }, ["explain operating defaults", "detect missing sync configuration"], ["update organization settings", "sync metadata"]),
    primitive("user", "User / rep / manager", "Revenue-team member, role, manager, hierarchy, and active status.", "hybrid", "bidirectional", ["users", "teamGroups"], "User records, roles, manager fields, territory associations.", "Owners/users plus custom properties or associations.", { salesforce: "native", hubspot: "native", convex: "table" }, ["inspect team coverage", "detect hierarchy gaps"], ["update role", "update manager", "deactivate user"]),
    primitive("crm_account", "CRM account/contact/deal/activity", "Canonical CRM objects inherited from Salesforce or HubSpot.", "crm", "crm_to_convex", ["crmAccounts", "crmContacts", "deals", "activityLog", "activityMetrics"], "Account, Contact, Opportunity, Task/Event.", "Company, Contact, Deal, Engagement.", { salesforce: "native", hubspot: "native", convex: "table" }, ["inspect CRM state", "detect hygiene and coverage gaps"], ["update CRM field", "link record", "refresh sync"]),
    primitive("account_assignment", "Account assignment", "Ownership and coverage assignment for accounts.", "hybrid", "bidirectional", ["crmAccounts", "territoryAssignments"], "OwnerId, account team, territory assignment objects.", "Company owner, teams, custom association objects.", { salesforce: "native", hubspot: "native", convex: "table" }, ["route accounts", "audit unowned accounts"], ["assign account owner", "clear account owner"]),
    primitive("territory", "Territory", "Territory definitions, rules, assignments, and ownership coverage.", "hybrid", "bidirectional", ["territories", "territoryAssignments", "territoryRules"], "Enterprise Territory Management or custom Territory objects.", "Custom objects/properties and company-owner rules.", { salesforce: "native", hubspot: "custom_object", convex: "table" }, ["explain territory model", "detect overlapping rules"], ["change territory owner", "update territory rule"]),
    primitive("quota_plan", "Quota plan", "Quota plan header and period structure.", "hybrid", "bidirectional", ["quotaPlans", "quotaPlanTargets", "quotaProgress"], "Forecasting quotas or custom quota objects.", "Custom objects/properties; limited native quota support.", { salesforce: "native", hubspot: "custom_object", convex: "table" }, ["inspect quota coverage", "simulate target changes"], ["create quota plan", "activate quota plan"]),
    primitive("quota_target", "Quota target", "Rep, team, or territory target for a period.", "hybrid", "bidirectional", ["quotaPlanTargets", "quotaProgress"], "Quota records or custom target object linked to user/territory.", "Custom quota target object linked to owner/team.", { salesforce: "native", hubspot: "custom_object", convex: "table" }, ["identify reps without quota", "compare quota to capacity"], ["create quota target", "update target amount"]),
    primitive("capacity_model", "Capacity model", "Ramp, attainment, productivity, and hiring capacity assumptions.", "convex", "convex_only", ["capacityModels"], "Usually not cleanly native; optional summary fields.", "Usually not cleanly native; optional custom object summaries.", { salesforce: "limited", hubspot: "limited", convex: "table" }, ["simulate plan capacity", "explain hiring requirements"], ["save capacity model"]),
    primitive("planning_scenario", "Planning scenario", "Versioned what-if model for targets, headcount, quota, and capacity.", "convex", "convex_only", ["planningScenarios"], "Optional custom object snapshot only after promotion.", "Optional custom object snapshot only after promotion.", { salesforce: "limited", hubspot: "limited", convex: "table" }, ["simulate scenarios", "compare options"], ["promote planning scenario", "archive scenario"]),
    primitive("forecast", "Forecast", "Forecast rollups, categories, coverage, and period projections.", "hybrid", "derived", ["deals", "quotaPlanTargets"], "Opportunity forecast categories and Collaborative Forecasts.", "Deal stage/category properties and forecast reports.", { salesforce: "native", hubspot: "custom_fields", convex: "derived" }, ["explain forecast", "detect category drift"], ["update forecast category"]),
    primitive("pipeline_stage_definition", "Pipeline stage definition", "Canonical stage, probability, and forecast-category mapping.", "hybrid", "bidirectional", ["pipelineStageConfigs"], "Opportunity stages, sales process metadata.", "Deal pipelines and stages.", { salesforce: "metadata", hubspot: "native", convex: "table" }, ["map CRM stages", "detect inconsistent probabilities"], ["sync pipeline stage metadata"]),
    primitive("budget", "Budget", "Operating budgets and line items for GTM planning.", "convex", "convex_only", ["budgets", "budgetLineItems"], "Custom budget objects if finance wants CRM visibility.", "Custom budget objects if finance wants CRM visibility.", { salesforce: "custom_object", hubspot: "custom_object", convex: "table" }, ["inspect spend plan", "compare budget to headcount"], ["create budget", "update budget line"]),
    primitive("headcount_plan", "Headcount plan", "Role, timing, cost, approval, and hiring requests.", "hybrid", "convex_to_crm", ["headcountReqs"], "Custom object or integration to HRIS/approval workflow.", "Custom object or ticket/workflow integration.", { salesforce: "custom_object", hubspot: "custom_object", convex: "table" }, ["explain hiring plan", "detect capacity gaps"], ["create headcount request", "approve headcount"]),
    primitive("commission_plan", "Commission plan", "Compensation plan, rules, assignments, and exclusions.", "convex", "convex_only", ["commissionPlans", "planRules", "planAssignments", "planRuleExclusions"], "Custom objects possible, but rule logic usually belongs outside CRM.", "Custom objects possible, but rule logic usually belongs outside CRM.", { salesforce: "custom_object", hubspot: "custom_object", convex: "table" }, ["explain comp plan", "audit assignment coverage"], ["assign commission plan", "update plan rule"]),
    primitive("commission_statement", "Commission statement", "Rep-facing commission results, line items, and approval state.", "hybrid", "convex_to_crm", ["statements", "commissionLineItems", "payPeriods"], "Custom statement objects or external comp-system links.", "Custom statement objects or external comp-system links.", { salesforce: "custom_object", hubspot: "custom_object", convex: "table" }, ["explain payout", "detect statement exceptions"], ["approve statement", "adjust line item"]),
    primitive("lead_scoring_model", "Lead scoring model", "Scoring rules, lead scores, and routing rules.", "hybrid", "bidirectional", ["leadScoringModels", "leadScores", "routingRules"], "Lead score fields, assignment rules, campaign metadata.", "Lead score properties, workflows, lists.", { salesforce: "custom_fields", hubspot: "native", convex: "table" }, ["explain routing", "detect stale scoring"], ["update score model", "sync routing rule"]),
    primitive("icp_profile", "ICP profile", "Ideal-customer profile criteria and account fit scores.", "hybrid", "convex_to_crm", ["icpProfiles", "icpScores"], "Account fit fields or custom ICP profile objects.", "Company fit properties or custom objects.", { salesforce: "custom_fields", hubspot: "custom_fields", convex: "table" }, ["score accounts", "explain ICP fit"], ["publish ICP score", "update ICP profile"]),
    primitive("abm_list", "ABM list", "Target account list, membership, and plays.", "hybrid", "bidirectional", ["abmLists", "abmListAccounts", "abmPlays"], "Campaigns, account lists, or custom ABM objects.", "Active/static lists, campaigns, custom objects.", { salesforce: "custom_object", hubspot: "native", convex: "table" }, ["inspect target account coverage", "recommend plays"], ["add account to ABM list", "launch ABM play"]),
    primitive("attribution_model", "Attribution model", "Campaign, touchpoint, and revenue attribution rules/results.", "hybrid", "derived", ["campaigns", "touchpoints"], "Campaign Influence plus custom attribution metadata.", "Campaigns, ads/events, custom attribution properties.", { salesforce: "native", hubspot: "native", convex: "derived" }, ["explain source impact", "compare attribution methods"], ["sync attribution result"]),
    primitive("customer_health_profile", "Customer health profile", "Health configuration, account health scores, and risk state.", "hybrid", "convex_to_crm", ["customerHealthConfigs", "customerHealthScores"], "Account health fields or custom customer health object.", "Company health score properties or custom object.", { salesforce: "custom_fields", hubspot: "custom_fields", convex: "table" }, ["detect churn risk", "explain health drivers"], ["publish health score", "update health config"]),
    primitive("playbook", "Playbook", "Sales, onboarding, expansion, or operational playbooks and sections.", "convex", "convex_to_crm", ["playbooks", "playbookSections"], "Sales cadences, enablement links, or custom playbook object.", "Sequences, playbooks, snippets, or custom object.", { salesforce: "limited", hubspot: "native", convex: "table" }, ["recommend next actions", "explain process"], ["create playbook", "publish playbook"]),
    primitive("onboarding_ramp_plan", "Onboarding/ramp plan", "Rep ramp expectations, milestones, and progress.", "convex", "convex_only", ["onboardingPlans", "onboardingProgress"], "Custom onboarding objects if CRM visibility is required.", "Custom onboarding objects if CRM visibility is required.", { salesforce: "custom_object", hubspot: "custom_object", convex: "table" }, ["track ramp", "detect ramp risk"], ["create ramp plan", "update ramp milestone"]),
    primitive("executive_dashboard_metric", "Executive dashboard metric", "Derived operating metrics for executive reporting.", "convex", "derived", ["deals", "quotaPlanTargets", "activityMetrics", "customerHealthScores"], "Reports/dashboards can mirror selected metrics.", "Reports/dashboards can mirror selected metrics.", { salesforce: "limited", hubspot: "limited", convex: "derived" }, ["summarize GTM state", "explain metric movement"], ["publish metric snapshot"]),
    primitive("call_intelligence", "Call intelligence", "Call recordings, transcripts, parsed speaker turns, and GTM insights linked to deals, accounts, contacts, and reps.", "hybrid", "derived", ["callRecordings", "callTranscriptSegments", "callInsights", "callInsightTags"], "Tasks/Events, Opportunity notes, custom call insight objects, and approved field updates.", "Engagements/calls, notes, custom objects, and approved property updates.", { salesforce: "custom_object", hubspot: "associations", convex: "table" }, ["extract pain points and objections", "summarize next steps", "surface deal risks", "prepare CRM patch plans from call evidence"], ["ingest transcript", "extract call insights", "propose CRM field updates"]),
    primitive("patch_plan", "Patch plan / proposed change", "Durable reviewable plan of typed operations before any mutation.", "convex", "convex_only", ["patchPlans", "patchOperations", "operationAuditLog"], "Not recommended as CRM-native except final audit logs and approved field updates.", "Not recommended as CRM-native except final audit logs and approved property updates.", { salesforce: "limited", hubspot: "limited", convex: "table" }, ["propose changes", "prepare rollback", "audit approved CRM writes"], ["create patch plan", "approve patch plan", "apply approved operation"]),
    primitive("approval", "Approval / decision point", "Human decision record for risky changes and workflow gates.", "convex", "convex_only", ["approvalWorkflows", "approvalRequests"], "Optional approval objects or tasks for visibility.", "Optional tickets/tasks/workflows for visibility.", { salesforce: "custom_object", hubspot: "limited", convex: "table" }, ["request human decision", "block unsafe write"], ["request approval", "record decision"]),
  ],
  recommendations: [
    {
      sourceOfRecord: "crm",
      guidance:
        "Keep canonical CRM records and fields in Salesforce or HubSpot, then sync read models into Convex for agent reasoning.",
      primitiveIds: ["crm_account"],
    },
    {
      sourceOfRecord: "hybrid",
      guidance:
        "Use CRM for operator-visible durable state and Convex for policy context, richer metadata, simulations, and cross-module reasoning.",
      primitiveIds: ["organization", "user", "account_assignment", "territory", "quota_plan", "quota_target", "forecast", "pipeline_stage_definition", "headcount_plan", "commission_statement", "lead_scoring_model", "icp_profile", "abm_list", "attribution_model", "customer_health_profile", "call_intelligence"],
    },
    {
      sourceOfRecord: "convex",
      guidance:
        "Keep complex planning, compensation logic, patch plans, approvals, and derived executive metrics in CanonCRM's Convex data plane.",
      primitiveIds: ["capacity_model", "planning_scenario", "budget", "commission_plan", "playbook", "onboarding_ramp_plan", "executive_dashboard_metric", "patch_plan", "approval"],
    },
  ],
} satisfies GtmOperatingModel;

function primitive(
  id: string,
  name: string,
  description: string,
  sourceOfRecord: GtmSourceOfRecord,
  syncDirection: GtmSyncDirection,
  convexTables: string[],
  salesforce: string,
  hubspot: string,
  providerSupport: GtmProviderSupport,
  agentUseCases: string[],
  patchPlanOperations: string[],
): GtmPrimitive {
  return {
    id,
    name,
    description,
    sourceOfRecord,
    syncDirection,
    convexTables,
    crmRepresentation: { salesforce, hubspot },
    providerSupport,
    agentUseCases,
    patchPlanOperations,
  };
}

export function getGtmOperatingModel(): GtmOperatingModel {
  return gtmOperatingModel;
}

export function getGtmStorageRecommendations() {
  return gtmOperatingModel.recommendations;
}
