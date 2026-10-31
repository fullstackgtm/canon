"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Linkedin, Pause, Play, Plus, Settings, Trash2, UserPlus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { BASE_VARS, MAX_MESSAGES, rate, type FunnelStage, type Step } from "../../../../convex/lib/linkedin/cadence";
import { EmptyState, LoadingRows, ViewFrame } from "@/components/dashboard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { linkedinPeople } from "@/lib/linkedin-people";
import { FlowCanvas, FlowSwitch, type FlowNode } from "@/components/flow/flow-canvas";
import { AcceptanceCharts, CadenceActivity, CohortTable, FunnelStages, StagePeople, pct, replyRate, type Person } from "./cadence-insights";
import { cn, getErrorMessage } from "@/lib/utils";
import { AccountSettings, IntakeSettings } from "../integrations/linkedin-card";
import { SelectField } from "@/components/ui/select";
import { SegmentBreakdown } from "./segment-breakdown";
import { ACTIVE_WITHIN_DAYS_CHOICES } from "../../../../convex/lib/linkedin/activity";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

const STATE_LABEL: Record<string, string> = {
  queued: "Queued", invited: "Invited", connected: "Connected", replied: "Replied", done: "Done",
  withdrawn: "Withdrawn", stopped: "Stopped", failed: "Failed",
};
const DEFAULT_STEPS: Step[] = [
  { kind: "invite", note: "" },
  { kind: "message", body: "Thanks for connecting, {{firstName}}.", delayDays: 1 },
];

async function attempt(work: () => Promise<unknown>, done?: string) {
  try {
    await work();
    if (done) void toast.success(done);
  } catch (cause) {
    void toast.error(getErrorMessage(cause));
  }
}

export default function LinkedinPage() {
  const mine = useQuery(api.linkedin.mine);
  const cadences = useQuery(api.linkedinCadences.list);
  const [open, setOpen] = useState<Id<"linkedinCadences"> | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const account = mine?.account ?? null;

  return (
    <ViewFrame
      title="LinkedIn"
      actions={account ? [
        { id: "linkedin-settings", label: "Settings", onClick: () => setSettingsOpen(true), icon: <Settings className="size-3.5" /> },
        { id: "linkedin-new-cadence", label: "New cadence", onClick: () => setOpen("new"), primary: true },
      ] : []}
    >
      {mine === undefined || cadences === undefined ? (
        <LoadingRows />
      ) : !account ? (
        <EmptyState
          icon={Linkedin}
          title="Connect your LinkedIn account first"
          description="Cadences send from your own account. Connect it in Integrations and review its limits."
          action={{ label: "Connect LinkedIn", href: "/dashboard/integrations/linkedin" }}
        />
      ) : (
        <>
          <SenderStrip account={account} showSummary={cadences.filter((c) => c.status === "active").length > 1} />
          <CadenceActivity cadences={cadences} />
          <CadenceTable cadences={cadences} current={open} onSelect={setOpen} />
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
              <DialogTitle>LinkedIn settings</DialogTitle>
              <DialogDescription>Manage your account&apos;s limits and sending hours across all cadences.</DialogDescription>
              <AccountSettings account={account} isAdmin={Boolean(mine?.isAdmin)} />
              <IntakeSettings account={account} />
            </DialogContent>
          </Dialog>
          <Dialog open={open !== null} onOpenChange={(o) => { if (!o) setOpen(null); }}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
              {open === "new" ? (
                <>
                  <DialogTitle>New cadence</DialogTitle>
                  <DialogDescription className="sr-only">Name the cadence and write its invite and follow-ups.</DialogDescription>
                  <NewCadence accountId={account._id} noteLimit={account.noteLimit} onCreated={(id) => setOpen(id)} />
                </>
              ) : open ? (
                <CadenceDetail key={open} id={open} />
              ) : null}
            </DialogContent>
          </Dialog>
        </>
      )}
    </ViewFrame>
  );
}

type CadenceRow = FunctionReturnType<typeof api.linkedinCadences.list>[number];

