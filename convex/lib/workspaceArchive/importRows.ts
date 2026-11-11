/**
 * Reading an archive's rows back into a workspace (docs/workspace-export.md, "Import a workspace"). An archive is
 * untrusted input: every row is decoded against the destination schema's validator for its table, every id in it is
 * rewritten through the import's id map, and anything that names an id the map lacks is reported rather than written.
 * The same code runs in Convex (convex/workspaceImport.ts, against the real map) and in the CLI's dry run (against
 * the map the archive implies), so the dry run reports exactly what the import refuses.
 *
 * Pure: imports only the arrivals (./actors.ts).
 */
import { ARRIVALS, type Arrival } from "./actors.ts";

/** A validator as plain data (convex/values `Validator` at runtime, or `shapeOf` of one). */
export type Shape = {
  kind: string;
  optional?: boolean;
  tableName?: string;
  fields?: Record<string, Shape>;
  element?: Shape;
  members?: Shape[];
  key?: Shape;
  value?: Shape | string | number | boolean | null;
};

/** A runtime Convex validator as plain JSON, for the CLI's dry run. */
export function shapeOf(v: Record<string, unknown>): Shape {
  const kind = v.kind as string;
  const s: Shape = { kind, ...(v.isOptional === "optional" ? { optional: true } : {}) };
  if (kind === "id") s.tableName = v.tableName as string;
  if (kind === "object") s.fields = Object.fromEntries(Object.entries(v.fields as Record<string, Record<string, unknown>>).map(([k, f]) => [k, shapeOf(f)]));
  if (kind === "array") s.element = shapeOf(v.element as Record<string, unknown>);
  if (kind === "union") s.members = (v.members as Record<string, unknown>[]).map(shapeOf);
  if (kind === "record") { s.key = shapeOf(v.key as Record<string, unknown>); s.value = shapeOf(v.value as Record<string, unknown>); }
  if (kind === "literal") s.value = v.value as string | number | boolean;
  return s;
}

/**
 * The tables this importer writes, and how. Every other `data` and `ledger` table of an archive is reported as not
 * imported yet, with its count. A table not listed here is never written, whatever the archive holds.
 * - `rows`: decoded and inserted as they are. `replace`: the destination's own rows of the table (a new workspace's
 *   defaults) are removed first, so the archive's settings take their place.
 * - `self`: the archive's workspace settings, patched onto the destination workspace.
 * - `members`: matched to the destination's members by email, or added as inactive placeholders.
 * - `ledger`: appended to each stream through the object layer's appendHistory, which folds and writes the hot row.
 * - `observations`: appended to each subject's log with this deployment's shard sequence.
 * - `facts`: inserted as they are, then each touched field's state is resolved again from its facts.
 * - `register`: the record service's register, written through its import route.
 */
export type ImportKind = "rows" | "self" | "members" | "ledger" | "observations" | "facts" | "register";
/**
 * `defer`: fields that name rows of a section imported later (by id inside text, so the order can't put it first),
 * left out of the first pass and filled in once `after` is in.
 * `dedupe`: a row this workspace already holds with the same `fields` (read through `index`) is replaced by the
 * archive's, and stands for it in the id map: a unique claim the replay wrote, or a default a module installed.
 * `arrive`: rows that can send or act arrive switched off (actors.ts), and the round trip expects exactly that change.
 * `module`: rows a module owns (`field` names it, on rows matching `when`). They are imported only when this
 * deployment has a module of that id installed in the workspace, and otherwise skipped and counted by module.
 */
export type ImportSpec = {
  kind: ImportKind; replace?: true; dependsOn?: readonly string[]; defer?: { fields: readonly string[]; after: string };
  dedupe?: { index: string; fields: readonly string[] };
  module?: { field: string; when?: Readonly<Record<string, string>> };
  /** How a row that can send or act arrives (actors.ts ARRIVALS): the one writer applies it whatever the file says. */
  arrive?: Arrival;
  /**
   * Text a person or a model wrote, by path (array positions left out; a path covers what is under it). An id the
   * archive maps is rewritten to its new id wherever it stands; any other word, id-shaped or not, stays as written.
   */
  prose?: readonly string[];
  /** Paths where an id the archive doesn't carry (a citation of a call, a mailbox's id) is kept as a foreign label. */
  labels?: readonly string[];
  /** Fields that name this deployment's connections (`table`), which never move: dropped and counted as cleared. */
  local?: Readonly<Record<string, string>>;
};

/** Tables whose ids sit inside other tables' strings: the order can't be read off the validators, so it is named. */
const STREAM_TABLES = ["canonEntities", "register.accounts", "register.contacts", "fakeRecordAccounts", "fakeRecordContacts"] as const;
/** After every record and its history: a row may name any of them by stream, register or fact id inside text. */
const RECORDS = ["ledgerEntries", "canonExternalIds", "fakeRecordHistory", "register.field_history"] as const;

