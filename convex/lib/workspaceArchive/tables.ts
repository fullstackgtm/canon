/**
 * Every Convex table, classified for moving one workspace between deployments (docs/self-hosting.md, "Export a
 * workspace"). An archive carries only `data` and `ledger` tables: the authoritative state a later import replays
 * through the app's own writers. Everything else is rebuilt there (`derived`), belongs to the deployment that holds it
 * (`local`), only works with that deployment's keys (`secret`), says who may sign in (`identity`), or is shared by every
 * workspace (`global`). Canon's operator tables are classified by convex/lib/operatorTables.ts, which the public
 * export leaves out together with them. tests/workspaceArchive.test.ts fails while a schema table is unclassified.
 *
 * Pure: no imports.
 */

/**
 * How one table's rows belong to a workspace.
 * - `org`: `field` (default `orgId`) equals the workspace id, read through `index`, whose first field it is.
 * - `parent`: the rows of `parent` rows the archive exports, read through `index`, whose first field is `via`. With
 *   `andOrg`, the index's second field is `orgId`, for a parent (a member) whose rows span workspaces.
 * - `self`: the workspace's own `organizations` row.
 * - `members`: the workspace's members, home and through `orgMemberships`.
 * - `needsIndex`: no index reaches the workspace's rows; left out of archives until `index` exists.
 */
export type ArchiveScope =
  | { by: "org"; index: string; field?: string }
  | { by: "parent"; parent: string; via: string; index: string; andOrg?: true }
  | { by: "self" }
  | { by: "members" }
  | { by: "needsIndex"; index: string };

export type ArchiveEntry =
  /** `codeFiles`: the stored files its rows name are code (a module's or recipe's bundle), which an archive never carries. */
  | { class: "data" | "ledger"; scope: ArchiveScope; omit?: readonly string[]; pick?: readonly string[]; codeFiles?: true }
  | { class: "derived"; rebuiltBy: string }
  | { class: "local" | "secret" | "identity" | "global"; why?: string };

export type ArchiveClass = ArchiveEntry["class"];

const data = (index: string, field?: string): ArchiveEntry => ({ class: "data", scope: { by: "org", index, ...(field ? { field } : {}) } });
const withCode = (index: string): ArchiveEntry => ({ class: "data", scope: { by: "org", index }, codeFiles: true });
const ledger = (index: string): ArchiveEntry => ({ class: "ledger", scope: { by: "org", index } });
const child = (parent: string, via: string, index: string, andOrg?: true): ArchiveEntry => ({ class: "data", scope: { by: "parent", parent, via, index, ...(andOrg ? { andOrg } : {}) } });
const derived = (rebuiltBy: string): ArchiveEntry => ({ class: "derived", rebuiltBy });
const local = (why?: string): ArchiveEntry => ({ class: "local", ...(why ? { why } : {}) });
const secret = (why: string): ArchiveEntry => ({ class: "secret", why });
const identity = (why: string): ArchiveEntry => ({ class: "identity", why });
const global = (why: string): ArchiveEntry => ({ class: "global", why });

const MEMBER_FIELDS = ["email", "name", "role", "managerId", "title", "department", "isActive", "startDate", "endDate"] as const;