/** Every cadence side by side, led by acceptance rate: the number that says which invites work. */
function CadenceTable({ cadences, current, onSelect }: { cadences: CadenceRow[]; current: string | null; onSelect: (id: Id<"linkedinCadences"> | "new") => void }) {
  const th = "px-2 py-1 font-medium";
  const num = "px-2 py-1.5 text-right tabular-nums";
  return (
    <section aria-label="Cadences" className="mt-6">
      <h2 className="text-sm font-semibold">Cadences</h2>
      {cadences.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No cadences yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className={th}>Cadence</th><th className={th}>Status</th>
                <th className={cn(th, "text-right")}>Enrolled</th><th className={cn(th, "text-right")}>Invited</th>
                <th className={cn(th, "text-right")}>Accepted</th><th className={cn(th, "text-right")}>Acceptance</th>
                <th className={cn(th, "text-right")}>Pending</th><th className={cn(th, "text-right")}>Messaged</th>
                <th className={cn(th, "text-right")}>Replied</th><th className={cn(th, "text-right")}>Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {cadences.map((c) => {
                const f = c.funnel;
                return (
                  <tr
                    key={c._id}
                    onClick={() => onSelect(c._id)}
                    aria-selected={current === c._id}
                    className={cn("cursor-pointer border-t border-border/60 hover:bg-muted/50", current === c._id && "bg-muted")}
                  >
                    <td className="px-2 py-1.5">
                      <button type="button" className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onSelect(c._id); }}>{c.name}</button>
                      <span className="block text-xs text-muted-foreground">{c.steps} steps · {c.sender}</span>
                    </td>
                    <td className="px-2 py-1.5 text-xs">{c.status === "active" ? "Running" : "Paused"}</td>
                    {f ? (
                      <>
                        <td className={num}>{f.enrolled}{c.funnelTruncated ? "+" : ""}</td>
                        <td className={num}>{f.invited}</td>
                        <td className={num}>{f.accepted}</td>
                        <td className={cn(num, "font-semibold")}>{pct(rate(f.accepted, f.invited))}</td>
                        <td className={num}>{f.pending}</td>
                        <td className={num}>{f.messaged}</td>
                        <td className={num}>{f.replied}</td>
                        <td className={num}>{pct(replyRate(f))}</td>
                      </>
                    ) : (
                      <td colSpan={8} className="px-2 py-1.5 text-xs text-muted-foreground">Open the cadence to see its numbers.</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type Account = NonNullable<NonNullable<FunctionReturnType<typeof api.linkedin.mine>>["account"]>;

function SenderStrip({ account, showSummary }: { account: Account; showSummary: boolean }) {
  const notes = [
    account.status !== "ok" && (account.statusReason ?? "This account isn't sending."),
    account.holdUntil && `${account.holdReason ?? "Paused by LinkedIn."} Until ${new Date(account.holdUntil).toLocaleString()}.`,
    account.inviteHoldUntil && `Invites paused until ${new Date(account.inviteHoldUntil).toLocaleString()}.`,
    account.invitePause,
    account.throttled && "Acceptance is low, so today's caps are halved.",
  ].filter(Boolean) as string[];
  const metrics = [
    ["Invites today", `${account.usage.invitesToday} / ${account.today.invitesPerDay}`],
    ["Invites this week", `${account.usage.invitesWeek} / ${account.today.invitesPerWeek}`],
    ["Messages today", `${account.usage.messagesToday} / ${account.today.messagesPerDay}`],
    ["Pending invites", account.pendingInvites],
    ["Accepted (7 days)", pct(rate(account.acceptance.accepted, account.acceptance.sent))],
  ];
  return (
    <section aria-label="Sender" className="space-y-2">
      {showSummary && (
        <section aria-label="Summary">
          <h2 className="text-sm font-semibold">Summary</h2>
          <div className="mt-2 overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>{metrics.map(([label]) => <th key={label} scope="col" className="whitespace-nowrap px-2 py-1 text-right font-medium">{label}</th>)}</tr>
              </thead>
              <tbody>
                <tr className="border-t border-border/60">{metrics.map(([label, value]) => <td key={label} className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{value}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
      {notes.map((n) => <p key={n} className="text-sm text-amber-600 dark:text-amber-400">{n}</p>)}
      <p className="text-xs text-muted-foreground">
        Sending {account.profileName ? `as ${account.profileName}` : ""} in {account.timezone}.
      </p>
    </section>
  );
}

/**
 * A cadence as a flow: the invite, then each message once they accept; not accepting or replying ends it for that
 * contact. Each step's pane edits it.
 */
function cadenceNodes({ steps, onChange, noteLimit }: { steps: Step[]; onChange: (s: Step[]) => void; noteLimit: number }): FlowNode[] {
  const invite = steps[0] as Extract<Step, { kind: "invite" }>;
  const messages = steps.slice(1) as Extract<Step, { kind: "message" }>[];
  const setMessage = (i: number, patch: Partial<Extract<Step, { kind: "message" }>>) =>
    onChange([invite, ...messages.map((m, j) => (j === i ? { ...m, ...patch } : m))]);
  const body = (text: string | undefined, none: string) => <p className="line-clamp-3 whitespace-pre-wrap">{text?.trim() || none}</p>;
  const nodes: FlowNode[] = [
    { id: "invite", row: 0, title: "Connection invite", tone: "active", metric: invite.note ? `${invite.note.length} chars` : "no note", card: body(invite.note, "No note"),
      detail: <div className="space-y-1">
        <textarea rows={6} aria-label="Invite note" className={input} placeholder="Optional note. Invites without a note are often accepted just as well."
          value={invite.note ?? ""} onChange={(e) => onChange([{ kind: "invite", note: e.target.value }, ...messages])} />
        <p className={cn("text-xs", (invite.note ?? "").length > noteLimit ? "text-destructive" : "text-muted-foreground")}>{(invite.note ?? "").length} / {noteLimit}</p>
        {messages.length < MAX_MESSAGES && messages.length === 0 && <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "message", body: "", delayDays: 3 }])}><Plus className="h-3 w-3" /> Add follow-up</button>}
      </div> },
    { id: "not-accepted", parent: "invite", row: 1, action: "not accepted", title: "Ends", tone: "exit", card: <p>Not enrolled further.</p> },
  ];
  messages.forEach((m, i) => nodes.push({
    id: `message-${i}`, parent: i === 0 ? "invite" : `message-${i - 1}`, row: 0, action: i === 0 ? `accepted · ${m.delayDays}d` : `no reply · ${m.delayDays}d`,
    title: `Message ${i + 1}`, tone: "planned", metric: `+${m.delayDays}d`, card: body(m.body, "Empty message"),
    detail: <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="number" min={0} max={30} aria-label={`Days before message ${i + 1}`} className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          value={m.delayDays} onChange={(e) => setMessage(i, { delayDays: Number(e.target.value) })} />
        {i === 0 ? "days after they accept" : "days after the last message"}
      </label>
      <textarea rows={7} className={input} value={m.body} onChange={(e) => setMessage(i, { body: e.target.value })} aria-label={`Message ${i + 1}`} />
      <div className="flex gap-2">
        {i === messages.length - 1 && messages.length < MAX_MESSAGES && <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "message", body: "", delayDays: 3 }])}><Plus className="h-3 w-3" /> Add follow-up</button>}
        <button type="button" className={btn} onClick={() => onChange([invite, ...messages.filter((_, j) => j !== i)])}><Trash2 className="h-3 w-3" /> Remove</button>
      </div>
    </div>,
  }));
  if (messages.length) nodes.push({ id: "replied", parent: "message-0", row: 1, action: "replied", title: "Stops: replied", tone: "done", card: <p>A reply stops the cadence.</p> });
  return nodes;
}

/** The cadence's steps, on a canvas (select a step to edit it) or as a list. */
function StepsEditor(props: { steps: Step[]; onChange: (s: Step[]) => void; noteLimit: number }) {
  return <FlowSwitch id="linkedin-cadence" canvas={<FlowCanvas scenario={{ id: "linkedin-cadence", title: "Cadence", nodes: cadenceNodes(props) }} height={340} />} list={<StepsList {...props} />} />;
}

function StepsList({ steps, onChange, noteLimit }: { steps: Step[]; onChange: (s: Step[]) => void; noteLimit: number }) {
  const invite = steps[0] as Extract<Step, { kind: "invite" }>;
  const messages = steps.slice(1) as Extract<Step, { kind: "message" }>[];
  const setMessage = (i: number, patch: Partial<Extract<Step, { kind: "message" }>>) =>
    onChange([invite, ...messages.map((m, j) => (j === i ? { ...m, ...patch } : m))]);
  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium" htmlFor="invite-note">1. Connection invite</label>
        <textarea
          id="invite-note"
          rows={3}
          className={cn(input, "mt-1")}
          placeholder="Optional note. Invites without a note are often accepted just as well."
          value={invite.note ?? ""}
          onChange={(e) => onChange([{ kind: "invite", note: e.target.value }, ...messages])}
        />
        <p className={cn("text-xs", (invite.note ?? "").length > noteLimit ? "text-destructive" : "text-muted-foreground")}>{(invite.note ?? "").length} / {noteLimit}</p>
      </div>
      {messages.map((m, i) => (
        <div key={i}>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{i + 2}. Message</span>
            <input
              type="number"
              min={0}
              max={30}
              aria-label={`Days before message ${i + 1}`}
              className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={m.delayDays}
              onChange={(e) => setMessage(i, { delayDays: Number(e.target.value) })}
            />
            <span className="text-muted-foreground">{i === 0 ? "days after they accept" : "days after the last message"}</span>
            <button type="button" aria-label={`Remove message ${i + 1}`} className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => onChange([invite, ...messages.filter((_, j) => j !== i)])}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <textarea rows={4} className={cn(input, "mt-1")} value={m.body} onChange={(e) => setMessage(i, { body: e.target.value })} aria-label={`Message ${i + 1}`} />
        </div>
      ))}
      {messages.length < MAX_MESSAGES && (
        <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "message", body: "", delayDays: 3 }])}>
          <Plus className="h-3 w-3" /> Add follow-up
        </button>
      )}
      <p className="text-xs text-muted-foreground">
        Merge fields: {BASE_VARS.map((v) => `{{${v}}}`).join(" ")} and {"{{custom.<field>}}"} for any contact field or AI field. A contact missing a field the cadence uses isn&apos;t enrolled. A reply stops the cadence for that contact.
      </p>
    </div>
  );
}