export const IMPORT_TABLES: Readonly<Record<string, ImportSpec>> = {
  users: { kind: "members" },
  organizations: { kind: "self", dependsOn: ["users"] },
  orgRoles: { kind: "rows", replace: true },
  rolePermissions: { kind: "rows", replace: true },
  teamGroups: { kind: "rows", replace: true },
  pipelineStageConfigs: { kind: "rows", replace: true },
  dealPipelines: { kind: "rows", replace: true },
  objectDefs: { kind: "rows", replace: true },
  // A deal's company can be a register id derived from its stream (acc_s_), which exists once the streams are in.
  deals: { kind: "rows", dependsOn: ["users", "pipelineStageConfigs", "dealPipelines"], defer: { fields: ["companyId"], after: "canonEntities" } },
  // A deal's stream names its deals row in projectionId.
  canonEntities: { kind: "rows", dependsOn: ["deals", "objectDefs"] },
  // A register account names the ICPs it passes (icpIds).
  "register.accounts": { kind: "register", dependsOn: ["canonEntities", "icps"] },
  "register.contacts": { kind: "register", dependsOn: ["canonEntities", "register.accounts"] },
  "register.field_history": { kind: "register", dependsOn: ["register.accounts", "register.contacts"] },
  fakeRecordAccounts: { kind: "rows", dependsOn: ["canonEntities", "icps"] },
  fakeRecordContacts: { kind: "rows", dependsOn: ["canonEntities", "fakeRecordAccounts"] },
  fakeRecordHistory: { kind: "rows", dependsOn: ["fakeRecordAccounts", "fakeRecordContacts"] },
  dealContacts: { kind: "rows", dependsOn: STREAM_TABLES },
  ledgerEntries: { kind: "ledger", dependsOn: [...STREAM_TABLES, "objectDefs", "users", "deals", "fakeRecordHistory", "register.field_history"] },
  // Unique claims the ledger's replay already wrote are kept; the rest arrive as they were.
  canonExternalIds: { kind: "rows", dedupe: { index: "by_orgId_provider_externalId", fields: ["provider", "externalId"] }, dependsOn: ["ledgerEntries"] },
  recordMerges: { kind: "rows", dependsOn: ["ledgerEntries"] },
  duplicateDismissals: { kind: "rows", dependsOn: STREAM_TABLES },
  observations: { kind: "observations", dependsOn: STREAM_TABLES },

  // The review queue and field values: the replay writes no facts (appendHistory keeps no `facts` mirror), so every
  // fact arrives here, and canonFieldState is resolved again from them. A fact names its ledger copy as <stream>@v#i.
  facts: { kind: "facts", dependsOn: RECORDS },
  canonFieldOwnership: { kind: "rows", dependsOn: RECORDS },
  crmFieldFollows: { kind: "rows", dependsOn: RECORDS },
  canonAutoAcceptRules: { kind: "rows", dependsOn: RECORDS },
  // ICPs and the fit model; `finish` asks for a rescore once they are in. A gate and a register row name ICPs by id.
  icps: { kind: "rows", dependsOn: ["users"] },
  icpNodes: { kind: "rows", dependsOn: RECORDS },
  icpVersions: { kind: "rows", dependsOn: [...RECORDS, "icps"] },
  icpProfiles: { kind: "rows", dependsOn: RECORDS },
  cliArtifacts: { kind: "rows", dependsOn: RECORDS },
  cliArtifactRevisions: { kind: "rows", dependsOn: RECORDS },
  cliArtifactDrafts: { kind: "rows", dependsOn: RECORDS },
  tamSegments: { kind: "rows", dependsOn: RECORDS },
  tamSuggestionRuns: { kind: "rows", dependsOn: RECORDS },
  icpChallengeRuns: { kind: "rows", dependsOn: RECORDS },
  marketSourceSearches: { kind: "rows", dependsOn: RECORDS },
  marketSourceMemberships: { kind: "rows", dependsOn: RECORDS },
  // Settings over Canon's recipes, scoring's among them. Module switches are module state (`module` below).
  recipeRevisions: { kind: "rows", dependsOn: RECORDS },
  // A template's enablement names the report or dashboard it installed.
  recipeEnablements: { kind: "rows", dedupe: { index: "by_orgId_and_point_and_recipeId_and_contributionKey", fields: ["point", "recipeId", "contributionKey"] }, module: { field: "recipeId", when: { point: "module" } }, dependsOn: [...RECORDS, "reports", "dashboards", "savedViews", "icps", "automationRules"] },
  // Lists, reports and dashboards. A built-in one replaces the copy a module installed here; a module's needs that module.
  savedViews: { kind: "rows", dependsOn: RECORDS },
  reports: { kind: "rows", dedupe: { index: "by_orgId_builtIn", fields: ["builtIn"] }, module: { field: "module.moduleId" }, dependsOn: RECORDS },
  dashboards: { kind: "rows", dedupe: { index: "by_orgId_builtIn", fields: ["builtIn"] }, module: { field: "module" }, dependsOn: RECORDS },
  audiences: { kind: "rows", dependsOn: RECORDS },
  audienceMembers: { kind: "rows", dependsOn: RECORDS },
  audienceRuns: { kind: "rows", dependsOn: RECORDS },
  audienceAdditions: { kind: "rows", dependsOn: RECORDS },
  // Who must never be contacted: imported so a later send respects them. They only hold sends back.
  suppressions: { kind: "rows", dependsOn: RECORDS },
  suppressionEvents: { kind: "rows", dependsOn: RECORDS },
  dialerDoNotCall: { kind: "rows", dependsOn: RECORDS },
  // An audit entry names the rule or plan it is about inside its details (automations.ts audit).
  operationAuditLog: { kind: "rows", dependsOn: [...RECORDS, "automationRules", "routingRules", "sequenceLaunches"] },
  notifications: { kind: "rows", dependsOn: RECORDS },
  notificationEmail: { kind: "rows", module: { field: "moduleId" }, dependsOn: RECORDS },
  orgOnboardingSteps: { kind: "rows", replace: true, dependsOn: RECORDS },
  healthSnapshots: { kind: "rows", dependsOn: RECORDS },
  crmOpportunities: { kind: "rows", dependsOn: RECORDS },
  dealChats: { kind: "rows", dependsOn: RECORDS },
  dealChatMessages: { kind: "rows", dependsOn: RECORDS },
  dealProspectRankings: { kind: "rows", dependsOn: [...RECORDS, ...STREAM_TABLES] },
  dealOverrides: { kind: "rows", dependsOn: RECORDS },
  researchPages: { kind: "rows", dependsOn: RECORDS },
  accountSignals: { kind: "rows", dependsOn: RECORDS },
  // The rest of the GTM planning tables: plain rows whose refs are members, deals and each other.
  competitors: { kind: "rows", dependsOn: RECORDS },
  battlecards: { kind: "rows", dependsOn: RECORDS },
  winLossRecords: { kind: "rows", dependsOn: RECORDS },
  playbooks: { kind: "rows", dependsOn: RECORDS },
  playbookSections: { kind: "rows", dependsOn: RECORDS },
  campaigns: { kind: "rows", dependsOn: RECORDS },
  onboardingPlans: { kind: "rows", dependsOn: RECORDS },
  onboardingProgress: { kind: "rows", dependsOn: RECORDS },
  activityMetrics: { kind: "rows", dependsOn: RECORDS },
  activityBenchmarks: { kind: "rows", dependsOn: RECORDS },
  partners: { kind: "rows", dependsOn: RECORDS },
  partnerDeals: { kind: "rows", dependsOn: RECORDS },
  compBenchmarks: { kind: "rows", dependsOn: RECORDS },
  gtmPlans: { kind: "rows", dependsOn: RECORDS },
  budgets: { kind: "rows", dependsOn: RECORDS },
  budgetLineItems: { kind: "rows", dependsOn: RECORDS },
  approvalWorkflows: { kind: "rows", dependsOn: RECORDS },
  leadScoringModels: { kind: "rows", dependsOn: RECORDS },
  customerHealthConfigs: { kind: "rows", dependsOn: RECORDS },
  scorecardConfigs: { kind: "rows", dependsOn: RECORDS },
  scorecardResults: { kind: "rows", dependsOn: RECORDS },
  abmLists: { kind: "rows", dependsOn: RECORDS },
  abmPlays: { kind: "rows", dependsOn: RECORDS },
  marketMaps: { kind: "rows", dependsOn: RECORDS },
  marketCaptures: { kind: "rows", dependsOn: RECORDS },
  marketClassifications: { kind: "rows", dependsOn: RECORDS },
  marketRuns: { kind: "rows", dependsOn: RECORDS },

  // What sends or acts (actors.ts): each arrives switched off. A plan comes before the facts and audit rows that name it.
  patchPlans: { kind: "rows", arrive: ARRIVALS.patchPlans, dependsOn: RECORDS },
  // A review-queue operation names its fact by id (packageOpId).
  patchOperations: { kind: "rows", dependsOn: [...RECORDS, "facts"] },
  approvalRequests: { kind: "rows", arrive: ARRIVALS.approvalRequests, dependsOn: RECORDS },
  automationRules: { kind: "rows", arrive: ARRIVALS.automationRules, dependsOn: RECORDS },
  // A version names its rule; a proposal arrives a proposal (actors.ts INERT), and only an admin here can approve it.
  automationVersions: { kind: "rows", prose: ["note", "reason", "spec.name"], dependsOn: [...RECORDS, "automationRules"] },
  routingRules: { kind: "rows", arrive: ARRIVALS.routingRules, dependsOn: RECORDS },
  sequenceLaunches: { kind: "rows", arrive: ARRIVALS.sequenceLaunches, module: { field: "moduleId" }, dependsOn: RECORDS },
  sequenceEnrollments: { kind: "rows", arrive: ARRIVALS.sequenceEnrollments, module: { field: "moduleId" }, dependsOn: RECORDS },
  // A send's history needs its mailbox, which never moves, so every row is left out and counted.
  emailSends: { kind: "rows", dependsOn: RECORDS },

  // Agents come before the history that names them (`agent:<id>` in a source ref); their routing waits for the audiences.
  agents: { kind: "rows", arrive: ARRIVALS.agents, defer: { fields: ["route"], after: "audiences" }, prose: ["label"], dependsOn: ["users"] },
  // A deal event's key names its deal (deal.stage_changed:<dealId>@<version>); a payload is what its sender sent.
  agentTurns: { kind: "rows", arrive: ARRIVALS.agentTurns, prose: ["payload", "subject", "skip", "error", "outputs.reason", "outputs.value", "outputs.label", "routing.message"], dependsOn: RECORDS },
  researchAgents: { kind: "rows", arrive: ARRIVALS.researchAgents, prose: ["label", "question", "options", "refreshHold"], dependsOn: RECORDS },
  // A run's scope can name a saved ICP.
  researchRuns: { kind: "rows", arrive: ARRIVALS.researchRuns, prose: ["error", "watch", "misses", "sample.label", "sample.value", "sample.quote", "sample.reason"], dependsOn: [...RECORDS, "icps"] },
  researchTraces: { kind: "rows", prose: ["label", "value", "quote", "reason"], dependsOn: RECORDS },
  researchAttempts: { kind: "rows", dependsOn: RECORDS },
  // What a person or the email logger read in from a mailbox or a LinkedIn sender. The text is read only through
  // lib/conversations/store.ts, which keys on the owner (mapped as a member) and the reader's role. `accountRef` is a
  // mailbox's or sender's id, which never moves (kept as a label, so no account here lists them), or emaillog:<userId>.
  // A thread's and a message's external ids are the provider's (a Message-ID, a LinkedIn chat's id): free text.
  conversations: { kind: "rows", arrive: ARRIVALS.conversations, labels: ["accountRef"], prose: ["externalThreadId", "subject", "counterpart", "participants", "extractSkipped"], dependsOn: RECORDS },
  conversationMessages: { kind: "rows", prose: ["externalMessageId", "inReplyTo", "references", "from", "to", "subject", "text"], dependsOn: RECORDS },
  conversationContacts: { kind: "rows", dependsOn: RECORDS },
  // A play's deal state cites facts, conversations, its deal's stages (<streamId>:stages) and calls. A cited source
  // the archive doesn't carry is kept as a label, and its quote stays.
  dealPlays: {
    kind: "rows", arrive: ARRIVALS.dealPlays, local: { linkedin: "linkedinAccounts" }, labels: ["state.qualification.sources.id", "state.concerns.sources.id"],
    prose: ["context", "whyNow", "alphaHypothesis", "alphaPitch", "windowLabel", "answers", "research.error", "stateRun.error", "peopleResearch.note", "keeper.error", "state", "stateSummary"],
    dependsOn: [...RECORDS, "facts", "conversations", "callRecordings"],
  },
  dealPlayItems: { kind: "rows", prose: ["text", "quote", "person"], dependsOn: RECORDS },
  dealPlayPeople: { kind: "rows", prose: ["persona", "angle", "capability"], dependsOn: RECORDS },
  dealPlaySteps: { kind: "rows", arrive: ARRIVALS.dealPlaySteps, prose: ["title", "draft.subject", "draft.body", "draft.review"], dependsOn: RECORDS },

  // LinkedIn cadences and enrollments need their sender, a dialer call its session, a feed item its connector link and
  // an email send its mailbox: none of these moves, so each row is left out and counted. What they did is on each
  // person's activity (observations), which the archive carries.
  linkedinCadences: { kind: "rows", dependsOn: RECORDS },
  linkedinEnrollments: { kind: "rows", dependsOn: RECORDS },
  dialerCalls: { kind: "rows", dependsOn: RECORDS },
  feedItems: { kind: "rows", dependsOn: RECORDS },
  dialerSettings: { kind: "rows", replace: true, arrive: ARRIVALS.dialerSettings, dependsOn: RECORDS },
  recordingPolicy: { kind: "rows", replace: true, arrive: ARRIVALS.recordingPolicy, prose: ["noticeText"], dependsOn: RECORDS },
  dialerProfiles: { kind: "rows", prose: ["voicemailMessage"], dependsOn: RECORDS },
  // Calls from every provider, with their transcripts and insights. A Telnyx call's audio was a file on its dialer
  // call, which doesn't come along; a provider's recording link does. A call names CRM mirror rows, which are cleared.
  callRecordings: { kind: "rows", prose: ["title", "transcriptText", "participants", "sourceMetadata", "recordingUrl"], dependsOn: RECORDS },
  callTranscriptSegments: { kind: "rows", prose: ["speaker", "text"], dependsOn: RECORDS },
  callInsights: { kind: "rows", prose: ["title", "text", "evidence", "speaker", "crmImpact"], dependsOn: RECORDS },
  callInsightTags: { kind: "rows", prose: ["label", "type", "prompt"], dependsOn: RECORDS },
  // A deal's suggestion is keyed by its call.
  callSuggestions: { kind: "rows", prose: ["values", "evidence", "research"], dependsOn: [...RECORDS, "callRecordings", "conversations"] },
  // The hierarchy manager and field consolidations: each scan, research, decision and run was started by a person.
  // A Canon scan names companies by register id; a Salesforce scan's ids are Salesforce's, kept as they are.
  hierarchySettings: { kind: "rows", replace: true, dependsOn: RECORDS },
  hierarchyScans: { kind: "rows", arrive: ARRIVALS.hierarchyScans, prose: ["error"], dependsOn: RECORDS },
  hierarchyGroups: { kind: "rows", prose: ["reasons", "accounts.name"], dependsOn: RECORDS },
  hierarchyResearch: { kind: "rows", arrive: ARRIVALS.hierarchyResearch, prose: ["groupName", "research", "verification", "error"], dependsOn: RECORDS },
  hierarchyDecisions: { kind: "rows", prose: ["applyError"], dependsOn: RECORDS },
  // A consolidation names its latest run, which names it back: the run is filled in once the runs are in.
  fieldConsolidations: { kind: "rows", defer: { fields: ["run"], after: "fieldConsolidationRuns" }, prose: ["concept", "keywords", "columns", "systems", "options", "valueMap", "error"], dependsOn: [...RECORDS, "patchPlans"] },
  fieldConsolidationRuns: { kind: "rows", arrive: ARRIVALS.fieldConsolidationRuns, prose: ["sections", "error"], dependsOn: RECORDS },
  fieldConsolidationWrites: { kind: "rows", prose: ["before", "after", "reason", "detail"], dependsOn: RECORDS },
  fieldConsolidationProfiles: { kind: "rows", prose: ["profile", "error"], dependsOn: RECORDS },
};

