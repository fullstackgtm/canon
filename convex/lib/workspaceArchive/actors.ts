/**
 * Nothing sends or acts after an import until a person turns it on here (docs/workspace-export.md, "What arrives
 * switched off"). Two halves, both data:
 * - `ARRIVALS`: how a row of an imported table that can act arrives. The one writer (convex/workspaceImport.ts
 *   writeRow) applies it to every row of the table, whatever the archive says, and refuses a change outside `fields`.
 * - `CENSUS`: every way the app sends, calls, writes to a CRM, fires a rule or lets an agent act, with the code that
 *   decides "may this happen now" and the rows that hold that switch. After an import, `gatesIn` (workspaceImport.ts)
 *   reads every switch the archive could have brought and finish refuses while one is open. tests/workspaceImport.test.ts
 *   fails when a cron or HTTP route isn't in the census, and when an imported table with a switch has no arrival.
 *
 * Pure: no imports.
 */

export type Row = Record<string, unknown>;
/** This deployment at the moment a row is written: its clock and its workspace's ledger heads (seq per shard). */
export type ArrivalAt = { now: number; heads: Record<string, number> };

export type Arrival = {
  /** What a person sees on arrival, for the import report. */
  why: string;
  /** The only fields `apply` changes. The round trip compares every other field as it was in the source. */
  fields: readonly string[];
  apply(row: Row, at: ArrivalAt): Row;
  /** Applied again by `finish` to the workspace's rows, when the ledger's heads are final whatever order pages came in. */
  again?: true;
};

/** A fact batch from the review queue (lib/canon/gate.ts CANON_PROPOSAL_OP): people decide its facts one by one there, never as a plan. */
const PROPOSAL_OP = "canon.propose_facts";
const UNAPPLIED = new Set(["draft", "pending_approval", "approved"]);
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

export const IMPORTED_RULE = "Imported from another workspace. Turn it on to run it on changes from then on.";
export const IMPORTED_TURN = "Imported from another workspace before it ran: it never runs here.";
export const IMPORTED_RUN = "Imported from another workspace before it finished: start it again here.";
export const IMPORTED_KEEPER = "this play was imported from another workspace.";
const importedRefresh = (cadence: unknown) =>
  `Imported from another workspace${typeof cadence === "string" ? `, where it refreshed ${cadence}` : ""}. Turn the refresh on here to start it.`;
/** A run that hadn't finished, as it arrives: failed, with why (`note` where the run keeps no error). */
const stopped = (run: unknown, field: "error" | "note" = "error") =>
  run && typeof run === "object" && (run as Row).status === "running" ? { ...(run as Row), status: "failed", [field]: IMPORTED_RUN } : run;
const unless = (row: Row, key: string, value: unknown) => (value === undefined ? without(row, key) : { ...row, [key]: value });

export const IMPORTED_PLAN = "Imported from another workspace before it was applied, so it arrived cancelled: an approval given there doesn't carry over. Plan the change again here.";

