"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, Loader2, RotateCcw, Search, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ItemDecision } from "../../../convex/accountHierarchy";
import type { HierarchyItem, ProposalJson } from "../../../engine/src/accountHierarchy/plan";
import type { CitationCheck, GroupResearch } from "../../../engine/src/accountHierarchy/research";
import { LoadingRows } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { primary, small } from "@/components/field-standards/shared";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { recordHref } from "@/components/records/record-target";
import { hierarchyHref } from "./list-page";

const CHECK_LABEL: Record<CitationCheck["result"], string> = {
  verified: "Quote found",
  attested: "Vouched for",
  quote_not_found: "Quote not found",
  unreachable: "Page unreadable",
};
const CHECK_TONE: Record<CitationCheck["result"], string> = {
  verified: "border-primary/50 bg-primary/10 text-primary",
  attested: "border-border bg-muted text-foreground",
  quote_not_found: "border-destructive/40 bg-destructive/10 text-destructive",
  unreachable: "border-warning/40 bg-warning/15 text-warning",
};
const STATUS_LABEL: Record<string, string> = { owned: "Owned", divested: "Divested", not_owned: "Not owned", sale_pending: "Sale pending" };

export function AccountHierarchyGroup() {
  const { groupId } = useParams<{ groupId: string }>();
  const data = useQuery(api.accountHierarchy.group, { groupId: groupId as Id<"hierarchyGroups"> });
  if (data === undefined) return <LoadingRows count={4} />;
  if (data === null) return <p className="text-sm text-muted-foreground">This group is not in the latest scan.</p>;
  const { group, research } = data;
  const canon = data.provider === "canon";
  const nameOf = new Map(group.accounts.map((a) => [a.id, a.name]));
  // A Canon scan shows each company's parent as it is now, so an applied move shows here at once.
  const parentOf = (a: { id: string; parentId?: string }) => (data.parents ? (data.parents[a.id] ?? undefined) : a.parentId);
  return (
    <>
      <Link href={hierarchyHref()} className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> All groups
      </Link>
      <Panel title={`Candidate group: ${group.size} ${canon ? "companies" : "accounts"}`}>
        <p className="mb-2 text-xs text-muted-foreground">{group.reasons.join("; ")}</p>
        <ul className="mb-4 columns-1 gap-6 text-sm sm:columns-2 lg:columns-3">
          {group.accounts.map((a) => (
            <li key={a.id} className="break-inside-avoid truncate">
              {canon ? (
                <Link href={recordHref("account", a.id)} className="record-name hover:underline">{a.name}</Link>
              ) : (
                <>
                  {a.name} <span className="font-mono text-[11px] text-muted-foreground">{a.id}</span>
                </>
              )}
              {parentOf(a) && <span className="ml-1 text-xs text-muted-foreground">under {nameOf.get(parentOf(a)!) ?? "a company outside this group"}</span>}
              {a.shell && <span className="ml-1 text-xs text-warning">shell</span>}
            </li>
          ))}
        </ul>
        <ResearchForm
          groupId={group._id}
          accounts={group.accounts}
          suggestedRootId={research?.rootAccountId ?? group.suggestedRootId}
          suggestedName={research?.groupName ?? ""}
          running={research?.status === "running"}
        />
      </Panel>
      {research?.status === "running" && (
        <Panel title="Research">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Researching {research.groupName} on the web since {new Date(research.startedAt).toLocaleTimeString()}. This
            takes a few minutes.
          </p>
        </Panel>
      )}
      {research?.status === "failed" && (
        <Panel title="Research">
          <p className="text-sm text-destructive">Research stopped: {research.error}</p>
        </Panel>
      )}
      {research?.status === "done" && research.proposal && (
        <Proposal
          researchId={research._id}
          proposal={research.proposal as ProposalJson}
          research={research.research as GroupResearch}
          checks={(research.verification as { checks: CitationCheck[] } | undefined)?.checks ?? []}
          decisions={data.decisions}
          canDecide={data.canDecide}
          canon={canon}
          model={research.model}
          finishedAt={research.finishedAt}
        />
      )}
    </>
  );
}

