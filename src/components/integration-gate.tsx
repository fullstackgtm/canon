"use client";

import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { ACTION_INTEGRATIONS, INTEGRATIONS_AVAILABLE, integrationNeeds, type IntegrationFeature } from "../../convex/lib/integrationsAvailable.ts";

export function useIntegrationAvailable(feature: IntegrationFeature): boolean {
  return useQuery(api.integrationsAvailable.status)?.[feature] === true;
}

export type IntegrationRequirement = IntegrationFeature | readonly IntegrationFeature[];

export function IntegrationGate({ feature, children, note = false }: { feature: IntegrationRequirement; children: ReactNode; note?: boolean }) {
  const available = useQuery(api.integrationsAvailable.status);
  if (!available) return null;
  const features = typeof feature === "string" ? [feature] : feature;
  if (!features.some((key) => available[key])) return note ? <p className="p-4 text-sm text-muted-foreground">This feature is off. {features.map(integrationNeeds).join(" or ")}.</p> : null;
  return children;
}

const ROUTES: readonly [string, IntegrationRequirement][] = [
  ["/dashboard/settings/billing", "billing"],
  ["/dashboard/integrations/chatgpt", "chatgpt"],
  ["/dashboard/integrations/gmail", "unipile"],
  ["/dashboard/integrations/linkedin", "unipile"],
  ["/dashboard/integrations/dialer", "dialer"],
  ["/dashboard/linkedin", "unipile"],
  ["/dashboard/m/dialer", "dialer"],
  ["/dashboard/fields", ["chatgpt", "openrouter"]],
  ["/dashboard/agents", "chatgpt"],
];

export function IntegrationRoutes({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const feature = ROUTES.find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1];
  return feature ? <IntegrationGate feature={feature} note>{children}</IntegrationGate> : children;
}

export function IntegrationReport() {
  const available = useQuery(api.integrationsAvailable.status);
  if (!available) return null;
  return <section className="mt-6 border border-border p-4" aria-label="Deployment integrations">
    <h2 className="mb-3 font-medium">Deployment integrations</h2>
    <dl className="space-y-2 text-sm">
      {(Object.keys(INTEGRATIONS_AVAILABLE) as IntegrationFeature[]).map((feature) => <div key={feature} className="flex flex-wrap justify-between gap-x-4">
        <dt>{INTEGRATIONS_AVAILABLE[feature].label}</dt>
        <dd className="text-muted-foreground">{available[feature] ? "On" : `Off. ${integrationNeeds(feature)}`}</dd>
      </div>)}
    </dl>
  </section>;
}

export function IntegrationActionGate({ action, children }: { action: string; children: ReactNode }) {
  const feature = ACTION_INTEGRATIONS[action];
  return feature ? <IntegrationGate feature={feature}>{children}</IntegrationGate> : children;
}
