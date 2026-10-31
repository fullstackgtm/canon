"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { getErrorMessage } from "@/lib/utils";

export function MapMyMarket({ icpId }: { icpId?: string }) {
  const data = useQuery(api.tamInvestigations.read, {}), run = data?.run;
  const plan = useMutation(api.tamInvestigations.plan);
  const start = useMutation(api.tamInvestigations.start);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState(500);
  const storedCap = run?.capCredits;
  useEffect(() => { if (storedCap !== undefined) setCap(storedCap); }, [storedCap]);
  const prepare = async () => {
    setBusy(true); setError(null);
    try { await plan({ ...(icpId ? { icpId } : {}), capCredits: cap }); } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  };
  const launch = async () => {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      await start({ investigationId: run._id, capCredits: cap });
      window.location.assign(`/dashboard/icps/investigations/${run._id}`);
    } catch (e) { setError(getErrorMessage(e)); setBusy(false); }
  };
  const active = run && ["planning", "awaiting_start", "running", "paused_at_cap"].includes(run.status);
  if (!data?.canMap) return null;
  return <section aria-labelledby="map-market-title" className="mt-8 border-t border-border pt-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="map-market-title" className="font-display text-lg font-semibold">Map my market</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Find companies in public directories, specialist job titles and relevant registries. Review the companies and their evidence before adding them to your CRM.</p></div>
      {!active && <button onClick={() => void prepare()} disabled={busy || !icpId} className="border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">{busy ? "Planning…" : "Map my market"}</button>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {run?.status === "planning" && <p className="mt-3 flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Choosing sources and estimating credits…</p>}
    {run?.status === "awaiting_start" && <div className="mt-4 border border-border bg-card p-4">
      <p className="font-medium">Estimated {run.estimateCredits.toLocaleString()} credits</p>
      <p className="mt-1 text-sm text-muted-foreground">1 credit per kept company. Planning, duplicates and rejects are free. Free monthly credits are used first.</p>
      <ul className="my-3 list-inside list-disc text-sm">{run.plan.sources.map((s) => <li key={`${s.kind}:${s.ref}`}>{s.label} · about {s.estimatedCompanies} companies</li>)}</ul>
      {!run.plan.sources.length && <p className="my-3 text-sm">No eligible sources were found for this ICP.</p>}
      <label className="flex items-center gap-2 text-sm">Credit cap <input aria-label="Credit cap" type="number" min={1} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="w-24 border border-border bg-background px-2 py-1" /></label>
      <p className="mt-2 text-xs text-muted-foreground">Reserve up to {Math.min(run.estimateCredits, cap).toLocaleString()} credits. Unused credits return when the run ends.</p>
      <button onClick={() => void launch()} disabled={busy || !run.plan.sources.length || !Number.isSafeInteger(cap) || cap < 1} className="mt-3 bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Starting…" : "Start mapping"}</button>
      <p className="mt-3 text-xs text-muted-foreground">{run.events.at(-1)?.message}</p>
    </div>}
    {run && run.status !== "planning" && run.status !== "awaiting_start" && <p className="mt-3 text-sm"><Link className="underline" href={`/dashboard/icps/investigations/${run._id}`}>Open market investigation</Link> · {run.status.replaceAll("_", " ")} · {run.counts.kept} kept · {run.spentCredits} credits</p>}
  </section>;
}