function ResearchForm({
  groupId,
  accounts,
  suggestedRootId,
  suggestedName,
  running,
}: {
  groupId: Id<"hierarchyGroups">;
  accounts: Array<{ id: string; name: string }>;
  suggestedRootId: string;
  suggestedName: string;
  running: boolean;
}) {
  const start = useMutation(api.accountHierarchy.startResearch);
  const [rootId, setRootId] = useState(suggestedRootId);
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!name) setName(accounts.find((a) => a.id === suggestedRootId)?.name.split(/[\s,]+/)[0] ?? "");
  }, [accounts, suggestedRootId, name]);

  async function submit() {
    setBusy(true);
    try {
      await start({ groupId, groupName: name, rootAccountId: rootId });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        Corporate family
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="LVMH" className="h-9 w-48 border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Top account
        <SelectField value={rootId} onValueChange={setRootId} options={accounts.map((a) => ({ value: a.id, label: a.name }))} className="h-9 w-72" />
      </label>
      <button type="button" className={primary} disabled={busy || running || !name.trim()} onClick={() => void submit()}>
        {busy || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        Research on the web
      </button>
      <span className="basis-full text-xs text-muted-foreground">Runs on your ChatGPT plan. It reads the web and this scan; it writes nothing.</span>
    </div>
  );
}

function Proposal({
  researchId,
  proposal,
  research,
  checks,
  decisions,
  canDecide,
  canon,
  model,
  finishedAt,
}: {
  researchId: Id<"hierarchyResearch">;
  proposal: ProposalJson;
  research: GroupResearch;
  checks: CitationCheck[];
  decisions: Record<string, ItemDecision>;
  canDecide: boolean;
  canon: boolean;
  model?: string;
  finishedAt?: number;
}) {
  const names = new Map(proposal.accounts.map((a) => [a.id, a.name]));
  const nm = (id: string | null) => (id ? (names.get(id) ?? id) : "none");
  const sections: Array<[string, HierarchyItem["op"]]> = [
    ["Merges", "merge"],
    ["Parent moves", "set_parent"],
    ["Region and country fixes", "set_fields"],
  ];
  const checkOf = (url: string, quote: string) => checks.find((c) => c.url === url && c.quote === quote);
  return (
    <>
      <Panel title={`${proposal.group}: proposed changes`}>
        <p className="mb-3 text-xs text-muted-foreground">
          Researched {finishedAt ? new Date(finishedAt).toLocaleString() : ""} by {model ?? "ChatGPT"}. Only claims whose quote was found on the cited page
          became items.{" "}
          {canon
            ? "Approving a parent move changes the parent in Canon now, as you; undo puts the previous parent back. Approving a merge or a field fix only records your decision."
            : "This scan read Salesforce, so approving only records your decision: nothing changes in Canon or Salesforce."}{" "}
          Nothing is written to a CRM.
        </p>
        {sections.map(([title, op]) => {
          const rows = proposal.items.filter((i) => i.op === op);
          return (
            <div key={op} className="mb-4">
              <h4 className="mb-1 text-sm font-medium">
                {title} <span className="tabular-nums text-muted-foreground">({rows.length})</span>
              </h4>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
              ) : (
                <ul className="divide-y divide-border border border-border">
                  {rows.map((it) => (
                    <li key={it.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <ItemText item={it} nm={nm} />
                        {it.warn.map((w) => (
                          <p key={w} className={cn("text-xs", w.startsWith("ACTIVE CONTRACT") ? "font-medium text-destructive" : "text-warning")}>
                            ⚠ {w}
                          </p>
                        ))}
                        {"citations" in it &&
                          it.citations.map((c) => (
                            <p key={`${c.url}${c.quote}`} className="truncate text-xs text-muted-foreground">
                              “{c.quote}” <a href={c.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{c.url}</a>
                            </p>
                          ))}
                      </div>
                      {canon && it.op === "set_parent" ? (
                        <ParentDecision researchId={researchId} itemKey={it.key} decision={decisions[it.key]} canDecide={canDecide} />
                      ) : (
                        <Decision researchId={researchId} itemKey={it.key} decision={decisions[it.key]} canDecide={canDecide} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </Panel>
      <Panel title={`Flags for a person (${proposal.flags.length})`}>
        <ul className="list-disc space-y-1 pl-5 text-sm">{proposal.flags.map((f) => <li key={f}>{f}</li>)}</ul>
      </Panel>
      {proposal.hints.length > 0 && (
        <Panel title="Suggestions, not proposed">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{proposal.hints.map((h) => <li key={h}>{h}</li>)}</ul>
        </Panel>
      )}
      <Panel title="Research and sources">
        <ul className="divide-y divide-border border border-border text-sm">
          {[{ name: research.ultimateParent.name, status: "parent", accountIds: [research.ultimateParent.accountId], citations: research.ultimateParent.citations, facts: [] as GroupResearch["entities"][number]["facts"] }, ...research.entities].map((e) => (
            <li key={e.name} className="px-3 py-2">
              <p>
                <span className="record-name font-medium">{e.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {e.status === "parent" ? "Ultimate parent" : STATUS_LABEL[e.status]}
                  {"ownerNow" in e && e.ownerNow ? ` · now ${e.ownerNow}` : ""}
                  {"parent" in e && e.parent ? ` · under ${e.parent}` : ""}
                  {e.accountIds.length ? ` · ${e.accountIds.map(nm).join(", ")}` : " · no account"}
                </span>
              </p>
              {[...e.citations, ...(e.facts ?? []).flatMap((f) => f.citations.map((c) => ({ ...c, note: `${f.field} = ${f.value}` })))].map((c) => {
                const check = checkOf(c.url, c.quote);
                return (
                  <p key={`${c.url}${c.quote}`} className="mt-1 flex items-start gap-2 text-xs">
                    {check && <span className={cn("shrink-0 border px-1.5 py-0.5 font-medium", CHECK_TONE[check.result])}>{CHECK_LABEL[check.result]}</span>}
                    <span className="min-w-0">
                      “{c.quote}”{c.note ? <span className="text-muted-foreground"> ({c.note})</span> : null}{" "}
                      <a href={c.url} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{c.url}</a>
                      {check?.detail && <span className="text-muted-foreground"> · {check.detail}</span>}
                    </span>
                  </p>
                );
              })}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function ItemText({ item, nm }: { item: HierarchyItem; nm: (id: string | null) => string }) {
  if (item.op === "merge") {
    const fill = Object.entries(item.fill);
    return (
      <p>
        Merge <b>{nm(item.loserId)}</b> into <b>{nm(item.survivorId)}</b>: {item.why}. Moves {item.moves}.
        {fill.length > 0 && ` Survivor takes blank fields: ${fill.map(([k, v]) => `${k} = ${v}`).join(", ")}.`}
      </p>
    );
  }
  if (item.op === "set_parent") {
    return (
      <p>
        Parent of <b>{nm(item.accountId)}</b>: {nm(item.from)} → <b>{nm(item.to)}</b>. {item.why}.
      </p>
    );
  }
  return (
    <p>
      <b>{nm(item.accountId)}</b>: {item.why}.
    </p>
  );
}

const when = (d: ItemDecision) => `${d.decidedBy}, ${new Date(d.appliedAt ?? d.decidedAt).toLocaleString()}`;

/** A decision that is only recorded: merges, field fixes, and every item on a Salesforce scan. */
function Decision({ researchId, itemKey, decision, canDecide }: { researchId: Id<"hierarchyResearch">; itemKey: string; decision?: ItemDecision; canDecide: boolean }) {
  const decide = useMutation(api.accountHierarchy.decide);
  const set = (d: "approved" | "rejected" | "clear") => decide({ researchId, itemKey, decision: d }).catch((e) => toast.error(getErrorMessage(e)));
  const state = decision?.decision;
  const note = state === "approved" ? <span className="text-[11px] text-muted-foreground">Recorded, not applied</span> : null;
  if (!canDecide) return state ? <span className="grid justify-items-end text-xs text-muted-foreground">{state === "approved" ? "Approved" : "Rejected"}{note}</span> : null;
  return (
    <span className="grid justify-items-end gap-1">
      <span className="flex items-start gap-1">
        <button type="button" className={cn(small, state === "approved" && "border-primary bg-primary/10 text-primary")} onClick={() => void set(state === "approved" ? "clear" : "approved")}>
          <Check className="h-3 w-3" /> {state === "approved" ? "Approved" : "Approve"}
        </button>
        <button type="button" className={cn(small, state === "rejected" && "border-destructive bg-destructive/10 text-destructive")} onClick={() => void set(state === "rejected" ? "clear" : "rejected")}>
          <X className="h-3 w-3" /> {state === "rejected" ? "Rejected" : "Reject"}
        </button>
      </span>
      {note}
    </span>
  );
}

/** A Canon scan's parent move: approving changes the parent in Canon, and undo puts the previous one back. */
function ParentDecision({ researchId, itemKey, decision, canDecide }: { researchId: Id<"hierarchyResearch">; itemKey: string; decision?: ItemDecision; canDecide: boolean }) {
  const decide = useMutation(api.accountHierarchy.decide);
  const approve = useAction(api.accountHierarchy.approveParent);
  const undo = useAction(api.accountHierarchy.undoParent);
  const [busy, setBusy] = useState(false);
  async function run(task: () => Promise<{ status: string; message?: string } | null>) {
    setBusy(true);
    try {
      const result = await task();
      if (result && "message" in result && result.message) toast.error(result.message);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const applied = decision?.appliedAt !== undefined;
  const refused = decision?.decision === "approved" && !applied ? decision.applyError ?? null : null;
  const status = applied ? (
    <span className="text-[11px] font-medium text-primary">Applied · {when(decision!)}</span>
  ) : refused ? (
    <span className="max-w-[32ch] text-right text-[11px] text-destructive">Not applied: {refused}</span>
  ) : null;
  if (!canDecide) {
    return <span className="grid justify-items-end text-xs text-muted-foreground">{decision?.decision === "rejected" ? "Rejected" : null}{status}</span>;
  }
  return (
    <span className="grid justify-items-end gap-1">
      <span className="flex items-start gap-1">
        {applied ? (
          <button type="button" className={small} disabled={busy} onClick={() => void run(() => undo({ researchId, itemKey }))}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Undo
          </button>
        ) : (
          <>
            <button type="button" className={small} disabled={busy} onClick={() => void run(() => approve({ researchId, itemKey }))}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} {refused ? "Try again" : "Approve and apply"}
            </button>
            <button
              type="button"
              className={cn(small, decision?.decision === "rejected" && "border-destructive bg-destructive/10 text-destructive")}
              disabled={busy}
              onClick={() => void run(() => decide({ researchId, itemKey, decision: decision?.decision === "rejected" ? "clear" : "rejected" }))}
            >
              <X className="h-3 w-3" /> {decision?.decision === "rejected" ? "Rejected" : "Reject"}
            </button>
          </>
        )}
      </span>
      {status}
    </span>
  );
}
