"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AlertCircle, Undo2 } from "lucide-react";
import type { DealStage } from "../../../../convex/lib/plays/model";
import { sectionKey, type LayoutNode } from "../../../../recipes/layout";
import { PAGE_OBJECTS } from "../../../../recipes/kernel";
import { apply, describeLayout, type LayoutOp } from "../../../../recipes/md/edit";
import { parseRecipe } from "../../../../recipes/md/parse";
import { cn } from "@/lib/utils";
import { AddSection, btn, SectionCard, type Ctx, type Drag } from "./layout-section";
import type { Slot } from "./layout-drops";

const PAGE_TITLE: Record<string, string> = { deal: "Deal page", account: "Account page", contact: "Person page" };

/**
 * The visual layout mode (docs/recipes.md, "Visual layout mode"): the pages a recipe.md lays out, edited by
 * dragging and clicking. Every change goes through `apply`, which rewrites only the lines it is about, so this and the
 * markdown editor show one draft. A refused change shows why and leaves the draft as it was. Undo's history lives in
 * the editor's draft (editor-draft.ts), so it outlasts a switch to Markdown.
 */
export function LayoutMode({ markdown, object, onPage, onChange, canUndo, onUndo, readOnly = false }: { markdown: string; object?: string; onPage?: (page: string) => void; onChange: (next: string) => void; canUndo: boolean; onUndo: () => void; readOnly?: boolean }) {
  const parsed = useMemo(() => parseRecipe(markdown).recipe, [markdown]);
  const titles = { ...PAGE_TITLE, ...Object.fromEntries((parsed.workspacePages ?? []).map((p) => [p.slug, p.title])) };
  const pages = useMemo(() => [...PAGE_OBJECTS, ...(parsed.workspacePages ?? []).map((p) => p.slug)].filter((o) => { const l = describeLayout(markdown, o); return !("error" in l) && (l.sections.length > 0 || parsed.workspacePages?.some((p) => p.slug === o)); }), [markdown, parsed]);
  const [chosen, setChosen] = useState<string | undefined>(object);
  const page = chosen && pages.includes(chosen) ? chosen : pages[0] ?? object ?? "deal";
  useEffect(() => onPage?.(page), [onPage, page]);
  const layout = useMemo(() => describeLayout(markdown, page), [markdown, page]);
  const stages = useMemo(() => parseRecipe(markdown).recipe.data?.stages, [markdown]);
  const [notice, setNotice] = useState<Ctx["notice"]>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<Slot | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const undo = () => {
    if (!canUndo) return;
    setNotice(null);
    setStatus("Undone");
    onUndo();
  };

  if ("error" in layout) {
    return (
      <section aria-label="Layout" className="border border-border bg-card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><AlertCircle className="h-4 w-4 text-destructive" />Fix the markdown first</h2>
        <p className="mt-1 text-sm text-muted-foreground">The layout shows again once customization.md has no errors. Switch to Markdown to fix them.</p>
        <ul className="mt-3 space-y-1 text-xs">
          {(layout.problems ?? []).map((p, i) => <li key={i}><span className="font-mono font-semibold text-destructive">Line {p.line}</span> {p.message}</li>)}
        </ul>
      </section>
    );
  }

  const ctx: Ctx = {
    layout, notice, drag, setDrag, readOnly,
    stageLabel: (s: DealStage) => { const label = (stages as Record<string, { label?: unknown }> | undefined)?.[s]?.label; return typeof label === "string" ? label : s; },
    refuse: (key, message) => setNotice({ key, message }),
    edit: (op: LayoutOp | null, key: string, done?: string) => {
      if (!op || readOnly) return true;
      setFresh(null);
      const out = apply(markdown, op);
      if ("error" in out) { setNotice({ key, message: out.error }); return false; }
      setNotice(null);
      if (out.markdown !== markdown) onChange(out.markdown);
      if (done) setStatus(done);
      return true;
    },
  };
  const outline = (node: LayoutNode): import("react").ReactNode => {
    if ("section" in node) {
      const i = layout.sections.findIndex((s) => sectionKey(s.ref) === node.section);
      const s = layout.sections[i];
      return s ? <SectionCard key={node.section} ctx={ctx} index={i} over={drag?.kind === "section" ? over : null} setOver={setOver} autoRename={fresh === i} /> : null;
    }
    return <li key={node.id}><p className="px-3 py-1 text-xs font-medium text-muted-foreground">{node.title ?? node.kind} <span className="font-mono">{node.id}</span></p><ol className="ml-4 border-l">{node.children.map(outline)}</ol></li>;
  };
  const keys = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (!typing && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && canUndo) { e.preventDefault(); undo(); }
  };

  return (
    <section aria-label="Layout" className="min-w-0 space-y-3" onKeyDown={keys}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {pages.length > 1 ? (
          <div role="radiogroup" aria-label="Page" className="flex">
            {pages.map((o) => (
              <button key={o} type="button" role="radio" aria-checked={o === page} onClick={() => { setChosen(o); setNotice(null); setFresh(null); }}
                className={cn("-ml-px border px-3 py-1 text-xs font-medium first:ml-0", o === page ? "relative border-foreground bg-foreground text-background" : "border-border hover:bg-muted")}>
                {titles[o]}
              </button>
            ))}
          </div>
        ) : <h2 className="text-sm font-semibold">{titles[page]}</h2>}
        <div className="flex items-center gap-2">
          {!readOnly && <form className="flex flex-wrap gap-1" onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget), title = String(data.get("title") ?? "");
            const slug = String(data.get("slug") ?? "");
            const result = apply(markdown, { op: "addPage", slug, title });
            if ("error" in result) setNotice({ key: "page", message: result.error });
            else { onChange(result.markdown); setChosen(slug); }
          }}><input name="title" aria-label="Page title" placeholder="Page title" required className="w-28 border px-2 text-xs" /><input name="slug" aria-label="Page slug" placeholder="page-slug" required className="w-28 border px-2 text-xs" /><button className={btn}>Add a page</button></form>}
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">{status}</span>
          {!readOnly && <button type="button" className={btn} disabled={!canUndo} onClick={undo} title="Undo (⌘Z)"><Undo2 className="h-3.5 w-3.5" />Undo</button>}
        </div>
      </div>
      {!pages.length ? (
        <p className="border border-border bg-card p-4 text-sm text-muted-foreground">This customization lays out no page. Its sections are headings with <span className="font-mono">{"{section=…}"}</span> in customization.md.</p>
      ) : (
        <>
          <ol aria-label={`Sections of the ${titles[page].toLowerCase()}`} className="border border-border bg-card" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}>
            {layout.tree.children.map(outline)}
          </ol>
          {notice?.key === "page" && <p role="alert" className="border border-warning/50 bg-warning/10 px-2 py-1.5 text-xs">{notice.message}</p>}
          <AddSection ctx={ctx} onAdded={setFresh} />
        </>
      )}
    </section>
  );
}