/**
 * The `data` sections this importer leaves for later, each with why. Every exported table is imported or listed
 * here (tests/workspaceImport.test.ts), so the dry run's "not imported yet" lines always say why.
 * - `C`: module documents and module-owned plans (commissions, territories): only for modules installed here.
 * - `files`: rows that are their stored file, which archives don't carry yet.
 * - `rebuilt`: state the import rebuilds or the next sync writes.
 */
export const DEFERRED: Readonly<Record<string, { group: "C" | "files" | "rebuilt"; why: string }>> = {

  modulePackages: { group: "C", why: "module code is never installed from an archive; a module installed here takes its documents" },
  moduleInterfaceOwners: { group: "C", why: "arrives with the module documents" },
  moduleDocs: { group: "C", why: "a module's documents, imported only where the module is installed" },
  moduleEvents: { group: "C", why: "arrives with the module documents" },
  moduleSnapshots: { group: "C", why: "arrives with the module documents" },
  moduleAiRuns: { group: "C", why: "arrives with the module documents" },
  commissionPlans: { group: "C", why: "commissions are a module's plans" },
  planRules: { group: "C", why: "commissions are a module's plans" },
  planAssignments: { group: "C", why: "commissions are a module's plans" },
  planRuleExclusions: { group: "C", why: "commissions are a module's plans" },
  payPeriods: { group: "C", why: "commissions are a module's plans" },
  commissionLineItems: { group: "C", why: "commissions are a module's plans" },
  statements: { group: "C", why: "commissions are a module's plans" },
  quotaProgress: { group: "C", why: "commissions are a module's plans" },
  compPlanAnalysis: { group: "C", why: "commissions are a module's plans" },
  territories: { group: "C", why: "territories are a module's plans" },
  territoryAssignments: { group: "C", why: "territories are a module's plans" },
  territoryRules: { group: "C", why: "territories are a module's plans" },
  quotaPlans: { group: "C", why: "quota plans name territories" },
  quotaPlanTargets: { group: "C", why: "quota plans name territories" },
  targetPlans: { group: "C", why: "arrives with the quota plans" },
  capacityModels: { group: "C", why: "arrives with the quota plans" },
  planningScenarios: { group: "C", why: "arrives with the quota plans" },
  headcountReqs: { group: "C", why: "a requisition names its territory" },
  recipePackages: { group: "files", why: "an installed recipe is its bundle, a stored file" },
  recipeMarkdownRevisions: { group: "files", why: "a workspace recipe's revisions run with its package's bundle, a stored file" },
  icpScores: { group: "rebuilt", why: "scores of CRM mirror accounts, which archives never carry; the rescore after import scores the register" },
  accountEnrichments: { group: "rebuilt", why: "enrichment of CRM mirror accounts, which archives never carry" },
  leadScores: { group: "rebuilt", why: "scores of CRM mirror contacts, which archives never carry" },
  abmListAccounts: { group: "rebuilt", why: "entries name CRM mirror accounts, which archives never carry" },
  customerHealthScores: { group: "rebuilt", why: "scores of CRM mirror accounts, which archives never carry" },
  touchpoints: { group: "rebuilt", why: "touchpoints name CRM mirror accounts and contacts, which archives never carry" },
  fitReconciliations: { group: "rebuilt", why: "the fit reconciler's progress here; the import asks for a fresh rescore" },
  tamInvestigations: { group: "rebuilt", why: "an investigation is its background job, which stays with the source deployment" },
  tamCandidates: { group: "rebuilt", why: "arrives with its investigation" },
  parentDisagreements: { group: "rebuilt", why: "what a connected CRM says about a link; the connection stays with the source, and the next sync of a CRM connected here finds them again" },
};

