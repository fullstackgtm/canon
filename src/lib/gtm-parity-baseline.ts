/**
 * Dashboard writes (mutations and actions) that are not yet on the agent
 * surface (canon MCP tools, the canon CLI, /api/v1). The interaction-parity
 * audit (scripts/fsgtm.ts) fails on any uncovered dashboard function that is
 * not listed here, and on any entry here that is now covered, human-only, or
 * no longer called from the dashboard. The list can only shrink: cover the
 * function (or mark it in gtm-human-only-mutations.ts) and delete the line.
 *
 * Reasons:
 * - read: an action that only reads, so it is not a write.
 * - human-only-candidate: should move to gtm-human-only-mutations.ts with a reason.
 * - todo: a real write that still needs a tool.
 */
export type GtmParityReason = "read" | "human-only-candidate" | "todo";

export const gtmParityBaseline: Readonly<Record<string, GtmParityReason>> = {
  // read
  "api.addRecords.previewMarket": "read",
  // A record's conversations; their /mcp tools are docs/conversation-intake.md CI5.
  "api.conversationView.forRecord": "read",
  "api.csvImports.preview": "read",
  "api.hubspotImportActions.portalCounts": "read",
  "api.icps.sizes": "read",
  "api.leadConversion.preview": "read",
  "api.linkedinCadences.previewEnroll": "read",
  "api.marketSize.facets": "read",
  "api.records.list": "read",
  "api.records.listContacts": "read",
  "api.researchAgentActions.previewRun": "read",
  "api.staging.countSelection": "read",
  // human-only-candidate
  "api.agentSlack.connect": "human-only-candidate",
  "api.agentSlack.disconnect": "human-only-candidate",
  "api.agentSlack.sendTest": "human-only-candidate",
  "api.agentTurns.rotateSecret": "human-only-candidate",
  "api.audienceActions.connectSequencer": "human-only-candidate",
  "api.audiences.disconnectSequencer": "human-only-candidate",
  "api.billing.openPortal": "human-only-candidate",
  "api.chatgptAuth.disconnect": "human-only-candidate",
  "api.chatgptAuthActions.start": "human-only-candidate",
  "api.credits.buy": "human-only-candidate",
  "api.devSeed.ensureWorkspace": "human-only-candidate",
  "api.emailAccounts.disconnect": "human-only-candidate",
  "api.emailActions.startConnect": "human-only-candidate",
  "api.explee.disconnect": "human-only-candidate",
  "api.expleeActions.connect": "human-only-candidate",
  "api.hubspot.disconnectWithRevocation": "human-only-candidate",
  "api.hubspotActions.connectWithToken": "human-only-candidate",
  "api.hubspotActions.getAuthUrl": "human-only-candidate",
  "api.linkedin.disconnect": "human-only-candidate",
  "api.linkedin.updateSettings": "human-only-candidate",
  "api.linkedinActions.startConnect": "human-only-candidate",
  "api.salesforce.disconnectWithRevocation": "human-only-candidate",
  "api.salesforceActions.getAuthUrl": "human-only-candidate",
  "api.tamSettings.setSeatPrice": "human-only-candidate",
  // todo
  "api.addRecords.startAccounts": "todo",
  "api.objects.createMany": "todo",
  "api.addRecords.startMarket": "todo",
  "api.audienceActions.exportViewCsv": "todo",
  "api.csvImports.claimUpload": "todo",
  "api.csvImports.generateUploadUrl": "todo",
  "api.csvImports.start": "todo",
  "api.leadConversion.convert": "todo",
  "api.emailActions.draftToContact": "todo",
  "api.emailActions.sendToContact": "todo",
  "api.expleeActions.syncNow": "todo",
  "api.hubspotActions.syncAll": "todo",
  "api.integrations.stopSync": "todo",
  "api.linkedinCadences.enroll": "todo",
  "api.marketActions.runCapture": "todo",
  "api.marketActions.runClassify": "todo",
  "api.objects.bulk": "todo",
  "api.paidRuns.start": "todo",
  "api.providerTests.run": "todo",
  "api.salesforceActions.syncAll": "todo",
  "api.tamSuggestions.add": "todo",
  "api.tamSuggestions.start": "todo",
};
