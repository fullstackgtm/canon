"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows } from "@/components/dashboard";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type Policy = NonNullable<FunctionReturnType<typeof api.outboundEmailPolicy.get>>;
const input = "w-full border border-border bg-background px-2 py-1.5 text-sm";

export function OutboundEmailPolicySection() {
  const context = useQuery(api.organizations.context);
  const available = context?.features?.outboundEmailPolicy === true && context?.organization?.currentUserRole === "admin";
  const policy = useQuery(api.outboundEmailPolicy.get, available ? {} : "skip");
  if (!available || policy === null) return null;
  if (policy === undefined) return <LoadingRows count={2} height="h-24" />;
  return <PolicyForm key={JSON.stringify(policy)} initial={policy} />;
}

function PolicyForm({ initial }: { initial: Policy }) {
  const [postalAddress, setPostalAddress] = useState(initial.postalAddress);
  const [cap, setCap] = useState(initial.recipientWeeklyCap);
  const [busy, setBusy] = useState(false);
  const save = useMutation(api.outboundEmailPolicy.save);
  return <section className="space-y-3 border border-border bg-card p-4" aria-label="Automated email policy">
    <h2 className="font-medium">Automated email policy</h2>
    <p className="text-sm text-muted-foreground">These settings prepare future automated email. Delivery is not enabled.</p>
    <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      try { await save({ postalAddress, recipientWeeklyCap: cap }); void toast.success("Outbound email policy saved"); }
      catch (cause) { void toast.error(getErrorMessage(cause)); } finally { setBusy(false); }
    }}>
      <label className="grid gap-1 text-xs">Workspace postal address
        <textarea className={input} rows={3} maxLength={500} value={postalAddress} onChange={(event) => setPostalAddress(event.target.value)} disabled={busy} />
      </label>
      <p className="text-xs text-muted-foreground">Plain text for the email footer. Leaving this empty prevents future automated email preparation.</p>
      <label className="grid max-w-52 gap-1 text-xs">Weekly emails per recipient
        <select className={input} value={cap} onChange={(event) => setCap(Number(event.target.value))} disabled={busy}>
          {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Across the workspace, up to three automated emails per recipient per week.</p>
      <p className="text-xs text-muted-foreground">Fallback timezone: {initial.timezone}. Change it in Workspace settings.</p>
      <button type="submit" disabled={busy} className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40">{busy ? "Saving..." : "Save email policy"}</button>
    </form>
  </section>;
}
