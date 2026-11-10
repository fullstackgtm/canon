export type GtmSurfaceRequirement = {
  area: string;
  module: string;
  dashboard: string[];
  api: string[];
  cli: string[];
  mcp: string[];
};

export const gtmSurfaceRequirements: GtmSurfaceRequirement[] = [
  {
    area: "Operating",
    module: "Summary",
    dashboard: ["src/app/dashboard/page.tsx"],
    api: ["src/app/api/gtm/summary/route.ts"],
    cli: ["summary"],
    mcp: ["gtm_summary"],
  },
  {
    area: "Operating",
    module: "Operating Model",
    dashboard: [],
    api: ["src/app/api/gtm/operating-model/route.ts"],
    cli: ["operating-model"],
    mcp: ["gtm_operating_model"],
  },
  {
    area: "Operating",
    module: "Patch Plans",
    dashboard: [],
    api: ["src/app/api/gtm/patch-plans/route.ts", "src/app/api/gtm/mutations/route.ts"],
    cli: ["patch-plans", "mutation"],
    mcp: ["gtm_patch_plans", "gtm_review_patch_plan", "gtm_mutation_manifest", "gtm_mutation"],
  },
  {
    area: "CRM",
    module: "Integrations",
    dashboard: ["src/app/dashboard/integrations/page.tsx"],
    api: ["src/app/api/gtm/integrations/route.ts"],
    cli: ["integrations"],
    mcp: ["gtm_integrations"],
  },
  {
    area: "Revenue",
    module: "Calls",
    dashboard: [],
    api: ["src/app/api/gtm/calls/route.ts"],
    cli: ["calls"],
    mcp: ["gtm_calls", "gtm_call", "gtm_analyze_call", "gtm_ingest_call_transcript", "gtm_propose_call_next_step_patch_plan", "gtm_ingest_and_analyze_demo_call"],
  },
  {
    area: "Admin",
    module: "Settings",
    dashboard: ["src/app/dashboard/settings/page.tsx"],
    api: ["src/app/api/gtm/settings/route.ts"],
    cli: ["settings"],
    mcp: ["gtm_settings"],
  },
  {
    area: "CRM",
    module: "Team",
    dashboard: ["src/app/dashboard/settings/team/page.tsx"],
    api: ["src/app/api/gtm/team/route.ts"],
    cli: ["team"],
    mcp: ["gtm_team", "gtm_update_team_member"],
  },
  {
    area: "Revenue",
    module: "Deals",
    dashboard: ["src/app/dashboard/revenue/page.tsx"],
    api: ["src/app/api/gtm/deals/route.ts"],
    cli: ["deals"],
    mcp: ["gtm_deals"],
  },
  {
    area: "Revenue",
    module: "Pipeline",
    dashboard: ["src/app/dashboard/revenue/page.tsx"],
    api: ["src/app/api/gtm/pipeline/route.ts"],
    cli: ["pipeline"],
    mcp: ["gtm_pipeline"],
  },
  {
    area: "Revenue",
    module: "Forecasting",
    dashboard: ["src/app/dashboard/revenue/page.tsx"],
    api: ["src/app/api/gtm/forecasting/route.ts"],
    cli: ["forecasting"],
    mcp: ["gtm_forecasting"],
  },
  {
    area: "Intelligence",
    module: "Research",
    dashboard: [],
    api: ["src/app/api/gtm/research/route.ts"],
    cli: ["research"],
    mcp: ["gtm_research", "gtm_generate_research"],
  },
  {
    area: "Intelligence",
    module: "ICP",
    dashboard: [],
    api: ["src/app/api/gtm/icp/route.ts"],
    cli: ["icp"],
    mcp: ["gtm_icp", "gtm_generate_icp"],
  },
  {
    area: "Intelligence",
    module: "Lead Scoring",
    dashboard: ["src/app/dashboard/leads/page.tsx"],
    api: ["src/app/api/gtm/leads/route.ts"],
    cli: ["leads"],
    mcp: ["gtm_lead_scoring", "gtm_generate_lead_scoring"],
  },
  {
    area: "Intelligence",
    module: "ABM",
    dashboard: ["src/app/dashboard/abm/page.tsx"],
    api: ["src/app/api/gtm/abm/route.ts"],
    cli: ["abm"],
    mcp: ["gtm_abm", "gtm_generate_abm"],
  },
  {
    area: "Intelligence",
    module: "Competitive",
    dashboard: [],
    api: ["src/app/api/gtm/competitive/route.ts"],
    cli: ["competitive"],
    mcp: ["gtm_competitive", "gtm_generate_competitive"],
  },
  {
    area: "Intelligence",
    module: "Customer Health",
    dashboard: ["src/app/dashboard/health/page.tsx"],
    api: ["src/app/api/gtm/health/route.ts"],
    cli: ["health"],
    mcp: ["gtm_customer_health", "gtm_generate_customer_health"],
  },
];


export function getGtmSurfaceManifest() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    surfaces: gtmSurfaceRequirements.map((requirement) => ({
      area: requirement.area,
      module: requirement.module,
      dashboard: requirement.dashboard,
      api: requirement.api,
      cli: requirement.cli,
      mcp: requirement.mcp,
    })),
  };
}
