type VerbSpec = { resource?: string; operation?: string; action?: string; inputType?: string; description: string };

type NounSpec = {
  noun: string;
  name: string;
  definition: string;
  requiredByDefault: boolean;
  becomesRelevantWhen: string[];
  sourceOfRecordPolicy: { default: "crm" | "convex" | "hybrid"; crm: string; convex: string; hybrid: string };
  relationships: Array<{ noun: string; relationship: string }>;
  verbs: { find: VerbSpec[]; set: VerbSpec[]; do: VerbSpec[]; parse: VerbSpec[] };
  lifecycle: string[];
  readinessSignals: string[];
};

function spec(args: NounSpec) {
  return args;
}

const crmHybrid = (noun: string) => ({
  default: "hybrid" as const,
  crm: `Use CRM-native ${noun} records when they are already the durable operator-facing source of truth.`,
  convex: `Use CanonCRM for ${noun} planning context, derived signals, agent metadata, and workflows that CRM does not model cleanly.`,
  hybrid: `Keep durable ${noun} state in CRM where possible and keep richer policy, evidence, recommendations, and cross-system metadata in CanonCRM.`,
});

const convexDefault = (noun: string) => ({
  default: "convex" as const,
  crm: `Publish selected ${noun} summaries to CRM only when operator visibility is useful.`,
  convex: `Use CanonCRM as the source of truth for ${noun} because it is a planning, workflow, or derived operating primitive.`,
  hybrid: `Mirror approved ${noun} outputs to external systems while retaining planning logic and audit metadata in CanonCRM.`,
});

export const organizationPrimitiveSpec = spec({
  noun: "organization",
  name: "Organization",
  definition: "The tenant/company operating context: fiscal calendar, currency, hierarchy, connected systems, and default policies.",
  requiredByDefault: true,
  becomesRelevantWhen: ["Always relevant; every workspace belongs to an organization."],
  sourceOfRecordPolicy: crmHybrid("organization settings"),
  relationships: [{ noun: "integration", relationship: "connected system configuration" }, { noun: "user", relationship: "members and hierarchy" }],
  verbs: {
    find: [{ resource: "organization", description: "Return organization settings, readiness, and connected-system context." }],
    set: [{ operation: "organization.settings", description: "Update fiscal, currency, timezone, sync, or hierarchy settings." }],
    do: [{ action: "organization.bootstrap", description: "Create or refresh default workspace setup." }],
    parse: [],
  },
  lifecycle: ["created", "configured", "connected", "operating"],
  readinessSignals: ["settings present", "users present", "integrations connected", "demo/local mode"],
});

export const userPrimitiveSpec = spec({
  noun: "user",
  name: "User / Revenue Member",
  definition: "A person participating in the GTM motion: rep, manager, admin, owner, approver, or plan assignee.",
  requiredByDefault: true,
  becomesRelevantWhen: ["Always relevant; users own records, receive assignments, and approve work."],
  sourceOfRecordPolicy: crmHybrid("user/owner"),
  relationships: [{ noun: "account", relationship: "owner" }, { noun: "deal", relationship: "owner" }],
  verbs: {
    find: [{ resource: "user", description: "Return team context, readiness, members, or hierarchy." }],
    set: [{ operation: "user.profile", description: "Update role, title, manager, or active status." }],
    do: [{ action: "user.bootstrap", description: "Sync/import users from connected systems or local auth context." }],
    parse: [{ inputType: "user_csv", description: "Parse users and hierarchy from CSV." }],
  },
  lifecycle: ["invited", "active", "managed", "inactive"],
  readinessSignals: ["active users", "reps", "managers", "manager coverage", "hidden/inactive users"],
});

