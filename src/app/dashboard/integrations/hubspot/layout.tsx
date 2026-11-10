"use client";

import { IntegrationPage, IntegrationTabs } from "../integration-ui";

const BASE = "/dashboard/integrations/hubspot";

export default function HubspotLayout({ children }: { children: React.ReactNode }) {
  return (
    <IntegrationPage
      integration="hubspot"
      tabs={
        <IntegrationTabs
          label="HubSpot sections"
          tabs={[
            { href: BASE, label: "Connection" },
            { href: `${BASE}/import`, label: "Import" },
            { href: `${BASE}/fields`, label: "Fields" },
          ]}
        />
      }
    >
      {children}
    </IntegrationPage>
  );
}
