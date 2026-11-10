"use client";

import { IntegrationGate } from "@/components/integration-gate";
import { useAction } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { getErrorMessage } from "@/lib/utils";

type SearchRead = FunctionReturnType<typeof api.marketSources.read>;
const capability = (value: boolean | undefined, yes: string, no: string) => value === undefined ? "Unknown" : value ? yes : no;
function MarketSourcesEnabled() {
  const read = useAction(api.marketSources.read), start = useAction(api.marketSources.start);
  const [data, setData] = useState<SearchRead | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { const next = await read({}); setData(next); return next; }, [read]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await read({});
        if (!live) return;
        setData(next);
        if (next.run?.status === "running") timer = setTimeout(() => void poll(), 2500);
      } catch (e) { if (live) setError(getErrorMessage(e)); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [read, data?.run?._id, data?.run?.status]);
  const search = async () => {
    setBusy(true); setError(null);
    try { await start({}); await load(); } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(false); }
  };
  const running = busy || data?.run?.status === "running";
  return <section className="mt-8 border-t border-border pt-5" aria-labelledby="market-sources-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="market-sources-title" className="font-display text-lg font-semibold">Where your market is listed</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Find directories and lists that mention your best accounts. Sources found for more seeds rank first. Free planning, no workspace credits.</p></div>
      <button type="button" onClick={() => void search()} disabled={running} className="inline-flex items-center gap-2 border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
        {running ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}{running ? "Searching directories…" : "Find directories"}
      </button>
    </div>
    <div aria-live="polite" className="mt-3 text-sm">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {data?.run?.reason && <p className="rounded border border-border bg-muted/30 p-3">{data.run.reason}</p>}
      {data?.run?.status === "done" && !data.sources.length && <p className="text-muted-foreground">No directories with a verified mention of your seeds were found.</p>}
      {data?.run && data.run.seeds.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Seeds used: {data.run.seeds.map((s) => s.name).join(", ")}</p>}
    </div>
    <div className="mt-4 grid gap-3">
      {data?.sources.map((source) => <article key={source.key} className="min-w-0 border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">{source.title}<ExternalLink className="size-3" /></a>
          <span className="text-xs text-muted-foreground">{source.kind.replaceAll("_", " ")} · {source.seedHits} distinct {source.seedHits === 1 ? "seed" : "seeds"} across searches</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Companies listed: {source.listedCount === undefined ? "Unknown" : `about ${source.listedCount.toLocaleString()}`} · Filtering: {capability(source.filterable, "Yes", "No")} · Export: {capability(source.exportable, "Yes", "No")}</p>
        {data.run?.results.filter((r) => r.sourceKey === source.key).map((hit) => <div key={hit.seedDomain} className="mt-3 border-l-2 border-primary/30 pl-3 text-sm">
          <p className="font-medium">{data.run?.seeds.find((s) => s.domain === hit.seedDomain)?.name ?? hit.seedDomain}</p>
          <blockquote className="mt-1 text-muted-foreground">“{hit.quote}”</blockquote>
          <p className="mt-2 text-xs text-muted-foreground">Found with <code className="break-words text-foreground">{hit.query}</code></p>
        </div>)}
      </article>)}
    </div>
    {data && <details className="mt-5" open><summary className="cursor-pointer text-sm font-medium">Catalog sources for your market</summary>
      <p className="mt-1 text-xs text-muted-foreground">Matched to your first active ICP. Browse-only sources are links for you to explore.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.catalog.map((source) => <div key={source.id} className="border border-border p-3">
        <a href={source.url} target="_blank" rel="noreferrer" className="text-sm font-medium underline underline-offset-4">{source.name}</a>
        <p className="mt-1 text-xs text-muted-foreground">{source.kinds.map((k) => k.replaceAll("_", " ")).join(", ")} · {source.scrapeAllowed ? source.method.toUpperCase() : "Browse only"}</p>
        <p className="mt-2 text-xs text-muted-foreground">{source.termsNote}</p>
      </div>)}</div>
    </details>}
  </section>;
}

export function MarketSources() {
  return <IntegrationGate feature="treg" note><MarketSourcesEnabled /></IntegrationGate>;
}