/** The archive's sections this importer writes, each after every table it references, by validator or by string. */
export function importOrder(shapes: Readonly<Record<string, Shape | undefined>>): string[] {
  const names = Object.keys(IMPORT_TABLES);
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: string) => {
    if (state.get(t) === "done") return;
    if (state.get(t) === "visiting") throw new Error(`import order has a cycle through ${t}`);
    state.set(t, "visiting");
    for (const dep of dependenciesOf(t, shapes[t])) visit(dep);
    state.set(t, "done");
    order.push(t);
  };
  names.forEach(visit);
  return order;
}

/** The imported tables `table` must follow: those its validator's ids name (other than itself) and those it names by string. */
export function dependenciesOf(table: string, shape: Shape | undefined): string[] {
  const refs = new Set<string>(IMPORT_TABLES[table]?.dependsOn ?? []);
  // A deferred field's refs are filled in by its second pass, after the section it waits for.
  const deferred = IMPORT_TABLES[table]?.defer?.fields ?? [];
  const own = shape?.fields ? { ...shape, fields: Object.fromEntries(Object.entries(shape.fields).filter(([k]) => !deferred.includes(k))) } : shape;
  if (own) for (const t of refTables(own)) refs.add(t);
  refs.delete(table);
  // The destination workspace exists before anything is imported: a ref to the archive's workspace is a ref to it.
  refs.delete("organizations");
  return [...refs].filter((t) => t in IMPORT_TABLES);
}

