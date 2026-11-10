"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Check, Loader2, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Market, Persona } from "../../../convex/lib/addRecords";
import { cn, getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

const label = "text-xs font-medium text-muted-foreground";
const credits = (n: number) => `${Math.floor(n).toLocaleString("en-US")} ${Math.floor(n) === 1 ? "credit" : "credits"}`;
const usd = (n: number) => (n >= 0.1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(4)}` : `$${n.toFixed(5)}`);

type Catalog = NonNullable<ReturnType<typeof useQuery<typeof api.providerTests.catalog>>>;
type Test = Catalog["tests"][number];

function TestResult({ test }: { test: Test }) {
  const [open, setOpen] = useState(false);
  if (test.status === "running") return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Testing…</p>;
  if (test.status === "failed") return <p className="text-xs text-destructive">{test.error ?? "The test failed."}</p>;
  const returned = test.returned ?? 0;
  const good = test.acceptable ?? 0;
  const cost = test.costUsd ?? 0;
  return (
    <div className="grid gap-1.5 text-xs">
      <p>
        <span className="font-medium">{good}/{returned} acceptable</span>
        <span className="text-muted-foreground">
          {" · "}{test.onTarget ?? 0} on target · {test.known ?? 0} at companies you have · cost {usd(cost)}
          {good > 0 ? ` (${usd(cost / good)} per acceptable record)` : ""}
        </span>
      </p>
      {test.sample.length > 0 && (
        <button type="button" onClick={() => setOpen(!open)} className="w-fit text-left text-muted-foreground underline-offset-2 hover:underline">
          {open ? "Hide sample" : `Show ${test.sample.length} of them`}
        </button>
      )}
      {open && (
        <ul className="grid gap-1 border-l border-border pl-2">
          {test.sample.map((s, i) => (
            <li key={i} className="flex min-w-0 items-start gap-1.5">
              {s.acceptable ? <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" /> : <X className="mt-0.5 size-3 shrink-0 text-destructive" />}
              <span className="min-w-0">
                {s.linkedinUrl ? <a href={s.linkedinUrl} target="_blank" rel="noreferrer" className="hover:underline">{s.name}</a> : s.name}
                <span className="text-muted-foreground">{s.title ? ` · ${s.title}` : ""}{s.company ? ` · ${s.company}` : ""}{s.domain ? ` (${s.domain})` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Run a tested source on the whole market, spending up to a cap of the workspace's credits. */
function RunPanel({ provider, test, market, persona, balance, enabled, onStarted }: {
  provider: Catalog["providers"][number]; test: Test; market: Market; persona: Persona; balance: number; enabled: boolean; onStarted?: () => void;
}) {
  const start = useAction(api.paidRuns.start);
  const good = test.returned ? (test.acceptable ?? 0) / test.returned : 0;
  // Only kept rows are charged, so the whole market costs its matches times the share that met the bar.
  const all = test.available !== undefined ? Math.ceil(test.available * good * provider.creditsPerRecord) : null;
  const [cap, setCap] = useState(() => Math.max(provider.minRunCapCredits, Math.floor(Math.min(balance, all ?? balance))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    setBusy(true);
    setError("");
    try {
      await start({ provider: provider.id, market, persona, capCredits: cap });
      void toast.success(`${provider.label} is searching your market. Progress shows in the jobs tray; results wait for your review.`);
      onStarted?.();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-border pt-2 text-xs">
      <p className="text-muted-foreground">
        {all !== null
          ? `About ${test.available!.toLocaleString("en-US")} people match. In the test, ${Math.round(good * 100)}% met the bar; only those are kept and charged, so the whole market would cost about ${credits(all)}.`
          : `This source doesn't report how many people match: a run keeps searching until it reaches your cap. In the test, ${Math.round(good * 100)}% met the bar, and only those are kept.`}
      </p>
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          Spend up to
          <input type="number" min={provider.minRunCapCredits} max={Math.floor(balance)} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="w-24 border border-border bg-background px-2 py-1 text-foreground" />
          <span>of your {credits(balance)}</span>
        </label>
        <button
          type="button"
          onClick={() => void go()}
          disabled={!enabled || busy || cap < provider.minRunCapCredits || cap > balance}
          className="ml-auto flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy && <Loader2 className="size-3 animate-spin" />} Run on whole market
        </button>
      </div>
      {balance < provider.minRunCapCredits && <p className="text-muted-foreground">A run needs at least {credits(provider.minRunCapCredits)}. Buy credits in Settings → Billing & usage.</p>}
    </div>
  );
}

/**
 * Paid people sources: the catalog and a capped test of each against the
 * market and buyers set on the Market tab. Tests are on CanonCRM's monthly
 * allowance and write nothing to the CRM.
 */
export function PaidSourcesTab({ market, persona, onStarted }: { market: Market; persona: Persona; onStarted?: () => void }) {
  const catalog = useQuery(api.providerTests.catalog);
  const wallet = useQuery(api.credits.summary);
  const run = useAction(api.providerTests.run);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!catalog) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const narrow = market.industries.length > 0 || market.countries.length > 0 || market.employeeBands.length > 0;
  const left = Math.max(0, catalog.allowance.limitUsd - catalog.allowance.usedUsd);
  const running = catalog.tests.some((t) => t.status === "running");

  async function test(provider: string) {
    setBusy(provider);
    setError("");
    try {
      await run({ provider, market, persona });
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Paid sources find more people than the free one. Test one against the market and buyers on the Market tab: up to 25 records,
        scored on whether each has a full name, a LinkedIn profile and the company&apos;s domain. Tests are on us
        ({usd(left)} of {usd(catalog.allowance.limitUsd)} left this month) and add nothing to your CRM.
      </p>
      {!catalog.paidEnabled && <p className="border border-border px-3 py-2 text-xs text-muted-foreground">Paid sources are switched off on this deployment.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid gap-2">
        {catalog.providers.map((p) => {
          const last = catalog.tests.find((t) => t.provider === p.id);
          const disabled = !catalog.canRun || !catalog.configured || !catalog.paidEnabled || !narrow || running || busy !== null || p.testCapUsd > left;
          return (
            <div key={p.id} className="grid gap-2 border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{p.label} <span className="font-normal text-muted-foreground">· {credits(p.creditsPerRecord)} a contact kept</span></p>
                  <p className="text-xs text-muted-foreground">{p.note}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void test(p.id)}
                  disabled={disabled}
                  className="flex shrink-0 items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium hover:border-primary disabled:opacity-60"
                >
                  {busy === p.id && <Loader2 className="size-3 animate-spin" />} {last ? "Test again" : "Test 25"}
                </button>
              </div>
              {last && <TestResult test={last} />}
              {last?.status === "done" && (last.acceptable ?? 0) > 0 && (
                <RunPanel
                  provider={p} test={last} market={market} persona={persona} balance={wallet?.spendable ?? 0} onStarted={onStarted}
                  enabled={catalog.canRun && catalog.configured && catalog.paidEnabled && narrow}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className={cn(label, "normal-case tracking-normal")}>
        {!narrow ? "Pick an industry, size or location on the Market tab first." : `Runs spend credits as they keep contacts. You have ${credits(wallet?.spendable ?? 0)}.`}
      </p>
    </div>
  );
}
