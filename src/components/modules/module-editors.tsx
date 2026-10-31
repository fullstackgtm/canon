"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical, Layers, Star, Target, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { InlineDraft, editorOptions, recordEditorValue, type EditorOptions, type EditableHierarchy, type EditorCall, type InlineEdit, type RecordEditorValue, type TokenChange, type ValueControl } from "../../../modules/kernel/editor";
import { valueAt, type Doc } from "../../../modules/kernel/text";
import type { Node } from "../../../modules/kernel/manifest";

export type EditorAccess = {
  allowed: (ref: EditorCall) => boolean;
  invoke: (ref: EditorCall, row: Doc, inputs: Record<string, unknown>) => Promise<unknown>;
};
const input = "w-full min-w-0 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary disabled:opacity-60";
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function ModuleInlineInput({ edit, row, access, label, multiline = 0, placeholder = "", disabled = false, initialValue }: {
  edit: InlineEdit; row: Doc; access: EditorAccess; label: string; multiline?: number; placeholder?: string; disabled?: boolean; initialValue?: string;
}) {
  const value = initialValue ?? String(valueAt(row, edit.field) ?? ""), version = Number(valueAt(row, edit.version));
  const [draft] = useState(() => new InlineDraft(value, version));
  const [, redraw] = useState(0);
  const refresh = () => redraw((v) => v + 1);
  draft.receive(value, version);
  const latest = useRef({ edit, row, access });
  useEffect(() => { latest.current = { edit, row, access }; }, [edit, row, access]);
  const dirty = draft.value !== draft.original;
  const check = async (text: string): Promise<{ text: string; error?: string }> => {
    const { edit: current, row: record, access: actions } = latest.current;
    if (current.nonempty && !text.trim()) return { text, error: "Give a nonempty value." };
    if (text.length > current.maxLength) return { text, error: `Keep this within ${current.maxLength} characters.` };
    if (!current.validate) return { text: current.nonempty ? text.trim() : text };
    const out = await actions.invoke(current.validate, record, { [current.arg]: text, [current.versionArg]: draft.version });
    if (out === null || typeof out !== "object" || typeof (out as { text?: unknown }).text !== "string" || ((out as { error?: unknown }).error !== undefined && typeof (out as { error?: unknown }).error !== "string")) throw new Error("Invalid inline validation result.");
    return out as { text: string; error?: string };
  };
  const validateDraft = useRef(() => Promise.resolve());
  useEffect(() => { validateDraft.current = () => draft.validate(check).then(refresh); });
  const validateCall = edit.validate?.call;
  useEffect(() => {
    if (!dirty || !validateCall) return;
    const timer = setTimeout(() => { void validateDraft.current(); }, 250);
    return () => clearTimeout(timer);
  }, [draft.value, dirty, validateCall]);
  const commit = () => {
    if (edit.nonempty && !draft.value.trim()) { draft.escape(value, version); refresh(); return; }
    void draft.commit(check, async (text, originalVersion) => {
      const current = latest.current;
      await current.access.invoke(current.edit, current.row, { [current.edit.arg]: text, [current.edit.versionArg]: originalVersion });
    }).then(refresh);
    refresh();
  };
  const editable = access.allowed(edit) && !disabled;
  if (!editable && !multiline) return <span>{edit.prefix && String(valueAt(row, edit.prefix) ?? "")} {value}{edit.suffix && String(valueAt(row, edit.suffix) ?? "")}</span>;
  const props = {
    value: draft.value, disabled: !editable || draft.pending, maxLength: edit.maxLength, placeholder,
    "aria-label": label, "aria-invalid": !!draft.error, spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { draft.change(e.target.value); refresh(); },
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") { e.preventDefault(); draft.escape(value, version); refresh(); e.currentTarget.blur(); }
      if (e.key === "Enter" && !multiline) { e.preventDefault(); commit(); }
    },
  };
  return <div onClick={(e) => e.stopPropagation()}>
    <span className={cn("flex min-w-0 items-center", draft.error && "border border-destructive", edit.prefix && "font-mono text-xs")}>
      {edit.prefix && <span className="px-1 text-primary">{String(valueAt(row, edit.prefix) ?? "")}</span>}
      {multiline ? <textarea {...props} rows={multiline} className={cn(input, "resize-y")} /> : <input {...props} className={cn(input, "border-transparent bg-transparent px-1 hover:border-border", edit.prefix && "text-xs")} />}
      {edit.suffix && <span className="px-1 text-primary">{String(valueAt(row, edit.suffix) ?? "")}</span>}
    </span>
    {draft.pending && <span role="status" className="text-[11px] text-muted-foreground">Saving…</span>}
    {draft.error && <p role="alert" className="text-[11px] text-destructive">{draft.error}</p>}
  </div>;
}