function refTables(s: Shape, out = new Set<string>()): Set<string> {
  if (s.kind === "id" && s.tableName) out.add(s.tableName);
  for (const f of Object.values(s.fields ?? {})) refTables(f, out);
  if (s.element) refTables(s.element, out);
  for (const m of s.members ?? []) refTables(m, out);
  if (s.kind === "record" && s.value && typeof s.value === "object") refTables(s.value, out);
  return out;
}

/** Whether rows of `table` reference rows of their own table, which a second pass fills in once all of them exist. */
export const selfReferencing = (table: string, shape: Shape) => refTables(shape).has(table);

/**
 * The fields of `table` a second pass fills in, and the section after which it runs: refs to the table's own rows
 * (after the table itself), and its `defer` fields (after the section they name). Null when it needs none.
 */
export function secondPassOf(table: string, shape: Shape): { fields: string[]; after: string } | null {
  const own = Object.entries(shape.fields ?? {}).filter(([, f]) => refTables(f).has(table)).map(([k]) => k);
  const defer = IMPORT_TABLES[table]?.defer;
  const fields = [...own, ...(defer?.fields ?? [])];
  return fields.length ? { fields, after: defer?.after ?? table } : null;
}

// ---------- ids ----------

const ID = "[0-9a-z]{31,37}";
const BARE = new RegExp(`^${ID}$`);
/** Prefixed ids in strings (lib/workspaceArchive/rows.ts EMBEDDED_ID_GRAMMARS): each id after its prefix is mapped. */
const PREFIXED: ReadonlyArray<{ name: string; re: RegExp; user?: true }> = [
  { name: "user:<userId>[:<dealId>]", re: new RegExp(`\\buser:(${ID})(?::(${ID}))?(?![0-9a-z])`, "g"), user: true },
  { name: "agent:<agentId>", re: new RegExp(`\\bagent:(${ID})(?![0-9a-z])`, "g") },
  { name: "grant:<grantId>", re: new RegExp(`\\bgrant:(${ID})(?![0-9a-z])`, "g") },
  { name: "automation:<ruleId>:", re: new RegExp(`\\bautomation:(${ID}):`, "g") },
  { name: "module:<moduleId>:plan:<planId>", re: new RegExp(`\\bmodule:\\S+?:plan:(${ID})(?![0-9a-z])`, "g") },
  { name: "canon_field:<fieldId>:<streamId>", re: new RegExp(`\\bcanon_field:(${ID}):(${ID})(?![0-9a-z])`, "g") },
  { name: "import:deal:<dealId>", re: new RegExp(`\\bimport:deal:(${ID})(?![0-9a-z])`, "g") },
  { name: "<streamId>@<version>#<index>", re: new RegExp(`\\b(${ID})@\\d+#\\d+`, "g") },
  // A deal event agent's turn key (convex/agentTurns.ts DEAL_EVENT), and a deal state's citation of its deal's stages (dealState.ts).
  { name: "deal.stage_changed:<dealId>@<version>", re: new RegExp(`\\bdeal\\.stage_changed:(${ID})@\\d+`, "g") },
  { name: "<streamId>:stages", re: new RegExp(`(?<![0-9a-z])(${ID}):stages\\b`, "g") },
  // A call suggestion's dedupe key: a deal from a call or conversation (lib/calls/suggestions.ts), a deal's gap (dealGaps.ts).
  { name: "call:<callOrConversationId>", re: new RegExp(`^call:(${ID})$`, "g") },
  { name: "deal:<streamId>:<key>", re: new RegExp(`^deal:(${ID}):`, "g") },
  // Email a member logged by BCC or forward (convex/conversations.ts loggedAccountRef).
  { name: "emaillog:<userId>", re: new RegExp(`\\bemaillog:(${ID})(?![0-9a-z])`, "g"), user: true },
  // An agent-class proposal's source record and dedupe key (lib/agents/attribution.ts proposalSourceRefBase): the record is a deal or stream.
  { name: "<sourceKind>:<label>:<recordId>[:<attribute>]", re: new RegExp(`\\b(?:agent_run|enrichment|call|email|linkedin|pipeline):\\S*?:(${ID})(?=:[A-Za-z0-9_.]+$|$)`, "g") },
];
const REGISTER = /\b(?:acc|con)_s_[0-9a-f]{20}\b/g;
/** Any id-shaped word inside text. One that names a row of the archive but no grammar above reads is refused. */
const LOOSE = new RegExp(`(?<![0-9a-z])${ID}(?![0-9a-z])`, "g");
/** What the id map holds for a row the import skipped: refs to it are dropped where optional, and skip their row where required. */
export const SKIPPED = "\u0000skipped";

