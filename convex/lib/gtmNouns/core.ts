export const accountPrimitiveSpec = {
  noun: "account",
  name: "Account",
  definition:
    "A company or buying organization that can own pipeline, contacts, health, territory assignment, plans, research, and customer lifecycle state.",
  requiredByDefault: true,
  becomesRelevantWhen: [
    "The workspace connects a CRM with companies/accounts",
    "The GTM team assigns ownership, territories, ABM tiers, account plans, or health scores",
  ],
  sourceOfRecordPolicy: {
    default: "crm",
    crm: "Use Salesforce Account or HubSpot Company as the durable source of truth whenever available.",
    convex:
      "Use CanonCRM for planning metadata, research enrichments, scoring context, coverage analytics, and agent-derived recommendations.",
    hybrid:
      "Keep operator-visible ownership and account fields in CRM; keep richer planning and agent context in CanonCRM.",
  },
  relationships: [
    { noun: "user", relationship: "owner or account team member" },
    { noun: "contact", relationship: "people at the account" },
    { noun: "deal", relationship: "pipeline and bookings" },
    { noun: "call", relationship: "account-level conversation evidence" },
    { noun: "icp", relationship: "fit scoring" },
    { noun: "health", relationship: "customer risk and expansion signal" },
  ],
  verbs: {
    find: [{ resource: "account", description: "Return account context, readiness, or records." }],
    set: [],
    do: [
      { action: "account.bootstrap", description: "Sync/import account records from the connected CRM." },
      { action: "account.enrich", description: "Generate account research enrichments." },
    ],
    parse: [{ inputType: "account_csv", description: "Parse account rows into proposed account operations." }],
  },
  lifecycle: ["not_connected", "synced", "assigned", "planned", "customer", "archived"],
  readinessSignals: ["crm connected", "account count", "ownership coverage", "open pipeline", "contact coverage"],
} as const;

export const dealPrimitiveSpec = {
  noun: "deal",
  name: "Deal / Opportunity",
  definition:
    "A revenue opportunity with stage, amount, close timing, forecast category, buying context, and execution risk.",
  requiredByDefault: true,
  becomesRelevantWhen: [
    "The workspace connects a CRM with opportunities/deals",
    "The GTM team wants pipeline inspection, forecasting, call evidence, attribution, or commissions",
  ],
  sourceOfRecordPolicy: {
    default: "crm",
    crm: "Use Salesforce Opportunity or HubSpot Deal as the durable source of truth.",
    convex:
      "Use CanonCRM for derived risk, call evidence, inspection notes, patch plans, and forecast analytics.",
    hybrid:
      "Keep stage, amount, owner, forecast category, and close date in CRM; keep agent-derived evidence and recommendations in CanonCRM.",
  },
  relationships: [
    { noun: "account", relationship: "buying organization" },
    { noun: "contact", relationship: "stakeholders and champions" },
    { noun: "user", relationship: "owner and team" },
    { noun: "call", relationship: "evidence and next-step source" },
  ],
  verbs: {
    find: [{ resource: "deal", description: "Return deal context, readiness, records, pipeline, forecast, or risks." }],
    set: [
      { operation: "deal.forecast_category", description: "Update forecast category with patch-plan governance." },
      { operation: "deal.next_step", description: "Propose or apply a next-step update from evidence." },
    ],
    do: [{ action: "deal.inspect", description: "Inspect pipeline/deal risk from CRM and call evidence." }],
    parse: [{ inputType: "deal_evidence", description: "Parse call/email evidence into proposed deal updates." }],
  },
  lifecycle: ["open", "at_risk", "commit", "closed_won", "closed_lost", "archived"],
  readinessSignals: ["CRM connected", "open pipeline", "owner coverage", "close dates", "next steps", "call evidence"],
} as const;

export const callPrimitiveSpec = {
  noun: "call",
  name: "Call",
  definition:
    "A customer or prospect conversation with participants, transcript, recording metadata, and extracted GTM evidence.",
  requiredByDefault: false,
  becomesRelevantWhen: [
    "The workspace connects Gong, Chorus, Fathom, HubSpot, or Salesforce call data",
    "The GTM team wants call evidence for deal inspection, coaching, product feedback, or CRM updates",
  ],
  sourceOfRecordPolicy: {
    default: "hybrid",
    crm: "Use CRM activities/engagements for operator-visible call records when available.",
    convex: "Use CanonCRM for transcripts, segments, insight extraction, evidence, and coaching metadata.",
    hybrid: "Keep provider/CRM call identity linked while storing structured intelligence in CanonCRM.",
  },
  relationships: [
    { noun: "deal", relationship: "deal evidence and next-step source" },
    { noun: "account", relationship: "conversation account" },
    { noun: "contact", relationship: "participants" },
    { noun: "user", relationship: "rep/host" },
  ],
  verbs: {
    find: [{ resource: "call", description: "Return call context, readiness, records, insights, or summaries." }],
    set: [
      { operation: "call.link", description: "Link a call to deal/account/contact records." },
      { operation: "call.insight_status", description: "Review, dismiss, or sync a call insight." },
    ],
    do: [
      { action: "call.import", description: "Import calls from a connected provider." },
      { action: "call.analyze", description: "Analyze a call transcript for GTM insights." },
    ],
    parse: [{ inputType: "call_transcript", description: "Parse a transcript into call segments and insights." }],
  },
  lifecycle: ["not_connected", "imported", "transcribed", "analyzed", "reviewed", "synced"],
  readinessSignals: ["provider connected", "calls imported", "transcripts available", "insights extracted", "deal linkage"],
} as const;

