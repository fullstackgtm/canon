"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { KeyRound, Loader2, RefreshCw, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { formatRelativeTime } from "./call-provider-card";

/** Explee: the workspace's own API key, checked and stored encrypted. Hot leads come in on their own every 10 minutes. */
export function ExpleeControls() {
  const status = useQuery(api.explee.status);
  const connect = useAction(api.expleeActions.connect);
  const syncNow = useAction(api.expleeActions.syncNow);
  const disconnect = useMutation(api.explee.disconnect);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="explee-card">
      {status?.connected ? (
        <>
          <p className="text-sm">
            {status.imported.toLocaleString("en-US")} hot {status.imported === 1 ? "lead" : "leads"} imported · last checked {formatRelativeTime(status.lastSyncAt ?? undefined)}
          </p>
          {status.lastSyncStatus === "error" && status.lastSyncError && <p className="mt-1 text-sm text-destructive">{status.lastSyncError}</p>}
          {status.recent.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {status.recent.map((r) => (
                <li key={r.contactId} className="flex justify-between gap-3">
                  <Link href={`/dashboard/records/contact/${encodeURIComponent(r.contactId)}`} className="hover:underline">
                    {r.name} <span className="text-muted-foreground">· {r.company}</span>
                  </Link>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(r.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => {
                const r = await syncNow({});
                void toast.success(r.imported ? `${r.imported} new hot ${r.imported === 1 ? "lead" : "leads"} added` : "No new hot leads");
              })}
              className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check now
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => { await disconnect({}); void toast.success("Explee disconnected"); })}
              className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="h-4 w-4" /> Disconnect
            </button>
          </div>
        </>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await connect({ apiKey: key });
              setKey("");
              void toast.success("Explee connected. Hot leads are on their way.");
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label="Explee API key"
            placeholder="Explee API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-72 rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect Explee
          </button>
          <p className="w-full text-xs text-muted-foreground">Create a key at explee.com, API keys.</p>
        </form>
      )}
    </div>
  );
}
