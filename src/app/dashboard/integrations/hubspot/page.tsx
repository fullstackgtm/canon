"use client";

import { LoadingRows } from "@/components/dashboard";
import { CrmSyncPanel, CrmSyncRunsPanel, HubspotConnectPanel, useCrm } from "../crm-panels";

export default function HubspotPage() {
  const { connection } = useCrm("hubspot");
  if (connection === undefined) return <LoadingRows count={3} />;
  if (!connection?.isActive) return <HubspotConnectPanel />;
  return (
    <div>
      <CrmSyncPanel provider="hubspot" canDisconnect />
      <CrmSyncRunsPanel provider="hubspot" />
    </div>
  );
}
