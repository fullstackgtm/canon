"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2, Mail, RefreshCw, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const STATUS_LABEL = { ok: "Linked", credentials: "Needs sign-in", paused: "Paused", disconnected: "Unlinked" } as const;

/** Gmail: the user's own Google accounts, linked through Unipile's hosted login, to send email to contacts from. */
export function GmailControls() {
  const mine = useQuery(api.emailAccounts.mine);
  const startConnect = useAction(api.emailActions.startConnect);
  const disconnect = useMutation(api.emailAccounts.disconnect);
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

  const connect = () =>
    run(async () => {
      const { url } = await startConnect({});
      if (url) window.location.assign(url);
    });

  if (!mine) return null;

  return (
    <div data-testid="gmail-card">
      {!mine.configured ? (
        <p className="text-sm text-muted-foreground">Gmail isn&apos;t set up on this deployment yet.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Canon caps each account at {mine.dailyCap} emails a day.</p>
          {mine.accounts.map((account) => (
            <div key={account._id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3" data-testid="gmail-account">
              <div className="text-sm">
                <div className="font-medium">{account.address}</div>
                <div className="text-xs text-muted-foreground">
                  {STATUS_LABEL[account.status]} · {account.sentLastDay} of {mine.dailyCap} sent in the last 24 hours
                </div>
                {account.statusReason && <div className="text-xs text-amber-600 dark:text-amber-400">{account.statusReason}</div>}
              </div>
              <div className="flex gap-2">
                {account.status !== "ok" && (
                  <button type="button" disabled={busy} onClick={() => void connect()} className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
                    <RefreshCw className="h-4 w-4" /> Sign in again
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => { await disconnect({ accountId: account._id }); void toast.success(`${account.address} unlinked`); })}
                  className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Unplug className="h-4 w-4" /> Unlink
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void connect()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} {mine.accounts.length ? "Link another Gmail account" : "Link Gmail"}
          </button>
        </div>
      )}
    </div>
  );
}
