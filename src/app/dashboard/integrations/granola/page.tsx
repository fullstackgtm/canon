"use client";

import { useQuery } from "convex/react";
import { Panel } from "@/components/salesforce-sync/ui";
import { api } from "../../../../../convex/_generated/api";
import { IntegrationPage } from "../integration-ui";
import { GranolaControls, GranolaMeetings } from "../granola-card";
import { ReadMyMeetings } from "../intake-settings";

export default function GranolaIntegrationPage() {
  const status = useQuery(api.granola.status);
  return (
    <IntegrationPage integration="granola">
      <Panel title="Connection">
        <GranolaControls />
      </Panel>
      <ReadMyMeetings />
      {status?.connected && (
        <Panel title="Meetings">
          <GranolaMeetings />
        </Panel>
      )}
    </IntegrationPage>
  );
}
