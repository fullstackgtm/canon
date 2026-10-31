"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { sfSync } from "@/components/salesforce-sync/data";
import { Panel, ReadOnlyToggle, formatTime } from "@/components/salesforce-sync/ui";
import { CrmSettingsPanel, CrmSyncPanel, CrmSyncRunsPanel } from "../crm-panels";

export default function SalesforceConnectionPage() {
  const connection = sfSync.useConnection();
  const state = sfSync.useSyncState();
  const getAuthUrl = sfSync.useGetAuthUrl();
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
          <div className="flex items-center justify-between gap-4">
            <p data-testid="sf-not-connected" className="text-sm text-muted-foreground">
              Salesforce is not connected.
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const { authUrl } = await getAuthUrl();
                  window.open(authUrl, "_blank");
                })
              }
            >
              Connect Salesforce
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Two-way sync" testId="sf-sync-state">
        <ReadOnlyToggle />
        {state && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Inbound mode</dt>
              <dd data-testid="sf-sync-mode">{state.mode === "cdc" ? "Change Data Capture" : `Polling every ${Math.round(state.pollIntervalMs / 1000)}s`}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last inbound</dt>
              <dd>{formatTime(state.lastInboundAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last outbound</dt>
              <dd>{formatTime(state.lastOutboundAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Outbox cursor</dt>
              <dd>{state.outboxCursor ?? "—"}</dd>
            </div>
          </dl>
        )}
      </Panel>

      <CrmSyncPanel provider="salesforce" />
      <CrmSettingsPanel provider="salesforce" />
      <CrmSyncRunsPanel provider="salesforce" />
    </div>
  );
}
