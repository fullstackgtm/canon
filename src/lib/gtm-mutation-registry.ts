import { api } from "../../convex/_generated/api.js";
export const gtmMutationRegistry = {
  "api.modules.revokeLink": api.modules.revokeLink,
  "api.modules.extendLink": api.modules.extendLink,
  "api.abm.addAccount": api.abm.addAccount,
  "api.audiences.update": api.audiences.update,
  "api.audiences.createFromIcp": api.audiences.createFromIcp,
  "api.agents.setOwner": api.agents.setOwner,
  "api.agents.setPaused": api.agents.setPaused,
  "api.agentTurns.create": api.agentTurns.create,
  "api.agentTurns.archive": api.agentTurns.archive,
  "api.agentTurns.testRun": api.agentTurns.testRun,
  "api.agentTurns.setRouting": api.agentTurns.setRouting,
  "api.agentTurns.setCrmTrigger": api.agentTurns.setCrmTrigger,
  "api.agentTurns.setSlack": api.agentTurns.setSlack,
  "api.abm.createList": api.abm.createList,
  "api.abm.generateFromCrm": api.abm.generateFromCrm,
  "api.callIntelligence.analyzeCall": api.callIntelligence.analyzeCall,
  "api.callIntelligence.ingestAndAnalyzeDemo": api.callIntelligence.ingestAndAnalyzeDemo,
  "api.callIntelligence.ingestTranscript": api.callIntelligence.ingestTranscript,
  "api.callIntelligence.proposeDealNextStepPatchPlan": api.callIntelligence.proposeDealNextStepPatchPlan,
  "api.callProviders.connect": api.callProviders.connect,
  "api.callProviders.disconnect": api.callProviders.disconnect,
  "api.cliAuth.approve": api.cliAuth.approve,
  "api.cliAuth.revoke": api.cliAuth.revoke,
  "api.competitive.createCompetitor": api.competitive.createCompetitor,
  "api.competitive.generateFromDeals": api.competitive.generateFromDeals,
  "api.customerHealth.generateFromCrm": api.customerHealth.generateFromCrm,
  "api.deals.updateForecast": api.deals.updateForecast,
  "api.dealLineItems.replace": api.dealLineItems.replace,
  "api.dealGapActions.checkNow": api.dealGapActions.checkNow,
  "api.dealGapActions.scanMine": api.dealGapActions.scanMine,
  "api.dealGapActions.search": api.dealGapActions.search,
  "api.dealLineItems.useAsAmount": api.dealLineItems.useAsAmount,
  "api.gtm.proposeDo": api.gtm.proposeDo,
  "api.hubspot.disconnect": api.hubspot.disconnect,
  "api.enrichFreeFill.coverage": api.enrichFreeFill.coverage,
  "api.enrichFreeFill.createPlan": api.enrichFreeFill.createPlan,
  "api.stripe.disconnect": api.stripe.disconnect,
  "api.icp.createProfile": api.icp.createProfile,
  "api.icps.create": api.icps.create,
  "api.icps.update": api.icps.update,
  "api.icps.setDefault": api.icps.setDefault,
  "api.icps.remove": api.icps.remove,
  "api.icps.importFromResearch": api.icps.importFromResearch,
  "api.icpTree.createNode": api.icpTree.createNode,
  "api.icpTree.updateNode": api.icpTree.updateNode,
  "api.icpTree.removeNode": api.icpTree.removeNode,
  "api.integrations.updateSettings": api.integrations.updateSettings,
  "api.linkedinCadences.create": api.linkedinCadences.create,
  "api.linkedinCadences.update": api.linkedinCadences.update,
  "api.linkedinCadences.setStatus": api.linkedinCadences.setStatus,
  "api.linkedinCadences.stopEnrollment": api.linkedinCadences.stopEnrollment,
  "api.leadScoring.createModel": api.leadScoring.createModel,
  "api.leadScoring.createRoutingRule": api.leadScoring.createRoutingRule,
  "api.onboarding.skipStep": api.onboarding.skipStep,
  "api.onboarding.completePlanTask": api.onboarding.completePlanTask,
  "api.opportunities.dismiss": api.opportunities.dismiss,
  "api.market.createMap": api.market.createMap,
  "api.canonGate.decide": api.canonGate.decide,
  "api.canonGate.resolveContested": api.canonGate.resolveContested,
  "api.canonGate.setAutoAcceptRule": api.canonGate.setAutoAcceptRule,
  "api.canonGate.setOwnership": api.canonGate.setOwnership,
  "api.market.updateMap": api.market.updateMap,
  "api.market.deleteMap": api.market.deleteMap,
  "api.organizations.updateSettings": api.organizations.updateSettings,
  "api.patchPlans.approve": api.patchPlans.approve,
  "api.patchPlans.revokeApproval": api.patchPlans.revokeApproval,
  "api.populateActions.stop": api.populateActions.stop,
  "api.research.generateFromCrm": api.research.generateFromCrm,
  "api.researchAgents.create": api.researchAgents.create,
  "api.researchAgents.setAutoAccept": api.researchAgents.setAutoAccept,
  "api.researchAgents.setRefresh": api.researchAgents.setRefresh,
  "api.researchAgents.remove": api.researchAgents.remove,
  "api.researchAgents.startRun": api.researchAgents.startRun,
  "api.researchAgents.startProbe": api.researchAgents.startProbe,
  "api.researchAgents.cancelRun": api.researchAgents.cancelRun,
  "api.salesforce.disconnect": api.salesforce.disconnect,
  "api.staging.approve": api.staging.approve,
  "api.staging.discard": api.staging.discard,
  "api.users.update": api.users.update,
} as const;

export type GtmMutationName = keyof typeof gtmMutationRegistry;

export function gtmMutationNames() {
  return Object.keys(gtmMutationRegistry) as GtmMutationName[];
}

export function getGtmMutationReference(name: string) {
  return gtmMutationRegistry[name as GtmMutationName] ?? null;
}

export function gtmMutationSurfaceManifest() {
  // previewMode "echo": without apply, the surface echoes the mutation name
  // and args WITHOUT schema validation (the generated Convex `api` carries no
  // runtime arg metadata) — it is not a typed dry-run, and this metadata must
  // not claim one. Only mode=apply executes.
  return {
    ok: true,
    mutations: gtmMutationNames().map((name) => ({
      name,
      previewMode: "echo" as const,
      dryRunDefault: false,
      applyRequires: ["--apply or mode=apply"],
    })),
  };
}