function Control({ value, options, busy, change, remove }: { value: ValueControl; options: EditorOptions; busy: boolean; change: (next: Omit<TokenChange, "id">) => void; remove?: () => void }) {
  const [search, setSearch] = useState("");
  const [low, setLow] = useState(value.kind === "range" && value.min !== undefined ? String(value.min) : "");
  const [high, setHigh] = useState(value.kind === "range" && value.max !== undefined ? String(value.max) : "");
  const [error, setError] = useState("");
  const toggle = (v: string) => { if (value.kind !== "range") change({ values: value.values.includes(v) ? value.values.filter((x) => x !== v) : [...value.values, v] }); };
  return <div className="grid gap-2">
    {value.kind === "range" ? <form className="flex items-center gap-2" onSubmit={(e) => {
      e.preventDefault();
      const min = low.trim() ? Number(low) : undefined, max = high.trim() ? Number(high) : undefined;
      if (min === undefined && max === undefined || ![min, max].every((n) => n === undefined || Number.isFinite(n)) || min !== undefined && max !== undefined && min > max) return setError("Give a valid minimum or maximum.");
      setError(""); change({ ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
    }}>
      <input aria-label="Minimum" placeholder="Min" className={cn(input, "w-20")} value={low} onChange={(e) => setLow(e.target.value)} disabled={busy} />
      <span className="text-xs">to</span>
      <input aria-label="Maximum" placeholder="Max" className={cn(input, "w-20")} value={high} onChange={(e) => setHigh(e.target.value)} disabled={busy} />
      <button type="submit" disabled={busy} className="border px-2 py-1 text-xs">Set</button>
    </form> : value.kind === "choices" ? <div className="grid gap-1">
      {options[value.options].length > 12 && <input aria-label="Search values" placeholder="Search" className={input} value={search} onChange={(e) => setSearch(e.target.value)} />}
      <div className="grid max-h-64 overflow-auto">{options[value.options].filter((o) => value.values.includes(o.value) || !search.trim() || o.label.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => Number(value.values.includes(b.value)) - Number(value.values.includes(a.value))).map((o) =>
        <label key={o.value} className="flex items-center gap-2 px-1 py-0.5 text-sm hover:bg-muted"><input type="checkbox" checked={value.values.includes(o.value)} disabled={busy} onChange={() => toggle(o.value)} />{o.label}</label>)}</div>
      {!options[value.options].length && <p className="text-xs text-muted-foreground">No values available.</p>}
    </div> : <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); const term = search.trim(); if (term && !value.values.includes(term)) change({ values: [...value.values, term] }); setSearch(""); }}>
      <div className="flex flex-wrap gap-1">{value.values.map((v) => <button key={v} type="button" disabled={busy} aria-label={`Remove ${v}`} onClick={() => toggle(v)} className="border px-1 text-xs">{v} ×</button>)}</div>
      <input aria-label="Condition value" className={input} placeholder={value.placeholder} value={search} onChange={(e) => setSearch(e.target.value)} maxLength={120} disabled={busy} />
    </form>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {remove && <button type="button" disabled={busy} className="justify-self-start text-xs text-muted-foreground underline" onClick={remove}>Remove this condition</button>}
  </div>;
}