/** The module that owns an archived row, when its table's `module` names one: null for a row no module owns. */
export function moduleOf(table: string, raw: Record<string, unknown>): string | null {
  const m = IMPORT_TABLES[table]?.module;
  if (!m || Object.entries(m.when ?? {}).some(([k, v]) => raw[k] !== v)) return null;
  const value = m.field.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), raw);
  return typeof value === "string" && value ? value : null;
}

/** A register id the record service derives from a stream id (services/record-service/src/register.ts `idFor`). */
export async function registerIdOf(object: "account" | "contact", streamId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(streamId));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
  return `${object === "account" ? "acc" : "con"}_s_${hex}`;
}

/** A source's id that no longer names anything here, kept as a stable label that no grammar reads as an id. */
export function foreignLabel(oldId: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < oldId.length; i++) { a = Math.imul(a ^ oldId.charCodeAt(i), 0x01000193); b = Math.imul(b ^ oldId.charCodeAt(i), 0x811c9dc5); }
  return `foreign-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** Every old id a raw archive row names: its refs, the ids inside its strings and its own. The import loads their map entries first. */
export function idsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (BARE.test(value)) out.add(value);
    for (const g of PREFIXED) for (const m of value.matchAll(g.re)) for (const id of m.slice(1)) if (id) out.add(id);
    for (const m of value.matchAll(REGISTER)) out.add(m[0]);
    for (const m of value.matchAll(LOOSE)) out.add(m[0]);
    const json = jsonIn(value);
    if (json !== undefined) idsIn(json, out);
  } else if (Array.isArray(value)) value.forEach((v) => idsIn(v, out));
  else if (value && typeof value === "object") {
    const ref = value as { $ref?: unknown; id?: unknown };
    if (typeof ref.$ref === "string" && typeof ref.id === "string") out.add(ref.id);
    else for (const v of Object.values(value)) idsIn(v, out);
  }
  return out;
}

const jsonIn = (s: string): unknown => {
  if (!/^[[{]/.test(s) || !/[0-9a-z]{31}/.test(s)) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
};

// ---------- decoding ----------

/** What a row names that the destination can't resolve, with where. The import writes no row that has one. */
export type Unmapped = { table: string; id: string | null; field: string; value: string; why: string };

export type RemapEnv = {
  /** The destination id of a source id: any table's (Convex ids are unique across tables), or a register id. */
  map(oldId: string): string | undefined;
  /** Tables the import writes. A ref to any other table is cleared where the field is optional. */
  imported(table: string): boolean;
  /** The destination workspace, which every row's workspace field is set to whatever the archive says. */
  orgId: string;
};

export type Decoded = {
  row: Record<string, unknown>;
  unmapped: Unmapped[];
  /** Refs to tables the import doesn't write (storage, derived or secret tables), dropped from optional fields. */
  cleared: Record<string, number>;
  /** Fields left out until a second pass, because they reference rows of the same table. */
  deferred: string[];
  /** Ids from the source that history keeps only as labels (an agent or a grant the archive doesn't carry). */
  foreign: number;
  /**
   * The table a required ref names that this import doesn't write (or a row of it the import skipped): the row is
   * skipped and counted, not written. Null for a row the import writes.
   */
  needs: string | null;
};

const SYSTEM = new Set(["_id", "_creationTime"]);
const SKIP = Symbol("skip");
/** A string a row holds for its own id (a stream's projectionId); the import swaps in the new id after insert. */
export const SELF = "\u0000self";

/**
 * Fields that name a row the archive never carries, kept as labels: a stream projected onto the CRM mirror
 * (crmAccounts, crmContacts) names its mirror row, which the next CRM sync rebuilds, and readers find none until then.
 */
const DERIVED_PROJECTIONS = new Set(["crmAccounts", "crmContacts"]);
const labelFieldsOf = (table: string, raw: Record<string, unknown>) =>
  [...(table === "canonEntities" && DERIVED_PROJECTIONS.has(raw.projectionTable as string) ? ["projectionId"] : []), ...(IMPORT_TABLES[table]?.labels ?? [])];
/** A value's path without array positions, as `prose` and `labels` name it. */
const fieldPath = (path: readonly string[]) => path.filter((p) => !/^\d+$/.test(p)).join(".");
const under = (path: string, prefixes: readonly string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}.`));

