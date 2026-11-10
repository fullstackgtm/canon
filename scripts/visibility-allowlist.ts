/**
 * Public Convex functions the visibility inventory (scripts/visibility-inventory.ts)
 * flags that are not judged by permissions.ts or the scoped record client, each
 * under the reason it needs none. tests/visibilityInventory.test.ts fails on a
 * flagged function that is neither judged nor listed here, and on an entry that
 * is no longer flagged-and-unjudged (stale). Add a function here only when none
 * of its answers names a record the caller's role could hide.
 */
export const ALLOWLIST: Record<string, string[]> = {
  "Local auth broker only: requireBroker checks local mode, the service issuer and the dedicated broker subject; reads login credentials or registers a member, never returns CRM records": [
    "localAuth.credential", "localAuth.register",
  ],
  "Visitor link handshake: signed visitorScope accepts a self-declared label and returns only public grant metadata, never Canon records": [
    "visits.visitOpen",
  ],
  "Email verification: signed visitorScope admits only a cookie-bound grant session, queues a gated system notice or verifies its single-use code, and returns no records, email eligibility or outbox details": [
    "visits.visitRequestCode", "visits.visitVerifyCode",
  ],
  "Signed visitorScope grants only the declared module projection, operation, transition or file capability; Canon attribution checks and observation writes stay internal": [
    "visits.visitFile", "visits.visitOp", "visits.visitPage", "visits.visitTransition", "visits.visitUpload",
  ],
  "The caller's own data: their dial session, list preview and calls, their connected accounts": [
    "conversations.deleteRead",
    "dialer.nextOfList", "dialer.overview", "dialer.profile",
    "emailAccounts.mine", "linkedin.mine",
  ],
  "The caller's own cadence (editableCadence: its sender or an admin); returns nothing about its people": [
    "linkedinCadences.setStatus", "linkedinCadences.stopEnrollment", "linkedinCadences.update",
  ],
  "A CLI token's own write (its checkpoint, artifact or run record); returns its id or revision": [
    "acquisitionCheckpointActions.upsert", "cliArtifactActions.upsert", "cliArtifacts.saveDraft", "cliRunsActions.recordRun",
  ],
  "Aggregate counts or metadata with no record identity": [
    "activity.feed", "audiences.history", "canonGate.settings", "cliRuns.listRuns",
    "linkedinCadences.list", "marketSize.facets", "salesforceSync.getState", "usage.summary",
  ],
  "Settings and definitions (admins, or managers for routing and integrations); return no record": [
    "canonGate.setAutoAcceptRule", "integrations.updateSettings", "leadScoring.createRoutingRule", "leadScoring.updateRoutingRule",
    "patchPlans.recoverStaleApplyClaim", "researchAgents.create", "users.createMember",
  ],
  "Sample data on dev and local stacks only, for admins: writes fixed sample records and returns only which sample sets are loaded, never a record": [
    "sampleData.load", "sampleData.status",
  ],
  "Starts, stops or runs a workspace job (a sync or import of the connected CRM, a signal check, a suggestion run); returns a job id or counts, and what it writes is judged where it is read": [
    "expleeActions.connect", "expleeActions.syncNow", "granola.disconnect", "granola.setFolders", "hubspotActions.syncAll", "hubspotImport.resume",
    "hubspotImport.start", "icpChallenge.start", "providerTests.run", "salesforceActions.syncAll", "salesforceImport.start",
    "signals.checkNow", "signals.setEnabled", "staging.discard", "tamSuggestions.start",
  ],
  "A website's domain (the user's own company, a homepage visitor's), not a record in the register": [
    "icpActions.deriveFromWebsite", "researchSessions.claim", "researchSessions.start",
  ],
  "Anonymous waitlist opt-in: an opaque research-session token permits a rate-limited submission and returns only a saved flag, never workspace records": [
    "researchSessions.joinWaitlist",
  ],
  "Workspace import: importCaller admits only an import key a human admin created for their own workspace, on a deployment with import switched on; writes that one empty workspace from the uploaded archive and returns counts and refusals, never an existing record": [
    "workspaceImport.begin", "workspaceImport.importPlan",
  ],
  "Dev tools: refused unless the dev auth bypass is on (local stacks only)": [
    "devSeed.ensureWorkspace", "devSeed.seedConversations", "devSeed.seedLinkedinEnrollment", "devSeed.seedSignalHistory",
  ],
};