export const ARRIVALS: Readonly<Record<string, Arrival>> = {
  sequenceLaunches: {
    why: "arrives paused with its approval spent: sending needs a member here to approve it again",
    fields: ["state", "authorizationEpoch"],
    // A new epoch, as a pause makes (lib/sequences/lifecycle.ts): nothing approved under the source's epoch can send.
    apply: (row) => ({ ...row, state: row.state === "active" ? "paused" : row.state, authorizationEpoch: Number(row.authorizationEpoch ?? 0) + 1 }),
  },
  sequenceEnrollments: {
    why: "arrives paused, and resumes only under a launch approved here",
    fields: ["state"],
    apply: (row) => ({ ...row, state: row.state === "pending" || row.state === "active" ? "paused" : row.state }),
  },
  automationRules: {
    why: "arrives paused; turning it on starts it from that moment",
    fields: ["status", "pausedReason", "activeSince", "startSeqs", "nextSlotAt", "slotRun"],
    // activeSince and startSeqs at this workspace's heads: no replayed entry is after them, so none can ever match.
    apply: (row, at) => ({ ...without(row, "nextSlotAt", "slotRun"), status: "paused", pausedReason: IMPORTED_RULE, activeSince: at.now, startSeqs: at.heads }),
    again: true,
  },
  routingRules: {
    why: "arrives turned off",
    fields: ["isActive"],
    apply: (row) => ({ ...row, isActive: false }),
  },
  patchPlans: {
    why: "an unapplied plan arrives cancelled, with the reason; an applied one is history",
    fields: ["status", "error", "approvedBy", "approvedAt", "approvedOperationIds", "valueOverrides", "applyClaim"],
    apply: (row) => {
      const kept = without(row, "applyClaim");
      // A review-queue batch awaiting review stays: its facts are reviewed here, one by one, and it can't be applied.
      const reviewBatch = row.operation === PROPOSAL_OP && row.status === "pending_approval";
      if (!UNAPPLIED.has(row.status as string) || reviewBatch) return kept;
      return { ...without(kept, "approvedBy", "approvedAt", "approvedOperationIds", "valueOverrides"), status: "cancelled", error: IMPORTED_PLAN };
    },
  },
  agents: {
    why: "arrives paused with its Slack messages off, and with no grants and no webhook secret: resuming it here runs it on what happens from then on",
    // Slack too: a paused agent still reports each skipped turn there (lib/agents/slack.ts shouldNotify).
    fields: ["pause", "slack"],
    apply: (row, at) => ({ ...without(row, "slack"), pause: { reason: "imported", at: at.now } }),
  },
  agentTurns: {
    why: "a turn that hadn't run arrives skipped, so resuming its agent never runs it",
    fields: ["status", "skip", "dispatchedAt"],
    apply: (row) => (row.status === "queued" || row.status === "running" ? { ...without(row, "dispatchedAt"), status: "skipped", skip: { reason: "imported", message: IMPORTED_TURN } } : row),
  },
  researchAgents: {
    why: "its scheduled refresh arrives off; turning it on here starts it a cadence from then",
    fields: ["refreshCadence", "refreshNextAt", "refreshHold"],
    apply: (row, at) => (row.refreshCadence === undefined && row.refreshNextAt === undefined ? row
      : { ...without(row, "refreshCadence", "refreshNextAt"), refreshHold: { message: importedRefresh(row.refreshCadence), at: at.now } }),
  },
  researchRuns: {
    why: "a run that hadn't finished arrives cancelled; the others are history",
    // A cursor is this deployment's place in a scan the source ran: it means nothing here.
    fields: ["status", "error", "cursor"],
    apply: (row) => ({ ...without(row, "cursor"), ...(row.status === "running" ? { status: "cancelled", error: IMPORTED_RUN } : {}) }),
  },
  dealPlays: {
    why: "its keeper arrives off until a person runs it here; research that hadn't finished arrives failed",
    fields: ["keeperPaused", "research", "stateRun", "peopleResearch", "stateDueAt"],
    apply: (row, at) => {
      let out: Row = { ...without(row, "stateDueAt"), keeperPaused: { reason: IMPORTED_KEEPER, at: at.now } };
      out = unless(out, "research", stopped(row.research));
      out = unless(out, "stateRun", stopped(row.stateRun));
      return unless(out, "peopleResearch", stopped(row.peopleResearch, "note"));
    },
  },
  dealPlaySteps: {
    why: "a LinkedIn step handed to a cadence arrives planned again: the cadence and its sender stay with the source",
    fields: ["queuedAt"],
    apply: (row) => without(row, "queuedAt"),
  },
  conversations: {
    why: "reading the thread for facts arrives off; a new message here starts it again",
    fields: ["extractDueAt"],
    apply: (row) => without(row, "extractDueAt"),
  },
  dialerSettings: {
    why: "call recording arrives off; calling needs a number connected here",
    fields: ["record"],
    apply: (row) => ({ ...row, record: false }),
  },
  recordingPolicy: {
    why: "call recording arrives off; the consent text and the domains never recorded come along",
    fields: ["callRecording"],
    apply: (row) => ({ ...row, callRecording: false }),
  },
  fieldConsolidationRuns: {
    why: "a run that wasn't applied arrives failed: preview it again here against a CRM connected here",
    fields: ["status", "error"],
    apply: (row) => (["previewing", "ready", "applying", "undoing"].includes(row.status as string) ? { ...row, status: "failed", error: IMPORTED_RUN } : row),
  },
  hierarchyScans: {
    why: "a scan that hadn't finished arrives failed",
    fields: ["status", "error"],
    apply: (row) => (row.status === "reading" ? { ...row, status: "failed", error: IMPORTED_RUN } : row),
  },
  hierarchyResearch: {
    why: "research that hadn't finished arrives failed",
    fields: ["status", "error"],
    apply: (row) => (row.status === "running" ? { ...row, status: "failed", error: IMPORTED_RUN } : row),
  },
  approvalRequests: {
    why: "an open or granted approval arrives cancelled with its plan",
    fields: ["status", "reason"],
    apply: (row) => (row.status === "pending" || row.status === "approved" ? { ...row, status: "cancelled", reason: IMPORTED_PLAN } : row),
  },
};