export function ModuleRecordEditor({ n, row, title, options: rawOptions, access }: { title?: string; options: unknown; n: Extract<Node, { c: "recordEditor" }>; row: Doc; access: EditorAccess }) {
  let model: RecordEditorValue, options: EditorOptions;
  try { options = editorOptions(rawOptions); model = recordEditorValue(valueAt(row, n.model), options); }
  catch (e) { return <p role="alert" className="text-sm text-destructive">{errorText(e)}</p>; }
  return <RecordEditor n={n} row={row} model={model} options={options} title={title} access={access} />;
}
function RecordEditor({ n, row, model, options, title, access }: { title?: string; options: EditorOptions; n: Extract<Node, { c: "recordEditor" }>; row: Doc; model: RecordEditorValue; access: EditorAccess }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending = useRef(false);
  const [choice, setChoice] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const editable = access.allowed(n.change);
  const save = async (change: TokenChange) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try { await access.invoke(n.change, row, { [n.change.arg]: change }); setAdding(false); setChoice(null); }
    catch (e) { setError(errorText(e)); }
    finally { sending.current = false; setBusy(false); }
  };
  const selected = model.conditions.find((c) => c.id === choice);
  return <section className="space-y-3 border border-border bg-card p-4">
    {title && <h2 className="text-sm font-semibold">{title}</h2>}
    <p className="text-sm leading-relaxed">{model.parts.map((p, i) => typeof p === "string" ? <span key={i}>{p}</span> : !editable ? <span key={p.id} className={cn("border-b-[1.5px] border-primary px-0.5", p.negative ? "border-dashed bg-muted" : "bg-primary/10")}>{p.text}</span> : <Popover key={p.id}>
      <PopoverTrigger asChild><button type="button" disabled={!editable || busy} className={cn("inline border-b-[1.5px] border-primary px-0.5 text-left disabled:cursor-default disabled:opacity-100", p.negative ? "border-dashed bg-muted" : "bg-primary/10")} aria-label={`Edit ${p.text}`}>{p.text}</button></PopoverTrigger>
      {editable && <PopoverContent align="start" className="w-80 rounded-none p-2"><Control key={`${row.key}:${valueAt(row, n.version)}:${p.id}`} value={p.control} options={options} busy={busy} change={(next) => void save({ id: p.id, ...next })} remove={() => void save({ id: p.id, remove: true })} /></PopoverContent>}
    </Popover>)}
      {editable && !!model.conditions.length && <Popover open={adding} onOpenChange={(open) => { setAdding(open); if (!open) setChoice(null); }}>
        <PopoverTrigger asChild><button type="button" disabled={busy} className="ml-1 text-xs text-muted-foreground underline">+ condition</button></PopoverTrigger>
        <PopoverContent align="start" className="w-80 rounded-none p-2">{selected ? <div className="space-y-2"><button type="button" onClick={() => setChoice(null)} className="text-xs underline">Conditions</button><p className="text-sm">{selected.label}</p><Control key={selected.id} value={selected.control} options={options} busy={busy} change={(next) => void save({ id: selected.id, add: true, ...next })} /></div> : <div className="grid max-h-72 overflow-auto">{model.conditions.map((c) => <button key={c.id} type="button" className="px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => setChoice(c.id)}>{c.label}</button>)}</div>}</PopoverContent>
      </Popover>}
    </p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <details><summary className="cursor-pointer text-xs text-muted-foreground">Message</summary><div className="mt-2 grid gap-2">
      {model.fields.map((f) => <label key={f.key} className="grid gap-1"><span className="text-xs text-muted-foreground">{f.label}</span><ModuleInlineInput
        edit={{ ...n.message, args: { ...n.message.args, [n.message.fieldArg]: f.key }, arg: n.message.valueArg, field: f.key, version: n.version, versionArg: n.versionArg, maxLength: f.maxLength }}
        row={row} access={access} initialValue={f.value} label={f.label} multiline={f.rows} placeholder={f.placeholder} />
      </label>)}
      {model.help && <p className="text-[11px] text-muted-foreground">{model.help}</p>}
    </div></details>
  </section>;
}

const icons = { target: Target, layers: Layers, users: Users };
export function HierarchyLabel({ hierarchy: h, row, hasChildren, closed, toggle, draggable, dragStart, dragEnd, children }: {
  hierarchy: EditableHierarchy; row: Doc; hasChildren: boolean; closed: boolean; toggle: () => void; draggable: boolean;
  dragStart: (e: React.DragEvent) => void; dragEnd: () => void; children: React.ReactNode;
}) {
  const Icon = icons[String(valueAt(row, h.icon)) as keyof typeof icons];
  return <div className="flex min-w-48 items-center gap-1" style={{ paddingLeft: `${Number(valueAt(row, h.depth)) * 18}px` }}>
    {draggable && <span draggable onDragStart={dragStart} onDragEnd={dragEnd} title="Drag to move. Move to also works with a keyboard." className="cursor-grab text-muted-foreground active:cursor-grabbing"><GripVertical className="size-3.5" /></span>}
    {hasChildren ? <button type="button" aria-expanded={!closed} aria-label={`Toggle ${String(row.data.name ?? row.key)}`} onClick={toggle}>{closed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}</button> : <span className="w-3.5" />}
    {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}{children}{valueAt(row, h.star) === true && <Star aria-label="Default" className="size-3 fill-current text-primary" />}
  </div>;
}

export function rowChoices(row: Doc, path: string): Array<{ value: string; label: string }> {
  const value = valueAt(row, path);
  if (!Array.isArray(value) || value.length > 200 || !value.every((v) => v !== null && typeof v === "object" && typeof v.value === "string" && typeof v.label === "string")) throw new Error("Invalid hierarchy choices.");
  return value;
}

export function HierarchyAdd({ h, row, access, select }: { h: EditableHierarchy; row: Doc; access: EditorAccess; select: (key: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false);
  if (!h.add || !access.allowed(h.add)) return null;
  const add = h.add;
  return <div className="flex flex-wrap gap-3 py-1" style={{ paddingLeft: `${(Number(valueAt(row, h.depth)) + 1) * 18}px` }}>
    {rowChoices(row, add.choices).map((o) => <button type="button" key={o.value} disabled={busy} aria-label={`${o.label.replace(/^\+ /, "")} under ${String(row.data.name ?? row.key)}`} className="border-b border-dashed border-border text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError("");
      void access.invoke(add, row, { [add.arg]: o.value }).then((value) => { if (value && typeof value === "object" && typeof (value as { key?: unknown }).key === "string") select((value as { key: string }).key); }, (e) => setError(errorText(e))).finally(() => { pending.current = false; setBusy(false); });
    }}>{o.label}</button>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
