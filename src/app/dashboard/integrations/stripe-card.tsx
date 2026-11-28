"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Download, ExternalLink, KeyRound, Loader2, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

function money(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return "Metered";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency ?? ""}`.trim();
  }
}

/**
 * Stripe: a restricted read key, then an import that mirrors one contract per
 * subscription with its invoices attached (docs/revenue-contracts.md).
 */
export function StripeControls() {
  const status = useQuery(api.stripe.status);
  const connect = useAction(api.stripeActions.connect);
  const getAuthUrl = useAction(api.stripeActions.getAuthUrl);
  const [showKey, setShowKey] = useState(false);
  const importRevenue = useAction(api.stripeActions.importRevenue);
  const disconnect = useMutation(api.stripe.disconnect);
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

  if (status === undefined) return null;
  if (!status.connected && status.oauthAvailable && !showKey) {
    return (
      <div data-testid="stripe-card" className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Approve read-only access to customers, subscriptions, invoices and products in Stripe.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { authUrl } = await getAuthUrl({});
              window.location.assign(authUrl);
            })
          }
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />} Connect Stripe
        </button>
        <button type="button" onClick={() => setShowKey(true)} className="block text-xs text-muted-foreground underline">
          Use a restricted key instead
        </button>
      </div>
    );
  }
  if (!status.connected) {
    return (
      <form
        data-testid="stripe-card"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await connect({ secretKey: key });
            setKey("");
            void toast.success("Stripe connected");
          });
        }}
      >
        <p className="w-full text-sm text-muted-foreground">
          Use a restricted key with read access to Customers, Subscriptions, Invoices and Products.
        </p>
        <input
          type="password"
          autoComplete="off"
          aria-label="Stripe restricted key"
          placeholder="rk_live_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="w-full max-w-72 rounded-lg border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !key.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Connect Stripe
        </button>
      </form>
    );
  }

  return (
    <div data-testid="stripe-card" className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {status.method === "oauth" ? "Connected through the Canon CRM Stripe App" : "Connected with a restricted key"}
        {status.account ? ` · ${status.account}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await importRevenue({});
              void toast.success(
                `Imported ${result.contracts} contracts and ${result.invoices} invoices` +
                  (result.unattached ? ` (${result.unattached} with no subscription, listed for review)` : ""),
              );
            })
          }
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Import from Stripe
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => { await disconnect({}); void toast.success("Stripe disconnected"); })}
          className="inline-flex items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        >
          <Unplug className="h-4 w-4" /> Disconnect
        </button>
      </div>
      <ContractList />
    </div>
  );
}

function ContractList() {
  const data = useQuery(api.revenueContracts.list);
  if (!data) return null;
  return (
    <div className="space-y-2">
      {data.contracts.length === 0 ? <p className="text-sm text-muted-foreground">No contracts imported yet.</p> : null}
      {data.contracts.length === 0 ? null : <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {data.contracts.map((contract) => (
          <li key={contract._id} className="space-y-0.5 px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium">{contract.customerName ?? contract.customerDomain ?? contract.stripeSubscriptionId}</span>
              <span className="shrink-0 tabular-nums">{money(contract.mrr, contract.currency)}/mo</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
              <span>
                {contract.startDate ?? "?"} → {contract.endDate ?? "open"} · {contract.status}
              </span>
              <span className="tabular-nums">
                {contract.invoiceCount} invoices · {money(contract.collected, contract.currency)} collected
                {contract.outstanding > 0 ? ` · ${money(contract.outstanding, contract.currency)} open` : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>}
      {data.unattachedInvoices.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {data.unattachedInvoices.length} invoice{data.unattachedInvoices.length === 1 ? "" : "s"} with no subscription, not booked.
        </p>
      ) : null}
    </div>
  );
}