export const integrationPrimitiveSpec = spec({
  noun: "integration",
  name: "Integration",
  definition: "A connected external system with credentials, sync configuration, run history, and provider-specific capabilities.",
  requiredByDefault: false,
  becomesRelevantWhen: ["The workspace needs CRM, call, enrichment, sequence, finance, or warehouse data."],
  sourceOfRecordPolicy: convexDefault("integration configuration"),
  relationships: [{ noun: "account", relationship: "sync source" }, { noun: "deal", relationship: "sync source" }, { noun: "call", relationship: "provider import source" }],
  verbs: {
    find: [{ resource: "integration", description: "Return connection status, readiness, and sync runs." }],
    set: [{ operation: "integration.settings", description: "Update sync schedule, mapping, or provider settings." }],
    do: [{ action: "integration.sync", description: "Run a provider sync." }, { action: "integration.disconnect", description: "Disconnect a provider." }],
    parse: [],
  },
  lifecycle: ["not_connected", "connected", "syncing", "healthy", "error", "disconnected"],
  readinessSignals: ["provider connected", "last sync", "sync errors", "record counts"],
});

export const routingPrimitiveSpec = spec({
  noun: "routing",
  name: "Routing",
  definition: "Rules, scores, and candidate assignment logic for leads, contacts, accounts, or inbound demand." ,
  requiredByDefault: false,
  becomesRelevantWhen: ["Inbound candidates, lead scores, routing rules, or assignment queues exist."],
  sourceOfRecordPolicy: crmHybrid("routing"),
  relationships: [{ noun: "contact", relationship: "candidate" }, { noun: "account", relationship: "candidate/company" }, { noun: "user", relationship: "assignee" }, { noun: "icp", relationship: "fit input" }],
  verbs: {
    find: [{ resource: "routing", description: "Return routing readiness, models, scores, or rules." }],
    set: [{ operation: "routing.model", description: "Create/update lead scoring model." }, { operation: "routing.rule", description: "Create/update routing rule." }],
    do: [{ action: "routing.bootstrap", description: "Generate lead scores and routing rules from CRM." }],
    parse: [{ inputType: "inbound_lead", description: "Parse inbound submissions into routing candidates." }],
  },
  lifecycle: ["not_relevant_yet", "model_draft", "active", "reviewed"],
  readinessSignals: ["model count", "score count", "routing rules", "unassigned candidates"],
});

export const icpPrimitiveSpec = spec({
  noun: "icp",
  name: "ICP Profile",
  definition: "Ideal customer profile criteria and derived account fit scores used for prioritization and routing.",
  requiredByDefault: false,
  becomesRelevantWhen: ["Accounts exist and the team wants fit scoring, segmentation, ABM, or routing prioritization."],
  sourceOfRecordPolicy: convexDefault("ICP"),
  relationships: [{ noun: "account", relationship: "scored object" }, { noun: "routing", relationship: "fit input" }, { noun: "abm", relationship: "target selection input" }],
  verbs: {
    find: [{ resource: "icp", description: "Return ICP readiness, profiles, scores, or top accounts." }],
    set: [{ operation: "icp.profile", description: "Create/update ICP profile." }],
    do: [{ action: "icp.score", description: "Score accounts from CRM context." }],
    parse: [{ inputType: "icp_definition", description: "Parse ICP criteria from text or CSV." }],
  },
  lifecycle: ["not_relevant_yet", "draft", "scored", "published"],
  readinessSignals: ["account count", "profile count", "score count", "default profile"],
});

export const healthPrimitiveSpec = spec({
  noun: "health",
  name: "Customer Health",
  definition: "Customer/account risk and expansion model with scored health states, drivers, and recommended action." ,
  requiredByDefault: false,
  becomesRelevantWhen: ["Customer accounts, renewals, product usage, support, or CS workflows exist."],
  sourceOfRecordPolicy: crmHybrid("customer health"),
  relationships: [{ noun: "account", relationship: "scored customer" }, { noun: "deal", relationship: "renewal/expansion risk" }],
  verbs: {
    find: [{ resource: "health", description: "Return health readiness, configs, scores, or stats." }],
    set: [{ operation: "health.model", description: "Create/update health scoring model." }],
    do: [{ action: "health.score", description: "Generate health scores from CRM context." }],
    parse: [{ inputType: "health_signal", description: "Parse health/risk signals from notes or CSV." }],
  },
  lifecycle: ["not_relevant_yet", "configured", "scored", "reviewed", "published"],
  readinessSignals: ["customer accounts", "health configs", "scores", "at-risk accounts"],
});