/** A history label's path: a source ref or an actor's id. Ids there that no longer exist are kept as labels. */
const isLabel = (path: readonly string[]) => {
  const key = path[path.length - 1];
  // A fact's decider (`decidedBy`, `decider`) may be a grant, which archives never carry. A template's `installed.rowId`
  // names the row it made, which may be one this import doesn't carry (an automation).
  return key === "ref" || key === "sourceRef" || key === "actorId" || key === "decidedBy" || path[path.length - 2] === "decider"
    || (key === "id" && path[path.length - 2] === "actor") || (key === "rowId" && path[path.length - 2] === "installed");
};

/**
 * One archive row as a destination row of `table`: its fields checked against `shape`, its refs and embedded ids
 * mapped, its workspace field set to the destination's. `deferSelf` leaves refs to the table's own rows for a second
 * pass. Nothing here writes; `unmapped` lists what keeps the row out.
 */
export function decodeRow(table: string, shape: Shape, raw: Record<string, unknown>, env: RemapEnv, opts: { deferSelf?: boolean; scopeField?: string; omit?: readonly string[] } = {}): Decoded {
  const out: Decoded = { row: {}, unmapped: [], cleared: {}, deferred: [], foreign: 0, needs: null };
  let missing: string | null = null;
  const own = typeof raw._id === "string" ? raw._id : null;
  const labels = labelFieldsOf(table, raw);
  const miss = (path: readonly string[], value: string, why: string) => out.unmapped.push({ table, id: own, field: path.join("."), value: value.slice(0, 200), why });

  const mapId = (id: string, path: readonly string[], why: string): string | null => {
    if (own && id === own) return SELF;
    const mapped = env.map(id);
    if (mapped !== undefined && mapped !== SKIPPED) return mapped;
    if (isLabel(path) || labels.includes(fieldPath(path))) { out.foreign++; return foreignLabel(id); }
    miss(path, id, mapped === SKIPPED ? "a row this import skips" : why);
    return null;
  };

  const prose = IMPORT_TABLES[table]?.prose ?? [];
  /** Free text: every id the archive maps becomes its new id, and every other word stays as written. */
  const rewriteProse = (s: string): string => {
    const known = (id: string) => { const mapped = env.map(id); return mapped !== undefined && mapped !== SKIPPED && !mapped.startsWith(SELF) ? mapped : undefined; };
    return s.replace(LOOSE, (id) => known(id) ?? (env.map(id) === SKIPPED ? (out.foreign++, foreignLabel(id)) : id)).replace(REGISTER, (id) => known(id) ?? id);
  };

  const rewrite = (s: string, path: readonly string[]): string => {
    const at = fieldPath(path);
    if (under(at, prose) && !labels.includes(at)) return rewriteProse(s);
    const json = jsonIn(s);
    if (json !== undefined) return JSON.stringify(walkAny(json, path));
    if (BARE.test(s)) return mapId(s, path, "an id this archive doesn't import") ?? s;
    const read = new Set<string>();
    let next = s;
    for (const g of PREFIXED) next = next.replace(g.re, (match, ...groups) => {
      let text = match;
      for (const id of groups.slice(0, 2)) {
        if (typeof id !== "string" || !BARE.test(id)) continue;
        read.add(id);
        const mapped = mapId(id, path, `an id in ${g.name}`);
        if (mapped && mapped !== SELF) text = text.replace(id, mapped);
      }
      return text;
    });
    for (const m of s.matchAll(LOOSE)) if (!read.has(m[0]) && m[0] !== own && env.map(m[0]) !== undefined) miss(path, m[0], "an id inside text in a form the import doesn't read");
    return next.replace(REGISTER, (id) => { const mapped = env.map(id); return mapped !== undefined && mapped !== SKIPPED ? mapped : (miss(path, id, "a register id of a stream this archive doesn't import"), id); });
  };

  const walkAny = (value: unknown, path: readonly string[]): unknown => {
    if (typeof value === "string") return rewrite(value, path);
    if (Array.isArray(value)) return value.map((v, i) => walkAny(v, [...path, String(i)]));
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (typeof o.$ref === "string" && typeof o.id === "string") return refOf(o.$ref, o.id, { kind: "any" }, path);
      if (typeof o.$int64 === "string") return BigInt(o.$int64);
      if (typeof o.$bytes === "string") return bytesOf(o.$bytes);
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walkAny(v, [...path, k])]));
    }
    return value;
  };

  const refOf = (refTable: string, id: string, at: Shape, path: readonly string[]): unknown => {
    if (opts.deferSelf && refTable === table) return SKIP;
    if (!env.imported(refTable) || env.map(id) === SKIPPED) {
      out.cleared[refTable] = (out.cleared[refTable] ?? 0) + 1;
      missing = refTable;
      return SKIP;
    }
    void at;
    return mapId(id, path, `a ${refTable} row this archive doesn't hold`) ?? id;
  };

  /** A value at a position of `shape`: refs where it declares ids, any union member that accepts it. */
  const walk = (s: Shape, value: unknown, path: readonly string[]): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { $ref?: unknown }).$ref === "string") {
      const r = value as { $ref: string; id: string };
      const ids = idTables(s);
      if (!ids.includes(r.$ref) && !ids.includes("*")) { miss(path, JSON.stringify(r), `a ${r.$ref} ref where the schema has none`); return SKIP; }
      return refOf(r.$ref, r.id, s, path);
    }
    if (s.kind === "union") {
      const ms = s.members ?? [];
      const fit = ms.find((m) => accepts(m, value)) ?? ms[0];
      return fit ? walk(fit, value, path) : value;
    }
    if (s.kind === "any") return walkAny(value, path);
    if (s.kind === "string" && typeof value === "string") return rewrite(value, path);
    if (s.kind === "id" && typeof value === "string") { miss(path, value, "an id written as text, not a ref"); return SKIP; }
    if (s.kind === "int64" && value && typeof value === "object" && typeof (value as { $int64?: unknown }).$int64 === "string") return BigInt((value as { $int64: string }).$int64);
    if (s.kind === "bytes" && value && typeof value === "object" && typeof (value as { $bytes?: unknown }).$bytes === "string") return bytesOf((value as { $bytes: string }).$bytes);
    if (s.kind === "array" && Array.isArray(value) && s.element) {
      const items = value.map((v, i) => walk(s.element!, v, [...path, String(i)]));
      return items.filter((v) => v !== SKIP);
    }
    if (s.kind === "record" && value && typeof value === "object" && !Array.isArray(value) && s.value && typeof s.value === "object") {
      const vs = s.value as Shape;
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(vs, v, [...path, k])]).filter(([, v]) => v !== SKIP));
    }
    if (s.kind === "object" && value && typeof value === "object" && !Array.isArray(value)) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const f = s.fields?.[k];
        if (!f) { miss([...path, k], JSON.stringify(v ?? null).slice(0, 80), "a field the destination schema doesn't have"); continue; }
        missing = null;
        const w = walk(f, v, [...path, k]);
        if (w === SKIP) {
          if (opts.deferSelf && idTables(f).includes(table) && path.length === 0) out.deferred.push(k);
          else if (!f.optional && missing) out.needs ??= missing;
          else if (!f.optional && !out.unmapped.some((u) => u.field.startsWith([...path, k].join(".")))) miss([...path, k], JSON.stringify(v).slice(0, 80), "a required ref to a table the import doesn't write");
          continue;
        }
        o[k] = w;
      }
      return o;
    }
    return value;
  };

  const fields: Record<string, unknown> = {};
  const local = IMPORT_TABLES[table]?.local ?? {};
  for (const [k, v] of Object.entries(raw)) {
    if (SYSTEM.has(k) || opts.omit?.includes(k)) continue;
    // A connection of the source deployment (a LinkedIn sender) never moves: the field is dropped, and counted.
    if (local[k]) { out.cleared[local[k]] = (out.cleared[local[k]] ?? 0) + 1; continue; }
    fields[k] = v;
  }
  const decoded = walk(shape, fields, []) as Record<string, unknown>;
  const scope = opts.scopeField ?? (shape.fields?.orgId ? "orgId" : null);
  if (scope) decoded[scope] = env.orgId;
  // A row that needs what isn't imported is skipped whole: its shape without that ref is never checked or written.
  if (out.needs) { out.row = decoded; return out; }
  for (const problem of check(shape, decoded, [])) out.unmapped.push({ table, id: own, field: problem.field, value: problem.value, why: "doesn't match the destination schema" });
  out.row = decoded;
  return out;
}

