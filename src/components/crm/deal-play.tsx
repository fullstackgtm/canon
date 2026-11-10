"use client";

import { IntegrationActionGate, IntegrationGate } from "@/components/integration-gate";

import { DealChat, DealChatButton } from "./deal-chat";

/**
 * A deal's control plane (docs/deal-plays.md): the keeper's read of what is
 * off track, the brief with its evidence, the outreach plan, the account map
 * with each person's thread, and every touch with them. Reads dealPlays.get
 * and rereads after each change; polls while a research run is going.
 */
import { useObjectLabels } from "@/components/records/object-labels";
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { ArrowRight, Check, ExternalLink, Loader2, Plus, Send, Sparkles, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { ControlPlane, PlayPerson, PlayRow, PlayStep } from "../../../convex/dealPlays";
import { emailParagraphs, type DraftCheck } from "../../../convex/lib/plays/drafts";
import { DEAL_ROLES, ROLE_LABEL, type DealRole } from "../../../convex/lib/committee";
import {
  CHANNEL_LABEL, CONFIDENCE, DEAL_STAGES, HEALTH_LABEL, ITEM_KINDS, ITEM_LABEL, PLAY_CHANNELS, THREAD_LABEL, orgTree, type OrgNode,
  type Channel, type Flag, type ItemKind, type Proposal, type ThreadState,
} from "../../../convex/lib/plays/model";
import { recordHref } from "@/components/records/lookup-field";
import { CrmRoleNotes } from "@/components/records/crm-note";
import { MultiSelect } from "@/components/ui/multi-select";
import { FlowCanvas, FlowRows, FlowSwitch, type FlowNode } from "@/components/flow/flow-canvas";
import { SelectField } from "@/components/ui/select";
import { AiCell, quoteAndSource, useContactAiFields, useContactAnswers } from "@/components/research/ai-cell";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, formatCurrency, getErrorMessage } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/background-activity";
import { draftSelected, rankingInput, selectProspects, visibleProspects } from "../../../convex/lib/plays/prospectSelection";
import { specBuyer } from "../../../convex/lib/icps";
import { isBuyer } from "../../../convex/lib/icpGates";
import { CENTER_LABEL, employment, PEOPLE_RESEARCH_MAX } from "../../../convex/lib/plays/peopleResearch";
import { researchAgain } from "../../../convex/lib/plays/runs";
import { offered, panelActions, sectionActions, showsPart, type ActionId, type Context, type Host, type Offer, type PageAction, type PageSpec, type PlayComponent, type RecordComponent } from "../../../recipes";
import { PageSections, type Renderers, type SectionOf } from "@/components/records/page-sections";

const head = "text-xs font-medium text-muted-foreground";
const label = "text-xs font-medium text-muted-foreground";
const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const field = "border border-border bg-background px-2 py-1 text-xs";
const primaryBtn = "inline-flex items-center gap-1 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
/** The deal page's ICP filter, the same on every deal: saved ICP ids, or null before the person has picked. */
const ICP_FILTER_KEY = "canon.deal.icpFilter";
const noSubscribe = () => () => {};
function readIcpFilterRaw(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(ICP_FILTER_KEY); } catch { return null; }
}
function parseIcpFilter(raw: string | null): string[] | null {
  try {
    const ids: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : null;
  } catch {
    return null;
  }
}
function writeIcpFilter(ids: string[]) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(ICP_FILTER_KEY, JSON.stringify(ids)); } catch { /* storage off: the pick lasts this visit */ }
}

/** The deal's people list: pick, person, the three research columns, researched, contacted, their first touch. */
const PEOPLE_GRID = "grid grid-cols-[24px_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_5rem_5.5rem_6.5rem] items-start gap-4";
const linkBtn = "text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50";

type Team = ReadonlyArray<{ _id: string; name?: string }>;
type Run = (change: () => Promise<unknown>, done?: string) => Promise<void>;