export const competitorPrimitiveSpec = spec({
  noun: "competitor",
  name: "Competitor",
  definition: "A competitor, alternative, battlecard, or win/loss signal used for deal strategy and market learning.",
  requiredByDefault: false,
  becomesRelevantWhen: ["Competitors are mentioned in deals, calls, notes, or win/loss analysis."],
  sourceOfRecordPolicy: convexDefault("competitive intelligence"),
  relationships: [{ noun: "deal", relationship: "competitive context" }, { noun: "call", relationship: "mention evidence" }],
  verbs: {
    find: [{ resource: "competitor", description: "Return competitive readiness, competitors, battlecards, or win/loss signals." }],
    set: [{ operation: "competitor.record", description: "Create/update competitor." }, { operation: "competitor.battlecard", description: "Create/update battlecard." }],
    do: [{ action: "competitor.bootstrap", description: "Generate competitive intel from deals/calls." }],
    parse: [{ inputType: "competitive_mention", description: "Parse competitive mentions into signals." }],
  },
  lifecycle: ["not_relevant_yet", "identified", "battlecarded", "measured"],
  readinessSignals: ["competitor count", "battlecards", "win/loss signals", "call mentions"],
});

export const researchPrimitiveSpec = spec({
  noun: "research",
  name: "Research Enrichment",
  definition: "An evidence artifact about an account, market, or prospect generated from CRM and external sources.",
  requiredByDefault: false,
  becomesRelevantWhen: ["Accounts exist and the team needs enrichment, prioritization, or account planning."],
  sourceOfRecordPolicy: convexDefault("research enrichment"),
  relationships: [{ noun: "account", relationship: "enriched object" }, { noun: "icp", relationship: "fit evidence" }],
  verbs: {
    find: [{ resource: "research", description: "Return research readiness, enrichments, or account research." }],
    set: [],
    do: [{ action: "research.enrich", description: "Generate account research enrichments." }],
    parse: [{ inputType: "research_source", description: "Parse web/page/text research into enrichment evidence." }],
  },
  lifecycle: ["not_relevant_yet", "queued", "enriched", "reviewed", "stale"],
  readinessSignals: ["account count", "enrichment count", "reviewed enrichments", "staleness"],
});

export const approvalPrimitiveSpec = spec({
  noun: "approval",
  name: "Approval",
  definition: "A human decision gate for risky GTM changes, patch plans, and external side effects.",
  requiredByDefault: false,
  becomesRelevantWhen: ["A mutation or action requires human approval by policy."],
  sourceOfRecordPolicy: convexDefault("approval workflow"),
  relationships: [{ noun: "patch_plan", relationship: "decision target" }, { noun: "user", relationship: "approver" }],
  verbs: {
    find: [{ resource: "approval", description: "Return approval readiness and workflow configuration." }],
    set: [{ operation: "approval.workflow", description: "Configure approval workflow." }, { operation: "approval.decision", description: "Record approval decision." }],
    do: [{ action: "approval.request", description: "Request approval for a patch plan or operation." }],
    parse: [],
  },
  lifecycle: ["not_required", "requested", "approved", "rejected", "expired"],
  readinessSignals: ["workflow count", "pending approvals", "high-risk operations"],
});

export const patchPlanPrimitiveSpec = spec({
  noun: "patch_plan",
  name: "Patch Plan",
  definition: "A reviewable set of proposed changes with before/after values, evidence, risk, approval requirement, and rollback guidance.",
  requiredByDefault: false,
  becomesRelevantWhen: ["Any agent or user proposes changing CRM, Convex, or third-party system state."],
  sourceOfRecordPolicy: convexDefault("patch plan"),
  relationships: [{ noun: "approval", relationship: "approval target" }, { noun: "user", relationship: "requester/apply actor" }],
  verbs: {
    find: [{ resource: "patch_plan", description: "Return patch plan readiness and previews." }],
    set: [{ operation: "patch_plan.status", description: "Update plan review/apply status." }],
    do: [{ action: "patch_plan.apply", description: "Apply an approved patch plan." }],
    parse: [],
  },
  lifecycle: ["preview", "pending_approval", "approved", "applied", "rejected", "rolled_back"],
  readinessSignals: ["pending plans", "approved plans", "high-risk operations", "audit log"],
});