/** The row as it arrives: `apply`, refusing any change to a field the arrival doesn't declare. */
export function arrive(table: string, a: Arrival, row: Row, at: ArrivalAt): Row {
  const out = a.apply(row, at);
  const keys = new Set([...Object.keys(row), ...Object.keys(out)]);
  for (const k of keys) if (!a.fields.includes(k) && JSON.stringify(out[k]) !== JSON.stringify(row[k])) throw new Error(`${table}: its arrival changed ${k}, which it doesn't declare`);
  return out;
}

/**
 * Where an actor's switch lives: rows of `table` in the workspace, read through `index` (first field `orgId`).
 * `open` says whether one row could act now; absent, any row could. With `parent`, the rows hang under the
 * mechanism's switch on that table, and `index`'s first field is the parent row's id.
 */
export type Switch = { table: string; index: string; open?: (row: Row) => boolean; parent?: string };

export type Mechanism = {
  key: string;
  /** What it does outward or on its own. */
  does: string;
  /** The code that decides "may this happen now". */
  gate: string;
  /** How an import brings it, or why it doesn't. */
  arrives: string;
  /** Rows an archive may bring. After an import none may be open, and finish refuses while one is. */
  imported: readonly Switch[];
  /** Connections and grants only this deployment makes. An import never writes them; the report counts them. */
  here: readonly Switch[];
  /** What starts it without a person: cron functions (internal.<module>.<fn>) and HTTP route registrations (convex/http.ts). */
  runs: readonly string[];
};

const any = (table: string, index = "by_orgId"): Switch => ({ table, index });