export const ARCHIVE_TABLES = {
  // Sign-in, billing and the Clerk mapping stay with the deployment that issued them.
  organizations: {
    class: "data", scope: { by: "self" },
    omit: ["clerkOrgId", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionStatus", "stripePriceId", "stripeCurrentPeriodEnd", "stripeCancelAtPeriodEnd",
      "creditBalanceMicro", "creditUnit", "freeCreditsMonth", "freeCreditsUsedMicro", "metronomeCustomerId", "metronomeContractId", "planTier"],
  },
  recipeRevisions: data("by_orgId_and_recipeId_and_revision"),
  recipeMarkdownRevisions: withCode("by_orgId_and_recipeId_and_revision"),
  recipePackages: withCode("by_orgId_and_recipeId"),
  recipeEnablements: data("by_orgId_and_point_and_enabled"),
  pageEditAttempts: local("a log of how the page editor routed each request"),
  githubRecipeConnections: local("an installation of this deployment's GitHub App; the other deployment connects its own"),
  githubRecipeSetupStates: local(),
  moduleInterfaceOwners: data("by_orgId_and_moduleId"),
  // A private module's bundle must never leave in an archive; no module's code installs from one.
  modulePackages: withCode("by_orgId_and_moduleId"),
  moduleActivityHeads: local(),
  moduleActivityPublications: derived("publishing each installed module's activity again from moduleDocs"),
  moduleActivityDescriptors: derived("publishing each installed module's activity again from moduleDocs"),
  moduleActivityChunks: derived("publishing each installed module's activity again from moduleDocs"),
  moduleActivityEvidence: derived("publishing each installed module's activity again from moduleDocs"),
  moduleActivityJournal: derived("publishing each installed module's activity again from moduleDocs"),
  moduleActivityCursors: local(),
  moduleManifests: local("the manifest of an upgrade in progress; finish or cancel the upgrade before exporting"),
  moduleDocs: data("by_orgId_moduleId_collection_key"),
  moduleEvents: data("by_orgId_moduleId_collection_key_at"),
  moduleShareGrants: secret("share links are verified against token hashes the visitor's link carries"),
  moduleVisitors: secret("visitor sessions are hashed bearer sessions"),
  moduleVisitCodes: secret("one-time visit codes are hashed bearer codes"),
  moduleRateLimits: local(),
  // Files people put in module docs, with their bytes (cli/workspaceArchive.ts). An upload ticket's secret and a
  // visitor's upload session (a share grant's, which never moves) stay behind.
  moduleFiles: { class: "data", scope: { by: "org", index: "by_orgId" }, omit: ["secret", "visitorUpload"] },
  moduleJobs: local(),
  moduleSnapshots: data("by_orgId_moduleId_snapshot_page"),
  moduleCursors: local(),
  moduleAiRuns: data("by_orgId_userId_at"),
  // A module's rows an import held until the module is installed here: the workspace's data, so they move again.
  moduleHeldRows: data("by_orgId_and_moduleId"),
  moduleGrants: secret("a grant's signature is an HMAC under this deployment's key over its own id"),
  moduleGrantUses: secret("each use's digest binds it to its grant's signature"),
  notifications: data("by_orgId_userId_at"),
  notificationEmail: data("by_orgId_and_userId_and_moduleId"),
  creditLedger: local("credits are sold and spent on the deployment that bills them"),
  users: { class: "data", scope: { by: "members" }, pick: MEMBER_FIELDS },
  localCredentials: identity("password hashes"),
  localSessions: identity("signed-in sessions"),
  localInvites: identity("invitation links"),
  devActAs: identity("a local stack's signed-in-as switch"),
  orgMemberships: identity("read into the users section's roles"),
  teamGroups: data("by_orgId"),
  orgRoles: data("by_orgId_and_key"),
  rolePermissions: data("by_orgId_and_role"),
  accessPreviews: local(),
  freeFillRuns: local(),
  enrichmentMatches: derived("the next free fill coverage check"),
  fieldConsolidations: data("by_orgId"),
  fieldConsolidationRuns: child("fieldConsolidations", "consolidationId", "by_consolidationId_and_createdAt"),
  fieldConsolidationWrites: child("fieldConsolidationRuns", "runId", "by_runId_and_status"),
  fieldConsolidationProfiles: child("fieldConsolidations", "consolidationId", "by_consolidationId_and_object"),
  hierarchySettings: data("by_orgId"),
  hierarchyScans: data("by_orgId"),
  hierarchyGroups: child("hierarchyScans", "scanId", "by_scanId_and_rank"),
  hierarchyResearch: child("hierarchyScans", "scanId", "by_scanId"),
  hierarchyDecisions: data("by_orgId_and_itemKey"),
  parentDisagreements: data("by_orgId_and_accountId_and_crmRef"),
  crmDisagreementJobs: local("an admin's job using a CRM's values, and its progress"),
  integrations: secret("CRM OAuth tokens encrypted with this deployment's key"),
  connectorLinks: secret("connector signing secrets encrypted with this deployment's key"),
  connectorFeedGrants: local("grants on connector links, which stay with this deployment"),
  feedItems: data("by_orgId_and_feed_and_itemId"),
  feedLog: local("each feed's change log, read by its consumers' cursors; the items' latest state is in feedItems"),
  objectDefinitions: derived("the next CRM describe"),
  fieldDefinitions: derived("the next Salesforce describe"),
  sfSyncState: local(),
  sfConflicts: local("conflicts with the connected Salesforce org, which stays with this deployment"),
  integrationSyncRuns: local(),
  crmImports: local(),
  oauthStates: secret("OAuth states and device-code hashes"),
  cliAuthRequests: secret("device-code hashes for CLI pairing"),
  cliTokens: secret("CLI token hashes"),
  agentConnections: identity("which OAuth clients signed in as a member"),
  chatgptAuth: secret("ChatGPT tokens encrypted with this deployment's key"),
  acquisitionCheckpoints: local("traversal checkpoints for paired CLIs"),
  cliArtifacts: data("by_org_kind_key"),
  cliArtifactRevisions: data("by_orgId_and_artifactId_and_createdAt"),
  cliArtifactDrafts: data("by_orgId_and_artifactId"),
  agentRegistrations: identity("self-registered agent tokens and their claims"),
  // Written only by CRM syncs and the seed: the next sync rewrites them, and the companies and people move as ledger streams.
  crmAccounts: derived("the next CRM sync"),
  crmContacts: derived("the next CRM sync"),
  // Deal ids are referenced from commissions, calls, plays and patch plans, and the row carries the pipeline state readers use.
  deals: data("by_orgId"),
  dealContacts: child("deals", "dealId", "by_dealId"),
  dealChats: data("by_orgId_streamId"),
  dealChatMessages: child("dealChats", "chatId", "by_chatId"),
  dealPlays: data("by_orgId_and_streamId"),
  dealProspectRankings: data("by_orgId_and_streamId"),
  dealPlayItems: child("dealPlays", "playId", "by_playId"),
  dealPlayPeople: child("dealPlays", "playId", "by_playId_and_contactId"),
  dealPlaySteps: child("dealPlays", "playId", "by_playId"),
  dealOverrides: data("by_orgId"),
  commissionPlans: data("by_orgId"),
  planRules: data("by_orgId"),
  planAssignments: data("by_orgId"),
  planRuleExclusions: child("planRules", "ruleId", "by_ruleId"),
  payPeriods: data("by_orgId"),
  commissionLineItems: data("by_orgId"),
  statements: data("by_orgId"),
  quotaProgress: data("by_orgId"),
  territories: data("by_orgId"),
  territoryAssignments: data("by_orgId"),
  territoryRules: data("by_orgId"),
  quotaPlans: data("by_orgId"),
  quotaPlanTargets: data("by_orgId"),
  targetPlans: data("by_orgId_and_year"),
  capacityModels: data("by_orgId"),
  planningScenarios: data("by_orgId"),
  pipelineStageConfigs: data("by_orgId"),
  dealPipelines: data("by_orgId"),
  approvalWorkflows: data("by_orgId"),
  callRecordings: data("by_orgId"),
  callTranscriptSegments: data("by_orgId"),
  callInsights: data("by_orgId"),
  callInsightTags: data("by_orgId"),
  callSuggestions: data("by_orgId_and_userId_and_status"),
  calendarEventLinks: local("which calendar event each meeting came from; the member's calendar links them again"),
  patchPlans: data("by_orgId"),
  patchOperations: data("by_orgId"),
  approvalRequests: data("by_orgId"),
  operationAuditLog: data("by_orgId"),
  gtmPlans: data("by_orgId"),
  budgets: data("by_orgId"),
  budgetLineItems: data("by_orgId"),
  headcountReqs: data("by_orgId"),
  icpProfiles: data("by_orgId"),
  icpScores: data("by_orgId"),
  icpVersions: data("by_orgId_and_version"),
  fitReconciliations: data("by_orgId"),
  icps: data("by_orgId"),
  icpNodes: data("by_orgId"),
  scorecardConfigs: data("by_orgId"),
  scorecardResults: data("by_orgId"),
  accountEnrichments: data("by_orgId"),
  competitors: data("by_orgId"),
  battlecards: data("by_orgId"),
  winLossRecords: data("by_orgId"),
  leadScoringModels: data("by_orgId"),
  leadScores: data("by_orgId"),
  routingRules: data("by_orgId"),
  abmLists: data("by_orgId"),
  abmListAccounts: data("by_orgId"),
  abmPlays: data("by_orgId"),
  campaigns: data("by_orgId"),
  touchpoints: data("by_orgId"),
  playbooks: data("by_orgId"),
  playbookSections: data("by_orgId"),
  customerHealthConfigs: data("by_orgId"),
  customerHealthScores: data("by_orgId"),
  onboardingPlans: data("by_orgId"),
  onboardingProgress: data("by_orgId"),
  activityMetrics: data("by_orgId"),
  activityBenchmarks: data("by_orgId"),
  partners: data("by_orgId"),
  partnerDeals: data("by_orgId"),
  compBenchmarks: data("by_orgId"),
  compPlanAnalysis: data("by_orgId"),
  cliRuns: local("the CLI run timeline"),
  // The Home health trend's history; a new deployment cannot recapture past readings.
  healthSnapshots: data("by_orgId_at"),
  // Not a CRM mirror: the hygiene audit's findings, whose planned and dismissed states are people's decisions.
  crmOpportunities: data("by_orgId_rule"),
  marketMaps: data("by_orgId"),
  marketCaptures: child("marketMaps", "mapId", "by_mapId"),
  marketClassifications: child("marketMaps", "mapId", "by_mapId"),
  marketRuns: data("by_orgId"),
  researchSessions: global("anonymous pre-signup research, copied into the workspace when claimed"),
  researchWaitlist: global("anonymous waitlist sign-ups"),
  researchFailures: local("a failure log"),
  tamSegments: data("by_orgId_and_key"),
  marketFacets: global("company counts shared by every workspace"),
  tamJobs: local(),
  tamSuggestionRuns: data("by_orgId_and_createdAt"),
  icpChallengeRuns: data("by_orgId_and_createdAt"),
  tamSiteTexts: global("public homepage text shared by every workspace"),
  companyWebFacts: global("public website facts shared by every workspace"),
  emailDomainPatterns: global("public email patterns shared by every workspace"),
  companyPeopleRuns: local(),
  marketSources: global("public market sources shared by every workspace"),
  marketSourceSearches: data("by_orgId_and_startedAt"),
  marketSourceMemberships: data("by_orgId"),
  tamInvestigations: data("by_orgId_and_createdAt"),
  tamCandidates: data("by_orgId_and_keys_domain_and_state"),
  webPeopleSuppressions: global("public people suppressions shared by every workspace"),
  companyWebFactReads: global("public website reads shared by every workspace"),
  agents: data("by_orgId_and_slug"),
  agentWebhooks: secret("webhook signing secrets encrypted with this deployment's key"),
  recordWebhookEndpoints: secret("webhook endpoints carry their signing secret"),
  recordWebhookDeliveries: local(),
  apiIdempotencyKeys: local("a create's answer for its retries, kept a day"),
  automationRules: data("by_orgId_and_status"),
  automationVersions: data("by_orgId_and_status"),
  automationCursors: local(),
  automationRuns: local("each rule's executions and their leases"),
  agentTurns: child("agents", "agentId", "by_agentId_and_createdAt"),
  agentGrants: secret("a grant's signature is an HMAC under this deployment's key over its own id"),
  agentGrantApprovals: secret("each approval's digest binds it to its grant's signature"),
  researchAgents: data("by_orgId_and_slug"),
  piPrototypeLeases: local(),
  piPrototypeCommits: local(),
  // A Pi run's step journal: its landed answers are proposed facts, which the archive carries.
  piResearchSteps: local("a run's execution journal; its answers move as facts"),
  piResearchEffects: local("a run's execution journal; its answers move as facts"),
  researchRuns: data("by_orgId_and_createdAt"),
  researchPages: data("by_orgId_and_url"),
  researchTraces: child("researchRuns", "runId", "by_runId"),
  researchAttempts: child("researchAgents", "agentId", "by_agentId_and_entityId"),
  signalWatch: local(),
  signalBoards: local("a cache of each domain's job board"),
  accountSignals: data("by_orgId_and_domain_and_trigger"),
  observations: ledger("by_orgId_subjectDomain_observedAt"),
  observationHeads: derived("replaying observations"),
  // The proposals and decisions behind field values, and the only place `verification` lives.
  facts: data("by_orgId_status"),
  canonFieldOwnership: data("by_orgId"),
  crmFieldFollows: data("by_orgId"),
  canonAutoAcceptRules: data("by_orgId"),
  canonEntities: ledger("by_orgId_projectionId"),
  canonExternalIds: ledger("by_orgId_provider_externalId"),
  recordMerges: ledger("by_orgId_and_mergeId"),
  duplicateDismissals: ledger("by_orgId_object_pair"),
  canonFieldState: derived("resolving facts"),
  partyMirrorQueue: local(),
  partyMirrorFailures: local(),
  partyMirrorDrains: local(),
  canonOutboundShadow: derived("resolving facts"),
  objectDefs: ledger("by_orgId_apiName"),
  ledgerEntries: ledger("by_orgId_shard_seq"),
  ledgerShardHeads: derived("replaying ledgerEntries"),
  dealVersions: derived("folding the deal streams"),
  dealVersionCursors: derived("folding the deal streams"),
  recordRows: derived("folding the streams"),
  associations: derived("folding the streams"),
  proposalQueue: derived("folding the streams"),
  savedViews: data("by_orgId_object_createdBy"),
  reports: data("by_orgId_createdBy"),
  dashboards: data("by_orgId_createdBy"),
  audiences: data("by_orgId"),
  audienceMembers: child("audiences", "audienceId", "by_audienceId_at"),
  audienceRuns: child("audiences", "audienceId", "by_audienceId_at_target"),
  audienceAdditions: child("audiences", "audienceId", "by_audienceId_and_contactId"),
  linkedinAccounts: local("senders connected through this deployment's Unipile account"),
  linkedinCadences: data("by_orgId"),
  linkedinEnrollments: data("by_orgId_and_contactId"),
  linkedinActivity: local("a cache of posts a sender saw"),
  linkedinSends: local("sending caps and acceptance per connected sender, which stays"),
  conversations: data("by_orgId"),
  conversationMessages: data("by_orgId_and_externalMessageId"),
  conversationContacts: data("by_orgId_and_contactId"),
  emailAccounts: local("mailboxes connected through this deployment's Unipile account"),
  emailLogAddresses: secret("a private logging address's token alone lets mail into the workspace; members make new ones here"),
  emailLogKeys: local("dedupe keys for logged email; the logged messages move as observations"),
  emailSends: data("by_orgId_and_contactId"),
  sequenceRecipientChecks: local(),
  sequenceLaunches: data("by_orgId_and_moduleId_and_moduleSequenceKey"),
  sequenceEnrollments: data("by_orgId_and_moduleId_and_moduleEnrollmentKey"),
  outboxRequests: local(),
  mailboxSendGrants: secret("a mailbox owner's consent is signed under this deployment's key"),
  suppressions: data("by_orgId_and_kind_and_value_and_source"),
  suppressionEvents: data("by_orgId_and_at"),
  suppressionMigrations: local(),
  outboundMessages: local("the send queue; its rows carry unsubscribe tokens"),
  outboundTargets: secret("endpoints carry their signing secret"),
  outboundChannels: local("channels on outbound targets, which stay with this deployment"),
  dialerNumbers: local("numbers on this deployment's Telnyx account"),
  dialerSessions: local(),
  dialerCalls: data("by_orgId_and_contactId"),
  recordingPolicy: data("by_orgId"),
  dialerSettings: data("by_orgId"),
  dialerDoNotCall: data("by_orgId_and_number"),
  dialerCredentials: secret("telephony credentials"),
  dialerProfiles: child("users", "userId", "by_userId_and_orgId", true),
  dialerQueueItems: local(),
  backgroundJobs: local(),
  csvUploads: local(),
  emailLookups: local(),
  providerCalls: local("metered provider calls billed by this deployment"),
  providerPacing: global("vendor rate limits shared by every workspace"),
  providerTests: local(),
  companyNames: global("company names shared by every workspace"),
  populateDone: local(),
  populateNames: local(),
  stagedRuns: local("a fill held for review belongs to the run that staged it; run the fill again after import"),
  stagedRecords: local("a fill held for review belongs to the run that staged it"),
  stagedCells: local("a fill held for review belongs to the run that staged it"),
  researchRateLimits: global("anonymous research rate limits"),
  orgOnboardingSteps: data("by_orgId_stepId"),
  // The record service's stand-in while RECORD_SERVICE_URL is unset: then these rows are the workspace's register.
  fakeRecordAccounts: data("by_ws_recordId", "ws"),
  fakeRecordContacts: data("by_ws_recordId", "ws"),
  fakeRecordHistory: data("by_ws_recordId", "ws"),
  fakeRecordKeys: local("idempotency keys"),
  sfImportJobs: local(),
  sfImportIds: local("a Salesforce import's id map; later syncs match through canonExternalIds"),
  workspaceExportKeys: secret("export key hashes"),
  workspaceImportKeys: secret("import key hashes"),
  workspaceImports: local("an import's progress on this deployment"),
  workspaceImportIds: local("an import's id map on this deployment"),
} as const satisfies Record<string, ArchiveEntry>;