function NewCadence({ accountId, noteLimit, onCreated }: { accountId: Id<"linkedinAccounts">; noteLimit: number; onCreated: (id: Id<"linkedinCadences">) => void }) {
  const create = useMutation(api.linkedinCadences.create);
  const templates = useQuery(api.templates.offered, { kind: "cadence" });
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [template, setTemplate] = useState<{ recipeId: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (value: string) => {
    const t = templates?.find((x) => `${x.recipeId}:${x.key}` === value);
    setTemplate(t ? { recipeId: t.recipeId, key: t.key } : null);
    if (t && "steps" in t.spec) { setName(t.title); setSteps(t.spec.steps as Step[]); }
  };
  return (
    <form
      className="space-y-4 border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void attempt(async () => onCreated(await create({ name, senderAccountId: accountId, steps, ...(template ? { template } : {}) })), "Cadence created. Enroll an audience, then start it.").finally(() => setBusy(false));
      }}
    >
      {!!templates?.length && (
        <SelectField aria-label="Start from a template" className="w-full sm:w-80" size="default" placeholder="Start from scratch"
          value={template ? `${template.recipeId}:${template.key}` : ""} onValueChange={pick}
          options={templates.map((t) => ({ value: `${t.recipeId}:${t.key}`, label: `${t.title} · ${t.recipeTitle}` }))} />
      )}
      <input className={input} aria-label="Cadence name" placeholder="Cadence name" value={name} onChange={(e) => setName(e.target.value)} />
      <StepsEditor steps={steps} onChange={setSteps} noteLimit={noteLimit} />
      <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        Create cadence
      </button>
    </form>
  );
}