export const CENSUS: readonly Mechanism[] = [
  {
    key: "sequence-email", does: "send a sequence's automatic emails (canonical launches)",
    gate: "convex/lib/sequences/lifecycle.ts:282 (launch active), :279 (enrollment active), :152 (a member approves a paused launch)",
    arrives: "launches paused under a new authorization epoch; enrollments paused; outbox requests are this deployment's and never move",
    imported: [
      { table: "sequenceLaunches", index: "by_orgId_and_moduleId", open: (r) => r.state === "active" },
      { table: "sequenceEnrollments", index: "by_orgId_and_moduleId_and_moduleEnrollmentKey", open: (r) => r.state === "pending" || r.state === "active" },
    ],
    here: [any("outboxRequests", "by_orgId_moduleId_projection_collection_projection_key"), any("mailboxSendGrants", "by_orgId_and_ownerId")],
    runs: [],
  },
  {
    key: "outbox", does: "deliver queued email, Slack and webhook messages",
    gate: "convex/outboundDispatch.ts:85 (queued outboundMessages rows)",
    arrives: "the queue and its targets are this deployment's: never in an archive",
    imported: [],
    here: [any("outboundMessages", "by_orgId_and_at"), any("outboundTargets", "by_orgId_and_channel_and_name")],
    runs: ["internal.outboundDispatch.tick", "registerUnsubscribeRoute"],
  },
  {
    key: "email", does: "send one email from a member's linked mailbox",
    gate: "convex/emailAccounts.ts:146 claimSend (a linked emailAccounts row)",
    arrives: "mailboxes are this deployment's; a send's history needs its mailbox, so it is left out and counted (the email itself moves as the person's email activity)",
    imported: [{ table: "emailSends", index: "by_orgId_and_contactId", open: (r) => r.state === "sending" || r.state === "unknown" }],
    here: [any("emailAccounts")],
    runs: [],
  },
  {
    key: "linkedin", does: "send LinkedIn invites and messages",
    gate: "convex/linkedinWorker.ts:69 (senders with status ok), :132 (cadence active)",
    arrives: "cadences and enrollments need their sender, which never moves, so each is left out and counted (the touches themselves are on each person's activity)",
    imported: [{ table: "linkedinCadences", index: "by_orgId", open: (r) => r.status === "active" }, { table: "linkedinEnrollments", index: "by_orgId_and_contactId", open: (r) => !["done", "withdrawn", "stopped", "failed", "replied"].includes(r.state as string) }],
    here: [any("linkedinAccounts")],
    runs: ["internal.linkedinWorker.tick", "internal.linkedinFeeds.refreshSenders", "internal.linkedinActions.ensureWebhooksDaily", "registerLinkedinRoutes"],
  },
  {
    key: "dialer", does: "place, record and transcribe calls",
    gate: "convex/dialer.ts:105 (a number on this deployment's telephony account)",
    arrives: "numbers, credentials and sessions never move; settings and the recording policy arrive with recording off; a call needs its session, so it is left out and counted (the call is on each person's activity, and its recording, transcript and insights come along)",
    imported: [
      { table: "dialerSettings", index: "by_orgId", open: (r) => r.record === true },
      { table: "recordingPolicy", index: "by_orgId", open: (r) => r.callRecording === true },
      { table: "dialerCalls", index: "by_orgId_and_contactId", open: (r) => ["dialing", "ringing", "answered"].includes(r.state as string) },
    ],
    here: [any("dialerNumbers")],
    runs: ["internal.dialer.reapExpired", "registerDialerRoutes"],
  },
  {
    key: "record-webhook", does: "deliver record changes to an admin's URL",
    gate: "convex/recordWebhooks.ts:326 (enabled endpoints), :71 (a new endpoint's cursor starts at the heads)",
    arrives: "endpoints carry their secret and never move; the import stops while one is enabled here (workspaceImport.ts actorsIn)",
    imported: [],
    here: [{ table: "recordWebhookEndpoints", index: "by_orgId", open: (r) => r.enabled === true }],
    runs: ["internal.recordWebhooks.sweep"],
  },
  {
    key: "crm-write", does: "write to HubSpot or Salesforce: a patch plan's apply, a sync's write-back",
    gate: "convex/lib/patchPlanGuards.ts:18 (approved), convex/patchPlans.ts:94 (a connected CRM), convex/moduleGrants.ts:166 (a module grant's apply)",
    arrives: "unapplied plans cancelled with the reason and their approval requests cancelled; applied plans as history; CRM connections and grants never move",
    imported: [
      { table: "patchPlans", index: "by_orgId", open: (r) => r.status === "approved" || r.applyClaim !== undefined || (UNAPPLIED.has(r.status as string) && r.operation !== PROPOSAL_OP) },
      { table: "approvalRequests", index: "by_orgId", open: (r) => r.status === "pending" || r.status === "approved" },
    ],
    here: [any("integrations"), any("moduleGrants", "by_orgId_and_moduleId")],
    runs: ["internal.integrationActions.runScheduledSyncs", "internal.salesforceSync.tick", "internal.canon.sweepPartyMirror", "/api/hubspot/callback", "/api/salesforce/callback", "/record-service/changes"],
  },
  {
    key: "automation", does: "run an automation rule's actions on record changes or on its schedule",
    gate: "convex/automations.ts:701 (active rules), :722 (activeSince and startSeqs), :882 (still active at each step), requirePerson (only a person approves a proposal or turns a rule on)",
    arrives: "paused, with activeSince and startSeqs at the end of the import; turning one on starts both again from that moment",
    imported: [{ table: "automationRules", index: "by_orgId_and_status", open: (r) => r.status === "active" }],
    here: [],
    runs: ["internal.automations.sweep"],
  },
  {
    key: "routing", does: "assign owners from a routing rule's members",
    gate: "convex/automations.ts:806 (the routing rule is on)",
    arrives: "turned off",
    imported: [{ table: "routingRules", index: "by_orgId", open: (r) => r.isActive === true }],
    here: [],
    runs: [],
  },
  {
    key: "agent", does: "run an agent's turns, its webhook and its Slack messages",
    gate: "convex/agentTurns.ts:450 startTurn (paused or archived), :319 admit (standing), :261 webhookSecret (a secret made here), convex/lib/agents/grants.ts (standing grants)",
    arrives: "paused with Slack off; turns that hadn't run arrive skipped; grants, webhook secrets and agent sign-ins never move",
    imported: [
      { table: "agents", index: "by_orgId_and_slug", open: (r) => (!r.pause && r.archivedAt === undefined) || r.slack !== undefined },
      { table: "agentTurns", index: "by_agentId_and_createdAt", parent: "agents", open: (r) => r.status === "queued" || r.status === "running" },
    ],
    here: [{ table: "agentGrants", index: "by_agentId", parent: "agents", open: (r) => r.revokedAt === undefined }, { table: "agentWebhooks", index: "by_agentId", parent: "agents" }],
    runs: ["registerAgentWebhookRoutes", "registerPiRoute"],
  },
  {
    key: "research", does: "refresh AI fields and run research on a schedule, on a member's ChatGPT plan",
    gate: "convex/researchAgents.ts:1035 (refreshNextAt due), :1043 (its agent may act)",
    arrives: "refresh off; runs that hadn't finished arrive cancelled",
    imported: [
      { table: "researchAgents", index: "by_orgId_and_slug", open: (r) => r.refreshNextAt !== undefined },
      { table: "researchRuns", index: "by_orgId_and_createdAt", open: (r) => r.status === "running" },
    ],
    here: [],
    runs: ["internal.researchAgents.startDueRefreshes"],
  },
  {
    key: "signals", does: "check job boards for account signals on a schedule",
    gate: "convex/signals.ts:129 (signalWatch due)",
    arrives: "the watch is this deployment's and never moves; found signals move as history",
    imported: [],
    here: [any("signalWatch")],
    runs: ["internal.signals.startDue"],
  },
  {
    key: "deal-play", does: "check each open deal's play and draft its touches",
    gate: "convex/dealPlays.ts:849 duePlays and :949 playsOfContact (keeperPaused), convex/dealPlayKeeper.ts:168 tick, convex/dealState.ts:148 runDue (stateDueAt)",
    arrives: "the keeper off until a person runs it on the play; unfinished research failed; LinkedIn steps unqueued (cadences and senders stay with the source)",
    imported: [
      { table: "dealPlays", index: "by_orgId_and_streamId", open: (r) => !r.keeperPaused || r.stateDueAt !== undefined || [r.research, r.stateRun, r.peopleResearch].some((x) => (x as Row | undefined)?.status === "running") },
      { table: "dealPlaySteps", index: "by_playId", parent: "dealPlays", open: (r) => r.queuedAt !== undefined },
    ],
    here: [],
    runs: ["internal.dealPlayKeeper.tick"],
  },
  {
    key: "hierarchy", does: "move parent companies and consolidate fields through patch plans",
    gate: "engine/src/accountHierarchy/policy.ts:61 (every proposal needs approval), convex/accountHierarchy.ts (a person starts each scan, research and decision), convex/fieldConsolidations.ts (a person previews and applies each run, through a connected CRM)",
    arrives: "settings as they were (nothing in them is automatic); unfinished scans, research and consolidation runs arrive failed; parent disagreements stay with the CRM connection, and its next sync finds them again",
    imported: [
      { table: "hierarchyScans", index: "by_orgId", open: (r) => r.status === "reading" },
      { table: "hierarchyResearch", index: "by_scanId", parent: "hierarchyScans", open: (r) => r.status === "running" },
      { table: "fieldConsolidations", index: "by_orgId", open: () => false },
      { table: "fieldConsolidationRuns", index: "by_consolidationId_and_createdAt", parent: "fieldConsolidations", open: (r) => ["previewing", "ready", "applying", "undoing"].includes(r.status as string) },
    ],
    here: [],
    runs: [],
  },
  {
    key: "module", does: "run module jobs, schedules, effects and visitor links",
    gate: "convex/moduleJobs.ts:857 (installed packages); a module's jobs are this deployment's (read only through lib/modules/jobs.ts)",
    arrives: "module code is never installed from an archive and jobs never move",
    imported: [],
    // What can run here is what is installed here: the import never installs a module.
    here: [{ table: "modulePackages", index: "by_orgId_and_status", open: (r) => r.status === "installed" }],
    runs: ["internal.moduleJobs.sweep", "internal.moduleDefaults.sweep", "internal.audienceImport.sweep", "internal.visits.notifyExpiring", "registerModuleUploadRoute"],
  },
  {
    key: "intake", does: "read connected mail, LinkedIn chats, meetings and lead feeds into records",
    gate: "convex/conversationExtract.ts:36 (conversations due), connector links and integrations (this deployment's)",
    arrives: "conversations arrive with extraction off; mailboxes, LinkedIn senders, connector links and integrations never move",
    imported: [{ table: "conversations", index: "by_orgId", open: (r) => r.extractDueAt !== undefined }],
    here: [any("connectorLinks", "by_orgId_and_connector_and_userId")],
    runs: ["internal.conversationExtract.startDue", "internal.conversations.reconcile", "internal.granolaActions.tick", "internal.expleeActions.tick", "registerEmailLogRoutes", "registerConnectorWebhookRoutes"],
  },
];

