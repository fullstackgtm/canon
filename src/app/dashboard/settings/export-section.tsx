"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

/** Admins only: an export key for `canon workspace export`, shown once. */
export function ExportSection() {
  const status = useQuery(api.workspaceTransfer.exportKeyStatus);
  const create = useMutation(api.workspaceTransfer.createExportKey);
  const revoke = useMutation(api.workspaceTransfer.revokeExportKey);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!status?.canExport) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().catch((cause) => toast.error(getErrorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-label="Export">
      <h2 className="text-sm font-medium">Export</h2>
      <p className="text-sm text-muted-foreground">
        Export this workspace&apos;s records, history and settings to one archive file with the canon CLI. Integration
        connections, credentials and files stay here.
      </p>
      {key ? (
        <div className="space-y-2 text-sm">
          <p>Copy this key now: it is shown once and works for an hour. Run the command, then paste the key when asked.</p>
          <code className="block break-all bg-muted px-2 py-1 font-mono text-xs">{key}</code>
          <code className="block break-all bg-muted px-2 py-1 font-mono text-xs">canon workspace export --url {origin}</code>
          <p className="text-muted-foreground">The archive holds your CRM data in plain form. Keep it as safe as the workspace itself.</p>
        </div>
      ) : status.expiresAt ? (
        <p className="text-sm text-muted-foreground">An export key is live until {new Date(status.expiresAt).toLocaleTimeString()}.</p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(async () => setKey((await create({})).key))}>
          {status.expiresAt ? "Replace export key" : "Create export key"}
        </Button>
        {status.expiresAt && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => run(async () => { await revoke({}); setKey(null); })}>
            Revoke
          </Button>
        )}
      </div>
    </section>
  );
}
