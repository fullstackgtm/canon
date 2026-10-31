"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { ROLE_LABEL } from "../../../../convex/lib/committee";
import { CHANNEL_LABEL } from "../../../../convex/lib/plays/model";
import { LEVELS } from "../../../../convex/lib/addRecords";
import { NAV_SECTIONS } from "@/components/shell/nav";
import { checkSetting, sameSetting, type AnyDescriptor, type SettingValue } from "../../../../recipes";
import { declaredTheme, themeProblems, themeVars, type ThemeDecl } from "../../../../recipes/theme";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { formatRelativeTime } from "@/lib/background-activity";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

type View = NonNullable<FunctionReturnType<typeof api.recipes.settings>>;

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const input = "border border-border bg-background px-2 py-1 text-sm";
const LABELS: Record<string, string> = {
  ...ROLE_LABEL, ...CHANNEL_LABEL, ...Object.fromEntries(LEVELS.map((l) => [l.value, l.label])),
  ...Object.fromEntries(NAV_SECTIONS.flatMap((s) => s.items.flatMap((i) => (i.id ? [[i.id, i.label]] : [])))),
};

const asNumber = (text: string) => (text.trim() ? Number(text) : NaN);
/** What a field holds while it's being edited: a number input keeps its text until it's checked. */
const parse = (d: AnyDescriptor, raw: unknown): unknown => typeof raw !== "string" ? raw
  : d.kind === "int" || d.kind === "number" ? asNumber(raw)
  : d.kind === "ints" ? raw.split(",").map(asNumber)
  : raw;

