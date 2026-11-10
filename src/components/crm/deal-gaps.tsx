"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.dealGaps.forDeal>>>;
type Proposal = Data["suggestions"][number];

export const VIA_LABEL: Record<string, string> = { crm: "In your CRM", email: "Email", linkedin: "LinkedIn", call: "Meeting", search: "Search" };

/** A proposal's evidence: where it came from, and a link to that thread, meeting, record or website. */
export function ProposalEvidence({ via, evidence, link }: { via: string | null | undefined; evidence: string | null; link: { href: string | null; external: boolean } | null }) {
  if (!via && !evidence) return null;
  const label = link?.href
    ? link.external ? <a href={link.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{evidence ?? "Open"}</a>
      : <Link href={link.href} className="underline underline-offset-2">{evidence ?? "Open"}</Link>
    : evidence;
  return (
    <p className="mt-0.5 text-xs text-muted-foreground" data-testid="deal-gap-evidence">
      {via && <span className="mr-1.5 rounded border border-border px-1 py-px text-[11px]">{VIA_LABEL[via] ?? via}</span>}
      {label}
    </p>
  );
}

/**
 * "Missing company" and "Missing people" on a deal's page (convex/dealGaps.ts): what Canon found in the CRM and the
 * owner's conversations, each with its evidence. Accept links it to the deal, creating the record first when the CRM
 * has none. Search looks outside Canon and runs only when pressed.
 */
export function DealGaps({ streamId, onChanged }: { streamId: string; onChanged: () => void }) {
  const data = useQuery(api.dealGaps.forDeal, { streamId });
  const create = useAction(api.callSuggestions.create);
  const dismiss = useMutation(api.callSuggestions.dismiss);
  const checkNow = useAction(api.dealGapActions.checkNow);
  const search = useAction(api.dealGapActions.search);
  const [busy, setBusy] = useState<string | null>(null);
  const [websites, setWebsites] = useState<Record<string, string>>({});
  if (!data) return null;
  const companies = data.suggestions.filter((s) => s.kind === "account");
  const people = data.suggestions.filter((s) => s.kind === "contact");
  if (data.hasCompany && data.hasPeople && !people.length) return null;

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }
  const accept = (s: Proposal) => run(s.id, async () => {
    const website = websites[s.id]?.trim();
    await create({ ids: [s.id as Id<"callSuggestions">], ...(website ? { websites: [{ id: s.id as Id<"callSuggestions">, domain: website }] } : {}) });
    void toast.success(`${s.values.name ?? s.values.email ?? "It"} ${s.existing ? "linked to" : "added to the CRM and linked to"} this deal`);
    onChanged();
  });
  const find = (kind: "account" | "contact") => run(`search:${kind}`, async () => {
    const r = await search({ streamId, kind });
    void (r.added ? toast.success(r.message) : toast.error(r.message));
  });

  const row = (s: Proposal) => (
    <li key={s.id} className="flex items-start justify-between gap-3 py-2" data-testid="deal-gap-proposal">
      <div className="min-w-0 text-sm">
        <p>
          <span className="font-medium">{s.values.name ?? s.values.email ?? s.values.domain}</span>
          {s.values.title && <>, {s.values.title}</>}
          {s.values.domain && <span className="text-muted-foreground"> · {s.values.domain}</span>}
          {s.values.email && s.kind === "contact" && <span className="text-muted-foreground"> · {s.values.email}</span>}
          {!s.existing && <span className="ml-1.5 text-xs text-muted-foreground">(new)</span>}
        </p>
        <ProposalEvidence via={s.via} evidence={s.evidence} link={s} />
        {s.kind === "account" && !s.existing && !s.values.domain && (
          <input aria-label={`${s.values.name} website`} placeholder="Website, such as acme.com" value={websites[s.id] ?? ""} onChange={(e) => setWebsites((w) => ({ ...w, [s.id]: e.target.value }))}
            className="mt-1 w-48 rounded border border-input bg-background px-2 py-1 text-xs" />
        )}
      </div>
      {data.canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" disabled={Boolean(busy)} onClick={() => void accept(s)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} {s.existing ? "Link" : "Add"}
          </button>
          <button type="button" aria-label="Dismiss" disabled={Boolean(busy)} onClick={() => void run(s.id, async () => { await dismiss({ ids: [s.id as Id<"callSuggestions">] }); })}
            className="rounded-md border border-input p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"><X className="h-3.5 w-3.5" /></button>
        </span>
      )}
    </li>
  );
  const searchButton = (kind: "account" | "contact", label: string) => data.canEdit && (
    <button type="button" disabled={Boolean(busy)} onClick={() => void find(kind)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
      {busy === `search:${kind}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} {label}
    </button>
  );
  const section = (title: string, items: Proposal[], empty: string, kind: "account" | "contact", searchLabel: string) => (
    <div className="border border-border bg-card px-4 py-3" data-testid={`deal-gap-${kind}`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="flex items-center gap-3">
          <IntegrationGate feature="treg">{searchButton(kind, searchLabel)}</IntegrationGate>
          {data.canEdit && (
            <button type="button" disabled={Boolean(busy)} onClick={() => void run("check", async () => { const n = await checkNow({ streamId }); void (n ? toast.success(`Found ${n} to review`) : toast.success("Nothing new in your CRM or conversations")); })}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline disabled:opacity-50">
              {busy === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check again
            </button>
          )}
        </span>
      </div>
      {items.length ? <ul className="mt-1 divide-y divide-border">{items.map(row)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
  return (
    <div className="grid gap-3" data-testid="deal-gaps">
      {!data.hasCompany && section("Missing company", companies, "Nothing in your CRM or conversations names this deal's company yet.", "account", "Search companies")}
      {(!data.hasPeople || people.length > 0) && section(data.hasPeople ? "Suggested people" : "Missing people", people, "No one from this deal's conversations or company yet.", "contact", "Search people")}
    </div>
  );
}

/** "Find missing companies and people": check every open deal of yours with a gap; progress shows in the background tray. */
export function DealGapScan() {
  const scan = useAction(api.dealGapActions.scanMine);
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy} data-testid="deal-gap-scan" title="Find missing companies and people on my deals"
      onClick={() => {
        setBusy(true);
        void scan({})
          .then((r) => void toast.success(r.proposals ? `Found ${r.proposals} to review across ${r.deals} deals` : `Checked ${r.deals} deals: nothing new`))
          .catch((cause) => void toast.error(getErrorMessage(cause)))
          .finally(() => setBusy(false));
      }}
      className="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Find missing records
    </button>
  );
}
