"use client";
import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { LoadingRows, ViewFrame } from "@/components/dashboard";
import { getErrorMessage } from "@/lib/utils";

export default function MarketInvestigationPage() {
  const { investigationId } = useParams<{ investigationId: string }>();
  const data = useQuery(api.tamInvestigations.read, { investigationId: investigationId as Id<"tamInvestigations"> }), run = data?.run;
  const start = useMutation(api.tamInvestigations.start), stop = useMutation(api.tamInvestigations.stop);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [extra, setExtra] = useState(500);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); } };
  if (data === undefined) return <ViewFrame title="Map my market"><LoadingRows /></ViewFrame>;
  if (!run) return <ViewFrame title="Market investigation not found"><p>This run is unavailable in your workspace.</p></ViewFrame>;
  const finished = run.status === "done" || run.status === "failed";
  return <ViewFrame title="Map my market" description="Follow the sources, company matches and website checks. Companies reach your CRM after staged review.">
    {run.trigger === "signup" && <p className="mb-4 border border-border bg-muted/30 p-4 text-sm">Canon started this market map for you after signup. {run.freeOnly ? "It uses only your free monthly credits, up to 500. Bought credits stay available until you choose to continue." : "You chose to continue with available credits, including bought credits."} You can stop the investigation at any time.</p>}
    <Link href="/dashboard/icps" className="text-sm underline">Back to ICPs</Link>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-border p-4">
      <div><p className="font-medium capitalize" aria-live="polite">{run.status.replaceAll("_", " ")}</p><p className="mt-1 text-sm text-muted-foreground">Estimated {run.estimateCredits} credits · Spent {run.spentCredits} of {run.capCredits} credit cap</p></div>
      {!finished && <button disabled={busy} onClick={() => void act(() => stop({ investigationId: run._id }))} className="border border-border px-3 py-2 text-sm disabled:opacity-50">Stop investigation</button>}
      {finished && <Link href={`/dashboard/imports/${run.jobId}`} className="bg-primary px-4 py-2 text-sm text-primary-foreground">Review {run.counts.kept} companies</Link>}
    </div>
    <dl className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{(["found", "duplicates", "rejected", "kept"] as const).map((key) => <div className="border border-border p-4" key={key}><dt className="text-xs capitalize text-muted-foreground">{key}</dt><dd className="mt-1 font-display text-2xl">{run.counts[key]}</dd></div>)}</dl>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {run.status === "awaiting_start" && <div className="mb-4 border border-border p-4"><p className="mb-2 text-sm">Reserve up to {Math.min(run.estimateCredits, run.capCredits)} credits. Charge 1 per kept company, free monthly credits first.</p><button disabled={busy} onClick={() => void act(() => start({ investigationId: run._id }))} className="bg-primary px-4 py-2 text-sm text-primary-foreground">Start mapping</button></div>}
    {run.status === "paused_at_cap" && <div className="mb-4 border border-border p-4"><p className="text-sm">{run.events.at(-1)?.message}</p><p className="mt-2 text-sm text-muted-foreground">Continuing can use bought credits. About {Math.max(0, run.estimateCredits - run.spentCredits)} credits remain in the estimate.</p><label className="mt-3 flex items-center gap-2 text-sm">Additional credits <input type="number" min={1} step={1} value={extra} onChange={(e) => setExtra(Number(e.target.value))} className="w-24 border border-border bg-background px-2 py-1" /></label><button disabled={busy || !Number.isSafeInteger(extra) || extra < 1} onClick={() => void act(() => start({ investigationId: run._id, capCredits: run.capCredits + extra }))} className="mt-3 bg-primary px-4 py-2 text-sm text-primary-foreground">Continue with cap of {run.capCredits + extra} credits</button></div>}
    <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
      <section><h2 className="font-display text-lg font-semibold">Sources in this plan</h2><ul className="mt-3 space-y-3">{run.plan.sources.map((source) => <li key={`${source.kind}:${source.ref}`} className="border border-border p-3 text-sm"><p className="font-medium">{source.label}</p><p className="mt-1 text-xs text-muted-foreground">About {source.estimatedCompanies} companies</p>{source.kind === "directory" && <a className="mt-1 block break-all text-xs underline" href={source.ref} target="_blank" rel="noreferrer">{source.ref}</a>}</li>)}</ul></section>
      <section><h2 className="font-display text-lg font-semibold">Run events</h2><ol aria-live="polite" className="mt-3 space-y-2">{run.events.map((event, i) => <li key={`${event.at}:${i}`} className="border-l-2 border-border pl-3 text-sm"><span className="text-xs text-muted-foreground">{new Date(event.at).toLocaleTimeString()} · {event.stage}</span><p>{event.message}</p></li>)}</ol></section>
    </div>
    <section className="mt-6"><h2 className="font-display text-lg font-semibold">Companies and source evidence</h2><p className="mt-1 text-xs text-muted-foreground">Showing up to 100 candidates. The review page contains all kept companies.</p><div className="mt-3 grid gap-3">{run.candidates.map((c) => <article key={c._id} className="border border-border p-4 text-sm"><p className="font-medium">{c.name} · {c.domain ?? "Website pending"} · {c.state}</p>{c.reason && <p className="mt-1 text-muted-foreground">{c.reason}</p>}{c.sources.map((s, i) => <blockquote key={i} className="mt-2 border-l-2 border-primary/30 pl-3"><a href={s.url} target="_blank" rel="noreferrer" className="break-all text-xs underline">{s.url}</a><p className="mt-1">{s.quote}</p></blockquote>)}</article>)}</div></section>
  </ViewFrame>;
}