export type ArchiveTable = keyof typeof ARCHIVE_TABLES;

/** The register's sections, read from the record service rather than Convex. */
export const REGISTER_SECTIONS = ["register.accounts", "register.contacts", "register.field_history"] as const;
export type RegisterSection = (typeof REGISTER_SECTIONS)[number];

export const entryOf = (table: string): ArchiveEntry | undefined => (ARCHIVE_TABLES as Record<string, ArchiveEntry>)[table];

/** Whether an archive carries the table's rows: a `data` or `ledger` table whose scope an index reaches. */
export function exported(entry: ArchiveEntry | undefined): entry is Extract<ArchiveEntry, { class: "data" | "ledger" }> & { scope: Exclude<ArchiveScope, { by: "needsIndex" }> } {
  return !!entry && (entry.class === "data" || entry.class === "ledger") && entry.scope.by !== "needsIndex";
}

/** The exported tables, each after the parent it is read through. */
export function exportOrder(): ArchiveTable[] {
  const tables = (Object.keys(ARCHIVE_TABLES) as ArchiveTable[]).filter((t) => exported(entryOf(t)));
  const done = new Set<string>();
  const order: ArchiveTable[] = [];
  const visit = (t: ArchiveTable) => {
    if (done.has(t)) return;
    done.add(t);
    const scope = (entryOf(t) as { scope: ArchiveScope }).scope;
    if (scope.by === "parent") visit(scope.parent as ArchiveTable);
    order.push(t);
  };
  tables.forEach(visit);
  return order;
}
