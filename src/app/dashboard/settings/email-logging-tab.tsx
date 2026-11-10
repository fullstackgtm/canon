"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Copy } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const button = "inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40";

/** The signed-in member's private logging address (convex/emailLog.ts), how to use it, and the mail it lately held. */
export function EmailLoggingTab() {
  const data = useQuery(api.emailLog.mine);
  const regenerate = useMutation(api.emailLog.regenerate);
  const [busy, setBusy] = useState(false);
  if (data === undefined) return <LoadingRows count={2} height="h-16" />;
  if (data === null) return <p className="text-sm text-muted-foreground">Email logging isn&apos;t set up on this deployment.</p>;
  const make = async () => {
    if (data.address && !window.confirm("Make a new address? Mail sent to the old one will no longer be logged.")) return;
    setBusy(true);
    try {
      await regenerate({});
      void toast.success(data.address ? "New address made; the old one no longer works" : "Your logging address is ready");
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid max-w-2xl gap-6">
      <section className="grid gap-3 border border-border p-4" aria-label="Your logging address">
        <h2 className="font-medium">Your logging address</h2>
        {data.address ? (
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="email-log-address" className="break-all border border-border bg-muted/40 px-2 py-1 text-sm">{data.address}</code>
            <button type="button" className={button} onClick={() => void navigator.clipboard.writeText(data.address!).then(() => toast.success("Copied"))}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You don&apos;t have an address yet.</p>
        )}
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Add it as BCC when you email a customer, and the email goes on the timeline of the people and companies on it.</li>
          <li>Forward an email you received to it, and it is logged from its original sender, at the time they sent it.</li>
        </ul>
        <p className="text-xs text-muted-foreground">Only mail sent from your own address is logged. Anyone who has this address can log mail as you, so keep it private.</p>
        <div>
          <button type="button" className={button} disabled={busy} onClick={() => void make()}>{data.address ? "Generate a new address" : "Make my address"}</button>
        </div>
      </section>
      {data.held.length > 0 && (
        <section className="grid gap-2 border border-border p-4" aria-label="Not logged">
          <h2 className="font-medium">Not logged</h2>
          <ul className="divide-y divide-border text-sm">
            {data.held.map((h) => (
              <li key={`${h.at}:${h.from}`} className="py-2">
                <div>{h.subject || "(no subject)"}</div>
                <div className="text-xs text-muted-foreground">{[h.from && `from ${h.from}`, new Date(h.at).toLocaleString(), h.reason].filter(Boolean).join(" · ")}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
