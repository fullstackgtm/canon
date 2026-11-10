"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronUp, Loader2, Plus, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import Link from "next/link";
import { conversationHref } from "./conversations";
import { ProposalEvidence } from "./deal-gaps";
import { recordHref } from "@/components/records/record-target";
import { toast } from "@/lib/toast";
import { cn, formatCurrency, getErrorMessage } from "@/lib/utils";

type Group = NonNullable<ReturnType<typeof useQuery<typeof api.callSuggestions.mine>>>["groups"][number];

type Kind = Group["suggestions"][number]["kind"];

const KINDS: Array<{ value: Kind; label: string; one: string; many: string }> = [
  { value: "contact", label: "People", one: "person", many: "people" },
  { value: "account", label: "Companies", one: "company", many: "companies" },
  { value: "deal", label: "Deals", one: "deal", many: "deals" },
];

type Source = "email" | "linkedin" | "call" | "deal";
const SOURCES: Array<{ value: Source; label: string }> = [
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "call", label: "Call" },
  { value: "deal", label: "Missing on deals" },
];
const sourceOf = (g: Group): Source | null => (g.source === "email" || g.source === "linkedin" || g.source === "call" || g.source === "deal" ? g.source : null);

/** Suggestions the list renders at a time; "Show more" adds this many. */
const PAGE = 40;
/** Suggestions one create takes (convex/callSuggestions.ts CREATE_MAX) and one dismiss takes (DISMISS_MAX). */
const CREATE_CHUNK = 25;
const DISMISS_CHUNK = 250;

type DealEdit = { name: string; amount: string; close: string };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One conversation's ticked ids in creates of at most CREATE_CHUNK, a company with its people in the same create: a
 * website the reviewer corrected only reaches the people created alongside it. Deals go last, after their people.
 */
function packed(g: Group, ids: string[]): string[][] {
  const kindOf = new Map<string, Group["suggestions"][number]>(g.suggestions.map((s) => [s.id, s]));
  const buckets = new Map<string, string[]>();
  for (const id of ids) {
    const s = kindOf.get(id)!;
    const key = s.kind === "deal" ? "~deal" : s.values.domain ?? `~${id}`;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  }
  const order = { account: 0, contact: 1, deal: 2 } as const;
  const out: string[][] = [];
  for (const [, bucket] of [...buckets].sort(([a], [b]) => Number(a === "~deal") - Number(b === "~deal"))) {
    bucket.sort((a, b) => order[kindOf.get(a)!.kind] - order[kindOf.get(b)!.kind]);
    const last = out[out.length - 1];
    if (last && last.length + bucket.length <= CREATE_CHUNK) last.push(...bucket);
    else out.push(...chunks(bucket, CREATE_CHUNK));
  }
  return out;
}

const chunks = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * What your meetings, email threads and LinkedIn conversations suggest adding (convex/callSuggestions.ts). One
 * summary bar that opens the list; nothing when there are none. Filter by source and kind, tick rows (or every row
 * the filter shows) and accept or dismiss them together. A page opens on its own kind: people on People, and so on.
 */
