"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

/** Once this workspace took an import: how many things it brought are still off, and the page that turns them on. */
export function ArrivedOffLink() {
  const data = useQuery(api.workspaceImport.arrivals);
  if (!data?.importedAt) return null;
  return (
    <section className="space-y-2 border-t border-border pt-5" aria-label="Arrived off">
      <h2 className="text-sm font-medium">Arrived off</h2>
      <p className="text-sm text-muted-foreground">
        {data.items.length ? `${data.items.length} ${data.items.length === 1 ? "thing" : "things"} the import brought ${data.items.length === 1 ? "is" : "are"} still off.` : "Everything the import brought switched off is on again."}{" "}
        <Link href="/dashboard/settings/imported" className="text-primary hover:underline">See what arrived off</Link>
      </p>
    </section>
  );
}

/** Admins only, where import is switched on: an import key for `canon workspace import`, shown once. */
export function ImportSection() {
  const status = useQuery(api.workspaceImport.importKeyStatus);
  const create = useMutation(api.workspaceImport.createImportKey);
  const revoke = useMutation(api.workspaceImport.revokeImportKey);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!status?.canImport) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn().catch((cause) => toast.error(getErrorMessage(cause))).finally(() => setBusy(false));
  };
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-label="Import">
      <h2 className="text-sm font-medium">Import</h2>
      <p className="text-sm text-muted-foreground">
        Import an archive exported from another Canon into this workspace with the canon CLI. It only goes into a new,
        empty workspace. Run it with <code className="font-mono text-xs">--dry-run</code> first to see what it would write.
      </p>
      {key ? (
        <div className="space-y-2 text-sm">
          <p>Copy this key now: it is shown once and works for an hour. Run the command, then paste the key when asked.</p>
          <code className="block break-all bg-muted px-2 py-1 font-mono text-xs">{key}</code>
          <code className="block break-all bg-muted px-2 py-1 font-mono text-xs">canon workspace import --dry-run &lt;archive&gt; --url {origin}</code>
        </div>
      ) : status.expiresAt ? (
        <p className="text-sm text-muted-foreground">An import key is live until {new Date(status.expiresAt).toLocaleTimeString()}.</p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => run(async () => setKey((await create({})).key))}>
          {status.expiresAt ? "Replace import key" : "Create import key"}
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