/**
 * Crons and routes that act for no workspace's records, or only rebuild what Canon derives: each with why it is
 * outside the census.
 */
export const QUIET: Readonly<Record<string, string>> = {
  "internal.audiences.refreshSummaries": "recomputes audience counts",
  "internal.operatorDashboards.refreshEdits": "Canon's operator dashboard",
  "internal.marketSize.warm": "market sizes shared by every workspace",
  "internal.integrations.endStaleSyncs": "ends sync runs that outlived their action",
  "internal.operatorIntakeActions.reconcileAndRecover": "Canon's operator bug intake",
  "internal.operatorTools.purgeExpiredStates": "Canon's operator sign-in states",
  "internal.apiIdempotency.purgeExpired": "deletes record creates' idempotency keys past their day",
  "internal.memberCredentials.purgeExpiredLocalSessions": "deletes self-hosted sign-in sessions past their expiry",
  "internal.staging.expire": "expires fills held for review, which never move",
  "/clerk-webhook": "sign-in",
  "/stripe/billing-webhook": "billing",
  ledgerFeedRoute: "reads the ledger for the record service",
  registerOperatorRoutes: "Canon's operator tools",
};

/** Field names that say a row is switched on, scheduled or due: an imported table with one has an arrival or is INERT. */
export const SWITCH_FIELDS = ["status", "state", "isActive", "enabled", "active", "nextAt", "nextRunAt", "refreshNextAt", "nextSlotAt", "schedule", "autoApply"] as const;

