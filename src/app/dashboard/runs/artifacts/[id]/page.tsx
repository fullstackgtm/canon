"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft, ExternalLink, FileSearch, Target, Users } from "lucide-react";
import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { ViewFrame } from "@/components/dashboard";

type Json = Record<string, any>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

function Source({ href, label = "Open source" }: { href: string; label?: string }) {
  if (!/^https?:\/\//i.test(href)) return null;
  let host = href;
  try { host = new URL(href).hostname.replace(/^www\./, ""); } catch {}
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-muted">{label} · {host}<ExternalLink className="h-3 w-3" /></a>;
}

function IcpReference({ value }: { value: unknown }) {
  const ref = record(value);
  if (!text(ref.artifactId) && !text(ref.domain)) return <span className="text-xs text-muted-foreground">Untracked local ICP</span>;
  const label = `${text(ref.domain) || "Canonical ICP"}${ref.revision ? ` · revision ${String(ref.revision)}` : ""}`;
  return text(ref.artifactId) ? <Link href={`/dashboard/runs/artifacts/${text(ref.artifactId)}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"><Target className="h-3.5 w-3.5" />{label}</Link> : <span className="text-xs text-muted-foreground">{label}</span>;
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return <div className="rounded-lg border bg-card p-4"><div className="text-2xl font-semibold">{value}</div><div className="mt-0.5 text-xs text-muted-foreground">{label}</div></div>;
}

function EvidenceRun({ document }: { document: unknown }) {
  const root = record(document); const counts = record(root.counts); const signals = values(root.signals).map(record);
  return <div className="space-y-7">
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-5">
      <div><h2 className="flex items-center gap-2 font-semibold"><FileSearch className="h-4 w-4 text-primary" />What this run found</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Public evidence retained because it matched a behavioral trigger hypothesis. Quotes and source pages are visible below; this run did not write to the CRM.</p></div>
      <IcpReference value={root.icpRef} />
    </section>
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric value={Number(counts.new ?? signals.length)} label="Fresh evidence" /><Metric value={signals.length} label="Retained results" /><Metric value={Number(counts.fetched ?? root.rawResults ?? signals.length)} label="Candidates checked" /><Metric value={typeof root.costUsd === "number" ? `$${root.costUsd.toFixed(3)}` : "$0.00"} label="Reported provider cost" /></section>
    {values(root.warnings).length > 0 ? <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">{values(root.warnings).map(String).join(" ")}</div> : null}
    <section><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Evidence ({signals.length})</h2><span className="text-xs text-muted-foreground">Verbatim public excerpts</span></div><div className="space-y-4">{signals.map((signal, index) => {
      const sourceUrl = text(signal.sourceUrl) || text(signal.url); const domain = text(signal.accountDomain) || text(signal.domain); const company = text(signal.companyName);
      return <article key={text(signal.id) || `${sourceUrl}-${index}`} className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{company || domain || `Evidence ${index + 1}`}</h3>{domain ? <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{domain}</span> : null}</div><p className="mt-1 text-sm font-medium">{text(signal.trigger) || text(signal.title) || "Behavioral trigger"}</p></div><Source href={sourceUrl} /></div>
        {text(signal.quote) || text(signal.summary) || text(signal.evidence) ? <blockquote className="mt-4 border-l-2 border-primary/50 pl-4 text-sm leading-6 text-muted-foreground">{text(signal.quote) || text(signal.summary) || text(signal.evidence)}</blockquote> : <p className="mt-4 text-sm text-muted-foreground">No source excerpt was retained.</p>}
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">{text(signal.hypothesisId) ? <span className="rounded bg-muted px-2 py-1">Hypothesis: {text(signal.hypothesisId)}</span> : null}{text(signal.source) ? <span className="rounded bg-muted px-2 py-1">Source: {text(signal.source)}</span> : null}{signal.weight !== undefined ? <span className="rounded bg-muted px-2 py-1">Weight: {String(signal.weight)}</span> : null}</div>
      </article>;
    })}</div></section>
  </div>;
}

function evidenceById(plan: Json): Map<string, Json> { return new Map(values(plan.evidence).map(record).map((item) => [text(item.id), item])); }
function evidencePayload(item: Json): Json { try { return record(JSON.parse(text(item.text))); } catch { return {}; } }

function LeadRun({ document }: { document: unknown }) {
  const root = record(document); const plan = record(root.plan); const operations = values(plan.operations).map(record); const evidence = evidenceById(plan); const counts = record(root.counts);
  return <div className="space-y-7">
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-5"><div><h2 className="flex items-center gap-2 font-semibold"><Users className="h-4 w-4 text-primary" />Governed lead preview</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">These contacts passed ICP fit and CRM duplicate resolution. They are proposed operations only—nothing was created, approved, or written.</p></div><IcpReference value={root.icpRef} /></section>
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric value={operations.length} label="Proposed leads" /><Metric value={Number(counts.fetched ?? operations.length)} label="Candidates sourced" /><Metric value={Number(counts.matched ?? 0)} label="Already in CRM" /><Metric value={Number(counts.ambiguous ?? 0)} label="Ambiguous matches" /></section>
    <section><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">People ({operations.length})</h2><span className="rounded bg-warning/15 px-2 py-1 text-xs font-medium text-warning">Dry run · no writes</span></div><div className="space-y-4">{operations.map((operation, index) => {
      const change = record(operation.afterValue ?? operation.payload); const properties = record(change.properties); const ev = evidence.get(text(values(operation.evidenceIds)[0])) ?? {}; const payload = evidencePayload(ev);
      const first = text(properties.firstname) || text(payload.firstName); const last = text(properties.lastname) || text(payload.lastName); const name = `${first} ${last}`.trim() || text(payload.fullName) || `Lead ${index + 1}`;
      const title = text(properties.jobtitle) || text(payload.jobTitle); const company = text(properties.company) || text(payload.companyName); const domain = text(change.associateCompanyDomain) || text(payload.companyDomain); const linkedin = text(properties.hs_linkedin_url) || text(payload.linkedin); const fit = typeof payload.fitScore === "number" ? Math.round(payload.fitScore <= 1 ? payload.fitScore * 100 : payload.fitScore) : null;
      return <article key={text(operation.id) || String(index)} className="rounded-lg border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{name}</h3>{fit !== null ? <span className="rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{fit}% fit</span> : null}</div><p className="mt-1 text-sm">{[title, company].filter(Boolean).join(" · ") || "Role details unavailable"}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{domain}</p></div><Source href={linkedin} label="LinkedIn" /></div>{text(operation.reason) ? <div className="mt-4 rounded-md bg-muted/60 p-3"><p className="text-xs font-semibold text-muted-foreground">Why this is here</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{text(operation.reason)}</p></div> : null}</article>;
    })}</div></section>
  </div>;
}

export default function RetainedRunPage() {
  const params = useParams(); const artifactId = (Array.isArray(params.id) ? params.id[0] : params.id) as Id<"cliArtifacts">;
  const artifact = useQuery(api.cliArtifacts.get, { artifactId });
  const available = artifact && artifact.kind !== "icp" ? artifact : null;
  return <ViewFrame title={available?.label ?? "Run"}
    description={available ? `${available.kind === "signal_run" ? "Evidence run" : "Lead preview"} · Completed ${new Date(available.updatedAt).toLocaleString()}` : undefined}
    actions={[{ id: "artifact-back", label: "Runs", href: "/dashboard/runs", icon: <ArrowLeft className="size-3.5" /> }]}>
    {artifact === undefined ? <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">Loading run…</div>
      : !available ? <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">Run not found, or not in your organization.</div>
        : available.kind === "signal_run" ? <EvidenceRun document={available.document} /> : <LeadRun document={available.document} />}
  </ViewFrame>;
}
