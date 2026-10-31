"use client";

import Link from "next/link";
import { LoadingRows } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { CrmSettingsPanel, CrmSyncPanel, CrmSyncRunsPanel, HubspotConnectPanel, useCrm } from "../crm-panels";
import { FreeFillPanel } from "./free-fill-panel";

export default function HubspotPage() {
  const { connection } = useCrm("hubspot");
  if (connection === undefined) return <LoadingRows count={3} />;
  if (!connection?.isActive) return <HubspotConnectPanel />;
  return (
    <div>
      <CrmSyncPanel provider="hubspot" canDisconnect />
      <FreeFillPanel />
      <Panel title="Full import">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            Bring the whole portal over once: every object, its history and its files. The import only reads HubSpot; it never writes to it.
          </p>
          <Link
            href="/dashboard/integrations/hubspot/import"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            Import the whole portal
          </Link>
        </div>
      </Panel>
      <CrmSettingsPanel provider="hubspot" />
      <CrmSyncRunsPanel provider="hubspot" />
    </div>
  );
}