export function shown(value: SettingValue): string {
  if (Array.isArray(value)) return value.length ? value.map((x) => LABELS[x] ?? x).join(", ") : "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** A changed long text shows only the part that changed, with a little context on each side. */
function change(from: SettingValue, to: SettingValue): [string, string] {
  const a = shown(from), b = shown(to);
  if (a.length + b.length <= 120) return [a, b];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const cut = (x: string) => {
    const from = Math.max(0, start - 12), to = Math.min(x.length, x.length - end + 12);
    return `${from > 0 ? "…" : ""}${x.slice(from, to)}${to < x.length ? "…" : ""}`;
  };
  return [cut(a), cut(b)];
}

/**
 * The workspace's settings for one recipe (docs/recipes.md, R2): a form built from the recipe's settings schema,
 * saved as a revision on top of the one it was opened on, the revision history with revert, and the open proposals
 * to approve or reject (R4).
 */
export function RecipeSettingsSheet({ recipe, onOpenChange }: { recipe: { id: string; title: string } | null; onOpenChange: (open: boolean) => void }) {
  const view = useQuery(api.recipes.settings, recipe ? { recipeId: recipe.id } : "skip");
  return (
    <Sheet open={recipe !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <div className="border-b border-border p-4 pr-10">
          <SheetTitle className="text-base">Customization settings</SheetTitle>
          <SheetDescription className="text-xs">
            {recipe?.title}{view ? ` · ${view.revision === null ? "customization defaults" : `revision ${view.revision}`}` : ""}
          </SheetDescription>
        </div>
        {view && <Editor key={`${view.recipeId}:${view.revision ?? 0}`} view={view} canEdit={view.canEdit} />}
      </SheetContent>
    </Sheet>
  );
}

function Editor({ view, canEdit }: { view: View; canEdit: boolean }) {
  const save = useMutation(api.recipes.saveSettings);
  const revert = useMutation(api.recipes.revertTo);
  const [raw, setRaw] = useState<Record<string, unknown>>(() => ({ ...view.settings }));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const schema = view.schema as readonly AnyDescriptor[];
  const checked = schema.map((d) => ({ d, result: checkSetting(d, parse(d, raw[d.key])) }));
  const values = Object.fromEntries(checked.flatMap(({ d, result }) => (result.ok ? [[d.key, result.value]] : [])));
  const theme = view.theme ? declaredTheme(view.theme as ThemeDecl, { ...view.defaults, ...values }) : null;
  const themeErrors = theme ? themeProblems(theme) : [];
  const invalid = checked.some((c) => !c.result.ok) || themeErrors.length > 0;
  const dirty = checked.some(({ d, result }) => !result.ok || !sameSetting(result.value, view.settings[d.key]));
  const groups = [...new Set(schema.map((d) => d.group))];

  async function run(change: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      const result = await change();
      toast.success(result && typeof result === "object" && "changed" in result && !result.changed ? "Nothing changed" : done);
      setNote("");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const onSave = () => run(() => save({
    recipeId: view.recipeId, baseRevision: view.revision, note: note || undefined,
    settings: Object.fromEntries(checked.flatMap(({ d, result }) => (result.ok ? [[d.key, result.value as string | number | boolean | string[]]] : []))),
  }), "Settings saved");

  return (
    <>
      <div className="flex-1 space-y-6 p-4">
        <Proposals view={view} canEdit={canEdit} busy={busy} run={run} />
        {theme && <ThemePreview vars={themeVars(theme)} problems={themeErrors.map((p) => p.message)} />}
        {groups.map((group) => (
          <fieldset key={group} className="space-y-3" disabled={!canEdit || busy}>
            <legend className="mb-2 text-xs font-medium text-muted-foreground">{group}</legend>
            {checked.filter((c) => c.d.group === group).map(({ d, result }) => (
              <Field key={d.key} d={d} raw={raw[d.key]} error={result.ok ? null : result.error}
                isDefault={result.ok && sameSetting(result.value, view.defaults[d.key])}
                onChange={(value) => setRaw((r) => ({ ...r, [d.key]: value }))} onReset={() => setRaw((r) => ({ ...r, [d.key]: view.defaults[d.key] }))} />
            ))}
          </fieldset>
        ))}
        <History view={view} canEdit={canEdit} busy={busy} onRevert={(revision) => run(() => revert({ recipeId: view.recipeId, revision }), revision ? `Reverted to revision ${revision}` : "Reverted to the customization defaults")} />
      </div>
      {canEdit && (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background p-3">
          <input className={cn(input, "min-w-0 flex-1 text-xs")} placeholder="What changed, and why (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="Save note" />
          <button type="button" className={cn(btn, "bg-foreground text-background hover:bg-foreground/90")} disabled={!dirty || invalid || busy} onClick={() => void onSave()}>Save</button>
        </div>
      )}
    </>
  );
}

function Field({ d, raw, error, isDefault, onChange, onReset }: { d: AnyDescriptor; raw: unknown; error: string | null; isDefault: boolean; onChange: (value: unknown) => void; onReset: () => void }) {
  const id = `setting-${d.key}`;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">{d.label}</label>
        {!isDefault && <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={onReset}>Reset to the customization default</button>}
      </div>
      {d.kind === "int" || d.kind === "number" ? (
        <input id={id} type="number" className={cn(input, "w-28")} min={d.min} max={d.max} step={d.kind === "int" ? 1 : d.step}
          value={typeof raw === "number" || typeof raw === "string" ? String(raw) : ""} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
      ) : d.kind === "ints" ? (
        <input id={id} type="text" inputMode="numeric" className={cn(input, "w-48")}
          value={Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : ""} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
      ) : d.kind === "bool" ? (
        <label className="flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" checked={raw === true} onChange={(e) => onChange(e.target.checked)} />
          {raw === true ? "Yes" : "No"}
        </label>
      ) : d.kind === "roles" || d.kind === "channels" || d.kind === "rules" || d.kind === "levels" ? (
        <div id={id} role="group" aria-label={d.label} className="flex flex-wrap gap-1.5">
          {d.options.map((o: string) => {
            const on = Array.isArray(raw) && raw.includes(o);
            return (
              <button key={o} type="button" aria-pressed={on} className={cn(btn, on && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
                onClick={() => onChange(on ? (raw as string[]).filter((x) => x !== o) : [...(Array.isArray(raw) ? raw : []), o])}>
                {LABELS[o] ?? o}
              </button>
            );
          })}
        </div>
      ) : d.kind === "color" ? (
        <div className="flex items-center gap-2">
          <input type="color" aria-label={`${d.label} colour`} className="h-8 w-10 cursor-pointer border border-border bg-background p-0.5"
            value={typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : "#000000"} onChange={(e) => onChange(e.target.value)} />
          <input id={id} className={cn(input, "w-28 font-mono text-xs")} value={typeof raw === "string" ? raw : ""} maxLength={7} spellCheck={false}
            aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
        </div>
      ) : d.kind === "choice" ? (
        <div id={id} role="radiogroup" aria-label={d.label} className="flex flex-wrap gap-1.5">
          {d.options.map((o: string) => (
            <button key={o} type="button" role="radio" aria-checked={raw === o} className={cn(btn, raw === o && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
              onClick={() => onChange(o)}>
              {LABELS[o] ?? o}
            </button>
          ))}
        </div>
      ) : (
        <textarea id={id} className={cn(input, "block min-h-16 w-full", d.kind === "phrases" && "font-mono text-xs")} rows={d.kind === "phrases" ? 2 : 4}
          maxLength={d.maxLength} value={typeof raw === "string" ? raw : ""} aria-invalid={Boolean(error)} spellCheck={d.kind !== "phrases"} onChange={(e) => onChange(e.target.value)} />
      )}
      {error ? <p className="text-xs text-destructive">{d.label} must be {error}.</p> : <p className="text-xs text-muted-foreground">{d.help}</p>}
    </div>
  );
}

/** The theme being edited, drawn in its own variables before it's saved, and why it can't be saved yet. */
function ThemePreview({ vars, problems }: { vars: Record<string, string>; problems: string[] }) {
  return (
    <section aria-label="Theme preview" className="space-y-2">
      <div style={vars as React.CSSProperties} className="border border-border bg-sidebar p-3">
        <div className="border border-border bg-card p-3 text-card-foreground">
          <p className="record-name text-base">Northwind Analytics</p>
          <p className="mt-0.5 text-xs text-muted-foreground">northwind.io · <span className="underline decoration-dotted decoration-provenance underline-offset-2">1,240 employees</span></p>
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-flex h-7 items-center bg-primary px-3 text-xs font-medium text-primary-foreground">Add account</span>
            <span className="inline-flex h-7 items-center border border-border px-3 text-xs font-medium">Filter</span>
            <span className="text-xs font-medium text-warning">2 need review</span>
            <span className="text-xs font-medium text-destructive">1 failed</span>
          </div>
        </div>
      </div>
      {problems.length > 0 && <ul className="space-y-0.5 text-xs text-destructive">{problems.map((p) => <li key={p}>{p[0].toUpperCase() + p.slice(1)}.</li>)}</ul>}
    </section>
  );
}

type Diff = View["revisions"][number]["diff"];
type Proposal = View["proposals"][number];

function DiffLines({ diff, label }: { diff: Diff; label: Map<string, string> }) {
  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {diff.map((line) => (
        <li key={line.key}><span className="text-muted-foreground">{label.get(line.key) ?? line.key}:</span> {change(line.from, line.to).join(" → ")}</li>
      ))}
    </ul>
  );
}

/** Proposed revisions from members and their agents (R4), each with its diff and eval results, for an admin or manager to decide. */
function Proposals({ view, canEdit, busy, run }: { view: View; canEdit: boolean; busy: boolean; run: (change: () => Promise<unknown>, done: string) => Promise<void> }) {
  const approve = useMutation(api.recipes.approveProposal);
  const reject = useMutation(api.recipes.rejectProposal);
  const label = new Map((view.schema as readonly AnyDescriptor[]).map((d) => [d.key, d.label]));
  if (!view.proposals.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">Proposed changes · {view.proposals.length}</h3>
      <ol className="divide-y divide-border border-y border-border">
        {view.proposals.map((p) => (
          <ProposalRow key={p.revision} p={p} label={label} canEdit={canEdit} busy={busy}
            onApprove={(acceptFailingEvals) => run(() => approve({ recipeId: view.recipeId, revision: p.revision, acceptFailingEvals }), `Proposal #${p.revision} approved`)}
            onReject={(reason) => run(() => reject({ recipeId: view.recipeId, revision: p.revision, reason: reason || undefined }), `Proposal #${p.revision} rejected`)} />
        ))}
      </ol>
    </section>
  );
}

function ProposalRow({ p, label, canEdit, busy, onApprove, onReject }: {
  p: Proposal; label: Map<string, string>; canEdit: boolean; busy: boolean;
  onApprove: (acceptFailingEvals: boolean) => Promise<void>; onReject: (reason: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const failing = p.evals.filter((e) => !e.ok).length;
  return (
    <li className="space-y-2 py-3 text-xs">
      <p>
        <span className="font-medium">Proposal #{p.revision}</span>
        <span className="text-muted-foreground"> · {p.author.name} · {formatRelativeTime(p.createdAt)}</span>
      </p>
      {p.note && <p>{p.note}</p>}
      <DiffLines diff={p.diff} label={label} />
      <EvalResults evals={p.evals} />
      {p.stale && <p className="text-muted-foreground">The settings changed since this was proposed. Ask for a fresh proposal.</p>}
      {canEdit && (confirming === null ? (
        <div className="flex gap-2">
          <button type="button" className={cn(btn, "bg-foreground text-background hover:bg-foreground/90")} disabled={busy || p.stale}
            onClick={() => (failing ? setConfirming("approve") : void onApprove(false))}>Approve</button>
          <button type="button" className={btn} disabled={busy} onClick={() => setConfirming("reject")}>Reject</button>
        </div>
      ) : confirming === "approve" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-destructive">{failing} eval{failing === 1 ? "" : "s"} fail{failing === 1 ? "s" : ""}. Approve anyway?</span>
          <button type="button" className={cn(btn, "border-destructive text-destructive")} disabled={busy} onClick={() => void onApprove(true)}>Approve anyway</button>
          <button type="button" className={btn} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input className={cn(input, "min-w-0 flex-1 text-xs")} placeholder="Why (optional, the author sees it)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Reject reason" />
          <button type="button" className={btn} disabled={busy} onClick={() => void onReject(reason)}>Reject</button>
          <button type="button" className={btn} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      ))}
    </li>
  );
}

/** Each eval's pass or fail, and why a failing one failed. */
export function EvalResults({ evals }: { evals: ReadonlyArray<{ name: string; ok: boolean; detail: string | null }> }) {
  if (!evals.length) return null;
  return (
    <ul className="space-y-0.5 text-xs" aria-label="Eval results">
      {evals.map((e) => (
        <li key={e.name} className="flex gap-2">
          <span className={cn("w-8 shrink-0 text-xs font-medium", e.ok ? "text-muted-foreground" : "text-destructive")}>{e.ok ? "pass" : "fail"}</span>
          <span>{e.name}{e.detail && <span className="text-muted-foreground">: {e.detail}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

function History({ view, canEdit, busy, onRevert }: { view: View; canEdit: boolean; busy: boolean; onRevert: (revision: number) => void }) {
  const label = new Map((view.schema as readonly AnyDescriptor[]).map((d) => [d.key, d.label]));
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">History</h3>
      {!view.revisions.length ? <p className="text-xs text-muted-foreground">No changes yet. This workspace runs the customization&apos;s defaults.</p> : (
        <ol className="divide-y divide-border border-y border-border">
          {view.revisions.map((r) => (
            <li key={r.revision} className="space-y-1 py-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <p>
                  <span className={cn(r.status === "current" && "font-medium")}>Revision {r.revision}</span>
                  <span className="text-muted-foreground"> · {r.author.name} · {formatRelativeTime(r.createdAt)}{r.status === "current" ? " · in force" : ""}</span>
                </p>
                {canEdit && r.status === "superseded" && <button type="button" className={btn} disabled={busy} onClick={() => onRevert(r.revision)}>Revert</button>}
              </div>
              {r.note && <p className="text-muted-foreground">{r.note}</p>}
              <DiffLines diff={r.diff} label={label} />
            </li>
          ))}
          {view.revisions.at(-1)?.parent === null && (
            <li className="flex items-baseline justify-between gap-2 py-2 text-xs">
              <span className="text-muted-foreground">Customization defaults</span>
              {canEdit && Object.keys(view.defaults).some((k) => !sameSetting(view.settings[k], view.defaults[k])) && <button type="button" className={btn} disabled={busy} onClick={() => onRevert(0)}>Revert</button>}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
