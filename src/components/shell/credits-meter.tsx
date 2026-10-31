"use client";

import { IntegrationGate } from "@/components/integration-gate";

import Link from "next/link";
import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";

const BILLING_HREF = "/dashboard/settings/billing";
const fmt = (n: number) => Math.floor(n).toLocaleString("en-US");
const compact = (n: number) => (n >= 10_000 ? `${Math.floor(n / 1000)}k` : n >= 1000 ? `${(Math.floor(n / 100) / 10).toFixed(1)}k` : fmt(n));

/**
 * The workspace's credits, in the sidebar slot the setup checklist leaves once
 * setup is done. The bar is what's spendable now: this month's free allowance
 * that's left, then bought credits, out of the allowance plus bought credits.
 */
function CreditsMeterEnabled({ collapsed = false }: { collapsed?: boolean }) {
  const credits = useQuery(api.credits.summary);
  if (!credits) return null;

  const { free, balance, spendable } = credits;
  const capacity = free.allowance + balance;
  const freePct = capacity > 0 ? (free.left / capacity) * 100 : 0;
  const paidPct = capacity > 0 ? (balance / capacity) * 100 : 0;
  // Low once less than a tenth of a month's allowance is left.
  const low = spendable < free.allowance / 10;

  if (collapsed) {
    return (
      <Link
        href={BILLING_HREF}
        title={`${fmt(spendable)} credits left`}
        className={cn(
          "flex justify-center border-t border-sidebar-border py-2 font-mono text-[10px] hover:text-sidebar-foreground",
          low ? "text-destructive" : "text-sidebar-foreground/60",
        )}
      >
        {compact(spendable)}
      </Link>
    );
  }

  return (
    <Link
      href={BILLING_HREF}
      className="group block border-t border-sidebar-border px-2 py-2"
      aria-label={`${fmt(spendable)} credits left. Open billing.`}
    >
      <div className="flex w-full items-center gap-2 px-2 py-1 text-xs font-medium text-sidebar-foreground/50 group-hover:text-sidebar-foreground/70">
        <span>Credits</span>
        <span className={cn("ml-auto tabular-nums", low ? "text-destructive" : "text-sidebar-foreground/70")}>
          {fmt(spendable)}
        </span>
      </div>
      <div className="mx-2 mt-1 flex h-[3px] bg-sidebar-border" role="img" aria-hidden>
        <div className={cn("h-[3px] transition-all", low ? "bg-destructive" : "bg-sidebar-primary")} style={{ width: `${freePct}%` }} />
        <div className="h-[3px] bg-sidebar-primary/50 transition-all" style={{ width: `${paidPct}%` }} />
      </div>
      <p className="mx-2 mt-1.5 text-[11px] text-sidebar-foreground/50">
        {fmt(free.left)} of {fmt(free.allowance)} free this month
        {balance > 0 && <> · {fmt(balance)} bought</>}
      </p>
    </Link>
  );
}

export function CreditsMeter(props: React.ComponentProps<typeof CreditsMeterEnabled>) {
  return <IntegrationGate feature="billing"><CreditsMeterEnabled {...props} /></IntegrationGate>;
}
