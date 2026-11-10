"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Bot, ChevronDown, ChevronRight, Copy, FlaskConical, Gauge, KeyRound, Loader2, MessageSquare, Route, ShieldCheck, Trash2, Webhook } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EmptyState, LoadingRows, StatusBadge, ViewFrame } from "@/components/dashboard";
import { AgentOwnerLine } from "@/components/agents/agent-owner-line";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { SelectField } from "@/components/ui/select";

type Agent = NonNullable<ReturnType<typeof useQuery<typeof api.agentTurns.list>>>["agents"][number];
type Turn = NonNullable<ReturnType<typeof useQuery<typeof api.agentTurns.turns>>>[number];

const input = "border border-border bg-background px-2 py-1.5 text-sm text-foreground";
const button = "flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs hover:border-primary disabled:opacity-60";
const SAMPLE = JSON.stringify({ event: "demo.requested", email: "jane@acme.com", company: { domain: "acme.com" } }, null, 2);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"));

export default function AgentsPage() {
  const data = useQuery(api.agentTurns.list);
  const [open, setOpen] = useState(false);
  const create = data?.canCreate ? { label: "New agent", onClick: () => setOpen(true) } : undefined;
  return (
    <ViewFrame
      title="Agents"
      description="An agent wakes up when an event arrives on its webhook or a deal enters a stage, finds the account, and answers its AI fields about it. If the answers qualify, it can add the event's contact to an audience. It runs on its owner's ChatGPT plan, and every answer goes through the write gate."
      actions={create ? [{ id: "agents-new", primary: true, ...create }] : []}
    >
      <NewAgentDialog open={open} onOpenChange={setOpen} />
      {data === undefined ? (
        <LoadingRows />
      ) : data.agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="For example: when an account books a demo, research it and fill the fields your outbound uses."
          action={create}
        />
      ) : (
        <div className="grid gap-4">{data.agents.map((a) => <AgentCard key={a.id} agent={a} />)}</div>
      )}
      <RuleAgents />
    </ViewFrame>
  );
}

/** Automation rules have their own page, outside the ChatGPT gate: they run no AI. An old #automations link goes there. */
function RuleAgents() {
  const ws = useQuery(api.automations.workspace);
  useEffect(() => {
    if (window.location.hash === "#automations") window.location.replace("/dashboard/automations");
  }, []);
  if (!ws) return null;
  return (
    <section id="automations" className="mt-10 scroll-mt-8">
      <h2 className="text-xs font-medium text-muted-foreground">Rule agents</h2>
      <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
        Automation rules run no AI and need no ChatGPT plan: the same change always gets the same actions. They are on{" "}
        <Link href="/dashboard/automations" className="underline underline-offset-2">Automations</Link>.
      </p>
    </section>
  );
}

function NewAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const fields = useQuery(api.researchAgents.list);
  const create = useMutation(api.agentTurns.create);
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [turnsPerDay, setTurnsPerDay] = useState(20);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await create({ label, fieldSlugs: picked, turnsPerDay });
      setLabel(""); setPicked([]);
      onOpenChange(false);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2"><Bot className="size-4 text-primary" /> New agent</DialogTitle>
        <DialogDescription className="text-sm">
          You own the agent: its turns run on your ChatGPT plan. It answers the AI fields you pick for the account each event names.
        </DialogDescription>
        <form onSubmit={submit} className="grid gap-3 text-xs text-muted-foreground">
          <label className="grid gap-1">
            Name
            <input required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Demo request research" className={input} />
          </label>
          <fieldset className="grid gap-1">
            <legend className="mb-1">AI fields to answer (up to 10)</legend>
            {fields === undefined ? <LoadingRows /> : fields.agents.length === 0 ? (
              <p>No AI fields yet. <Link href="/dashboard/fields" className="underline underline-offset-2">Create one</Link> first.</p>
            ) : fields.agents.filter((f) => f.entityType === "account").map((f) => (
              <label key={f.slug} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={picked.includes(f.slug)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.slug] : p.filter((s) => s !== f.slug)))}
                />
                {f.label} <span className="text-xs text-muted-foreground">{f.question}</span>
              </label>
            ))}
          </fieldset>
          <label className="grid w-40 gap-1">
            Turns per day, at most
            <input type="number" min={1} max={500} value={turnsPerDay} onChange={(e) => setTurnsPerDay(Number(e.target.value))} className={input} />
          </label>
          <div className="flex justify-end">
            <button type="submit" disabled={busy || !label.trim() || picked.length === 0 || picked.length > 10} className="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60">
              {busy && <Loader2 className="size-3 animate-spin" />} Create agent
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const archive = useMutation(api.agentTurns.archive);
  const [showTurns, setShowTurns] = useState(true);
  const b = agent.budget;
  return (
    <section className="border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">{agent.label}</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            {agent.fields.map((f) => (
              <span key={f.slug} className={f.missing ? "bg-destructive/15 px-1.5 py-0.5 text-xs line-through" : "bg-muted px-1.5 py-0.5 text-xs"} title={f.missing ? "This AI field was deleted" : undefined}>
                {f.label}
              </span>
            ))}
          </div>
          <AgentOwnerLine agent={agent.agent} />
          <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Gauge className="size-3.5" />
            {agent.turnsToday} of {b.turnsPerDay} turns in the last 24 hours · per turn at most {b.maxRounds} read rounds per field, ~{Math.round(b.maxTokens / 1000)}k tokens, {Math.round(b.maxSeconds / 60)} min
          </p>
        </div>
        {agent.canManage && (
          <button
            type="button"
            aria-label={`Archive ${agent.label}`}
            onClick={() => { if (confirm(`Archive “${agent.label}”? Its webhook stops answering; its turns and answers stay.`)) void archive({ agentId: agent.id }).catch((e) => toast.error(getErrorMessage(e))); }}
            className="p-1.5 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      <WebhookPanel agent={agent} />
      <RoutingPanel agent={agent} />
      <SlackPanel agent={agent} />
      <GrantsPanel agent={agent} />
      {agent.canManage && <TestRun agentId={agent.id} />}
      <button type="button" onClick={() => setShowTurns((s) => !s)} className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        {showTurns ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Turns
      </button>
      {showTurns && <TurnLog agentId={agent.id} />}
    </section>
  );
}

function WebhookPanel({ agent }: { agent: Agent }) {
  const rotate = useAction(api.agentTurns.rotateSecret);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { url, rotatedAt } = agent.webhook;
  async function go() {
    if (rotatedAt && !confirm("Rotate the secret? The old one stops working at once.")) return;
    setBusy(true);
    try { setSecret((await rotate({ agentId: agent.id })).secret); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Webhook className="size-3.5" /> Webhook
        <code className="truncate bg-muted px-1.5 py-0.5 text-foreground">{url}</code>
        <button type="button" aria-label="Copy webhook URL" onClick={() => copy(url)} className="hover:text-foreground"><Copy className="size-3.5" /></button>
        <span>{rotatedAt ? `secret set ${when(rotatedAt)}` : "no secret yet: events are refused"}</span>
        {agent.canManage && (
          <button type="button" disabled={busy} onClick={() => void go()} className={button}>
            <KeyRound className="size-3" /> {rotatedAt ? "Rotate secret" : "Create secret"}
          </button>
        )}
      </div>
      {secret && (
        <div className="grid gap-1 border border-warning/40 bg-warning/10 p-2">
          <span className="text-foreground">Copy this signing secret now. Canon shows it only once.</span>
          <span className="flex items-center gap-2">
            <code className="break-all text-foreground">{secret}</code>
            <button type="button" aria-label="Copy secret" onClick={() => copy(secret)} className="hover:text-foreground"><Copy className="size-3.5" /></button>
          </span>
        </div>
      )}
      <details>
        <summary className="cursor-pointer hover:text-foreground">How to sign an event</summary>
        <p className="mt-1">POST JSON with a company <code>domain</code>, <code>website</code> or work <code>email</code> (top level or one level down). Sign <code>&lt;timestamp&gt;.&lt;body&gt;</code> with HMAC-SHA256; requests older than 5 minutes are refused. An <code>id</code> or <code>event_id</code> in the body makes retries safe: the same event runs once. Keep the secret in an environment variable, never on a command line.</p>
        <pre className="mt-1 overflow-x-auto bg-muted p-2 text-[11px] text-foreground">{`# CANON_WEBHOOK_SECRET is set in the environment (for example from your secret manager)
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$BODY" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write(require("crypto").createHmac("sha256",process.env.CANON_WEBHOOK_SECRET).update(b).digest("hex")))')
curl -X POST '${url}' -H 'Content-Type: application/json' \\
  -H "X-Canon-Timestamp: $ts" -H "X-Canon-Signature: v1=$sig" -d "$BODY"`}</pre>
      </details>
    </div>
  );
}

function routeSummary(agent: Agent): string {
  const r = agent.route;
  if (!r) return "Not routing contacts to an audience.";
  const field = r.rule && (agent.fields.find((f) => f.slug === r.rule!.fieldSlug)?.label ?? r.rule.fieldSlug);
  const cond = r.rule ? `when ${field} ${r.rule.op} “${r.rule.value}”` : "after every finished turn";
  return `Adds the event's contact to ${r.audienceName ?? "a removed audience"} ${cond}. Pushing the audience out stays manual.`;
}

function RoutingPanel({ agent }: { agent: Agent }) {
  const audiences = useQuery(api.audiences.list);
  const setRouting = useMutation(api.agentTurns.setRouting);
  const setCrmTrigger = useMutation(api.agentTurns.setCrmTrigger);
  const [editing, setEditing] = useState(false);
  const [audienceId, setAudienceId] = useState<string>(agent.route?.audienceId ?? "");
  const [field, setField] = useState(agent.route?.rule?.fieldSlug ?? "");
  const [op, setOp] = useState<"equals" | "contains">(agent.route?.rule?.op ?? "equals");
  const [value, setValue] = useState(agent.route?.rule?.value ?? "");
  const [onDeal, setOnDeal] = useState(Boolean(agent.crmTrigger));
  const [stage, setStage] = useState(agent.crmTrigger?.toStage ?? "");
  const [busy, setBusy] = useState(false);
  const choices = agent.fields.find((f) => f.slug === field)?.choices ?? [];
  async function save() {
    setBusy(true);
    try {
      await setRouting({
        agentId: agent.id,
        audienceId: (audienceId || null) as Id<"audiences"> | null,
        rule: audienceId && field ? { fieldSlug: field, op, value } : null,
      });
      await setCrmTrigger({ agentId: agent.id, trigger: onDeal ? { event: "deal.stage_changed", ...(stage.trim() ? { toStage: stage.trim() } : {}) } : null });
      setEditing(false);
      toast.success("Saved");
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const trigger = agent.crmTrigger
    ? `Also runs when a deal enters ${agent.crmTrigger.toStage ? `the “${agent.crmTrigger.toStage}” stage` : "any stage"}, about the deal's account.`
    : null;
  return (
    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Route className="size-3.5" /> {routeSummary(agent)}
        {trigger && <span>{trigger}</span>}
        {agent.canManage && !editing && <button type="button" onClick={() => setEditing(true)} className={button}>Edit routing and triggers</button>}
      </div>
      {editing && (
        <div className="grid gap-2 border border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            Add the event&apos;s contact to
            <SelectField aria-label="Audience" value={audienceId} onValueChange={setAudienceId}
              options={[{ value: "", label: "no audience (don’t route)" }, ...(audiences ?? []).map((a) => ({ value: a._id, label: a.name }))]} />
            when
            <SelectField aria-label="Rule field" value={field} disabled={!audienceId} onValueChange={setField}
              options={[{ value: "", label: "every finished turn" }, ...agent.fields.filter((f) => !f.missing).map((f) => ({ value: f.slug, label: f.label }))]} />
            {field && audienceId && (
              <>
                <SelectField aria-label="Rule operator" value={op} onValueChange={(v) => setOp(v as "equals" | "contains")}
                  options={[{ value: "equals", label: "equals" }, { value: "contains", label: "contains" }]} />
                <input aria-label="Rule value" list={`choices-${agent.id}`} value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} placeholder="value" className={input} />
                <datalist id={`choices-${agent.id}`}>{choices.map((c) => <option key={c} value={c} />)}</datalist>
              </>
            )}
          </div>
          {audiences !== undefined && audiences.length === 0 && (
            <p>No audiences yet. Save one from the <Link href="/dashboard/records/contact" className="underline underline-offset-2">contacts list</Link>.</p>
          )}
          <p>Only answers that passed the write gate count. The contact is found by the event&apos;s email among existing contacts; Canon doesn&apos;t create one.</p>
          <label className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={onDeal} onChange={(e) => setOnDeal(e.target.checked)} />
            Also run when a deal enters the stage
            <input aria-label="Deal stage" value={stage} maxLength={100} disabled={!onDeal} onChange={(e) => setStage(e.target.value)} placeholder="any stage" className={input} />
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || (Boolean(field) && Boolean(audienceId) && !value.trim())} onClick={() => void save()} className={button}>{busy && <Loader2 className="size-3 animate-spin" />} Save</button>
            <button type="button" onClick={() => setEditing(false)} className={button}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function GrantsPanel({ agent }: { agent: Agent }) {
  const data = useQuery(api.agentGrants.list, { agentId: agent.id });
  const create = useMutation(api.agentGrants.create);
  const revoke = useMutation(api.agentGrants.revoke);
  const fields = agent.fields.filter((f) => !f.missing);
  const [adding, setAdding] = useState(false);
  const [field, setField] = useState(fields[0]?.slug ?? "");
  const [values, setValues] = useState<string[]>([]);
  const [cap, setCap] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const choices = fields.find((f) => f.slug === field)?.choices ?? [];
  if (!data || (!data.grants.length && !data.canManage)) return null;
  async function submit() {
    setBusy(true);
    try {
      await create({ agentId: agent.id, fieldSlug: field, days, ...(values.length ? { allowedValues: values } : {}), ...(cap.trim() ? { maxPerDay: Number(cap) } : {}) });
      setAdding(false); setValues([]); setCap("");
      toast.success("Grant created");
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-3.5" /> Standing grants: answers a grant covers are accepted without a reviewer. The rest wait in Fact Review.
        {data.canManage && data.signingReady && !adding && fields.length > 0 && <button type="button" onClick={() => setAdding(true)} className={button}>Add grant</button>}
      </div>
      {data.canManage && !data.signingReady && <p>Grants can&apos;t be signed on this deployment yet: its encryption key isn&apos;t configured.</p>}
      {data.grants.map((g) => (
        <div key={g.id} className={`flex flex-wrap items-center gap-2 ${g.state === "live" ? "text-foreground" : ""}`}>
          <span className="font-medium">{g.fieldLabel}</span>
          <span>{g.allowedValues ? `only ${g.allowedValues.join(", ")}` : "any value"}</span>
          <span>· {g.usedToday}{g.maxPerDay !== null ? ` of ${g.maxPerDay}` : ""} in the last 24 hours</span>
          <span>· {g.revokedAt ? `revoked ${when(g.revokedAt)}` : `${g.state === "expired" ? "expired" : "expires"} ${when(g.expiresAt)}`}</span>
          {g.createdBy && <span>· by {g.createdBy}</span>}
          {g.state !== "live" && !g.revokedAt && <StatusBadge status="failed" label={g.stateLabel} />}
          {data.canManage && !g.revokedAt && (
            <button type="button" onClick={() => { if (confirm(`Revoke the grant on ${g.fieldLabel}? Answers wait for a reviewer again from now on.`)) void revoke({ grantId: g.id }).catch((e) => toast.error(getErrorMessage(e))); }} className={button}>
              Revoke
            </button>
          )}
        </div>
      ))}
      {adding && (
        <div className="grid gap-2 border border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            Let this agent set
            <SelectField aria-label="Grant field" value={field} onValueChange={(v) => { setField(v); setValues([]); }}
              options={fields.map((f) => ({ value: f.slug, label: f.label }))} />
            for
            <input aria-label="Days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${input} w-16`} /> days,
            at most
            <input aria-label="Daily cap" type="number" min={1} max={500} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="any" className={`${input} w-20`} /> values a day
          </div>
          {choices.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              Only these values (none ticked: any):
              {choices.map((c) => (
                <label key={c} className="flex items-center gap-1 text-foreground">
                  <input type="checkbox" checked={values.includes(c)} onChange={(e) => setValues((v) => (e.target.checked ? [...v, c] : v.filter((x) => x !== c)))} /> {c}
                </label>
              ))}
            </div>
          )}
          <p>The quote check and the write gate still apply. Deletes, merges and owner changes are never grantable.</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !field} onClick={() => void submit()} className={button}>{busy && <Loader2 className="size-3 animate-spin" />} Grant</button>
            <button type="button" onClick={() => setAdding(false)} className={button}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const SLACK_MODES = [
  { value: "all", label: "Every finished turn" },
  { value: "qualified", label: "Only qualified or routed turns" },
  { value: "failures", label: "Only failures and skips" },
] as const;

function SlackPanel({ agent }: { agent: Agent }) {
  const slack = useQuery(api.agentSlack.status);
  const setSlack = useMutation(api.agentTurns.setSlack);
  const [busy, setBusy] = useState(false);
  async function save(mode: "all" | "qualified" | "failures" | null) {
    setBusy(true);
    try { await setSlack({ agentId: agent.id, mode }); } catch (e) { toast.error(getErrorMessage(e)); } finally { setBusy(false); }
  }
  const on = agent.slack !== null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <MessageSquare className="size-3.5" />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on} disabled={busy || !agent.canManage} onChange={(e) => void save(e.target.checked ? "all" : null)} />
        Slack notification
      </label>
      {agent.slack && (
        <SelectField aria-label="Which turns to notify" value={agent.slack.mode} disabled={busy || !agent.canManage} onValueChange={(v) => void save(v as "all" | "qualified" | "failures")}
          options={SLACK_MODES} />
      )}
      {on && slack?.connected === false && (
        <span className="text-destructive">Slack isn&apos;t connected. <Link href="/dashboard/integrations?selected=slack" className="underline underline-offset-2">Add a webhook URL</Link> first.</span>
      )}
    </div>
  );
}

function TestRun({ agentId }: { agentId: Id<"agents"> }) {
  const testRun = useMutation(api.agentTurns.testRun);
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await testRun({ agentId, payload });
      if (res.status === "skipped") toast.error("Test run skipped: see the turn below.");
      else toast.success("Test run started");
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 text-xs text-muted-foreground">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 hover:text-foreground">
        <FlaskConical className="size-3.5" /> Test run with a sample event
      </button>
      {open && (
        <div className="mt-2 grid gap-2">
          <textarea aria-label="Sample event" rows={6} value={payload} onChange={(e) => setPayload(e.target.value)} className={`${input} font-mono text-xs`} />
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void run()} className={button}>{busy && <Loader2 className="size-3 animate-spin" />} Run test</button>
            <span>Runs like a real event, on the owner&apos;s plan, and counts against the daily budget.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TurnLog({ agentId }: { agentId: Id<"agents"> }) {
  const rows = useQuery(api.agentTurns.turns, { agentId });
  if (rows === undefined) return <LoadingRows />;
  if (!rows.length) return <p className="mt-2 text-xs text-muted-foreground">No turns yet. Send an event to the webhook, or use a test run.</p>;
  return (
    <table className="mt-2 w-full text-sm">
      <thead className="text-left text-xs font-medium text-muted-foreground">
        <tr><th className="py-1 pr-3 font-normal">When</th><th className="py-1 pr-3 font-normal">Status</th><th className="py-1 pr-3 font-normal">Account</th><th className="py-1 font-normal">Outputs</th></tr>
      </thead>
      <tbody>{rows.map((t) => <TurnRow key={t.id} turn={t} />)}</tbody>
    </table>
  );
}

function TurnRow({ turn: t }: { turn: Turn }) {
  // A Slack message links here as /dashboard/agents#turn-<id>; the rows load after the page, so scroll once this one exists.
  useEffect(() => {
    if (window.location.hash === `#turn-${t.id}`) document.getElementById(`turn-${t.id}`)?.scrollIntoView({ block: "center" });
  }, [t.id]);
  return (
    <tr id={`turn-${t.id}`} className="border-t border-border align-top text-xs target:bg-muted/50">
      <td className="py-2 pr-3 text-muted-foreground">
        {when(t.createdAt)}
        <div>{t.trigger === "test" ? "test run" : t.trigger === "crm_event" ? "deal stage" : "webhook"}</div>
      </td>
      <td className="py-2 pr-3">
        <StatusBadge status={t.status === "done" ? "completed" : t.status} label={t.waiting ? "waiting" : t.status} />
        {t.waiting && <div className="mt-0.5 text-[11px] text-muted-foreground">Runs after the agent&apos;s current turn.</div>}
        {t.status !== "skipped" && t.status !== "queued" && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{t.spend.modelCalls} calls · ~{Math.round(t.spend.tokens / 1000)}k tokens · {Math.round(t.spend.ms / 1000)}s</div>
        )}
      </td>
      <td className="py-2 pr-3">
        {t.account ? (
          <Link href={`/dashboard/accounts/${encodeURIComponent(t.account.recordId)}`} className="underline underline-offset-2">{t.account.name}</Link>
        ) : (
          <span className="text-muted-foreground">{t.subject.domain ?? t.subject.email ?? "—"}</span>
        )}
      </td>
      <td className="py-2 text-muted-foreground">
        {t.skip && <p className="text-destructive">{t.skip.message}</p>}
        {t.error && <p className="text-destructive">{t.error}</p>}
        {t.budgetHit && <p>Stopped at the turn&apos;s {t.budgetHit} budget.</p>}
        {t.outputs.map((o) => (
          <p key={o.fieldSlug}>
            <span className="text-foreground">{o.label}</span>:{" "}
            {o.value !== undefined ? <b className="font-medium text-foreground">{String(o.value)}</b> : o.status.replace(/_/g, " ")}
            {o.factId && <> · <Link href="/dashboard/facts" className="underline underline-offset-2">{o.factStatus ?? "proposed"}</Link></>}
            {o.value !== undefined && !o.factId && <> · {o.status.replace(/_/g, " ")}</>}
            {o.grantId && <span className="text-foreground"> · <ShieldCheck className="inline size-3" /> by standing grant</span>}
            {o.reason && <span> ({o.reason})</span>}
          </p>
        ))}
        {t.routing && (
          <p className={t.routing.status === "added" ? "text-foreground" : undefined}>
            <Route className="mr-1 inline size-3" />
            {t.routing.status === "added" ? <Link href="/dashboard/audiences" className="underline underline-offset-2">{t.routing.message}</Link> : t.routing.message}
          </p>
        )}
        {t.slack && (
          <p>
            <MessageSquare className="mr-1 inline size-3" />
            {t.slack.status === "sent" ? "Slack message sent" : t.slack.status === "sending" ? "Sending Slack message" : `Slack message failed${t.slack.httpStatus ? ` (HTTP ${t.slack.httpStatus})` : ""}${t.slack.error ? `: ${t.slack.error}` : ""}`}
          </p>
        )}
      </td>
    </tr>
  );
}
