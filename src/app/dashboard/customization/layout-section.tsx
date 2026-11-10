"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, EyeOff, GripVertical, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { DEAL_STAGES, type DealStage } from "../../../../convex/lib/plays/model";
import { KERNEL_ACTIONS, scopeOf, type ActionId, type Panel } from "../../../../recipes/actions";
import type { Layout, LayoutOp, LayoutSection } from "../../../../recipes/md/edit";
import type { PageComponent } from "../../../../recipes/kernel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { actionDrop, areaOf, fieldDrop, sectionDrop, shownIn, whenFor, type Slot } from "./layout-drops";

export const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent";
const icon = "inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent";
const input = "border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:border-primary";

/** What is being dragged. Dragover can't read the transfer's data, so the drag lives in state. */
export type Drag = { kind: "section"; from: number } | { kind: "action"; section: number; id: string } | { kind: "field"; field: string };

/** What every card shares: the page, one edit that reports whether it applied, and the drag in progress. */
export type Ctx = {
  layout: Layout;
  edit: (op: LayoutOp | null, key: string, done?: string) => boolean;
  /** Shows why a change was refused before it reaches `apply`. */
  refuse: (key: string, message: string) => void;
  notice: { key: string; message: string } | null;
  drag: Drag | null;
  setDrag: (d: Drag | null) => void;
  stageLabel: (s: DealStage) => string;
  readOnly: boolean;
};