function CadenceDetail({ id }: { id: Id<"linkedinCadences"> }) {
  const cadence = useQuery(api.linkedinCadences.get, { cadenceId: id });
  const update = useMutation(api.linkedinCadences.update);
  const setStatus = useMutation(api.linkedinCadences.setStatus);
  const stop = useMutation(api.linkedinCadences.stopEnrollment);
  const [draft, setDraft] = useState<{ name: string; steps: Step[]; activeWithinDays: number } | null>(null);
  const [stage, setStage] = useState<FunnelStage>("enrolled");
  const [now] = useState(() => Date.now());
  if (cadence === undefined) return <><DialogTitle className="sr-only">Cadence</DialogTitle><DialogDescription className="sr-only">Loading</DialogDescription><LoadingRows /></>;
  if (cadence === null) return <><DialogTitle>Cadence not found</DialogTitle><DialogDescription>It may have been archived.</DialogDescription></>;
  const people: Person[] = linkedinPeople(cadence.enrollments, "all");
  const isLive = (p: Person) => p.state === "queued" || p.state === "invited" || p.state === "connected";
  const next = (p: Person) =>
    !isLive(p) ? "–" : p.state === "invited" ? "Waiting for accept" : p.state === "queued" ? queuedLabel(p, cadence.queue.waitReason) : new Date(p.nextAt).toLocaleString();

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-2 pr-8">
        <DialogTitle>{cadence.name}</DialogTitle>
        <span className="text-xs text-muted-foreground">{cadence.status === "active" ? "Running" : "Paused"}</span>
        <DialogDescription className="sr-only">This cadence&apos;s funnel, acceptance timing, people and steps.</DialogDescription>
        {cadence.canEdit && (
          <div className="ml-auto flex gap-2">
            {cadence.status === "active" ? (
              <button type="button" className={btn} onClick={() => void attempt(() => setStatus({ cadenceId: id, status: "paused" }), "Cadence paused")}><Pause className="h-3 w-3" /> Pause</button>
            ) : (
              <button type="button" className={btn} onClick={() => void attempt(() => setStatus({ cadenceId: id, status: "active" }), "Cadence running")}><Play className="h-3 w-3" /> Start</button>
            )}
            <button type="button" className={btn} onClick={() => setDraft(draft ? null : { name: cadence.name, steps: cadence.steps as Step[], activeWithinDays: cadence.activeWithinDays })}>{draft ? "Cancel edit" : "Edit"}</button>
            <button
              type="button"
              className={btn}
              onClick={() => { if (window.confirm("Archive this cadence? Everyone still in it stops.")) void attempt(() => setStatus({ cadenceId: id, status: "archived" }), "Cadence archived"); }}
            >Archive</button>
          </div>
        )}
      </div>

      <FunnelStages funnel={cadence.funnel} truncated={cadence.funnelTruncated} stage={stage} onStage={setStage} />
      <AcceptanceCharts rows={people} timezone={cadence.queue.timezone ?? "UTC"} now={now} />
      {(cadence.counts.queued ?? 0) > 0 && <p className="text-xs">{queueSummary(cadence.queue)}</p>}
      <StagePeople
        key={stage}
        people={people}
        stage={stage}
        stateLabel={STATE_LABEL}
        next={next}
        actions={(p) => isLive(p) && cadence.canEdit && (
          <button type="button" className={btn} onClick={() => void attempt(() => stop({ enrollmentId: p._id as Id<"linkedinEnrollments"> }), "Stopped")}>Stop</button>
        )}
      />

      <CohortTable rows={people} now={now} />
      <SegmentBreakdown cadenceId={id} enrolled={cadence.funnel.enrolled} revision={Object.values(cadence.funnel).join(",")} />

      {draft ? (
        <form
          className="space-y-4 border border-border p-4"
          onSubmit={(e) => { e.preventDefault(); void attempt(async () => { await update({ cadenceId: id, ...draft }); setDraft(null); }, "Cadence saved"); }}
        >
          <input className={input} aria-label="Cadence name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <StepsEditor steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} noteLimit={cadence.sender?.tier === "free" ? 200 : 300} />
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Skip people with no LinkedIn posts or comments in
            <SelectField
              aria-label="Activity window"
              value={String(draft.activeWithinDays)}
              onValueChange={(v) => setDraft({ ...draft, activeWithinDays: Number(v) })}
              options={ACTIVE_WITHIN_DAYS_CHOICES.map((d) => ({ value: String(d), label: d === 0 ? "never skip" : `${d} days` }))}
            />
          </label>
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Save</button>
        </form>
      ) : (
        <>
        <p className="text-xs text-muted-foreground">{activityLabel(cadence.activeWithinDays)}</p>
        <ol className="space-y-2 text-sm" aria-label="Steps">
          {(cadence.steps as Step[]).map((s, i) => (
            <li key={i} className="border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">
                {s.kind === "invite" ? "Connection invite" : `Message, ${s.delayDays} day${s.delayDays === 1 ? "" : "s"} ${i === 1 ? "after they accept" : "after the last message"}`}
              </div>
              <div className="whitespace-pre-wrap">{s.kind === "invite" ? s.note || <span className="text-muted-foreground">No note</span> : s.body}</div>
            </li>
          ))}
        </ol>
        </>
      )}

      {cadence.canEdit && <EnrollAudience cadenceId={id} />}
    </div>
  );
}