/** Imported tables with a field named like a switch that turns nothing on: each with why. */
export const INERT: Readonly<Record<string, string>> = {
  users: "a member's active flag: imported members arrive inactive and never sign in",
  pipelineStageConfigs: "a stage in use",
  recipeRevisions: "a recipe's draft or published settings over Canon's own pages and scoring",
  suppressions: "who must never be contacted: it only holds sends back",
  operationAuditLog: "what happened, as history",
  automationVersions: "a rule's proposed or past document: a proposal does nothing until an admin here approves it, and that admin becomes who the rule acts as; the rule row is the switch",
  battlecards: "a battlecard in use",
  facts: "a fact's review state; accepting one writes Canon's own field",
  patchOperations: "a plan's operations act only through their plan",
  emailSends: "a send's outcome: rows arrive only with their mailbox, which never moves",
  icps: "an ICP's draft or published state scores records",
  tamSuggestionRuns: "a finished suggestion run",
  icpChallengeRuns: "a finished challenge run",
  marketSourceSearches: "a finished search",
  suppressionEvents: "who unsubscribed or bounced",
  crmOpportunities: "a hygiene finding's state",
  campaigns: "a campaign's plan",
  onboardingPlans: "a plan's state",
  onboardingProgress: "progress through a plan",
  partners: "a partner's state",
  gtmPlans: "a plan's state",
  budgets: "a budget's state",
  approvalWorkflows: "an approval workflow's definition, run only by a person's request",
  leadScoringModels: "a scoring model's state",
  customerHealthConfigs: "a health model's state",
  scorecardConfigs: "a scorecard's state",
  abmLists: "a list's state",
  abmPlays: "a play's plan",
  marketRuns: "a finished map run",
  playbooks: "a playbook's state",
  canonAutoAcceptRules: "auto-accepts facts as they arrive; a fact arrives already decided",
  recipeEnablements: "which templates and modules are on: a module's needs that module installed here",
  researchTraces: "how a finished record's research went",
  linkedinCadences: "rows arrive only with their sender, which never moves",
  linkedinEnrollments: "rows arrive only with their sender, which never moves",
  dialerCalls: "rows arrive only with their dialer session, which never moves",
  callInsights: "an insight's review state",
  callInsightTags: "a tag the next call's analysis asks about; analysis runs when a call arrives",
  callSuggestions: "a suggestion a person accepts or dismisses",
  fieldConsolidationWrites: "a write acts only through its run",
};