function Panel({ title, action, children, className, collapsed = false }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; collapsed?: boolean }) {
  if (collapsed) return (
    <details className={cn("min-w-0 rounded-lg border border-border bg-card p-4", className)}>
      <summary className={cn(head, "cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring")}>{title}</summary>
      <div className="mt-4">
        {action && <div className="mb-3 flex flex-wrap justify-end gap-2">{action}</div>}
        {children}
      </div>
    </details>
  );
  return (
    <section className={cn("min-w-0 border border-border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={head}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const SEVERITY_DOT = { high: "bg-red-500", medium: "bg-amber-500", low: "bg-muted-foreground/50" } as const;
const HEALTH_TONE = { on_track: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400", needs_attention: "border-amber-500/50 text-amber-700 dark:text-amber-400", at_risk: "border-red-500/50 text-red-700 dark:text-red-400" } as const;
const THREAD_TONE: Record<ThreadState, string> = {
  untouched: "text-muted-foreground", waiting: "text-foreground", replied: "text-red-700 dark:text-red-400 font-medium", engaged: "text-emerald-700 dark:text-emerald-400", quiet: "text-amber-700 dark:text-amber-400",
};
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Text that turns into a field on click and saves on blur or Enter. Empty saves as a clear. */
function EditText({ value, placeholder, multiline, disabled, onSave, className }: {
  value: string | null; placeholder: string; multiline?: boolean; disabled?: boolean; onSave: (next: string) => Promise<void>; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const commit = async () => {
    setEditing(false);
    if (draft.trim() !== (value ?? "").trim()) await onSave(draft.trim());
  };
  if (!editing) {
    return (
      <button type="button" disabled={disabled} onClick={() => { setDraft(value ?? ""); setEditing(true); }} className={cn("block w-full whitespace-pre-wrap text-left disabled:cursor-default", !value && "text-muted-foreground", className)}>
        {value || (disabled ? "—" : placeholder)}
      </button>
    );
  }
  const props = {
    autoFocus: true, value: draft, placeholder, className: cn(field, "w-full text-sm", className),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => void commit(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); }
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

/** The record's own sections, which the record page draws: its header, fields, timeline, history, related records, products, splits and apps. */
export type RecordRenderers = Pick<Renderers, RecordComponent | "header">;

/** `page` is the workspace recipe's `deal.page` slot. Every section, the play's and the record's, shows in its order. */
export function DealPlay({ streamId, amount, currency, team, page, record }: { streamId: string; amount: number | null; currency: string | null; team: Team | undefined; page: PageSpec; record: RecordRenderers }) {
  const read = useAction(api.dealPlays.get);
  const [data, setData] = useState<ControlPlane | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => read({ streamId }), [read, streamId]);
  useEffect(() => {
    let live = true;
    setFailed(null);
    load().then((r) => { if (live) setData(r); }, (cause) => { if (live) { setData(null); setFailed(getErrorMessage(cause)); } });
    return () => { live = false; };
  }, [load]);
  const running = data?.research?.status === "running" || data?.peopleResearch?.status === "running" || data?.stateRun?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load().then(setData, () => {}), 4000);
    return () => clearInterval(t);
  }, [running, load]);
  const run: Run = useCallback(async (change, done) => {
    setBusy(true);
    try {
      await change();
      setData(await load());
      if (done) void toast.success(done);
    } catch (cause) {
      await load().then(setData, () => {});
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [load]);

  // While the play loads, the page's header still says which deal this is.
  if (data === undefined) return <><PageSections object="deal" page={page.filter((s) => s.component === "header")} stage={null} renderers={{ ...NO_PLAY, ...record }} /><div className="my-4 border border-border bg-card p-4 text-sm text-muted-foreground">Loading the play…</div></>;
  const recordOnly = <PageSections object="deal" page={page} stage={null} renderers={{ ...NO_PLAY, ...record }} />;
  if (failed) return <><div role="alert" className="mb-6 border border-destructive/50 bg-card p-4 text-sm text-destructive">The play couldn&apos;t load. {failed}</div>{recordOnly}</>;
  if (data === null) return recordOnly;
  return <Plane data={{ ...data, deal: { ...data.deal, amount, currency } }} busy={busy} run={run} team={team} page={page} record={record} />;
}

type SectionProps = { data: ControlPlane; busy: boolean; run: Run; team: Team | undefined; page: PageSpec; propose: (p: Proposal) => Promise<void> };
type PlaySection<K extends PlayComponent> = SectionProps & { section: SectionOf<K> };

/** The play's sections, drawn only once the play loads: none of them can show without it. */
export const NO_PLAY: Pick<Renderers, PlayComponent> = {
  queue: () => null, summary: () => null, stageRail: () => null, fanOut: () => null, prep: () => null,
  plan: () => null, keeper: () => null, brief: () => null, accountMap: () => null, touches: () => null,
};

/** Each play component by kind, given the play. */
const playRenderers = (p: SectionProps): Pick<Renderers, PlayComponent> => ({
  queue: (section) => <DealQueue streamId={p.data.streamId} actions={sectionActions(section)} ctx={pageContext(p.data)} />,
  summary: (section) => <><DealStateSection data={p.data} busy={p.busy} run={p.run} /><Summary {...p} section={section} /></>,
  stageRail: () => <StageRail data={p.data} />,
  fanOut: (section) => <FanOut key={p.data.streamId} {...p} section={section} />,
  prep: () => <Prep data={p.data} />,
  plan: (section) => <Plan {...p} section={section} />,
  keeper: (section) => <Keeper {...p} section={section} />,
  brief: (section) => <Brief {...p} section={section} />,
  accountMap: (section) => <AccountMap {...p} section={section} />,
  touches: (section) => <Touches data={p.data} section={section} />,
});

function Plane({ data, busy, run, team, page, record }: { data: ControlPlane; busy: boolean; run: Run; team: Team | undefined; page: PageSpec; record: RecordRenderers }) {
  const saveStep = useAction(api.dealPlays.saveStep);
  const { streamId } = data;
  const propose = (p: Proposal) => run(() => saveStep({ streamId, title: p.title, channel: p.channel, ...(p.contactId ? { contactId: p.contactId } : {}), ...(p.role ? { role: p.role } : {}) }), "Added to the plan");
  return <div className="mb-6"><PageSections object="deal" page={page} stage={data.stage} renderers={{ ...playRenderers({ data, busy, run, team, page, propose }), ...record }} /><DealChat key={streamId} streamId={streamId} team={team} /></div>;
}

const STATE_DOT = { established: "bg-emerald-600", partial: "bg-yellow-500", missing: "bg-red-500", unknown: "bg-muted-foreground/50" };

function StateSources({ sources }: { sources: NonNullable<ControlPlane["state"]>["qualification"][number]["sources"] }) {
  if (!sources.length) return <span className="text-xs text-muted-foreground">No verified quote</span>;
  return <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted-foreground">{sources.length} source{sources.length === 1 ? "" : "s"}</summary>
    <div className="mt-2 space-y-2">{sources.map((source, i) => <blockquote key={`${source.kind}:${source.id}:${i}`} className="border-l-2 border-border pl-2">
      {source.quote ? <p className="whitespace-pre-wrap">&quot;{source.quote}&quot;</p> : <p className="text-muted-foreground">Quote hidden: it is from a conversation you can&apos;t read.</p>}
      <p className="mt-1 text-muted-foreground">{source.support === "buyer" ? "Buyer said" : "Our-side support"} · {source.kind} · {(source.kind === "email" || source.kind === "linkedin")
        ? <Link href={`/dashboard/conversations/${source.id}`} className="underline">Open thread</Link> : <span className="break-all font-mono">{source.id}</span>}</p>
    </blockquote>)}</div>
  </details>;
}

function DealStateSectionEnabled({ data, busy, run }: { data: ControlPlane; busy: boolean; run: Run }) {
  const regenerate = useAction(api.dealStateActions.regenerate);
  const dismiss = useAction(api.dealPlays.dismissConcern);
  const chatgpt = useQuery(api.chatgptAuth.status);
  const state = data.state;
  const running = data.stateRun?.status === "running";
  const connected = chatgpt?.status === "connected";
  const termsAtRisk = state?.concerns.filter((c) => c.kind === "risk" && c.key.startsWith("term:") && !c.resolved && !c.dismissed) ?? [];
  const groups = [...new Set(state?.qualification.map((line) => line.group) ?? [])];
  return <Panel title="Deal state" className="mb-4" action={data.canEdit && !data.stateHidden && <button type="button" aria-label={running ? "Reading deal state" : "Regenerate"} className={btn} disabled={busy || running || !connected} onClick={() => void run(() => regenerate({ streamId: data.streamId }))}>
    {running && <Loader2 className="h-3 w-3 animate-spin" />}{running ? "Reading activities…" : "Regenerate"}
  </button>}>
    {chatgpt && !connected && <div className="mb-3 border border-border bg-muted/30 p-3 text-sm">Deal state runs on a ChatGPT plan. <Link href="/dashboard/integrations/chatgpt" className="text-primary underline">Connect ChatGPT</Link> to regenerate. The keeper uses the deal owner&apos;s plan.</div>}
    {data.stateRun?.status === "failed" && <p role="alert" className="mb-3 text-sm text-destructive">{data.stateRun.error || "The last run failed. Try regenerating."}</p>}
    {!state && data.stateHidden ? <p className="text-sm text-muted-foreground">Deal state is hidden for your role: it is read with full access to the deal.</p> : !state ? <p className="text-sm text-muted-foreground">{running ? "Reading the deal’s conversations and evidence." : "No deal state yet. Regenerate to read the deal’s conversations and evidence."}</p> : <div className="space-y-4">
      <p className="whitespace-pre-wrap text-sm">{state.summary}</p>
      <div className="border-l-2 border-border pl-3 text-sm"><p className="font-medium">Evidence supports {state.stage.label}{state.stage.mismatch && <span className="ml-2 text-warning">Differs from CRM stage {state.stage.crmStage ?? "unset"}</span>}</p><p className="mt-1 text-muted-foreground">{state.stage.reason}</p></div>
      {termsAtRisk.length > 0 && <div><p className={head}>Terms at risk</p><ul className="mt-2 space-y-2">{termsAtRisk.map((term) => <li key={term.key} className="border-l-2 border-destructive pl-3 text-sm"><p className="font-medium">{term.title}{term.severity && <span className="ml-2 text-xs font-normal text-muted-foreground">{term.severity} severity</span>}</p><p>{term.text}</p><StateSources sources={term.sources} /></li>)}</ul></div>}
      <div><p className={head}>{state.framework} · <span className="tabular-nums">{state.completeness.established} / {state.completeness.total}</span> established</p>
        <table className="mt-2 w-full text-left text-sm"><caption className="sr-only">Deal qualification and verified sources</caption><thead className="sr-only"><tr><th>Qualification</th><th>Evidence</th></tr></thead>
          {groups.map((group) => <tbody key={group}><tr><th colSpan={2} className="pt-3 pb-1 text-xs font-medium text-muted-foreground">{group}</th></tr>
            {state.qualification.filter((line) => line.group === group).map((line) => <tr key={line.key} className="border-t border-border align-top"><th scope="row" className="w-1/3 py-2 pr-3 font-normal"><span className="inline-flex items-center gap-2"><span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", STATE_DOT[line.status])} />{line.label}</span><span className="mt-1 block text-xs text-muted-foreground">{line.status}</span></th><td className="py-2"><p>{line.text}</p><StateSources sources={line.sources} /></td></tr>)}
          </tbody>)}
        </table>
      </div>
      <div><p className={head}>Objections and risks</p><div className="mt-2 space-y-3">{state.concerns.filter((risk) => !risk.dismissed).map((risk) => <div key={risk.key} className="border-t border-border pt-2 text-sm">
        <div className="flex items-start justify-between gap-3"><p className="font-medium">{risk.title} <span className="text-xs font-normal text-muted-foreground">{risk.kind}{risk.resolved ? " · Resolved" : ""}</span></p>{data.canEdit && <button type="button" className={linkBtn} disabled={busy} onClick={() => void run(() => dismiss({ streamId: data.streamId, key: risk.key }))}>Dismiss</button>}</div>
        <DealChatButton streamId={data.streamId} text={`${risk.kind}: ${risk.title}. ${risk.text}`} /><p>{risk.text}</p><p className="mt-1 text-xs text-muted-foreground">Raised by {risk.raisedBy} · First {day(risk.firstObservedAt)} · Last {day(risk.lastObservedAt)} · Observed <span className="tabular-nums">{risk.count}</span> time{risk.count === 1 ? "" : "s"}</p><StateSources sources={risk.sources} />
      </div>)}{!state.concerns.some((risk) => !risk.dismissed) && <p className="text-sm text-muted-foreground">No cited objections or risks in the activities read.</p>}</div></div>
      <p className="text-xs text-muted-foreground">Read <span className="tabular-nums">{state.coverage.read} of {state.coverage.total}</span> activities{state.coverage.inventoryLimited ? " found within the search limits" : ""}.{state.coverage.partial ? ` Partial read; ${state.coverage.omitted} activities left out, and some text may be truncated or unavailable.` : ""} Last run {new Date(state.generatedAt).toLocaleString()}.</p>
    </div>}
  </Panel>;
}

/** What every action on the page can read (recipes/actions.ts). */
function pageContext(data: ControlPlane): Context {
  return {
    canEdit: data.canEdit, stage: data.stage, "deal.companyId": Boolean(data.deal.companyId),
    "research.status": data.research?.status ?? "none", "people.research.status": data.peopleResearch?.status ?? "none",
    "play.started": Boolean(data.started), "others.count": data.others.length, "suggested.count": data.suggested.length,
  };
}

type Values = { n?: number; role?: string | null };
/** How a slot draws one kernel action: a renderer, or one with what that action alone reads and names in its label. */
type Binding = ((o: Offer) => ReactNode) | { ctx: Context; values?: Values; render: (o: Offer) => ReactNode };

/**
 * The recipe's actions in `host` that run one of `render`'s kernel actions, in the recipe's order, each drawn by
 * `render`. A recipe that leaves an action out gets no button for it.
 */
function slot<R extends ActionId>(actions: readonly PageAction[], host: Host, ctx: Context, render: Record<R, Binding>, values?: Values): ReactNode[] {
  return actions.flatMap((a) => {
    const b: Binding | undefined = render[a.runs as R];
    if (!b) return [];
    const [draw, c, v] = typeof b === "function" ? [b, ctx, values] : [b.render, { ...ctx, ...b.ctx }, b.values ?? values];
    return offered([a], host, [a.runs], c, v).map((o) => <IntegrationActionGate key={o.action.id} action={o.action.runs}>{draw(o)}</IntegrationActionGate>);
  });
}

/** A navigation action: a link, or, when the recipe's `enabled:` is false, the same look, disabled and going nowhere. */
function NavLink({ o, href, external, className, children }: { o: Offer; href: string; external?: boolean; className: string; children: ReactNode }) {
  if (o.disabled) return <a aria-disabled="true" className={cn(className, "pointer-events-none opacity-50")}>{children}</a>;
  return external ? <a href={href} target="_blank" rel="noreferrer noopener" className={className}>{children}</a> : <Link href={href} className={className}>{children}</Link>;
}
/** The first action the page offers for `runs`, or null: an edit in place that the recipe can leave out. */
const offer = (actions: readonly PageAction[], host: Host, runs: ActionId, ctx: Context, values?: { n?: number; role?: string | null }): Offer | null =>
  offered(actions, host, [runs], ctx, values)[0] ?? null;

/**
 * Research spends credits: each profile it enriches (whatever the plan), and without a ChatGPT plan each answer
 * too. `ask` shows the most it can cost and what the workspace has, and starts it only on confirm. `cost` says
 * what this research can cost, given whether the person has a ChatGPT plan.
 */
function useCreditConfirm() {
  const chatgpt = useQuery(api.chatgptAuth.status);
  const wallet = useQuery(api.credits.summary);
  const onPlan = chatgpt?.status === "connected";
  const [pending, setPending] = useState<{ title: string; cost: string; go: () => void } | null>(null);
  const ask = (title: string, cost: (onPlan: boolean) => string, go: () => void) => setPending({ title, cost: cost(onPlan), go });
  const dialog = (
    <Dialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{pending?.title}</DialogTitle>
          <DialogDescription>
            {onPlan
              ? "Research runs on your ChatGPT plan; the profiles it pulls in cost credits."
              : "You haven't connected ChatGPT, so research runs on Canon's model and its answers cost credits, as do the profiles it pulls in."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">{pending?.cost} Nothing is charged for what isn&apos;t found.</p>
        <p className="text-xs text-muted-foreground">
          The workspace has {wallet ? Math.floor(wallet.spendable).toLocaleString() : "…"} credits.{onPlan ? "" : " Connect ChatGPT under Integrations → ChatGPT to research for free."}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={() => setPending(null)}>Cancel</button>
          <button type="button" className={cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}
            onClick={() => { pending?.go(); setPending(null); }}>Spend credits</button>
        </div>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}

/** When the keeper's daily check researches the account again, on the recipe's cadence: only for a deal it would research. */
function ResearchAgain({ data, finishedAt }: { data: ControlPlane; finishedAt: number }) {
  const plays = data.recipe.plays;
  if (!plays || data.deal.isClosed || !data.deal.domain || !data.prep.questions.length) return null;
  return <> · {againLabel(researchAgain(finishedAt, data.prep.answers.some((a) => !a.asked), plays))}</>;
}

function againLabel(at: number, now = Date.now()): string {
  return at > now ? `again in ${Math.ceil((at - now) / 86_400_000)} d` : "again on the keeper's next check";
}

/** The deal's health, money, close date and owner, with the account research run. */
function Summary({ data, busy, run, section }: PlaySection<"summary">) {
  const research = useAction(api.dealPlayActions.research);
  const credits = useCreditConfirm();
  const { streamId } = data;
  const r = data.research;
  const part = (name: string) => showsPart(section, name);
  // The money, close date and owner read as one line, joined by dots.
  const facts = [
    part("amount") && data.deal.amount !== null && <span key="amount" data-part="amount" className="font-medium">{formatCurrency(data.deal.amount, data.deal.currency ?? "USD")}</span>,
    part("closeDate") && data.deal.closeDate && <span key="close" data-part="closeDate" className="text-muted-foreground">closes {data.deal.closeDate}</span>,
    part("owner") && data.deal.ownerName && <span key="owner" data-part="owner" className="text-muted-foreground">{data.deal.ownerName}</span>,
  ].filter(Boolean).flatMap((x, i) => (i ? [<span key={`dot${i}`} className="text-muted-foreground"> · </span>, x] : [x]));
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border border-border bg-card px-4 py-3">
      {part("health") && <span data-part="health" className={cn("border px-2 py-0.5 text-xs font-medium", HEALTH_TONE[data.keeper.health])}>{HEALTH_LABEL[data.keeper.health]}</span>}
      {facts.length > 0 && <span className="text-sm">{facts}</span>}
      <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        {part("research") && r?.status === "running" && <span data-part="research" className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Researching {data.deal.companyName ?? "the account"}…</span>}
        {part("research") && r?.status === "done" && r.finishedAt && <span data-part="research" title={`${r.searches ?? 0} searches, ${r.pages ?? 0} pages read, ${r.kept ?? 0} items kept, ${r.dropped ?? 0} dropped for lack of evidence`}>Researched {formatRelativeTime(r.finishedAt)} · {r.kept ?? 0} kept, {r.dropped ?? 0} dropped<ResearchAgain data={data} finishedAt={r.finishedAt} /></span>}
        {part("research") && r?.status === "failed" && <span data-part="research" className="text-destructive">Research failed: {r.error}</span>}
        {slot(sectionActions(section), "summary", pageContext(data), {
          "kernel.researchAccount": (o) => (
            <button type="button" className={btn} disabled={busy || o.disabled}
              onClick={() => credits.ask(`Research ${data.deal.companyName ?? "the account"}?`,
                (onPlan) => (onPlan ? "At most 1 credit: the company's profile (headcount, revenue, tech stack, founding year…)." : "At most 2 credits: the company's profile (headcount, revenue, tech stack, founding year…) and the research."),
                () => void run(() => research({ streamId }), "Research started. It takes a minute or two."))}>
              <Sparkles className="h-3 w-3" /> {o.label}
            </button>
          ),
        })}
      </span>
      {credits.dialog}
    </div>
  );
}

/** Why a deal in the queue wants attention, in a few words: a reply owed first, then its health and window. */
function queueReason(row: PlayRow): string {
  const owed = row.summary?.repliesOwed ?? 0;
  if (owed) return `${owed} ${owed === 1 ? "reply" : "replies"} owed`;
  const health = row.health ? HEALTH_LABEL[row.health].toLowerCase() : "not checked yet";
  return row.windowDays !== null && row.windowDays >= 0 ? `${health}, ${row.windowDays} days to ${row.windowLabel || "the window"}` : health;
}

/**
 * Take action on this deal, then move on (docs/deal-prep-loop.md PL3): the caller's open deals in the Plays page's
 * order (at risk and closing soon first), or every open deal when they own none, with the next one a click away.
 */
function DealQueue({ streamId, actions, ctx }: { streamId: string; actions: readonly PageAction[]; ctx: Context }) {
  const list = useAction(api.dealPlays.list);
  const [rows, setRows] = useState<PlayRow[] | null>(null);
  useEffect(() => {
    let live = true;
    list({}).then((r) => { if (live) setRows(r); }, () => { if (live) setRows([]); });
    return () => { live = false; };
  }, [list]);
  if (!rows) return null;
  const open = rows.filter((r) => !r.isClosed);
  const queue = open.some((r) => r.mine) ? open.filter((r) => r.mine) : open;
  const at = queue.findIndex((r) => r.streamId === streamId);
  const next = queue.filter((r) => r.streamId !== streamId)[at >= 0 ? at % Math.max(1, queue.length - 1) : 0];
  if (!next) return null;
  return (
    <nav aria-label="Deal queue" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="text-muted-foreground">{at >= 0 ? `Deal ${at + 1} of ${queue.length}` : `${queue.length} open deals`}</span>
      <span className="flex min-w-24 flex-1 gap-1" aria-hidden>
        {queue.slice(0, 30).map((r, i) => <span key={r.streamId} className={cn("h-1 flex-1", i === at ? "bg-primary" : i < at ? "bg-primary/40" : "bg-muted")} />)}
      </span>
      <span className="text-muted-foreground">Next: {next.name}, {queueReason(next)}</span>
      {slot(actions, "queue", { ...ctx, "queue.next": true }, {
        "nav.nextDeal": (o) => (
          <NavLink o={o} href={recordHref("deal", next.streamId)} className="inline-flex items-center gap-1 bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            {o.label} <ArrowRight className="h-3 w-3" />
          </NavLink>
        ),
      })}
    </nav>
  );
}

/**
 * The deal's prep (docs/deal-prep-loop.md PL1): one sentence on where it stands, what's missing before it can move,
 * and what research asked. A question research couldn't answer is asked on the next call.
 */
function Prep({ data }: { data: ControlPlane }) {
  const { verdict, checks, answers } = data.prep;
  const missing = checks.filter((c) => !c.ok);
  return (
    <section className="grid gap-4 border border-border bg-card p-4" aria-label="Prep">
      <p className="max-w-[70ch] text-base leading-snug">{verdict}</p>
      <div className="grid grid-cols-1 gap-6 text-sm md:grid-cols-2">
        <div className="grid content-start gap-2">
          <h3 className={head}>{missing.length ? `Missing before it can move · ${checks.length - missing.length} of ${checks.length} in place` : "Everything it needs to move is in place"}</h3>
          {missing.map((c) => (
            <div key={c.key}>
              <p>{c.label}</p>
              <p className="text-muted-foreground">{c.evidence}</p>
            </div>
          ))}
        </div>
        <div className="grid content-start gap-2">
          <h3 className={head}>What research asked</h3>
          {answers.map((a) => (
            <div key={a.question}>
              <p>{a.question}</p>
              {a.answer ? (
                <p className="text-muted-foreground">
                  {a.answer}{a.quote && <> &ldquo;{a.quote}&rdquo;</>}{" "}
                  {a.sourceUrl && <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline hover:text-foreground">Source</a>}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {a.asked ? "Research couldn't answer this, so the next call asks it."
                    : data.deal.companyId ? "Not researched yet. The keeper researches it on its next daily check."
                    : "Link this deal to a company so research can answer it."}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A person a page named: make the contact at the deal's company, put them on the deal, and close the gap. */
function useAddNamedPerson(data: ControlPlane, run: Run) {
  const upsert = useAction(api.records.upsert);
  const setRole = useAction(api.dealCommittee.setRole);
  const dismiss = useAction(api.dealPlays.dismissItem);
  return (item: ControlPlane["items"][number]) => run(async () => {
    const person = item.person!;
    const out = await upsert({
      object: "contact", idempotencyKey: `play:${item.id}`,
      contacts: [{ fullName: person.name, ...(person.title ? { title: person.title } : {}), ...(data.deal.domain ? { accountDomain: data.deal.domain } : data.deal.companyId ? { accountId: data.deal.companyId } : {}) }],
    });
    const contactId = out.ids[0];
    if (!contactId) throw new Error(out.rejected?.[0]?.reason ?? "Canon couldn't add this person");
    await setRole({ streamId: data.streamId, contactId, role: person.role ?? "involved", reason: item.sourceUrl ? `Named on ${hostOf(item.sourceUrl)}` : "Named by account research" });
    await dismiss({ streamId: data.streamId, itemId: item.id });
  }, `${item.person!.name} added to the deal`);
}

/** The deal's stage, which decides what the page is for (docs/deal-prep-loop.md). */
function StageRail({ data }: { data: ControlPlane }) {
  const names = data.recipeData.stages;
  const stages = DEAL_STAGES;
  const at = stages.indexOf(data.stage);
  return (
    <section aria-label="Stage" className="grid gap-3">
      <ol className="grid grid-cols-3 gap-1">
        {stages.map((s, i) => (
          <li key={s}>
            <span className={cn("block h-1", i < at ? "bg-primary/50" : i === at ? "bg-primary" : "bg-muted")} />
            <span className={cn("mt-2 block text-sm", i === at ? "font-medium" : "text-muted-foreground")}>{names[s].label}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">Leave this stage when: {names[data.stage].exit}</p>
    </section>
  );
}

/**
 * Find the way in: know who's at the account, choose who to reach first, send the first touches. Canon suggests
 * who; picking someone and drafting puts them on the deal with a first-touch step and a draft to review and send.
 */
function FanOut({ data, busy, run, section, page }: PlaySection<"fanOut">) {
  const rank = useAction(api.dealPlays.rankProspects);
  const firstTouches = useAction(api.dealPlayKeeper.firstTouches);
  const researchPeople = useAction(api.dealPlayActions.researchPeople);
  const addPerson = useAddNamedPerson(data, run);
  const people = data.prospects;
  const [picked, setPicked] = useState<string[]>(people.filter((p) => p.buyer && p.suggested && p.contactId).map((p) => p.contactId!));
  const [search, setSearch] = useState("");
  // Saved ICP ids: a contact shows when it matches any one's buyer; none shows everyone. Until the person picks, every
  // active ICP. Their pick is remembered in this browser for every deal (ICP_FILTER_KEY); an ICP deleted since drops out.
  const stored = useSyncExternalStore(noSubscribe, readIcpFilterRaw, () => null);
  const [icpPick, setIcpPick] = useState<string[] | null>(null);
  const chosen = icpPick ?? parseIcpFilter(stored);
  const icpView = useQuery(api.icpsInterface.list);
  const icpList = icpView?.icps;
  const savedIcps = icpList ?? [];
  const icpFilter = icpList ? (chosen ?? icpList.filter((icp) => icp.active).map((icp) => icp.key)).filter((id) => icpList.some((icp) => icp.key === id)) : chosen ?? [];
  const setIcpFilter = (next: string[]) => { setIcpPick(next); writeIcpFilter(next); };
  const buyers = savedIcps.filter((icp) => icpFilter.includes(icp.key)).map((icp) => specBuyer(icp.spec, icpView?.buyerLevels ?? []));
  const [ranking, setRanking] = useState<{ input: string; keys: string[]; note: string | null } | null>(null);
  const input = rankingInput(people, [data.brief.context, data.pointOfView?.text].filter(Boolean).join("\n") || null);
  useEffect(() => {
    let live = true;
    rank({ streamId: data.streamId }).then((result) => { if (live) setRanking(result); }, () => {
      if (live) setRanking({ input, keys: [], note: "Jev ranking unavailable. Showing role and research order." });
    });
    return () => { live = false; };
  }, [rank, data.streamId, input]);
  const currentRanking = ranking?.input === input ? ranking : null;
  const positions = new Map(currentRanking?.keys.map((key, i) => [key, i]));
  const visible = visibleProspects(people, search, false)
    .filter((p) => !icpFilter.length || Boolean(p.title && buyers.some((b) => isBuyer(p.title!, b))))
    .sort((a, b) => (positions.get(a.key) ?? Infinity) - (positions.get(b.key) ?? Infinity));
  const { peopleFields: researchFields, peopleSlugs: slugs } = data.recipeData;
  const peopleFields = useContactAiFields().filter((f) => researchFields.some((r) => r.slug === f.slug));
  const goalField = peopleFields.find((f) => f.slug === slugs.goal);
  const systemsField = peopleFields.find((f) => f.slug === slugs.systems);
  const answers = useContactAnswers(visible.flatMap((p) => (p.contactId ? [p.contactId] : [])), peopleFields) ?? {};
  const company = data.deal.companyName ?? "the account";
  const pickedIds = new Set(picked);
  const head2 = "text-lg font-semibold";
  // People research (issue #394): the picked people, else everyone shown, up to a run's limit.
  const researchIds = (picked.length ? picked : visible.flatMap((p) => (p.contactId ? [p.contactId] : []))).slice(0, PEOPLE_RESEARCH_MAX);
  const pr = data.peopleResearch;
  const credits = useCreditConfirm();
  const actions = sectionActions(section);
  const ctx = pageContext(data);
  return (
    <div className="grid gap-10">
      {credits.dialog}
      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h2 className={head2}>{section.title ?? "Choose who to reach first"}</h2>
          <span className="text-sm text-muted-foreground">{picked.length} picked · {visible.length} of {people.length} shown</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input type="search" aria-label="Search contacts" placeholder="Search name or title" value={search} onChange={(e) => setSearch(e.target.value)} className={cn(field, "min-w-48 flex-1")} />
          <MultiSelect label="ICP buyer filter" emptyLabel="All contacts" value={icpFilter} onChange={setIcpFilter}
            options={savedIcps.map((icp) => ({ value: icp.key, label: icp.active ? icp.name : `${icp.name} (inactive)` }))} />
          {data.canEdit && <>
            <button type="button" className={btn} disabled={busy || !visible.some((p) => p.contactId)} onClick={() => setPicked(selectProspects(picked, visible))}>Select shown</button>
            <button type="button" className={btn} disabled={busy || !picked.length} onClick={() => setPicked([])}>Clear selection</button>
          </>}
          {slot(actions, "fanOut", ctx, {
            "kernel.researchPeople": { ctx: { "targets.count": researchIds.length, "picked.count": picked.length }, values: { n: researchIds.length }, render: (o) => (
              <button type="button" className={btn} disabled={busy || o.disabled}
                title="Pull in each person's profile, research their goal and systems on the web, then read them against your product. A profile costs up to 3 credits; without a ChatGPT plan each answer costs 1 too."
                onClick={() => credits.ask(`Research ${researchIds.length} ${researchIds.length === 1 ? "person" : "people"}?`,
                  (onPlan) => {
                    const n = researchIds.length;
                    // A profile found costs at most 3 credits (what treg charges, marked up); a job change check 8, at most monthly.
                    const profiles = `${(11 * n).toLocaleString()} credits: up to 3 for ${n === 1 ? "their profile" : "each profile"} (title, seniority, role, tenure…) and 8 to check ${n === 1 ? "they still work" : "each still works"} there (at most monthly)`;
                    return onPlan
                      ? `At most ${profiles}.`
                      : `At most ${profiles}, plus 1 per answer: ${(n * researchFields.length).toLocaleString()} at most (${n} × ${researchFields.length} questions).`;
                  },
                  () => void run(async () => {
                    const out = await researchPeople({ streamId: data.streamId, contactIds: researchIds });
                    if (out.note) void toast.info(out.note);
                  }, `Researching ${researchIds.length} ${researchIds.length === 1 ? "person" : "people"}. Answers fill in as they land.`))}>
                <Sparkles className="h-3 w-3" /> {o.label}
              </button>
            ) },
            "kernel.firstTouches": { ctx: { "picked.count": picked.length, "shown.count": visible.length }, values: { n: picked.length }, render: (o) => (
              <button type="button" disabled={busy || o.disabled} className={btn}
                title="Each one: why them now, the surprising part of your view, how it should work, and a question. Nothing sends until you do."
                onClick={() => void run(async () => {
                  await draftSelected(picked, (contactIds) => firstTouches({ streamId: data.streamId, contactIds }));
                }, "First touches drafted. Open each from its row.")}>
                <Sparkles className="h-3 w-3" /> {o.label}
              </button>
            ) },
          })}
        </div>
        {pr && <p role="status" className="text-xs text-muted-foreground">
          {pr.status === "running"
            ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Researching {pr.contactIds.length} {pr.contactIds.length === 1 ? "person" : "people"}: goals and systems first, then what your product changes for them.</span>
            : pr.status === "done" ? `People researched ${formatRelativeTime(pr.finishedAt ?? pr.startedAt)}. The keeper refreshes this weekly.` : "People research failed."}
          {pr.note && <span className={pr.status === "failed" ? "text-destructive" : ""}> {pr.note}</span>}
        </p>}
        {(!currentRanking || currentRanking.note) && <p role="status" className="text-xs text-muted-foreground">{currentRanking?.note ?? "Comparing ICP buyers for product fit…"}</p>}
        {people.length > 0 && visible.length === 0 && <p className="text-sm text-muted-foreground">No contacts match. Change your search or choose another ICP buyer filter.</p>}
        {people.length === 0 ? <p className="text-sm text-muted-foreground">Nobody at {company} is in Canon yet. Research {company} to find who works there.</p> : (
          <ul className="divide-y divide-border border-y border-border">
            <li aria-hidden className={cn(PEOPLE_GRID, label, "py-2")}>
              <span /><span>Person</span><span>Primary goal</span><span>Responsible systems</span><span>New capability</span><span>Researched</span><span>Contacted</span><span>First touch</span>
            </li>
            {visible.map((p) => {
              const on = p.contactId !== null && pickedIds.has(p.contactId);
              const answer = (slug: string) => (p.contactId ? answers[p.contactId]?.[slug] : undefined);
              return (
                <li key={p.key} className={cn(PEOPLE_GRID, "py-3 text-sm")}>
                  <input type="checkbox" aria-label={`Reach ${p.name}`} disabled={!p.contactId || !data.canEdit || busy} checked={on}
                    onChange={() => setPicked(on ? picked.filter((x) => x !== p.contactId) : [...picked, p.contactId!])} className="mt-1" />
                  <span>
                    {p.contactId ? <Link href={recordHref("contact", p.contactId)} className="block font-medium hover:underline">{p.name}</Link> : <span className="block font-medium">{p.name}</span>}
                    {p.title && <span className="block text-muted-foreground">{p.title}</span>}
                    <span className="block text-xs text-muted-foreground">
                      {p.source === "deal" ? `On the deal${p.role && p.role !== "involved" ? ` as ${ROLE_LABEL[p.role]}` : ""}` : p.source === "company" ? "In Canon" : "Named by research, not in Canon"}
                      {p.buyer ? " · matches your buyer" : ""}
                    </span>
                    {(() => {
                      // Whether research found them still at the company: a departure is the one thing to see first.
                      const employed = answer(slugs.employed);
                      const still = employment(employed);
                      if (still === null || !employed) return null;
                      const { quote, url } = quoteAndSource(employed.evidence);
                      const tip = [quote, url && `Source: ${url}`, employed.status === "proposed" && "Waiting for review in Fact Review."].filter(Boolean).join("\n\n") || undefined;
                      return still
                        ? <span className="mt-1 block text-xs text-muted-foreground" title={tip}>Still at {company}</span>
                        : <span className={cn(label, "mt-1 block w-fit border border-destructive/50 px-1.5 py-0.5 text-destructive")} title={tip}>Left {company}</span>;
                    })()}
                    {(p.why ?? (p.role === "executive" ? "Reach them once someone below them is talking." : null)) && (
                      <span className="mt-1 block text-xs text-muted-foreground">{p.why ?? "Reach them once someone below them is talking."}</span>
                    )}
                  </span>
                  <span className="grid gap-1">
                    <span className="line-clamp-4">{goalField ? <AiCell field={goalField} answer={answer(slugs.goal)} /> : <span className="text-muted-foreground">—</span>}</span>
                    {p.center && <span className={cn(label, "w-fit border border-border px-1.5 py-0.5")} title="Jev's read of their remit, from their title and goal">{CENTER_LABEL[p.center]} center</span>}
                  </span>
                  <span className="line-clamp-4">{systemsField ? <AiCell field={systemsField} answer={answer(slugs.systems)} /> : <span className="text-muted-foreground">—</span>}</span>
                  <span className="line-clamp-4 text-muted-foreground" title={p.capability ? "A hypothesis from their researched goal and systems and your product. Check it before you say it." : undefined}>
                    {p.capability ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.researched || answer(slugs.goal) || answer(slugs.systems) ? "Yes" : <span className="text-warning">Not yet</span>}
                    {slot(actions, "fanOut", { ...ctx, ...rowContext(data, p) }, {
                      "kernel.addToCanon": (o) => {
                        const item = data.items.find((i) => i.id === p.itemId);
                        return item ? <><br /><button type="button" disabled={busy || o.disabled} className="underline hover:text-foreground disabled:opacity-50" onClick={() => void addPerson(item)}>{o.label}</button></> : null;
                      },
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">{p.reached ?? "Never"}</span>
                  <span>{p.contactId && <RowDraft data={data} contactId={p.contactId} name={p.name} busy={busy} run={run} page={page} actions={slot(actions, "fanOut", { ...ctx, ...rowContext(data, p) }, {
                    "kernel.firstTouch": (o) => (
                      <button type="button" disabled={busy || o.disabled} className={linkBtn} onClick={() => void run(async () => {
                        const out = await firstTouches({ streamId: data.streamId, contactIds: [p.contactId!] });
                        if (out.error) throw new Error(out.error);
                      }, `First touch to ${p.name} drafted`)}>{o.label}</button>
                    ),
                  })} />}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

    </div>
  );
}

function Window({ data, title, disabled, onSave }: { data: ControlPlane; title: string; disabled: boolean; onSave: (patch: { windowLabel?: string; windowClosesOn?: string }) => Promise<void> }) {
  const { windowLabel, windowClosesOn } = data.brief;
  const days = data.keeper.windowDays;
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className={label}>{title}</span>
      <EditText value={windowLabel} placeholder="Name the decision window (e.g. RFP)" disabled={disabled} onSave={(v) => onSave({ windowLabel: v })} className="w-auto max-w-[16rem] font-medium" />
      <input type="date" aria-label="Window closes on" disabled={disabled} value={windowClosesOn ?? ""} onChange={(e) => void onSave({ windowClosesOn: e.target.value })} className={field} />
      {days !== null && <span className={cn("font-mono text-xs", days < 0 ? "text-red-600" : days <= 45 ? "text-amber-600" : "text-muted-foreground")}>{days < 0 ? `closed ${-days} d ago` : `${days} d left`}</span>}
    </span>
  );
}

function Keeper({ data, busy, run, propose, section }: PlaySection<"keeper">) {
  const checkNow = useAction(api.dealPlayKeeper.checkNow);
  const flags: Flag[] = data.keeper.flags;
  const last = data.keeperCheck;
  const actions = sectionActions(section);
  const ctx = pageContext(data);
  const status = (
    <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span title="Each day the keeper checks this deal as its owner, drafts the touches due in the next 3 days on the owner's ChatGPT plan, and posts new urgent flags to Slack. It never sends.">
        {data.keeperPaused ? `Off: ${data.keeperPaused} Check now to turn it on.` : last ? `Checked ${formatRelativeTime(last.at)}${last.drafted ? ` · drafted ${last.drafted}` : ""}${last.error ? ` · ${last.error}` : ""}` : "Checks daily and drafts the touches coming due"}
      </span>
      {slot(actions, "keeper", ctx, {
        "kernel.checkNow": (o) => (
          <button type="button" disabled={busy || o.disabled} className={btn} onClick={() => void run(async () => {
            const out = await checkNow({ streamId: data.streamId });
            if (out.error) void toast.warning(out.error);
          }, "Keeper checked the deal")}>{o.label}</button>
        ),
      })}
    </span>
  );
  return (
    <Panel collapsed={Boolean(section.collapsed)} title={`${section.title ?? "Deal health"} · ${flags.length} flags`} action={status}>
      {flags.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is off track.</p> : (
        <ul className="space-y-2 text-sm">
          {flags.map((f) => (
            <li key={f.key} className="flex items-start gap-3">
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[f.severity])} aria-label={f.severity} />
              <span className="flex-1">{f.text}</span>
              {slot(actions, "keeper", { ...ctx, "flag.propose": Boolean(f.propose) }, {
                "kernel.planFlag": (o) => (
                  <button type="button" disabled={busy || o.disabled} className={btn} onClick={() => void propose(f.propose!)} title={`${CHANNEL_LABEL[f.propose!.channel]}: ${f.propose!.title}`}>
                    <Plus className="h-3 w-3" /> {o.label}
                  </button>
                ),
              })}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const EVIDENCE_NOTE = { verified: "Quote checked against the page", unverified: "Canon couldn't find this quote in the page", none: "No source" } as const;

function Brief({ data, busy, run, section }: PlaySection<"brief">) {
  const setBrief = useAction(api.dealPlays.setBrief);
  const dismiss = useAction(api.dealPlays.dismissItem);
  const addItems = useAction(api.dealPlayActions.addItems);
  const { streamId, brief } = data;
  const addPerson = useAddNamedPerson(data, run);
  const save = (patch: Record<string, string>) => run(() => setBrief({ streamId, ...patch }));
  const [kind, setKind] = useState<ItemKind>("signal");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [quote, setQuote] = useState("");
  const actions = sectionActions(section);
  const ctx = pageContext(data);
  const editBrief = offer(actions, "brief", "kernel.setBrief", ctx);
  const editWindow = offer(actions, "brief", "kernel.setWindow", ctx);
  const addItem = offer(actions, "brief", "kernel.addItem", ctx);
  const disabled = !editBrief || editBrief.disabled || busy;
  const itemActions = <R extends ActionId>(i: ControlPlane["items"][number], render: Record<R, (o: Offer) => ReactNode>) =>
    slot(actions, "brief", { ...ctx, "item.kind": i.kind, "item.person": Boolean(i.person) }, render, { role: i.person?.role ? ROLE_LABEL[i.person.role] : null });
  const facts = data.items.filter((i) => i.kind === "timeline" || i.kind === "signal" || i.kind === "competitor");
  const open = data.items.filter((i) => i.kind === "risk" || i.kind === "gap" || i.kind === "discovery");
  const hypothesis = brief.briefBy === "research" ? <span className="ml-1 normal-case tracking-normal text-[10px]">hypothesis · by research</span> : null;

  return (
    <Panel collapsed={Boolean(section.collapsed)} title={`${section.title ?? "Brief & evidence"} · ${data.items.length}`}>
      <div className="mb-4">
        <Window data={data} title={editWindow?.label ?? "Window"} disabled={!editWindow || editWindow.disabled || busy} onSave={(patch) => run(() => setBrief({ streamId, ...patch }))} />
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className={label}>What we sell them and the angle</dt>
          <dd><EditText multiline value={brief.context} placeholder="Tell research what you offer this account (e.g. ICM for a sales comp transition)" disabled={disabled} onSave={(v) => save({ context: v })} /></dd>
        </div>
        <div>
          <dt className={label}>Why now{hypothesis}</dt>
          <dd><EditText multiline value={brief.whyNow} placeholder="Why this account acts this quarter" disabled={disabled} onSave={(v) => save({ whyNow: v })} /></dd>
        </div>
        <div>
          <dt className={label}>Alpha{hypothesis}</dt>
          <dd><EditText multiline value={brief.alphaHypothesis} placeholder="The non-obvious insight you lead with" disabled={disabled} onSave={(v) => save({ alphaHypothesis: v })} /></dd>
          <dd className="mt-1 border-l-2 border-border pl-3 text-muted-foreground"><EditText multiline value={brief.alphaPitch} placeholder="The 2–3 sentence opener" disabled={disabled} onSave={(v) => save({ alphaPitch: v })} /></dd>
        </div>
      </dl>

      <h3 className={cn(label, "mt-5 mb-2")}>Evidence ({facts.length})</h3>
      {facts.length === 0 ? <p className="text-sm text-muted-foreground">No cited events or signals yet.</p> : (
        <ul className="space-y-3 text-sm">
          {facts.map((i) => (
            <li key={i.id} className="group">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 border border-border px-1 text-xs font-medium text-muted-foreground">{ITEM_LABEL[i.kind]}</span>
                <span className="flex-1">{i.occurredOn && <span className="font-mono text-xs text-muted-foreground">{i.occurredOn} · </span>}{i.text}</span>
                {itemActions(i, {
                  "kernel.dismissItem": (o) => <button type="button" aria-label={o.label} disabled={busy || o.disabled} onClick={() => void run(() => dismiss({ streamId, itemId: i.id }))} className="p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"><X className="h-3 w-3" /></button>,
                })}
              </div>
              {(i.quote || i.sourceUrl) && (
                <blockquote className="mt-1 ml-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                  {i.quote && <>&ldquo;{i.quote.length > 280 ? `${i.quote.slice(0, 280)}…` : i.quote}&rdquo; </>}
                  {i.sourceUrl && <a href={i.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline">{hostOf(i.sourceUrl)}</a>}
                  <span className={cn("ml-2", i.evidence === "verified" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-600")} title={EVIDENCE_NOTE[i.evidence]}>
                    {i.evidence === "verified" ? "✓ verified" : i.evidence === "unverified" ? "unverified" : ""}
                  </span>
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      )}

      {(["risk", "gap", "discovery"] as const).map((k) => {
        const rows = open.filter((i) => i.kind === k);
        return rows.length ? (
          <div key={k} className="mt-4">
            <h3 className={cn(label, "mb-1")}>{ITEM_LABEL[k]}s</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {rows.map((i) => (
                <li key={i.id} className="group">
                  {i.text}
                  {i.sourceUrl && <a href={i.sourceUrl} target="_blank" rel="noreferrer noopener" className="ml-1 text-xs text-muted-foreground underline">{hostOf(i.sourceUrl)}</a>}
                  {itemActions(i, {
                    "kernel.addToDeal": (o) => (
                      <button type="button" disabled={busy || o.disabled} className={cn(btn, "ml-2 py-0")} onClick={() => void addPerson(i)}>
                        <Plus className="h-3 w-3" /> {o.label}
                      </button>
                    ),
                    "kernel.dismissItem": (o) => <button type="button" aria-label={o.label} disabled={busy || o.disabled} onClick={() => void run(() => dismiss({ streamId, itemId: i.id }))} className="ml-1 align-middle text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"><X className="inline h-3 w-3" /></button>,
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null;
      })}

      {addItem && (
        <form
          className="mt-4 grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void run(async () => {
              const out = await addItems({ streamId, items: [{ kind, text, ...(url.trim() ? { sourceUrl: url.trim() } : {}), ...(quote.trim() ? { quote: quote.trim() } : {}) }] });
              setText(""); setUrl(""); setQuote("");
              if (out.unverified) void toast.warning("Saved, but Canon couldn't find that quote on the page.");
            });
          }}
        >
          <div className="flex gap-2">
            <SelectField aria-label="Kind" value={kind} onValueChange={(v) => setKind(v as ItemKind)} options={ITEM_KINDS.map((k) => ({ value: k, label: ITEM_LABEL[k] }))} />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a signal, event, risk, gap or question" className={cn(field, "min-w-0 flex-1")} />
          </div>
          <div className="flex gap-2">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Source URL (optional)" className={cn(field, "min-w-0 flex-1")} />
            <input value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="Exact quote from it (optional)" className={cn(field, "min-w-0 flex-1")} />
            <button type="submit" disabled={busy || addItem.disabled || !text.trim()} className={btn}>{addItem.label}</button>
          </div>
        </form>
      )}
    </Panel>
  );
}

const targetName = (s: PlayStep, data: ControlPlane) => {
  const p = data.people.find((x) => x.contactId === s.targetId) ?? null;
  if (p) return p.name;
  return s.role ? `${ROLE_LABEL[s.role]} (unfilled)` : null;
};

/**
 * A play's steps as a flow: the deal, a branch per person or role a step is for, and each one's steps in due order.
 * A step's pane marks it done and moves its due date.
 */
function planNodes(data: ControlPlane, edit: { busy: boolean; resave: (s: PlayStep, patch: { state?: PlayStep["state"]; dueOn?: string }) => void } | null): FlowNode[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, PlayStep[]>();
  for (const s of [...data.steps].sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"))) {
    const key = s.contactId ? `c:${s.contactId}` : s.role ? `r:${s.role}` : "anyone";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const nodes: FlowNode[] = [{ id: "play", row: 0, title: "Play", metric: `${data.steps.length} steps`, tone: "active",
    card: <FlowRows rows={[["Open", String(data.steps.filter((s) => s.state === "planned" && !s.doneBy).length)], ["People", String(data.people.length)]]} /> }];
  [...groups].forEach(([key, steps], row) => {
    const who = key === "anyone" ? "Anyone" : targetName(steps[0], data) ?? (steps[0].role ? ROLE_LABEL[steps[0].role] : "Someone");
    steps.forEach((s, i) => {
      const done = s.state === "done" || s.doneBy !== null;
      const late = !done && s.state === "planned" && s.dueOn !== null && s.dueOn < today;
      const rows: Array<[string, string]> = [["Channel", CHANNEL_LABEL[s.channel]], ["For", who], ["Due", s.dueOn ?? "No date"]];
      nodes.push({
        id: s.id, parent: i === 0 ? "play" : steps[i - 1].id, row: i === 0 ? row : 0, action: i === 0 ? who : "then",
        title: s.title, metric: s.dueOn?.slice(5) ?? undefined, tone: done ? "done" : s.state === "skipped" ? "neutral" : late ? "failed" : "planned",
        card: <FlowRows rows={rows.slice(0, 2)} />,
        detail: <div className="space-y-3">
          <DealChatButton streamId={data.streamId} text={`Play step: ${s.title}. Channel: ${CHANNEL_LABEL[s.channel]}.`} /><FlowRows rows={[...rows, ["State", done ? "Done" : s.state === "skipped" ? "Skipped" : late ? "Overdue" : "Planned"]]} />
          {edit && <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} disabled={edit.busy} onClick={() => edit.resave(s, { state: done ? "planned" : "done" })}>{done ? "Mark not done" : "Mark done"}</button>
            <input type="date" aria-label="Due" disabled={edit.busy} value={s.dueOn ?? ""} onChange={(e) => edit.resave(s, { dueOn: e.target.value })} className={field} />
          </div>}
        </div>,
      });
    });
  });
  return nodes;
}

function Plan({ data, busy, run, team, section, page }: PlaySection<"plan">) {
  const saveStep = useAction(api.dealPlays.saveStep);
  const removeStep = useAction(api.dealPlays.removeStep);
  const { streamId, canEdit } = data;
  const actions = sectionActions(section);
  const ctx = pageContext(data);
  const addStep = offer(actions, "plan", "kernel.addStep", ctx);
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState<Channel>("linkedin");
  const [target, setTarget] = useState("");
  const [dueOn, setDueOn] = useState("");
  const resave = (s: PlayStep, patch: Partial<{ state: PlayStep["state"]; dueOn: string; ownerUserId: string }>) => run(() => saveStep({
    streamId, stepId: s.id, title: s.title, channel: s.channel,
    ...(s.contactId ? { contactId: s.contactId } : {}), ...(s.role ? { role: s.role } : {}),
    ...(s.ownerUserId ? { ownerUserId: s.ownerUserId } : {}), ...(s.dueOn ? { dueOn: s.dueOn } : {}),
    ...patch,
  } as never));
  const [showAll, setShowAll] = useState(false);
  const pending = data.steps.filter((s) => s.state === "planned" && !s.doneBy)
    .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
  const remaining = data.steps.filter((s) => s.state !== "planned" || s.doneBy);
  const visible = showAll ? [...pending, ...remaining] : pending.slice(0, 1);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Panel collapsed={Boolean(section.collapsed)} title={section.title ?? "Next action"} className="rounded-lg border-primary/30 bg-primary/5" action={<span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium">{pending.length} open</span>}>
      <FlowSwitch id="deal-plan" initial="list" label="Steps view"
        canvas={<FlowCanvas scenario={{ id: `deal-plan-${streamId}`, title: "Plan", nodes: data.steps.length ? planNodes(data, canEdit ? { busy, resave: (st, patch) => void resave(st, patch) } : null) : [] }} height={320} empty="No steps yet." />}
        list={<>
      {visible.length === 0 ? <p className="text-sm text-muted-foreground">{!canEdit ? "No open steps." : data.steps.length === 0 ? "Add a next step below, or research the account to draft a plan." : "No open steps. Add the next move below."}</p> : (
          <table className="w-full text-sm">
            <tbody>
              {visible.map((s) => {
                const done = s.state === "done" || s.doneBy !== null;
                const who = targetName(s, data);
                const at = { ...ctx, ...stepContext(data, s) };
                const owner = offer(actions, "plan", "kernel.setStepOwner", at);
                const due = offer(actions, "plan", "kernel.setStepDue", at);
                return (
                  <tr key={s.id} className="group border-t border-border align-top first:border-t-0">
                    <td className="w-6 py-2">
                      {slot(actions, "plan", at, {
                        "kernel.markDone": (o) => (
                          <button type="button" aria-label={o.label} disabled={busy || o.disabled}
                            onClick={() => void resave(s, { state: done ? "planned" : "done" })}
                            className={cn("mt-0.5 flex h-4 w-4 items-center justify-center border border-border", done && "bg-foreground text-background")}>
                            {done && <Check className="h-3 w-3" />}
                          </button>
                        ),
                      })}
                    </td>
                    <td className="py-2">
                      <div className={cn(done && "text-muted-foreground line-through", s.state === "skipped" && "text-muted-foreground line-through")}>{s.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{CHANNEL_LABEL[s.channel]}{who ? ` · ${who}` : ""}</span><DealChatButton streamId={data.streamId} text={`Play step: ${s.title}. Channel: ${CHANNEL_LABEL[s.channel]}. ${who ? `For ${who}.` : ""}`} />
                        {s.doneBy && <span className="text-emerald-700 dark:text-emerald-400">done by touch {day(s.doneBy.at)}</span>}
                        {s.origin === "research" && <span>drafted by research</span>}
                        <span className="ml-auto flex items-center gap-1">
                          {owner ? (
                            <SelectField aria-label={owner.label} disabled={busy || owner.disabled} value={s.ownerUserId ?? ""} onValueChange={(v) => void resave(s, { ownerUserId: v })}
                              options={[{ value: "", label: "No owner" }, ...(team ?? []).map((u) => ({ value: u._id, label: u.name ?? "Teammate" }))]} />
                          ) : <span>{team?.find((u) => u._id === s.ownerUserId)?.name ?? ""}</span>}
                          {due ? (
                            <input type="date" aria-label={due.label} disabled={busy || due.disabled} value={s.dueOn ?? ""} onChange={(e) => void resave(s, { dueOn: e.target.value })}
                              className={cn(field, "py-0.5", !done && s.dueOn && s.dueOn < today && "border-red-500 text-red-600")} />
                          ) : s.dueOn && <span>{s.dueOn}</span>}
                        </span>
                      </div>
                      {!done && s.state === "planned" && canEdit && DRAFTABLE.includes(s.channel) && data.people.some((p) => p.contactId === s.targetId) && (
                        <StepDraft data={data} step={s} busy={busy} run={run} page={page} collapsed />
                      )}
                    </td>
                    <td className="w-6 py-2 text-right">
                      {slot(actions, "plan", at, {
                        "kernel.removeStep": (o) => <button type="button" aria-label={o.label} disabled={busy || o.disabled} onClick={() => void run(() => removeStep({ streamId, stepId: s.id }))} className="p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"><X className="h-3 w-3" /></button>,
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </>} />
      {data.steps.length > visible.length || showAll ? (
        <button type="button" aria-expanded={showAll} className={cn(btn, "mt-3")} onClick={() => setShowAll(!showAll)}>
          {showAll ? "Focus on next action" : `Show all ${data.steps.length} steps`}
        </button>
      ) : null}
      {addStep && (
        <details className="mt-3 border-t border-border pt-3" open={data.steps.length === 0 ? true : undefined}>
          <summary className="cursor-pointer text-sm font-medium">{addStep.label}</summary>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            const [kind, id] = target.split(":");
            void run(async () => {
              await saveStep({ streamId, title, channel, ...(kind === "c" ? { contactId: id } : kind === "r" ? { role: id as DealRole } : {}), ...(dueOn ? { dueOn } : {}) });
              setTitle(""); setDueOn("");
            });
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Next touch (e.g. Founder note to the CRO)" className={cn(field, "min-w-[12rem] flex-1")} />
          <SelectField aria-label="Channel" value={channel} onValueChange={(v) => setChannel(v as Channel)} options={PLAY_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
          <SelectField aria-label="For" value={target} onValueChange={setTarget} className="max-w-[12rem]" options={[
            { value: "", label: "For…" },
            ...data.people.map((p) => ({ value: `c:${p.contactId}`, label: p.name })),
            ...DEAL_ROLES.filter((r) => r !== "involved").map((r) => ({ value: `r:${r}`, label: `Whoever is ${ROLE_LABEL[r]}` })),
          ]} />
          <input type="date" aria-label="Due" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={field} />
          <button type="submit" disabled={busy || addStep.disabled || !title.trim()} className={btn}><Plus className="h-3 w-3" /> Add</button>
        </form>
        </details>
      )}
    </Panel>
  );
}

function AccountMap({ data, busy, run, section }: PlaySection<"accountMap">) {
  const names = useObjectLabels();
  const setPerson = useAction(api.dealPlays.setPerson);
  const setRole = useAction(api.dealCommittee.setRole);
  const { streamId } = data;
  const actions = sectionActions(section);
  const ctx = pageContext(data);
  const edit = offer(actions, "accountMap", "kernel.setPerson", ctx);
  const addOther = offer(actions, "accountMap", "kernel.setRole", ctx);
  const disabled = !edit || edit.disabled || busy;
  const save = (p: PlayPerson, patch: Record<string, string>) => run(() => setPerson({ streamId, contactId: p.contactId, ...patch }));
  const order = (r: DealRole) => DEAL_ROLES.indexOf(r);
  const people = [...data.people].sort((a, b) => order(a.role) - order(b.role));
  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<DealRole>("involved");
  const [view, setView] = useState<"table" | "chart">("table");
  const toggle = (
    <span className="flex items-center gap-3 text-xs text-muted-foreground">
      <span>Persona and angle are hypotheses</span>
      <span role="radiogroup" aria-label="Map view" className="flex border border-border">
        {(["table", "chart"] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
            className={cn("px-2 py-0.5 text-xs font-medium", view === v ? "bg-primary text-primary-foreground" : "hover:text-foreground")}>
            {v === "table" ? "Table" : "Org chart"}
          </button>
        ))}
      </span>
    </span>
  );

  return (
    <Panel collapsed={Boolean(section.collapsed)} title={`${section.title ?? names("contact")!.pluralLabel} · ${data.people.length}`} action={toggle}>
      {people.length === 0 ? <p className="text-sm text-muted-foreground">No one is on this deal yet. Add people from the company below, or set the committee further down.</p> : view === "chart" ? <OrgChart people={people} /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className={cn(label, "text-left")}>
              <tr><th className="py-1 pr-3">Role</th><th className="py-1 pr-3">Person</th><th className="py-1 pr-3">Reports to</th><th className="py-1 pr-3">Angle</th><th className="py-1 pr-3">Confidence</th><th className="py-1">Thread</th></tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.contactId} className="border-t border-border align-top">
                  <td className="w-28 py-2 pr-3 text-xs font-medium text-muted-foreground">{ROLE_LABEL[p.role]}</td>
                  <td className="w-56 py-2 pr-3">
                    <Link href={recordHref("contact", p.contactId)} className="font-medium underline">{p.name}</Link>
                    {p.linkedinUrl && <a href={p.linkedinUrl} target="_blank" rel="noreferrer noopener" aria-label="LinkedIn" className="ml-1 inline-block align-middle text-muted-foreground hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
                    {p.title && <div className="text-xs text-muted-foreground">{p.title}</div>}
                    {!p.atCompany && <div className="text-xs text-amber-600">Not among the company&apos;s people</div>}
                    <div className="mt-1 text-xs text-muted-foreground"><EditText value={p.persona} placeholder="Persona: what they care about" disabled={disabled} onSave={(v) => save(p, { persona: v })} /></div>
                  </td>
                  <td className="w-40 py-2 pr-3">
                    <SelectField aria-label={`${p.name} reports to`} disabled={disabled} value={p.reportsTo ?? ""} onValueChange={(v) => void save(p, { reportsTo: v })} className="w-full"
                      options={[{ value: "", label: "—" }, ...data.people.filter((o) => o.contactId !== p.contactId).map((o) => ({ value: o.contactId, label: o.name }))]} />
                  </td>
                  <td className="py-2 pr-3"><EditText multiline value={p.angle} placeholder="How to open with them" disabled={disabled} onSave={(v) => save(p, { angle: v })} /></td>
                  <td className="w-28 py-2 pr-3">
                    <SelectField aria-label={`Confidence in ${p.name}`} disabled={disabled} value={p.confidence ?? ""} onValueChange={(v) => void save(p, { confidence: v })} className="w-full"
                      options={[{ value: "", label: "—" }, ...CONFIDENCE.map((c) => ({ value: c, label: c }))]} />
                  </td>
                  <td className="w-44 py-2">
                    <div className={THREAD_TONE[p.thread.state]}>{THREAD_LABEL[p.thread.state]}</div>
                    {p.thread.touches > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {p.thread.touches} touch{p.thread.touches === 1 ? "" : "es"}{p.thread.lastChannel ? ` · last ${CHANNEL_LABEL[p.thread.lastChannel]}` : ""}
                        {` · ${formatRelativeTime(Math.max(p.thread.lastOut ?? 0, p.thread.lastIn ?? 0))}`}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.suggested.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className={cn(label, "mb-2")}>Research suggests</h3>
          <ul className="space-y-2 text-sm">
            {data.suggested.map((s) => (
              <li key={s.contactId} className="flex items-start justify-between gap-3">
                <div>
                  <Link href={recordHref("contact", s.contactId)} className="font-medium underline">{s.name}</Link>
                  {s.title && <span className="text-muted-foreground"> · {s.title}</span>}
                  <span className="text-muted-foreground"> as {ROLE_LABEL[s.role]}</span>
                  {s.angle && <div className="text-xs text-muted-foreground">{s.angle}</div>}
                </div>
                {slot(actions, "accountMap", ctx, {
                  "kernel.addSuggested": (o) => <button type="button" disabled={busy || o.disabled} className={btn} onClick={() => void run(() => setRole({ streamId, contactId: s.contactId, role: s.role, reason: "Suggested by account research" }))}>{o.label}</button>,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {addOther && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <SelectField aria-label="Person" value={addId} onValueChange={setAddId} className="min-w-0 flex-1 max-w-none" options={[
            { value: "", label: `Add someone from ${data.deal.companyName ?? "the company"}…` },
            ...data.others.map((o) => ({ value: o.id, label: `${o.name}${o.title ? ` · ${o.title}` : ""}` })),
          ]} />
          <SelectField aria-label="Role" value={addRole} onValueChange={(v) => setAddRole(v as DealRole)} options={DEAL_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          <button type="button" disabled={busy || addOther.disabled || !addId} className={btn} onClick={() => void run(async () => { await setRole({ streamId, contactId: addId, role: addRole }); setAddId(""); })}><Plus className="h-3 w-3" /> {addOther.label}</button>
        </div>
      )}
      {edit && !edit.disabled && <CrmRoleNotes roles={data.crmRoles} roleLabel={(r) => ROLE_LABEL[r as DealRole]} onUsed={() => void run(async () => undefined)}
        personLink={(id, name) => <Link href={recordHref("contact", id)} className="underline">{name}</Link>} />}
    </Panel>
  );
}

function Touches({ data, section }: { data: ControlPlane; section: SectionOf<"touches"> }) {
  const name = (id: string | null) => (id ? data.people.find((p) => p.contactId === id)?.name ?? "Someone" : "The deal");
  const [limit, setLimit] = useState(10);
  return (
    <Panel collapsed={Boolean(section.collapsed)} title={`${section.title ?? "Activity"} · ${data.touches.length}`} action={<span className="text-xs text-muted-foreground">LinkedIn, email, calls and meetings with the people on this deal</span>}>
      {data.touches.length === 0 ? <p className="text-sm text-muted-foreground">No touches yet.</p> : (
        <ul className="space-y-1.5 text-sm">
          {data.touches.slice(0, limit).map((t, i) => (
            <li key={`${t.at}-${i}`} className="grid grid-cols-[5rem_8rem_1fr] gap-3">
              <time className="font-mono text-xs text-muted-foreground" title={new Date(t.at).toLocaleString()}>{day(t.at)}</time>
              <span className="truncate">{name(t.contactId)}</span>
              <span className={cn(t.direction === "in" && "font-medium")}>{t.direction === "in" ? "← " : t.direction === "out" ? "→ " : "↔ "}{t.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {data.touches.length > limit && <button type="button" className={cn(linkBtn, "mt-2")} onClick={() => setLimit(limit + 20)}>Show more</button>}
    </Panel>
  );
}


const DRAFTABLE: readonly Channel[] = ["email", "linkedin", "call"];

/** Every pending step for a person, the first touch first: a queued LinkedIn touch must not hide an email draft. */
const rowSteps = (data: ControlPlane, contactId: string) =>
  data.steps.filter((s) => s.state === "planned" && !s.doneBy && s.targetId === contactId && DRAFTABLE.includes(s.channel))
    .sort((a, b) => Number(b.title.startsWith("First touch")) - Number(a.title.startsWith("First touch")));

/** What a row's actions can read: where the person came from, and whether they already have a step to open. */
function rowContext(data: ControlPlane, p: ControlPlane["prospects"][number]): Context {
  const hasStep = p.contactId !== null && rowSteps(data, p.contactId).length > 0 && data.people.some((x) => x.contactId === p.contactId);
  return { "row.source": p.source, "row.inCanon": p.contactId !== null, "row.hasStep": hasStep };
}

/**
 * A person's first touch from their row: draft it (`actions`, which put them on the deal with a first-touch step), or
 * open the draft in a modal to review, edit and send. Nothing sends from here without that.
 */
function RowDraft({ data, contactId, name, busy, run, page, actions }: { data: ControlPlane; contactId: string; name: string; busy: boolean; run: Run; page: PageSpec; actions: ReactNode[] }) {
  // Read-only viewers can't open a draft (StepDraftContent shows them nothing), so there is nothing to offer.
  if (!data.canEdit) return <span className="text-xs text-muted-foreground">—</span>;
  const steps = rowSteps(data, contactId);
  const person = data.people.find((p) => p.contactId === contactId);
  if (!steps.length || !person) return <>{actions}</>;
  const title = steps.some((s) => s.draft) ? "Review draft" : "Prepare outreach";
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" aria-label={`${title} for ${name}`} className="text-left text-xs font-medium text-primary hover:underline">
          {`${title}${steps.length > 1 ? ` (${steps.length})` : ""}`}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{steps.length > 1 ? `Outreach to ${person.name}` : title}</DialogTitle>
          <DialogDescription>
            {steps.length > 1 ? `${steps.length} steps waiting` : `${CHANNEL_LABEL[steps[0].channel]} to ${person.name}`}{person.email && steps.some((s) => s.channel === "email") ? ` · ${person.email}` : ""}
          </DialogDescription>
        </DialogHeader>
        {steps.map((step) => (
          <div key={step.id} className="grid gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
            {steps.length > 1 && <p className={label}>{step.title} · {CHANNEL_LABEL[step.channel]}</p>}
            <StepDraftContent data={data} step={step} busy={busy} run={run} page={page} />
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}

/** What a step's actions read: the step, its draft and the person it is for. */
function stepContext(data: ControlPlane, step: PlayStep): Context {
  const person = data.people.find((p) => p.contactId === step.targetId);
  return {
    "step.channel": step.channel, "step.done": step.state === "done" || step.doneBy !== null, "step.doneByTouch": step.doneBy !== null, "step.queued": Boolean(step.queuedAt),
    "draft.exists": Boolean(step.draft), "draft.by": step.draft?.by ?? "none", "draft.subject": Boolean(step.draft?.subject),
    "person.email": Boolean(person?.email), "person.linkedinUrl": Boolean(person?.linkedinUrl),
  };
}

function StepDraft(props: { data: ControlPlane; step: PlayStep; busy: boolean; run: Run; page: PageSpec; collapsed?: boolean }) {
  const { data, step } = props;
  const person = data.people.find((p) => p.contactId === step.targetId);
  if (!data.canEdit || !person || !DRAFTABLE.includes(step.channel)) return null;
  const title = step.draft ? "Review draft" : "Prepare outreach";
  if (step.channel !== "email" && !props.collapsed) return <StepDraftContent {...props} />;
  if (step.channel !== "email") return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-primary">{title}</summary>
      <StepDraftContent {...props} />
    </details>
  );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="mt-2 text-left text-xs font-medium text-primary">{title}</button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Email to {person.name}{person.email ? ` · ${person.email}` : ""}</DialogDescription>
        </DialogHeader>
        <StepDraftContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A step's message: the keeper's draft (or a person's), editable in place. An email step sends from the user's
 * linked Gmail, and the sent email completes the step as a touch. A LinkedIn step copies the note and opens the
 * profile; the touch completes it once it lands.
 */
function StepDraftContent({ data, step, busy, run, page }: { data: ControlPlane; step: PlayStep; busy: boolean; run: Run; page: PageSpec }) {
  const setDraft = useAction(api.dealPlays.setDraft);
  const draftStep = useAction(api.dealPlayKeeper.draftStep);
  const send = useAction(api.emailActions.sendToContact);
  const saveDraft = useAction(api.emailActions.draftToContact);
  const mail = useQuery(api.emailAccounts.mine);
  const linkedin = useQuery(api.linkedin.mine);
  const queue = useAction(api.dealPlays.queueLinkedin);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const person = data.people.find((p) => p.contactId === step.targetId) ?? null;
  if (!data.canEdit || !person || !DRAFTABLE.includes(step.channel)) return null;
  const d = step.draft;
  const sender = mail?.accounts.find((a) => a.status === "ok") ?? null;
  const liSender = linkedin?.account && linkedin.account.status !== "credentials" ? linkedin.account : null;
  // An email reads, copies and sends as paragraphs, so a draft saved before the keeper wrote them does too.
  const draftBody = d ? (step.channel === "email" ? emailParagraphs(d.body) : d.body) : "";
  const edit = () => { setSubject(d?.subject ?? ""); setBody(draftBody); setEditing(true); };
  const save = () => void run(async () => { await setDraft({ streamId: data.streamId, stepId: step.id, contactId: person.contactId, subject, body }); setEditing(false); });
  const copy = () => void navigator.clipboard.writeText(d!.subject ? `${d!.subject}\n\n${draftBody}` : draftBody).then(() => toast.success("Copied"));
  const byLine = d && <span className="text-muted-foreground">{d.by === "keeper" ? `Drafted by the keeper ${formatRelativeTime(d.at)}` : "Your draft"}</span>;
  const actions = panelActions(page, "draftPanel");
  const ctx = { ...pageContext(data), ...stepContext(data, step), "gmail.linked": Boolean(sender), "linkedin.sender": Boolean(liSender) };
  const footer = slot(actions, "draftPanel", ctx, {
    "kernel.editDraft": (o) => <button type="button" disabled={busy || o.disabled} className={linkBtn} onClick={edit}>{o.label}</button>,
    "kernel.redraftStep": (o) => <button type="button" disabled={busy || o.disabled} className={linkBtn} onClick={() => void run(() => draftStep({ streamId: data.streamId, stepId: step.id }), "Redrafted")}>{o.label}</button>,
  });
  const scheduleNote = d && offered(actions, "draftPanel", ["kernel.saveGmailDraft"], ctx).length > 0;

  if (!d && !editing) {
    return (
      <div className="mt-2 flex gap-2">
        {slot(actions, "draftPanel", ctx, {
          "kernel.draftStep": (o) => <button type="button" disabled={busy || o.disabled} className={btn} onClick={() => void run(() => draftStep({ streamId: data.streamId, stepId: step.id }), "Drafted")}><Sparkles className="h-3 w-3" /> {o.label}</button>,
          "kernel.writeDraft": (o) => <button type="button" disabled={busy || o.disabled} className={linkBtn} onClick={edit}>{o.label}</button>,
        })}
      </div>
    );
  }
  if (step.channel === "email") {
    // A compose window, like Gmail's: who it's from and to, the subject, the body, and send at the foot.
    const row = "flex items-baseline gap-3 border-b border-border px-3 py-2";
    const rowLabel = "w-14 shrink-0 text-xs text-muted-foreground";
    return (
      <div className="mt-2 grid gap-2">
        <form className="border border-border bg-background text-sm" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className={row}>
            <span className={rowLabel}>From</span>
            {sender ? <span>{sender.address}</span> : <Link href="/dashboard/integrations?selected=gmail" className={linkBtn}>Link Gmail to send</Link>}
          </div>
          <div className={row}>
            <span className={rowLabel}>To</span>
            {person.email ? <span>{person.name} <span className="text-muted-foreground">&lt;{person.email}&gt;</span></span>
              : <span>{person.name} <span className="text-destructive">· no email address on file</span></span>}
          </div>
          <div className={cn(row, editing && "py-1")}>
            <span className={rowLabel}>Subject</span>
            {editing ? <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="min-w-0 flex-1 bg-transparent py-1 font-medium outline-none" />
              : d!.subject ? <span className="font-medium">{d!.subject}</span> : <span className="text-muted-foreground">No subject</span>}
          </div>
          {editing ? (
            <textarea aria-label="Message" rows={14} value={body} onChange={(e) => setBody(e.target.value)} className="block w-full resize-y bg-transparent px-3 py-3 leading-relaxed outline-none" />
          ) : (
            <div className="grid gap-3 px-3 py-4 leading-relaxed">
              {draftBody.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2 text-xs">
            {editing ? (
              <>
                <button type="submit" disabled={busy} className={primaryBtn}>Save</button>
                <button type="button" className={linkBtn} onClick={() => setEditing(false)}>Cancel</button>
              </>
            ) : (
              <>
                {slot(actions, "draftPanel", ctx, {
                  "kernel.sendEmail": (o) => (
                    <button type="button" disabled={busy || o.disabled} className={primaryBtn} title={d!.subject ? `From ${sender!.address} to ${person.email}` : "Add a subject first"}
                      onClick={() => void run(() => send({ accountId: sender!._id, contactId: person.contactId, subject: d!.subject ?? "", body: draftBody }), `Sent to ${person.email}`)}>
                      <Send className="h-3 w-3" /> {o.label}
                    </button>
                  ),
                  "kernel.saveGmailDraft": (o) => (
                    <button type="button" disabled={busy || o.disabled} className={linkBtn} title={d!.subject ? `Saves it in ${sender!.address} drafts to finish, or schedule, from Gmail` : "Add a subject first"}
                      onClick={() => void run(() => saveDraft({ accountId: sender!._id, contactId: person.contactId, subject: d!.subject ?? "", body: draftBody }), `Saved to ${sender!.address} drafts`)}>
                      {o.label}
                    </button>
                  ),
                })}
                <span className="ml-auto flex items-center gap-3">
                  {footer}
                  <button type="button" className={linkBtn} onClick={copy}>Copy</button>
                </span>
              </>
            )}
          </div>
        </form>
        {d && (
          <p className="flex flex-wrap gap-x-2 text-xs">
            {byLine}
            {scheduleNote && <span className="text-muted-foreground">· To schedule a send, save to Gmail drafts, then choose Schedule send in Gmail.</span>}
          </p>
        )}
        {d && !editing && <DraftChecks draft={d} pointOfView={data.pointOfView} />}
      </div>
    );
  }
  if (editing) {
    return (
      <form className="mt-2 grid gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <textarea aria-label="Message" rows={6} value={body} onChange={(e) => setBody(e.target.value)} className={cn(field, "text-sm")} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={btn}>Save</button>
          <button type="button" className={linkBtn} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    );
  }
  return (
    <div className="mt-2 border-l-2 border-border pl-3 text-sm">
      <div className="whitespace-pre-wrap text-muted-foreground">{d!.body}</div>
      <DraftChecks draft={d!} pointOfView={data.pointOfView} />
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {byLine}
        {footer}
        <button type="button" className={linkBtn} onClick={copy}>Copy</button>
        {slot(actions, "draftPanel", ctx, {
          "nav.linkedinProfile": (o) => <NavLink o={o} href={person.linkedinUrl!} external className={linkBtn}>{o.label}</NavLink>,
          "kernel.queueLinkedin": (o) => (
            <button type="button" disabled={busy || o.disabled} className={btn} title={`Sends from ${liSender!.profileName ?? "your LinkedIn"} within its daily limits and window: an invite, then this message (straight away if you're already connected)`}
              onClick={() => void run(() => queue({ streamId: data.streamId, stepId: step.id, senderAccountId: liSender!._id }), "Queued on LinkedIn")}>
              <Send className="h-3 w-3" /> {o.label}
            </button>
          ),
        })}
        {step.channel === "linkedin" && (
          step.queuedAt ? <span className="text-muted-foreground">Queued on LinkedIn {formatRelativeTime(step.queuedAt)}: invite, then this message</span>
          : !person.linkedinUrl ? <span className="text-muted-foreground">No LinkedIn profile on file</span>
          : !liSender ? <Link href="/dashboard/linkedin" className={linkBtn}>Connect LinkedIn to send</Link> : null
        )}
      </div>
    </div>
  );
}

/** The account map as a reporting tree (reports-to), each person with their role and thread. Set reports-to in the table. */
function OrgChart({ people }: { people: PlayPerson[] }) {
  const roots = orgTree(people);
  const linked = people.some((p) => p.reportsTo);
  const Node = ({ node }: { node: OrgNode<PlayPerson> }) => (
    <li>
      <div className="inline-block min-w-[14rem] border border-border bg-background px-3 py-2">
        <div className="flex items-baseline justify-between gap-3">
          <Link href={recordHref("contact", node.person.contactId)} className="font-medium hover:underline">{node.person.name}</Link>
          <span className="text-xs font-medium text-muted-foreground">{ROLE_LABEL[node.person.role]}</span>
        </div>
        {node.person.title && <div className="text-xs text-muted-foreground">{node.person.title}</div>}
        <div className={cn("text-xs", THREAD_TONE[node.person.thread.state])}>{THREAD_LABEL[node.person.thread.state]}</div>
      </div>
      {node.reports.length > 0 && <ul className="ml-6 mt-2 space-y-2 border-l border-border pl-4">{node.reports.map((r) => <Node key={r.person.contactId} node={r} />)}</ul>}
    </li>
  );
  return (
    <div>
      {!linked && <p className="mb-3 text-xs text-muted-foreground">No reporting lines yet. Set each person&apos;s Reports to in the table view.</p>}
      <ul className="space-y-3">{roots.map((r) => <Node key={r.person.contactId} node={r} />)}</ul>
    </div>
  );
}

/**
 * What a draft was checked against (docs/deal-prep-loop.md): the recipe's rule checks, which the server runs on
 * the saved draft (a person's edit too), and the model's review of a keeper draft. Passing checks fold into one
 * line; failing ones show.
 */
function DraftChecks({ draft, pointOfView }: { draft: NonNullable<PlayStep["draft"]>; pointOfView: ControlPlane["pointOfView"] }) {
  const [open, setOpen] = useState(false);
  const r = draft.review;
  const checks: Array<DraftCheck & { model?: boolean }> = [
    ...draft.checks,
    ...(r ? [
      { key: "relevant", label: "Relevant to their role", ok: r.relevant, model: true },
      ...(r.pointOfView !== undefined ? [{ key: "pov", label: "Rests on the point of view", ok: r.pointOfView, model: true }] : []),
      ...(r.surprising !== undefined ? [{ key: "surprising", label: "Says something they wouldn't expect", ok: r.surprising, model: true }] : []),
      ...(r.termConcessions !== undefined ? [{ key: "terms", label: "Preserves workspace deal terms", ok: r.termConcessions.length === 0, note: r.termConcessions.map((t) => `${t.label} (${t.severity})`).join(", "), model: true }] : []),
      { key: "reply", label: "They would reply", ok: r.wouldReply, model: true },
    ] : []),
  ];
  const failing = checks.filter((c) => !c.ok);
  const shown = open ? checks : failing;
  return (
    <div className="mt-2 grid gap-1 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className={failing.length ? "text-destructive" : "text-primary"}>{failing.length ? `${failing.length} of ${checks.length} checks fail` : `All ${checks.length} checks pass`}</span>
        <button type="button" className={linkBtn} onClick={() => setOpen(!open)}>{open ? "Hide checks" : "Show checks"}</button>
      </p>
      {shown.length > 0 && (
        <ul className="grid gap-0.5">
          {shown.map((c) => (
            <li key={c.key} className="flex items-baseline gap-1.5">
              {c.ok ? <Check className="h-3 w-3 shrink-0 translate-y-0.5 text-primary" /> : <X className="h-3 w-3 shrink-0 translate-y-0.5 text-destructive" />}
              <span>{c.label}{c.note && <span className="text-muted-foreground">: {c.note}</span>}{c.model && <span className="text-muted-foreground"> (model)</span>}</span>
            </li>
          ))}
        </ul>
      )}
      {r?.note && failing.some((c) => c.model) && <p className="text-muted-foreground">{r.note}</p>}
      <p className="text-muted-foreground">
        {pointOfView?.text ? <>Point of view from the ICP {pointOfView.icpName}.</>
          : pointOfView ? <>The ICP {pointOfView.icpName} has no point of view yet, so drafts make no claim of their own. <Link href="/dashboard/icps" className={linkBtn}>Add one</Link></>
          : <>This account is in no ICP, so drafts have no point of view.</>}
      </p>
    </div>
  );
}

function DealStateSection(props: React.ComponentProps<typeof DealStateSectionEnabled>) {
  return <IntegrationGate feature="chatgpt" note><DealStateSectionEnabled {...props} /></IntegrationGate>;
}