/** A kernel name as words: kernel.redraftStep is "Redraft step", accountMap is "Account map". */
export const words = (name: string) => {
  const s = name.slice(name.indexOf(".") + 1).replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const AREA_TITLE: Record<Panel, string> = { draftPanel: "Draft panel buttons" };

/** Which half of the element the pointer is over: the slot before it or after it. */
const half = (e: DragEvent<HTMLElement>, i: number, axis: "x" | "y" = "y"): Slot => {
  const r = e.currentTarget.getBoundingClientRect();
  return (axis === "y" ? e.clientY - r.top < r.height / 2 : e.clientX - r.left < r.width / 2) ? i : i + 1;
};
const startDrag = (e: DragEvent<HTMLElement>, card: HTMLElement | null, text: string) => {
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", text);
  if (card) e.dataTransfer.setDragImage(card, 16, 16);
};

/**
 * One section of the page as a row: its name and where it shows, dragged by the handle. Clicking it opens the rest:
 * stages, folded or open, its buttons or fields, rename and remove.
 */
export function SectionCard({ ctx, index, over, setOver, autoRename }: { ctx: Ctx; index: number; over: Slot | null; setOver: (s: Slot | null) => void; autoRename: boolean }) {
  const { layout, edit, notice, drag, setDrag, readOnly } = ctx;
  const s = layout.sections[index];
  const key = `section:${index}`;
  const card = useRef<HTMLLIElement>(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(autoRename);
  const [refused, setRefused] = useState(false);
  const count = s.fields ? `${s.fields.length} field${s.fields.length === 1 ? "" : "s"}` : `${s.actions.length} button${s.actions.length === 1 ? "" : "s"}`;
  const editable = s.fields ? true : s.actions.length > 0 || s.addable.length > 0;
  const n = layout.sections.length;
  const move = (slot: Slot, where: string) => edit(sectionDrop(layout, index, slot), key, `Moved ${s.title} ${where}`);
  const keys = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && index > 0) move(index - 1, `above ${layout.sections[index - 1].title}`);
    if (e.key === "ArrowDown" && index < n - 1) move(index + 2, `below ${layout.sections[index + 1].title}`);
  };
  const remove = () => {
    const ok = edit({ op: "removeSection", object: layout.object, section: s.ref }, key, `Removed ${s.title}`);
    setRefused(!ok);
  };
  const fold = (collapsed: boolean) => edit({ op: "setCollapsed", object: layout.object, section: s.ref, collapsed }, key, `${s.title} ${collapsed ? "starts folded" : "starts open"}`);
  const mine = notice?.key === key ? notice.message : null;
  const summary = [layout.object === "deal" ? stageSummary(s, ctx.stageLabel) : null, editable && s.actions.length + (s.fields?.length ?? 0) > 0 ? count : null, s.collapsed ? "folded" : null].filter(Boolean).join(" · ");

  return (
    <li ref={card} aria-label={s.title}
      onDragOver={(e) => { if (drag?.kind !== "section") return; e.preventDefault(); setOver(half(e, index)); }}
      onDrop={(e) => { if (drag?.kind !== "section") return; e.preventDefault(); const slot = half(e, index); setOver(null); setDrag(null); edit(sectionDrop(layout, drag.from, slot), `section:${drag.from}`, `Moved ${layout.sections[drag.from].title}`); }}
      className={cn("group/row relative border-b border-border last:border-b-0", drag?.kind === "section" && drag.from === index && "opacity-50", open && "bg-muted/20")}>
      {over === index && <DropLine at="top" />}
      {over === index + 1 && index === n - 1 && <DropLine at="bottom" />}
      <div className="flex items-center gap-1 py-1.5 pl-1 pr-2">
        <button type="button" draggable={!readOnly} disabled={readOnly} className={cn(icon, "cursor-grab opacity-40 group-hover/row:opacity-100 focus-visible:opacity-100 active:cursor-grabbing")}
          aria-label={`Drag ${s.title}. Alt and the arrow keys move it`} title="Drag to reorder (or Alt + arrow keys)"
          onDragStart={(e) => { startDrag(e, card.current, s.title); setDrag({ kind: "section", from: index }); }}
          onDragEnd={() => { setDrag(null); setOver(null); }} onKeyDown={keys}>
          <GripVertical className="h-4 w-4" />
        </button>
        {renaming ? (
          <div className="min-w-0 flex-1">
            <InlineText value={s.title} label={s.title} autoEdit className="text-sm font-medium" onDone={() => setRenaming(false)}
              onCommit={(title) => edit({ op: "renameSection", object: layout.object, section: s.ref, title }, key, `Renamed to ${title}`)} />
          </div>
        ) : (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
            <span className={cn("max-w-[70%] shrink-0 truncate text-sm font-medium", s.collapsed && "text-muted-foreground")}>{s.title}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
          </button>
        )}
        <button type="button" className={icon} aria-label={open ? `Close ${s.title}` : `Edit ${s.title}`} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
      {mine && (
        <div role="alert" className="mx-2 mb-2 border border-warning/50 bg-warning/10 px-2 py-1.5 text-xs">
          {refused ? <>Canon can&apos;t remove {s.title}: {reason(mine)}. {s.collapsed ? "Show it in fewer stages instead." : "Fold it or show it in fewer stages instead."}</> : reason(mine)}
          {refused && !s.collapsed && (
            <button type="button" className={cn(btn, "ml-2 bg-background")} onClick={() => { setRefused(false); fold(true); }}>Fold it</button>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-3 px-3 pb-3 pl-8">
          {layout.object === "deal" && <Prop label="Shows in"><StageChips ctx={ctx} s={s} index={index} /></Prop>}
          <Prop label="Starts">
            <div role="radiogroup" aria-label={`${s.title} starts`} className="flex">
              {([false, true] as const).map((c) => (
                <button key={String(c)} type="button" role="radio" aria-checked={Boolean(s.collapsed) === c} disabled={readOnly} onClick={() => fold(c)}
                  className={cn("-ml-px border px-2 py-1 text-xs first:ml-0", Boolean(s.collapsed) === c ? "relative border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted")}>
                  {c ? "Folded" : "Open"}
                </button>
              ))}
            </div>
          </Prop>
          {editable && <div><p className="mb-1 text-xs font-medium text-muted-foreground">{s.fields ? "Fields" : "Buttons"}</p>{s.fields ? <FieldsEditor ctx={ctx} index={index} /> : <ButtonsEditor ctx={ctx} index={index} />}</div>}
          {!readOnly && (
            <div className="flex gap-3 pt-1 text-xs">
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setRenaming(true)}><Pencil className="h-3 w-3" />Rename</button>
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive" onClick={remove}><Trash2 className="h-3 w-3" />Remove from page</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function DropLine({ at }: { at: "top" | "bottom" | "left" }) {
  return <span aria-hidden className={cn("pointer-events-none absolute z-10 bg-primary", at === "left" ? "-left-1 top-0 h-full w-0.5" : "inset-x-0 h-0.5", at === "top" && "-top-[5px]", at === "bottom" && "-bottom-[5px]")} />;
}

/** Why an edit was refused, in words: a logic binding is the one refusal a person meets without knowing the grammar. */
function reason(message: string) {
  const logic = /binds (\S+) in a ```logic block/.exec(message);
  return logic ? `the customization's ${logic[1]} logic lives in this section` : message.replace(/^the edit would break the customization: /, "");
}

function stageSummary(s: LayoutSection, label: (s: DealStage) => string) {
  const shown = shownIn(s.when);
  if (shown.length === DEAL_STAGES.length) return "every stage";
  const hidden = DEAL_STAGES.filter((x) => !shown.includes(x));
  return hidden.length < shown.length ? `hidden in ${hidden.map(label).join(", ")}` : `only in ${shown.map(label).join(", ")}`;
}

/** One chip per stage: on means the section shows in that stage. */
function StageChips({ ctx, s, index }: { ctx: Ctx; s: LayoutSection; index: number }) {
  const shown = shownIn(s.when);
  const key = `section:${index}`;
  return (
    <div role="group" aria-label={`Stages ${s.title} shows in`} className="flex items-center">
      {DEAL_STAGES.map((stage) => {
        const on = shown.includes(stage);
        return (
          <button key={stage} type="button" aria-pressed={on} disabled={ctx.readOnly}
            title={on ? `Shows in ${ctx.stageLabel(stage)}. Click to hide it there` : `Hidden in ${ctx.stageLabel(stage)}. Click to show it there`}
            onClick={() => {
              const next = on ? shown.filter((x) => x !== stage) : [...shown, stage];
              if (!next.length) { ctx.refuse(key, `${s.title} shows in at least one stage. To take it off the page, remove it`); return; }
              ctx.edit({ op: "setWhen", object: "deal", section: s.ref, when: whenFor(s.when, next) }, key, `${s.title} ${on ? "hidden" : "shows"} in ${ctx.stageLabel(stage)}`);
            }}
            className={cn("-ml-px border px-2 py-1 text-xs first:ml-0", on ? "relative border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground line-through decoration-muted-foreground/60 hover:bg-muted")}>
            {ctx.stageLabel(stage)}
          </button>
        );
      })}
    </div>
  );
}

/** A name shown as text until it is clicked, then edited in place: Enter or leaving keeps it, Escape drops it. */
function InlineText({ value, label, onCommit, onDone, disabled, autoEdit = false, className }: { value: string; label: string; onCommit: (v: string) => void; onDone?: () => void; disabled?: boolean; autoEdit?: boolean; className?: string }) {
  const [editing, setEditing] = useState(autoEdit && !disabled);
  const [text, setText] = useState(value);
  const done = useRef(false);
  if (!editing) {
    return (
      <button type="button" disabled={disabled} aria-label={`Rename ${label}`} onClick={() => { setText(value); done.current = false; setEditing(true); }}
        className={cn("group inline-flex max-w-full items-center gap-1 text-left hover:underline hover:decoration-muted-foreground/50 disabled:no-underline", className)}>
        <span className="truncate">{value}</span>
        {!disabled && <Pencil aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />}
      </button>
    );
  }
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (keep && text.trim() && text.trim() !== value) onCommit(text.trim());
    onDone?.();
  };
  return (
    <input autoFocus aria-label={`New name for ${label}`} value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } }}
      onBlur={() => finish(true)} className={cn(input, "w-full max-w-sm py-0.5", className)} />
  );
}

/** A section's buttons, its own and each panel's, as separate lists: a button moves only within its own. */
function ButtonsEditor({ ctx, index }: { ctx: Ctx; index: number }) {
  const s = ctx.layout.sections[index];
  const panels = [...new Set([...s.actions, ...s.addable].map((a) => a.panel).filter((p): p is Panel => p !== undefined))];
  return (
    <div className="space-y-3">
      {[undefined, ...panels].map((panel) => <ButtonArea key={panel ?? "own"} ctx={ctx} index={index} panel={panel} titled={panels.length > 0} />)}
    </div>
  );
}

function ButtonArea({ ctx, index, panel, titled }: { ctx: Ctx; index: number; panel: Panel | undefined; titled: boolean }) {
  const { layout, edit, drag, setDrag, readOnly } = ctx;
  const s = layout.sections[index];
  const area = areaOf(s, panel);
  const addable = s.addable.filter((a) => a.panel === panel);
  const [over, setOver] = useState<Slot | null>(null);
  if (!area.length && !addable.length) return null;
  const title = panel ? AREA_TITLE[panel] : titled ? "Section buttons" : null;
  const dragging = drag?.kind === "action" && drag.section === index && area.some((a) => a.id === drag.id) ? drag : null;
  const drop = (id: string, slot: Slot) => edit(actionDrop(layout.object, s, id, slot), `action:${index}:${id}`, `Moved ${s.actions.find((a) => a.id === id)?.label}`);
  return (
    <div>
      {title && <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>}
      {area.length ? (
        <ol className="divide-y divide-border border border-border bg-background" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}>
          {area.map((a, i) => (
            <ButtonRow key={a.id} ctx={ctx} index={index} a={a} i={i} count={area.length} over={over}
              onDragOver={(e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); setOver(half(e, i)); }}
              onDrop={(e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); const slot = half(e, i); setOver(null); setDrag(null); drop(dragging.id, slot); }}
              onDragEnd={() => setOver(null)} move={(slot) => drop(a.id, slot)} />
          ))}
        </ol>
      ) : <p className="text-xs text-muted-foreground">No buttons here yet.</p>}
      {addable.length > 0 && !readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className={cn(btn, "mt-1.5")}><Plus className="h-3.5 w-3.5" />Add a button</button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-sm rounded-none">
            {addable.map((x) => (
              <DropdownMenuItem key={x.runs} className="flex-col items-start gap-0 rounded-none"
                onSelect={() => edit({ op: "addAction", object: layout.object, section: s.ref, runs: x.runs, ...(panel ? { panel } : {}) }, `section:${index}`, `Added ${words(x.runs)}`)}>
                <span className="text-xs font-medium">{words(x.runs)}</span>
                <span className="text-[11px] leading-4 text-muted-foreground">{KERNEL_ACTIONS[x.runs].gate}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

type Action = LayoutSection["actions"][number];

function ButtonRow({ ctx, index, a, i, count, over, onDragOver, onDrop, onDragEnd, move }: {
  ctx: Ctx; index: number; a: Action; i: number; count: number; over: Slot | null;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void; onDrop: (e: DragEvent<HTMLLIElement>) => void; onDragEnd: () => void; move: (slot: Slot) => void;
}) {
  const { layout, edit, notice, setDrag, readOnly } = ctx;
  const s = layout.sections[index];
  const key = `action:${index}:${a.id}`;
  const row = useRef<HTMLLIElement>(null);
  const [conditions, setConditions] = useState(false);
  const keys = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && i > 0) move(i - 1);
    if (e.key === "ArrowDown" && i < count - 1) move(i + 2);
  };
  return (
    <li ref={row} aria-label={a.label} onDragOver={onDragOver} onDrop={onDrop} className="relative">
      {over === i && <DropLine at="top" />}
      {over === i + 1 && i === count - 1 && <DropLine at="bottom" />}
      <div className="group/btn flex items-center gap-1 px-1 py-0.5">
        <button type="button" draggable={!readOnly} disabled={readOnly} className={cn(icon, "cursor-grab opacity-40 group-hover/btn:opacity-100 focus-visible:opacity-100")} aria-label={`Drag ${a.label}. Alt and the arrow keys move it`}
          onDragStart={(e) => { e.stopPropagation(); startDrag(e, row.current, a.label); setDrag({ kind: "action", section: index, id: a.id }); }}
          onDragEnd={() => { setDrag(null); onDragEnd(); }} onKeyDown={keys}>
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <InlineText value={a.label} label={a.label} disabled={readOnly} className="text-sm"
            onCommit={(label) => edit({ op: "setActionLabel", object: layout.object, section: s.ref, action: a.id, label }, key, `Renamed to ${label}`)} />
          {(a.shows || a.enabled) && (
            <p className="truncate text-[11px] text-muted-foreground">
              {a.shows && <>shows when <span className="font-mono">{a.shows}</span></>}
              {a.shows && a.enabled && " · "}
              {a.enabled && <>enabled when <span className="font-mono">{a.enabled}</span></>}
            </p>
          )}
        </div>
        <button type="button" className={cn(icon, !conditions && "opacity-0 group-hover/btn:opacity-100 focus-visible:opacity-100")} aria-expanded={conditions} disabled={readOnly} aria-label={`Conditions for ${a.label}`} title="When it shows and when it can be clicked" onClick={() => setConditions(!conditions)}><SlidersHorizontal className="h-3.5 w-3.5" /></button>
        <button type="button" className={cn(icon, "opacity-0 group-hover/btn:opacity-100 focus-visible:opacity-100")} disabled={readOnly} aria-label={`Hide ${a.label}`} title="Hide this button"
          onClick={() => edit({ op: "removeAction", object: layout.object, section: s.ref, action: a.id }, `section:${index}`, `Hid ${a.label}`)}><EyeOff className="h-3.5 w-3.5" /></button>
      </div>
      {notice?.key === key && <p role="alert" className="mx-2 mb-1.5 border border-warning/50 bg-warning/10 px-2 py-1 text-xs">{reason(notice.message)}</p>}
      {conditions && <ConditionsEditor ctx={ctx} s={s} a={a} onDone={() => setConditions(false)} errorKey={key} />}
    </li>
  );
}

/** The advanced part of a button: when it shows and when it can be clicked, written in the condition grammar. */
function ConditionsEditor({ ctx, s, a, onDone, errorKey }: { ctx: Ctx; s: LayoutSection; a: Action; onDone: () => void; errorKey: string }) {
  const [shows, setShows] = useState(a.shows ?? "");
  const [enabled, setEnabled] = useState(a.enabled ?? "");
  const last = useRef<"shows" | "enabled">("shows");
  const scope = scopeOf(a.runs as ActionId, a.panel ?? s.component, ctx.layout.object);
  const insert = (name: string) => {
    const set = last.current === "shows" ? setShows : setEnabled;
    set((v) => (v.trim() ? `${v.trim()} && ${name}` : name));
  };
  const field = (id: "shows" | "enabled", label: string, value: string, set: (v: string) => void, hint: string): ReactNode => (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} onFocus={() => { last.current = id; }} placeholder={hint} spellCheck={false}
        className={cn(input, "mt-0.5 block w-full font-mono text-xs")} />
    </label>
  );
  return (
    <form className="mx-2 mb-2 space-y-2 border border-border bg-muted/30 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ctx.edit({ op: "setActionCondition", object: ctx.layout.object, section: s.ref, action: a.id, shows: shows.trim() || null, enabled: enabled.trim() || null }, errorKey, `Saved ${a.label}'s conditions`)) onDone();
      }}>
      <div className="grid gap-2 sm:grid-cols-2">
        {field("shows", "Show when", shows, setShows, "Always")}
        {field("enabled", "Enabled when", enabled, setEnabled, "Always")}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Names this button reads. Click one to add it. Combine them with <span className="font-mono">&amp;&amp;</span>, <span className="font-mono">||</span> and <span className="font-mono">!</span>, and compare with <span className="font-mono">== &quot;value&quot;</span> or <span className="font-mono">&gt; 0</span>.</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {Object.entries(scope).map(([name, t]) => (
            <button key={name} type="button" onClick={() => insert(name)} title={t.kind === "enum" ? `one of ${t.values.join(", ")}` : t.kind === "number" ? "a number" : "yes or no"}
              className="border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:border-primary hover:text-primary">{name}</button>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" className={cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90")}>Apply</button>
        <button type="button" className={btn} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** A fields section's fields in order. Drag a field within it or onto another fields section, or use Move to. */
function FieldsEditor({ ctx, index }: { ctx: Ctx; index: number }) {
  const { layout, edit, drag, setDrag, readOnly } = ctx;
  const s = layout.sections[index];
  const fields = s.fields ?? [];
  const [over, setOver] = useState<Slot | null>(null);
  const others = layout.sections.map((x, j) => ({ x, j })).filter(({ x, j }) => x.fields && j !== index);
  const key = `section:${index}`;
  const drop = (field: string, slot: Slot) => edit(fieldDrop(layout, field, index, slot), key, `Moved ${field}`);
  const fieldDrag = drag?.kind === "field" ? drag : null;
  return (
    <ol aria-label={`Fields in ${s.title}`} className="flex flex-wrap gap-1.5"
      onDragOver={(e) => { if (!fieldDrag) return; e.preventDefault(); if (e.target === e.currentTarget) setOver(fields.length); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
      onDrop={(e) => { if (!fieldDrag || e.target !== e.currentTarget) return; e.preventDefault(); setOver(null); setDrag(null); drop(fieldDrag.field, fields.length); }}>
      {fields.map((f, i) => (
        <li key={f} className="relative flex items-center border border-border bg-background text-xs"
          onDragOver={(e) => { if (!fieldDrag) return; e.preventDefault(); e.stopPropagation(); setOver(half(e, i, "x")); }}
          onDrop={(e) => { if (!fieldDrag) return; e.preventDefault(); e.stopPropagation(); const slot = half(e, i, "x"); setOver(null); setDrag(null); drop(fieldDrag.field, slot); }}>
          {over === i && <DropLine at="left" />}
          <button type="button" draggable={!readOnly} disabled={readOnly} aria-label={`Drag ${f}. Alt and the arrow keys move it`} className={cn(icon, "h-6 w-5 cursor-grab")}
            onDragStart={(e) => { e.stopPropagation(); startDrag(e, e.currentTarget.parentElement, f); setDrag({ kind: "field", field: f }); }}
            onDragEnd={() => { setDrag(null); setOver(null); }}
            onKeyDown={(e) => {
              if (!e.altKey) return;
              if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && i > 0) { e.preventDefault(); drop(f, i - 1); }
              if ((e.key === "ArrowRight" || e.key === "ArrowDown") && i < fields.length - 1) { e.preventDefault(); drop(f, i + 2); }
            }}>
            <GripVertical className="h-3 w-3" />
          </button>
          <span className="pr-1.5 font-mono">{f}</span>
          {others.length > 0 && !readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className={cn(icon, "h-6 w-5")} aria-label={`Move ${f} to another section`}><ChevronDown className="h-3 w-3" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="rounded-none">
                {others.map(({ x, j }) => (
                  <DropdownMenuItem key={j} className="rounded-none text-xs" onSelect={() => edit(fieldDrop(layout, f, j, (x.fields ?? []).length), key, `Moved ${f} to ${x.title}`)}>Move to {x.title}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </li>
      ))}
      {over === fields.length && <li aria-hidden className="w-0.5 self-stretch bg-primary" />}
    </ol>
  );
}

/** The page's Add section control: each component the page can still take, and a fields section with its fields. */
export function AddSection({ ctx, onAdded }: { ctx: Ctx; onAdded: (index: number) => void }) {
  const { layout, edit } = ctx;
  const [fields, setFields] = useState<string | null>(null);
  const [title, setTitle] = useState("Details");
  const pending = useRef<PageComponent | null>(null);
  if (ctx.readOnly || !layout.addable.length) return null;
  const add = (op: LayoutOp) => { if (edit(op, "page", "Added a section")) { onAdded(layout.sections.length); setFields(null); } };
  return (
    <div className="space-y-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className={btn}><Plus className="h-3.5 w-3.5" />Add a section</button></DropdownMenuTrigger>
        {/* The section is added once the menu has gone, so the menu can't pull focus from its new title's rename box. */}
        <DropdownMenuContent align="start" className="rounded-none"
          onCloseAutoFocus={(e) => {
            const c = pending.current;
            pending.current = null;
            if (!c) return;
            e.preventDefault();
            if (c === "fields") setFields("");
            else add({ op: "addSection", object: layout.object, component: c, title: words(c), before: null });
          }}>
          {layout.addable.map((c) => (
            <DropdownMenuItem key={c} className="rounded-none text-xs" onSelect={() => { pending.current = c; }}>
              {c === "fields" ? "Fields…" : words(c)}<span className="ml-auto pl-4 font-mono text-[11px] text-muted-foreground">{c}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {fields !== null && (
        <form className="flex flex-wrap items-end gap-2 border border-border bg-card p-2"
          onSubmit={(e) => { e.preventDefault(); add({ op: "addSection", object: layout.object, component: "fields", title, fields: fields.split(",").map((f) => f.trim()).filter(Boolean), before: null }); }}>
          <label className="block"><span className="text-xs font-medium text-muted-foreground">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={cn(input, "mt-0.5 block w-40")} /></label>
          <label className="block min-w-0 flex-1"><span className="text-xs font-medium text-muted-foreground">Fields no other section lists, separated by commas</span>
            <input autoFocus value={fields} onChange={(e) => setFields(e.target.value)} placeholder="nextStep, closeDate" spellCheck={false} className={cn(input, "mt-0.5 block w-full font-mono text-xs")} /></label>
          <button type="submit" className={btn}>Add</button>
          <button type="button" className={btn} onClick={() => setFields(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}