const activityLabel = (days: number) =>
  days > 0
    ? `Before inviting, Canon checks their recent posts and comments with your account (two lookups, reused for 30 days) and skips anyone quiet for ${days} days.`
    : "Everyone is invited, active on LinkedIn or not.";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const etaDay = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type QueueInfo = { waitReason: string | null; window: { days: number[]; startMinute: number; endMinute: number } | null; timezone: string | null; queued: number; finishAt: number | null };

function queueSummary(q: QueueInfo): string {
  if (q.waitReason) return `Not sending: ${q.waitReason}`;
  const hours = q.window ? `${q.window.days.map((d) => DAY_NAMES[d]).join(", ")} ${hhmm(q.window.startMinute)}–${hhmm(q.window.endMinute)}${q.timezone ? ` (${q.timezone})` : ""}` : "";
  const finish = q.finishAt ? ` The ${q.queued} in this account's queue should all be invited by about ${etaDay(q.finishAt)}.` : "";
  return `Each day's invites are spread across your sending hours at random times, within the account's daily and weekly caps: ${hours}. "Next" is an estimate.${finish}`;
}

function queuedLabel(e: { position: number | null; eta: number | null }, waitReason: string | null): string {
  if (waitReason) return "Waiting (see above)";
  if (e.position === null) return "Queued";
  return e.eta ? `#${e.position} in line · about ${etaDay(e.eta)}` : `#${e.position} in line · over 60 days out`;
}