function CallSuggestionsEnabled({ kind: initialKind, className }: { kind?: Kind; className?: string }) {
  const data = useQuery(api.callSuggestions.mine);
  const create = useAction(api.callSuggestions.create);
  const dismiss = useMutation(api.callSuggestions.dismiss);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | "all">(initialKind ?? "all");
  const [source, setSource] = useState<Source | "all">("all");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [websites, setWebsites] = useState<Record<string, string>>({});
  const [deals, setDeals] = useState<Record<string, DealEdit>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const all = useMemo(() => data?.groups ?? [], [data]);
  const canCreateDeals = data?.canCreateDeals ?? false;
  const groups = useMemo(() => all.flatMap((g) => {
    if (source !== "all" && sourceOf(g) !== source) return [];
    if (kind === "all") return [g];
    if (!g.suggestions.some((s) => s.kind === kind)) return [];
    if (kind !== "contact") return [{ ...g, suggestions: g.suggestions.filter((s) => s.kind === kind) }];
    // People at a company only named in the meeting keep that company beside them: it is confirmed (or its website
    // corrected) before they are added under it.
    const domains = new Set(g.suggestions.filter((s) => s.kind === "contact").map((s) => s.values.domain));
    return [{ ...g, suggestions: g.suggestions.filter((s) => s.kind === "contact" || (s.kind === "account" && s.evidence && domains.has(s.values.domain))) }];
  }), [all, kind, source]);
  // Anything can be ticked to dismiss; accepting skips deals for those who may not create them.
  const visibleIds = useMemo(() => groups.flatMap((g) => g.suggestions.map((s) => s.id)), [groups]);
  // What is ticked and still pending in this filter: a ticked row the filter hides is not acted on.
  const live = new Set<string>(visibleIds);
  const selected = [...picked].filter((id) => live.has(id));
  if (!data || !all.length) return null;

  const total = all.reduce((n, g) => n + g.suggestions.length, 0);
  const count = (k: Kind) => all.reduce((n, g) => n + g.suggestions.filter((s) => s.kind === k).length, 0);
  const bySource = (src: Source) => all.filter((g) => sourceOf(g) === src).reduce((n, g) => n + g.suggestions.length, 0);
  // Render up to `shown` suggestions; a long conversation is cut and continues on "Show more".
  const page: Group[] = [];
  let budget = shown;
  for (const g of groups) {
    if (budget <= 0) break;
    page.push(g.suggestions.length > budget ? { ...g, suggestions: g.suggestions.slice(0, budget) } : g);
    budget -= g.suggestions.length;
  }
  const rows = groups.reduce((n, g) => n + g.suggestions.length, 0);
  const allPicked = visibleIds.length > 0 && selected.length === visibleIds.length;

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const dealEdit = (g: Group): DealEdit => {
    const d = g.suggestions.find((s) => s.kind === "deal");
    return deals[g.key] ?? { name: d?.values.name ?? "", amount: d?.values.amount !== undefined ? String(d.values.amount / 100) : "", close: d?.values.closeDate ?? day(g.at + 30 * 86_400_000) };
  };

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

  /** Accept the ticked rows: one create per conversation (create takes one source at a time), the rest go on when one fails. */
  async function accept(ids: string[]) {
    const want = new Set<string>(ids.filter((id) => canCreateDeals || !all.some((g) => g.suggestions.some((s) => s.id === id && s.kind === "deal"))));
    const work = all.map((g) => ({ g, ids: g.suggestions.filter((s) => want.has(s.id)).map((s) => s.id) })).filter((w) => w.ids.length);
    const totals = { companies: 0, people: 0, deals: 0 };
    const skipped: string[] = [];
    const failed: string[] = [];
    let done = 0;
    for (const { g, ids: groupIds } of work) {
      setBusy(`Accepting ${++done} of ${work.length} conversations…`);
      const deal = g.suggestions.find((s) => s.kind === "deal" && want.has(s.id));
      const edit = dealEdit(g);
      try {
        const amount = edit.amount.trim() ? Math.round(Number(edit.amount.replace(/[$,]/g, "")) * 100) : undefined;
        if (deal && amount !== undefined && !Number.isFinite(amount)) throw new Error("the deal amount is a number, such as 50000");
        for (const part of packed(g, groupIds)) {
          // A deal brings its conversation's company and people along (server side), so their corrections go too.
          const given = (deal && part.includes(deal.id) ? g.suggestions.map((s) => s.id) : part).filter((id) => websites[id]?.trim()).map((id) => ({ id: id as Id<"callSuggestions">, domain: websites[id]!.trim() }));
          const r = await create({
            ids: part as Id<"callSuggestions">[],
            ...(given.length ? { websites: given } : {}),
            ...(deal && part.includes(deal.id) ? { deal: { name: edit.name, closeDate: edit.close, ...(amount !== undefined ? { amount } : {}) } } : {}),
          });
          totals.companies += r.companies;
          totals.people += r.people;
          if (r.deal) totals.deals++;
          skipped.push(...r.skipped);
        }
      } catch (cause) {
        failed.push(`${g.title}: ${getErrorMessage(cause)}`);
      }
    }
    setPicked((p) => new Set([...p].filter((id) => !want.has(id))));
    const parts = [
      totals.companies && `${totals.companies} ${totals.companies === 1 ? "company" : "companies"}`,
      totals.people && `${totals.people} ${totals.people === 1 ? "person" : "people"}`,
      totals.deals && `${totals.deals} ${totals.deals === 1 ? "deal" : "deals"}`,
    ].filter(Boolean);
    if (!failed.length || parts.length) void toast.success(parts.length ? `Added ${parts.join(", ")}` : "Already in the CRM: linked the conversations to them");
    if (skipped.length) void toast.error(`Not added: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""}. A person needs a company: give the company's website, find who they are, or dismiss.`);
    if (failed.length) void toast.error(`${failed.length} ${failed.length === 1 ? "conversation" : "conversations"} not added. ${failed[0]}`);
  }

  async function dismissIds(ids: string[]) {
    for (const part of chunks(ids, DISMISS_CHUNK)) await dismiss({ ids: part as Id<"callSuggestions">[] });
    setPicked((p) => new Set([...p].filter((id) => !ids.includes(id))));
    void toast.success(`Dismissed ${ids.length} ${ids.length === 1 ? "suggestion" : "suggestions"}`);
  }

  const chip = (active: boolean) => cn("rounded-full border px-2.5 py-0.5 text-xs", active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted");
  const summary = KINDS.map((k) => ({ ...k, n: count(k.value) })).filter((k) => k.n).map((k) => `${k.n} ${k.n === 1 ? k.one : k.many}`).join(", ");
  return (
    <section className={cn("border border-border bg-card", className)} data-testid="call-suggestions">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/50">
        <span><span className="font-semibold">From your conversations</span> <span className="text-muted-foreground">· {summary} from {all.length} {all.length === 1 ? "conversation" : "conversations"}</span></span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">{open ? "Hide" : "Review"} {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
      </button>
      {open && (
        <div className="border-t border-border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2" data-testid="call-suggestions-filters">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Source">
              <button type="button" className={chip(source === "all")} aria-pressed={source === "all"} onClick={() => { setSource("all"); setShown(PAGE); }}>All sources · {total}</button>
              {SOURCES.map((src) => bySource(src.value) > 0 && (
                <button key={src.value} type="button" className={chip(source === src.value)} aria-pressed={source === src.value} onClick={() => { setSource(src.value); setShown(PAGE); }}>{src.label} · {bySource(src.value)}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Kind">
              <button type="button" className={chip(kind === "all")} aria-pressed={kind === "all"} onClick={() => { setKind("all"); setShown(PAGE); }}>Everything</button>
              {KINDS.map((k) => count(k.value) > 0 && (
                <button key={k.value} type="button" className={chip(kind === k.value)} aria-pressed={kind === k.value} onClick={() => { setKind(k.value); setShown(PAGE); }}>{k.label} · {count(k.value)}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-sm" data-testid="call-suggestions-bulk">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allPicked} disabled={Boolean(busy) || !visibleIds.length} aria-label="Select all in this filter"
                onChange={() => setPicked((p) => (allPicked ? new Set([...p].filter((id) => !live.has(id))) : new Set([...p, ...visibleIds])))} />
              {selected.length ? `${selected.length} selected` : `Select all ${visibleIds.length}`}
            </label>
            <span className="flex-1" />
            {busy && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {busy}</span>}
            <button type="button" disabled={Boolean(busy) || !selected.length} onClick={() => void run("Accepting…", () => accept(selected))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Plus className="h-4 w-4" /> Accept selected
            </button>
            <button type="button" disabled={Boolean(busy) || !selected.length} onClick={() => void run("Dismissing…", () => dismissIds(selected))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
              <X className="h-4 w-4" /> Dismiss selected
            </button>
          </div>
          {page.length ? page.map((g) => (
            <MeetingSuggestions key={g.key} group={g} canCreateDeals={canCreateDeals} busy={Boolean(busy)} picked={picked} toggle={toggle}
              websites={websites} setWebsite={(id, d) => setWebsites((w) => ({ ...w, [id]: d }))}
              deal={dealEdit(g)} setDeal={(d) => setDeals((all) => ({ ...all, [g.key]: d }))}
              onFound={(id) => setPicked((p) => new Set(p).add(id))} />
          )) : <p className="px-4 py-3 text-sm text-muted-foreground">Nothing in this filter.</p>}
          {rows > shown && (
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="w-full border-t border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50">
              Show {Math.min(PAGE, rows - shown)} more ({rows - shown} not shown)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const SOURCE_LABEL: Record<Source, string> = { email: "Email", linkedin: "LinkedIn", call: "Call", deal: "Deal" };

function MeetingSuggestions({ group, canCreateDeals, busy, picked, toggle, websites, setWebsite, deal, setDeal, onFound }: {
  group: Group; canCreateDeals: boolean; busy: boolean; picked: Set<string>; toggle: (id: string) => void;
  websites: Record<string, string>; setWebsite: (id: string, domain: string) => void;
  deal: DealEdit; setDeal: (d: DealEdit) => void; onFound: (id: string) => void;
}) {
  // A company only named in the meeting (no attendee address behind it): research's match is a best guess to confirm.
  const named = (s: Group["suggestions"][number]) => s.kind === "account" && Boolean(s.evidence);
  const src = sourceOf(group);
  const thread = group.dealStreamId
    ? <Link href={recordHref("deal", group.dealStreamId)} className="text-xs text-primary hover:underline">Open deal</Link>
    : group.conversationId
    ? <Link href={conversationHref(group.conversationId)} className="text-xs text-primary hover:underline">Open thread</Link>
    : group.meetingUrl ? <a href={group.meetingUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Open meeting</a> : null;
  return (
    <div className="border-b border-border px-4 py-3 last:border-b-0" data-testid="call-suggestions-meeting">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
          {src && <span className="rounded border border-border px-1.5 py-px text-[11px] font-normal text-muted-foreground" data-testid="call-suggestions-source">{SOURCE_LABEL[src]}</span>}
          <span className="truncate">{group.title}</span>
        </p>
        <span className="flex shrink-0 items-baseline gap-2 text-xs text-muted-foreground">{thread}{day(group.at)}</span>
      </div>
      <ul className="mt-2 space-y-2 text-sm">
        {group.suggestions.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              aria-label={`Select ${s.values.name ?? s.values.email ?? s.values.domain}`}
              checked={picked.has(s.id)}
              disabled={busy}
              onChange={() => toggle(s.id)}
            />
            <div className="min-w-0 flex-1">
              {s.kind === "account" && (
                <div>
                  <p><span className="text-muted-foreground">Company</span> {s.values.name} {s.values.domain && <span className="text-muted-foreground">· {s.values.domain}</span>}</p>
                  {(group.dealStreamId ? !s.values.domain && !s.existing : !s.values.domain || named(s)) && (
                    <label className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {s.values.domain ? "Website (correct it if this is the wrong company):" : "Named in the conversation, not found in public sources. Its website:"}
                      <input aria-label={`${s.values.name} website`} placeholder="acme.com" value={websites[s.id] ?? s.values.domain ?? ""} disabled={busy}
                        onChange={(e) => setWebsite(s.id, e.target.value)}
                        className="w-40 rounded border border-input bg-background px-2 py-1 text-sm text-foreground" />
                    </label>
                  )}
                  {s.research?.status === "found" && s.research.sourceUrl && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Named in the conversation. Best match from public sources: <a href={s.research.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{hostOf(s.research.sourceUrl)}</a>. Tick it once you&apos;ve confirmed it&apos;s the right company.
                    </p>
                  )}
                </div>
              )}
              {s.kind === "contact" && (
                <div>
                  <p>
                    <span className="text-muted-foreground">Person</span> {s.values.name}
                    {s.values.title && <>, {s.values.title}</>}
                    {s.values.companyName && <> at {s.values.companyName} <span className="text-muted-foreground">({s.values.domain})</span></>}
                    {" "}<span className="text-muted-foreground">· {s.values.email ?? (group.source === "linkedin" ? "on LinkedIn" : "named in the conversation")}</span>
                    {s.values.linkedinUrl && <> · <a href={s.values.linkedinUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">LinkedIn</a></>}
                  </p>
                  {!s.values.email && s.research?.status === "not_found" && (
                    <p className="mt-1 text-xs text-muted-foreground">Only the name the conversation used: public sources didn&apos;t confirm their full name. Check before adding.</p>
                  )}
                  {!s.values.domain && !s.values.email && (
                    <label className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      No company yet. Their company&apos;s website:
                      <input aria-label={`${s.values.name} company website`} placeholder="acme.com" value={websites[s.id] ?? ""} disabled={busy}
                        onChange={(e) => setWebsite(s.id, e.target.value)}
                        className="w-40 rounded border border-input bg-background px-2 py-1 text-sm text-foreground" />
                    </label>
                  )}
                  {!s.values.domain && s.values.email && !group.dealStreamId && (
                    <PersonResearch id={s.id} notFound={s.research?.status === "not_found"} onFound={() => onFound(s.id)} />
                  )}
                  {s.research?.status === "found" && s.research.sourceUrl && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Found from public sources: <a href={s.research.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{hostOf(s.research.sourceUrl)}</a>. Check it&apos;s the right person.
                    </p>
                  )}
                </div>
              )}
              {s.kind === "deal" && (
                <div>
                  <p>
                    <span className="text-muted-foreground">Deal</span>{" "}
                    {canCreateDeals ? "" : <span className="text-xs text-muted-foreground">(only admins and managers create deals)</span>}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <input aria-label="Deal name" value={deal.name} onChange={(e) => setDeal({ ...deal, name: e.target.value })} disabled={busy || !canCreateDeals} className="w-64 rounded border border-input bg-background px-2 py-1 text-sm" />
                    <input aria-label="Deal amount" inputMode="decimal" placeholder="Amount" value={deal.amount} onChange={(e) => setDeal({ ...deal, amount: e.target.value })} disabled={busy || !canCreateDeals} className="w-28 rounded border border-input bg-background px-2 py-1 text-sm" />
                    <input aria-label="Deal close date" type="date" value={deal.close} onChange={(e) => setDeal({ ...deal, close: e.target.value })} disabled={busy || !canCreateDeals} className="rounded border border-input bg-background px-2 py-1 text-sm" />
                  </div>
                  {s.values.amount !== undefined && <p className="mt-1 text-xs text-muted-foreground">Amount said in the conversation: {formatCurrency(s.values.amount)}</p>}
                </div>
              )}
              {group.dealStreamId
                ? <ProposalEvidence via={s.via} evidence={`${s.existing ? "Link from your CRM. " : "New record. "}${s.evidence ?? ""}`} link={s.link} />
                : (s.evidence ?? s.research?.quote) && <p className="mt-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">“{s.evidence ?? s.research?.quote}”</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};

/** A person on personal email with no company yet: research who they are, on the caller's ChatGPT plan. */
function PersonResearch({ id, notFound, onFound }: { id: string; notFound: boolean; onFound: () => void }) {
  const identify = useAction(api.callSuggestionActions.identify);
  const [busy, setBusy] = useState(false);
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {notFound ? "Couldn't tell who this is from public sources. " : "Personal email, no company yet. "}
      <button type="button" disabled={busy} className="underline underline-offset-2 disabled:opacity-50"
        onClick={() => {
          setBusy(true);
          void identify({ id: id as Id<"callSuggestions"> })
            .then((r) => {
              if (r.found) {
                onFound();
                void toast.success(`Found them at ${r.companyName}`);
              } else void toast.error("Couldn't tell who this is from public sources");
            })
            .catch((cause) => void toast.error(getErrorMessage(cause)))
            .finally(() => setBusy(false));
        }}>
        {busy ? "Searching…" : notFound ? "Try again" : "Find who this is"}
      </button>
    </p>
  );
}

export function CallSuggestions(props: React.ComponentProps<typeof CallSuggestionsEnabled>) {
  return <IntegrationGate feature="chatgpt"><CallSuggestionsEnabled {...props} /></IntegrationGate>;
}
