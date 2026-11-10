"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Coins, CreditCard, Loader2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { FREE_CREDITS_PER_MONTH } from "../../../../convex/lib/creditPacks";
import { LoadingRows } from "@/components/dashboard";
import { getErrorMessage } from "@/lib/utils";
import { CreditUsage } from "./credit-usage";

const num = (n: number) => Math.floor(n).toLocaleString("en-US");

/** Prepaid credits for paid data sources: the balance and packs to buy. */
function CreditsSection({ justBought }: { justBought: boolean }) {
  const credits = useQuery(api.credits.summary);
  const buy = useAction(api.credits.buy);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  if (!credits) return null;

  async function purchase(pack: number) {
    setBusy(pack);
    setError("");
    try {
      const { url } = await buy({ pack });
      if (url) window.location.assign(url);
      else setBusy(null);
    } catch (e) {
      setError(getErrorMessage(e));
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Coins className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Credits</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Contacts from paid sources cost credits, whether a person or an agent runs the search. The workspace gets{" "}
        {num(FREE_CREDITS_PER_MONTH)} free credits a month, spent first; bought credits last 10 years, and the bigger packs add bonus credits.
      </p>
      <div className="mt-4 text-2xl font-bold">{num(credits.spendable)} credits</div>
      <p className="mt-1 text-sm text-muted-foreground">
        {num(credits.free.left)} of {num(credits.free.allowance)} free credits left this month · {num(credits.balance)} bought
      </p>
      {justBought && <p className="mt-1 text-sm text-muted-foreground">Payment received. Credits appear here as soon as Stripe confirms it.</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {!credits.canBuy ? (
          <p className="text-sm text-muted-foreground">Only workspace admins can buy credits.</p>
        ) : !credits.configured ? (
          <p className="text-sm text-muted-foreground">Credits aren&apos;t configured on this deployment.</p>
        ) : (
          credits.packs.map((pack) => (
            <button key={pack.price} type="button" onClick={() => void purchase(pack.price)} disabled={busy !== null} className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
              {busy === pack.price && <Loader2 className="size-4 animate-spin" />} {num(pack.credits)} credits for ${pack.price}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

/** Settings -> Billing: the Stripe Customer Portal for invoices and saved cards, credits, then this month's usage. */
export function BillingTab({ justBoughtCredits }: { justBoughtCredits: boolean }) {
  const billing = useQuery(api.billing.summary);
  const portal = useAction(api.billing.openPortal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (billing === undefined) return <LoadingRows count={2} height="h-24" />;
  if (billing === null) return null;

  async function openPortal() {
    setBusy(true);
    setError("");
    try {
      const { url } = await portal({});
      if (url) window.location.assign(url);
      else setBusy(false);
    } catch (e) {
      setError(getErrorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      {billing.canManage && billing.configured && billing.hasCustomer && (
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Invoices and cards</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Every pack comes with a Stripe invoice. Download them or change your saved card in Stripe.</p>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <button type="button" onClick={() => void openPortal()} disabled={busy} className="mt-4 flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
            {busy && <Loader2 className="size-4 animate-spin" />} Open billing portal
          </button>
        </section>
      )}
      <CreditsSection justBought={justBoughtCredits} />
      <section className="rounded-xl border border-border bg-card p-6">
        <CreditUsage />
      </section>
    </div>
  );
}
