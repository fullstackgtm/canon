"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { Inbox, Loader2 } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { LEVELS } from "../../../../../convex/lib/addRecords";
import { NONE, cellFromKey, facetOf, hasKeywords, needsCount, selects, totalsOf, type FacetDim, type Keywords, type Selection, type Terms } from "../../../../../convex/lib/staging";
import { REGIONS, SIZE_BANDS } from "../../../../../services/record-service/src/dimensions";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { TagInput } from "@/components/crm/icp-fields";
import { JobPhaseBars } from "@/components/job-phase-bars";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

const FACETS: Array<{ dim: FacetDim; label: string; of: "contacts" | "accounts" }> = [
  { dim: "seniority", label: "Seniority", of: "contacts" },
  { dim: "department", label: "Department", of: "contacts" },
  { dim: "region", label: "Region", of: "accounts" },
  { dim: "industry", label: "Industry", of: "accounts" },
  { dim: "sizeBand", label: "Company size", of: "accounts" },
];

function keyLabel(dim: FacetDim, key: string): string {
  if (key === NONE) return dim === "seniority" || dim === "department" ? "Other titles" : "Unknown";
  if (dim === "seniority") return LEVELS.find((l) => l.value === key)?.label ?? key;
  if (dim === "region") return REGIONS.find((r) => r.key === key)?.label ?? key;
  if (dim === "sizeBand") return `${SIZE_BANDS.find((b) => b.key === key)?.label ?? key} employees`;
  return key;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const button = "border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = "flex items-center gap-2 bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50";

/** Review a staged fill: explore what it found, then add the part you keep. */
export default function StagedRunPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const run = useQuery(api.staging.run, { jobId: jobId as Id<"backgroundJobs"> });
  const [selection, setSelection] = useState<Selection>({});
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"contact" | "account">("contact");
  const approve = useMutation(api.staging.approve);
  const discard = useMutation(api.staging.discard);
  const router = useRouter();
  // Keywords and "only companies with a kept contact" aren't in the run's cells: count them over the records, and use those cells instead.
  const countSelection = useAction(api.staging.countSelection);
  const keywords = hasKeywords(selection.keywords) ? selection.keywords : undefined;
  const runCells = run?.cells;
  // A count belongs to what it counted and to the run as it was: a fill still collecting recounts as it grows.
  // Keywords alone count once; companies with kept contacts depend on the whole selection.
  const runSize = useMemo(() => (runCells ?? []).reduce((n, c) => n + c.count, 0), [runCells]);
  const counts: Selection | null = !needsCount(selection) ? null : selection.accountsWithContacts ? selection : { keywords };
  const keywordKey = counts ? `${JSON.stringify(counts)}#${runSize}` : "";
  type Counted = Awaited<ReturnType<typeof countSelection>>;
  const [counted, setCounted] = useState<({ key: string } & Counted) | { key: string; error: string } | null>(null);
  useEffect(() => {
    if (!keywordKey) return;
    let live = true;
    countSelection({ jobId: jobId as Id<"backgroundJobs">, selection: JSON.parse(keywordKey.slice(0, keywordKey.lastIndexOf("#"))) as Selection })
      .then((result) => live && setCounted({ key: keywordKey, ...result }))
      .catch((cause) => live && setCounted({ key: keywordKey, error: getErrorMessage(cause) }));
    return () => { live = false; };
  }, [countSelection, jobId, keywordKey]);
  const keywordCount = keywordKey && counted?.key === keywordKey && "cells" in counted ? counted : null;
  const keywordCells = keywordCount?.cells ?? null;
  const counting = Boolean(keywordKey) && !keywordCells;
  const countError = keywordKey && counted?.key === keywordKey && "error" in counted ? counted.error : null;

  const cells = useMemo(() => (keywordKey ? keywordCells ?? [] : runCells ?? []), [keywordKey, keywordCells, runCells]);
  const all = useMemo(() => totalsOf(runCells ?? []), [runCells]);
  useEffect(() => { if (all.accounts && !all.contacts) setView("account"); }, [all.accounts, all.contacts]);
  // With keywords, the sample comes from the count: the records it kept per cell, under the rest of the selection.
  const querySample = useQuery(api.staging.sample, run && !keywordKey ? { jobId: jobId as Id<"backgroundJobs">, kind: view, selection, limit: 50 } : "skip");
  const sample = useMemo(() => {
    if (!keywordKey) return querySample;
    if (!keywordCount) return undefined;
    return keywordCount.sample.filter((r) => r.kind === view && selects(view, cellFromKey(r.cell, 1).dims, selection)).slice(0, 50);
  }, [keywordKey, keywordCount, querySample, view, selection]);
  const kept = useMemo(() => totalsOf(cells, selection), [cells, selection]);

  if (run === undefined) return <ViewFrame title="Review"><LoadingRows /></ViewFrame>;
  if (run === null) return <ViewFrame title="Review"><EmptyState icon={Inbox} title="Run not found" description="This staged run doesn't exist or belongs to another workspace." /></ViewFrame>;

  const toggle = (dim: FacetDim, key: string) => setSelection((s) => {
    const cur = new Set(s[dim] ?? []);
    if (!cur.delete(key)) cur.add(key);
    return { ...s, [dim]: cur.size ? [...cur] : undefined };
  });
  const filtered = FACETS.some((f) => selection[f.dim]?.length) || Boolean(selection.existing) || needsCount(selection);
  const setTerms = (field: keyof Keywords, side: keyof Terms, values: string[]) => setSelection((s) => ({
    ...s, keywords: { ...s.keywords, [field]: { ...s.keywords?.[field], [side]: values } },
  }));

  async function onApprove() {
    setBusy(true);
    try {
      await approve({ jobId: jobId as Id<"backgroundJobs">, selection, ...(counts ? { counted: { accounts: kept.accounts, contacts: kept.contacts } } : {}) });
      toast.success(`Adding ${fmt(kept.accounts)} accounts and ${fmt(kept.contacts)} contacts. Progress shows in the jobs tray.`);
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function onDiscard() {
    if (!window.confirm("Discard this run? Nothing from it will be added.")) return;
    setBusy(true);
    try {
      await discard({ jobId: jobId as Id<"backgroundJobs"> });
      router.push("/dashboard/contacts");
    } catch (cause) {
      toast.error(getErrorMessage(cause));
      setBusy(false);
    }
  }

  const reviewable = run.state === "ready" || run.state === "collecting";
  return (
    <ViewFrame
      title={`Review: ${run.title}`}
      description={reviewable
        ? "Nothing from this run is in your CRM yet. Check what it found, narrow it to the records you want, then add them."
        : undefined}
    >
      {run.state === "collecting" && (
        <div className="mb-4 border border-border bg-card px-4 py-3 text-sm">
          <div className="mb-2 flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Still searching. Counts update as results arrive; you can approve once it finishes.</div>
          {run.fill && <JobPhaseBars phases={run.fill.phases} />}
        </div>
      )}
      {run.approval && (
        <div className="mb-4 border border-border bg-card px-4 py-3 text-sm">
          <p>{run.approval.detail ?? `Adding ${fmt(run.approval.accounts)} accounts and ${fmt(run.approval.contacts)} contacts…`}</p>
          {run.state === "approved" && <Link className="mt-1 inline-block underline" href="/dashboard/contacts">Open contacts</Link>}
        </div>
      )}
      {(run.state === "discarding" || run.state === "discarded") && (
        <div className="mb-4 border border-border bg-card px-4 py-3 text-sm text-muted-foreground">This run was discarded. Nothing from it was added.</div>
      )}
      {run.truncated && (
        <p className="mb-4 text-xs text-muted-foreground">This run has more combinations than the breakdown shows; counts are partial.</p>
      )}

      {reviewable && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
            <div className="text-sm">
              <div className="font-medium">
                {counting ? <span className="flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Counting the records your selection keeps…</span> : <>
                {filtered ? "Your selection adds" : "The whole run adds"} {fmt(kept.accounts)} accounts and {fmt(kept.contacts)} contacts
                {filtered && <span className="text-muted-foreground"> of {fmt(all.accounts)} and {fmt(all.contacts)}</span>}
                </>}
              </div>
              {countError && <div className="text-xs text-destructive">Couldn&apos;t count this selection: {countError}</div>}
              {run.knowsExisting && (
                <div className="text-xs text-muted-foreground">
                  {fmt(kept.existingAccounts)} accounts and {fmt(kept.existingContacts)} contacts are already in your CRM; they only gain fields they're missing.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {filtered && <button className={button} onClick={() => setSelection({})}>Clear filters</button>}
              {run.canApprove && <button className={button} disabled={busy} onClick={() => void onDiscard()}>Discard</button>}
              {run.canApprove && (
                <button className={primary} disabled={busy || counting || Boolean(countError) || run.state !== "ready" || (!kept.accounts && !kept.contacts)} onClick={() => void onApprove()}>
                  {busy && <Loader2 className="size-3 animate-spin" />} Add {fmt(kept.accounts)} accounts and {fmt(kept.contacts)} contacts
                </button>
              )}
            </div>
          </div>
          {!run.canApprove && <p className="mb-4 text-xs text-muted-foreground">Only admins and managers can add or discard staged records.</p>}

          <div className="mb-4 flex items-center gap-2 text-sm">
            {/* What the CRM already has is matched against every record, so only a viewer who sees them all is told (CP14). */}
            {run.knowsExisting && <>
              <span className="text-xs font-medium text-muted-foreground">Already in your CRM</span>
              {([[undefined, "Include"], ["new", "New only"], ["existing", "Only those"]] as const).map(([value, label]) => (
                <button key={label} onClick={() => setSelection((s) => ({ ...s, existing: value }))}
                  className={`${button} ${selection.existing === value ? "bg-muted text-foreground" : ""}`}>{label}</button>
              ))}
            </>}
            <label className="ml-4 flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={Boolean(selection.accountsWithContacts)}
                onChange={(e) => setSelection((s) => ({ ...s, accountsWithContacts: e.target.checked || undefined }))} />
              Only companies with a contact you keep
            </label>
          </div>

          <section className="mb-4 grid grid-cols-1 gap-3 border border-border bg-card p-3 md:grid-cols-2">
            {([["title", "Title", "contacts"], ["company", "Company name or domain", "accounts and their contacts"]] as const).map(([field, name, of]) => (
              <div key={field} className="grid gap-2">
                <h2 className="flex justify-between text-xs font-medium text-muted-foreground"><span>{name} keywords</span><span>{of}</span></h2>
                <label className="grid gap-1 text-xs text-muted-foreground">Has any of
                  <TagInput value={selection.keywords?.[field]?.include ?? []} onChange={(v) => setTerms(field, "include", v)} placeholder={field === "title" ? "VP, vice president… then Enter" : "bank, .io… then Enter"} />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">Has none of
                  <TagInput value={selection.keywords?.[field]?.exclude ?? []} onChange={(v) => setTerms(field, "exclude", v)} placeholder={field === "title" ? "assistant, intern… then Enter" : "staffing… then Enter"} />
                </label>
              </div>
            ))}
          </section>

          <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {FACETS.map((f) => (
              <Facet key={f.dim} title={f.label} of={f.of} rows={facetOf(cells, f.dim, selection)} picked={selection[f.dim] ?? []}
                empty={(f.of === "accounts" ? all.accounts : all.contacts) ? `No ${f.of} in this selection.` : "Nothing yet."}
                label={(key) => keyLabel(f.dim, key)} onToggle={(key) => toggle(f.dim, key)} />
            ))}
          </div>

          <div className="mb-2 flex items-center gap-2">
            {(["contact", "account"] as const).map((k) => (
              <button key={k} onClick={() => setView(k)} className={`${button} ${view === k ? "bg-muted text-foreground" : ""}`}>
                {k === "contact" ? "Sample contacts" : "Sample accounts"}
              </button>
            ))}
          </div>
          <SampleTable kind={view} rows={sample} />
        </>
      )}
    </ViewFrame>
  );
}

function Facet({ title, of, rows, picked, empty, label, onToggle }: {
  title: string;
  empty: string;
  of: string;
  rows: Array<{ key: string; count: number }>;
  picked: string[];
  label: (key: string) => string;
  onToggle: (key: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="border border-border bg-card p-3">
      <h2 className="mb-2 flex justify-between text-xs font-medium text-muted-foreground">
        <span>{title}</span><span>{of}</span>
      </h2>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      <ul className="grid max-h-64 gap-1 overflow-y-auto">
        {rows.map((r) => {
          const on = picked.includes(r.key);
          return (
            <li key={r.key}>
              <label className="relative flex cursor-pointer items-center gap-2 px-1 py-0.5 text-sm">
                <span aria-hidden className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${(r.count / max) * 100}%` }} />
                <input type="checkbox" className="relative" checked={on} onChange={() => onToggle(r.key)} aria-label={`${title}: ${label(r.key)}`} />
                <span className={`relative flex-1 truncate ${picked.length && !on ? "text-muted-foreground" : ""}`}>{label(r.key)}</span>
                <span className="relative text-xs tabular-nums">{fmt(r.count)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type SampleRow = NonNullable<ReturnType<typeof useQuery<typeof api.staging.sample>>>[number];

function SampleTable({ kind, rows }: { kind: "contact" | "account"; rows: SampleRow[] | undefined }) {
  if (rows === undefined) return <LoadingRows />;
  if (!rows.length) return <p className="text-sm text-muted-foreground">No staged {kind}s match this selection yet.</p>;
  const tag = (r: SampleRow) => r.existing ? <span className="ml-2 border border-border px-1 text-xs font-medium text-muted-foreground">in CRM</span> : null;
  return (
    <div className="overflow-x-auto border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
          {kind === "contact" ? (
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Title</th><th className="px-3 py-2">Company</th><th className="px-3 py-2">Seniority</th><th className="px-3 py-2">Department</th></tr>
          ) : (
            <tr><th className="px-3 py-2">Account</th><th className="px-3 py-2">Domain</th><th className="px-3 py-2">Industry</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Region</th></tr>
          )}
        </thead>
        <tbody>
          {rows.map((r) => kind === "contact" ? (
            <tr key={r.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{r.linkedinUrl ? <a className="hover:underline" href={r.linkedinUrl} target="_blank" rel="noreferrer">{r.fullName}</a> : r.fullName}{tag(r)}</td>
              <td className="px-3 py-2">{r.title ?? "—"}</td>
              <td className="px-3 py-2">{r.accountDomain ?? "—"}</td>
              <td className="px-3 py-2">{keyLabel("seniority", r.seniority ?? NONE)}</td>
              <td className="px-3 py-2">{keyLabel("department", r.department ?? NONE)}</td>
            </tr>
          ) : (
            <tr key={r.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{r.name}{tag(r)}{r.discoverySources?.map((source, i) => <blockquote key={i} className="mt-2 max-w-md border-l-2 border-primary/30 pl-2 text-xs font-normal"><a href={source.url} target="_blank" rel="noreferrer" className="underline">Source</a><p className="mt-1 whitespace-normal">{source.quote}</p></blockquote>)}</td>
              <td className="px-3 py-2">{r.domain}</td>
              <td className="px-3 py-2">{keyLabel("industry", r.industry)}</td>
              <td className="px-3 py-2">{keyLabel("sizeBand", r.sizeBand)}</td>
              <td className="px-3 py-2">{keyLabel("region", r.region)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