const idTables = (s: Shape): string[] =>
  s.kind === "id" ? [s.tableName!] : s.kind === "union" ? (s.members ?? []).flatMap(idTables) : s.kind === "any" ? ["*"] : [];

function bytesOf(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** Whether an archived value fits `s`, refs and encoded numbers included, to pick the union member it was written as. */
const accepts = (s: Shape, value: unknown): boolean => check(s, value, [], true).length === 0;

const tagged = (value: unknown, tag: string) => !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[tag] === "string";

/**
 * Where `value` breaks `s`, the destination validator. A decoded row with any problem is not written. `archived`
 * reads a value as the archive writes it: `{$ref}` for an id, `{$int64}` and `{$bytes}` for those types.
 */
export function check(s: Shape, value: unknown, path: readonly string[], archived = false): Array<{ field: string; value: string }> {
  const bad = () => [{ field: path.join(".") || "(row)", value: JSON.stringify(value === undefined ? null : value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))?.slice(0, 80) ?? "" }];
  const sub = (shape: Shape, v: unknown, p: readonly string[]) => check(shape, v, p, archived);
  switch (s.kind) {
    case "any": return [];
    case "string": return typeof value === "string" ? [] : bad();
    case "id": return (archived ? tagged(value, "$ref") && (value as { $ref: string }).$ref === s.tableName : typeof value === "string") ? [] : bad();
    case "float64": return typeof value === "number" ? [] : bad();
    case "int64": return (archived ? tagged(value, "$int64") : typeof value === "bigint") ? [] : bad();
    case "boolean": return typeof value === "boolean" ? [] : bad();
    case "null": return value === null ? [] : bad();
    case "bytes": return (archived ? tagged(value, "$bytes") : value instanceof ArrayBuffer) ? [] : bad();
    case "literal": return value === s.value ? [] : bad();
    case "array": return Array.isArray(value) ? value.flatMap((v, i) => sub(s.element!, v, [...path, String(i)])) : bad();
    case "union": {
      const ms = s.members ?? [];
      if (ms.some((m) => sub(m, value, path).length === 0)) return [];
      return bad();
    }
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
      return Object.entries(value).flatMap(([k, v]) => sub(s.value as Shape, v, [...path, k]));
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
      const o = value as Record<string, unknown>;
      const problems: Array<{ field: string; value: string }> = [];
      for (const [k, f] of Object.entries(s.fields ?? {})) {
        if (o[k] === undefined) { if (!f.optional) problems.push({ field: [...path, k].join("."), value: "missing" }); continue; }
        problems.push(...sub(f, o[k], [...path, k]));
      }
      for (const k of Object.keys(o)) if (!(k in (s.fields ?? {}))) problems.push({ field: [...path, k].join("."), value: "not in the schema" });
      return problems;
    }
    default: return bad();
  }
}
