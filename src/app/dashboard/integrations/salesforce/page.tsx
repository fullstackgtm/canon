"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { sfSync } from "@/components/salesforce-sync/data";
import { Panel, formatTime } from "@/components/salesforce-sync/ui";
import { CrmSyncPanel, CrmSyncRunsPanel, SalesforceConnectPanel } from "../crm-panels";

export default function SalesforceConnectionPage() {
  const connection = sfSync.useConnection();
  const disconnect = sfSync.useDisconnect();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Panel title="Connection" testId="sf-connection">
        {connection === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : connection && connection.isActive ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Org</dt>
              <dd data-testid="sf-org-name">{connection.displayName ?? connection.externalOrgDomain ?? "Salesforce"}</dd>
              <dt className="text-muted-foreground">Instance</dt>
              <dd className="break-all">{connection.instanceUrl ?? "—"}</dd>
              <dt className="text-muted-foreground">Signed in with</dt>
              <dd>{connection.authMethod === "key" ? "App key (client credentials)" : "Salesforce sign-in"}</dd>
              <dt className="text-muted-foreground">Connected</dt>
              <dd>{formatTime(connection.connectedAt)}</dd>
            </dl>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("Disconnect Salesforce? Sync stops until you reconnect.")) return;
                  await disconnect();
                  toast.success("Salesforce disconnected");
                })
              }
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <p data-testid="sf-not-connected" className="text-sm text-muted-foreground">
            Salesforce is not connected.
          </p>
        )}
      </Panel>
      {connection !== undefined && !connection?.isActive && <SalesforceConnectPanel />}

      <CrmSyncPanel provider="salesforce" />
      <CrmSyncRunsPanel provider="salesforce" />
    </div>
  );
}
