"use client";

import { Panel } from "@/components/salesforce-sync/ui";
import { IntegrationPage } from "../integration-ui";
import { ExpleeControls } from "../explee-card";

export default function ExpleeIntegrationPage() {
  return (
    <IntegrationPage integration="explee">
      <Panel title="Connection">
        <ExpleeControls />
      </Panel>
    </IntegrationPage>
  );
}