function EnrollAudience({ cadenceId }: { cadenceId: Id<"linkedinCadences"> }) {
  const audiences = useQuery(api.audiences.list);
  const preview = useAction(api.linkedinCadences.previewEnroll);
  const enroll = useAction(api.linkedinCadences.enroll);
  const [audienceId, setAudienceId] = useState<Id<"audiences"> | "">("");
  const [plan, setPlan] = useState<{ total: number; enroll: number; skipped: { contactName: string; reason: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>, done?: string) => { setBusy(true); void attempt(work, done).finally(() => setBusy(false)); };

  return (
    <section className="border border-border p-4">
      <h3 className="text-sm font-semibold">Add people from an audience</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SelectField
          aria-label="Audience"
          value={audienceId}
          onValueChange={(v) => { setAudienceId(v as Id<"audiences">); setPlan(null); }}
          options={[{ value: "", label: "Choose an audience" }, ...(audiences ?? []).map((a) => ({ value: a._id, label: a.name }))]}
        />
        <button type="button" className={btn} disabled={!audienceId || busy} onClick={() => run(async () => setPlan(await preview({ cadenceId, audienceId: audienceId as Id<"audiences"> })))}>Preview</button>
        {plan && plan.enroll > 0 && (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => run(async () => {
              const out = await enroll({ cadenceId, audienceId: audienceId as Id<"audiences">, expectToEnroll: plan.enroll });
              setPlan(null);
              void toast.success(`${out.enrolled} enrolled${out.skipped ? `, ${out.skipped} skipped` : ""}`);
            })}
          >
            <UserPlus className="h-3 w-3" /> Enroll {plan.enroll}
          </button>
        )}
      </div>
      {plan && (
        <div className="mt-2 text-sm">
          <p>{plan.enroll} of {plan.total} would join. {plan.skipped.length ? `${plan.skipped.length} skipped:` : ""}</p>
          {plan.skipped.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-muted-foreground">
              {plan.skipped.map((s, i) => <li key={i}>{s.contactName}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
