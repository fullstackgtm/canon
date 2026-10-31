import { INTEGRATIONS_AVAILABLE, integrationEnabled, integrationNeeds, type IntegrationFeature } from "../convex/lib/integrationsAvailable.ts";

for (const feature of Object.keys(INTEGRATIONS_AVAILABLE) as IntegrationFeature[]) {
  const definition = INTEGRATIONS_AVAILABLE[feature];
  const enabled = integrationEnabled(feature);
  console.log(`${definition.label}: ${enabled ? "on" : `off (${integrationNeeds(feature)})`}`);
}
