"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { LoadingRows, StatusBadge } from "@/components/dashboard";
import { recordHref } from "@/components/records/list-view";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { FlowCanvas, chain, type FlowNode } from "@/components/flow/flow-canvas";
import {
  TODAY, describe, describeConditions, describeParts, relatedField, ruleChanges, stepAt,
  type AutomationAction, type Condition, type IfStep, type OwnerChoice, type RuleNames, type RuleShape, type RuleStep, type Trigger,
} from "../../../../modules/kernel/automation";

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const when = (t: number) => new Date(t).toLocaleString();

export type Workspace = NonNullable<FunctionReturnType<typeof api.automations.workspace>>;
type ObjectInfo = Workspace["objects"][number];
type FieldInfo = ObjectInfo["fields"][number];
export type Rule = NonNullable<FunctionReturnType<typeof api.automations.list>>[number];
type Scalar = string | number | boolean;
type Owner = OwnerChoice;
type Action = AutomationAction;

const OPS: Array<[string, string]> = [
  ["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["gt", "is more than"], ["lt", "is less than"], ["empty", "is empty"], ["notEmpty", "is not empty"],
];
const NUMERIC = new Set(["number", "currency", "datetime"]);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const ACTION_TITLES: Record<Action["kind"], string> = { set_field: "Set a field", create_task: "Create a task", assign_owner: "Assign an owner", wait: "Wait", if: "If" };
/** How many Ifs deep a step may sit: an If holds one more If, and that one only actions. */
const IF_DEPTH = 2;

/** A typed value from a form's text, as the field stores it: money in cents, as the record filters store it. */
function parseValue(field: FieldInfo | undefined, raw: string): Scalar | null {
  if (raw === "") return null;
  if (raw === TODAY) return raw;
  if (field?.type === "currency") return Math.round(Number(raw) * 100);
  if (field && NUMERIC.has(field.type)) return Number(raw);
  if (field?.type === "checkbox") return raw === "true";
  return raw;
}
/** A stored value as the form shows it: money in whole units. */
const formText = (x: unknown, field?: FieldInfo) => (x === null || x === undefined ? "" : field?.type === "currency" && typeof x === "number" ? String(x / 100) : String(x));

/** What the sentence names a rule's references by, from the builder's workspace. */
export function namesFor(ws: Workspace, object: string): RuleNames {
  const o = ws.objects.find((x) => x.apiName === object);
  const related = Object.fromEntries((o?.relations ?? []).map((r) => [r.via, { label: r.label, fields: r.fields }]));
  return { object: o ? { label: o.label, fields: o.fields } : undefined, related, members: ws.members, teams: ws.teams, routingRules: ws.routingRules, timezone: ws.timezone, currency: ws.currency };
}

/** A field an If can test: the record's own, or with a dot a related record's (`companyId.industry`). */
const fieldIn = (o: ObjectInfo | undefined, apiName: string): FieldInfo | undefined => {
  const rel = relatedField(apiName, (f) => !o || o.fields.some((x) => x.apiName === f));
  return rel ? o?.relations.find((r) => r.via === rel.via)?.fields.find((f) => f.apiName === rel.field) : o?.fields.find((f) => f.apiName === apiName);
};

/** A run's or a replay's way through the rule's Ifs, in words: each If's conditions and whether they held. */
function pathText(path: ReadonlyArray<{ ref: string; took: "then" | "else" }>, rule: RuleShape, ws: Workspace): string {
  return path.map((p) => {
    const step = stepAt(rule.actions, p.ref);
    const words = step?.kind === "if" ? describeConditions(rule.object, step.conditions, namesFor(ws, rule.object)) : "If";
    return `${words}: ${p.took === "then" ? "yes" : "no"}`;
  }).join("; ");
}
export const sentence = (rule: RuleShape, ws: Workspace) => describe(rule, namesFor(ws, rule.object));

/** A rule as a flow: its trigger, the conditions a record must meet (one node), then each action in order, in the sentence's words. */
function ruleNodes(rule: RuleShape, ws: Workspace): FlowNode[] {
  const parts = describeParts(rule, namesFor(ws, rule.object));
  const text = (s: string) => <p className="line-clamp-3">{s}</p>;
  return chain([
    { id: "trigger", title: rule.trigger.kind === "schedule" ? "On a schedule" : "When", tone: "active", card: text(parts.trigger), detail: <p>{parts.trigger}</p> },
    ...(parts.conditions.length ? [{ id: "conditions", title: "Only if", action: "check", metric: String(parts.conditions.length), tone: "neutral" as const,
      card: text(parts.conditions.join(" and ")), detail: <ul className="list-disc space-y-1 pl-4">{parts.conditions.map((c) => <li key={c}>{c}</li>)}</ul> }] : []),
    ...rule.actions.map((a, i) => ({ id: `action-${i}`, title: ACTION_TITLES[a.kind], action: i === 0 ? "then" : "and then", tone: "planned" as const, card: text(parts.actions[i]), detail: <p>{parts.actions[i]}</p> })),
  ]);
}

type PreviewArgs = { object: string; trigger: Trigger; conditions: Condition[] };
type PreviewResult = FunctionReturnType<typeof api.automations.preview>;

/** Dry run: the existing records the rule's conditions match now (a schedule: at its next slot). Nothing runs. */
function DryRun({ args, label }: { args: PreviewArgs; label: string }) {
  const preview = useAction(api.automations.preview);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      setResult(await preview(args));
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1 text-xs" data-testid="automation-dry-run">
      <button type="button" className={btn} disabled={busy} onClick={() => void go()}>{label}</button>
      {result && (
        <div className="border border-border/60 p-2">
          <p className="text-muted-foreground">
            {result.nextSlotAt ? `Next run ${when(result.nextSlotAt)}: ` : "Matching now: "}
            {result.total} record{result.total === 1 ? "" : "s"}{result.total > result.rows.length ? `, first ${result.rows.length} shown` : ""}.
            {result.capped ? " A run acts on 500 at most; the rest wait for the next one." : ""} Nothing was changed.
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.rows.map((r) => <li key={r.streamId}><Link className="underline" href={recordHref(args.object, r.streamId)}>{r.title || "Untitled"}</Link></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

const lastRunText = (r: Rule) => (r.lastRun ? `Last run ${r.lastRun.status}, ${when(r.lastRun.at)}` : "No runs yet");

/**
 * Automation rules (CP17): the list, each rule in words, and one rule's detail. Admins only, as the functions are.
 * `selected` is the open rule's id, `creating` whether the new rule form is open; the page keeps both in its URL.
 */
export function AutomationRules({ selected, creating, onSelect }: { selected: string | null; creating: boolean; onSelect: (id: string | null) => void }) {
  const ws = useQuery(api.automations.workspace);
  const rules = useQuery(api.automations.list);
  if (ws === undefined || rules === undefined) return <LoadingRows count={2} height="h-24" />;
  if (ws === null || rules === null) return <p className="text-sm text-muted-foreground">Only admins manage automation rules.</p>;
  const open = rules.find((r) => r.id === selected);
  if (open) return <RuleDetail rule={open} ws={ws} onClose={() => onSelect(null)} />;
  return (
    <div className="max-w-5xl space-y-4">
      <Proposals ws={ws} />
      {creating && <Builder ws={ws} onDone={() => onSelect(null)} />}
      {rules.length === 0 && !creating && (
        <p className="border border-border p-4 text-sm text-muted-foreground">No rules yet. A rule could create a follow-up task when a deal reaches Proposal, or hand each new lead to the next rep in turn.</p>
      )}
      {rules.length > 0 && (
        <ul className="divide-y divide-border border border-border bg-card" aria-label="Automation rules">
          {rules.map((r) => (
            <li key={r.id} data-testid="automation-rule">
              <button type="button" onClick={() => onSelect(r.id)} className="block w-full p-3 text-left hover:bg-muted/50">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  <StatusBadge status={r.status} label={r.status === "active" ? "Active" : "Paused"} />
                </span>
                <span className="mt-1 block text-sm">{sentence(r, ws)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Acts as {r.actsAs} · {lastRunText(r)}{r.nextSlotAt ? ` · next run ${when(r.nextSlotAt)}` : ""}{r.recipe ? ` · from ${r.recipe.id} v${r.recipe.version}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ProposalRow = NonNullable<FunctionReturnType<typeof api.automations.proposals>>["open"][number];
type ReplayShown = { wouldRun: number; runs: Array<{ streamId: string; at: number; title: string; path?: Array<{ ref: string; took: "then" | "else" }> }>; skipped: Array<{ reason: string; count: number }>; partial: boolean; through: number | null; since: number; notes: string[] };
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A replay's summary: how often the rule would have run over the last two weeks and on what, what it would have skipped and why. */
function ReplaySummary({ replay, rule, ws }: { replay: ReplayShown; rule: RuleShape; ws: Workspace }) {
  const object = rule.object;
  const skipped = replay.skipped.reduce((n, s) => n + s.count, 0);
  return (
    <div className="space-y-1 border border-border/60 p-2 text-xs" data-testid="automation-replay">
      <p>
        <span className="font-medium">Over the last two weeks ({day(replay.since)} on), it would have run {replay.wouldRun} time{replay.wouldRun === 1 ? "" : "s"}</span>
        {skipped ? `, and skipped ${skipped} change${skipped === 1 ? "" : "s"}` : ""}.
        {replay.partial ? ` Partial: it read the history up to ${replay.through ? when(replay.through) : "the start"} and stopped at its read limit.` : ""}
      </p>
      {replay.runs.length > 0 && (
        <ul className="space-y-0.5">
          {replay.runs.map((r) => (
            <li key={`${r.streamId}-${r.at}`}>
              <span className="text-muted-foreground tabular-nums">{day(r.at)}</span> <Link className="underline" href={recordHref(object, r.streamId)}>{r.title || "Untitled"}</Link>
              {r.path?.length ? <span className="text-muted-foreground" data-testid="automation-replay-path"> · {pathText(r.path, rule, ws)}</span> : null}
            </li>
          ))}
          {replay.wouldRun > replay.runs.length && <li className="text-muted-foreground">and {replay.wouldRun - replay.runs.length} more</li>}
        </ul>
      )}
      {replay.skipped.length > 0 && <ul className="text-muted-foreground">{replay.skipped.map((s) => <li key={s.reason}>Skipped {s.count}: {s.reason}</li>)}</ul>}
      {replay.notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
    </div>
  );
}

/** Replay a proposal or a rule over the last two weeks, on request: a proposal keeps the result for its approver. */
function Replay({ args, rule, ws, stored, label }: { args: { versionId: Id<"automationVersions"> } | { ruleId: Id<"automationRules"> }; rule: RuleShape; ws: Workspace; stored?: ReplayShown | null; label: string }) {
  const replay = useAction(api.automations.replay);
  const [result, setResult] = useState<ReplayShown | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = result ?? stored ?? null;
  async function go() {
    setBusy(true);
    try {
      const out = await replay(args);
      if ("wouldRun" in out) setResult(out);
      else void toast.message("A schedule acts on what matches at each run: use the dry run instead.");
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      {shown ? <ReplaySummary replay={shown} rule={rule} ws={ws} /> : null}
      <button type="button" className={btn} disabled={busy} onClick={() => void go()}>{busy ? "Replaying…" : shown ? "Replay again" : label}</button>
    </div>
  );
}

const PART_LABELS: Record<string, string> = { name: "Name", object: "Object", trigger: "When", condition: "Only if", action: "Then" };

/** What a proposal changes against the version in force, part by part, in the sentence's words. */
function Changes({ row, ws }: { row: ProposalRow; ws: Workspace }) {
  const changes = ruleChanges(row.current, row.spec, namesFor(ws, row.spec.object));
  if (!changes.length) return <p className="text-xs text-muted-foreground">No change from the version in force.</p>;
  return (
    <ul className="space-y-1 text-xs" data-testid="automation-changes">
      {changes.map((c, i) => (
        <li key={i} className="grid gap-x-2 sm:grid-cols-[5rem_1fr]">
          <span className="text-muted-foreground">{PART_LABELS[c.part]}</span>
          <span>
            {c.before !== undefined && <del className="text-destructive">{c.before}</del>}
            {c.before !== undefined && c.after !== undefined && <span className="text-muted-foreground"> → </span>}
            {c.after !== undefined && <ins className="text-primary no-underline">{c.after}</ins>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Proposals waiting for an admin: each in a sentence, what it changes, who wrote it and why. Approving makes the approver the member the rule acts as. */
function Proposals({ ws }: { ws: Workspace }) {
  const data = useQuery(api.automations.proposals);
  const approve = useMutation(api.automations.approve);
  const reject = useMutation(api.automations.reject);
  const [busy, setBusy] = useState(false);
  if (!data?.open.length) return null;
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      void toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3" aria-label="Proposals" data-testid="automation-proposals">
      <h2 className="text-xs font-medium text-muted-foreground">Waiting for approval</h2>
      {data.open.map((row) => (
        <article key={row.id} className="space-y-2 border border-warning/40 bg-card p-4" data-testid="automation-proposal">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{row.spec.name} <span className="text-xs font-normal text-muted-foreground">{!row.current ? "new rule" : row.current.name === row.spec.name ? `version ${row.version}` : `version ${row.version} of ${row.current.name}`}</span></h3>
            <StatusBadge status="pending" label="Proposed" />
          </div>
          <p className="text-sm">{sentence(row.spec, ws)}</p>
          <p className="text-xs text-muted-foreground">
            {row.author.agent ? `Written by ${row.author.agent} for ${row.author.name}` : `Written by ${row.author.name}`}, {when(row.createdAt)}
            {row.note ? <>: “{row.note}”</> : null}
          </p>
          {row.current && <Changes row={row} ws={ws} />}
          {row.spec.trigger.kind === "schedule"
            ? <DryRun label="Dry run: which records it would act on at its next run" args={{ object: row.spec.object, trigger: row.spec.trigger, conditions: row.spec.conditions }} />
            : <Replay args={{ versionId: row.id }} rule={row.spec} ws={ws} stored={row.replay} label="Replay the last two weeks" />}
          {row.stale && <p className="text-xs text-warning">The rule changed since this was written (version {row.current?.version} is in force). Ask for a fresh proposal.</p>}
          <p className="text-xs text-muted-foreground">Approving it makes you the member this rule acts as, with your access.{row.current ? " A running rule keeps running on the new version from now on, never on what happened before." : " It starts at once."}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || row.stale || row.ruleGone} className="bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40"
              onClick={() => void run(() => approve({ versionId: row.id }), "Approved. The rule acts as you.")}>Approve</button>
            <button type="button" disabled={busy} className={btn} onClick={() => {
              const reason = window.prompt("Why reject it? The author sees this.");
              if (reason !== null) void run(() => reject({ versionId: row.id, reason }), "Rejected.");
            }}>Reject</button>
          </div>
        </article>
      ))}
    </section>
  );
}

function RuleDetail({ rule, ws, onClose }: { rule: Rule; ws: Workspace; onClose: () => void }) {
  const setStatus = useMutation(api.automations.setStatus);
  const remove = useMutation(api.automations.remove);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-5xl space-y-4" data-testid="automation-detail">
      <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={onClose}>All rules</button>
      <section className="space-y-3 border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 font-medium">{rule.name}</h2>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" className={btn} onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit"}</button>
            <button type="button" disabled={busy} className={btn} onClick={() => void run(() => setStatus({ id: rule.id, status: rule.status === "active" ? "paused" : "active" }))}>
              {rule.status === "active" ? "Pause" : "Resume"}
            </button>
            <button type="button" disabled={busy} className={btn} onClick={() => { if (window.confirm("Delete this rule?")) void run(async () => { await remove({ id: rule.id }); onClose(); }); }}>Delete</button>
          </div>
        </div>
        <p className="text-sm">{sentence(rule, ws)}</p>
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">Status</dt><dd>{rule.status === "active" ? "Active" : rule.pausedReason ?? "Paused"}</dd>
          <dt className="text-muted-foreground">Acts as</dt><dd>{rule.actsAs}, with their access as it is when the rule runs</dd>
          <dt className="text-muted-foreground">Version</dt><dd>{rule.version || "Before versions"}{rule.createdBy !== rule.actsAs ? ` · written by ${rule.createdBy}` : ""}</dd>
          <dt className="text-muted-foreground">Last run</dt><dd>{lastRunText(rule)}</dd>
          {rule.nextSlotAt ? <><dt className="text-muted-foreground">Next run</dt><dd>{when(rule.nextSlotAt)}</dd></> : null}
          {rule.lastSlot ? <><dt className="text-muted-foreground">Last slot</dt><dd>{when(rule.lastSlot.at)}: {rule.lastSlot.runs} record{rule.lastSlot.runs === 1 ? "" : "s"}{rule.lastSlot.done ? "" : ", in progress"}{rule.lastSlot.note ? ` (${rule.lastSlot.note})` : ""}</dd></> : null}
          {rule.recipe ? <><dt className="text-muted-foreground">From</dt><dd>Customization {rule.recipe.id} v{rule.recipe.version}</dd></> : null}
        </dl>
        <FlowCanvas scenario={{ id: `automation-${rule.id}`, title: rule.name, nodes: ruleNodes(rule, ws) }} height={220} />
        {rule.trigger.kind === "schedule"
          ? <DryRun label="Dry run" args={{ object: rule.object, trigger: rule.trigger, conditions: rule.conditions }} />
          : <Replay args={{ ruleId: rule.id }} rule={rule} ws={ws} label="Replay the last two weeks" />}
      </section>
      {editing && <Builder ws={ws} initial={rule} onDone={() => setEditing(false)} />}
      <section className="border border-border bg-card p-4">
        <h2 className="text-xs font-medium text-muted-foreground">Runs</h2>
        <Runs ruleId={rule.id} ws={ws} object={rule.object} />
      </section>
    </div>
  );
}

function Runs({ ruleId, ws, object }: { ruleId: Id<"automationRules">; ws: Workspace; object: string }) {
  const rows = useQuery(api.automations.runs, { ruleId });
  const retry = useMutation(api.automations.retryRun);
  const o = ws.objects.find((x) => x.apiName === object);
  const label = (field: string | undefined, value: unknown) => {
    const f = o?.fields.find((x) => x.apiName === field);
    return value === TODAY ? "today" : typeof value === "boolean" ? (value ? "Yes" : "No") : f?.options?.find((x) => x.value === value)?.label ?? String(value ?? "empty");
  };
  if (rows === undefined) return <LoadingRows count={1} height="h-8" />;
  if (!rows.length) return <p className="mt-2 text-xs text-muted-foreground">No runs yet. A run appears when a record changes the way the trigger says.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs" data-testid="automation-runs">
        <thead className="text-left text-muted-foreground">
          <tr><th className="py-1 pr-3">When</th><th className="pr-3">Record</th><th className="pr-3">Trigger</th><th className="pr-3">Conditions</th><th className="pr-3">Actions</th><th>Status</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border/60 align-top">
              <td className="py-1 pr-3 whitespace-nowrap">{when(r.createdAt)}</td>
              <td className="pr-3">{r.title ? <Link className="underline" href={recordHref(r.object, r.streamId)}>{r.title}</Link> : "Hidden record"}</td>
              <td className="pr-3">{r.change ? `${o?.fields.find((x) => x.apiName === r.change?.field)?.label ?? r.change.field}: ${label(r.change.field, r.change.from)} → ${label(r.change.field, r.change.to)}` : r.event === "schedule" && r.triggeredAt ? `Schedule, ${when(r.triggeredAt)}` : r.event}{r.depth ? ` (from a rule, depth ${r.depth})` : ""}</td>
              <td className="pr-3">{r.matched ? "Met" : r.reason ?? "Not met"}</td>
              <td className="pr-3">
                {r.steps.map((s, i) => (
                  // A step in an If's branch sits under it: its ref has a branch for each If it is in.
                  <div key={i} style={{ paddingLeft: `${((s.ref ?? "").split(".").length - 1) * 6}px` }} data-testid={s.kind === "if" ? "automation-run-if" : undefined}>
                    {ACTION_TITLES[s.kind as Action["kind"]] ?? s.kind}{s.branch ? `, ${s.branch === "then" ? "then" : "otherwise"}` : ""}: {s.status}{s.detail ? ` (${s.detail})` : ""}
                    {s.streamId ? <> · <Link className="underline" href={recordHref("task", s.streamId)}>open</Link></> : null}
                  </div>
                ))}
              </td>
              <td>
                {r.status}
                {r.status === "waiting" && r.resumeAt ? <span className="text-muted-foreground"> until {when(r.resumeAt)}</span> : null}
                {r.status === "done" && r.triggeredAt && r.finishedAt ? <span className="text-muted-foreground" data-delay-ms={r.finishedAt - r.triggeredAt}> in {((r.finishedAt - r.triggeredAt) / 1000).toFixed(1)} s</span> : null}
                {r.status === "failed" && (
                  <button type="button" className={`${btn} ml-2`} onClick={() => void retry({ runId: r.id }).catch((e: unknown) => toast.error(getErrorMessage(e)))}>Retry</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueInput({ field, value, onChange, label }: { field: FieldInfo | undefined; value: string; onChange: (v: string) => void; label: string }) {
  if (field?.options) {
    return (
      <SelectField aria-label={label} value={value} onValueChange={onChange}
        options={[{ value: "", label: "Choose…" }, ...field.options.map((o) => ({ value: o.value, label: o.label }))]} />
    );
  }
  if (field?.type === "checkbox") {
    return (
      <SelectField aria-label={label} value={value} onValueChange={onChange}
        options={[{ value: "", label: "Choose…" }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]} />
    );
  }
  if (field?.type === "date" || field?.type === "datetime") {
    return (
      <span className="flex items-center gap-1">
        <SelectField aria-label={`${label} kind`} value={value === TODAY ? "today" : "date"} onValueChange={(v) => onChange(v === "today" ? TODAY : "")}
          options={[{ value: "date", label: "a date" }, { value: "today", label: "today" }]} />
        {value !== TODAY && (
          <input aria-label={label} className={input} value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.type === "date" ? "YYYY-MM-DD" : "Value"} />
        )}
      </span>
    );
  }
  return <input aria-label={label} className={`${input} min-w-0`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Value" />;
}

function OwnerPicker({ owner, onChange, ws, allowRecordOwner }: { owner: Owner; onChange: (o: Owner) => void; ws: Workspace; allowRecordOwner: boolean }) {
  const first = ws.members[0]?.id;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <SelectField aria-label="Owner kind" value={owner.kind} onValueChange={(v) => {
        const k = v as Owner["kind"];
        if (k === "member" && first) onChange({ kind: "member", userId: first });
        if (k === "record_owner") onChange({ kind: "record_owner" });
        if (k === "round_robin") onChange({ kind: "round_robin", userIds: [] });
        if (k === "team" && ws.teams[0]) onChange({ kind: "team", teamId: ws.teams[0].id });
        if (k === "routing_rule" && ws.routingRules[0]) onChange({ kind: "routing_rule", routingRuleId: ws.routingRules[0].id });
      }}
        options={[
          ...(allowRecordOwner ? [{ value: "record_owner", label: "The record’s owner" }] : []),
          { value: "member", label: "A member" },
          { value: "round_robin", label: "Round robin over members" },
          ...(ws.teams.length > 0 ? [{ value: "team", label: "Round robin over a team" }] : []),
          ...(ws.routingRules.length > 0 ? [{ value: "routing_rule", label: "A saved routing rule" }] : []),
        ]} />
      {owner.kind === "member" && (
        <SelectField aria-label="Member" value={owner.userId} onValueChange={(v) => onChange({ kind: "member", userId: v as Id<"users"> })}
          options={ws.members.map((m) => ({ value: m.id, label: m.name }))} />
      )}
      {owner.kind === "round_robin" && ws.members.map((m) => (
        <label key={m.id} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={owner.userIds.includes(m.id)} onChange={() => onChange({ kind: "round_robin", userIds: owner.userIds.includes(m.id) ? owner.userIds.filter((x) => x !== m.id) : [...owner.userIds, m.id] })} />
          {m.name}
        </label>
      ))}
      {owner.kind === "team" && (
        <SelectField aria-label="Team" value={owner.teamId} onValueChange={(v) => onChange({ kind: "team", teamId: v as Id<"teamGroups"> })}
          options={ws.teams.map((t) => ({ value: t.id, label: `${t.name} (${t.size})` }))} />
      )}
      {owner.kind === "routing_rule" && (
        <SelectField aria-label="Routing rule" value={owner.routingRuleId} onValueChange={(v) => onChange({ kind: "routing_rule", routingRuleId: v as Id<"routingRules"> })}
          options={ws.routingRules.map((r) => ({ value: r.id, label: `${r.name} (${r.size})${r.isActive ? "" : ", off"}` }))} />
      )}
    </span>
  );
}

/** The steps without an If's condition rows that name no field yet: the form adds one, which the sentence and the save leave out. */
const withoutBlankConditions = (steps: readonly RuleStep[]): RuleStep[] => steps.map((s) => (s.kind !== "if" ? s : {
  ...s, conditions: s.conditions.filter((c) => c.field), then: withoutBlankConditions(s.then), ...(s.else ? { else: withoutBlankConditions(s.else) } : {}),
}));

/** An If's conditions: the record's own fields, and each related record's (by lookup), as the If reads them. Values are stored as the field stores them. */
function IfConditions({ conditions, onChange, o }: { conditions: readonly Condition[]; onChange: (c: Condition[]) => void; o: ObjectInfo | undefined }) {
  const options = [
    { value: "", label: "Field…" },
    ...(o?.fields ?? []).map((f) => ({ value: f.apiName, label: f.label })),
    ...(o?.relations ?? []).flatMap((r) => r.fields.map((f) => ({ value: `${r.via}.${f.apiName}`, label: `${r.label}: ${f.label}` }))),
  ];
  const set = (i: number, c: Condition) => onChange(conditions.map((x, j) => (j === i ? c : x)));
  return (
    <div className="space-y-1">
      {conditions.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <SelectField aria-label="If field" value={c.field} onValueChange={(v) => set(i, { field: v, op: c.op })} options={options} />
          <SelectField aria-label="If operator" value={c.op} onValueChange={(v) => set(i, { field: c.field, op: v, ...(v === "empty" || v === "notEmpty" ? {} : { value: c.value }) })}
            options={[...OPS, ...(OPS.some(([k]) => k === c.op) ? [] : [[c.op, c.op] as [string, string]])].map(([k, label]) => ({ value: k, label }))} />
          {c.op !== "empty" && c.op !== "notEmpty" && (Array.isArray(c.value)
            ? <button type="button" className={btn} aria-label="If value" onClick={() => set(i, { field: c.field, op: c.op })}>{c.value.length} values (replace)</button>
            : <ValueInput label="If value" field={fieldIn(o, c.field)} value={formText(c.value, fieldIn(o, c.field))} onChange={(raw) => set(i, { ...c, value: parseValue(fieldIn(o, c.field), raw) })} />)}
          <button type="button" className={btn} onClick={() => onChange(conditions.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" className={btn} onClick={() => onChange([...conditions, { field: "", op: "eq", value: null }])}>Add condition</button>
    </div>
  );
}

/** A rule's steps in order, each editable; an If holds two more lists, Then and Otherwise, down to IF_DEPTH Ifs. */
function StepList({ steps, onChange, ws, o, depth }: { steps: readonly RuleStep[]; onChange: (s: RuleStep[]) => void; ws: Workspace; o: ObjectInfo | undefined; depth: number }) {
  const fieldOf = (apiName: string) => o?.fields.find((f) => f.apiName === apiName);
  const editable = (o?.fields ?? []).filter((f) => f.apiName !== "ownerId" && f.type !== "formula");
  const dates = (o?.fields ?? []).filter((f) => f.type === "date" || f.type === "datetime");
  const set = (i: number, a: RuleStep) => onChange(steps.map((x, j) => (j === i ? a : x)));
  return (
    <div className="space-y-2">
      {steps.map((a, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 border-l-2 border-border pl-2" data-testid={a.kind === "if" ? "automation-if" : undefined}>
          <span className="text-xs text-muted-foreground">{i + 1}.</span>
          {a.kind === "set_field" && (
            <>
              <span>Set</span>
              <SelectField aria-label="Field to set" value={a.field} onValueChange={(v) => set(i, { ...a, field: v, value: null })}
                options={[{ value: "", label: "Field…" }, ...editable.map((f) => ({ value: f.apiName, label: f.label }))]} />
              <span>to</span>
              <ValueInput label="Value to set" field={fieldOf(a.field)} value={formText(a.value, fieldOf(a.field))} onChange={(raw) => set(i, { ...a, value: parseValue(fieldOf(a.field), raw) })} />
            </>
          )}
          {a.kind === "create_task" && (
            <>
              <span>Create a task</span>
              <input aria-label="Task subject" className={`${input} min-w-0`} value={a.subject} onChange={(e) => set(i, { ...a, subject: e.target.value })} placeholder="Follow up on {record}" />
              <span>due in</span>
              <input aria-label="Due in days" type="number" min={0} max={365} className={`${input} w-16`} value={a.dueInDays} onChange={(e) => set(i, { ...a, dueInDays: Number(e.target.value) })} />
              <span>days for</span>
              <OwnerPicker ws={ws} allowRecordOwner owner={a.owner} onChange={(owner) => set(i, { ...a, owner })} />
            </>
          )}
          {a.kind === "assign_owner" && (
            <>
              <span>Assign the owner:</span>
              <OwnerPicker ws={ws} allowRecordOwner={false} owner={a.owner} onChange={(owner) => set(i, { ...a, owner })} />
            </>
          )}
          {a.kind === "wait" && (
            <>
              <span>Wait</span>
              <SelectField aria-label="Wait for" value={a.until !== undefined ? "until" : "days"}
                onValueChange={(v) => set(i, v === "until" ? { kind: "wait", until: dates[0]?.apiName ?? "" } : { kind: "wait", days: 2 })}
                options={[{ value: "days", label: "a number of days" }, ...(dates.length ? [{ value: "until", label: "until a date on the record" }] : [])]} />
              {a.until !== undefined
                ? <SelectField aria-label="Wait until" value={a.until} onValueChange={(v) => set(i, { kind: "wait", until: v })} options={dates.map((f) => ({ value: f.apiName, label: f.label }))} />
                : <input aria-label="Days to wait" type="number" min={1} max={365} className={`${input} w-16`} value={a.days ?? 1} onChange={(e) => set(i, { kind: "wait", days: Number(e.target.value) })} />}
            </>
          )}
          {a.kind === "if" && <IfEditor step={a} onChange={(x) => set(i, x)} ws={ws} o={o} depth={depth} />}
          <button type="button" className={btn} onClick={() => onChange(steps.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "set_field", field: "", value: null }])}>Set a field</button>
        <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "create_task", subject: "Follow up on {record}", dueInDays: 2, owner: { kind: "record_owner" } }])}>Create a task</button>
        {o?.fields.some((f) => f.apiName === "ownerId") && ws.members.length > 0 && (
          <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "assign_owner", owner: { kind: "round_robin", userIds: [] } }])}>Assign an owner</button>
        )}
        <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "wait", days: 2 }])}>Wait</button>
        {depth < IF_DEPTH && (
          <button type="button" className={btn} onClick={() => onChange([...steps, { kind: "if", conditions: [{ field: "", op: "eq", value: null }], then: [] }])}>If…</button>
        )}
      </div>
    </div>
  );
}

function IfEditor({ step, onChange, ws, o, depth }: { step: IfStep; onChange: (s: IfStep) => void; ws: Workspace; o: ObjectInfo | undefined; depth: number }) {
  return (
    <div className="w-full space-y-2">
      <div className="text-xs text-muted-foreground">If the record, when the run gets here, matches</div>
      <IfConditions conditions={step.conditions} onChange={(conditions) => onChange({ ...step, conditions })} o={o} />
      <div className="text-xs text-muted-foreground">Then</div>
      <StepList steps={step.then} onChange={(then) => onChange({ ...step, then })} ws={ws} o={o} depth={depth + 1} />
      <div className="text-xs text-muted-foreground">Otherwise</div>
      <StepList steps={step.else ?? []} onChange={(next) => {
        const rest: IfStep = { ...step };
        delete rest.else;
        onChange(next.length ? { ...rest, else: next } : rest);
      }} ws={ws} o={o} depth={depth + 1} />
    </div>
  );
}

/** The new rule form, or with `initial` the form for changing that rule. A value list the form cannot show (a trigger's several values, a condition's list) is kept until it is replaced. */
function Builder({ ws, initial, onDone }: { ws: Workspace; initial?: Rule; onDone: () => void }) {
  const propose = useMutation(api.automations.propose);
  const t0 = initial?.trigger;
  /** A field of the rule being changed, for reading its stored values into the form. */
  const fieldIn = (apiName: string) => ws.objects.find((x) => x.apiName === initial?.object)?.fields.find((f) => f.apiName === apiName);
  const [name, setName] = useState(initial?.name ?? "");
  const [object, setObject] = useState(initial?.object ?? ws.objects[0]?.apiName ?? "deal");
  const [kind, setKind] = useState<Trigger["kind"]>(t0?.kind ?? "updated");
  const [field, setField] = useState(t0?.kind === "updated" ? t0.field ?? "" : "");
  const triggerField = t0?.kind === "updated" && t0.field ? fieldIn(t0.field) : undefined;
  const [from, setFrom] = useState<string | Scalar[]>(t0?.kind === "updated" && t0.from?.length ? (t0.from.length > 1 ? t0.from : formText(t0.from[0], triggerField)) : "");
  const [to, setTo] = useState<string | Scalar[]>(t0?.kind === "updated" && t0.to?.length ? (t0.to.length > 1 ? t0.to : formText(t0.to[0], triggerField)) : "");
  const [cadence, setCadence] = useState<"daily" | "weekly">(t0?.kind === "schedule" ? t0.cadence : "daily");
  const [weekday, setWeekday] = useState(t0?.kind === "schedule" ? t0.weekday ?? 1 : 1);
  const [time, setTime] = useState(t0?.kind === "schedule" ? clock(t0.minute) : "09:00");
  // A list value (`in`, `hasAny`, `hasAll`) the form can't show is kept as it is until it is replaced.
  const [conditions, setConditions] = useState<Array<{ field: string; op: string; value: string | Scalar[] }>>(
    initial?.conditions.map((c) => ({ field: c.field, op: c.op, value: Array.isArray(c.value) ? (c.value as Scalar[]) : formText(c.value, fieldIn(c.field)) })) ?? [],
  );
  const [actions, setActions] = useState<Action[]>(initial?.actions ?? []);
  const [busy, setBusy] = useState(false);
  const o = ws.objects.find((x) => x.apiName === object);
  const fieldOf = (apiName: string) => o?.fields.find((f) => f.apiName === apiName);

  const reset = (next: string) => {
    setObject(next);
    setField("");
    setFrom("");
    setTo("");
    setConditions([]);
    setActions([]);
  };

  const minute = (() => {
    const [h, m] = time.split(":").map(Number);
    return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : -1;
  })();
  const f = fieldOf(field);
  const valueList = (x: string | Scalar[]) => (Array.isArray(x) ? x : x ? [parseValue(f, x)!] : []);
  const trigger: Trigger = kind === "updated"
    ? { kind, ...(field ? { field } : {}), ...(valueList(from).length ? { from: valueList(from) } : {}), ...(valueList(to).length ? { to: valueList(to) } : {}) }
    : kind === "schedule" ? { kind, cadence, minute, ...(cadence === "weekly" ? { weekday } : {}) }
    : { kind };
  const conditionList: Condition[] = conditions.filter((c) => c.field).map((c) => ({
    field: c.field, op: c.op, ...(c.op === "empty" || c.op === "notEmpty" ? {} : { value: Array.isArray(c.value) ? c.value : parseValue(fieldOf(c.field), c.value) }),
  }));
  const draft: RuleShape = { object, trigger, conditions: conditionList, actions: withoutBlankConditions(actions) as Action[] };

  async function save() {
    setBusy(true);
    try {
      // A person's own change is approved as it is saved: they act as the admin who decides.
      await propose({ ...(initial ? { ruleId: initial.id } : {}), name, ...draft, conditions: conditionList, actions: draft.actions as Action[] });
      void toast.success(initial ? "Rule saved." : "Rule saved. It acts on changes from now on.");
      onDone();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const listInput = (label: string, x: string | Scalar[], set: (v: string) => void) => Array.isArray(x)
    ? <button type="button" className={btn} aria-label={label} onClick={() => set("")}>{x.length} values (replace)</button>
    : <ValueInput label={label} field={fieldOf(field)} value={x} onChange={set} />;

  return (
    <section className="space-y-3 border border-border bg-card p-4" data-testid="automation-builder">
      <h2 className="font-medium">{initial ? `Change ${initial.name}` : "New rule"}</h2>
      <input aria-label="Rule name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Proposal follow-up" className={`${input} w-full`} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">When a</span>
        <SelectField aria-label="Object" value={object} onValueChange={reset}
          options={ws.objects.map((x) => ({ value: x.apiName, label: x.label }))} />
        <SelectField aria-label="Trigger" value={kind} onValueChange={(v) => setKind(v as Trigger["kind"])}
          options={[
            { value: "created", label: "is created" },
            { value: "updated", label: "has a field change" },
            { value: "deleted", label: "is deleted" },
            { value: "schedule", label: "matches, on a schedule" },
          ]} />
        {kind === "schedule" && (
          <>
            <SelectField aria-label="Cadence" value={cadence} onValueChange={(v) => setCadence(v as "daily" | "weekly")}
              options={[{ value: "daily", label: "every day" }, { value: "weekly", label: "every week on" }]} />
            {cadence === "weekly" && (
              <SelectField aria-label="Weekday" value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}
                options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
            )}
            <span className="text-muted-foreground">at</span>
            <input aria-label="Time" type="time" className={input} value={time} onChange={(e) => setTime(e.target.value)} />
            <span className="text-xs text-muted-foreground">({ws.timezone})</span>
          </>
        )}
        {kind === "updated" && (
          <>
            <SelectField aria-label="Trigger field" value={field} onValueChange={(v) => { setField(v); setFrom(""); setTo(""); }}
              options={[{ value: "", label: "Any field" }, ...(o?.fields ?? []).map((f) => ({ value: f.apiName, label: f.label }))]} />
            {field && (
              <>
                <span className="text-muted-foreground">from</span>
                {listInput("From value", from, setFrom)}
                <span className="text-muted-foreground">to</span>
                {listInput("To value", to, setTo)}
                <span className="text-xs text-muted-foreground">(blank: any)</span>
              </>
            )}
          </>
        )}
      </div>

      <div className="space-y-2 text-sm">
        <div className="text-xs text-muted-foreground">{kind === "schedule" ? "Each time, for every record that matches (at most 500 a run)" : "Only if the record (after the change) matches"}</div>
        {conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <SelectField aria-label="Condition field" value={c.field} onValueChange={(v) => setConditions(conditions.map((x, j) => (j === i ? { ...x, field: v, value: "" } : x)))}
              options={[{ value: "", label: "Field…" }, ...(o?.fields ?? []).map((f) => ({ value: f.apiName, label: f.label }))]} />
            <SelectField aria-label="Condition operator" value={c.op} onValueChange={(v) => setConditions(conditions.map((x, j) => (j === i ? { ...x, op: v } : x)))}
              options={[...OPS, ...(OPS.some(([k]) => k === c.op) ? [] : [[c.op, c.op] as [string, string]])].map(([k, label]) => ({ value: k, label }))} />
            {c.op !== "empty" && c.op !== "notEmpty" && (Array.isArray(c.value)
              ? <button type="button" className={btn} aria-label="Condition value" onClick={() => setConditions(conditions.map((x, j) => (j === i ? { ...x, value: "" } : x)))}>{c.value.length} values (replace)</button>
              : <ValueInput label="Condition value" field={fieldOf(c.field)} value={c.value} onChange={(value) => setConditions(conditions.map((x, j) => (j === i ? { ...x, value } : x)))} />)}
            <button type="button" className={btn} onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className={btn} onClick={() => setConditions([...conditions, { field: "", op: "eq", value: "" }])}>Add condition</button>
      </div>

      <div className="space-y-2 text-sm">
        <div className="text-xs text-muted-foreground">Then, in order</div>
        <StepList steps={actions} onChange={(next) => setActions(next as Action[])} ws={ws} o={o} depth={0} />
      </div>

      <p className="border-l-2 border-primary pl-2 text-sm" data-testid="automation-sentence">{sentence(draft, ws)}</p>
      <FlowCanvas scenario={{ id: initial ? `automation-edit-${initial.id}` : "automation-draft", title: name || "New rule", nodes: ruleNodes(draft, ws) }} height={220} />
      <DryRun label="Dry run: which records match now" args={{ object, trigger, conditions: conditionList }} />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !name.trim() || !actions.length} onClick={() => void save()} className="bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-40">Save rule</button>
        <button type="button" className={btn} onClick={onDone}>Cancel</button>
      </div>
    </section>
  );
}
